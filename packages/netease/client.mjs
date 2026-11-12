import fs from 'node:fs';
import {directory} from '../plugin-api/catalog.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import https from 'node:https';
import {Readable} from 'node:stream';
// NetEase's web request format; protocol reference: api-enhanced/module and util/crypto.js.
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const routes=new Set(['/api/login/qrcode/unikey','/api/login/qrcode/client/login','/api/w/nuser/account/get','/api/cloudsearch/pc','/api/song/detail','/api/song/enhance/player/url','/api/song/enhance/player/url/v1']);
const fault=code=>Object.assign(Error(code),{code,status:400});
// Keep authentication response headers in Node's server-side HTTP layer.
// Chromium-backed fetch implementations may filter Set-Cookie from Headers.
export function neteaseFetch(url,options){return new Promise((resolve,reject)=>{
  const target=new URL(url);if(target.protocol!=='https:'||target.hostname!=='music.163.com'||target.port||target.username||target.password){reject(fault('NETEASE_ENDPOINT_BLOCKED'));return;}
  const req=https.request(target,{method:options.method,headers:options.headers,signal:options.signal},res=>{
    const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);
    resolve(new Response(Readable.toWeb(res),{status:res.statusCode,headers}));
  });req.on('error',reject);req.end(options.body);
});}
const clean=v=>String(v??'').replace(/[\u0000-\u001f<>]/g,'').slice(0,100);
// Some desktop fetch implementations expose one combined Set-Cookie header.
// Split on cookie names, never on the comma inside an Expires date.
export function sessionCookies(...values){
  const jar=new Map();
  for(const value of values.flat())for(const part of String(value??'').split(/;\s*|,(?=\s*[\w-]+=)/)){
    const match=/^\s*(MUSIC_U|__csrf|NMTID|MUSIC_A)=([^;\r\n,]*)/.exec(part);
    if(match){if(match[2])jar.set(match[1],match[2]);else jar.delete(match[1]);}
  }
  return [...jar].map(([key,value])=>key+'='+value).join('; ');
}
export function webBody(data){
  const secret=crypto.randomBytes(8).toString('hex'),aes=(text,key)=>{const cipher=crypto.createCipheriv('aes-128-cbc',Buffer.from(key),Buffer.from('0102030405060708'));return Buffer.concat([cipher.update(text,'utf8'),cipher.final()]).toString('base64');};
  const block=Buffer.alloc(128);Buffer.from([...secret].reverse().join('')).copy(block,112);
  return new URLSearchParams({params:aes(aes(JSON.stringify(data),'0CoJUm6Qyw8W8jud'),secret),encSecKey:crypto.publicEncrypt({key:PUBLIC_KEY,padding:crypto.constants.RSA_NO_PADDING},block).toString('hex')}).toString();
}
export async function protectCredential(value,mode='protect'){
  if(process.platform!=='win32')throw fault('NETEASE_SECURE_STORAGE_UNAVAILABLE');
  return new Promise((resolve,reject)=>{
    const child=spawn(path.win32.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./credential.ps1',import.meta.url)),mode],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let result='';const timer=setTimeout(()=>{child.kill();reject(fault('NETEASE_SECURE_STORAGE_UNAVAILABLE'));},10000);
    child.stdout.on('data',chunk=>{result+=chunk;if(result.length>65536)child.kill();});
    child.once('error',()=>{clearTimeout(timer);reject(fault('NETEASE_SECURE_STORAGE_UNAVAILABLE'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(result):reject(fault('NETEASE_SECURE_STORAGE_UNAVAILABLE'));});child.stdin.on('error',()=>{});child.stdin.end(value);
  });
}
export function createNeteaseClient(root,{fetcher=neteaseFetch,protect=protectCredential,now=Date.now}={}){
  const file=root?path.join(directory(root,'state/netease'),'session.json'):null;
  let loadedStamp='',credential='',qr=null,lastCheck=0,checking=null,epoch=0,lastLogin={state:'idle'};
  function stored(){try{if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>65536)return null;const v=JSON.parse(fs.readFileSync(file,'utf8'));return v.version===1&&typeof v.protectedCookie==='string'?v:null;}catch{return null;}}
  async function cookie(){if(!file)return '';const v=stored(),stamp=v?.revision??'';if(stamp!==loadedStamp){credential=v?await protect(v.protectedCookie,'unprotect'):'';loadedStamp=stamp;}return credential;}
  async function request(route,data={}, {signal,cookieOverride}={}){
    if(!routes.has(route))throw fault('NETEASE_ENDPOINT_BLOCKED');
    const auth=cookieOverride??await cookie(),csrf=/(?:^|;\s*)__csrf=([^;]+)/.exec(auth)?.[1]??'';
    let response;try{response=await fetcher('https://music.163.com'+route.replace('/api/','/weapi/')+'?csrf_token='+encodeURIComponent(csrf)+'&timestamp='+now(),{method:'POST',redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(6000)]),headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'Mozilla/5.0','Referer':'https://music.163.com/',...(auth?{Cookie:auth}:{})},body:webBody({...data,csrf_token:csrf})});}catch{throw fault('NETEASE_CONNECTION_FAILED');}
    if(!response.ok){await response.body?.cancel();throw fault('NETEASE_HTTP_'+response.status);}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024){await response.body.cancel().catch(()=>{});throw fault('NETEASE_RESPONSE_INVALID');}chunks.push(Buffer.from(chunk));}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('NETEASE_RESPONSE_INVALID');}
    const cookies=sessionCookies(response.headers.getSetCookie?.()??response.headers.get('set-cookie')??'');
    return {data:result,cookies};
  }
  const status=()=>{const v=stored();return {loggedIn:!!v,verifiedAt:v?.verifiedAt??null,nickname:v?.nickname??'',searchMode:'netease-direct',login:qr&&now()>qr.expiresAt?{state:'expired'}:{...lastLogin}};};
  async function verify(){if(!stored()){if(qr)await checkLogin();if(!stored())return {...status(),valid:false,pending:!!qr};}const before=epoch,{data}=await request('/api/w/nuser/account/get');if(before!==epoch)return status();if(data.code===200&&data.account?.id){const v=stored();if(v){v.nickname=clean(data.profile?.nickname);v.verifiedAt=now();fs.writeFileSync(file,JSON.stringify(v),{mode:0o600});}return {...status(),valid:true};}if([200,301,302].includes(data.code)){if(qr){loadedStamp='';credential='';if(file&&fs.existsSync(file))fs.unlinkSync(file);return {...status(),valid:false,pending:true};}logout();return {...status(),expired:true};}throw fault('NETEASE_LOGIN_VERIFY_FAILED');}
  function logout(){epoch++;qr=null;lastLogin={state:'idle'};loadedStamp='';credential='';if(file&&fs.existsSync(file))fs.unlinkSync(file);return status();}
  async function startLogin(){
    const before=++epoch,{data,cookies}=await request('/api/login/qrcode/unikey',{type:3},{cookieOverride:''});
    if(before!==epoch)throw fault('NETEASE_LOGIN_CANCELLED');if(data.code!==200||typeof data.unikey!=='string'||!/^[\w-]{8,256}$/.test(data.unikey))throw fault('NETEASE_QR_UNAVAILABLE');
    qr={key:data.unikey,cookies,expiresAt:now()+180000,epoch:before};lastLogin={state:'waiting',expiresAt:qr.expiresAt};lastCheck=0;
    return {url:'https://music.163.com/login?codekey='+encodeURIComponent(qr.key),expiresAt:qr.expiresAt};
  }
  function cancelLogin(){epoch++;qr=null;lastLogin={state:'cancelled'};return {...lastLogin};}
  async function checkLogin(){
    if(!qr||now()>qr.expiresAt)return stored()?{state:'logged-in',...status()}:{state:'expired'};
    if(checking)return checking;if(now()-lastCheck<2500)return {...lastLogin};lastCheck=now();
    const current=qr;
    checking=(async()=>{const {data,cookies}=await request('/api/login/qrcode/client/login',{key:current.key,type:3},{cookieOverride:current.cookies});
      if(qr!==current||current.epoch!==epoch)return {state:'expired'};
      current.cookies=sessionCookies(current.cookies,cookies);
      lastLogin={state:({800:'expired',801:'waiting',802:'confirm',803:'saving'})[data.code]??'retrying',expiresAt:current.expiresAt,upstreamCode:Number.isInteger(data.code)?data.code:null};
      if(data.code===800){qr=null;return {...lastLogin};}if(data.code===801||data.code===802)return {...lastLogin};
      if(data.code!==803)throw fault('NETEASE_LOGIN_FAILED');
      if(!/(?:^|;\s*)MUSIC_U=/.test(current.cookies))throw fault('NETEASE_LOGIN_COOKIE_MISSING');
      const protectedCookie=await protect(current.cookies,'protect');if(qr!==current||current.epoch!==epoch)return {state:'expired'};
      fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw fault('NETEASE_SECURE_STORAGE_UNAVAILABLE');
      const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,revision:crypto.randomUUID(),protectedCookie,nickname:'网易云用户',verifiedAt:null}),{mode:0o600});fs.renameSync(tmp,file);qr=null;loadedStamp='';lastLogin={state:'logged-in'};return {state:'logged-in',...status()};
    })().catch(error=>{if(qr===current)lastLogin={...lastLogin,state:'retrying',error:/^NETEASE_[A-Z_0-9]+$/.test(error.code??'')?error.code:'NETEASE_LOGIN_FAILED'};throw error;}).finally(()=>{checking=null;});return checking;
  }
  async function saveOfficialCookies(value){const before=epoch;const cookies=sessionCookies(value);if(!/(?:^|;\s*)MUSIC_U=/.test(cookies))throw fault('NETEASE_LOGIN_COOKIE_MISSING');const protectedCookie=await protect(cookies,'protect');if(before!==epoch)throw fault('NETEASE_LOGIN_CANCELLED');const tmp=file+'.'+crypto.randomUUID()+'.tmp';if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw fault('NETEASE_SECURE_STORAGE_UNAVAILABLE');fs.writeFileSync(tmp,JSON.stringify({version:1,revision:crypto.randomUUID(),protectedCookie,nickname:'网易云用户',verifiedAt:null}),{mode:0o600});fs.renameSync(tmp,file);qr=null;loadedStamp='';lastLogin={state:'logged-in'};return status();}
  async function search(query,limit=5,{signal}={}){if(typeof query!=='string'||!query.trim()||query.length>100||!Number.isInteger(limit)||limit<1||limit>20)throw fault('NETEASE_SEARCH_INVALID');const {data}=await request('/api/cloudsearch/pc',{s:query.trim(),type:1,limit,offset:0,total:true},{signal});if(data.code!==200||!Array.isArray(data.result?.songs))throw fault('SONG_SEARCH_UNAVAILABLE');return data.result.songs;}
  return {request,status,verify,logout,startLogin,checkLogin,cancelLogin,saveOfficialCookies,search};
}
