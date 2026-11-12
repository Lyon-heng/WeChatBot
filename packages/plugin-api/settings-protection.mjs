import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const purpose='WeChatBot.plugin-settings.v1';
const failure=()=>Object.assign(Error('无法保护或解密插件设置。请使用原 Windows 账号，保留原配置后重试；程序不会改为明文保存。'),{code:'PLUGIN_SETTINGS_PROTECTION_FAILED',status:503});
export function windowsSettingsProtection(value,mode){
  if(process.platform!=='win32')throw failure();
  const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const result=spawnSync(path.win32.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../netease/credential.ps1',import.meta.url)),mode],{input:value,encoding:'utf8',windowsHide:true,shell:false,env,timeout:10000,maxBuffer:1024*1024,stdio:['pipe','pipe','ignore']});
  if(result.error||result.status!==0||!result.stdout||mode==='protect'&&!/^[A-Za-z0-9+/=]+$/.test(result.stdout))throw failure();
  return result.stdout;
}
export function createSettingsCodec(transform=windowsSettingsProtection){
  const opened=new Map();
  const remember=(cipher,text)=>{if(opened.size>=32)opened.delete(opened.keys().next().value);opened.set(cipher,text);};
  const table=config=>Object.fromEntries(Object.entries(config.plugins).map(([id,record])=>[id,record.settings??{}]));
  function decode(config){
    if(config.version===1){if(config.protectedSettings!==undefined)throw failure();return structuredClone(config);}
    try{
      const envelope=config.protectedSettings;
      if(config.version!==2||!envelope||envelope.scheme!=='windows-dpapi-current-user-v1'||typeof envelope.data!=='string'||envelope.data.length>800000)throw failure();
      let text=opened.get(envelope.data);if(text===undefined){text=transform(envelope.data,'unprotect');remember(envelope.data,text);}
      const data=JSON.parse(text);
      if(data.purpose!==purpose||!data.settings||typeof data.settings!=='object'||Array.isArray(data.settings))throw failure();
      const result=structuredClone(config);
      for(const [id,record]of Object.entries(result.plugins)){
        if(!Object.hasOwn(data.settings,id)||!data.settings[id]||typeof data.settings[id]!=='object'||Array.isArray(data.settings[id]))throw failure();
        if(record.settings&&Object.keys(record.settings).length)throw failure();
        record.settings=data.settings[id];
      }
      if(Object.keys(data.settings).length!==Object.keys(result.plugins).length)throw failure();
      return result;
    }catch{throw failure();}
  }
  function encode(config){
    try{
      const result=structuredClone(config),text=JSON.stringify({purpose,settings:table(config)});
      let cipher=result.protectedSettings?.data;
      if(!cipher||opened.get(cipher)!==text){cipher=transform(text,'protect');remember(cipher,text);}
      result.version=2;result.protectedSettings={scheme:'windows-dpapi-current-user-v1',data:cipher};
      for(const record of Object.values(result.plugins))record.settings={};
      return result;
    }catch{throw failure();}
  }
  return {decode,encode};
}
export const settingsCodec=createSettingsCodec();
