const bounded=(value,fallback,min,max)=>Number.isInteger(value)&&value>=min&&value<=max?value:fallback;
export function voiceSendPolicy(settings={}){return {intervalMs:bounded(settings.voiceSendIntervalSeconds,2,0,30)*1000,minute:bounded(settings.voicePerMinute,6,1,30),tenMinutes:bounded(settings.voicePerTenMinutes,30,1,120)};}
export function voiceSendReadyAt(rows,now,settings){
 const policy=voiceSendPolicy(settings),sent=rows.filter(row=>row.isSend&&Number(row.localType)===34).map(row=>Number(row.createTime)*1000).filter(at=>Number.isFinite(at)&&at>now-600000).sort((a,b)=>a-b),minute=sent.filter(at=>at>now-60000);
 return Math.max(now,(sent.at(-1)??0)+policy.intervalMs,minute.length>=policy.minute?minute[minute.length-policy.minute]+60000:0,sent.length>=policy.tenMinutes?sent[sent.length-policy.tenMinutes]+600000:0);
}
