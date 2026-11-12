import crypto from 'node:crypto';
import {verifiedAssistantSender,validWechatIdentity} from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';

export const validMention = value => value && validWechatIdentity(value.wxid) && value.wxid!=='all' &&
  /^[1-9]\d{0,15}$/.test(value.id??'') && String(Number(crypto.createHash('sha256').update(value.wxid).digest().readBigUInt64BE(0)%2147483647n+1n))===value.id && typeof value.name==='string' && value.name.length>0 && value.name.length<=80 && !/[\r\n\x00-\x1f\u2005]/.test(value.name);
export function mentionCandidates(rows){
  const members=new Map();
  for(const row of rows){
    if(row.kind!=='group'||row.outgoing||row.forwardedRecord)continue;
    const wxid=verifiedAssistantSender(row),key=crypto.createHash('sha256').update('wechat-member:'+wxid).digest('hex');
    const member={id:String(row.sender_id),wxid,name:String(row.sender_name||row.sender_id).trim().slice(0,80)};
    if(wxid&&row.sender_key===key&&member.id!==String(row.self_id)&&validMention(member))members.set(key,member);
  }
  return members;
}
export function groupMentionPrompt(rows){
  const members=mentionCandidates(rows);
  return members.size?'\n群聊定向回复：明确回答某位群友的问题或直接叫对方名字时，在 RESPOND: 后、正文前加 [REPLY_TO:成员ID]，程序会在第一条文字前真正艾特该成员。成员ID必须取自本轮下列映射；正文不用重复写 @名字。面向全群的闲聊、仅提及第三人时不加，不艾特全体。名字重复时按发言的成员ID区分，不能猜。\n'+[...members].map(([key,m])=>JSON.stringify({成员ID:key,名字:m.name})).join('\n'):'';
}
export function directedGroupReply(result,rows){
  if(result.decision!=='RESPOND')return result;
  const parts=[...(result.textParts??[result.text])],members=mentionCandidates(rows);
  const marker=/^\s*\[REPLY_TO:([a-f0-9]{64})\]\s*/.exec(parts[0]);
  let member=result.replyToKey?members.get(result.replyToKey):marker?members.get(marker[1]):null;
  if(marker)parts[0]=parts[0].slice(marker[0].length).trim();
  // Also support natural name-first replies from models that omit the marker.
  if(!marker){
    const matches=[...members.values()].filter(m=>parts[0].startsWith('@'+m.name+'\u2005')||new RegExp('^@?'+m.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[，,:：!！、\\s]').test(parts[0]));
    if(matches.length===1){member=matches[0];parts[0]=parts[0].replace(new RegExp('^@?'+member.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[，,:：!！、\\s]+'),'').trim();}
  }
  // Never expose malformed controls, including private-chat or invented IDs.
  if(parts.some(text=>/\[REPLY_TO:/i.test(text)))return {decision:'INVALID',text:''};
  if(!parts[0])parts.shift();
  if(!parts.length)return {decision:'INVALID',text:''};
  if(member)for(let i=0;i<parts.length;i++)parts[i]=parts[i].replace(new RegExp('^@'+member.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[，,:：!！、\\s]+'),'').trim();
  const {textParts,mention,replyToKey,...base}=result;
  return {...base,text:parts.join('\n\n'),...(parts.length>1?{textParts:parts}:{}),...(member?{mention:member}:{})};
}
// A fresh model turn is not necessarily a new conversation. Persist the actual
// first reminder in outgoing history so restarts cannot reset this cooldown.
export function limitGroupMention(result,recent,now=Date.now(),windowMs=10*60000){
  if(!result.mention)return result;
  const notified=recent.some(row=>row.outgoing&&row.mention?.wxid===result.mention.wxid&&['confirmed','unconfirmed'].includes(row.delivery_status)&&Number.isFinite(row.timestamp)&&row.timestamp*1000<=now&&now-row.timestamp*1000<windowMs);
  if(!notified)return result;
  const {mention,...plain}=result;return plain;
}
