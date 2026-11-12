import fs from 'node:fs';
import path from 'node:path';
import {directory,atomicJson} from './catalog.mjs';

const relative='state/plugin-service-checks/speech-runtime.json';
const stages=new Set(['configuration','audio','api','host','complete']);
function normalized(value,generation){
  if(value?.version!==1||value.generation!==generation||typeof value.ok!=='boolean'||!Number.isFinite(value.at)||value.at<0||!stages.has(value.stage))return null;
  const code=value.ok?'VOICE_TRANSCRIBED':/^VOICE_[A-Z0-9_]{3,80}$/.test(value.code??'')?value.code:'VOICE_INPUT_FAILED';
  return {version:1,generation,ok:value.ok,at:value.at,code,stage:value.stage};
}
export function writeVoiceAttempt(root,result,generation){
  if(typeof generation!=='string'||!generation||generation.length>200)return;
  const value=normalized({version:1,generation,ok:result.ok===true,code:result.code,stage:result.stage,at:Date.now()},generation);
  if(!value)return;
  const file=path.join(directory(root,'state/plugin-service-checks'),'speech-runtime.json');
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())return;
  atomicJson(file,value);
}
export function readVoiceAttempt(root,generation){
  try{
    const file=path.join(root,relative),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return null;
    return normalized(JSON.parse(fs.readFileSync(file,'utf8')),generation);
  }catch{return null;}
}
