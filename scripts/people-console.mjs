import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {PeopleMemory} from '../packages/plugin-api/people-memory.mjs';
import {activeReaderAccount} from './reader-account-state.mjs';
import {configuration} from '../packages/plugin-api/catalog.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),fault=(message,status=400)=>Object.assign(Error(message),{status});
const messages={PEOPLE_MEMORY_BUSY:'记忆正在更新，请稍后重试。',PEOPLE_MEMORY_REVISION_CHANGED:'这条记忆已更新，请刷新后再修改。',PEOPLE_MEMORY_EDIT_INVALID:'请填写500字以内的有效记忆。',PEOPLE_MEMORY_RESTORE_INVALID:'这条记忆已被新事实替代，不能直接恢复。',PEOPLE_MEMORY_NOTE_INACTIVE:'这条记忆已失效，请刷新后查看。',PEOPLE_MEMORY_FULL:'记忆文件已达到容量限制，原数据保留。',PEOPLE_MEMORY_NOTE_NOT_FOUND:'这条记忆已不存在。'};
export function createPeopleConsole({root,configFor,plugin,now=Date.now}){
 function store(expected){const account=activeReaderAccount(root);if(!/^[a-f0-9]{64}$/.test(account.id??''))throw fault('请先连接并验证微信。',409);if(expected!==undefined&&expected!==account.id)throw fault('账号已切换，请刷新后操作。',409);return {account:account.id,memory:new PeopleMemory({root,accountScope:hash(account.id),accountId:account.id,now,settings:configuration(root).config.plugins['people-memory']?.settings})};}
 function snapshot(params=new URLSearchParams()){
  const {account,memory}=store(params.get('scope')??undefined),query=(params.get('query')??'').trim().toLowerCase(),status=params.get('status')??'active';if(query.length>80||!['active','all','forgotten','expired'].includes(status))throw fault('记忆筛选条件无效。');
  const catalog=memory.managementCatalog(),config=configFor(),allowed=new Set(['private','groups'].flatMap(kind=>(config.wechat.whitelist?.[kind]??[]).map(id=>'wechat:'+(kind==='groups'?'group':'private')+':'+id)));
  const people=catalog.people.map(person=>({...person,notes:person.notes.filter(note=>allowed.has(note.chat)&&(status==='all'||note.status===status)).filter(note=>!query||[note.text,...person.names,person.id].some(text=>text.toLowerCase().includes(query)))})).filter(person=>person.notes.length);
  const offset=Number(params.get('offset')??0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw fault('分页参数无效。');
  if(store().account!==account)throw fault('账号已切换，请刷新。',409);return {scope:account,people:people.slice(offset,offset+12),offset,limit:12,total:people.length,stats:{people:people.length,notes:people.reduce((n,p)=>n+p.notes.length,0),recalled:Object.values(catalog.usage).reduce((n,u)=>n+(u.lastContextNotes??0),0)}};
 }
 function change(body){const {memory}=store(body?.scope);if(!body||body.scope===undefined)throw fault('请刷新页面后操作。',409);const config=configFor(),note=memory.managementCatalog().people.flatMap(p=>p.notes).find(n=>n.id===body.id),match=/^wechat:(private|group):(\d+)$/.exec(note?.chat??'');if(!match||!(config.wechat.whitelist?.[match[1]==='group'?'groups':'private']??[]).map(String).includes(match[2]))throw fault('该记忆的来源聊天不在当前允许范围内。',403);
  try{return memory.manage(Object.fromEntries(Object.entries(body).filter(([key])=>key!=='scope')));}catch(error){throw fault(messages[error.code??error.message]??'记忆更新未完成，原记录保留。',/BUSY|REVISION|INACTIVE/.test(error.message)?409:400);}
 }
 async function diagnostics(){
  const config=configFor(),files=['packages/dsh-social-bridge-plugin/native-context.mjs','packages/dsh-social-bridge-plugin/continuity-memory.mjs','packages/plugin-api/people-memory.mjs','packages/plugin-api/memory-policy.mjs','packages/plugin-api/contract.mjs'];const fingerprint=hash(files.map(file=>fs.existsSync(path.join(root,file))?hash(fs.readFileSync(path.join(root,file))):'missing').join(':')).slice(0,16);
  let health;try{health=await plugin('/health');}catch{}
  const data={hostFingerprint:fingerprint,expectedMemoryKernel:'layered-archive-v1',dsh:{connected:health?.ok===true,kernel:health?.memoryContinuity??null,loadedCurrentKernel:health?.memoryContinuity==='layered-archive-v1',workspaceMatches:health?.projectRoot?path.resolve(health.projectRoot).toLowerCase()===path.resolve(root).toLowerCase():false},history:{enabled:config.wechat.history?.enabled===true,recentMessages:config.wechat.history?.recentMessages??40,recentChars:config.wechat.history?.recentChars??12000,coldWakeMinutes:config.wechat.history?.coldWakeMinutes??30}};
  data.dsh.modelEvaluationReady=health?.memoryEvaluationTransport==='authenticated-rpc-v2';data.dsh.contractRevision=health?.pluginContractRevision??null;data.dsh.workbench=health?.memoryWorkbench??null;data.dsh.configurablePlugin=Array.isArray(health?.pluginHostFeatures)&&health.pluginHostFeatures.includes('people-memory-config-v1');data.dsh.loadedCurrentKernel=data.dsh.loadedCurrentKernel&&health?.memoryWorkbench==='fact-management-v1'&&data.dsh.configurablePlugin&&data.dsh.workspaceMatches;
  let sessions=[];if(health?.ok)try{const result=await plugin('/sessions');const allowed=new Set(['groups','private'].flatMap(kind=>(config.wechat.whitelist?.[kind]??[]).map(id=>'wechat:'+(kind==='groups'?'group':'private')+':'+id)));sessions=(result.sessions??[]).filter(row=>allowed.has(row.conversationKey)&&row.memoryDiagnostics).slice(0,30).map(row=>({key:row.conversationKey,...Object.fromEntries(['at','recentRecords','recentChars','personNotes','correctionCount','checkpoint'].map(field=>[field,Number.isFinite(row.memoryDiagnostics[field])?row.memoryDiagnostics[field]:null]))}));}catch{}
  data.sessions=sessions;
  return {...data,message:!health?'WorkBuddy 模型尚未连接，无法核对加载版本。':!data.dsh.workspaceMatches?'WorkBuddy 连接的数据目录尚未确认或与当前程序不同，请检查配置并重启应用。':!data.dsh.loadedCurrentKernel?'磁盘代码已准备；WorkBuddy 尚未加载新版记忆内核，请重启应用后重新打开。':'WorkBuddy 已加载新版分层记忆与管理接口。'};
 }
 return {snapshot,change,diagnostics};
}
