import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {directory,atomicJson} from '../plugin-api/catalog.mjs';import {voiceError} from './jobs.mjs';
import {songRenderSignature} from './saved-songs.mjs';
import {prepareSong,mixSong} from './music.mjs';
import {resolveFfmpeg,wavToPcm24k} from './wav-resample.mjs';
export function pcmToWav(pcm){const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);}
export async function wavToPcm(root,wav,{signal,pitchSemitones=0,speed=1,volume=1,bassDb=0,trebleDb=0,normalize=false,trimSilence=false,lightVoice=false,maxSeconds=60}={}){
  if(!Number.isInteger(maxSeconds)||maxSeconds<1||maxSeconds>600)throw voiceError('VOICE_DURATION_LIMIT_INVALID');
  if(!Number.isFinite(pitchSemitones)||pitchSemitones<0||pitchSemitones>5)throw voiceError('VOICE_PITCH_INVALID');
  if(!Number.isFinite(speed)||speed<0.75||speed>1.25)throw voiceError('VOICE_SPEED_INVALID');
  for(const [value,min,max]of [[volume,0.5,1.5],[bassDb,-6,6],[trebleDb,-6,6]])if(!Number.isFinite(value)||value<min||value>max)throw voiceError('VOICE_EFFECT_INVALID');
  if(typeof normalize!=='boolean'||typeof trimSilence!=='boolean'||typeof lightVoice!=='boolean')throw voiceError('VOICE_EFFECT_INVALID');
  const filters=[];
  if(pitchSemitones||speed!==1)filters.push(`rubberband=pitch=${2**(pitchSemitones/12)}:tempo=${speed}:formant=preserved`);
  if(trimSilence)filters.push('silenceremove=start_periods=1:start_duration=0:start_threshold=-48dB:start_silence=0.08','areverse','silenceremove=start_periods=1:start_duration=0:start_threshold=-48dB:start_silence=0.08','areverse');
  if(lightVoice)filters.push('highpass=f=85','equalizer=f=320:t=q:w=0.9:g=-2.2');
  if(bassDb)filters.push('bass=g='+bassDb);if(trebleDb)filters.push('treble=g='+trebleDb);
  if(normalize)filters.push('dynaudnorm=f=150:g=7:p=0.9');if(volume!==1)filters.push('volume='+volume);
  if(volume!==1||bassDb||trebleDb||normalize||lightVoice)filters.push('alimiter=limit=0.95:level=0:latency=1');
  // 绿色版自带的 ffmpeg 不在原版写死的 state/voice/tools 目录里，这里自动发现；
  // 纯格式转换（外接 TTS 的常见情况）不依赖外部程序，解析不了的特殊 WAV 再交给 ffmpeg。
  const executable=resolveFfmpeg(root);
  if(!filters.length){
    try{return await wavToPcm24k(wav,{maxSeconds,signal});}
    catch(error){
      if(signal?.aborted)throw voiceError('VOICE_CANCELLED');
      if(!['WAV_INVALID','WAV_UNSUPPORTED'].includes(error.code))throw voiceError(error.code??'VOICE_RESAMPLING_FAILED');
      if(!executable)throw voiceError('VOICE_RESAMPLER_NOT_READY');
    }
  }else if(!executable)throw voiceError('VOICE_RESAMPLER_NOT_READY');
  const filter=filters.length?['-af',filters.join(',')]:[];
  return new Promise((resolve,reject)=>{const child=spawn(executable,['-hide_banner','-loglevel','error','-nostdin','-i','pipe:0',...filter,'-ac','1','-ar','24000','-f','s16le','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});const chunks=[];let size=0,failed=false;child.stderr.resume();child.stdout.on('data',bytes=>{size+=bytes.length;if(size>24000*2*maxSeconds){failed=true;child.kill();reject(voiceError('VOICE_EXCEEDS_60_SECONDS'));}else chunks.push(bytes);});child.on('error',()=>reject(voiceError('VOICE_RESAMPLING_FAILED')));child.on('close',code=>{if(!failed){if(code!==0||size<960)reject(voiceError('VOICE_RESAMPLING_FAILED'));else resolve(Buffer.concat(chunks));}});child.stdin.on('error',()=>{});child.stdin.end(wav);});
}
export async function convertSongPcm(pcm,convert,{signal,onProgress=()=>{}}={}){
  if(!Buffer.isBuffer(pcm)||pcm.length<960||pcm.length%2||pcm.length>600*48000)throw voiceError('SONG_DURATION_INVALID');
  const core=30*48000,context=12000,parts=[];
  for(let offset=0;offset<pcm.length;offset+=core){signal?.throwIfAborted();const end=Math.min(offset+core,pcm.length),start=Math.max(0,offset-context),stop=Math.min(pcm.length,end+context);onProgress('conversion',{part:parts.length+1,parts:Math.ceil(pcm.length/core)});const input=pcm.subarray(start,stop),converted=await convert(input,parts.length);signal?.throwIfAborted();if(!Buffer.isBuffer(converted)||converted.length%2||Math.abs(converted.length-input.length)>48000)throw voiceError('SONG_CONVERSION_ALIGNMENT_FAILED');const normalized=Buffer.alloc(input.length);converted.copy(normalized,0,0,Math.min(converted.length,normalized.length));parts.push(normalized.subarray(offset-start,end-start));}
  return Buffer.concat(parts);
}
export async function synthesizeSinging(root,request,{signal,fetcher=fetch,remoteJobId,onRemoteJob=()=>{},sourceWav,onProgress=()=>{},onPreparedSong=()=>{},mixSettings={},prepare=prepareSong}={}){
  let song;
  if(request.kind==='song'){song=await prepare(root,request,{signal,fetcher,onProgress});onPreparedSong(song);sourceWav=fs.readFileSync(path.join(song.folder,'vocals.wav'));}
  onProgress('conversion');
  const tokenFile=path.join(root,'state/voice/feiyu-service/server/.runtime/voice-service/api_key.txt');
  if(!fs.existsSync(tokenFile)||fs.lstatSync(tokenFile).isSymbolicLink())throw voiceError('SINGING_ENGINE_NOT_READY');
  const token=fs.readFileSync(tokenFile,'utf8').trim();if(token.length<16||token.length>256)throw voiceError('SINGING_ENGINE_NOT_READY');
  const base='http://127.0.0.1:19882',headers={Authorization:'Bearer '+token};
  async function json(route,options={}){const response=await fetcher(base+route,{...options,headers:{...headers,...options.headers},signal,redirect:'error'});if(!response.ok)throw voiceError('SINGING_API_HTTP_'+response.status);return response.json();}
  // 唱歌音色：默认肥鱼；兔娘需要单独的 RVC 模型包，缺失时明确失败，不用其它音色顶替。
  const rvcVoice=mixSettings.singingVoice==='rabbit'?'rabbit':'feiyu';
  if(rvcVoice!=='feiyu'){
    let available=false;
    try{const caps=await json('/v1/capabilities');available=(caps.rvc??[]).some(item=>item.voice===rvcVoice&&item.available===true);}catch{available=false;}
    if(!available)throw voiceError('SINGING_VOICE_UNAVAILABLE');
  }
  async function upload(data,name,type){const form=new FormData();form.set('file',new Blob([data],{type}),name);const result=await json('/v1/assets',{method:'POST',body:form});if(!/^[a-f0-9]{32}$/.test(result.id??''))throw voiceError('SINGING_UPLOAD_INVALID');return result.id;}
  async function jobAudio(id){
    for(;;){if(signal?.aborted)throw voiceError('VOICE_CANCELLED');const job=await json('/v1/jobs/'+id);if(job.status==='success')break;if(['failed','cancelled','interrupted'].includes(job.status))throw voiceError('SINGING_GENERATION_FAILED');await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(voiceError('VOICE_CANCELLED'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},1000);signal?.addEventListener('abort',abort,{once:true});});}
    const response=await fetcher(base+'/v1/jobs/'+id+'/audio',{headers,signal,redirect:'error'});if(!response.ok)throw voiceError('SINGING_AUDIO_UNAVAILABLE');const chunks=[];let size=0;for await(const bytes of response.body){size+=bytes.length;if(size>140*1024*1024)throw voiceError('SINGING_AUDIO_TOO_LARGE');chunks.push(Buffer.from(bytes));}return Buffer.concat(chunks);
  }
  if(song){
    const source=await wavToPcm(root,sourceWav,{signal,maxSeconds:song.maxSeconds}),folder=directory(root,path.relative(root,song.folder)+'/converted-parts'),recipe=songRenderSignature(root,request,mixSettings),digest=value=>crypto.createHash('sha256').update(value).digest('hex');
    const pcm=await convertSongPcm(source,async input=>{
      const key=digest('bounded-rvc-v1:'+recipe+':'+digest(input)),meta=path.join(folder,key+'.json'),audio=path.join(folder,key+'.pcm');let saved;
      for(const file of [meta,audio])if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw voiceError('SONG_CONVERSION_CACHE_INVALID');
      if(fs.existsSync(meta)&&fs.statSync(meta).size<4096)try{saved=JSON.parse(fs.readFileSync(meta,'utf8'));}catch{}
      if(saved?.key===key&&saved.sha256&&fs.existsSync(audio)&&fs.statSync(audio).size<=input.length+48000){const bytes=fs.readFileSync(audio);if(digest(bytes)===saved.sha256)return bytes;}
      let id=saved?.key===key&&/^[a-f0-9]{32}$/.test(saved.jobId??'')?saved.jobId:null;
      if(!id){const audioId=await upload(pcmToWav(input),'vocal-part.wav','audio/wav'),job=await json('/v1/voice-conversion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:rvcVoice,audio_id:audioId})});if(!/^[a-f0-9]{32}$/.test(job.id??''))throw voiceError('SINGING_JOB_INVALID');id=job.id;atomicJson(meta,{key,jobId:id});}
      let converted;try{converted=await wavToPcm(root,await jobAudio(id),{signal,maxSeconds:32});}catch(error){if(['SINGING_GENERATION_FAILED','SINGING_API_HTTP_404'].includes(error.code))atomicJson(meta,{key});throw error;}
      signal?.throwIfAborted();if(converted.length%2||Math.abs(converted.length-input.length)>48000){atomicJson(meta,{key});throw voiceError('SONG_CONVERSION_ALIGNMENT_FAILED');}fs.writeFileSync(audio,converted,{mode:0o600});atomicJson(meta,{key,sha256:digest(converted)});return converted;
    },{signal,onProgress});
    onProgress('mix');return mixSong(root,pcm,song,{signal,clarity:mixSettings.singingClarity!==false,backingVolume:mixSettings.backingVolume??0.4});
  }
  let id=remoteJobId;
  if(!id){const capabilities=await json('/v1/capabilities');if(request.kind==='score'&&capabilities.singing?.available!==true)throw voiceError('SINGING_SCORE_ENGINE_NOT_READY');
    let job;if(request.kind==='cover'||sourceWav){
      let audio=sourceWav;if(!audio){const songs=directory(root,'state/voice/songs'),file=path.join(songs,request.songId+'.wav');if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>140*1024*1024)throw voiceError('SINGING_SONG_NOT_PREPARED');audio=fs.readFileSync(file);}
      const audioId=await upload(audio,'vocal.wav','audio/wav');job=await json('/v1/voice-conversion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:rvcVoice,audio_id:audioId})});
    }else{const scoreId=await upload(request.score,'score.abc','text/vnd.abc');job=await json('/v1/singing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:rvcVoice,score_id:scoreId,lyrics:request.lyrics,segment_seconds:20})});}
    id=job.id;if(!/^[a-f0-9]{32}$/.test(id??''))throw voiceError('SINGING_JOB_INVALID');onRemoteJob(id);
  }
  if(!/^[a-f0-9]{32}$/.test(id??''))throw voiceError('SINGING_JOB_INVALID');
  const pcm=await wavToPcm(root,await jobAudio(id),{signal,maxSeconds:60});
  // Internal speech conversion is polished once by synthesis, including resumed jobs.
  if((request.kind==='score'||request.kind==='cover'&&!sourceWav)&&mixSettings.singingClarity!==false)return wavToPcm(root,pcmToWav(pcm),{signal,lightVoice:true});
  return pcm;
}
