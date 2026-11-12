import {songPlayback} from './segments.mjs';
import {createNeteaseClient} from '../netease/client.mjs';
import {resolveFfmpeg} from './wav-resample.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {directory,atomicJson,json} from '../plugin-api/catalog.mjs';
import {voiceError} from './jobs.mjs';
import {mediaLink,createPublicMedia} from '../public-media/index.mjs';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const ffmpegTool=root=>{
  const executable=resolveFfmpeg(root);
  if(!executable)throw voiceError('VOICE_RESAMPLER_NOT_READY');
  return executable;
};
export const songName=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[\s·•《》「」“”"'，,。.!！?？-]/g,'');
const artistName=value=>songName(value).replace(/[.．]/g,'').replace(/^gem(?=[\p{Script=Han}])/u,'');
const mediaHost=host=>/^(?:[a-z0-9-]+\.)*music\.126\.net$/.test(host);
export async function musicFetch(url,{fetcher=fetch,signal,maxBytes=1024*1024,media=false}={}){
  signal=AbortSignal.any([AbortSignal.timeout(45000),...(signal?[signal]:[])]);
  for(let redirects=0;redirects<4;redirects++){
    const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password||target.port||!(media?mediaHost(target.hostname):target.hostname==='music.163.com'))throw voiceError('SONG_SOURCE_UNSAFE');
    const response=await fetcher(target.href,{signal,redirect:'manual',headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36','Referer':'https://music.163.com/'}});
    if(response.status>=300&&response.status<400){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw voiceError('SONG_SOURCE_UNAVAILABLE');url=new URL(location,target).href;continue;}
    if(!response.ok){await response.body?.cancel();throw voiceError('SONG_SOURCE_UNAVAILABLE');}
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw voiceError('SONG_SOURCE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  }
  throw voiceError('SONG_SOURCE_REDIRECT_LIMIT');
}
export function chooseSong(songs,title,artist=''){
  const wanted=songName(title),who=artistName(artist);
  const exact=songs.filter(song=>songName(song.name)===wanted&&Array.isArray(song.artists??song.ar)&&(!who||(song.artists??song.ar).some(item=>[item.name,...(item.alias??[]),...(item.transNames??[])].some(name=>artistName(name)===who)))&&Number.isSafeInteger(song.id)&&song.id>0);
  if(!exact.length)throw voiceError('SONG_EXACT_MATCH_NOT_FOUND');
  // Search ranking supplies the default version; an explicit artist is exact.
  return exact[0];
}
export async function songById(value,{fetcher=fetch,signal,neteaseClient}={}){
  const link=mediaLink('netease','https://music.163.com/song?id='+value);
  const data=JSON.parse((await musicFetch('https://music.163.com/api/song/detail?ids='+encodeURIComponent('['+link.id+']'),{fetcher,signal})).toString('utf8'));
  const song=data.code===200?data.songs?.find(s=>String(s.id)===link.id):null;if(!song)throw voiceError('SONG_EXACT_MATCH_NOT_FOUND');return playableSong(song,{fetcher,signal,neteaseClient});
}
async function playableSong(song,{fetcher,signal,neteaseClient}){
  let player=neteaseClient?(await neteaseClient.request('/api/song/enhance/player/url/v1',{ids:JSON.stringify([song.id]),level:'standard',encodeType:'mp3'},{signal})).data:JSON.parse((await musicFetch('https://music.163.com/api/song/enhance/player/url?'+new URLSearchParams({ids:JSON.stringify([song.id]),br:'192000'}),{fetcher,signal})).toString('utf8'));
  if(neteaseClient&&(!Array.isArray(player.data)||!player.data.some(item=>String(item.id)===String(song.id))))player=(await neteaseClient.request('/api/song/enhance/player/url',{ids:JSON.stringify([song.id]),br:192000},{signal})).data;
  const item=Array.isArray(player.data)?player.data.find(item=>String(item.id)===String(song.id)):null;
  if(player.code!==200||item?.code!==200||!item.url||item.freeTrialInfo||item.fee===1&&!neteaseClient?.status().loggedIn){const code=!neteaseClient?'SONG_PUBLIC_AUDIO_UNAVAILABLE':item?.freeTrialInfo?'SONG_TRIAL_ONLY':!neteaseClient.status().loggedIn&&(item?.fee===1||song.fee===1)?'SONG_LOGIN_REQUIRED':'SONG_ACCOUNT_AUDIO_UNAVAILABLE';throw voiceError(code);}
  const media=new URL(item.url);if(media.protocol==='http:')media.protocol='https:';
  if(media.protocol!=='https:'||media.username||media.password||media.port||!mediaHost(media.hostname))throw voiceError('SONG_SOURCE_UNSAFE');
  return {id:String(song.id),title:song.name,artist:(song.artists??song.ar??[]).map(item=>item.name).join(' / '),durationSeconds:Number(song.duration??song.dt??0)/1000,url:media.href};
}
export async function findSong(title,artist='',{fetcher=fetch,signal,neteaseClient}={}){
  const result=await createPublicMedia({fetchImpl:fetcher,neteaseClient})('search',{platform:'netease',query:[title,artist].filter(Boolean).join(' ').slice(0,100),limit:5},{signal});
  const ids=(result.items??[]).map(s=>s.id).filter(value=>/^[1-9]\d{0,15}$/.test(value??''));if(result.status!=='ready'||!ids.length)throw voiceError('SONG_SEARCH_UNAVAILABLE');
  const found=JSON.parse((await musicFetch('https://music.163.com/api/song/detail?ids='+encodeURIComponent('['+ids.join(',')+']'),{fetcher,signal})).toString('utf8'));
  if(found.code!==200)throw voiceError('SONG_SEARCH_UNAVAILABLE');return playableSong(chooseSong(found.songs??[],title,artist),{fetcher,signal,neteaseClient});
}
function verifiedPrepared(folder,sourceId,provider){
  try{const file=path.join(folder,'song.json');if(fs.lstatSync(folder).isSymbolicLink()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>65536)return null;
    const meta=json(file);if(meta.version!==1||provider&&meta.provider!==provider||sourceId&&String(meta.sourceId)!==String(sourceId))return null;
    for(const name of ['vocals.wav','instrumental.wav']){const stem=path.join(folder,name);if(fs.lstatSync(stem).isSymbolicLink()||fs.statSync(stem).size>140*1024*1024||digest(fs.readFileSync(stem))!==meta.hashes?.[name])return null;}
    return {...meta,folder};
  }catch{return null;}
}
export function runMusicTool(executable,args,{cwd,signal,timeoutMs=480000,onProgress=()=>{}}={}){
  return new Promise((resolve,reject)=>{
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
    if(combined.aborted){reject(voiceError('VOICE_CANCELLED'));return;}
    const child=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONNOUSERSITE:'1'}});
    const abort=()=>{
      if(child.exitCode!==null||!child.pid)return;
      if(process.platform==='win32'){const stop=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.on('error',()=>child.kill());}
      else child.kill();
    };
    combined.addEventListener('abort',abort,{once:true});
    let text='',error='',progressText='';const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
    child.stdout.on('data',part=>{text=(text+part).slice(-12000);progressText+=part.toString();const lines=progressText.split('\n');progressText=lines.pop().slice(-200);for(const line of lines){const match=/^MUSIC_PROGRESS:separate:(\d+):(\d+)\s*$/.exec(line);if(match&&Number(match[1])<=Number(match[2])&&Number(match[2])<=60)onProgress('separate',{part:Number(match[1]),parts:Number(match[2])});}});child.stderr.on('data',part=>{error=(error+part).slice(-12000);});
    child.on('error',()=>{clearTimeout(timer);combined.removeEventListener('abort',abort);reject(voiceError(combined.aborted?'VOICE_CANCELLED':'SONG_TOOL_START_FAILED'));});
    child.on('close',code=>{clearTimeout(timer);combined.removeEventListener('abort',abort);if(combined.aborted)reject(voiceError('VOICE_CANCELLED'));else if(code!==0){const typed=/WECHATBOT_MUSIC_ERROR:(SONG_SEPARATOR_MEMORY_PRESSURE|SONG_SEPARATOR_FAILED|SONG_STEM_MISSING|SONG_STEMS_INVALID|SONG_SEPARATOR_INPUT_INVALID)/.exec(error);reject(voiceError(typed?.[1]??'SONG_PREPARATION_FAILED'));}else resolve(text);});
  });
}
/** 这些错误说明网易云没给出可用音源，可以换公开音源重试 */
const RECOVERABLE_SOURCE_ERRORS=new Set(['SONG_EXACT_MATCH_NOT_FOUND','SONG_ACCOUNT_AUDIO_UNAVAILABLE','SONG_TRIAL_ONLY','SONG_LOGIN_REQUIRED','SONG_PUBLIC_AUDIO_UNAVAILABLE','SONG_SEARCH_UNAVAILABLE']);

export async function prepareSong(root,request,{fetcher=fetch,signal,find=findSong,findById=songById,run=runMusicTool,onProgress=()=>{}}={}){
  // 本地/网络导入的整曲音源：跳过网易云，直接用本机 WAV 分离
  let local=null;
  if(request.localId){const {readFullSong}=await import('./web-source.mjs');local=readFullSong(root,request.localId);}
  const link=!local&&request.sourceUrl?mediaLink('netease',request.sourceUrl):null;if(link&&link.kind!=='song')throw voiceError('VOICE_SONG_LINK_INVALID');
  const playback=songPlayback(request.playbackMode);
  let provider=local?'local-source':'netease-public';
  const key=digest(playback.mode+':v3:'+(local?'local:'+local.id:link?'netease-id:'+link.id:songName(request.title)+'\0'+songName(request.artist))),folder=directory(root,'state/voice/music-cache/'+key),metaFile=path.join(folder,'song.json');
  const prepared=verifiedPrepared(folder,local?'local:'+local.id:link?.id,local||link?provider:undefined);if(prepared)return prepared;
  // Reuse only locally retained public stems with exact platform ID and hashes.
  if(link){const base=directory(root,'state/voice/music-cache');for(const name of fs.readdirSync(base).filter(name=>/^[a-f0-9]{64}$/.test(name)).slice(0,128)){const old=verifiedPrepared(path.join(base,name),link.id,'netease-public');if(old&&old.playbackMode===playback.mode)return old;}}
  onProgress('source');
  let track;
  if(local){track={id:'local:'+local.id,title:local.title,artist:'',durationSeconds:local.durationSeconds,file:local.file};}
  else{
    const neteaseClient=createNeteaseClient(root,{fetcher:fetcher===fetch?undefined:fetcher});
    try{track=link?await findById(link.id,{fetcher,signal,neteaseClient}):await find(request.title,request.artist??'',{fetcher,signal,neteaseClient});}
    catch(error){
      // 网易云没版权、只给试听或搜不到时，自动改用公开音源（B 站音轨），用户无需再手动给链接。
      const code=error?.code??error?.message;
      if(link||!RECOVERABLE_SOURCE_ERRORS.has(code))throw error;
      onProgress('search');
      const {autoImportSong,readFullSong}=await import('./web-source.mjs');
      const imported=await autoImportSong(root,{query:[request.title,request.artist].filter(Boolean).join(' ').trim()||request.title,signal,fetcher,run});
      const file=readFullSong(root,imported.id);
      local={id:imported.id,title:imported.title,durationSeconds:imported.durationSeconds,file:file.file};
      track={id:'web:'+imported.id,title:imported.title,artist:'',durationSeconds:imported.durationSeconds,file:file.file};
      provider='web-public';
    }
  }
  if(link&&track.id!==link.id)throw voiceError('SONG_EXACT_MATCH_NOT_FOUND');
  if(playback.mode==='full'&&(!Number.isFinite(track.durationSeconds)||track.durationSeconds<=0||track.durationSeconds>playback.maxSeconds))throw voiceError('SONG_FULL_DURATION_UNSUPPORTED');
  onProgress('download');
  const source=path.join(folder,'source.audio');
  if(local){fs.copyFileSync(local.file,source);}
  else{const audio=await musicFetch(track.url,{fetcher,signal,media:true,maxBytes:140*1024*1024});fs.writeFileSync(source,audio,{mode:0o600});}
  const startSeconds=playback.mode==='full'?0:track.durationSeconds>120?30:0,clip=path.join(folder,'clip.wav');
  await run(ffmpegTool(root),['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(startSeconds),'-i',source,'-t',String(playback.maxSeconds),'-ar','44100','-ac','2',clip],{signal,timeoutMs:60000});
  const python=path.join(root,'state/voice/engines/music/venv/Scripts/python.exe');
  if(!fs.existsSync(python))throw voiceError('SONG_SEPARATOR_NOT_INSTALLED');
  onProgress('separate');await run(python,['-B',path.join(root,'scripts/separate-song.py'),'--input',clip,'--output',folder,'--models',directory(root,'state/voice/engines/music/models')],{signal,onProgress});
  const hashes={};for(const name of ['vocals.wav','instrumental.wav']){const file=path.join(folder,name);if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>140*1024*1024)throw voiceError('SONG_STEMS_INVALID');hashes[name]=digest(fs.readFileSync(file));}
  const meta={version:1,provider,sourceId:track.id,title:track.title,artist:track.artist,startSeconds,maxSeconds:playback.maxSeconds,playbackMode:playback.mode,hashes,preparedAt:Date.now()};atomicJson(metaFile,meta);return {...meta,folder};
}
export function songMixFilter({clarity=true,backingVolume=0.4}={}){
  if(typeof clarity!=='boolean'||!Number.isFinite(backingVolume)||backingVolume<0||backingVolume>1)throw voiceError('SONG_MIX_INVALID');
  return clarity?`[0:a]highpass=f=85,lowpass=f=11000,equalizer=f=250:t=q:w=1:g=-2.5,equalizer=f=500:t=q:w=1:g=-1.5,equalizer=f=3200:t=q:w=1:g=1.2,asplit=2[v][side];[1:a]aformat=sample_rates=24000:channel_layouts=mono,volume=${backingVolume},equalizer=f=3000:t=q:w=0.8:g=-2[b];[b][side]sidechaincompress=threshold=0.035:ratio=2.5:attack=12:release=180:makeup=1[duck];[v][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-19:TP=-1.5:LRA=9,alimiter=limit=0.92:level=0:latency=1`:`[0:a]volume=1.15[v];[1:a]volume=${backingVolume}[b];[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1`;
}
export async function mixSong(root,vocalPcm,prepared,{signal,run=runMusicTool,clarity=true,backingVolume=0.4}={}){
  const output=path.join(prepared.folder,'mixed-'+crypto.randomUUID()+'.pcm'),vocal=path.join(prepared.folder,'converted-'+crypto.randomUUID()+'.pcm');
  fs.writeFileSync(vocal,vocalPcm,{mode:0o600});
  try{
    await run(ffmpegTool(root),['-hide_banner','-loglevel','error','-nostdin','-y','-f','s16le','-ar','24000','-ac','1','-i',vocal,'-i',path.join(prepared.folder,'instrumental.wav'),'-filter_complex',songMixFilter({clarity,backingVolume}),'-t',String(prepared.maxSeconds??60),'-ar','24000','-ac','1','-f','s16le',output],{signal,timeoutMs:60000});
    const pcm=fs.readFileSync(output);if(pcm.length<960||pcm.length>(prepared.maxSeconds??60)*48000||pcm.length%2)throw voiceError('SONG_MIX_INVALID');return pcm;
  }finally{for(const file of [vocal,output]){try{fs.unlinkSync(file);}catch{}}}
}
