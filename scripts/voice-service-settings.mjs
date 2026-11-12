import path from 'node:path';
import fs from 'node:fs';
import {localModelServices} from './local-model-services.mjs';
import {fileURLToPath} from 'node:url';
import {configuration} from '../packages/plugin-api/catalog.mjs';
export function voiceServiceSettings(root,{prepare=false}={}){
 const all=configuration(root).config.plugins,plugin=all['voice-studio'];
 let models=[];try{models=localModelServices(root,{prepare});}catch{}
 if(!plugin?.enabled||!plugin.permissions?.includes('voice'))return {enabled:models.length>0,port:19881,...(models.length?{voiceEnabled:false,models}:{})};
 const port=plugin.settings?.breezePort??19881;
 if(!Number.isInteger(port)||port<1024||port>65534)throw Error('VOICE_PORT_INVALID');
 const selected=all['local-voice-model']?.enabled===true?(all['local-voice-model'].settings?.localModelPath??''):(plugin.settings?.localModelPath??'');let modelPath='';
 if(selected){if(typeof selected!=='string'||selected.length>500||!path.isAbsolute(selected)||/[\x00-\x1f"<>|]/.test(selected)||!selected.toLowerCase().endsWith('.gguf'))throw Error('VOICE_LOCAL_MODEL_PATH_INVALID');
 const stat=fs.lstatSync(selected);if(stat.isSymbolicLink()||!stat.isFile())throw Error('VOICE_LOCAL_MODEL_FILE_INVALID');
 const fd=fs.openSync(selected,'r');try{const header=Buffer.alloc(4);fs.readSync(fd,header,0,4,0);if(header.toString()!=='GGUF')throw Error('VOICE_LOCAL_MODEL_FORMAT_INVALID');}finally{fs.closeSync(fd);}modelPath=path.resolve(selected);}
 return {enabled:true,port,...(modelPath?{modelPath}:{}),...(models.length?{voiceEnabled:true,models}:{})};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(voiceServiceSettings(process.argv[2],{prepare:true})));}
 catch{process.stderr.write('VOICE_SERVICE_SETTINGS_UNAVAILABLE\n');process.exitCode=1;}
}
