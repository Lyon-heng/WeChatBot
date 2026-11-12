import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {configuration,scanPlugins,validateValue,atomicJson} from '../packages/plugin-api/catalog.mjs';
import {readVoiceAttempt} from '../packages/plugin-api/voice-status.mjs';
import {discoverModels,inspectConfiguration,probeTranscription,errorMessage} from '../optional-extensions/speech-recognition/lib/diagnostics.mjs';
import {enginePaths,readJson as readEngineJson} from '../optional-extensions/speech-recognition/lib/local-provision.mjs';

const bundled=JSON.parse(fs.readFileSync(new URL('../packages/plugin-distribution/catalog.json',import.meta.url),'utf8')).schemas['speech-recognition'];
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
const fault=(message,status=400)=>Object.assign(new Error(message),{status});

export function voiceDecoderCapabilities(root,{spawnImpl=spawn}={}){
  return new Promise(resolve=>{
    let python;
    try{python=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'')).runtime.python;}catch{return resolve({checked:false,decoder:false,reason:'未配置运行环境。'});}
    let child,output='',settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child?.kill();finish({checked:false,decoder:false,reason:'运行环境检测超时。'});},4000);
    try{
      child=spawnImpl(python,['-B',path.join(root,'scripts/decode-wechat-voice.py'),'--probe'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
      child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>4096){child.kill();finish({checked:false,decoder:false});}});
      child.once('error',()=>finish({checked:false,decoder:false,reason:'无法启动已配置的运行环境。'}));
      child.once('exit',code=>{try{const value=JSON.parse(output.trim());finish({checked:code===0,decoder:code===0&&value.decoder===true});}catch{finish({checked:false,decoder:false,reason:'运行环境检测未完成。'});}});
    }catch{finish({checked:false,decoder:false,reason:'无法启动已配置的运行环境。'});}
  });
}

