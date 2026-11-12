import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {nativeMemorySummaries} from '../packages/dsh-social-bridge-plugin/memory-summary.mjs';

// SQLite work stays off the console thread. Only summary fields cross this boundary.
let db;
try{
  const {file,keys,source}=workerData;db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=150;');
  const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),mode=key=>key.endsWith(':assistant-chat')?'assistant-chat':key.endsWith(':assistant')?'assistant':'social';
  let history=[],historyTotal=0,native=[];
  if(has('checkpoints')){
    historyTotal=Number(db.prepare('SELECT count(*) n FROM checkpoints WHERE chat IN (?,?,?)').get(...keys).n);
    if(source!=='native')history=db.prepare('SELECT id,chat,at,substr(text,1,60000) text,length(text) characters FROM checkpoints WHERE chat IN (?,?,?) ORDER BY at DESC,id DESC LIMIT 200').all(...keys).map(row=>({id:'history:'+row.id,source:'history',mode:mode(row.chat),at:row.at,text:row.text,characters:row.characters,truncated:row.characters>60000}));
  }
  let nativeError=false;
  if(source!=='history'&&has('native_sessions')&&has('native_events'))try{
    const sessions=db.prepare('SELECT session,chat FROM native_sessions WHERE chat IN (?,?,?) ORDER BY archived_at DESC LIMIT 21').all(...keys);
    const read=db.prepare(`SELECT seq,json_extract(event,'$.type') type,json_extract(event,'$.time') time,
      json_extract(event,'$.data.compactionId') compactionId,json_extract(event,'$.data.error') error,
      json_extract(event,'$.data.summary') summary,json_extract(event,'$.data.shadowedTokenCount') tokens,
      json_array_length(event,'$.data.shadowedSeqs') coveredMessages,
      CASE WHEN json_extract(event,'$.data.source.kind')='compact-checkpoint' THEN json_extract(event,'$.data.content') ELSE NULL END content
      FROM native_events WHERE session=? AND (json_extract(event,'$.type') IN ('compaction/summary','compaction/end') OR (json_extract(event,'$.type')='user/message' AND json_extract(event,'$.data.source.kind')='compact-checkpoint')) ORDER BY seq DESC LIMIT 150`);
    for(const row of sessions){
      const events=read.all(row.session).map(e=>({seq:e.seq,type:e.type,time:e.time,data:{compactionId:e.compactionId??undefined,error:e.error??undefined,summary:e.summary??undefined,shadowedTokenCount:e.tokens,shadowedMessageCount:e.coveredMessages,...(e.content?{source:{kind:'compact-checkpoint',compactionId:e.compactionId??undefined},content:JSON.parse(e.content)}:{})}}));
      native.push(...nativeMemorySummaries({id:row.session,snapshotEvents:()=>events},{mode:mode(row.chat)}));
    }
    native=native.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).slice(0,50);
  }catch{nativeError=true;}
  parentPort.postMessage({history,historyTotal,native,nativeError});
}catch{parentPort.postMessage({error:true});}finally{db?.close();}
