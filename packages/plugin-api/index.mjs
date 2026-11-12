import {MusicPreferences} from '../voice-studio/music-preferences.mjs';
import {songPlayback} from '../voice-studio/segments.mjs';
import {ArchiveMemory} from './archive-memory.mjs';
import {filterMemoryOverrides} from '../dsh-social-bridge-plugin/continuity-memory.mjs';
import {localEmbeddings} from './embeddings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {PluginProcess} from './process.mjs';
import {configuration,scanPlugins,allowedChat,validateValue,atomicJson,directory,hash,json,fail} from './catalog.mjs';
import {safeFetch} from '../../components/qq-bridge/src/safe-fetch.js';
import {FileTransfers,safeFileName} from '../dsh-social-bridge-plugin/file-transfers.mjs';
import {PluginDocuments} from './documents.mjs';
import {PeopleMemory} from './people-memory.mjs';
import {adminDshRequest} from './admin-dsh.mjs';
import {assistantSenderAllowed} from '../dsh-social-bridge-plugin/assistant-policy.mjs';
import {boundedTask} from '../dsh-social-bridge-plugin/deadline.mjs';
import {dailyScheduleIdentity,scheduleCompleted} from './daily-schedule.mjs';
import {VoiceJobs,voiceRequest} from '../voice-studio/jobs.mjs';
import {SavedSongs} from '../voice-studio/saved-songs.mjs';
import {createAudioReader} from './audio.mjs';
export {createPluginModelUtility} from './model-utility.mjs';
export const TOOL_POLICY=Symbol.for('wechatagent.extension-tools.v1');

