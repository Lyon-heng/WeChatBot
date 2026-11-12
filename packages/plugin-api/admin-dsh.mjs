import fs from 'node:fs';import path from 'node:path';
import {assistantSenderAllowed} from '../dsh-social-bridge-plugin/assistant-policy.mjs';
function cancellationEvidence(row,turn,args){
 if(row.senderId!==turn.actorId||typeof args.evidenceId!=='string'||row.evidenceId!==args.evidenceId)return false;
 const text=String(row.text??'').trim();
 if(!/^(?:请|帮我|麻烦)?\s*(?:取消|停止|终止)(?:这个|当前|指定)?任务(?:\s*T[a-f0-9]{16})?[。！!\s]*$|^(?:please\s+)?cancel\s+(?:this\s+|the\s+|current\s+)?task(?:\s+T[a-f0-9]{16})?[.!\s]*$/i.test(text))return false;
 const named=text.match(/T[a-f0-9]{16}/)?.[0];return !named||named===args.taskId;
}
export function adminDshRequest(root,turn,args){
 const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
 if(!assistantSenderAllowed(config.wechat,turn.conversationKey,turn.actorId)||(config.wechat.workModes?.[turn.conversationKey]!=='assistant'&&config.wechat.dshAccess?.chats?.[turn.conversationKey]?.chatExecution!==true))throw Error('ADMIN_DSH_PERMISSION_DENIED');
 if(!args||Object.keys(args).some(key=>!['action','taskId','evidenceId'].includes(key))||!['list','status','result','cancel','capabilities'].includes(args.action)||args.taskId!==undefined&&!/^T[a-f0-9]{16}$/.test(args.taskId))throw Error('ADMIN_DSH_REQUEST_INVALID');
 if(args.action==='cancel'&&!(turn.peopleObservations??[]).some(row=>cancellationEvidence(row,turn,args)))throw Error('ADMIN_DSH_CANCEL_CONFIRMATION_REQUIRED');
 return {action:args.action,body:{conversationKey:turn.conversationKey,senderWxid:turn.actorId,...(args.taskId?{taskId:args.taskId}:{})}};
}
