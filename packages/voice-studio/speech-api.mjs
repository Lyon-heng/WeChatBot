import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {CustomVoices} from './voices.mjs';import {atomicJson,json} from '../plugin-api/catalog.mjs';import {protectCredential} from '../netease/client.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fault=(message,status=400)=>Object.assign(Error(message),{status});
const protocolCache=new Map();
export function speechEndpoint(value){let url;try{url=new URL(value);}catch{throw fault('请填写有效的 API 地址。');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||value.length>2048)throw fault('API 地址仅支持 HTTP/HTTPS，不能包含账号、查询参数或片段。');url.pathname=url.pathname.replace(/\/+$/,'')||'/';if(url.pathname==='/')url.pathname='/v1';if(!url.pathname.endsWith('/audio/speech'))url.pathname=url.pathname.replace(/\/$/,'')+'/audio/speech';return url.href;}
export class SpeechApi{
 constructor(root,{protect=protectCredential,fetcher=fetch,resample}={}){Object.assign(this,{root,protect,fetcher,resample});}
 file(){return path.join(new CustomVoices(this.root).folder(),'engine.json');}
 read(){const file=this.file();if(!fs.existsSync(file))return {version:1,mode:'local',baseUrl:'',model:'',voice:'alloy',sendInstructions:false,key:''};if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>32768)throw fault('语音服务配置异常。');const data=json(file);if(data.version!==1||!['local','external'].includes(data.mode))throw fault('语音服务配置异常。');if(data.mode==='external')speechEndpoint(data.baseUrl);return data;}
 snapshot(){const {key,...data}=this.read();return {...data,hasKey:!!key,revision:hash(JSON.stringify({...data,key}))};}
 async save(body){if(!body||Object.keys(body).some(key=>!['revision','mode','baseUrl','model','voice','apiKey','clearKey','sendInstructions','voiceIds'].includes(key))||!['local','external'].includes(body.mode)||typeof body.baseUrl!=='string'||typeof body.model!=='string'||body.model.length>100||typeof body.voice!=='string'||!body.voice.trim()||body.voice.length>100||typeof body.sendInstructions!=='boolean'||typeof body.apiKey!=='string'||body.apiKey.length>4096||/[\r\n]/.test(body.apiKey))throw fault('语音 API 配置无效。');if(body.voiceIds!==undefined&&(!Array.isArray(body.voiceIds)||body.voiceIds.length>100||body.voiceIds.some(v=>typeof v!=='string'||!v.trim()||v.length>100||/[\r\n]/.test(v))))throw fault('音色ID清单无效。');const targetFile=this.file(),before=this.snapshot();if(body.revision!==before.revision)throw fault('语音服务配置已变化，请刷新后重试。',409);if(body.mode==='external'){speechEndpoint(body.baseUrl);if(!body.model.trim())throw fault('请填写外接语音模型。');}let key=this.read().key;if(body.clearKey)key='';if(body.apiKey.trim())try{key=await this.protect(body.apiKey.trim());}catch{throw fault('无法加密保存 API 密钥，原配置未更改。');}if(this.file()!==targetFile||this.snapshot().revision!==before.revision)throw fault('语音服务配置已变化，请刷新后重试。',409);atomicJson(this.file(),{version:1,savedAt:Date.now(),mode:body.mode,baseUrl:body.baseUrl.trim(),model:body.model.trim(),voice:body.voice.trim(),sendInstructions:body.sendInstructions,voiceIds:body.voiceIds??this.read().voiceIds??[],key});return this.snapshot();}
 /** 供应商协议：VoiceLab Studio 与 OpenAI 兼容 /audio/speech 的请求格式完全不同 */
 async protocolFor(settings,signal){
  const key=String(settings.baseUrl??'');
  const cached=protocolCache.get(key);if(cached&&Date.now()-cached.at<300000)return cached.value;
  let value='openai';
  try{
   const origin=new URL(key).origin;
   const response=await this.fetcher(origin+'/openapi.json',{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(2500),...(signal?[signal]:[])])});
   if(response.ok){const doc=await response.json().catch(()=>null);if(/voicelab/i.test(String(doc?.info?.title??'')))value='voicelab';}
  }catch{/* 探测失败按 OpenAI 兼容处理，保持原有行为 */}
  protocolCache.set(key,{value,at:Date.now()});return value;
 }
 async readWav(response,signal){
  const chunks=[];let length=0;
  for await(const bytes of response.body){signal?.throwIfAborted();length+=bytes.length;if(length>8*1024*1024){await response.body?.cancel().catch(()=>{});throw Error('VOICE_API_AUDIO_TOO_LARGE');}chunks.push(Buffer.from(bytes));}
  const wav=Buffer.concat(chunks);
  if(wav.length<44||wav.subarray(0,4).toString()!=='RIFF'||wav.subarray(8,12).toString()!=='WAVE')throw Error('VOICE_API_WAV_REQUIRED');
  return wav;
 }
 async openaiWav(text,settings,{voice,instruction,key,signal}){
  const response=await this.fetcher(speechEndpoint(settings.baseUrl),{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body:JSON.stringify({model:settings.model,input:text,voice:voice||settings.voice,response_format:'wav',...(settings.sendInstructions&&instruction?{instructions:instruction}:{})}),redirect:'error',signal});
  if(!response.ok){await response.body?.cancel();throw Object.assign(Error('VOICE_API_HTTP_'+response.status),{code:'VOICE_API_HTTP_'+response.status});}
  return this.readWav(response,signal);
 }
 /** VoiceLab Studio：POST /api/tts（multipart），按预设名或 id 找 preset_id，直接返回 WAV */
 async voicelabWav(text,settings,{voice,instruction,signal}){
  const origin=new URL(settings.baseUrl).origin;
  let preset=null;
  try{
   const response=await this.fetcher(origin+'/api/presets',{redirect:'error',signal});
   if(response.ok){
    const data=await response.json().catch(()=>({})),items=Array.isArray(data?.items)?data.items:[];
    const wanted=[voice,settings.voice,settings.model].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
    preset=items.find(item=>wanted.includes(item.id)||wanted.includes(item.name))??null;
   }
  }catch{/* 没有预设时用纯朗读，至少能出声 */}
  const form=new FormData();
  form.set('mode',preset?.has_audio?'clone':'tts');
  form.set('text',text);
  if(preset)form.set('preset_id',preset.id);
  if(settings.sendInstructions&&instruction)form.set('instruction',instruction);
  form.set('cfg_scale','1');form.set('seed','42');
  const response=await this.fetcher(origin+'/api/tts',{method:'POST',body:form,redirect:'error',signal});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw Object.assign(Error('VOICE_API_HTTP_'+response.status),{code:'VOICE_API_HTTP_'+response.status});}
  return this.readWav(response,signal);
 }
 async synthesize(text,{expectedRevision,voice,instruction,signal}={}){
  signal=AbortSignal.any([AbortSignal.timeout(90000),...(signal?[signal]:[])]);
  const targetFile=this.file(),settings=this.read();
  if(settings.mode!=='external'||expectedRevision&&this.snapshot().revision!==expectedRevision)throw Object.assign(Error('VOICE_API_SETTINGS_CHANGED'),{code:'VOICE_API_SETTINGS_CHANGED'});
  let key='';if(settings.key)try{key=await this.protect(settings.key,'unprotect');}catch{throw Object.assign(Error('VOICE_API_CREDENTIAL_UNAVAILABLE'),{code:'VOICE_API_CREDENTIAL_UNAVAILABLE'});}
  if(this.file()!==targetFile)throw Error('VOICE_ACCESS_CHANGED');
  const protocol=await this.protocolFor(settings,signal);
  const wav=protocol==='voicelab'
   ? await this.voicelabWav(text,settings,{voice,instruction,signal})
   : await this.openaiWav(text,settings,{voice,instruction,key,signal});
  if(this.resample)return this.resample(wav,{signal});
  const {wavToPcm}=await import('./singing.mjs');return wavToPcm(this.root,wav,{signal});
 }
}
