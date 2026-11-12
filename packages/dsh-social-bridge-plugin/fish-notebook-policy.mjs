import crypto from 'node:crypto';
import {allowedConversation} from './conversation-policy.mjs';
import {verifiedAssistantSender} from './assistant-policy.mjs';
export const NOTEBOOK_DEFAULTS=Object.freeze({enabled:false,writeTime:'21:30'});
export const notebookHash=value=>crypto.createHash('sha256').update(value).digest('hex');
export function validateFishNotebook(settings){
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['enabled','writeTime','chats'].includes(k)))throw Error('鱼的记事本设置无效。');
  if(settings.enabled!==undefined&&typeof settings.enabled!=='boolean')throw Error('记事本开关必须为开关值。');
  if(settings.writeTime!==undefined&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.writeTime))throw Error('写日记时间应为 HH:MM。');
  if(settings.chats!==undefined&&(!settings.chats||typeof settings.chats!=='object'||Array.isArray(settings.chats)||Object.entries(settings.chats).some(([key,value])=>!/^wechat:(private|group):[1-9]\d{0,15}$/.test(key)||typeof value!=='boolean')))throw Error('记事本聊天开关无效。');
}
export function fishNotebookEnabled(wechat,key){validateFishNotebook(wechat?.fishNotebook);return allowedConversation(wechat,key)&&wechat.fishNotebook?.enabled===true&&wechat.fishNotebook.chats?.[key]!==false;}
export function notebookDay(now=Date.now()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),get=name=>parts.find(p=>p.type===name).value;
  return {date:get('year')+'-'+get('month')+'-'+get('day'),time:get('hour')+':'+get('minute')};
}
export function isNotebookQuestion(text){
  text=String(text??'').trim();if(text.length>300||/[\r\n]|```|<untrusted_|^[>＞]/.test(text))return false;
  if(/(?:不要|不用|别|不想|不愿)(?:(?:再|给我|让我|去|先|马上|直接)){0,3}(?:看|读|翻|发|分享|给)[^。！？]{0,12}(?:日记|记事本|小本本)/.test(text))return false;
  if(/(?:我的|我写的|她的|他的|别人的|示例|举例|怎么写|帮我写)/.test(text)&&!/(?:你的|鱼的)/.test(text))return false;
  return /(?:日记|(?:鱼的|你的|你的小)?记事本|小本本)/.test(text)&&(/(?:看|读|翻|给|发|写了|写的|内容|记了|记录了|有啥|有什么|分享|告诉|记事本[?？]|日记[?？])/.test(text)||/^(?:你的|鱼的|今天的)?(?:日记|记事本|小本本)[！!。]*$/.test(text));
}
function notebookViewer(row){const wxid=verifiedAssistantSender(row);return /^[a-f0-9]{64}$/.test(row.sender_key??'')?row.sender_key:wxid?notebookHash('wxid\0'+wxid):row.kind==='private'&&String(row.sender_id)===String(row.conversation_id)?notebookHash('private\0'+row.conversation_id):'';}
const followup=text=>/^(?:(?:那|再|就|还|快|让我|给我|求求你|求你|可以|能不能|要|想|我想|我就|我再|嗯|好嘛|嘛|吧|呀|啊|哎)){0,6}(?:看(?:看|一下|一眼|一回|一次)?|翻(?:翻|一下)?)(?:嘛|吧|呀|啊|啦|呗|好吗|好不好|一次|一下|！|!|？|\?|。|~|～)*$/.test(String(text??'').trim().replace(/^@\S+\s+/,''));
export function notebookQuery(rows,history=[]){
  const row=[...rows].reverse().find(r=>!r.outgoing&&!r.forwardedRecord&&!r.quoteReply&&r.interaction!=='pat'&&String(r.text??'').trim());
  if(!row||row.platform!=='wechat'||!row.message_id&&!row.id)return null;
  const viewer=notebookViewer(row);let question=isNotebookQuestion(row.text);
  if(!question&&viewer&&followup(row.text))for(const prior of [...history].reverse()){
    if(prior.outgoing||String(prior.message_id||prior.id)===String(row.message_id||row.id)||notebookViewer(prior)!==viewer)continue;
    if(!Number.isFinite(row.timestamp)||!Number.isFinite(prior.timestamp)||row.timestamp-prior.timestamp<0||row.timestamp-prior.timestamp>600||prior.forwardedRecord||prior.quoteReply)break;
    if(isNotebookQuestion(prior.text)){question=true;break;}if(!followup(prior.text))break;
  }
  if(!question)return null;
  if(!viewer)return null;return {id:notebookHash(String(row.message_id||row.id)),viewer};
}
