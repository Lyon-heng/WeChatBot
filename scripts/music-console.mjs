import {MusicLibrary} from '../packages/voice-studio/library.mjs';
import {createNeteaseClient} from '../packages/netease/client.mjs';
import {readSendingMode} from '../packages/wechat-send-policy.mjs';
import {VoiceJobs} from '../packages/voice-studio/jobs.mjs';
import {songById} from '../packages/voice-studio/music.mjs';
const fail=message=>Object.assign(Error(message),{status:400});
export function createMusicConsole(root,{client=createNeteaseClient(root),officialLogin}={}){
  let loginTimer,officialState={state:'idle'};
  function watchLogin(){clearTimeout(loginTimer);loginTimer=setTimeout(async()=>{try{await client.checkLogin();}catch{}if(['waiting','confirm','retrying','saving'].includes(client.status().login?.state))watchLogin();},3000);loginTimer.unref?.();}
  return {
    snapshot:()=>({sendingMode:readSendingMode(root),account:{...client.status(),...(officialState.state!=='idle'&&!client.status().loggedIn?{login:officialState}:{})},officialLoginAvailable:!!officialLogin,songs:new MusicLibrary(root).list()}),
    async action(action,body={}){
      try{
      if(action==='official-login'){
        if(!officialLogin)throw fail('请在桌面程序中使用网易云官方窗口登录。');
        clearTimeout(loginTimer);client.cancelLogin();
        return await officialLogin.open({save:value=>client.saveOfficialCookies(value),onState:state=>{officialState=state;if(state.state==='cancelled')client.cancelLogin();}});
      }
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['query','id'].includes(k)))throw fail('音乐请求无效。');
      if(action==='login'){const {default:qrcode}=await import('../vendor/netease-qr/qrcode.cjs'),value=await client.startLogin(),qr=qrcode(0,'M');qr.addData(value.url);qr.make();watchLogin();return {expiresAt:value.expiresAt,qrImage:'data:image/svg+xml;base64,'+Buffer.from(qr.createSvgTag(5,12)).toString('base64')};}
      if(action==='check')return client.checkLogin();
      if(action==='verify')return client.verify();
      if(action==='cancel'){clearTimeout(loginTimer);officialLogin?.close();officialState={state:'idle'};return client.cancelLogin();}
      if(action==='logout'){clearTimeout(loginTimer);officialLogin?.close();officialState={state:'idle'};return client.logout();}
      if(action==='check-song'){
        if(typeof body.id!=='string'||!/^\d{1,16}$/.test(body.id))throw fail('请选择搜索结果中的歌曲。');
        try{const track=await songById(body.id,{neteaseClient:client});return {id:track.id,playable:true,message:'已取得完整音源，可在聊天里点唱。'};}
        catch(error){const messages={SONG_LOGIN_REQUIRED:'已找到这首歌，需先登录网易云，再检查账号是否可读取。',SONG_TRIAL_ONLY:'网易云仅返回试听片段，暂不能制作翻唱。',SONG_ACCOUNT_AUDIO_UNAVAILABLE:'当前账号未取得完整音源，可能受会员、版权或地区限制。',SONG_PUBLIC_AUDIO_UNAVAILABLE:'网易云未返回可用完整音源。'};if(messages[error.code])return {id:body.id,playable:false,reason:error.code,message:messages[error.code]};throw error;}
      }
      if(action==='search'){
        const songs=await client.search(body.query,15);
        return {source:'netease-direct',items:songs.filter(s=>Number.isSafeInteger(s.id)&&s.id>0).map(s=>({id:String(s.id),title:String(s.name??'').slice(0,150),artist:(s.ar??s.artists??[]).map(a=>String(a.name??'').slice(0,80)).join(' / '),album:String((s.al??s.album)?.name??'').slice(0,150),durationSeconds:Number(s.dt??s.duration??0)/1000,url:'https://music.163.com/song?id='+s.id}))};
      }
      throw fail('音乐操作不存在。');
      }catch(error){if(/^(NETEASE|SONG)_[A-Z0-9_]+$/.test(error.code??'')){error.status=400;throw error;}if(error.status)throw error;throw fail('音乐操作失败，请稍后重试。');}
    }
  };
}
