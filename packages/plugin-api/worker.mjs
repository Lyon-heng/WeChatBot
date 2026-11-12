import {pathToFileURL} from 'node:url';
import {hostContract} from './contract.mjs';

const tools=new Map(),actions=new Map(),services=new Map(),calls=new Map();let module,scheduled,ready=false,serial=0;
const send=value=>{if(process.connected&&Buffer.byteLength(JSON.stringify(value))<=2*1024*1024)process.send(value);};
const service=(call,method,args)=>new Promise((resolve,reject)=>{const id=String(++serial);services.set(id,{resolve,reject});send({type:'service',id,call,method,args});});
function context(call,data,signal){
  const storage=scope=>Object.freeze(Object.fromEntries(['get','set','delete'].map(method=>[method,(...args)=>service(call,'storage.'+method,[scope,...args])])));
  return Object.freeze({...data,apiVersion:2,signal,config:()=>structuredClone(data.settings),
    storage:storage('chat'),actorStorage:storage('actor'),
    audio:Object.freeze({read:(id,options)=>service(call,'audio.read',[id,options??{}])}),
    dshTasks:Object.freeze({control:args=>service(call,'dshTasks.control',[args])}),
    // WorkBuddy 宿主命名：走进程内 WorkBuddy 任务服务；历史 dshTasks 仍保留给旧插件。
    workbuddyTasks:Object.freeze({control:args=>service(call,'workbuddyTasks.control',[args])}),
    people:Object.freeze({current:()=>service(call,'people.current',[]),recall:options=>service(call,'people.recall',[options??{}]),remember:note=>service(call,'people.remember',[note]),forget:options=>service(call,'people.forget',[options])}),
    documents:Object.freeze({get:id=>service(call,'documents.get',[id]),put:(id,value)=>service(call,'documents.put',[id,value]),list:options=>service(call,'documents.list',[options??{}])}),
    persona:()=>service(call,'persona',[]),
    model:Object.freeze({embed:texts=>service(call,'model.embed',[texts]),generate:options=>service(call,'model.generate',[options])}),
    memory:Object.freeze({search:options=>service(call,'memory.search',[options??{}]),index:()=>service(call,'memory.index',[])}),
    history:Object.freeze({recent:options=>service(call,'history.recent',[options??{}]),today:options=>service(call,'history.today',[options??{}]),day:options=>service(call,'history.day',[options??{}])}),
    media:Object.freeze({search:options=>service(call,'media.search',[options]),read:options=>service(call,'media.read',[options])}),
    voice:Object.freeze({enqueue:request=>service(call,'voice.enqueue',[request]),cancel:options=>service(call,'voice.cancel',[options??{}]),status:()=>service(call,'voice.status',[]),songs:()=>service(call,'voice.songs',[])}),
    // 视频文件投递：插件先把 mp4 写到 state/media/video/<pluginId>/ 下，再按相对路径入队
    video:Object.freeze({enqueue:request=>service(call,'video.enqueue',[request]),status:options=>service(call,'video.status',[options??{}])}),
    // WorkBuddy 表情包来源与搜索：search / save / status 全部在宿主进程执行
    memes:Object.freeze({search:options=>service(call,'memes.search',[options??{}]),save:options=>service(call,'memes.save',[options??{}]),status:()=>service(call,'memes.status',[])}),
    reply:text=>service(call,'reply',[text]),
    fetch:async(url,options)=>{const result=await service(call,'fetch',[url,options??{}]);return new Response([204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:result.headers});},
  });
}
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
  if(message?.type==='service-result'){
    const pending=services.get(message.id);if(!pending)return;services.delete(message.id);
    if(message.error)pending.reject(Error(message.error));else pending.resolve(message.value);return;
  }
  if(message?.type==='dispose'){
    try{await module?.deactivate?.();await module?.dispose?.();}finally{process.exit(0);}return;
  }
  if(message?.type!=='call'||!ready||typeof message.id!=='string')return;
  const controller=new AbortController();calls.set(message.id,controller);
  try{
    const ctx=context(message.id,message.context,controller.signal);
    const action=message.kind==='tool'?tools.get(message.name)?.execute:message.kind==='action'?actions.get(message.name)?.execute:message.kind==='schedule'?scheduled:module.hooks?.[message.name];
    if(typeof action!=='function')throw Error('PLUGIN_ACTION_UNAVAILABLE');
    const value=['tool','action'].includes(message.kind)?await action(ctx,message.args):await action(Object.freeze({...ctx,...message.args}));
    if(Buffer.byteLength(JSON.stringify(value??null))>64*1024)throw Error('PLUGIN_OUTPUT_TOO_LARGE');
    send({type:'result',id:message.id,value:value??null});
  }catch(error){send({type:'result',id:message.id,error:String(error.message??'PLUGIN_EXECUTION_FAILED').slice(0,500)});}
  finally{controller.abort();calls.delete(message.id);}
});
try{
  module=await import(pathToFileURL(process.argv[2]).href);
  const api=Object.freeze({apiVersion:2,registerTool(def){
    if(!def||!/^[a-z][a-z0-9-]{0,19}$/.test(def.id??'')||tools.has(def.id)||tools.size>=16||typeof def.execute!=='function'||typeof def.description!=='string'||!def.description.trim()||def.description.length>2000)throw Error('PLUGIN_TOOL_DEFINITION_INVALID');
    tools.set(def.id,def);return process.argv[3]+'__'+def.id;
  },registerAction(def){
    if(!def||!/^[a-z][a-z0-9-]{0,19}$/.test(def.id??'')||actions.has(def.id)||actions.size>=16||typeof def.execute!=='function'||typeof def.description!=='string'||!def.description.trim()||def.description.length>2000)throw Error('PLUGIN_ACTION_DEFINITION_INVALID');
    actions.set(def.id,def);return def.id;
  },onSchedule(fn){if(typeof fn!=='function'||scheduled)throw Error('PLUGIN_SCHEDULE_INVALID');scheduled=fn;}});
  if(typeof module.setup!=='function')throw Error('PLUGIN_SETUP_REQUIRED');
  await module.setup(api);await module.activate?.();
  const hooks=Object.keys(module.hooks??{});if(hooks.some(name=>!['before-context','after-response'].includes(name)||typeof module.hooks[name]!=='function'))throw Error('PLUGIN_HOOK_INVALID');
  if(!tools.size&&!hooks.length&&!actions.size&&!scheduled)throw Error('PLUGIN_HAS_NO_ACTIONS');
  ready=true;send({type:'ready',contract:hostContract(),tools:[...tools.values()].map(({id,description,parameters})=>({id,description,parameters})),actions:[...actions.values()].map(({id,description,parameters})=>({id,description,parameters})),scheduled:!!scheduled,hooks});
}catch(error){send({type:'fatal',error:String(error.message??'PLUGIN_LOAD_FAILED').slice(0,500)});setTimeout(()=>process.exit(1),20);}