const text=value=>String(value??'').slice(0,12000);
export class PluginRuntime{
  constructor({root,accountScope='unbound',isAllowed=()=>true,historyFor=()=>[],archiveFor=()=>[],rowsForDate=()=>[],personaFor=()=>{throw fail('PLUGIN_PERSONA_UNAVAILABLE');},generateText,readAudio,taskControl,workbuddyTasks,requestMedia,memesHost,voiceJobs,isBusy=()=>false,canSchedule=()=>true,now=Date.now,log=()=>{},fetchText=safeFetch,toolTimeoutMs=8000,maxWorkers=16}){
    this.root=path.resolve(root);this.accountScope=hash(accountScope);this.isAllowed=isAllowed;this.historyFor=historyFor;this.archiveFor=archiveFor;this.log=log;this.fetchText=fetchText;
    this.records=new Map();this.dirty=true;this.revision='';this.closed=false;
    this.readAudio=readAudio??createAudioReader(root);
    this.accountBound=accountScope!=='unbound'&&!!accountScope;this.accountId=/^[a-f0-9]{64}$/.test(accountScope)?accountScope:hash(accountScope);Object.assign(this,{rowsForDate,personaFor,generateText,taskControl,workbuddyTasks,requestMedia,memesHost,voiceJobs:voiceJobs??new VoiceJobs(this.root),isBusy,canSchedule,now});this.utilityCalls=0;this.scheduleRetry=new Map();this.voiceCooldown=new Map();
    this.maxWorkers=Number.isSafeInteger(maxWorkers)?Math.max(1,Math.min(24,maxWorkers)):16;
    this.toolTimeoutMs=Math.max(20,Math.min(8000,toolTimeoutMs));
    const base=directory(root,'plugins');try{this.watcher=fs.watch(base,{recursive:true},()=>{this.dirty=true;});this.watcher.on('error',()=>{this.dirty=true;});this.watcher.unref();}catch{}
  }
  policy(){return configuration(this.root);}
  active(record,key,permission){
    try{
      const saved=this.policy().config.plugins[record.id];
      return !this.closed&&this.isAllowed()&&(!record.requiresAccount||this.accountBound)&&!!saved?.enabled&&saved.generation===record.generation&&!record.invalid&&!record.failure&&!record.process?.closed&&!!record.process&&record.permissions.every(p=>saved.permissions?.includes(p))
        &&(!permission||record.permissions.includes(permission)&&saved.permissions.includes(permission))&&(!key||allowedChat(this.root,key)&&(saved.chats===null||saved.chats?.includes(key)));
    }catch{return false;}
  }
  isActive(id,key){const record=this.records.get(id);return !!record&&this.active(record,key);}
  async sync(){
    if(this.closed)return;
    if(this.syncing)return this.syncing;
    this.syncing=this.reconcile().finally(()=>{this.syncing=null;});return this.syncing;
  }
  async reconcile(){
    const saved=this.policy(),changed=saved.revision!==this.revision;
    if(!this.dirty&&!changed)return;
    const catalog=this.dirty||changed||!this.catalog?scanPlugins(this.root):this.catalog;this.catalog=catalog;this.dirty=false;this.revision=saved.revision;
    for(const [id,record]of this.records){
      const next=catalog.find(item=>item.id===id),setting=saved.config.plugins[id];
      if(!next||next.revision!==record.revision||record.generation!==setting?.generation||!setting?.enabled){await record.process?.dispose();this.records.delete(id);}
    }
    const deadline=Date.now()+6000;let started=[...this.records.values()].filter(item=>item.process&&!item.process.closed).length;
    for(const item of catalog){
      if(this.closed)break;
      const setting=saved.config.plugins[item.id];if(this.records.has(item.id))continue;
      const record={...item,generation:setting?.generation};this.records.set(item.id,record);
      if(item.invalid||!setting?.enabled||item.permissions.some(p=>!setting.permissions?.includes(p)))continue;
      if(started>=this.maxWorkers||Date.now()>=deadline){record.failure='启用的插件过多或加载超时，请停用部分插件后重新保存。';continue;}
      started++;
      try{
        const worker=new PluginProcess(item,{onFailure:reason=>{if(reason!=='PLUGIN_DISABLED'){record.failure=reason;this.log(`[plugin:${item.id}] ${reason}`);}}});
        record.process=worker;await worker.start(Math.max(1,Math.min(2000,deadline-Date.now())));
      }catch(error){record.failure=error.message;}
    }
  }
  list(){
    return [...this.records.values()].map(record=>({id:record.id,actions:record.process?.actions??[],loaded:!!record.process&&!record.process.closed,active:this.active(record),reason:record.invalid?record.reason:record.failure??(!this.policy().config.plugins[record.id]?.enabled?'已关闭':!this.active(record)?'权限未授予或等待加载':'已生效')}));
  }
  toolDefinitions(key){if(typeof key!=='string'||!/^wechat:(private|group):[1-9]\d*$/.test(key))return [];return [...this.records.values()].filter(record=>this.active(record,key)).flatMap(record=>(record.process.tools??[]).map(tool=>({...tool,name:record.id+'__'+tool.id,pluginId:record.id})));}
  bindingRevision(key){return this.toolDefinitions(key).map(tool=>tool.name+':'+this.records.get(tool.pluginId).revision+':'+this.records.get(tool.pluginId).generation).join('|');}
  instructions(key){const record=this.records.get('voice-studio');if(!record||!this.active(record,key,'voice'))return '';try{const preference=new MusicPreferences(this.root).snapshot();return '[音乐发送设置] 普通点歌默认：'+preference.label+'。本轮用户明确要求只唱1分钟或完整唱一遍时优先遵从，不改变已保存默认；没有明确要求时不要擅自改模式。片段只处理最多60秒并发送一条；完整翻唱处理整首并按每段最长55秒发送，最长支持10分钟。以工具返回的modeLabel为准，staged不是已送达。';}catch{return '';}}
  context(record,turn){return {engagement:turn.engagement,chat:{key:turn.conversationKey,platform:'wechat',kind:turn.conversationKey.split(':')[1],id:turn.conversationKey.split(':')[2],name:turn.conversationName??turn.conversationKey},account:{id:this.accountId},now:this.now(),actor:{id:turn.actorId??'',administrator:assistantSenderAllowed(JSON.parse(fs.readFileSync(path.join(this.root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'' )).wechat,turn.conversationKey,turn.actorId)},sessionId:turn.sessionId??'',settings:structuredClone({...record.settings,...this.policy().config.plugins[record.id]?.settings})};}
  service(record,turn,signal,readOnly=false){
    const check=permission=>{if(signal.aborted||!this.active(record,turn.conversationKey,permission))throw fail('PLUGIN_PERMISSION_DENIED');};
    return async(method,args)=>{
      if(method.startsWith('video.')){
        check('video');if(!Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>8192)throw fail('VIDEO_REQUEST_INVALID');
        if(method==='video.enqueue'){
          if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
          return await this.queueVideoFile(record,turn,args[0]??{});
        }
        if(method==='video.status')return new FileTransfers(this.root).status(String(args[0]?.id??''),turn.conversationKey,turn.actorId);
        throw fail('PLUGIN_SERVICE_UNAVAILABLE');
      }
      if(method.startsWith('voice.')){
        check('voice');if(!Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>8192)throw fail('VOICE_REQUEST_INVALID');
        if(method==='voice.enqueue'){
          if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');let request=voiceRequest(args[0]),settings=this.policy().config.plugins[record.id]?.settings??{};
          if(request.kind==='song')request={...request,playbackMode:turn.songPlaybackMode??request.playbackMode??new MusicPreferences(this.root).snapshot().mode};
          if(turn.networkOptOut){if(request.kind!=='song'||!new SavedSongs(this.root).find(request,settings))throw fail('PLUGIN_NETWORK_DISABLED_FOR_TURN');request={...request,cachedOnly:true};}
          turn.voiceRequests??=[];if(turn.voiceRequests.length>=3)throw fail('VOICE_QUEUE_FULL');turn.voiceRequests.push({id:record.id,generation:record.generation,request,fallbackText:request.kind==='speech'?request.text:undefined});
          return {staged:true,savedSongReady:request.cachedOnly===true,...(request.kind==='song'?{playbackMode:request.playbackMode,modeLabel:songPlayback(request.playbackMode).label}:{})};
        }
        if(method==='voice.cancel'){if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');return this.voiceJobs.cancel(turn.conversationKey,record.id,args[0]?.id);}
        if(method==='voice.status')return this.voiceJobs.status(turn.conversationKey,record.id);
        if(method==='voice.songs')return this.voiceJobs.songs();
        throw fail('PLUGIN_SERVICE_UNAVAILABLE');
      }
      if(method==='dshTasks.control'||method==='workbuddyTasks.control'){
        check('dsh_tasks');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
        // WorkBuddy 宿主优先使用进程内实现；旧 taskControl 仅作兼容回退。
        const control=this.workbuddyTasks??this.taskControl;if(!control)throw fail('WORKBUDDY_TASKS_HOST_UNAVAILABLE');
        if(!Array.isArray(args)||args.length!==1||Buffer.byteLength(JSON.stringify(args))>2048)throw fail('ADMIN_DSH_REQUEST_INVALID');
        const request=adminDshRequest(this.root,turn,args[0]);const value=await control(request.action,request.body);check('dsh_tasks');adminDshRequest(this.root,turn,args[0]);return value;
      }
      if(method.startsWith('people.')){
        check('people_memory');const memory=new PeopleMemory({root:this.root,accountScope:this.accountScope,accountId:this.accountId,pluginId:record.id,now:this.now,settings:this.policy().config.plugins[record.id]?.settings,allowedSource:key=>this.active(record,key,'people_memory')});
        if(method==='people.current'){if(this.policy().config.plugins[record.id]?.settings?.autoRemember!==false)memory.capture(turn);return memory.current(turn);}
        if(method==='people.recall')return memory.recall(turn,args[0]??{});
        if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
        if(method==='people.remember')return memory.remember(turn,args[0]);
        if(method==='people.forget')return memory.forgetForTurn(turn,args[0]);
        throw fail('PLUGIN_SERVICE_UNAVAILABLE');
      }
      const limit=method.startsWith('documents.')?1100000:method==='model.generate'?128*1024:64*1024;
      if(!Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>limit)throw fail('PLUGIN_SERVICE_ARGUMENT_INVALID');
      if(method==='audio.read'){
        check('audio_read');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
        const [id,options]=args;
        if(!this.accountBound||!turn.voiceIds?.includes(id)||!options||Object.keys(options).some(key=>key!=='format')||!['wav','silk'].includes(options.format??'wav'))throw fail('VOICE_REFERENCE_NOT_ALLOWED');
        const result=await this.readAudio(id,turn.conversationKey,record.id,{...options,signal});
        check('audio_read');return result;
      }
      if(method.startsWith('documents.')){
        check('documents');const documents=new PluginDocuments(this.root,this.accountScope,this.accountId,record);
        if(method==='documents.get')return documents.get(turn.conversationKey,args[0]);
        if(method==='documents.list')return documents.list(turn.conversationKey,args[0]);
        if(method==='documents.put'){if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');check('documents');return documents.put(turn.conversationKey,args[0],args[1]);}
        throw fail('PLUGIN_SERVICE_UNAVAILABLE');
      }
      if(method==='persona'){check('persona_read');const persona=this.personaFor(turn.conversationKey),name=String(persona.personaName??'').slice(0,80),body=String(persona.persona??'');return {personaName:name,persona:body.slice(0,8000),digest:hash(body),signature:hash(name+'\0'+body)};}
      if(method==='history.today'){
        check('history_read');const {date,limit=200,maxChars=14000,...extra}=args[0]??{};
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(this.now()),get=name=>parts.find(part=>part.type===name).value,current=get('year')+'-'+get('month')+'-'+get('day');
        if(Object.keys(extra).length||date!==current||!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(maxChars)||maxChars<1||maxChars>14000)throw fail('PLUGIN_HISTORY_DAY_INVALID');
        const rows=await this.rowsForDate(turn.conversationKey,date);check('history_read');const selected=[];let chars=0;
        for(const row of rows.slice(-limit)){if(row.forwardedRecord||row.quoteReply||row.outgoing&&row.delivery_status!=='confirmed')continue;const body=String(row.text??'').slice(0,400);if(!body.trim())continue;if(chars+body.length>maxChars)break;chars+=body.length;selected.push({who:String(row.who??row.sender_name??'群友').slice(0,100),text:body});}
        return selected;
      }
      if(method==='history.day'){
        check('history_read');const {date,limit=100,maxChars=12000,...extra}=args[0]??{};
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(this.now()),get=name=>parts.find(part=>part.type===name).value,current=get('year')+'-'+get('month')+'-'+get('day'),[year,month,day]=current.split('-').map(Number),previous=new Date(Date.UTC(year,month-1,day-1)).toISOString().slice(0,10);
        if(Object.keys(extra).length||![current,previous].includes(date)||!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(maxChars)||maxChars<1||maxChars>14000)throw fail('PLUGIN_HISTORY_DAY_INVALID');
        const rows=await this.rowsForDate(turn.conversationKey,date);check('history_read');const selected=[];let chars=0;
        for(const row of rows.slice(-limit)){if(row.forwardedRecord||row.quoteReply||row.outgoing&&row.delivery_status!=='confirmed')continue;const body=String(row.text??'').slice(0,400);if(!body.trim())continue;if(chars+body.length>maxChars)break;chars+=body.length;selected.push({who:String(row.who??row.sender_name??'群友').slice(0,100),text:body});}
        return selected;
      }
      if(method==='media.search'||method==='media.read'){
        check('web_fetch');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(turn.networkOptOut)throw fail('PLUGIN_NETWORK_DISABLED_FOR_TURN');
        if(!Array.isArray(args)||args.length!==1||Buffer.byteLength(JSON.stringify(args))>8192)throw fail('PLUGIN_MEDIA_REQUEST_INVALID');
        if(!this.requestMedia)throw fail('PLUGIN_MEDIA_HOST_UNAVAILABLE');
        const action=method==='media.search'?'search':'read',value=await this.requestMedia(action,args[0],{signal});check('web_fetch');return value;
      }
      // WorkBuddy 表情包来源与搜索：搜索/下载/入库都在宿主进程完成，worker 只传小参数
      if(method.startsWith('memes.')){
        check('web_fetch');if(!this.memesHost)throw fail('PLUGIN_MEME_HOST_UNAVAILABLE');
        if(method==='memes.status')return this.memesHost.status();
        if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(turn.networkOptOut)throw fail('PLUGIN_NETWORK_DISABLED_FOR_TURN');
        if(method==='memes.search')return this.memesHost.search(args[0]??{},{signal});
        if(method==='memes.save')return this.memesHost.save(args[0]??{},{signal});
        throw fail('PLUGIN_SERVICE_UNAVAILABLE');
      }
      if(method==='model.embed'){check('model_embed');if(readOnly||turn.networkOptOut)throw fail('EMBEDDING_NOT_ALLOWED');const result=await localEmbeddings(this.policy().config.plugins[record.id]?.settings??{},args[0],{signal});check('model_embed');return result;}
      if(method==='model.generate'){
        check('model_generate');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(!this.generateText)throw fail('PLUGIN_MODEL_UNAVAILABLE');if(this.utilityCalls>=2||(turn.modelCalls=(turn.modelCalls??0)+1)>3)throw fail('PLUGIN_MODEL_BUSY');
        const options=args[0];if(!options||Object.keys(options).some(key=>!['prompt','maxTokens','maxChars','timeoutMs'].includes(key)))throw fail('PLUGIN_MODEL_OPTIONS_INVALID');
        if(typeof options.prompt!=='string'||!options.prompt.trim()||options.prompt.length>32000||[['maxTokens',16,2200],['maxChars',1,4000],['timeoutMs',1000,120000]].some(([key,min,max])=>options[key]!==undefined&&(!Number.isInteger(options[key])||options[key]<min||options[key]>max)))throw fail('PLUGIN_MODEL_OPTIONS_INVALID');
        this.utilityCalls++;try{const value=await boundedTask(()=>this.generateText({...options,pluginId:record.id,key:turn.conversationKey,signal,allowed:()=>!signal.aborted&&this.active(record,turn.conversationKey,'model_generate')}),{signal,timeoutMs:options.timeoutMs??25000});check('model_generate');return value;}finally{this.utilityCalls--;}
      }
      if(method.startsWith('storage.')){
        check('storage');const [scope,key,value]=args;
        if(!['chat','actor'].includes(scope)||typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(key)||scope==='actor'&&!turn.actorId)throw fail('PLUGIN_STORAGE_KEY_INVALID');
        const file=path.join(directory(this.root,'state/plugins/'+this.accountScope+'/'+record.id),'data.json'),data=fs.existsSync(file)?json(file):{};
        const storeKey=hash(turn.conversationKey+'\0'+(scope==='actor'?turn.actorId:'chat'))+'|'+key;
        if(method==='storage.get')return structuredClone(data[storeKey]??null);
        if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');
        if(method==='storage.set')data[storeKey]=structuredClone(value);else if(method==='storage.delete')delete data[storeKey];else throw fail('PLUGIN_SERVICE_UNAVAILABLE');
        if(Buffer.byteLength(JSON.stringify(data))>256*1024)throw fail('PLUGIN_STORAGE_LIMIT');
        check('storage');atomicJson(file,data);return {ok:true};
      }
      if(method==='memory.search'||method==='memory.index'){check('history_read');if(record.id!=='memory-retrieval'||readOnly)throw fail('MEMORY_SEARCH_NOT_ALLOWED');const settings={...record.settings,...this.policy().config.plugins[record.id]?.settings};if(turn.networkOptOut)settings.embeddingEnabled=false;if(settings.embeddingEnabled)check('model_embed');this.archiveIndex??=new ArchiveMemory({root:this.root,scope:this.accountScope,pageFor:this.archiveFor});const allowed=()=>this.active(record,turn.conversationKey,'history_read');if(method==='memory.index')return this.archiveIndex.start(turn.conversationKey,settings,allowed);return this.archiveIndex.search(turn.conversationKey,args[0]??{},settings,allowed,rows=>filterMemoryOverrides(rows,new PeopleMemory({root:this.root,accountScope:this.accountScope,accountId:this.accountId,settings:this.policy().config.plugins['people-memory']?.settings,allowedSource:key=>allowedChat(this.root,key)}).overrides(turn)));}
      if(method==='history.recent'){
        check('history_read');const {limit=20,...extra}=args[0]??{};if(Object.keys(extra).length||!Number.isInteger(limit)||limit<1||limit>100)throw fail('PLUGIN_HISTORY_LIMIT');
        const rows=[];let bytes=0;
        for(const row of this.historyFor(turn.conversationKey,limit).slice(-limit).reverse()){
          const item={id:String(row.id??'').slice(0,200),text:text(row.text),senderId:String(row.sender_wxid??row.sender_id??'').slice(0,200),senderName:String(row.sender_name??'').slice(0,100),timestamp:row.timestamp,outgoing:!!row.outgoing};
          const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>48*1024)break;bytes+=size;rows.unshift(item);
        }
        return rows;
      }
      if(method==='reply'){
        check('reply');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(turn.replyDisabled)throw fail('PLUGIN_ACTION_REPLY_UNAVAILABLE');if(typeof args[0]!=='string'||!args[0].trim()||turn.replies.reduce((sum,item)=>sum+item.text.length+1,0)+args[0].length>12000||turn.replies.length>=3)throw fail('PLUGIN_REPLY_LIMIT');
        turn.replies.push({id:record.id,text:args[0].trim()});return {queued:true};
      }
      if(method==='fetch'){
        check('web_fetch');if(readOnly)throw fail('PLUGIN_HOOK_READ_ONLY');if(turn.networkOptOut)throw fail('PLUGIN_NETWORK_DISABLED_FOR_TURN');
        const [url,options]=args;if(typeof url!=='string'||!options||Object.keys(options).some(key=>!['maxChars','timeoutMs'].includes(key)))throw fail('PLUGIN_FETCH_OPTIONS_INVALID');
        const {maxChars=12000,timeoutMs=6000}=options;
        if(!Number.isSafeInteger(maxChars)||maxChars<256||maxChars>32000||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>7000)throw fail('PLUGIN_FETCH_OPTIONS_INVALID');
        const response=await this.fetchText(url,maxChars,{signal,timeoutMs});check('web_fetch');
        return {status:response.statusCode??200,body:response.body??response.text??'',headers:{'X-WeChatAgent-Truncated':response.truncated?'true':'false'}};
      }
      throw fail('PLUGIN_SERVICE_UNAVAILABLE');
    };
  }
  async execute(name,args,turn,signal){
    const tool=this.toolDefinitions(turn.conversationKey).find(tool=>tool.name===name);if(!tool)throw fail('PLUGIN_TOOL_UNAVAILABLE');
    validateValue(args,tool.parameters);if(++turn.toolCalls>3)throw fail('PLUGIN_TOOL_LIMIT');
    const record=this.records.get(tool.pluginId),controller=new AbortController(),before=turn.replies.length;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      const result=await record.process.call('tool',tool.id,structuredClone(args),this.context(record,turn),this.service(record,turn,controller.signal),{signal:controller.signal,timeoutMs:this.toolTimeoutMs});
      if(!this.active(record,turn.conversationKey))throw fail('PLUGIN_TOOL_UNAVAILABLE');
      if(result?.isError)turn.replies.splice(before);
      return {content:text(typeof result==='string'?result:result?.content??JSON.stringify(result)),isError:result?.isError===true};
    }catch(error){turn.replies.splice(before);throw error;}
    finally{controller.abort();signal?.removeEventListener('abort',abort);}
  }
  memoryOverrides(turn){const record=this.records.get('people-memory');if(!record||!this.active(record,turn.conversationKey,'people_memory'))return [];return new PeopleMemory({root:this.root,accountScope:this.accountScope,accountId:this.accountId,settings:this.policy().config.plugins['people-memory']?.settings,allowedSource:key=>this.active(record,key,'people_memory')}).overrides(turn);}
  async hooks(name,value,turn,signal){
    const results=[],deadline=Date.now()+2000;
    for(const record of this.records.values()){
      if(!this.active(record,turn.conversationKey)||!record.process.hooks?.includes(name))continue;
      const timeoutMs=Math.min(800,deadline-Date.now());if(timeoutMs<=0)break;
      const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      try{if(name==='before-context'&&record.id==='people-memory'&&this.active(record,turn.conversationKey,'people_memory')&&this.policy().config.plugins[record.id]?.settings?.autoRemember!==false)new PeopleMemory({root:this.root,accountScope:this.accountScope,accountId:this.accountId,pluginId:record.id,now:this.now,settings:this.policy().config.plugins[record.id]?.settings,allowedSource:key=>this.active(record,key,'people_memory')}).capture(turn);
        const result=await record.process.call('hook',name,value,this.context(record,turn),this.service(record,turn,controller.signal,true),{signal:controller.signal,timeoutMs});
        const policyAllowed=this.active(record,turn.conversationKey,'reply_policy')&&turn.conversationKey.startsWith('wechat:group:')&&turn.engagement?.mode==='social'&&turn.engagement?.verified===true&&turn.engagement?.direct===false;
        if(result?.suppressReply&&!policyAllowed)delete result.suppressReply;
        if(name==='after-response'&&result?.text!==undefined&&!this.active(record,turn.conversationKey,'reply')&&!(policyAllowed&&result.text==='SILENT'))delete result.text;
        if(name==='after-response'&&result&&record.permissions.includes('voice')&&this.active(record,turn.conversationKey,'voice')){
          const request=result.voiceReplacement??result.voiceRequest,cooldownKey=record.id+'|'+turn.conversationKey;
          if(request&&(!result.voiceReplacement||(this.voiceCooldown?.get(cooldownKey)??0)<=this.now())){turn.voiceRequests??=[];if(turn.voiceRequests.length<3){try{const normalized=voiceRequest(request);turn.voiceRequests.push({id:record.id,generation:record.generation,request:normalized,fallbackText:result.voiceReplacement?normalized.text:undefined,replacement:!!result.voiceReplacement,cooldownKey,cooldownMs:Math.max(10,Math.min(3600,Number(this.policy().config.plugins[record.id]?.settings?.randomVoiceCooldownSeconds)||90))*1000});}catch(error){this.log(`[plugin:${record.id}] invalid voice request: ${error.message}`);}}}
        }
        results.push(result);
      }
      catch(error){this.log(`[plugin:${record.id}] hook ${name}: ${error.message}`);}
      finally{controller.abort();signal?.removeEventListener('abort',abort);}
    }
    return results;
  }
  /** 只调用指定插件的钩子（WorkBuddy 主链路用），避免触发其它插件的 before/after 副作用。 */
  async hookFor(id,name,value,turn,signal){
    const record=this.records.get(id);
    if(!record||!this.active(record,turn.conversationKey)||!['before-context','after-response'].includes(name)||!record.process?.hooks?.includes(name))return null;
    const controller=new AbortController(),abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{return await record.process.call('hook',name,value,this.context(record,turn),this.service(record,turn,controller.signal,true),{signal:controller.signal,timeoutMs:800});}
    finally{controller.abort();signal?.removeEventListener('abort',abort);}
  }
  async invokeAction(id,name,args,turn,{signal,timeoutMs=35000,requireReply=false}={}){
    if(!allowedChat(this.root,turn.conversationKey))throw fail('PLUGIN_CHAT_UNAVAILABLE');await this.sync();const record=this.records.get(id);
    if(!record||!this.active(record,turn.conversationKey))return {handled:false};
    const action=record.process.actions.find(action=>action.id===name);if(!action)throw fail('PLUGIN_ACTION_UNAVAILABLE');validateValue(args,action.parameters);
    return this.invoke(record,'action',name,args,turn,{signal,timeoutMs,requireReply});
  }
  async invoke(record,kind,name,args,turn,{signal,timeoutMs=35000,requireReply=false}={}){
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const scoped={...turn,replies:[],toolCalls:0,modelCalls:0,replyDisabled:true};
    try{const result=await record.process.call(kind,name,args,this.context(record,scoped),this.service(record,scoped,controller.signal),{signal:controller.signal,timeoutMs:Math.min(120000,timeoutMs)});
      if(!this.active(record,turn.conversationKey)||requireReply&&!this.active(record,turn.conversationKey,'reply'))throw fail('PLUGIN_PERMISSION_DENIED');return result;
    }finally{controller.abort();signal?.removeEventListener('abort',abort);}
  }
  // 插件视频文件投递：文件必须已由插件写进 state/media/video/<pluginId>/ 下的一个普通文件，
  // 这里只做路径收紧与真实入队；真正的发送、回执与重试全部复用 DSH 文件投递管线。
  async queueVideoFile(record,turn,request){
    const transfers=new FileTransfers(this.root),folder='state/media/video/'+record.id;
    const file=String(request?.file??''),base=file.startsWith(folder+'/')?file.slice(folder.length+1):'';
    if(!base||base.includes('/')||base.includes('\\'))throw fail('VIDEO_FILE_PATH_INVALID');
    const name=request?.name===undefined?undefined:String(request.name);
    if(!safeFileName(name??base))throw fail('VIDEO_FILE_NAME_INVALID');
    if(turn.networkOptOut)throw fail('PLUGIN_NETWORK_DISABLED_FOR_TURN');
    if(fs.lstatSync(path.resolve(this.root,file)).isSymbolicLink())throw fail('VIDEO_FILE_PATH_INVALID');
    // FileTransfers.queue 要求 batchId 为 64 位十六进制；turn 的兜底值是 turn-<时间戳>，
    // 直接传入会被拒为 FILE_RELATIVE_PATH_REQUIRED。这里把非标准值归一成稳定的 sha256。
    const rawBatch=String(turn.batchId??('turn-'+this.now()));
    const batchId=/^[a-f0-9]{64}$/.test(rawBatch)?rawBatch:hash(rawBatch);
    const job=await transfers.queue({key:turn.conversationKey,sender:turn.actorId,cwd:this.root,file,name,batchId});
    return {staged:true,id:job.id,state:job.state,name:job.name,size:job.size,notice:job.notice};
  }
  commitVoice(turn,signal){
    if(signal?.aborted||!Array.isArray(turn.voiceRequests)||!turn.voiceRequests.length)return [];
    const staged=turn.voiceRequests.splice(0),queued=[];
    for(let index=0;index<staged.length;index++){const item=staged[index],record=this.records?.get(item.id);if(!record||record.generation!==item.generation||!this.active(record,turn.conversationKey,'voice'))continue;try{queued.push({...this.voiceJobs.queue({key:turn.conversationKey,pluginId:item.id,generation:item.generation,batchId:turn.batchId??turn.sessionId??'turn-'+this.now(),request:item.request,index,fallbackText:item.fallbackText}),fallbackText:item.fallbackText});if(item.replacement&&item.cooldownKey)this.voiceCooldown?.set(item.cooldownKey,this.now()+item.cooldownMs);}catch(error){this.log(`[plugin:${item.id}] voice queue: ${error.message}`);}}
    turn.queuedVoiceRequests=queued;return queued;
  }
  voiceReplyText(turn,source){let output=String(source??'');for(const job of turn.queuedVoiceRequests??[]){const text=job.fallbackText;if(text&&job.state==='queued')output=output.replace(text,'');}return output;}
  async tick(){
    if(this.closed||this.ticking||!this.isAllowed()||!this.canSchedule()||this.isBusy())return;this.ticking=true;
    try{await this.sync();const settings=json(path.join(this.root,'config/wechatagent.json')),parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(this.now()),value=name=>parts.find(part=>part.type===name).value,date=value('year')+'-'+value('month')+'-'+value('day'),time=value('hour')+':'+value('minute');
      for(const record of this.records.values()){
        if(!record.schedule||!record.process?.scheduled||!this.active(record,undefined,'schedule'))continue;
        const local=this.policy().config.plugins[record.id],at=local.settings?.[record.schedule.timeSetting]??record.settings[record.schedule.timeSetting];if(time<at)continue;
        const folder=directory(this.root,'state/plugin-schedules/'+this.accountScope),file=path.join(folder,record.id+'.json');
        if(fs.existsSync(file)&&(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>512*1024))throw fail('PLUGIN_SCHEDULE_STATE_INVALID');
        const receipts=fs.existsSync(file)?json(file):{};
        const keys=['private','groups'].flatMap(kind=>(settings.wechat?.whitelist?.[kind]??[]).map(id=>'wechat:'+(kind==='groups'?'group':'private')+':'+id));
        for(const key of keys){const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(this.now()),get=name=>day.find(part=>part.type===name).value;if(get('year')+'-'+get('month')+'-'+get('day')!==date)return;if(!this.active(record,key,'schedule')||this.isBusy(key))continue;
          const retryKey=record.id+'|'+key,local=this.policy().config.plugins[record.id],settingsNow=local.settings??record.settings,persona=record.schedule.personaScoped?this.personaFor(key):null,identity=dailyScheduleIdentity(record,settingsNow,date,persona);
          if(receipts._deferUntil>this.now()||receipts[key]===identity||(this.scheduleRetry.get(retryKey)??0)>this.now())continue;
          try{const result=await this.invoke(record,'schedule','daily',{date},{conversationKey:key},{timeoutMs:35000});if(scheduleCompleted(result)){receipts[key]=identity;delete receipts._deferUntil;this.scheduleRetry.delete(retryKey);atomicJson(file,receipts);}else this.scheduleRetry.set(retryKey,this.now()+15*60000);}
          catch(error){this.scheduleRetry.set(retryKey,this.now()+15*60000);this.log(`[plugin:${record.id}] schedule: ${error.message}`);}
        }
      }
    }finally{this.ticking=false;}
  }
  start(){if(!this.closed&&!this.timer){this.timer=setInterval(()=>{void this.tick().catch(error=>this.log('plugin scheduler: '+error.message));},60000);this.timer.unref?.();}}
  async dispose(){await this.archiveIndex?.close();this.closed=true;clearInterval(this.timer);this.watcher?.close();await Promise.allSettled([...this.records.values()].map(record=>record.process?.dispose()));await this.syncing?.catch(()=>{});this.records.clear();}
}

export function bindAgentTools(agentCtx,runtime,key,turnFor){
  const disposers=[];
  const policy={names:()=>new Set(runtime.toolDefinitions(key).map(tool=>tool.name)),check:name=>!!turnFor()&&runtime.toolDefinitions(key).some(tool=>tool.name===name),definitions:()=>runtime.toolDefinitions(key)};
  try{Object.defineProperty(agentCtx,TOOL_POLICY,{value:policy,configurable:true});}
  catch{runtime.log('plugin tool policy could not be bound; continuing without plugin tools');return()=>{};}
  const groups=new Map();for(const tool of runtime.toolDefinitions(key)){if(!groups.has(tool.pluginId))groups.set(tool.pluginId,[]);groups.get(tool.pluginId).push(tool);}
  for(const [id,tools]of groups){
    const own=[];
    try{
      for(const tool of tools)own.push(agentCtx.tools.register({name:tool.name,description:tool.description,parameters:tool.parameters,
        output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,result)=>[{type:'text',text:result.content}]},
        async execute(args,execution){const turn=turnFor();if(!turn)throw fail('PLUGIN_TURN_UNAVAILABLE');const result=await runtime.execute(tool.name,args,turn,execution?.signal);if(result.isError)throw fail(result.content);return result;},
      }));
      disposers.push(...own);
    }catch{
      for(const dispose of own)if(typeof dispose==='function')dispose();
      const record=runtime.records.get(id);if(record){record.failure='PLUGIN_TOOL_REGISTRATION_CONFLICT';record.process?.dispose().catch(()=>{});}
      runtime.log(`[plugin:${id}] PLUGIN_TOOL_REGISTRATION_CONFLICT`);
    }
  }
  return()=>{for(const dispose of disposers)if(typeof dispose==='function')dispose();if(agentCtx[TOOL_POLICY]===policy)delete agentCtx[TOOL_POLICY];};
}
