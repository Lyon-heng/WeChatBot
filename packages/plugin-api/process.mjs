import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateSchema,fail} from './catalog.mjs';
import {hostContract,contractFingerprint} from './contract.mjs';

export class PluginProcess{
  constructor(item,{onFailure=()=>{}}={}){this.item=item;this.pending=new Map();this.onFailure=onFailure;this.closed=false;}
  async start(timeoutMs=2000){
    const env=Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','PATH'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    env.ELECTRON_RUN_AS_NODE='1';
    const entry=fileURLToPath(new URL('./worker.mjs',import.meta.url));
    // Windows pins a process working directory. Keep it outside the user
    // package so enabled plugins can still be archived or replaced atomically.
    const child=this.child=fork(entry,[path.join(this.item.directory,'index.mjs'),this.item.id],{cwd:path.dirname(entry),env,execArgv:['--max-old-space-size=96'],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    child.on('error',()=>this.stop('PLUGIN_PROCESS_FAILED'));child.on('exit',()=>this.stop('PLUGIN_PROCESS_EXITED'));
    child.on('message',message=>this.message(message));
    return new Promise((resolve,reject)=>{this.loading={resolve,reject};this.loadTimer=setTimeout(()=>this.stop('PLUGIN_LOAD_TIMEOUT'),timeoutMs);});
  }
  message(message){
    if(!message||this.closed)return;
    if(message.type==='ready'&&this.loading){
      try{
        if(contractFingerprint(message.contract)!==contractFingerprint(hostContract())){this.stop('PLUGIN_HOST_CONTRACT_CHANGED');return;}
        if(!Array.isArray(message.tools)||message.tools.length>16||!Array.isArray(message.hooks))throw Error();
        const ids=new Set();
        for(const tool of message.tools){if(!/^[a-z][a-z0-9-]{0,19}$/.test(tool.id??'')||ids.has(tool.id)||typeof tool.description!=='string'||!tool.description.trim()||tool.description.length>2000)throw Error();ids.add(tool.id);validateSchema(tool.parameters);if(tool.parameters.type!=='object')throw Error();}
        if(message.hooks.some(name=>!['before-context','after-response'].includes(name)))throw Error();
        if(!Array.isArray(message.actions)||message.actions.length>16||!!message.scheduled!==!!this.item.schedule)throw Error();
        const actionIds=new Set();for(const action of message.actions){if(!/^[a-z][a-z0-9-]{0,19}$/.test(action.id??'')||actionIds.has(action.id)||typeof action.description!=='string'||!action.description.trim()||action.description.length>2000)throw Error();actionIds.add(action.id);validateSchema(action.parameters);if(action.parameters.type!=='object')throw Error();}
        this.tools=message.tools;this.actions=message.actions;this.scheduled=message.scheduled===true;this.hooks=message.hooks;clearTimeout(this.loadTimer);this.loading.resolve(this);delete this.loading;
      }catch{this.stop('PLUGIN_TOOL_SCHEMA_INVALID');}return;
    }
    if(message.type==='fatal'){this.stop(message.error??'PLUGIN_LOAD_FAILED');return;}
    const call=this.pending.get(message.call??message.id);if(!call)return;
    if(message.type==='result'){
      this.pending.delete(message.id);call.cleanup();if(message.error)call.reject(fail(message.error));else call.resolve(message.value);return;
    }
    if(message.type==='service')Promise.resolve().then(()=>call.service(message.method,message.args)).then(value=>{
      if(this.pending.has(message.call)&&this.child.connected)this.child.send({type:'service-result',id:message.id,value:value??null});
    },error=>{if(this.pending.has(message.call)&&this.child.connected)this.child.send({type:'service-result',id:message.id,error:String(error.message).slice(0,500)});});
  }
  call(kind,name,args,context,service,{timeoutMs=8000,signal}={}){
    if(this.closed)return Promise.reject(fail('PLUGIN_PROCESS_UNAVAILABLE'));
    if(this.pending.size>=8)return Promise.reject(fail('PLUGIN_PROCESS_BUSY'));
    return new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(),abort=()=>this.stop(signal?.reason?.message??'PLUGIN_CANCELLED'),timer=setTimeout(()=>this.stop('PLUGIN_TIMEOUT'),timeoutMs);
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      this.pending.set(id,{resolve,reject,service,cleanup});
      if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
      this.child.send({type:'call',id,kind,name,args,context},error=>{if(error)this.stop('PLUGIN_PROCESS_FAILED');});
    });
  }
  stop(reason='PLUGIN_DISABLED'){
    if(this.closed)return;this.closed=true;clearTimeout(this.loadTimer);
    this.loading?.reject(fail(reason));delete this.loading;
    for(const call of this.pending.values()){call.cleanup();call.reject(fail(reason));}this.pending.clear();
    this.child?.kill('SIGKILL');this.onFailure(reason);
  }
  async dispose(){
    const child=this.child;if(!child||child.exitCode!==null||child.signalCode!==null){this.stop('PLUGIN_DISABLED');return;}
    const exited=new Promise(resolve=>{const timer=setTimeout(resolve,500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    this.stop('PLUGIN_DISABLED');await exited;
  }
}
