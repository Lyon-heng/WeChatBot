import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ASSISTANT_CONTROLLER='durable-wechat-tasks-v1';
export const taskFault=(code,status=409)=>Object.assign(Error(code),{code,status});
export const liveTask=task=>['queued','running','waiting_approval','waiting_input','cancelling'].includes(task?.state);
const terminal=new Set(['completed','failed','cancelled','interrupted']);
const short=value=>String(value??'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,300);

// Only an explicitly labelled public message accompanying a real tool request
// is progress. Never forward reasoning blocks, partial streams or tool output.
export function assistantProgressText(message){
  const blocks=Array.isArray(message?.content)?message.content:[];
  if(!(Array.isArray(message?.toolCalls)&&message.toolCalls.length)&&!blocks.some(block=>['tool-call','tool_call','tool_use'].includes(block.type)))return '';
  const text=blocks.filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('').trim();
  const match=/^WECHAT_PROGRESS:[ \t]*([^\r\n]{1,160})$/.exec(text);if(!match)return '';
  return publicProgressText(match[1]);
}
export function publicProgressText(text){
  if(typeof text!=='string')return '';
  const value=text.replace(/^🐟\s*/, '').trim();
  if(!value||Array.from(value).length>80||/[\x00-\x1f\x7f]|RESPOND:|SILENT|WECHAT_PROGRESS:|<\/?(?:think|analysis|reasoning)\b|\[STICKER:|\bT[a-f0-9]{16}\b|排队中/i.test(value))return '';
  return value;
}

// Persist before admission. Uncertain native executions are never replayed after
// a host restart: continuing them requires a fresh, authenticated user request.
export class AssistantTasks {
  constructor({file,execute,allowed,now=Date.now,concurrency=2}){
    Object.assign(this,{file,execute,allowed,now,concurrency});this.jobs=new Map();this.active=new Map();this.closed=false;
    if(fs.existsSync(file)){
      const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||stat.size>64*1024*1024)throw taskFault('ASSISTANT_TASK_STORE_INVALID');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1||!Array.isArray(data.tasks)||data.tasks.length>200)throw taskFault('ASSISTANT_TASK_STORE_INVALID');
      for(const job of data.tasks){if(!/^T[a-f0-9]{16}$/.test(job.id)||!['queued','running','waiting_approval','waiting_input','cancelling',...terminal].includes(job.state)||!job.request||!/^[a-f0-9]{64}$/.test(job.batchId))throw taskFault('ASSISTANT_TASK_STORE_INVALID');
        if(['queued','running','waiting_approval','waiting_input','cancelling'].includes(job.state)){job.state='interrupted';job.error='DSH_RESTARTED_REVIEW_BEFORE_CONTINUING';job.finishedAt=now();delete job.approval;delete job.question;}
        this.jobs.set(job.id,job);
      }
      this.persist();
    }
  }
  persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,tasks:[...this.jobs.values()]}),{mode:0o600});fs.renameSync(temp,this.file);}
  view(job,{result=false}={}){return job?{id:job.id,parentId:job.parentId??null,conversationKey:job.key,owner:job.sender,state:job.state,createdAt:job.createdAt,startedAt:job.startedAt??null,finishedAt:job.finishedAt??null,stage:job.stage??'',tool:job.tool??null,steps:job.steps??0,sessionId:job.sessionId??null,...(job.feedback?{feedback:job.feedback}:{}),...(job.error?{error:job.error}:{}),...(job.approval?{approval:job.approval}:{}),...(job.question?{question:job.question}:{}),...(result&&job.output?{output:job.output}:{}),revision:job.revision??0}:null;}
  get(id){return this.jobs.get(id);}
  list(key,sender,{admin=false}={}){return [...this.jobs.values()].filter(job=>job.key===key&&(admin||job.sender===sender)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20).map(job=>this.view(job));}
  submit(request){
    if(this.closed)throw taskFault('ASSISTANT_CONTROLLER_STOPPED',503);
    const key=request.conversationKey,sender=request.assistantSender,batchId=request.batchId;
    if(!/^[a-f0-9]{64}$/.test(batchId??''))throw taskFault('ASSISTANT_BATCH_REQUIRED',400);
    if(!this.allowed(key,sender))throw taskFault('ASSISTANT_SENDER_DENIED',403);
    const id='T'+crypto.createHash('sha256').update(key+'\0'+sender+'\0'+batchId).digest('hex').slice(0,16),prior=this.jobs.get(id);
    if(prior)return this.view(prior);
    if([...this.jobs.values()].filter(job=>job.key===key&&liveTask(job)).length>=20)throw taskFault('ASSISTANT_QUEUE_FULL',429);
    let parent;
    if(request.assistantParentId){parent=this.jobs.get(request.assistantParentId);if(!parent||parent.key!==key||parent.sender!==sender)throw taskFault('ASSISTANT_PARENT_NOT_ALLOWED',403);if(liveTask(parent))throw taskFault('ASSISTANT_PARENT_RUNNING');}
    while(this.jobs.size>=200){const old=[...this.jobs.values()].find(job=>terminal.has(job.state));if(!old)throw taskFault('ASSISTANT_QUEUE_FULL',429);this.jobs.delete(old.id);}
    const job={id,key,sender,batchId,request:structuredClone(request),parentId:parent?.id,state:'queued',createdAt:this.now(),stage:'等待执行',revision:1};
    this.jobs.set(id,job);try{this.persist();}catch(error){this.jobs.delete(id);throw error;}queueMicrotask(()=>this.pump());return this.view(job);
  }
  update(id,patch){const job=this.jobs.get(id);if(!job)return;Object.assign(job,patch,{revision:(job.revision??0)+1});this.persist();return this.view(job);}
  adopt(request,sessionId){
    const key=request.conversationKey,sender=request.assistantSender,id='T'+crypto.createHash('sha256').update(key+'\0'+sender+'\0'+request.batchId).digest('hex').slice(0,16);
    if(this.closed||!this.allowed(key,sender)||this.jobs.has(id))throw taskFault('ASSISTANT_BACKGROUND_ALREADY_ADMITTED');
    if(this.jobs.size>=200){const old=[...this.jobs.values()].find(job=>terminal.has(job.state));if(!old)throw taskFault('ASSISTANT_QUEUE_FULL');this.jobs.delete(old.id);}
    const job={id,key,sender,batchId:request.batchId,request,parentId:request.assistantParentId,state:'running',sessionId,createdAt:this.now(),startedAt:this.now(),stage:'执行 DSH 原生定时任务',revision:1};
    this.jobs.set(id,job);this.persist();const controller=new AbortController();this.active.set(id,controller);
    const finish=output=>{if(this.closed)return;this.update(id,{state:output.error?'failed':'completed',stage:output.error?'定时任务执行失败':'定时任务已完成',output,finishedAt:this.now(),...(output.error?{error:String(output.error).slice(0,100)}:{})});this.active.delete(id);this.pump();};
    return {job,controller,finish};
  }
  progress(id,stage,{tool,sessionId,step=false}={}){const job=this.jobs.get(id);if(!job||!liveTask(job))return;Object.assign(job,{stage:short(stage),...(tool?{tool:short(tool)}:{}),...(sessionId?{sessionId}:{}),...(step?{steps:(job.steps??0)+1}:{}),revision:(job.revision??0)+1});if(!this.progressTimer)this.progressTimer=setTimeout(()=>{this.progressTimer=null;try{this.persist();}catch{this.persistenceDelayed=true;}},500);this.progressTimer.unref?.();return this.view(job);}
  putFeedback(id,text,source){const job=this.jobs.get(id);text=publicProgressText(text);if(job?.state!=='running'||!text||job.feedback?.text===text)return false;job.feedback={id:(job.feedback?.id??0)+1,text,source,at:this.now()};this.progress(id,job.stage);return true;}
  progressMessage(id,message){return this.putFeedback(id,assistantProgressText(message),'model');}
  progressHeartbeat(id,text){return this.putFeedback(id,text,'heartbeat');}
  cancel(id){const job=this.jobs.get(id);if(!job)throw taskFault('ASSISTANT_TASK_NOT_FOUND',404);if(job.state==='queued')return this.update(id,{state:'cancelled',stage:'已取消',finishedAt:this.now()});if(liveTask(job)){this.update(id,{state:'cancelling',stage:'正在取消'});this.active.get(id)?.abort(taskFault('task_cancelled'));}return this.view(job);}
  pump(){
    if(this.closed||this.active.size>=this.concurrency)return;
    for(const job of this.jobs.values()){
      if(this.active.size>=this.concurrency)break;if(job.state!=='queued')continue;
      if([...this.active.keys()].some(id=>this.jobs.get(id)?.key===job.key))continue;
      if(!this.allowed(job.key,job.sender)){this.update(job.id,{state:'cancelled',stage:'权限已收回',finishedAt:this.now()});continue;}
      const controller=new AbortController();this.active.set(job.id,controller);this.update(job.id,{state:'running',stage:'准备 DSH 工作区',startedAt:this.now()});
      Promise.resolve().then(()=>this.execute({...job.request,assistantTaskId:job.id},controller.signal)).then(output=>{
        if(this.closed)return;const state=output?.error?'failed':'completed';this.update(job.id,{state,stage:state==='completed'?'已完成':'执行失败',finishedAt:this.now(),output,...(output?.error?{error:short(output.code??output.error)}:{})});
      }).catch(error=>{if(!this.closed)this.update(job.id,{state:controller.signal.aborted?'cancelled':'failed',stage:controller.signal.aborted?'已取消':'执行失败',error:short(error.code??error.message),finishedAt:this.now(),admitted:error.admitted===true});}).finally(()=>{this.active.delete(job.id);if(!this.closed)this.pump();});
    }
  }
  close(){this.closed=true;clearTimeout(this.progressTimer);this.progressTimer=null;for(const job of this.jobs.values())if(job.state==='queued')this.update(job.id,{state:'interrupted',stage:'DSH 已退出，需检查后继续',finishedAt:this.now(),error:'DSH_STOPPED'});for(const [id,controller]of this.active){this.update(id,{state:'interrupted',stage:'DSH 已退出，需检查后继续',finishedAt:this.now(),error:'DSH_STOPPED'});controller.abort(taskFault('plugin_stopped'));}this.persist();}
}

