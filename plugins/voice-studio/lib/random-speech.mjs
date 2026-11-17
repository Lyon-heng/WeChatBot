export function chooseVoiceSentence(output,{chance=25,random=Math.random}={}){
 if(typeof output!=='string'||!output.startsWith('RESPOND:')||!Number.isInteger(chance)||chance<1||chance>100||random()*100>=chance)return null;
 const body=output.slice(8).trim();if(!body||body.length>1200||/https?:|www\.|[\[\]{}<>`@]|(?:SILENT|OBSERVE|REASONING):/i.test(body))return null;
 const candidates=(body.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[^。！？!?；;\n]+$/g)??[]).map(s=>s.trim()).filter(s=>s.length>=6&&s.length<=90);
 return candidates.length?candidates[Math.min(candidates.length-1,Math.floor(random()*candidates.length))]:null;
}
