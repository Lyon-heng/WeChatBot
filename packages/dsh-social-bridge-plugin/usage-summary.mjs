export function usageMetrics(value={}){
  const result={};
  for(const name of ['calls','missingUsage','U','R','W','O','formatRepairs','historySummaries']){
    const n=value[name]??0;if(!Number.isSafeInteger(n)||n<0)throw Error('HISTORY_USAGE_INVALID');result[name]=n;
  }
  result.P=result.U+result.R+result.W;result.cacheReadRate=result.P?result.R/result.P:null;
  result.firstAt=value.firstAt??null;result.lastAt=value.lastAt??null;return result;
}
export function summarizeUsage(rows){
  const result=usageMetrics();
  for(const row of rows){result.calls++;result.formatRepairs+=row.purpose==='format-repair'?1:0;result.historySummaries+=row.purpose==='history-summary'?1:0;
    if(Number.isFinite(row.at)){result.firstAt=result.firstAt===null?row.at:Math.min(result.firstAt,row.at);result.lastAt=result.lastAt===null?row.at:Math.max(result.lastAt,row.at);}
    if(['u','r','w','o'].some(key=>row[key]===null||row[key]===undefined)){result.missingUsage++;continue;}
    for(const [name,key]of [['U','u'],['R','r'],['W','w'],['O','o']]){if(!Number.isSafeInteger(row[key])||row[key]<0)throw Error('HISTORY_USAGE_INVALID');result[name]+=row[key];}
  }
  return usageMetrics(result);
}
