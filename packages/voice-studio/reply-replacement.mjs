export function voiceReplacementRange(source,text){
 if(typeof source!=='string'||!source.startsWith('RESPOND:')||typeof text!=='string'||text.length<1||text.length>220||/[\[\]{}<>`@]|https?:/i.test(text))return null;
 const start=source.indexOf(text,8);return start>=8?{source,start,length:text.length}:null;
}
export function replaceCommittedVoiceText(source,replacement){
 if(!replacement||replacement.source!==source)return source;
 const text=(source.slice(8,replacement.start)+source.slice(replacement.start+replacement.length)).trim();return text?'RESPOND: '+text:'SILENT';
}
