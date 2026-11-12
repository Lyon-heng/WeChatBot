// Read-only projection: never expose raw model output, reasoning or tool events.
const MAX_TEXT=60000;
const textOf=value=>typeof value==='string'?value:value&&typeof value==='object'?JSON.stringify(value,null,2):'';
export function nativeMemorySummaries(session,{mode='social',limit=50}={}){
  const events=session.snapshotEvents(),ends=new Map();
  for(const event of events)if(event.type==='compaction/end')ends.set(event.data?.compactionId??event.seq,event);
  const rows=[];
  for(const event of events){
    const data=event.data??{};
    if(event.type!=='compaction/summary')continue;
    const end=ends.get(data.compactionId);
    if(!end||end.data?.error||end.seq<event.seq)continue;
    const full=textOf(data.summary);if(!full.trim())continue;
    rows.push({id:'native:'+session.id+':'+event.seq,source:'native',mode,sessionId:String(session.id),at:Number(end.time)||Number(event.time)||0,text:full.slice(0,MAX_TEXT),truncated:full.length>MAX_TEXT,characters:full.length,coveredTokens:Number.isSafeInteger(data.shadowedTokenCount)?data.shadowedTokenCount:null,coveredMessages:Array.isArray(data.shadowedSeqs)?data.shadowedSeqs.length:Number.isSafeInteger(data.shadowedMessageCount)?data.shadowedMessageCount:null});
  }
  // Older DSH versions persist only the explicitly marked replacement checkpoint.
  if(!rows.length)for(const event of events){
    if(event.type!=='user/message'||event.data?.source?.kind!=='compact-checkpoint')continue;
    if(!events.some(end=>end.type==='compaction/end'&&!end.data?.error&&end.seq>event.seq&&(event.data.source.compactionId===undefined||end.data?.compactionId===event.data.source.compactionId)))continue;
    const full=(event.data.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n');if(!full.trim())continue;
    rows.push({id:'native:'+session.id+':'+event.seq,source:'native',mode,sessionId:String(session.id),at:Number(event.time)||0,text:full.slice(0,MAX_TEXT),truncated:full.length>MAX_TEXT,characters:full.length,coveredTokens:null,coveredMessages:null});
  }
  return rows.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).slice(0,limit);
}
