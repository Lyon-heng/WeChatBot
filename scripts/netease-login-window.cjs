// Isolated official-site sign-in. Only NetEase music cookies leave this window,
// through the caller's encrypted local credential store.
module.exports=function createNeteaseLoginWindow({BrowserWindow,session}){
  let win=null,timer=null,attempt=0;
  const allowed=raw=>{try{const u=new URL(raw);return u.protocol==='https:'&&(u.hostname==='music.163.com'||u.hostname.endsWith('.163.com'))&&!u.username&&!u.password;}catch{return false;}};
  function close(){attempt++;clearTimeout(timer);if(win&&!win.isDestroyed())win.close();win=null;}
  async function open({save,onState}){
    close();const generation=attempt,partition='netease-login-'+require('node:crypto').randomUUID(),authSession=session.fromPartition(partition);
    const current=new BrowserWindow({width:1080,height:780,title:'网易云音乐 · 官方登录',autoHideMenuBar:true,webPreferences:{session:authSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});win=current;
    authSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    current.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    current.webContents.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault();});
    current.webContents.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault();});
    let done=false;
    current.on('closed',()=>{if(generation!==attempt)return;clearTimeout(timer);win=null;if(!done)onState({state:'cancelled'});void authSession.clearStorageData().catch(()=>{});});
    current.webContents.on('did-fail-load',(_e,code)=>{if(code!==-3&&generation===attempt)onState({state:'retrying',error:'NETEASE_OFFICIAL_PAGE_UNAVAILABLE'});});
    async function poll(){if(generation!==attempt||current.isDestroyed())return;try{
      const cookies=await authSession.cookies.get({url:'https://music.163.com/'}),auth=cookies.find(c=>c.name==='MUSIC_U'&&c.value);
      if(auth){onState({state:'saving'});await save(cookies.filter(c=>['MUSIC_U','__csrf','MUSIC_A','NMTID'].includes(c.name)).map(c=>c.name+'='+c.value).join('; '));if(generation!==attempt)return;done=true;onState({state:'logged-in'});current.close();return;}
    }catch{onState({state:'retrying',error:'NETEASE_OFFICIAL_SAVE_FAILED'});}timer=setTimeout(poll,2000);}
    onState({state:'official-window'});await current.loadURL('https://music.163.com/');timer=setTimeout(poll,2000);return {mode:'official-window'};
  }
  return {open,close};
};
