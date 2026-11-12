import fs from 'node:fs';
import path from 'node:path';
import {atomicJson,hash,fail} from './catalog.mjs';
const KEY=/^wechat:(private|group):[1-9]\d*$/,ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
export class PluginDocuments{
  constructor(root,accountScope,accountId,item){Object.assign(this,{root:path.resolve(root),accountScope,accountId,item});}
  folder(key){
    if(!KEY.test(key??''))throw fail('PLUGIN_DOCUMENT_CHAT_INVALID');
    const relative=this.item.dataNamespace==='fish-notebook-v1'?['fish-notebook',this.accountId,hash(key)]:['plugin-documents',this.accountScope,this.item.id,hash(key)];
    return path.join(this.root,'state',...relative);
  }
  file(key,id){
    if(!ID.test(id??'')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id))throw fail('PLUGIN_DOCUMENT_ID_INVALID');
    const file=path.join(this.folder(key),id+'.json');
    for(let current=file;current!==this.root;current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw fail('PLUGIN_DOCUMENT_PATH_INVALID');
    return file;
  }
  validate(value,key,id){
    if(!value||typeof value!=='object'||Array.isArray(value)||value.conversationKey!==undefined&&value.conversationKey!==key||value.accountScope!==undefined&&value.accountScope!==this.accountId||value.id!==undefined&&value.id!==id)throw fail('PLUGIN_DOCUMENT_SCOPE_INVALID');
    return value;
  }
  get(key,id){
    const file=this.file(key,id);if(!fs.existsSync(file))return null;
    const info=fs.lstatSync(file);if(!info.isFile()||info.size>1024*1024)throw fail('PLUGIN_DOCUMENT_FILE_INVALID');
    let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw fail('PLUGIN_DOCUMENT_FILE_INVALID');}
    return this.validate(value,key,id);
  }
  put(key,id,value){
    const file=this.file(key,id);this.validate(value,key,id);
    if(Buffer.byteLength(JSON.stringify(value))>1024*1024)throw fail('PLUGIN_DOCUMENT_LIMIT');
    // A malformed legacy journal is evidence, not an empty document.
    if(fs.existsSync(file))this.get(key,id);
    fs.mkdirSync(path.dirname(file),{recursive:true});this.file(key,id);atomicJson(file,value);return {ok:true};
  }
  list(key,{offset=0,limit=12}={}){
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('PLUGIN_DOCUMENT_PAGE_INVALID');
    const folder=this.folder(key);this.file(key,'check');if(!fs.existsSync(folder))return {entries:[],total:0,offset,limit,errors:0};
    const names=fs.readdirSync(folder).filter(name=>name.endsWith('.json')&&ID.test(name.slice(0,-5))).sort().reverse();let errors=0,bytes=0,scanned=0;const entries=[];
    for(const name of names.slice(offset,offset+limit)){try{const entry=this.get(key,name.slice(0,-5)),size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>1024*1024)break;bytes+=size;entries.push(entry);}catch{errors++;}scanned++;}
    return {entries,total:names.length,offset,limit,errors,nextOffset:offset+scanned,truncated:scanned<Math.min(limit,names.length-offset)};
  }
}
