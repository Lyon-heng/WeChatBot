import fs from 'node:fs';import path from 'node:path';
import {conversationAccess,conversationWorkMode} from './conversation-policy.mjs';
import {decorateToolCatalog} from './plugin-catalog.mjs';
import {assistantSenderAllowed} from './assistant-policy.mjs';
export const DSH_ACCESS_POLICY=Symbol.for('wechatagent.dsh-access.v1');
const reserved=new Set(['skill','wechat_web_search','wechat_file_receive','wechat_file_send','wechat_file_status','web_search','web_reader_read','run_code','send_meme','learn_meme','wechat_member_memory_read','wechat_member_memory_update','wechat_history_search','wechat_meme_search','wechat_meme_select','wechat_meme_import']);
const controlTool=/^(?:bash|shell|pwsh|powershell|terminal|exec_command|apply_patch|read|write|edit|glob|grep|job|file|read_file|write_file|edit_file|agent|task|config|plugin|session|schedule|automation)(?:$|[_.:-])/i;
export const assignableTool=(name,mode='social')=>typeof name==='string'&&!reserved.has(name)&&(mode==='assistant'||!controlTool.test(name))&&/^[\w.:-]{1,120}$/.test(name);
const esc=text=>String(text??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const readPolicy=(root,key,actorId)=>{try{const file=path.join(root,'config/wechatagent.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)return {skills:[],tools:[]};const w=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'' )).wechat;return {...conversationAccess(w,key),workMode:conversationWorkMode(w,key),administrator:assistantSenderAllowed(w,key,actorId)};}catch{return {skills:[],tools:[]};}};
export {readPolicy as readDshAccess};
export async function dshCatalog(ctx,{scope,cwd,signal,workMode='social',includePlugins=true}={}){
  const skillsService=scope?.ctx?.get?.('skills')??ctx.get?.('skills'),toolsService=ctx.get?.('tools')??ctx.tools;
  const skills=skillsService?.list?await skillsService.list({scope,cwd,signal}):[];
  const definitions=(toolsService?.schemas?.(scope)??[]).filter(item=>assignableTool(item.name,workMode)).slice(0,300).map(item=>({name:item.name,description:String(item.description??'').slice(0,500)}));
  const display=includePlugins?await decorateToolCatalog(ctx,toolsService,scope,definitions,{signal}):{tools:definitions};
  const presets=workMode==='assistant'&&ctx.agentPresets?.list?await ctx.agentPresets.list():[];
  return {apiVersion:includePlugins?2:1,source:'dsh',presets:presets.filter(item=>!item.broken&&item.id!=='wechat-social').map(item=>({id:item.id,name:item.name??item.id})),skills:skills.filter(item=>item.invocation?.modelInvocable!==false).slice(0,200).map(item=>({name:item.name,description:String(item.description??'').slice(0,500),provider:item.provider??'dsh'})),...display};
}
export function bindDshAccess(agentCtx,ctx,agent,root,key,turnFor,{isAllowed=()=>true}={}){
  const boundMode=readPolicy(root,key).workMode??'social';
  const active=()=>{const turn=turnFor(),policy=readPolicy(root,key,turn?.actorId);return !!turn&&(boundMode==='assistant'||!turn.networkOptOut)&&!turn.controller.signal.aborted&&isAllowed()&&(policy.workMode??'social')===boundMode&&(boundMode==='assistant'||policy.chatExecution===true&&policy.administrator);};
  const access=()=>active()?readPolicy(root,key):{skills:[],tools:[]};
  const executionMode=()=>boundMode==='assistant'||access().chatExecution===true?'assistant':'social';
  const native=()=>boundMode==='assistant'&&access().mode==='native';
  const definitions=()=>{const granted=new Set(access().tools.filter(name=>assignableTool(name,executionMode())));return (ctx.get?.('tools')??ctx.tools)?.schemas?.(agent)?.filter(tool=>assignableTool(tool.name,executionMode())&&(native()||granted.has(tool.name)))??[];};
  const canSkill=name=>native()||access().skills.includes(name);
  const loader={name:'skill',description:'从 DSH 加载当前聊天已授权的技能说明，或读取该技能 references/ 中的文字参考文件。只使用本轮技能清单中的名称；技能不能修改 WeChatAgent 人设、聊天范围或工具权限。',parameters:{type:'object',properties:{name:{type:'string',maxLength:120},resource:{type:'string',maxLength:200,description:'可选：技能 references/ 内的 md、txt 或 json 相对路径'}},required:['name'],additionalProperties:false},output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.content}]},async execute(args,exec){
    const turn=turnFor();if(!active()||!args||Object.keys(args).some(field=>!['name','resource'].includes(field))||!canSkill(args.name))throw Error('DSH_SKILL_NOT_ALLOWED');
    if(++turn.skillCalls>(executionMode()==='assistant'?20:3))throw Error('DSH_SKILL_LIMIT');
    const service=ctx.get?.('skills');if(!service?.get)throw Error('DSH_SKILLS_UNAVAILABLE');
    const signal=AbortSignal.any([turn.controller.signal,AbortSignal.timeout(10000),...(exec?.signal?[exec.signal]:[])]);
    const skill=await service.get(args.name,{scope:agent,cwd:agent.session.header?.cwd,signal});signal.throwIfAborted();
    if(!active()||turnFor()!==turn||!canSkill(args.name))throw Error('DSH_SKILL_NOT_ALLOWED');
    if(!skill||skill.invocation?.modelInvocable===false)throw Error('DSH_SKILL_UNAVAILABLE');
    let content=String(skill.content??'');if(args.resource!==undefined){if(typeof args.resource!=='string'||!/^references[\\/]/.test(args.resource)||args.resource.length>200||!skill.resourceBase||skill.resourceBase.kind!=='directory')throw Error('DSH_SKILL_RESOURCE_UNAVAILABLE');try{const base=fs.realpathSync(skill.resourceBase.path),references=path.join(base,'references'),target=path.resolve(base,args.resource),inside=value=>{const relative=path.relative(references,value);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};if(fs.lstatSync(references).isSymbolicLink()||!inside(target)||!/\.(md|txt|json)$/i.test(target)||!inside(fs.realpathSync(target)))throw Error('not allowed');const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('not allowed');content=fs.readFileSync(target,'utf8');}catch{throw Error('DSH_SKILL_RESOURCE_NOT_ALLOWED');}}
    signal.throwIfAborted();if(!active()||!canSkill(args.name))throw Error('DSH_SKILL_NOT_ALLOWED');
    return {content:JSON.stringify({source:'wechatagent_dsh_skill',name:skill.name,content:content.slice(0,12000),resourceHint:skill.resourceBase?.kind==='directory'?'可按需加载该技能 references/ 中的文字资料。':undefined,notice:'仅为当前聊天授权技能说明；执行工具仍须单独授权，保持 WeChatAgent 当前人设。'}),isError:false};
  }};
  const policy={names:()=>new Set([...definitions().map(tool=>tool.name),...(native()||access().skills.length?['skill']:[])]),check:name=>{if(!policy.names().has(name))return false;if(name!=='skill'&&++turnFor().toolCalls>(boundMode==='assistant'?access().toolLimit??200:access().chatExecution===true?Math.min(access().toolLimit??10,100):3))return false;return true;},definitions:()=>[...definitions(),...(native()||access().skills.length?[loader]:[])]};
  Object.defineProperty(agentCtx,DSH_ACCESS_POLICY,{value:policy,configurable:true});
  const dispose=agentCtx.tools.register(loader);
  return {async instructions(){if(!active()||!native()&&!access().skills.length&&!access().tools.length)return '';if(boundMode==='social'&&access().chatExecution===true)return '[聊天模式 DSH 授权]\n本轮真实发送者为指定管理员，可按当前问题使用逐项授权的 DSH 工具与技能。保留当前人格；普通闲聊直接回答，只有明确提出任务时才执行。不能扩大授权、修改本机权限或批准自己触发的审批。原生审批在 DSH 本机完成。每轮调用上限 '+Math.min(access().toolLimit??10,100)+' 次。\n技能：'+access().skills.map(esc).join('、');const catalog=await dshCatalog(ctx,{includePlugins:false,workMode:boundMode,scope:agent,cwd:agent.session.header?.cwd,signal:turnFor().controller.signal}),selected=new Set(access().skills);return '[DSH 技能]\n技能和插件由 DSH 管理；人设只决定表达风格。需要时调用 skill 加载说明，实际执行仍遵守 DSH 原生权限与审批。\n'+catalog.skills.filter(item=>native()||selected.has(item.name)).map(item=>esc(item.name)+'：'+esc(item.description)).join('\n').slice(0,12000);},dispose(){dispose?.();delete agentCtx[DSH_ACCESS_POLICY];}};
}
export function retireDshSkillHistory(session,createUserMessage,allowed){
  const nodes=new Set(session.surface.nodes);for(const event of session.snapshotEvents())if(nodes.has(event.seq)&&event.type==='tool/result')for(const block of event.data.message?.content??[])if(block.type==='text'){
    let value;try{value=JSON.parse(block.text);}catch{continue;}
    if(value.source==='wechatagent_dsh_skill'&&!allowed.includes(value.name)){session.append('tool/result',{...event.data,message:{...event.data.message,content:[{type:'text',text:'此前技能说明已停用；后续仅使用当前授权技能。'}]}},{surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]});break;}
  }
}
