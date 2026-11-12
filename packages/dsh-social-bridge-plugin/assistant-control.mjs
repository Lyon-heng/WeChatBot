import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assistantAdministrator,assistantSenderAllowed,assistantGroupChatAllowed} from './assistant-policy.mjs';
import {conversationAccess,conversationWorkMode} from './conversation-policy.mjs';
import {dshCatalog} from './dsh-access.mjs';
import {taskFault,liveTask,assistantHelp,formatAssistantTask} from './assistant-tasks.mjs';

export function createAssistantControl({ctx,root,tasks,accountReady,sessionGroups,mappings,profiles,pending,notifications}){
  const confirmations=new Map(),approvals=new Map(),questions=new Map();
  const settings=()=>JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8')).wechat;
  const allowed=(body,w=settings())=>{
    if(!accountReady()||(conversationWorkMode(w,body.conversationKey)!=='assistant'&&conversationAccess(w,body.conversationKey).chatExecution!==true))throw taskFault('ASSISTANT_SENDER_DENIED',403);
    if(body.localControl!==true&&!assistantSenderAllowed(w,body.conversationKey,body.senderWxid))throw taskFault(assistantGroupChatAllowed(w,body.conversationKey,body.senderWxid)?'ASSISTANT_ADMIN_REQUIRED':'ASSISTANT_SENDER_DENIED',403);
    return w;
  };
  const own=(body,w,job)=>{if(!job||job.key!==body.conversationKey)throw taskFault('ASSISTANT_TASK_NOT_FOUND',404);if(body.localControl!==true&&!assistantAdministrator(w,body.senderWxid)&&job.sender!==body.senderWxid)throw taskFault('ASSISTANT_TASK_NOT_ALLOWED',403);return job;};
  const prune=()=>{for(const [id,item]of confirmations)if(item.expiresAt<Date.now())confirmations.delete(id);};
  const disposeApproval=ctx.on('approval/request',async(req,next)=>{
    const sid=String(req.agent?.session?.id??''),turn=pending.get(sid),job=tasks.get(turn?.taskId);
    if(!job||!accountReady()||conversationAccess(settings(),job.key).remoteApproval!==true)return next();
    const w=settings();if(!assistantSenderAllowed(w,job.key,job.sender)||!assistantAdministrator(w,job.sender))return next();
    // An approval always names the actual native tool call. Oversized or
    // unavailable actions stay in DSH rather than approving an unseen command.
    const events=req.agent.session.snapshotEvents(),call=events.findLast(event=>event.type==='tool/call'&&(event.data.callId??event.data.call?.id??event.data.id)===req.callId);
    const args=call?.data.call?.arguments??call?.data.arguments;
    const action=[req.toolName,req.reason,args].filter(value=>value!==undefined).map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n');
    if(!req.callId||!args||action.length>3000||!action.trim())return next();
    const id='A'+crypto.randomBytes(8).toString('hex'),expiresAt=Date.now()+600000;
    return new Promise(resolve=>{
      let timer;const done=outcome=>{if(!approvals.has(id))return;approvals.delete(id);clearTimeout(timer);req.signal?.removeEventListener('abort',abort);if(liveTask(job))tasks.update(job.id,{state:job.state==='cancelling'?'cancelling':'running',stage:outcome==='allowed-once'?'审批已通过，继续执行':'审批未通过',approval:undefined});resolve(outcome);};
      const abort=()=>done('cancelled');approvals.set(id,{jobId:job.id,key:job.key,sender:job.sender,done,expiresAt});
      tasks.update(job.id,{state:'waiting_approval',stage:'等待管理员微信审批',approval:{id,action,expiresAt}});
      timer=setTimeout(()=>done('rejected'),600000);timer.unref?.();req.signal?.addEventListener('abort',abort,{once:true});if(req.signal?.aborted)abort();
    });
  },{global:true,prepend:true});

  const disposeQuestions=ctx.on('user-questions/request',async(req,next)=>{
    const sid=String(req.agent?.session?.id??''),job=tasks.get(pending.get(sid)?.taskId);
    // Native confirmation intents retain their own reviewed approval flow.
    if(!job||!accountReady()||!assistantSenderAllowed(settings(),job.key,job.sender)||!Array.isArray(req.questions)||!req.questions.length||req.questions.length>5||req.questions.some(q=>q.intent))return next();
    const text=req.questions.map(q=>`${q.id}：${q.question}${q.detail?'\n'+q.detail:''}${q.options?.length?'\n选项：'+q.options.map(o=>o.label).join(' / '):''}`).join('\n\n');if(text.length>4500)return next();
    const id='Q'+crypto.randomBytes(8).toString('hex');
    return new Promise((resolve,reject)=>{
      let timer;const done=(value,error)=>{if(!questions.has(id))return;questions.delete(id);clearTimeout(timer);req.signal?.removeEventListener('abort',abort);if(liveTask(job))tasks.update(job.id,{state:job.state==='cancelling'?'cancelling':'running',stage:error?'提问已结束':'已收到补充信息',question:undefined});if(error)reject(error);else resolve(value);};
      const abort=()=>done(null,taskFault('ASK_ABORTED'));questions.set(id,{jobId:job.id,key:job.key,sender:job.sender,questions:req.questions,done});
      tasks.update(job.id,{state:'waiting_input',stage:'等待微信补充信息',question:{id,text:text+(req.questions.length>1?'\n多个问题请使用 JSON 回答，例如 {"问题ID":"答案"}。':'')}});timer=setTimeout(()=>done(null,taskFault('ASK_TIMED_OUT')),600000);timer.unref?.();req.signal?.addEventListener('abort',abort,{once:true});if(req.signal?.aborted)abort();
    });
  },{global:true,prepend:true});

  async function control(action,body){
    if(['notifications','notification-ack'].includes(action)){if(body.localControl!==true||!accountReady())throw taskFault('ASSISTANT_SENDER_DENIED',403);if(action==='notification-ack')notifications?.ack(body.id);return {ok:true,notifications:notifications?.list()??[]};}
    const w=allowed(body),key=body.conversationKey,admin=body.localControl===true||assistantAdministrator(w,body.senderWxid);
    if(action==='submit'){
      if(body.localControl===true)throw taskFault('ASSISTANT_SENDER_REQUIRED',400);
      if(body.assistantSender!==body.senderWxid)throw taskFault('ASSISTANT_SENDER_DENIED',403);
      if(typeof body.message!=='string'||!body.message.trim()||body.message.length>18000)throw taskFault('invalid_request',400);
      if(body.assistantParentId){const parent=own(body,w,tasks.get(body.assistantParentId));if(parent.sessionId&&mappings[key]!==parent.sessionId)throw taskFault('ASSISTANT_WORKSPACE_CHANGED');}
      return {ok:true,task:tasks.submit(body)};
    }
    const list=()=>tasks.list(key,body.senderWxid,{admin});
    if(action==='help')return {ok:true,text:assistantHelp};
    if(action==='list'){const jobs=list();return {ok:true,tasks:jobs,text:jobs.length?jobs.slice(0,10).map(formatAssistantTask).join('\n\n'):'还没有任务。直接描述需求即可创建任务。'};}
    if(['status','result','cancel'].includes(action)){
      const jobs=list(),job=body.taskId?own(body,w,tasks.get(body.taskId)):tasks.get(jobs.find(liveTask)?.id??(action==='result'?jobs[0]?.id:undefined));
      if(!job)return {ok:true,running:false,task:null,text:formatAssistantTask(null)};
      if(action==='cancel')tasks.cancel(job.id);
      return {ok:true,running:liveTask(job),task:tasks.view(job,{result:action==='result'}),text:formatAssistantTask(job)};
    }
    if(action==='capabilities'){
      const scope=ctx.agents.get(mappings[key]),access=conversationAccess(w,key),catalog=await dshCatalog(ctx,{scope,workMode:'assistant',cwd:scope?.session.header?.cwd,signal:AbortSignal.timeout(4000)}),native=access.mode==='native';
      const tools=catalog.tools.filter(item=>native||access.tools.includes(item.name)),skills=catalog.skills.filter(item=>native||access.skills.includes(item.name));
      return {ok:true,text:`能力配置：${native?'使用 DSH 可用能力':'逐项授权'}\n工具：${tools.map(item=>item.name).join('、')||'尚未授权'}\n技能：${skills.map(item=>item.name).join('、')||'尚未授权'}\n微信文件：${w.assistant?.fileTransferChats?.[key]?'开启':'关闭'}\n联网搜索：${w.search?.chats?.[key]??w.search?.enabled?'开启':'关闭'}\n审批：${access.remoteApproval?'原生审批可由管理员微信逐次确认，无法完整展示的操作仍在 DSH 确认':'在 DSH 本机确认'}\n单任务上限：${access.timeoutMinutes??30} 分钟 / ${access.toolLimit??200} 次工具调用。`.slice(0,6000)};
    }
    if(action==='answer'){
      const item=questions.get(body.token);if(!item||item.key!==key)throw taskFault('ASSISTANT_QUESTION_EXPIRED');own(body,w,tasks.get(item.jobId));
      if(typeof body.text!=='string'||!body.text.trim()||body.text.length>6000)throw taskFault('ASSISTANT_ANSWER_INVALID',400);
      let input;if(item.questions.length===1)input={[item.questions[0].id]:body.text.trim()};else{try{input=JSON.parse(body.text);}catch{throw taskFault('ASSISTANT_ANSWER_INVALID',400);}if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length!==item.questions.length)throw taskFault('ASSISTANT_ANSWER_INVALID',400);}
      const answers=item.questions.map(q=>{const value=input[q.id];if(typeof value!=='string'||!value.trim())throw taskFault('ASSISTANT_ANSWER_INVALID',400);const labels=(q.options??[]).map(o=>o.label),selected=q.multiSelect?value.split(/[,，]/).map(s=>s.trim()).filter(v=>labels.includes(v)):labels.includes(value)?[value]:[];return {id:q.id,selected,...(selected.length?{}:{custom:value})};});
      item.done({answers});return {ok:true,text:'已将回答交给 DSH，继续执行原任务。'};
    }
    if(!admin)throw taskFault('ASSISTANT_ADMIN_REQUIRED',403);
    if(action==='approve'||action==='reject'){
      const item=approvals.get(body.token);if(!item||item.key!==key||item.expiresAt<Date.now())throw taskFault('ASSISTANT_APPROVAL_EXPIRED');
      const job=own(body,w,tasks.get(item.jobId));if(!liveTask(job)||!assistantSenderAllowed(w,key,job.sender)||conversationAccess(w,key).remoteApproval!==true)throw taskFault('ASSISTANT_APPROVAL_REVOKED',403);
      item.done(action==='approve'?'allowed-once':'rejected');return {ok:true,text:action==='approve'?'已批准这一次操作，DSH 继续执行。':'已拒绝这一次操作。'};
    }
    if(action==='workspaces'){const data=sessionGroups.snapshot();return {ok:true,text:data.available?data.groups.slice(0,30).map(group=>`${group.id} · ${group.title}${group.id===profiles[key]?.workspaceId?'（当前）':''}`).join('\n')||'暂无已登记的 DSH 工作区，请在电脑端创建。':'DSH 工作区服务暂不可用。'};}
    if(action==='workspace-select'){
      prune();if(confirmations.size>=100)throw taskFault('ASSISTANT_CONFIRMATION_LIMIT',429);
      const group=sessionGroups.snapshot().groups.find(group=>group.id===body.groupId);if(!group)throw taskFault('SESSION_GROUP_NOT_FOUND',404);
      const token='W'+crypto.randomBytes(8).toString('hex');confirmations.set(token,{key,sender:body.senderWxid,groupId:group.id,sid:mappings[key]??null,expiresAt:Date.now()+300000});
      return {ok:true,text:`将此聊天移动到 DSH 工作区“${group.title}”。已有历史会保留，后续任务使用新目录。\n请在 5 分钟内回复：确认切换工作区 ${token}`};
    }
    if(action==='workspace-confirm'){
      prune();const item=confirmations.get(body.token);if(!item||item.key!==key||item.sender!==body.senderWxid)throw taskFault('ASSISTANT_CONFIRMATION_EXPIRED');
      if([...tasks.jobs.values()].some(job=>job.key===key&&liveTask(job)))throw taskFault('SESSION_GROUP_SESSION_BUSY');
      const result=await sessionGroups.run('move',{conversationKey:key,groupId:item.groupId,expectedSessionId:item.sid,confirmed:true},AbortSignal.timeout(20000));confirmations.delete(body.token);return {...result,text:'工作区已切换，历史保留。新任务将使用目标目录。'};
    }
    throw taskFault('ASSISTANT_UNKNOWN_COMMAND',400);
  }
  control.dispose=()=>{disposeApproval?.();disposeQuestions?.();for(const item of [...approvals.values()])item.done('cancelled');for(const item of [...questions.values()])item.done(null,taskFault('ASK_ABORTED'));confirmations.clear();};
  return control;
}
