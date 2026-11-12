import fs from 'node:fs';
import path from 'node:path';
import {memoryPluginPolicy} from '../plugin-api/memory-policy.mjs';

export const HISTORY_POLICY=Symbol.for('wechatagent.chat-history.v1');
export const HISTORY_DEFAULTS=Object.freeze({enabled:false,mode:'bounded',restoreHistory:true,windowStrategy:'rolling',recentMessages:40,recentChars:12000,coldWakeMinutes:30,summaryChars:3200,summaryInputChars:24000,maxSessionTurns:32,maxSessionEvents:1500,maxContextTokens:20000,maxContextChars:64000,maxAgeHours:168});
const ranges={recentMessages:[4,100],recentChars:[2000,24000],coldWakeMinutes:[0,1440],summaryChars:[800,6000],summaryInputChars:[4000,48000],maxSessionTurns:[4,200],maxSessionEvents:[100,5000],maxContextTokens:[8000,100000],maxContextChars:[24000,200000],maxAgeHours:[1,720]};
/** Upgrade only installations that predate history settings. Explicit owner
 * choices (including disabled history or rolling windows) remain authoritative. */
export function migrateHistorySettings(config){
  if(!config?.wechat||Array.isArray(config.wechat)||Object.hasOwn(config.wechat,'history'))return false;
  config.wechat.history={...HISTORY_DEFAULTS,enabled:true,mode:'window',windowStrategy:'append',recentMessages:40,recentChars:12000,coldWakeMinutes:0,chats:{}};
  return true;
}
export function validateHistorySettings(value){
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('history settings invalid');
  for(const [key,item]of Object.entries(value)){
    if(key==='enabled'){if(typeof item!=='boolean')throw Error('history enabled invalid');}
    else if(key==='mode'){if(!['bounded','window'].includes(item))throw Error('history mode invalid');}
    else if(key==='windowStrategy'){if(!['rolling','append'].includes(item))throw Error('history windowStrategy invalid');}
    else if(key==='restoreHistory'){if(typeof item!=='boolean')throw Error('history restoreHistory invalid');}
    else if(key==='chats'){if(!item||typeof item!=='object'||Array.isArray(item)||Object.entries(item).some(([k,v])=>!/^wechat:(private|group):[1-9]\d*$/.test(k)||typeof v!=='boolean'))throw Error('history chats invalid');}
    else if(!ranges[key]||!Number.isSafeInteger(item)||item<ranges[key][0]||item>ranges[key][1])throw Error('history '+key+' invalid');
  }
  const p={...HISTORY_DEFAULTS,...value};
  if(p.recentChars+p.summaryChars+8000>p.maxContextChars*.8)throw Error('history seed exceeds context budget');
}
export function historyPolicy(wechat={},key){
  const value=wechat.history??{};validateHistorySettings(value);
  const match=/^wechat:(private|group):([1-9]\d*)$/.exec(key),allowed=match&&(wechat.whitelist?.[match[1]==='group'?'groups':'private']??[]).map(String).includes(match[2]);
  return {...HISTORY_DEFAULTS,...value,enabled:!!allowed&&value.enabled===true&&value.chats?.[key]!==false};
}
export function readHistoryPolicy(root,key){
  const file=path.join(root,'config/wechatagent.json');
  const policy=historyPolicy(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')).wechat:{},key),memory=memoryPluginPolicy(root,key);
  if(!memory.active)return policy;
  return {...policy,recentMessages:memory.settings.recentMessages,recentChars:Math.min(memory.settings.recentChars,Math.max(2000,Math.floor(policy.maxContextChars*.8)-policy.summaryChars-8001)),coldWakeMinutes:memory.settings.coldWakeMinutes};
}
export function sessionSize(session){
  const events=session.snapshotEvents(),nodes=new Set(session.surface.nodes);
  const chars=events.filter(e=>nodes.has(e.seq)).reduce((n,e)=>{
    const derived=session.deriveEventMessage?.(e),message=derived?.content?derived:derived?.message??e.data.message??e.data;
    // Durable settlements also contain a packed stream, usage and replay
    // metadata. Count the effective message once, not the audit envelope.
    return n+JSON.stringify({role:message.role,content:message.content,toolCalls:message.toolCalls}).length;
  },0);
  return {events:events.length,turns:events.filter(e=>e.type==='turn/end').length,chars};
}
export function rotationReason(size,policy,{tokens=0,createdAt=Date.now(),incomingChars=0,now=Date.now()}={}){
  if(size.turns>=policy.maxSessionTurns)return 'turns';
  if(size.events>=policy.maxSessionEvents-50)return 'events';
  if(tokens>=policy.maxContextTokens)return 'tokens';
  if(size.chars+incomingChars+8000>=policy.maxContextChars*.8)return 'characters';
  if(size.turns&&now-createdAt>=policy.maxAgeHours*3600000)return 'age';
  return null;
}
