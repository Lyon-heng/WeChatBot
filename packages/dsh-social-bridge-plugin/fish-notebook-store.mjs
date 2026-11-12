import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {notebookHash} from './fish-notebook-policy.mjs';
const HEX=/^[a-f0-9]{64}$/,KEY=/^wechat:(private|group):[1-9]\d{0,15}$/,ID=/^\d{4}-\d{2}-\d{2}-[a-f0-9]{16}$/,MAX=1024*1024;
export function notebookTextValid(text,max=1000){return typeof text==='string'&&!!text.trim()&&text.length<=max&&!/<\/?(?:think|thinking|analysis|reasoning)\b|<\|[^>]+\|>|[\[［【]\s*(?:STICKER\s*[:：]|S\d+\s*[\]］】])|STICKER_LABELS:|RESPOND\s*[:：]|(?:^|\n)\s*(?:SILENT\s*$|(?:#{1,6}\s*)?(?:思考(?:过程|内容|链)?|内部(?:分析|推理|思考)|推理过程|分析过程|analysis|reasoning|thinking)\s*[:：\n])/i.test(text);}
export class FishNotebookStore{
  constructor(root,accountScope){if(!HEX.test(accountScope??''))throw Error('NOTEBOOK_ACCOUNT_REQUIRED');this.root=path.resolve(root);this.accountScope=accountScope;}
  directory(key){if(!KEY.test(key??''))throw Error('NOTEBOOK_CHAT_INVALID');return this.safe('fish-notebook',this.accountScope,notebookHash(key));}
  safe(...parts){const file=path.join(this.root,'state',...parts);for(let current=file;current!==this.root;current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('NOTEBOOK_PATH_INVALID');return file;}
  file(key,id){if(!ID.test(id??''))throw Error('NOTEBOOK_ENTRY_INVALID');const dir=this.directory(key);return this.safe('fish-notebook',this.accountScope,path.basename(dir),id+'.json');}
  id(date,persona){return date+'-'+notebookHash(persona.personaName+'\0'+persona.persona).slice(0,16);}
  read(key,id){
    const file=this.file(key,id);if(!fs.existsSync(file))return null;
    if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>MAX)throw Error('NOTEBOOK_FILE_INVALID');let entry;try{entry=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('NOTEBOOK_FILE_INVALID');}
    if(entry?.version!==1||entry.accountScope!==this.accountScope||entry.conversationKey!==key||entry.id!==id||entry.date!==id.slice(0,10)||typeof entry.personaName!=='string'||entry.personaName.length>80||!HEX.test(entry.personaDigest??'')||!notebookTextValid(entry.text)||!Number.isSafeInteger(entry.createdAt)||!Number.isSafeInteger(entry.sourceCount)||entry.sourceCount<0||!entry.visitors||typeof entry.visitors!=='object'||Array.isArray(entry.visitors)||Object.keys(entry.visitors).length>500)throw Error('NOTEBOOK_FILE_INVALID');
    for(const [viewer,value]of Object.entries(entry.visitors))if(!HEX.test(viewer)||!Number.isInteger(value?.count)||value.count<0||value.count>3||!Array.isArray(value.receipts)||value.receipts.length>8||value.receipts.some(r=>!HEX.test(r?.id??'')||![1,2,3].includes(r.phase)||(r.reply!==null&&!notebookTextValid(r.reply,240))))throw Error('NOTEBOOK_FILE_INVALID');
    return entry;
  }
  write(entry){
    const file=this.file(entry.conversationKey,entry.id),text=JSON.stringify(entry,null,2)+'\n';if(Buffer.byteLength(text)>MAX)throw Error('NOTEBOOK_FILE_FULL');
    // Validate existing data first; malformed journals are never silently replaced.
    if(fs.existsSync(file))this.read(entry.conversationKey,entry.id);
    fs.mkdirSync(path.dirname(file),{recursive:true});this.file(entry.conversationKey,entry.id);const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
    try{fs.writeFileSync(temp,text,{flag:'wx',mode:0o600});this.file(entry.conversationKey,entry.id);fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  public(entry){return Object.fromEntries(['id','conversationKey','date','personaName','personaDigest','createdAt','sourceCount','text'].map(key=>[key,entry[key]]));}
  list(key,{offset=0,limit=12}={}){
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw Error('NOTEBOOK_PAGE_INVALID');const directory=this.directory(key);if(!fs.existsSync(directory))return {entries:[],total:0,offset,limit,errors:0};
    const files=fs.readdirSync(directory).filter(name=>name.endsWith('.json')&&ID.test(name.slice(0,-5))).sort().reverse();let errors=0;
    const entries=files.slice(offset,offset+limit).flatMap(name=>{try{const entry=this.read(key,name.slice(0,-5));return entry?[this.public(entry)]:[];}catch{errors++;return [];}});return {entries,total:files.length,offset,limit,errors};
  }
}
