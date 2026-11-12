import {advanceSongPart} from '../packages/voice-studio/segments.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {VoiceJobs,VOICE_TERMINAL,voiceError} from '../packages/voice-studio/jobs.mjs';
import {synthesizeVoice} from '../packages/voice-studio/synthesis.mjs';
import {runMusicTool} from '../packages/voice-studio/music.mjs';
import {voiceQueueRank} from '../packages/voice-studio/progress.mjs';
import {voiceSendReadyAt} from '../packages/voice-studio/delivery-policy.mjs';
import {readSendingMode} from '../packages/wechat-send-policy.mjs';
export async function verifyVoicePayload(root,job,{signal}={}){
  if(!/^[a-f0-9]{64}$/.test(job.id??''))return null;
  try{
    const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
    const output=await runMusicTool(config.runtime.python,['-B',path.join(root,'scripts/voice-receipt.py'),job.id],{signal,timeoutMs:15000});
    const receipt=JSON.parse(output.trim().split(/\r?\n/).at(-1)).receipt;
    return receipt?.type==='wechat-voice'&&receipt.serverConfirmed===true&&receipt.payloadMatched===true&&/^[1-9]\d*$/.test(receipt.messageId??'')?receipt:null;
  }catch{return null;}
}
const rowKey=row=>JSON.stringify([row.localId,row.serverId,row.createTime]);
export function voiceReceipt(rows,job){
  if(!Array.isArray(job.baseline)||!Number.isFinite(job.startedAt))return null;
  const candidates=rows.filter(row=>row.isSend&&Number(row.localType)===34&&!job.baseline.includes(rowKey(row))&&Number(row.createTime)>=Math.floor(job.startedAt/1000)-1&&/^[1-9]\d*$/.test(String(row.serverId??'')));
  for(const row of candidates){const xml=String(row.fullText??row.content??row.parsedContent??'').slice(0,16000),md5=xml.match(/\bvoicemd5=["']([a-fA-F0-9]{32})["']/)?.[1]?.toLowerCase();if(md5===job.md5)return {messageId:String(row.localId),type:'wechat-voice',serverConfirmed:true};}
  return null;
}
export class VoiceDeliveryWorker{
  constructor(adapter,{log=()=>{},synthesize=synthesizeVoice,verifyPayload=verifyVoicePayload}={}){Object.assign(this,{adapter,log,synthesize,verifyPayload});this.store=new VoiceJobs(adapter.directory);this.stopped=false;this.nextAt=0;this.lanes=new Map();this.inflight=new Set();}
  save(job){if(VOICE_TERMINAL.has(job.state)){job.completedAt??=Date.now();if(['failed','expired'].includes(job.state)&&job.fallbackText&&!job.startedAt&&job.error!=='VOICE_ACCESS_CHANGED')job.fallbackState??='queued';}this.store.write(job);this.log('[Voice] '+job.id.slice(0,12)+' state='+job.state+(job.error?' code='+job.error:''));}
  tick(){
    if(readSendingMode(this.adapter.directory)==='foreground')this.lanes.get('generation')?.controller.abort();
    if(this.stopped||Date.now()<this.nextAt)return;
    const jobs=this.store.list().filter(job=>!this.inflight.has(job.id)&&((job.retryAt??0)<=Date.now()||['queued','generating','prepared'].includes(job.state)&&!job.waitReason||job.deadlineAt<=Date.now()&&!VOICE_TERMINAL.has(job.state)));
    const delivery=jobs.filter(job=>['prepared','submitting','submitted'].includes(job.state)||job.fallbackState==='queued').sort((a,b)=>(a.state==='prepared'?0:1)-(b.state==='prepared'?0:1)||a.createdAt-b.createdAt)[0];
    const generation=jobs.filter(job=>['queued','generating'].includes(job.state)).sort((a,b)=>voiceQueueRank(a)-voiceQueueRank(b)||a.createdAt-b.createdAt)[0];
    for(const [lane,job]of [['delivery',delivery],['generation',generation]]){if(!job||this.lanes.has(lane))continue;const controller=new AbortController();this.inflight.add(job.id);const task=(job.fallbackState==='queued'?this.sendFallback(job,controller.signal):this.run(job,controller.signal)).catch(error=>{if(this.store.cancelled(job))return;job.state=['submitting','submitted'].includes(job.state)?'unconfirmed':'failed';job.error=/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code??error.message)?error.code??error.message:'VOICE_DELIVERY_FAILED';this.adapter.status.last_voice_error=job.error;this.save(job);}).finally(()=>{this.inflight.delete(job.id);this.lanes.delete(lane);});this.lanes.set(lane,{controller,task});}
  }
  async sendFallback(job,signal){
    if(!this.store.allowed(job)||this.store.cancelled(job)||signal.aborted){job.fallbackState='cancelled';this.store.write(job);return;}
    if(job.request.kind!=='speech'||job.fallbackText!==job.request.text||job.startedAt){job.fallbackState='cancelled';this.store.write(job);return;}
    job.fallbackDeadlineAt??=Date.now()+120000;if(Date.now()>job.fallbackDeadlineAt){job.fallbackState='failed';this.store.write(job);return;}
    const [,kind,target]=job.key.split(':');try{job.fallbackAttempts=(job.fallbackAttempts??0)+1;this.store.write(job);await this.adapter.send(kind,target,job.fallbackText,'voice-fallback:'+job.id,false);job.fallbackState='confirmed';delete job.retryAt;}catch{job.retryAt=Date.now()+3000;}this.store.write(job);
  }
  async run(job,signal){
    const adapter=this.adapter;
    if(readSendingMode(adapter.directory)==='foreground'){job.state=['submitting','submitted'].includes(job.state)?'unconfirmed':'failed';job.error='VOICE_DISABLED_IN_FOREGROUND';this.save(job);return;}
    if(!this.store.allowed(job)){job.state=['submitting','submitted'].includes(job.state)?'unconfirmed':'cancelled';job.error='VOICE_ACCESS_CHANGED';this.save(job);return;}
    if(Date.now()>=job.deadlineAt){job.state=['submitting','submitted'].includes(job.state)?'unconfirmed':'expired';this.save(job);return;}
    const identity=await adapter.checkNative();if(adapter.status.native_voice_send!==true){this.nextAt=Date.now()+5000;job.waitReason='native_not_ready';this.store.write(job);adapter.status.last_voice_error='VOICE_NATIVE_SENDER_NOT_READY';return;}
    const [,kind,target]=job.key.split(':'),wxid=await adapter.resolveTarget(kind,target);
    if(job.account&&job.account!==identity.account||job.wxid&&job.wxid!==wxid)throw voiceError('VOICE_ACCOUNT_CHANGED');
    if(['queued','generating'].includes(job.state)){
      if((job.generationAttempts??0)>=2)throw voiceError('VOICE_GENERATION_INTERRUPTED');job.generationAttempts=(job.generationAttempts??0)+1;job.state='generating';job.generationStartedAt??=Date.now();this.save(job);
      const timeout=AbortSignal.timeout(Math.max(1,job.deadlineAt-Date.now())),proof=await this.synthesize(adapter.directory,job.request,this.store.settings(job),{signal:AbortSignal.any([signal,timeout]),remoteJobId:job.singingJobId,onProgress:(stage,detail)=>{const progress=detail&&Number.isSafeInteger(detail.part)&&Number.isSafeInteger(detail.parts)&&detail.part>=1&&detail.part<=detail.parts&&detail.parts<=60?{part:detail.part,parts:detail.parts}:{};if(!this.store.cancelled(job)&&this.store.allowed(job)&&(job.progress?.stage!==stage||progress.part!==undefined&&progress.part!==job.progress?.part)){job.progress={stage,...progress,at:Date.now()};this.store.write(job);}},onRemoteJob:id=>{if(!this.store.cancelled(job)){job.singingJobId=id;this.save(job);}}});
      if(this.store.cancelled(job))return;Object.assign(job,proof);
      if(readSendingMode(adapter.directory)==='foreground')throw voiceError('VOICE_DISABLED_IN_FOREGROUND');
      job.generationFinishedAt=Date.now();job.state='prepared';delete job.retryAt;delete job.waitReason;this.save(job);return;
    }
    if(job.state==='prepared'){
      if(this.store.cancelled(job))return;if(!this.store.allowed(job)||signal.aborted)throw voiceError('VOICE_ACCESS_CHANGED');
      const lock=kind+':'+target;if(adapter.targetsSending.has(lock)||adapter.targetsSending.size>=(adapter.hook?.maxConcurrentSends??4)){job.retryAt=Date.now()+500;job.waitReason='target_busy';this.store.write(job);return;}
      adapter.targetsSending.add(lock);
      try{
        const source=path.join(adapter.directory,'state/voice/outgoing',job.md5+'.silk');if(!/^[a-f0-9]{32}$/.test(job.md5??'')||fs.lstatSync(source).isSymbolicLink()||fs.statSync(source).size!==job.size||job.size>1024*1024||crypto.createHash('md5').update(fs.readFileSync(source)).digest('hex')!==job.md5)throw voiceError('VOICE_STAGED_INVALID');
        const rows=await adapter.messages(wxid),now=Date.now(),readyAt=voiceSendReadyAt(rows,now,this.store.settings(job));
        if(readyAt>now){job.retryAt=readyAt;job.waitReason='voice_rate_limit';this.store.write(job);return;}delete job.waitReason;delete job.retryAt;
        job.baseline=rows.map(rowKey);job.startedAt=now;job.account=identity.account;job.wxid=wxid;
        if(this.store.cancelled(job))return;if(!this.store.allowed(job)||signal.aborted)throw voiceError('VOICE_ACCESS_CHANGED');job.state='submitting';this.save(job);
        try{const response=await adapter.native('/SendVoiceMsg',{wxidorgid:wxid,path:source,md5:job.md5,size:job.size,duration_ms:job.durationMs},identity.account);if(response?.ret!==0)throw voiceError('VOICE_NATIVE_REJECTED');}
        catch(error){if(error.code==='VOICE_NATIVE_REJECTED'||/^API_HTTP_(400|401|403|409|429)$/.test(error.message??'')){job.state='failed';throw error;}job.error='VOICE_SUBMISSION_UNCERTAIN';}
        if(this.store.cancelled(job))return;job.state='submitted';this.save(job);
      }finally{adapter.targetsSending.delete(lock);}
    }
    if(['submitting','submitted'].includes(job.state)){
      let receipt=voiceReceipt(await adapter.messages(wxid),job);
      if(!receipt&&Date.now()-(job.payloadCheckedAt??0)>=5000){job.payloadCheckedAt=Date.now();this.store.write(job);receipt=await this.verifyPayload(adapter.directory,job,{signal});}
      if(receipt){if(this.store.cancelled(job)||!this.store.allowed(job)||signal.aborted)return;if(advanceSongPart(job,receipt)){this.save(job);adapter.status.confirmed_sends++;return;}job.state='confirmed';job.receipt=receipt;delete job.error;this.save(job);adapter.status.confirmed_sends++;return;}
      if(Date.now()-(job.startedAt??0)>45000){job.state='unconfirmed';job.error='VOICE_RECEIPT_UNCONFIRMED';this.save(job);}else{job.retryAt=Date.now()+1000;this.store.write(job);}
    }
  }
  stop(){this.stopped=true;for(const {controller}of this.lanes.values())controller.abort();}
}
