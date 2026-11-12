import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {unpackZip} from './zip.mjs';
import {LIMITS,directory,inspectPackage,configuration,scanPlugins,atomicJson,validateValue,fail,saveConfiguration} from './catalog.mjs';

export class PluginInstaller{
  constructor(root){this.root=path.resolve(root);this.tickets=new Map();}
  remove(folder){
    const base=path.resolve(this.root,'state/plugin-install-staging');
    if(path.dirname(path.resolve(folder))!==base||fs.lstatSync(folder).isSymbolicLink())throw fail('安装暂存路径无效。');
    fs.rmSync(folder,{recursive:true,force:true});
  }
  expire(){
    for(const [ticket,item]of this.tickets)if(item.expiresAt<Date.now()){if(fs.existsSync(item.folder))this.remove(item.folder);this.tickets.delete(ticket);}
    const base=directory(this.root,'state/plugin-install-staging');
    for(const entry of fs.readdirSync(base,{withFileTypes:true}))if(entry.isDirectory()&&/^[a-f0-9-]{36}$/.test(entry.name)&&!this.tickets.has(entry.name)){
      const folder=path.join(base,entry.name);if(fs.lstatSync(folder).mtimeMs<Date.now()-10*60000)this.remove(folder);
    }
  }
  inspect(body){
    this.expire();
    if(this.tickets.size>=4)throw fail('待确认的插件过多，请先完成或取消安装。',429);
    if(typeof body.name!=='string'||!body.name.toLowerCase().endsWith('.zip')||typeof body.zip!=='string'||body.zip.length>Math.ceil(LIMITS.zipBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.zip))throw fail('请选择不超过 8 MiB 的 ZIP 插件文件。');
    const bytes=Buffer.from(body.zip,'base64');if(bytes.toString('base64')!==body.zip)throw fail('ZIP 文件数据无效。');
    const files=unpackZip(bytes),ticket=crypto.randomUUID(),folder=directory(this.root,'state/plugin-install-staging/'+ticket);
    try{
      for(const file of files){const target=path.resolve(folder,...file.name.split('/'));if(!target.startsWith(folder+path.sep))throw fail('ZIP 路径无效。');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.data,{flag:'wx'});}
      const item=inspectPackage(folder),installed=scanPlugins(this.root).find(row=>row.id===item.id);
      this.tickets.set(ticket,{folder,item,expiresAt:Date.now()+10*60000});
      return {ticket,revision:configuration(this.root).revision,plugin:{id:item.id,name:item.name,description:item.description,version:item.version,author:item.author??'',permissions:item.permissions,apiVersion:2},installedVersion:installed?.version??null,files:files.length,bytes:files.reduce((sum,file)=>sum+file.data.length,0)};
    }catch(error){this.remove(folder);throw error;}
  }
  cancel(ticket){const item=this.tickets.get(ticket);if(item){if(fs.existsSync(item.folder))this.remove(item.folder);this.tickets.delete(ticket);}return {ok:true};}
  install({ticket,revision,replace=false}){
    if(typeof replace!=='boolean')throw fail('更新确认必须是明确的布尔值。');
    this.expire();const pending=this.tickets.get(ticket);if(!pending)throw fail('安装预览已过期，请重新选择 ZIP。',409);
    const saved=configuration(this.root);if(saved.revision!==revision)throw fail('插件列表已变化，请重新选择 ZIP。',409);
    const item=inspectPackage(pending.folder);if(item.revision!==pending.item.revision)throw fail('预览后的插件文件发生变化，请重新选择 ZIP。',409);
    const base=directory(this.root,'plugins'),target=path.join(base,item.id),exists=fs.existsSync(target);
    if(exists&&!replace)throw fail('同名插件已安装，请确认更新。',409);
    if(!exists&&scanPlugins(this.root).length>=LIMITS.plugins)throw fail('最多安装 32 个插件，请先卸载不使用的插件。');
    if(exists&&fs.lstatSync(target).isSymbolicLink())throw fail('已有插件目录不能是链接。');
    const archive=exists?path.join(directory(this.root,'state/plugin-archives'),item.id+'-'+crypto.randomUUID()):null;
    if(archive)fs.renameSync(target,archive);
    try{
      fs.renameSync(pending.folder,target);
      const previous=saved.config.plugins[item.id]??{};
      // Updating code always requires re-enabling it, while retaining data
      // and compatible owner settings. No plugin code runs in this process.
      const settings={...item.settings};
      for(const [key,value]of Object.entries(previous.settings??{}))if(Object.hasOwn(item.configSchema,key)){
        try{validateValue(value,item.configSchema[key]);settings[key]=value;}catch{}
      }
      saved.config.plugins[item.id]={enabled:false,permissions:[],chats:previous.chats??[],settings,generation:crypto.randomUUID()};
      saveConfiguration(this.root,saved.config,saved.revision);
    }catch(error){
      if(fs.existsSync(target)&&!fs.existsSync(pending.folder))fs.renameSync(target,pending.folder);
      if(archive)fs.renameSync(archive,target);
      throw error;
    }
    this.tickets.delete(ticket);return {ok:true,id:item.id,updated:exists,enabled:false,revision:configuration(this.root).revision};
  }
  dispose(){for(const ticket of [...this.tickets.keys()])try{this.cancel(ticket);}catch{this.tickets.delete(ticket);}}
}
