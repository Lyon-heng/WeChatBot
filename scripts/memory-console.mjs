import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {activeReaderAccount} from './reader-account-state.mjs';
import {MEMBER_TAGS,memberMemoryEnabled} from '../packages/dsh-social-bridge-plugin/member-memory-policy.mjs';

const HEX=/^[a-f0-9]{64}$/,KEY=/^wechat:(private|group):[1-9]\d{0,15}$/,AGE=90*86400000;
const fault=(message,status=400)=>Object.assign(Error(message),{status});
function readHistory(file,keys,source){return new Promise(resolve=>{
  const worker=new Worker(new URL('./memory-console-worker.mjs',import.meta.url),{workerData:{file,keys,source},resourceLimits:{maxOldGenerationSizeMb:96}});let finished=false;
  const done=value=>{if(finished)return;finished=true;clearTimeout(timer);resolve(value);void worker.terminate();};
  const timer=setTimeout(()=>done({error:true}),2500);worker.once('message',done);worker.once('error',()=>done({error:true}));worker.once('exit',()=>done({error:true}));
});}
function safeFile(root,...parts){
  root=path.resolve(root);const file=path.join(root,'state',...parts);
  for(let current=file;current!==root;current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw fault('记忆目录包含链接，已停止读取。请检查数据目录。',409);
  return file;
}
function pageNumber(value,fallback,max){const n=value===null?fallback:Number(value);if(!Number.isSafeInteger(n)||n<0||n>max)throw fault('记忆筛选参数无效。');return n;}
export function createMemoryConsole({root,configFor,plugin,now=Date.now}){
  function scope(expected){const activeFile=safeFile(root,'weflow','active-account.json');void activeFile;const value=activeReaderAccount(root),id=value.id||value.legacyId;if(!id||!HEX.test(id))throw fault('请先连接并验证微信，再查看当前账号的记忆。',409);if(expected!==undefined&&expected!==null&&expected!==id)throw fault('微信账号已切换，请刷新记忆页面。',409);return id;}
  function chat(key){const config=configFor(),match=KEY.exec(key??'');if(!match||!(config.wechat.whitelist?.[match[1]==='group'?'groups':'private']??[]).map(String).includes(key.split(':')[2]))throw fault('请选择已保存聊天范围中的会话。',403);return config;}
  function overview(){
    let accountScope;try{accountScope=scope();}catch(error){if(error.status!==409)throw error;return {available:false,message:error.message,chats:[]};}
    const config=configFor(),chats=['groups','private'].flatMap(kind=>(config.wechat.whitelist?.[kind]??[]).map(id=>{const key='wechat:'+(kind==='groups'?'group':'private')+':'+id;return {key,id:String(id),kind,memberMemoryEnabled:memberMemoryEnabled(config.wechat,key)};}));
    return {available:true,accountScope,chats};
  }
  function members(params){
    const id=scope(params.get('scope')),key=params.get('conversationKey'),config=chat(key);if(!key.startsWith('wechat:group:'))throw fault('群友记忆只适用于群聊。');
    const offset=pageNumber(params.get('offset'),0,100000),query=(params.get('query')??'').trim().toLocaleLowerCase(),status=params.get('status')??'all';if(query.length>80||!['all','observed','tentative','untagged'].includes(status))throw fault('群友筛选参数无效。');
    const file=safeFile(root,'member-memory',id,key.split(':')[2]+'.json');let entries=[];
    if(fs.existsSync(file)){
      if(!fs.statSync(file).isFile()||fs.statSync(file).size>4*1024*1024)throw fault('群友记忆文件过大或无效，原文件已保留。',409);
      let data;try{data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw fault('群友记忆 JSON 无法解析，原文件已保留。',409);}
      if(data.version!==1||data.accountScope!==id||data.conversationKey!==key||!data.members||typeof data.members!=='object'||Array.isArray(data.members)||Object.keys(data.members).length>500)throw fault('群友记忆文件与账号或群聊不匹配，原文件已保留。',409);
      try{entries=Object.entries(data.members).map(([memberId,m])=>{
        if(!HEX.test(memberId)||m?.memberId!==memberId||!Array.isArray(m.names)||m.names.length>5||m.names.some(name=>typeof name!=='string'||name.length>80)||!Array.isArray(m.tags)||m.tags.length>6||!Number.isSafeInteger(m.lastSeenAt))throw Error();
        const tags=m.tags.map(tag=>{if(!MEMBER_TAGS.includes(tag?.label)||!Array.isArray(tag.evidence)||tag.evidence.length>6||tag.evidence.some(e=>!e||!/^[a-f0-9]{32}$/.test(e.id??'')||!Number.isSafeInteger(e.at)))throw Error();const evidence=[...new Map(tag.evidence.filter(e=>e.at<=now()+60000&&now()-e.at<AGE).map(e=>[e.id,e])).values()];return {label:tag.label,evidenceCount:evidence.length,status:evidence.length>=3?'observed':'tentative',confidence:Math.min(.85,.25+.1*evidence.length),updatedAt:Number.isSafeInteger(tag.updatedAt)?tag.updatedAt:null};}).filter(tag=>tag.evidenceCount>0);
        return {memberId,senderId:/^[1-9]\d{0,15}$/.test(m.senderId??'')?m.senderId:'',names:m.names,tags,firstSeenAt:Number.isSafeInteger(m.firstSeenAt)?m.firstSeenAt:null,lastSeenAt:m.lastSeenAt};
      });}catch{throw fault('群友记忆结构无效，原文件已保留。',409);}
    }
    const stats={members:entries.length,tags:entries.reduce((n,m)=>n+m.tags.length,0),tentative:entries.reduce((n,m)=>n+m.tags.filter(tag=>tag.status==='tentative').length,0)};
    const filtered=entries.filter(m=>(!query||[m.senderId,m.memberId,...m.names,...m.tags.map(t=>t.label)].some(s=>s.toLocaleLowerCase().includes(query)))&&(status==='all'||(status==='untagged'?!m.tags.length:m.tags.some(tag=>tag.status===status)))).sort((a,b)=>b.lastSeenAt-a.lastSeenAt||a.memberId.localeCompare(b.memberId));
    scope(id);return {accountScope:id,conversationKey:key,enabled:memberMemoryEnabled(config.wechat,key),stats,total:filtered.length,offset,limit:24,members:filtered.slice(offset,offset+24)};
  }
  async function summaries(params){
    const id=scope(params.get('scope')),key=params.get('conversationKey');chat(key);const offset=pageNumber(params.get('offset'),0,100000),source=params.get('source')??'all';if(!['all','history','native'].includes(source))throw fault('请选择有效的记忆来源。');
    const file=safeFile(root,'chat-history',id,'history.sqlite'),keys=[key,key+':assistant',key+':assistant-chat'];let history=[],historyTotal=0,historyError='',native=[],nativeAvailable=false,nativeStatus='unavailable';
    try{if(fs.existsSync(file)){
      safeFile(root,'chat-history',id,'history.sqlite-wal');safeFile(root,'chat-history',id,'history.sqlite-shm');
      if(!fs.statSync(file).isFile())throw Error('HISTORY_FILE_INVALID');
      const result=await readHistory(file,keys,source);if(result.error)throw Error('HISTORY_READ_UNAVAILABLE');history=result.history;historyTotal=result.historyTotal;native=result.native;if(native.length){nativeAvailable=true;nativeStatus='saved';}
    }}catch{historyError='本地摘要暂时无法读取，请稍后刷新；原数据未改动。';}
    // Fetch at most 50 projected native summaries; the endpoint never resumes an agent.
    if(source!=='history')try{const response=await plugin('/memory/native?conversationKey='+encodeURIComponent(key));if(response.accountScope!==id)throw Error('account changed');const combined=new Map(native.map(row=>[row.id,row]));for(const row of response.summaries??[])combined.set(row.id,row);native=[...combined.values()].sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).slice(0,50);nativeAvailable=true;nativeStatus='live';}catch{}
    const rows=[...history,...native].sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
    scope(id);return {accountScope:id,conversationKey:key,offset,limit:24,total:rows.length,historyTotal,historyLimited:historyTotal>200,historyError,nativeAvailable,nativeStatus,summaries:rows.slice(offset,offset+24)};
  }
  return {overview,members,summaries};
}
