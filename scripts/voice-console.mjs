import {MusicLibrary} from '../packages/voice-studio/library.mjs';
import {MusicPreferences} from '../packages/voice-studio/music-preferences.mjs';
import {resolveSpeechEngine,previewCosyVoice,cosyEngineSettings} from '../packages/voice-studio/cosyvoice.mjs';
import {SpeechApi} from '../packages/voice-studio/speech-api.mjs';
import {CustomVoices} from '../packages/voice-studio/voices.mjs';
import {synthesizeVoice} from '../packages/voice-studio/synthesis.mjs';
import {importAudioFromUrl,importAudioFromBytes,importAudioFromBilibili,autoImportSong,listFullSongs} from '../packages/voice-studio/web-source.mjs';
import {searchBilibili} from '../packages/voice-studio/song-search.mjs';
import {createNeteaseClient} from '../packages/netease/client.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {sendingMode} from '../packages/wechat-send-policy.mjs';
import {VoiceJobs,voiceRequest} from '../packages/voice-studio/jobs.mjs';import {configuration,directory,atomicJson,updatePlugin} from '../packages/plugin-api/catalog.mjs';import {wavToPcm} from '../packages/voice-studio/singing.mjs';
const fault=message=>Object.assign(Error(message),{status:400});
// 点歌 = 下载 → ffmpeg 裁段 → 人声分离 → AI 换声 → 混音 → SILK 编码。
// 便携版只附带了基础 Python 环境与 ffmpeg，下面三项属于需单独部署的本地 AI 组件。
const singingBlockers=root=>{
  const voice=path.join(root,'state/voice'),missing=[];
  if(!fs.existsSync(path.join(voice,'engines/music/venv/Scripts/python.exe')))missing.push('人声分离环境（engines/music/venv）');
  if(!fs.existsSync(path.join(voice,'engines/music/models/UVR-MDX-NET-Inst_HQ_3.onnx')))missing.push('UVR 人声分离模型');
  if(!fs.existsSync(path.join(voice,'feiyu-service/server/.runtime/voice-service/api_key.txt')))missing.push('AI 换声服务（127.0.0.1:19882）');
  return missing;
};
const webImportMessage=error=>{
  const messages={
    WEB_SOURCE_URL_INVALID:'链接格式不正确，请粘贴以 http:// 或 https:// 开头的地址。',
    WEB_SOURCE_URL_BLOCKED:'不能使用本机或内网地址。',
    WEB_SOURCE_AUDIO_NOT_FOUND:'这个页面里没有找到可下载的音频，请换成音频直链（.mp3/.m4a/.wav）。',
    WEB_SOURCE_TOO_LARGE:'音频超过 140 MB，请选择更小的文件。',
    WEB_SOURCE_AUDIO_INVALID:'这个文件不是有效的音频，或时长过短。',
    WEB_SOURCE_UNAVAILABLE:'链接无法访问，可能已失效或需要登录。',
    WEB_SOURCE_REDIRECT_LIMIT:'链接跳转次数过多，请换一个直链。',
    VOICE_RESAMPLER_NOT_READY:'音频转换组件未就绪，请重启应用后重试。',
    SONG_SEARCH_INVALID:'请填写 100 字以内的歌名或歌手。',
    SONG_SEARCH_NOT_FOUND:'没有搜到可用音轨，补充歌手或换个写法再试。',
    BILI_SEARCH_UNAVAILABLE:'联网搜歌暂时不可用，可能是网络波动或视频站限流，稍后重试即可。',
    BILI_SEARCH_TIMEOUT:'联网搜歌超时，请检查网络后重试。',
    BILI_SEARCH_HTTP_412:'视频站触发了访问限制，请等 1 分钟再试。',
    BILI_VIDEO_UNAVAILABLE:'这个视频无法读取，换一个候选版本再试。',
    BILI_AUDIO_UNAVAILABLE:'这个视频没有可用音轨，换一个候选版本再试。',
    BILI_AUDIO_INVALID:'下载到的音轨不完整，换一个候选版本再试。',
    BILI_SOURCE_BLOCKED:'音源地址不在允许范围内，已拒绝下载。',
  };
  return messages[error?.code]??messages[error?.message]??('导入失败：'+(error?.message??'未知错误'));
};
const wav=pcm=>{const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);};
export function createVoiceConsole(root,{fetcher=fetch,resample=wavToPcm}={}){
 let previewBusy=false;
 const jobs=()=>new VoiceJobs(root);
 async function endpoint(url,headers={}){try{const response=await fetcher(url,{headers,signal:AbortSignal.timeout(2000),redirect:'error'});return response.ok?await response.json():null;}catch{return null;}}
 async function preview(text,profile,styleOverride){if(previewBusy)throw Object.assign(fault('正在制作另一条试听，请稍后再试。'),{status:409});if(typeof text!=='string'||!text.trim()||text.length>100)throw fault('请填写100字以内的试听文字。');const settings=configuration(root).config.plugins['voice-studio']?.settings??{},engine=resolveSpeechEngine(root,{style:styleOverride??profile?.baseStyle??settings.defaultStyle??'cute',profile});let pcm;previewBusy=true;try{await synthesizeVoice(root,voiceRequest({kind:'speech',style:styleOverride??profile?.baseStyle??settings.defaultStyle??'cute',text}),{...settings,...(profile?{customVoiceProfile:profile}:styleOverride&&engine.mode==='local'?{feiyuTimbre:false}:{}),speechEngine:{mode:engine.mode,revision:engine.revision}},{signal:AbortSignal.timeout(120000),onPcm:value=>{pcm=value;}});return {b64:wav(pcm).toString('base64')};}catch(error){const messages={SINGING_GENERATION_FAILED:'换声服务未能生成试听，请检查本机换声服务。',TimeoutError:'试听超时。自定义音色的额外换声与唱歌共用队列，请等当前任务结束再试。',VOICE_REFERENCE_NOT_READY:'缺少本机参考音频，请检查语音组件与音色。',COSY_ENGINE_SETTINGS_CHANGED:'专用引擎设置已改变，请重新试听。',COSY_ENGINE_NOT_READY:'专用肥鱼服务尚未启动，请检查模型和本机服务。',COSY_SYNTHESIS_UNAVAILABLE:'专用肥鱼合成失败，请检查本机服务。',VOICE_API_SETTINGS_CHANGED:'语音API配置已变化，请重新试听。',VOICE_API_HTTP_401:'API密钥未通过验证，请检查密钥。',VOICE_API_HTTP_403:'该API拒绝请求，请检查模型和账号权限。',VOICE_API_HTTP_429:'该API请求受限，请检查额度或稍后重试。',VOICE_API_WAV_REQUIRED:'该API没有返回WAV音频，请确认接口兼容音频生成协议。',VOICE_API_CREDENTIAL_UNAVAILABLE:'无法解密API密钥，请重新填写保存。'};throw fault(messages[error.code??error.message]??'试听未完成，请检查所选语音服务的连接与音色配置。');}finally{previewBusy=false;}}
 const engineView=()=>{const base=new SpeechApi(root).snapshot(),profile=new CustomVoices(root).selected(),settings=configuration(root).config.plugins['voice-studio']?.settings??{};return {...base,localEngine:resolveSpeechEngine(root,{base,profile,style:profile?.baseStyle??settings.defaultStyle??'cute'}).mode==='cosyvoice'?'cosyvoice':'breeze'};};
 return {
  musicPreferences:()=>new MusicPreferences(root).snapshot(),
  saveMusicPreferences:body=>{const result=new MusicPreferences(root).save(body);const cleanup=body.maxSongs!==undefined?new MusicLibrary(root).enforceLimit():{deleted:0};return {...result,cleanup};},
  deleteSongs:body=>{if(!body||Object.keys(body).some(k=>!['items','confirmed'].includes(k))||body.confirmed!==true)throw fault('请确认删除所选音乐。');return new MusicLibrary(root).remove(body.items);},
  async compareEngines(body){if(previewBusy)throw fault('正在制作另一条试听，请稍后再试。');if(!body||Object.keys(body).some(key=>key!=='text')||typeof body.text!=='string'||!body.text.trim()||body.text.length>100)throw fault('请填写100字以内的对比文字。');previewBusy=true;try{const control=cosyEngineSettings(root);if(!control.enabled||!control.allowComparison)throw Object.assign(Error('COSY_COMPARISON_DISABLED'),{code:'COSY_COMPARISON_DISABLED'});const settings=configuration(root).config.plugins['voice-studio']?.settings??{},signal=AbortSignal.timeout(120000);let pcm;const start=Date.now();await synthesizeVoice(root,voiceRequest({kind:'speech',style:'cute',text:body.text}),{breezePort:settings.breezePort??19881,feiyuTimbre:false,cutePitch:0,speechEngine:{mode:'local'}},{signal,fetcher,onPcm:value=>pcm=value});const breeze={b64:wav(pcm).toString('base64'),elapsedMs:Date.now()-start,seconds:pcm.length/48000};const next=Date.now(),cosy=await previewCosyVoice(root,body.text,'cute',{signal,fetcher});return {text:body.text,localOnly:true,wechatMessagesSent:0,breeze,cosyvoice:{b64:wav(cosy).toString('base64'),elapsedMs:Date.now()-next,seconds:cosy.length/48000}};}catch(error){throw fault(error.code==='COSY_COMPARISON_DISABLED'?'请先安装并启用原生肥鱼引擎插件，允许本机对比试听。':'对比试听未完成，请检查两个本地服务；没有向微信发送消息。');}finally{previewBusy=false;}},
  voices:()=>new CustomVoices(root).snapshot(),
  webSources:()=>listFullSongs(root),
  async singingVoices(){
    const settings=configuration(root).config.plugins['voice-studio']?.settings??{};
    const current=settings.singingVoice==='rabbit'?'rabbit':'feiyu';
    const items=[
      {id:'feiyu',name:'肥鱼',available:false,reason:'本机换声服务未启动'},
      {id:'rabbit',name:'兔娘',available:false,reason:'尚未安装兔娘的 RVC 模型包（models/Rabbit-RVC）'},
    ];
    try{
      const keyFile=path.join(root,'state/voice/feiyu-service/server/.runtime/voice-service/api_key.txt');
      const key=fs.existsSync(keyFile)&&!fs.lstatSync(keyFile).isSymbolicLink()?fs.readFileSync(keyFile,'utf8').trim():'';
      const response=await fetcher('http://127.0.0.1:19882/v1/capabilities',{headers:key?{Authorization:'Bearer '+key}:{},signal:AbortSignal.timeout(4000),redirect:'error'});
      if(response.ok){
        const data=await response.json();
        for(const item of items){
          const found=(data.rvc??[]).find(entry=>entry.voice===item.id);
          if(!found){item.available=false;continue;}
          item.available=found.available===true;
          item.reason=found.available===true?'':String(found.reason??'模型不可用').slice(0,160);
        }
      }
    }catch{ /* 服务未启动时保持默认不可用状态 */ }
    return {current,items,serviceOnline:items.some(item=>item.available)};
  },
  saveSingingVoice(body){
    if(!body||Object.keys(body).some(key=>key!=='voice')||!['feiyu','rabbit'].includes(body.voice))throw fault('请选择唱歌音色。');
    const saved=configuration(root),setting=saved.config.plugins['voice-studio'];
    if(!setting?.enabled)throw fault('请先启用声音插件，再切换唱歌音色。');
    updatePlugin(root,'voice-studio',{revision:saved.revision,enabled:setting.enabled,permissions:setting.permissions,chats:setting.chats,settings:{...setting.settings,singingVoice:body.voice}});
    return {current:body.voice};
  },
  async searchSongs(body){
    if(!body||Object.keys(body).some(key=>key!=='query'))throw fault('请填写歌名或歌手。');
    const query=String(body.query??'').trim();
    if(!query||query.length>100)throw fault('请填写 100 字以内的歌名或歌手。');
    const items=[],notes=[];
    try{
      const bili=await searchBilibili({query,limit:8,fetcher});
      for(const item of bili.items)items.push({...item,provider:'bilibili',label:'公开音源 · 可直接下载'});
    }catch(error){notes.push(webImportMessage(error));}
    try{
      const client=createNeteaseClient(root),songs=await client.search(query,6);
      for(const song of songs){
        if(!/^[1-9]\d{0,15}$/.test(String(song.id??'')))continue;
        items.push({provider:'netease',id:String(song.id),title:String(song.name??'').slice(0,80),artist:(song.ar??song.artists??[]).map(item=>item.name).join(' / ').slice(0,80),durationSeconds:Math.round(Number(song.dt??song.duration??0)/1000),url:'https://music.163.com/song?id='+song.id,label:'网易云 · 版权歌可能无音源'});
      }
    }catch{notes.push('网易云搜索暂时不可用，只显示公开音源候选。');}
    return {query,items:items.slice(0,12),notes};
  },
  async importSongAuto(body){
    if(!body||Object.keys(body).some(key=>!['query','bvid','title'].includes(key)))throw fault('请填写歌名或选择候选。');
    try{
      if(typeof body.bvid==='string'&&body.bvid.trim())return await importAudioFromBilibili(root,{bvid:body.bvid.trim(),title:body.title,fetcher});
      const query=String(body.query??'').trim();
      if(!query)throw fault('请填写歌名或歌手。');
      return await autoImportSong(root,{query,fetcher});
    }catch(error){throw fault(webImportMessage(error));}
  },
  async importWeb(body){
    if(!body||Object.keys(body).some(key=>!['url','title'].includes(key)))throw fault('请填写音频或网页链接。');
    if(typeof body.url!=='string'||!body.url.trim()||body.url.length>2048)throw fault('链接无效，请粘贴 http/https 地址。');
    try{return await importAudioFromUrl(root,{url:body.url.trim(),title:body.title,fetcher});}
    catch(error){throw fault(webImportMessage(error));}
  },
  async importLocal(body){
    if(!body||Object.keys(body).some(key=>!['name','title','b64'].includes(key)))throw fault('请选择音频文件。');
    if(typeof body.b64!=='string'||!body.b64||body.b64.length>110000000)throw fault('音频文件过大，请选择 60 MB 以内的文件。');
    const bytes=Buffer.from(body.b64,'base64');
    try{return await importAudioFromBytes(root,{bytes,name:body.name,title:body.title});}
    catch(error){throw fault(webImportMessage(error));}
  },
  changeVoice:body=>new CustomVoices(root).change(body),
  engine:engineView,
  saveEngine:async body=>{await new SpeechApi(root).save(body);return engineView();},
  async previewVoice(body){if(!body||Object.keys(body).some(key=>!['id','text'].includes(key)))throw fault('试听参数无效。');const profile=new CustomVoices(root).snapshot().voices.find(voice=>voice.id===body.id);if(!profile)throw fault('请先保存并选择音色。');return preview(body.text,profile);},
  async previewEngine(body){if(!body||Object.keys(body).some(key=>!['text','style'].includes(key))||body.style!==undefined&&!['cute','natural','gentle'].includes(body.style))throw fault('试听参数无效。');return preview(body.text,body.style?null:new CustomVoices(root).selected(),body.style);},
  async snapshot(){const settings=configuration(root).config.plugins['voice-studio']?.settings??{},project=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));const keyFile=path.join(root,'state/voice/feiyu-service/server/.runtime/voice-service/api_key.txt');let key='';if(fs.existsSync(keyFile)&&!fs.lstatSync(keyFile).isSymbolicLink())key=fs.readFileSync(keyFile,'utf8').trim();
    let engine;try{const profile=new CustomVoices(root).selected();engine=resolveSpeechEngine(root,{profile,style:profile?.baseStyle??settings.defaultStyle??'cute'});}catch{engine={mode:'unavailable'};}
    const [speech,adapter,singing]=await Promise.all([endpoint('http://127.0.0.1:'+(engine.mode==='cosyvoice'?engine.port:settings.breezePort??19881)+'/health'),endpoint('http://127.0.0.1:'+project.ports.adapter+'/status'),key?endpoint('http://127.0.0.1:19882/v1/capabilities',{Authorization:'Bearer '+key}):null]);let recent=[];try{const store=jobs(),account=store.account();recent=store.list().filter(job=>job.accountScope===account).slice(-8).map(job=>{const value=store.public(job);if(['separate','conversion'].includes(job.progress?.stage)&&Number.isSafeInteger(job.progress?.part)&&Number.isSafeInteger(job.progress?.parts)&&job.progress.part>=1&&job.progress.part<=job.progress.parts&&job.progress.parts<=60)value.stageLabel+=' · '+job.progress.part+'/'+job.progress.parts;return value;});}catch{}
    const separator=path.join(root,'state/voice/engines/music/models/UVR-MDX-NET-Inst_HQ_3.onnx');
    const blocked=sendingMode(project)==='foreground';
    return {sendingMode:sendingMode(project),sendDisabledReason:blocked?'前台模式已停用原生语音与歌曲语音发送；切换到 Hook 模式后恢复。':'',speechSource:engine.mode,speech:engine.mode==='external'?!!engine.baseUrl&&!!engine.model:engine.mode==='cosyvoice'?speech?.ok===true&&speech?.engine==='feiyu-cosyvoice3'&&speech?.sampleRate===24000:engine.mode==='local'&&speech?.status==='ok'&&speech?.sample_rate===24000,nativeVoice:!blocked&&adapter?.native_voice_send===true,feiyuTimbre:engine.mode==='local'&&settings.feiyuTimbre===true,cover:singing?.rvc?.some?.(item=>item?.available===true)||false,score:singing?.singing?.available===true,onlineSongs:settings.onlineSongs!==false,musicReady:fs.existsSync(separator)&&!fs.lstatSync(separator).isSymbolicLink(),songs:jobs().songs(),jobs:recent};
  },
  async importSong(body){
    if(!body||Object.keys(body).some(key=>!['title','b64'].includes(key))||typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>80||typeof body.b64!=='string'||body.b64.length>11300000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.b64))throw fault('请填写歌曲名称并选择有效音频。');
    const bytes=Buffer.from(body.b64,'base64');if(bytes.length>8*1024*1024||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WAVE')throw fault('请导入最长 60 秒的 WAV 人声音频。');
    const pcm=await resample(root,bytes,{signal:AbortSignal.timeout(30000)});if(!Buffer.isBuffer(pcm)||pcm.length<960||pcm.length>24000*2*60||pcm.length%2)throw fault('请使用60秒以内的有效人声音频。');const audio=wav(pcm),id=crypto.createHash('sha256').update(audio).digest('hex').slice(0,24),folder=directory(root,'state/voice/songs');const file=path.join(folder,id+'.wav');if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw fault('歌曲文件异常，请检查本机素材目录。');fs.writeFileSync(file,audio,{mode:0o600});atomicJson(path.join(folder,id+'.json'),{title:body.title.trim(),durationSeconds:pcm.length/48000,source:'owner-imported-vocal'});return {ok:true,id,title:body.title.trim()};
  },
  song(body){
    const localSource=/^[a-z0-9]{24}$/.test(body?.songId??'');
    const neteaseId=typeof body?.id==='string'&&/^\d{1,16}$/.test(body.id);
    if(!body||Object.keys(body).some(key=>!['key','id','songId','playbackMode'].includes(key))||(!localSource&&!neteaseId)||!['preview','full'].includes(body.playbackMode))throw fault('请选择歌曲、聊天和发送模式。');const setting=configuration(root).config.plugins['voice-studio'];if(!setting?.enabled||!setting.permissions?.includes('voice'))throw fault('请先启用声音插件并授予语音权限。');if(setting.chats!==null&&!setting.chats?.includes(body.key))throw fault('请选择声音插件已经授权的聊天。');const blockers=singingBlockers(root);if(blockers.length)throw fault('AI 翻唱组件未就绪，缺少：'+blockers.join('、')+'。点歌会先分离人声再换声，缺任一项都无法完成；外接语音 API 只负责说话，不参与翻唱。可在「音乐」页查看组件状态。');const base={kind:'song',style:setting.settings?.defaultStyle??'cute',playbackMode:body.playbackMode};
    const request=voiceRequest(localSource?{...base,localId:body.songId}:{...base,sourceUrl:'https://music.163.com/song?id='+body.id});
    return jobs().queue({key:body.key,pluginId:'voice-studio',generation:setting.generation,batchId:crypto.randomUUID(),request});},
  test(body){if(!body||Object.keys(body).some(key=>!['key','style','text'].includes(key)))throw fault('测试参数无效。');const setting=configuration(root).config.plugins['voice-studio'];if(!setting?.enabled||!setting.permissions?.includes('voice'))throw fault('请先保存插件设置，并允许声音插件运行。');if(setting.chats!==null&&!setting.chats?.includes(body.key))throw fault('请选择插件已经授权的聊天；修改聊天范围后请先保存。');return jobs().queue({key:body.key,pluginId:'voice-studio',generation:setting.generation,batchId:crypto.randomUUID(),request:voiceRequest({kind:'speech',style:body.style,text:body.text})});}
 };
}
