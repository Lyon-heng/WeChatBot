import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {windowsPowerShellExecutable,windowsPowerShellEnvironment} from './console-process.mjs';
import {hookProfile} from './hook-profiles.mjs';
const execute=promisify(execFile);
export const BUNDLED_WECHAT_VERSION='4.1.10.27';
export function clientCatalog(result){
  const clients=(result.clients??[]).map(row=>{
    const supported=row.version===BUNDLED_WECHAT_VERSION;
    const intact=row.architecture==='x64'&&row.signed===true&&row.coreSigned===true&&row.coreVersion===row.version;
    const canLaunch=supported&&intact&&result.nativeReady===true;
    return {...row,supported,intact,canLaunch,tool:canLaunch?'wechat-hook-4.1.10.27':null,
      status:!supported?(hookProfile(row.version)?'上游有此精确版本的基础文字方案；本发行的语音、表情等尚未适配，请使用内置匹配版。':row.version==='4.1.15.56'?'此版本没有匹配组件，不能套用上游 4.1.15.13 方案；请使用内置匹配版。':'此版本未验证完整收发，请使用内置匹配版。'):!intact?'客户端文件、架构或腾讯签名不匹配，请修复内置客户端。':!result.nativeReady?'匹配的发送组件未准备完成，请检查内置环境。':'版本、核心文件、腾讯签名及发送组件均匹配。'};
  });
  return {expectedVersion:BUNDLED_WECHAT_VERSION,clients,bundled:clients.find(row=>row.bundled)??null,
    conflict:clients.some(row=>row.running&&!row.bundled),message:'内置匹配版独立保存，不替换系统微信；首次使用仍需登录。其他微信正在运行时，请先保存工作并从其托盘退出。'};
}
export function createClientDetector(root,{scan,now=Date.now}={}){
  let pending,cached,at=0;
  scan??=async()=>{const {stdout}=await execute(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./wechat-clients.ps1',import.meta.url)),'-Root',root],{cwd:root,windowsHide:true,shell:false,env:windowsPowerShellEnvironment(),encoding:'utf8',timeout:20000,maxBuffer:256*1024});return JSON.parse(stdout.replace(/^\uFEFF/,''));};
  return {inspect({force=false}={}){if(pending)return pending;if(!force&&cached&&now()-at<15000)return Promise.resolve(cached);pending=Promise.resolve().then(scan).then(result=>{cached=clientCatalog(result);at=now();return cached;}).finally(()=>{pending=null;});return pending;}};
}
