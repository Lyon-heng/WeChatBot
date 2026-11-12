import fs from 'node:fs';
import {voiceServiceSettings} from './voice-service-settings.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const VOICE_COMPONENTS=JSON.parse(fs.readFileSync(new URL('../packaging/windows/voice-components.json',import.meta.url),'utf8'));
const messages={VOICE_COMPONENT_HASH:'组件包与已登记发行版不一致，请使用本页下载入口重新下载。',VOICE_COMPONENT_PATH:'组件包含无效路径，未导入。',VOICE_COMPONENT_LINK:'目标位置含链接，已停止导入。',VOICE_COMPONENT_LIMIT:'组件包超过文件数量或大小限制。',VOICE_COMPONENT_DISK_FULL:'数据磁盘空间不足，请留出至少 600 MB 可用空间。',VOICE_COMPONENT_BUSY:'另一个实例正在导入组件，请稍后重试。',VOICE_COMPONENT_INCOMPLETE:'组件包内容不完整，请重新下载。',VOICE_COMPONENT_DESTINATION_CHANGED:'目标目录已发生变化，请重新检查组件状态。'};
const fault=(message,status=400)=>Object.assign(Error(message),{status});
export function createVoiceComponents({root,pickFile,python,spec=VOICE_COMPONENTS,launch=spawn}){
 const dataHome=path.dirname(path.resolve(root)),supported=path.basename(root).toLowerCase()==='workspace';
 const tickets=new Map();let job=null,pending=null,selecting=false;
 function snapshot(){
  const components=Object.entries(spec.roots).map(([id,markers])=>{const location=path.join(dataHome,id);let exists=false,ready=false;try{exists=fs.existsSync(location);ready=exists&&!fs.lstatSync(location).isSymbolicLink()&&markers.every(marker=>{const file=path.join(location,marker);return fs.statSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink();});}catch{}return {id,status:ready?'present':exists?'incomplete':'missing'};});
  const voice=path.join(root,'state/voice');let selectedModel;try{selectedModel=voiceServiceSettings(root).modelPath;}catch{}
  return {supported,target:dataHome,package:{name:spec.name,url:spec.url,bytes:spec.bytes,release:spec.release},components,localFiles:{speechEngine:fs.existsSync(path.join(voice,'breeze/runtime/breeze-tts-2-v0.1.6-windows-x64-vulkan/breeze-server.exe')),speechModel:fs.existsSync(selectedModel??path.join(voice,'breeze/models/breeze-tts-2-q8_0.gguf')),singingEnvironment:fs.existsSync(path.join(voice,'feiyu-service/server/.venv/Scripts/python.exe')),separatorEnv:fs.existsSync(path.join(voice,'engines/music/venv/Scripts/python.exe')),separatorModel:fs.existsSync(path.join(voice,'engines/music/models/UVR-MDX-NET-Inst_HQ_3.onnx')),singingService:fs.existsSync(path.join(voice,'feiyu-service/server/.runtime/voice-service/api_key.txt'))},job:job?structuredClone(job):null};
 }
 return {
  snapshot,
  get busy(){return !!pending||selecting;},
  wait:()=>pending??Promise.resolve(),
  async select(){
   if(!supported)throw fault('请在安装版或便携版工作区中导入组件。',409);
   if(pending||selecting)throw fault('组件导入或选择窗口正在处理中。',409);
   selecting=true;
   try{
    const selected=await pickFile();if(!selected)return {cancelled:true};
    const info=fs.lstatSync(selected);if(!info.isFile()||info.isSymbolicLink()||info.size!==spec.bytes||path.extname(selected).toLowerCase()!=='.zip')throw fault('请选择本页下载的完整语音组件 ZIP 包。');
    for(const [id,item]of tickets)if(item.expires<Date.now())tickets.delete(id);
    if(tickets.size>=4)tickets.clear();
    const ticket=crypto.randomUUID();tickets.set(ticket,{file:path.resolve(selected),expires:Date.now()+10*60000});
    return {ticket,name:path.basename(selected),bytes:info.size};
   }finally{selecting=false;}
  },
  start(body){
   if(!body||Object.keys(body).some(key=>key!=='ticket')||typeof body.ticket!=='string')throw fault('请先选择组件包。');
   if(pending||selecting)throw fault('组件正在导入，请等待完成。',409);
   const selected=tickets.get(body.ticket);if(!selected||selected.expires<Date.now())throw fault('选择已过期，请重新选择组件包。',409);tickets.delete(body.ticket);
   job={id:crypto.randomUUID(),phase:'starting',startedAt:Date.now(),message:'正在启动校验…'};
   pending=new Promise(resolve=>{
    let child,buffer='',last=null,total=0,finished=false,timer;
    const finish=(success,code)=>{if(finished)return;finished=true;clearTimeout(timer);job={...job,...(success?last:{}),phase:success?'complete':'failed',finishedAt:Date.now(),message:success?'组件环境导入完成；已有目录保留。请继续检查模型和本地服务。':messages[code]??'组件导入未完成。已有环境保留，请检查空间和目录权限；部分新组件可能已安装，可刷新状态后重试。'};resolve();};
    try{
     child=launch(python(),['-B',fileURLToPath(new URL('./import-voice-components.py',import.meta.url))],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
     timer=setTimeout(()=>{child.kill();finish(false,'VOICE_COMPONENT_TIMEOUT');},15*60000);
     child.stdout.on('data',chunk=>{total+=chunk.length;if(total>1024*1024){child.kill();finish(false);return;}buffer+=chunk.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=JSON.parse(line);if(!['validating','inspecting','extracting','installing','complete','failed'].includes(event.phase))continue;last=event;job={...job,phase:event.phase,filesDone:event.filesDone,filesTotal:event.filesTotal,bytesDone:event.bytesDone,bytesTotal:event.bytesTotal};}catch{}}});
     child.once('error',()=>finish(false));child.once('close',code=>finish(code===0&&last?.phase==='complete',last?.code));
     child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({archive:selected.file,dataHome}));
    }catch{finish(false);}
   }).finally(()=>{pending=null;});
   return {jobId:job.id};
  }
 };
}