export function createSpeechPluginConsole({root,fetchImpl=fetch,readCapabilities=()=>voiceDecoderCapabilities(root),now=Date.now}){
  const file=path.join(root,'state/plugin-service-checks/speech-recognition.json'),modelsCache=new Map(),checksCache=new Map(),controllers=new Set();
  let closed=false,capabilityCache,capabilityAt=0;
  function context(body={},checkRevision=true){
    const saved=configuration(root),item=scanPlugins(root).find(item=>item.id==='speech-recognition'&&!item.invalid);
    if(!item)throw fault('请先安装语音识别插件，再配置接口。',404);
    if(checkRevision&&body.revision!==saved.revision)throw fault('插件设置已变化，请重新打开配置后重试。',409);
    const draft=body.settings??{},record=saved.config.plugins[item.id]??{};
    validateValue(draft,{type:'object',properties:item.configSchema,additionalProperties:false},'插件检测设置');
    const settings={...bundled.settings,...item.settings,...record.settings,...draft,_root:root};
    for(const [key,schema]of Object.entries(item.configSchema))if(schema.secret&&draft[key]===''&&record.settings?.[key])settings[key]=record.settings[key];
    return {settings,item,saved,generation:record.generation,key:digest({revision:item.revision,...settings}),savedKey:digest({revision:item.revision,...bundled.settings,...item.settings,...record.settings})};
  }
  function redact(value,settings){
    let text=JSON.stringify(value);
    const secrets=[settings.apiKey,settings.apiKey?.trim()];try{secrets.push(...Object.values(JSON.parse(settings.headersJson)).filter(value=>typeof value==='string'&&value.length>=6));}catch{}
    for(const secret of secrets)if(typeof secret==='string'&&secret.length>=6)text=text.split(JSON.stringify(secret).slice(1,-1)).join('[已隐藏]');
    return JSON.parse(text);
  }
  function persist(ctx,report){
    checksCache.set(ctx.key,report);while(checksCache.size>32)checksCache.delete(checksCache.keys().next().value);
    if(ctx.key===ctx.savedKey){atomicJson(file,{version:1,key:ctx.key,report});}
  }
  function previousReport(ctx){
    const cached=checksCache.get(ctx.key);if(cached)return cached;
    try{if(fs.statSync(file).size>512*1024)return;const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.version===1&&value.key===ctx.key)return value.report;}catch{}
  }
  function summary(report){
    if(report.configuration?.local)return localSummary(report);
    if(!report.configuration?.configurationValid)return {state:'error',ready:false,label:'配置有误',message:report.configuration?.checks.find(item=>item.state==='error')?.message??'请检查接口配置。'};
    if(!report.configuration.decoderReady&&!report.capabilities.checked)return {state:'pending',ready:false,label:'运行环境待确认',message:report.capabilities.reason??'尚未确认 WAV 转换组件，请稍后重试。'};
    if(!report.configuration.decoderReady)return {state:'error',ready:false,label:'转换组件未就绪',message:'当前微信语音还不能转换成所选上传格式。'};
    if(report.lastAttempt&&report.lastAttempt.at>(report.probe?.testedAt??0))return attemptSummary(report.lastAttempt);
    if(report.probe?.verified===true&&report.audioFormat==='wav')return {state:'ok',ready:true,label:'配置已验证',message:'内置短句转写成功，WAV 转换组件已就绪。'};
    if(report.probe?.verified===true)return {state:'warning',ready:false,label:'API 测试成功',message:'WAV 测试短句已识别；实际 SILK 输入仍待验证。'};
    if(report.probe?.inconclusive)return {state:'warning',ready:false,label:'SILK 输入待验证',message:report.probe.message};
    if(report.probe&&!report.probe.ok)return {state:'error',ready:false,label:'识别测试失败',message:report.probe.message};
    if(report.probe)return {state:'warning',ready:false,label:'转写结果待确认',message:report.probe.message};
    return {state:'pending',ready:false,label:'待测试识别',message:report.models?.ok?'读取模型不代表转写成功，请运行配置检测。':report.models?.message??'请运行配置检测。'};
  }
  function attemptSummary(attempt){return attempt.ok?{state:'ok',ready:true,label:'最近语音转写成功',message:'微信语音已收到并完成转写。'}:{state:'error',ready:false,label:'语音已收到，转写失败',message:errorMessage(attempt.code)+'（'+attempt.code+'）'};}
  function localSummary(report){
    if(report.lastAttempt&&report.lastAttempt.at>(report.probe?.testedAt??0))return attemptSummary(report.lastAttempt);
    if(report.probe?.verified===true)return {state:'ok',ready:true,label:'本地引擎已验证',message:'内置测试短句转写成功，音频全程未离开本机。'};
    if(report.probe&&!report.probe.ok)return {state:'warning',ready:false,label:'本地引擎待就绪',message:report.probe.message};
    const engineCheck=report.configuration?.checks?.find(item=>item.id==='local-engine');
    if(engineCheck?.state==='running'||engineCheck?.state==='ok')return {state:'pending',ready:false,label:'待测试识别',message:'本地引擎已运行，请点击“检测配置”验证转写效果。'};
    return {state:'pending',ready:false,label:'本地引擎待就绪',message:engineCheck?.message??'请先下载并启动本地引擎，再检测配置。'};
  }
  async function capabilities(){
    if(capabilityCache&&now()-capabilityAt<30000)return capabilityCache;
    capabilityCache=await readCapabilities();capabilityAt=now();return capabilityCache;
  }
  async function modelList(settings,signal,refresh=false){
    const key=digest({apiProtocol:settings.apiProtocol,requestMode:settings.requestMode,endpoint:settings.endpoint,modelsEndpoint:settings.modelsEndpoint,modelsResponsePath:settings.modelsResponsePath,apiKey:settings.apiKey,headersJson:settings.headersJson,authHeader:settings.authHeader,authPrefix:settings.authPrefix});
    const cached=modelsCache.get(key);if(!refresh&&cached&&cached.until>now())return cached.result;
    const result=await discoverModels(settings,{signal,fetchImpl});modelsCache.set(key,{result,until:now()+(result.ok?300000:10000)});while(modelsCache.size>32)modelsCache.delete(modelsCache.keys().next().value);return result;
  }
  async function run(kind,body,{signal}={}){
    if(closed)throw fault('配置检测已关闭。',503);
    if(controllers.size>=2)throw fault('已有接口检测正在进行，请稍后再试。',429);
    const ctx=context(body),controller=new AbortController();controllers.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(35000),...(signal?[signal]:[])]);
    try{
      const initial=inspectConfiguration(ctx.settings),[models,local,probe]=await Promise.all([
        modelList(ctx.settings,combined,body.refreshModels===true),capabilities(),
        kind==='check'&&body.testAudio===true&&initial.configurationValid?probeTranscription(ctx.settings,{signal:combined,fetchImpl}):undefined,
      ]);
      const configuration=inspectConfiguration(ctx.settings,local,models.models),report={checkedAt:now(),audioFormat:ctx.settings.audioFormat,models,capabilities:local,configuration};
      if(probe)report.probe={...probe,testedAt:now()};
      else if(kind==='models'&&(models.ok||models.code==='VOICE_MODELS_UNSUPPORTED')&&previousReport(ctx)?.probe)report.probe=previousReport(ctx).probe;
      if(ctx.key===ctx.savedKey)report.lastAttempt=readVoiceAttempt(root,ctx.generation);
      report.summary=summary(report);const sanitized=redact(report,ctx.settings);
      combined.throwIfAborted();
      // A different window must not replace the status of newly saved credentials.
      if(configurationRevisionChanged(ctx.saved.revision))return {...sanitized,stale:true,summary:{state:'pending',ready:false,label:'设置已变化',message:'请重新检测当前设置。'}};
      persist(ctx,sanitized);return sanitized;
    }finally{controller.abort();controllers.delete(controller);}
  }
  function configurationRevisionChanged(revision){try{return configuration(root).revision!==revision;}catch{return true;}}
  function status(){
    try{
      const ctx=context({},false),record=previousReport(ctx);
      const lastAttempt=readVoiceAttempt(root,ctx.generation);
      if(record)return {...summary({...record,lastAttempt}),checkedAt:record.checkedAt,lastAttempt};
      if(lastAttempt)return {...attemptSummary(lastAttempt),checkedAt:lastAttempt.at,lastAttempt};
      return {state:'pending',ready:false,label:'配置待检测',message:'请读取模型并检测语音识别接口。'};
    }catch{return {state:'pending',ready:false,label:'尚未配置',message:'安装后可读取模型并检测接口。'};}
  }
  function onSaved(){try{const ctx=context({},false),report=checksCache.get(ctx.key);if(report)atomicJson(file,{version:1,key:ctx.key,report});}catch{}}
  const LOCAL_REQUESTS=new Set(['start','stop','download','restart']);
  const ENGINE_MESSAGES={start:'启动指令已下发，插件进程会在数秒内拉起本地引擎。',stop:'停止指令已下发。',download:'下载指令已下发，进度可在面板中查看（首次约 250MB）。',restart:'重启指令已下发。'};
  function pluginState(){
    try{
      const saved=configuration(root),item=scanPlugins(root).find(item=>item.id==='speech-recognition'&&!item.invalid);
      const record=saved.config.plugins['speech-recognition']??{};
      return {installed:!!item,enabled:record.enabled===true,settings:{...item?.settings,...record.settings},reason:item?'':'请先安装语音识别插件。'};
    }catch{return {installed:false,enabled:false,settings:{},reason:'插件配置不可读。'};}
  }
  async function engineStatus(){
    const paths=enginePaths(root),state=pluginState();
    const engine=readEngineJson(paths.engineFile);
    const info=engine&&typeof engine==='object'?engine:null;
    // 状态文件可能滞后：插件进程崩溃后 sidecar 由看护退出，但文件还写着 running。探测一次真实状态。
    let responsive=null;
    if(info?.state==='running'&&info?.port&&info?.token){
      try{
        const probe=await fetch(`http://127.0.0.1:${info.port}/status`,{headers:{'x-engine-token':info.token},signal:AbortSignal.timeout(1500)});
        await probe.body?.cancel().catch(()=>{});
        responsive=probe.ok;
      }catch{responsive=false;}
    }
    if(info&&responsive===false){info={...info,state:'orphaned'};}
    return {
      version:1,
      installed:state.installed,enabled:state.enabled,reason:state.installed?(state.enabled?'':'插件未启用，启动指令不会被处理。'):state.reason,
      engine:info,
      engineMode:state.settings.engine==='local'?'local':'api',
      localAutostart:state.settings.localAutostart!==false,
      message:info?.state==='running'?'本地引擎正在运行（127.0.0.1:'+info.port+'），转写不出网。':info?.state==='starting'?'本地引擎正在启动…':info?.state==='downloading'?'正在下载本地引擎组件…':info?.state==='missing'?'本地引擎组件尚未下载。':info?.state==='orphaned'?'本地引擎无响应（可能已随插件进程退出），请重新启动。':info?.state==='error'?'本地引擎上次启动失败：'+(info.error??''):'本地引擎未运行。',
    };
  }
  function engineCommand(body){
    const request=String(body?.request??'');
    if(!LOCAL_REQUESTS.has(request))throw fault('无效的本地引擎指令。');
    const state=pluginState();
    if(!state.installed)throw fault('请先安装语音识别插件。',404);
    const paths=enginePaths(root);
    if(!fs.existsSync(paths.state))fs.mkdirSync(paths.state,{recursive:true});
    const nonce=crypto.randomUUID();
    atomicJson(paths.controlFile,{version:1,request,nonce,at:Date.now()});
    return {accepted:true,nonce,request,message:ENGINE_MESSAGES[request]};
  }
  async function validateForSave(body){
    if(body.enabled!==true)return;
    const ctx=context(body),result=inspectConfiguration(ctx.settings,await capabilities());
    const error=result.checks.find(item=>item.state==='error');if(error)throw fault(error.message,400);
  }
  return {run,status,onSaved,engineStatus,engineCommand,validateForSave,close(){closed=true;for(const controller of controllers)controller.abort();}};
}
