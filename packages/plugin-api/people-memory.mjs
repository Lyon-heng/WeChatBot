import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {directory,atomicJson} from './catalog.mjs';
import {selfFacts,sharingConfirmed,memoryQueryTokens} from './people-facts.mjs';
import {memorySettings} from './memory-policy.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const HEX=/^[a-f0-9]{64}$/,KEY=/^wechat:(private|group):[1-9]\d{0,15}$/;
const rememberRequest=/记住|记一下|记得|以后叫我|请叫我|我喜欢|我习惯|我的偏好|我叫|remember|call me|i prefer/i;
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
const noteRevision=note=>hash(JSON.stringify(note));
function auditNote(note,at,reason){note.history=[...(note.history??[]),{text:note.text,visibility:note.visibility,pinned:note.pinned===true,deletedAt:note.deletedAt??null,at,reason,version:note.version??1}].slice(-8);note.version=(note.version??1)+1;}
export function peopleObservations(key,rows){
  return rows.filter(row=>!row.outgoing&&!row.forwardedRecord&&!row.quoteReply&&row.interaction!=='pat'&&typeof row.sender_wxid==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(row.sender_wxid))
    .slice(-20).map(row=>({senderId:row.sender_wxid,...(HEX.test(row.sender_key??'')?{memberId:row.sender_key}:{}),name:clean(row.sender_name).slice(0,80),evidenceId:hash(JSON.stringify([key,row.sender_wxid,row.message_id||row.id])),text:String(row.text??'').slice(0,1000),at:Math.floor(row.timestamp*1000)}));
}
export class PeopleMemory{
  constructor({root,accountScope,accountId,pluginId='people-memory',now=Date.now,allowedSource=()=>true,settings={}}){Object.assign(this,{root,accountScope,accountId,pluginId,now,allowedSource});this.settings=memorySettings(settings);}
  file(){const base=directory(this.root,`state/plugins/${this.accountScope}/${this.pluginId}`),file=path.join(base,'people-memory.json');if(fs.existsSync(file)&&(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile()||fs.statSync(file).size>4*1024*1024))throw Error('PEOPLE_MEMORY_FILE_INVALID');return file;}
  read(){const file=this.file();if(!fs.existsSync(file))return {version:1,accountId:this.accountId,people:{},usage:{}};const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1||data.accountId!==this.accountId||!data.people||Array.isArray(data.people)||typeof data.people!=='object'||Object.keys(data.people).length>1000)throw Error('PEOPLE_MEMORY_FILE_INVALID');data.usage??={};if(!data.usage||Array.isArray(data.usage)||typeof data.usage!=='object'||Object.keys(data.usage).length>1000)throw Error('PEOPLE_MEMORY_FILE_INVALID');for(const key of Object.keys(data.usage))if(!KEY.test(key)||!data.usage[key]||!Number.isSafeInteger(data.usage[key].lastContextNotes)||data.usage[key].lastContextNotes<0)throw Error('PEOPLE_MEMORY_FILE_INVALID');for(const [id,person]of Object.entries(data.people)){if(!HEX.test(id)||person.id!==id||!Array.isArray(person.names)||person.names.length>5||person.names.some(name=>typeof name!=='string'||name.length>80)||!Array.isArray(person.notes)||person.notes.length>256)throw Error('PEOPLE_MEMORY_FILE_INVALID');for(const note of person.notes)if(!HEX.test(note.id)||!HEX.test(note.evidenceId)||!KEY.test(note.chat)||!['chat','person'].includes(note.visibility)||typeof note.text!=='string'||note.text.length>500||!Number.isSafeInteger(note.at)||!Number.isSafeInteger(note.expiresAt))throw Error('PEOPLE_MEMORY_FILE_INVALID');}return data;}
  write(data){if(Buffer.byteLength(JSON.stringify(data))>4*1024*1024)throw Error('PEOPLE_MEMORY_FULL');atomicJson(this.file(),data);}
  mutate(action){
    const lock=this.file()+'.lock';let handle;
    try{handle=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;let stale=false;try{const st=fs.lstatSync(lock),pid=st.isFile()&&!st.isSymbolicLink()&&st.size<32?fs.readFileSync(lock,'utf8'):'';if(/^[1-9]\d{0,9}$/.test(pid)){try{process.kill(Number(pid),0);}catch(check){stale=check.code==='ESRCH';}}}catch{}if(!stale)throw Error('PEOPLE_MEMORY_BUSY');fs.unlinkSync(lock);handle=fs.openSync(lock,'wx',0o600);}
    try{fs.writeFileSync(handle,String(process.pid));return action();}finally{fs.closeSync(handle);fs.unlinkSync(lock);}
  }
  observations(turn){if(!KEY.test(turn?.conversationKey??''))return [];return (Array.isArray(turn.peopleObservations)?turn.peopleObservations:[]).slice(-20).filter(row=>row&&/^[A-Za-z0-9_-]{1,128}$/.test(row.senderId??'')&&HEX.test(row.evidenceId??'')&&typeof row.name==='string'&&row.name.length<=80&&typeof row.text==='string'&&row.text.length<=1000&&Number.isSafeInteger(row.at)&&row.at>this.now()-86400000&&row.at<this.now()+60000).map(row=>({...row,personId:hash(this.accountId+'\0'+row.senderId)}));}
  current(turn){const rows=this.observations(turn);return [...new Set(rows.map(row=>row.personId))].map(id=>({id,name:rows.findLast(row=>row.personId===id).name,evidence:rows.filter(row=>row.personId===id).map(row=>({id:row.evidenceId,text:row.text,at:row.at}))}));}
  capture(turn){return this.mutate(()=>this.captureUnlocked(turn));}
  captureUnlocked(turn){
    const rows=this.observations(turn);if(!rows.length)return {saved:0};const data=this.read();let saved=0,changed=false;
    for(const evidence of rows){
      const known=data.people[evidence.personId];if(!known&&Object.keys(data.people).length>=1000)continue;
      const observed=known??{id:evidence.personId,names:[],notes:[],firstSeenAt:evidence.at};const names=[evidence.name,...observed.names].filter((value,index,array)=>value&&array.indexOf(value)===index).slice(0,5);
      const archiveIds=[...new Set([hash(evidence.senderId),...(HEX.test(evidence.memberId??'')?[evidence.memberId]:[]),...(observed.archiveIds??[])])].slice(0,20);
      if(!known||JSON.stringify(names)!==JSON.stringify(observed.names)||JSON.stringify(archiveIds)!==JSON.stringify(observed.archiveIds)||evidence.at>Number(observed.lastSeenAt??0)){observed.names=names;observed.archiveIds=archiveIds;observed.lastSeenAt=Math.max(evidence.at,observed.lastSeenAt??0);data.people[evidence.personId]=observed;changed=true;}
      for(const fact of selfFacts(evidence.text)){
        if(this.settings['remember'+fact.category[0].toUpperCase()+fact.category.slice(1)]===false)continue;
        const id=evidence.personId,visibility=this.settings.allowCrossChat&&sharingConfirmed(evidence.text)?'person':'chat';
        const person=data.people[id]??{id,names:[],notes:[],firstSeenAt:evidence.at};
        const noteId=hash(id+'\0'+turn.conversationKey+'\0'+fact.text+'\0'+visibility);
        // Keep deletion tombstones: replaying the same source message cannot restore a forgotten note.
        if(person.notes.some(note=>note.id===noteId)){data.people[id]=person;continue;}
        if(person.notes.length>=this.settings.maxNotesPerPerson)continue;
        for(const old of person.notes){if(old.deletedAt||old.chat!==turn.conversationKey&&(old.visibility!=='person'||!this.allowedSource(old.chat)))continue;if(selfFacts(old.text).some(previous=>previous.key===fact.key&&(previous.polarity!==fact.polarity||['nickname','pet','activity','project'].includes(fact.category)&&previous.value!==fact.value))){auditNote(old,this.now(),'本人新陈述修正');old.deletedAt=this.now();old.supersededBy=noteId;}}
        person.names=[evidence.name,...person.names].filter((value,index,array)=>value&&array.indexOf(value)===index).slice(0,5);person.lastSeenAt=evidence.at;
        person.notes.push({id:noteId,text:fact.text,visibility,chat:turn.conversationKey,evidenceId:evidence.evidenceId,evidence:evidence.text.slice(0,300),at:this.now(),expiresAt:this.now()+(fact.category==='nickname'?this.settings.nicknameRetentionDays:fact.category==='plan'?this.settings.planRetentionDays:this.settings.factRetentionDays)*86400000});data.people[id]=person;saved++;
      }
    }
    if(saved||changed)this.write(data);return {saved};
  }
  recall(turn,args={}){return this.mutate(()=>this.recallUnlocked(turn,args));}
  recallUnlocked(turn,args={}){
    if(Object.keys(args).some(key=>!['personId','query','limit'].includes(key))||args.personId!==undefined&&!HEX.test(args.personId)||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>120)||args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>8))throw Error('PEOPLE_MEMORY_QUERY_INVALID');
    const current=this.current(turn);if(args.personId&&!current.some(person=>person.id===args.personId))throw Error('PEOPLE_MEMORY_PERSON_NOT_PRESENT');const data=this.read(),tokens=memoryQueryTokens(args.query);
    const seen=turn.memoryPeopleRecalled??=new Set();
    const result=current.filter(person=>!args.personId||person.id===args.personId).filter(person=>{if(seen.has(person.id))return true;if(seen.size>=this.settings.recallPeopleLimit)return false;seen.add(person.id);return true;}).slice(0,this.settings.recallPeopleLimit).map(person=>{
      const ranked=(data.people[person.id]?.notes??[]).filter(note=>!note.deletedAt&&note.expiresAt>this.now()&&this.allowedSource(note.chat)&&(note.chat===turn.conversationKey||this.settings.allowCrossChat&&note.visibility==='person')).map(note=>({...note,score:tokens.reduce((score,token)=>score+(note.text.toLocaleLowerCase().includes(token)?1:0),0)})).sort((a,b)=>b.score-a.score||b.at-a.at);
      const nickname=ranked.filter(note=>selfFacts(note.text).some(fact=>fact.category==='nickname')).sort((a,b)=>b.at-a.at)[0];
      const pinned=ranked.filter(note=>note.pinned).sort((a,b)=>(b.modifiedAt??b.at)-(a.modifiedAt??a.at));const ordered=[...pinned,...(nickname?[nickname]:[]),...ranked],seen=new Set();const selected=ordered.filter(note=>!seen.has(note.id)&&seen.add(note.id)).slice(0,Math.min(args.limit??this.settings.recallLimit,this.settings.recallLimit));
      return {id:person.id,name:person.name,notes:selected.map(note=>({id:note.id,text:note.text,visibility:note.visibility,at:note.modifiedAt??note.at,source:note.correctedAt?'本机用户纠正的事实':note.chat===turn.conversationKey?'本聊天的本人陈述':'本人明确允许跨聊天使用'}))};
    });
    const contextBatch=hash(JSON.stringify(this.observations(turn).map(row=>row.evidenceId).sort())),previous=data.usage[turn.conversationKey];
    const counts=previous?.contextBatch===contextBatch&&previous.contextPeople&&Object.entries(previous.contextPeople).every(([id,n])=>HEX.test(id)&&Number.isInteger(n)&&n>=0&&n<=8)?{...previous.contextPeople}:{};
    for(const person of result)counts[person.id]=person.notes.length;
    data.usage[turn.conversationKey]={lastContextNotes:Object.values(counts).reduce((a,b)=>a+b,0),contextBatch,contextPeople:counts};this.write(data);return result;
  }
  remember(turn,args){return this.mutate(()=>this.rememberUnlocked(turn,args));}
  rememberUnlocked(turn,args){
    if(!args||Object.keys(args).some(key=>!['personId','text','evidenceId','visibility'].includes(key))||typeof args.text!=='string'||!clean(args.text)||args.text.length>500||!HEX.test(args.evidenceId??'')||!['chat','person'].includes(args.visibility??'chat'))throw Error('PEOPLE_MEMORY_NOTE_INVALID');
    const evidence=this.observations(turn).find(row=>row.evidenceId===args.evidenceId&&(!args.personId||row.personId===args.personId));if(!evidence)throw Error('PEOPLE_MEMORY_EVIDENCE_MISMATCH');if(!clean(evidence.text).includes(clean(args.text)))throw Error('PEOPLE_MEMORY_EVIDENCE_MISMATCH');if(!rememberRequest.test(evidence.text))throw Error('PEOPLE_MEMORY_EXPLICIT_REQUEST_REQUIRED');
    const visibility=args.visibility??'chat';if(visibility==='person'&&(!this.settings.allowCrossChat||!sharingConfirmed(evidence.text)))throw Error('PEOPLE_MEMORY_SHARING_NOT_CONFIRMED');
    const data=this.read(),id=evidence.personId;if(!data.people[id]&&Object.keys(data.people).length>=1000)throw Error('PEOPLE_MEMORY_FULL');
    const person=data.people[id]??{id,names:[],notes:[],firstSeenAt:evidence.at};person.names=[evidence.name,...person.names].filter((value,index,array)=>value&&array.indexOf(value)===index).slice(0,5);person.lastSeenAt=evidence.at;
    const noteId=hash(id+'\0'+turn.conversationKey+'\0'+clean(args.text)+'\0'+visibility);
    const existing=person.notes.find(note=>note.id===noteId);if(existing)return existing.deletedAt?{saved:false,forgotten:true}:{saved:true,duplicate:true,id:existing.id};
    if(person.notes.length>=this.settings.maxNotesPerPerson)throw Error('PEOPLE_MEMORY_PERSON_FULL');
    person.notes.push({id:noteId,text:clean(args.text),visibility,chat:turn.conversationKey,evidenceId:evidence.evidenceId,evidence:evidence.text.slice(0,300),at:this.now(),expiresAt:this.now()+this.settings.factRetentionDays*86400000});data.people[id]=person;this.write(data);return {saved:true,id:noteId,visibility};
  }
  forget(id){return this.mutate(()=>{if(!HEX.test(id??''))throw Error('PEOPLE_MEMORY_NOTE_INVALID');const data=this.read();for(const person of Object.values(data.people)){const note=person.notes.find(note=>note.id===id);if(note){if(!note.deletedAt){auditNote(note,this.now(),'忘记此条');note.deletedAt=this.now();this.write(data);}return {forgotten:true};}}return {forgotten:false};});}
  manage(body){return this.mutate(()=>{
    if(!body||Object.keys(body).some(key=>!['id','revision','action','text'].includes(key))||!HEX.test(body.id??'')||!HEX.test(body.revision??'')||!['edit','pin','unpin','revoke-sharing','forget','restore'].includes(body.action))throw Error('PEOPLE_MEMORY_EDIT_INVALID');
    const data=this.read(),person=Object.values(data.people).find(p=>p.notes.some(n=>n.id===body.id)),note=person?.notes.find(n=>n.id===body.id);if(!note)throw Error('PEOPLE_MEMORY_NOTE_NOT_FOUND');if(noteRevision(note)!==body.revision)throw Error('PEOPLE_MEMORY_REVISION_CHANGED');
    if(body.action==='edit'&&(typeof body.text!=='string'||!clean(body.text)||body.text.length>500))throw Error('PEOPLE_MEMORY_EDIT_INVALID');
    if(note.deletedAt&&body.action!=='restore')throw Error('PEOPLE_MEMORY_NOTE_INACTIVE');
    if(body.action==='restore'&&(!note.deletedAt||note.supersededBy))throw Error('PEOPLE_MEMORY_RESTORE_INVALID');
    auditNote(note,this.now(),{edit:'本机用户纠正',pin:'置顶',unpin:'取消置顶','revoke-sharing':'撤销跨聊天共享',forget:'忘记此条',restore:'恢复此条'}[body.action]);note.modifiedAt=this.now();
    if(body.action==='edit'){note.text=clean(body.text);note.correctedAt=this.now();note.visibility='chat';}
    if(body.action==='pin'||body.action==='unpin')note.pinned=body.action==='pin';
    if(body.action==='revoke-sharing')note.visibility='chat';
    if(body.action==='forget')note.deletedAt=this.now();
    if(body.action==='restore'){delete note.deletedAt;note.expiresAt=Math.max(note.expiresAt,this.now()+this.settings.factRetentionDays*86400000);}
    this.write(data);return {saved:true};
  });}
  managementCatalog(){const data=this.read();return {people:Object.values(data.people).map(person=>({id:person.id,names:person.names,firstSeenAt:person.firstSeenAt,lastSeenAt:person.lastSeenAt,notes:person.notes.map(({evidence,...note})=>({...note,revision:noteRevision(person.notes.find(n=>n.id===note.id)),status:note.deletedAt?'forgotten':note.expiresAt<=this.now()?'expired':'active'}))})).sort((a,b)=>b.lastSeenAt-a.lastSeenAt),usage:structuredClone(data.usage)};}
  overrides(turn){const data=this.read(),current=this.observations(turn);return Object.values(data.people).flatMap(person=>person.notes.filter(note=>(note.correctedAt||note.deletedAt||note.history?.some(h=>h.visibility==='person')&&note.visibility==='chat')&&this.allowedSource(note.chat)&&(note.chat===turn.conversationKey||note.visibility==='person'||note.history?.some(h=>h.visibility==='person'))).map(note=>({personId:person.id,archiveIds:[...new Set([...(person.archiveIds??[]),...current.filter(row=>row.personId===person.id).flatMap(row=>[hash(row.senderId),...(HEX.test(row.memberId??'')?[row.memberId]:[])])])],redactions:[...new Set([...(note.history??[]).map(h=>h.text),...(note.deletedAt?[note.text]:[])])],replacement:note.correctedAt&&!note.deletedAt&&note.expiresAt>this.now()&&(note.chat===turn.conversationKey||this.settings.allowCrossChat&&note.visibility==='person')?note.text:null})));}
  forgetForTurn(turn,args){const data=this.read(),evidence=this.observations(turn).find(row=>row.evidenceId===args?.evidenceId);if(!evidence||!/忘记|删除.*记忆|forget/i.test(evidence.text)||!data.people[evidence.personId]?.notes.some(note=>note.id===args.id))throw Error('PEOPLE_MEMORY_FORGET_NOT_CONFIRMED');return this.forget(args.id);}
  catalog(){const data=this.read();return {people:Object.values(data.people).map(person=>({...person,notes:person.notes.filter(note=>!note.deletedAt&&note.expiresAt>this.now()).map(({evidence,...note})=>note)})).filter(person=>person.notes.length).sort((a,b)=>b.lastSeenAt-a.lastSeenAt)};}
  usage(){return structuredClone(this.read().usage);}
}
