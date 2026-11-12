import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {directory,atomicJson,json} from '../plugin-api/catalog.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fault=(message,status=400)=>Object.assign(Error(message),{status});
export const VOICE_TUNING_DEFAULTS=Object.freeze({volume:1,bassDb:0,trebleDb:0,normalize:false,trimSilence:false,cfgScale:3,temperature:0,seed:42});
export function validateVoiceProfile(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!/^[a-f0-9]{16}$/.test(value.id??'')||typeof value.name!=='string'||!value.name.trim()||value.name.length>40||!['cute','natural','gentle'].includes(value.baseStyle)||typeof value.instruction!=='string'||value.instruction.length>500||typeof value.referenceText!=='string'||value.referenceText.length>500||!Number.isFinite(value.pitch)||value.pitch<0||value.pitch>5||!Number.isFinite(value.speed)||value.speed<0.75||value.speed>1.25||typeof value.feiyu!=='boolean'||value.referenceId!==undefined&&!/^[a-f0-9]{64}$/.test(value.referenceId))throw fault('音色设置无效，请检查名称、音调和语速。');
 for(const [key,min,max,integer]of [['volume',0.5,1.5],['bassDb',-6,6],['trebleDb',-6,6],['cfgScale',1,5],['temperature',0,1.5],['seed',0,2147483647,true]])if(value[key]!==undefined&&(!Number.isFinite(value[key])||value[key]<min||value[key]>max||integer&&!Number.isInteger(value[key])))throw fault('音色参数超出范围：'+key);
 for(const key of ['normalize','trimSilence'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw fault('音色开关无效：'+key);
 if(value.apiVoice!==undefined&&(typeof value.apiVoice!=='string'||value.apiVoice.length>100||/[\u0000-\u001f\u007f]/.test(value.apiVoice)))throw fault('API音色ID无效。');
 return value;
}
export class CustomVoices{
 constructor(root){this.root=path.resolve(root);}
 account(){const saved=json(path.join(this.root,'state/weflow/active-account.json')),id=saved.id||saved.legacyId;if(!/^[a-f0-9]{64}$/.test(id??''))throw fault('请先连接微信账号，再管理音色。');return id;}
 folder(){return directory(this.root,'state/voice/custom-voices/'+this.account());}
 read(){const file=path.join(this.folder(),'catalog.json');if(!fs.existsSync(file))return {version:1,selected:'',selectedAt:0,random:{enabled:false,choices:[]},voices:[]};if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>100000)throw fault('音色目录异常。');const saved=json(file);if(saved.version!==1||!Array.isArray(saved.voices)||saved.voices.length>40)throw fault('音色目录异常。');saved.voices.forEach(validateVoiceProfile);if(saved.selected&&!saved.voices.some(voice=>voice.id===saved.selected))throw fault('默认音色不存在。');saved.random??={enabled:false,choices:[]};return saved;}
 snapshot(){const data=this.read();return {...data,revision:hash(JSON.stringify(data))};}
 selected(){const file=path.join(this.root,'state/weflow/active-account.json');if(!fs.existsSync(file))return null;const data=this.read();return data.voices.find(voice=>voice.id===data.selected)??null;}
 choose({external=false,randomIndex=crypto.randomInt}={}){const data=this.read(),selected=data.voices.find(voice=>voice.id===data.selected)??null;if(!data.random?.enabled)return {profile:selected};const choices=data.random.choices.flatMap(id=>{if(id.startsWith('builtin:'))return external?[]:[{profile:null,style:id.slice(8)}];const voice=data.voices.find(voice=>voice.id===id);return voice&&(!external||voice.apiVoice)?[{profile:voice,style:voice.baseStyle}]:[];});return choices.length?choices[randomIndex(choices.length)]:{profile:selected};}
 reference(profile){validateVoiceProfile(profile);if(!profile.referenceId)return null;const file=path.join(this.folder(),profile.referenceId+'.wav');if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>1440044)throw fault('参考音频不存在或已变化。');const bytes=fs.readFileSync(file);if(hash(bytes)!==profile.referenceId)throw fault('参考音频校验失败。');return bytes;}
 change(body){
  if(!body||Object.keys(body).some(key=>!['action','revision','id','name','baseStyle','instruction','referenceText','pitch','speed','feiyu','b64','clearReference','apiVoice','enabled','choices',...Object.keys(VOICE_TUNING_DEFAULTS)].includes(key)))throw fault('音色操作参数无效。');
  const data=this.snapshot();if(body.revision!==data.revision)throw fault('音色列表已变化，请刷新后重试。',409);delete data.revision;
  const existing=data.voices.find(voice=>voice.id===body.id);
  if(body.action==='random'){const allowed=new Set(['builtin:cute','builtin:natural','builtin:gentle',...data.voices.map(voice=>voice.id)]);if(typeof body.enabled!=='boolean'||!Array.isArray(body.choices)||body.choices.length>43||body.choices.some(id=>!allowed.has(id))||body.enabled&&!body.choices.length)throw fault('请选择至少一个可随机使用的音色。');data.random={updatedAt:Date.now(),enabled:body.enabled,choices:[...new Set(body.choices)]};}
  else if(body.action==='activate'){if(body.id!==''&&!existing)throw fault('请选择已有音色。');data.selected=body.id;data.selectedAt=Date.now();}
  else if(body.action==='delete'){if(!existing)throw fault('音色不存在。');data.voices=data.voices.filter(voice=>voice.id!==body.id);if(data.random){data.random.choices=data.random.choices.filter(id=>id!==body.id);if(!data.random.choices.length)data.random.enabled=false;}if(data.selected===body.id)data.selected='';}
  else if(body.action==='duplicate'){if(!existing||data.voices.length>=40)throw fault('无法复制音色，最多保存40个。');data.voices.push({...existing,id:crypto.randomBytes(8).toString('hex'),name:(existing.name+' 副本').slice(0,40)});}
  else if(body.action==='save'){
   if(body.id&&!existing)throw fault('音色不存在。');if(!existing&&data.voices.length>=40)throw fault('最多保存40个自定义音色。');
   const voice=validateVoiceProfile({id:existing?.id??crypto.randomBytes(8).toString('hex'),name:body.name,baseStyle:body.baseStyle,instruction:body.instruction,referenceText:body.referenceText,pitch:body.pitch,speed:body.speed,feiyu:body.feiyu,apiVoice:body.apiVoice??existing?.apiVoice??'',...Object.fromEntries(Object.entries(VOICE_TUNING_DEFAULTS).map(([key,value])=>[key,body[key]??existing?.[key]??value])),...(existing?.referenceId&&!body.clearReference?{referenceId:existing.referenceId}:{})});
   if(body.b64!==undefined){if(typeof body.b64!=='string'||body.b64.length>1920060||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.b64))throw fault('请使用1到30秒的参考音频。');const bytes=Buffer.from(body.b64,'base64');if(bytes.length<48044||bytes.length>1440044||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,16).toString()!=='WAVEfmt '||bytes.readUInt32LE(16)!==16||bytes.readUInt16LE(20)!==1||bytes.readUInt16LE(22)!==1||bytes.readUInt32LE(24)!==24000||bytes.readUInt16LE(34)!==16||bytes.subarray(36,40).toString()!=='data'||bytes.readUInt32LE(40)!==bytes.length-44||(bytes.length-44)%2)throw fault('请使用1到30秒的有效参考音频。');voice.referenceId=hash(bytes);const file=path.join(this.folder(),voice.referenceId+'.wav');if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw fault('参考音频位置异常。');fs.writeFileSync(file,bytes,{mode:0o600});}
   if(voice.referenceId&&!voice.referenceText.trim())throw fault('请填写参考音频中实际说出的文字。');data.voices=existing?data.voices.map(item=>item.id===voice.id?voice:item):[...data.voices,voice];
  }else throw fault('音色操作不存在。');
  atomicJson(path.join(this.folder(),'catalog.json'),data);return this.snapshot();
 }
}
