import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Match only our generated success notice, including queued notices from older versions.
// Actual scheduled results and failure notifications must still be delivered.
export const isSilentAssistantNotification=notice=>notice?.kind==='status'&&/^后台任务 [^\r\n]{1,100} 已结束，状态：completed。需要详细结果可让助手检查该任务。$/.test(notice.text??'');

// Outbound facts only. Native job output, credentials and reasoning are never
// copied into this queue. Every delivery rechecks account/chat/sender policy.
export class AssistantNotifications {
  constructor(file,allowed){this.file=file;this.allowed=allowed;this.bindings={};this.schedules={};this.messages={};if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('ASSISTANT_NOTIFICATIONS_INVALID');const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1)throw Error('ASSISTANT_NOTIFICATIONS_INVALID');Object.assign(this,{bindings:data.bindings??{},schedules:data.schedules??{},messages:data.messages??{}});}}
  persist(){for(const map of [this.bindings,this.schedules])for(const id of Object.keys(map).slice(0,-2000))delete map[id];fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,bindings:this.bindings,schedules:this.schedules,messages:this.messages}),{mode:0o600});fs.renameSync(temp,this.file);}
  queue({id,key,sender,text,kind='status'}){if(!this.allowed(key,sender))return;const hash=crypto.createHash('sha256').update(id+'\0'+key+'\0'+sender).digest('hex');if(!this.messages[hash]){this.messages[hash]={id:hash,key,sender,kind,...(kind==='result'?{textFormat:'wechat-result-text-v2'}:{}),text:String(text).slice(0,12000),at:Date.now(),state:'queued'};const items=Object.values(this.messages).sort((a,b)=>a.at-b.at);for(const item of items.slice(0,-200))delete this.messages[item.id];this.persist();}return hash;}
  list(){let changed=false;const result=[];for(const item of Object.values(this.messages)){if(item.state!=='queued')continue;if(isSilentAssistantNotification(item)||Date.now()-item.at>86400000||!this.allowed(item.key,item.sender)){item.state='cancelled';changed=true;}else result.push(item);}if(changed)this.persist();return result.slice(0,20);}
  ack(id){const item=this.messages[id];if(item?.state==='queued'){item.state='delivered';this.persist();}}
  observe(session,event,key,job){
    const sid=String(session.id),data=event.data;
    if(event.type==='job/registered'&&job){this.bindings[sid+'\0'+data.jobId]={key,sender:job.sender,taskId:job.id};this.persist();}
    if(event.type==='job/settled'){
      const item=this.bindings[sid+'\0'+data.jobId];if(item&&data.status!=='completed'&&data.cause!=='teardown'&&data.awaited!==true)this.queue({id:'job:'+sid+':'+data.jobId,key:item.key,sender:item.sender,text:`后台任务 ${String(data.jobId).slice(0,100)} 已结束，状态：${String(data.status??'已结束').slice(0,40)}。需要详细结果可让助手检查该任务。`});
    }
    if(event.type==='tool/result'&&job){
      const callId=data.message?.toolCallId??data.message?.source?.callId??data.message?.callId;
      const call=session.snapshotEvents().findLast(e=>e.type==='tool/call'&&e.data.callId===callId);if(!['schedule_create','schedule_update','schedule_delete'].includes(call?.data.name))return;
      let value;try{value=JSON.parse(data.message.content.filter(b=>b.type==='text').map(b=>b.text).join(''));}catch{return;}
      const id=value?.id??value?.record?.id;if(typeof id!=='string'||id.length>120||!id)return;
      if(call.data.name==='schedule_delete')delete this.schedules[sid+'\0'+id];else this.schedules[sid+'\0'+id]={key,sender:job.sender,taskId:job.id,sid,id};
      this.persist();
    }
  }
  scheduleOwner(sid,messages){
    const selected=messages.filter(message=>message.source?.kind==='schedule');if(!selected.length||selected.length!==messages.length)return null;
    const text=selected.flatMap(message=>message.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'),ids=[];
    // Read only the native framing fields. A reminder's user-supplied prompt
    // can mention another reminder ID and must never choose its permissions.
    try{for(const line of text.split('\n')){if(line.startsWith('schedule_id_json: '))ids.push(JSON.parse(line.slice(18)));if(line.startsWith('reminders_json: '))ids.push(...JSON.parse(line.slice(16)).map(item=>item.schedule_id));}}catch{return null;}
    if(!ids.length||ids.some(id=>typeof id!=='string'||!this.schedules[sid+'\0'+id]))return null;
    const matches=ids.map(id=>this.schedules[sid+'\0'+id]);
    if(new Set(matches.map(item=>item.sender)).size!==1)return null;
    const owner=matches[0];return this.allowed(owner.key,owner.sender)?owner:null;
  }
}