export const assistantHelp='助手模式可在当前 DSH 工作区执行已授权的任务。\n直接描述需求，或发送：\n新任务 具体要求\n任务列表\n任务状态 [任务编号]\n取消任务 [任务编号]\n继续任务 任务编号 补充要求\n助手能力\n回答 Q… 答案\n工作区列表（管理员）\n切换工作区 工作区编号（需再次确认）\n批准 审批编号 / 拒绝 审批编号（管理员）\n群聊中请 @ 助手或使用唤醒词。';
export function parseAssistantCommand(text,wakeWords=[]){
  let value=String(text??'').trim().replace(/^@[^\s]+\s+/,'');for(const word of wakeWords)if(word&&value.startsWith(word))value=value.slice(word.length).trim().replace(/^[,，:：]\s*/,'');
  const simple={'助手帮助':'help','任务列表':'list','助手能力':'capabilities','工作区列表':'workspaces'};if(simple[value])return {action:simple[value]};
  let m=/^(任务状态|取消任务)(?:\s+(T[a-f0-9]{16}))?$/i.exec(value);if(m)return {action:m[1]==='任务状态'?'status':'cancel',taskId:m[2]?'T'+m[2].slice(1).toLowerCase():undefined};
  m=/^回答\s+(Q[a-f0-9]{16})\s+([\s\S]{1,6000})$/.exec(value);if(m)return {action:'answer',token:m[1],text:m[2]};
  m=/^(批准|拒绝|确认切换工作区)\s+([A-Za-z0-9_-]{8,80})$/.exec(value);if(m)return {action:m[1]==='批准'?'approve':m[1]==='拒绝'?'reject':'workspace-confirm',token:m[2]};
  m=/^切换工作区\s+(.{1,120})$/.exec(value);if(m)return {action:'workspace-select',groupId:m[1].trim()};
  m=/^继续任务\s+(T[a-f0-9]{16})\s+([\s\S]{1,12000})$/i.exec(value);if(m)return {action:'continue',taskId:'T'+m[1].slice(1).toLowerCase(),text:m[2]};
  m=/^新任务\s+([\s\S]{1,12000})$/.exec(value);return m?{action:'new',text:m[1]}:null;
}

export function formatAssistantTask(job){
  if(!job)return '当前没有正在执行的任务。发送“任务列表”查看最近任务。';
  const states={queued:'排队中',running:'执行中',waiting_approval:'等待审批',waiting_input:'等待补充信息',cancelling:'正在取消',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'执行被中断，请检查后继续'};
  return `${job.id} · ${states[job.state]??job.state}\n${job.stage??''}${job.tool?' · '+job.tool:''}${job.steps?'\n已执行工具：'+job.steps+' 次':''}${job.approval?'\n待审批：'+job.approval.id+'\n'+job.approval.action+'\n管理员回复“批准 '+job.approval.id+'”或“拒绝 '+job.approval.id+'”。':''}${job.question?'\n'+job.question.text+'\n回复：回答 '+job.question.id+' 答案':''}${job.error?'\n原因：'+job.error:''}`;
}
