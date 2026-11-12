export function startUpdateUI({api,toast}) {
  const button=document.querySelector('#check-updates'),banner=document.querySelector('#update-banner');
  if(!button||!banner)return;
  const repository='https://github.com/Lyon-heng/WeChatBot';
  const openRepository=url=>{
    const target=url||repository;
    try{if(window.desktop?.openExternal)return void window.desktop.openExternal(target);}catch{}
    window.open(target,'_blank','noopener,noreferrer');
  };
  const show=result=>{
    if(result.status!=='available')return;
    document.querySelector('#update-message').textContent='发现 '+result.latestVersion+(result.sameVersionBuild?' 的更新构建':' 新版本')+'，可下载后运行安装包更新。';
    document.querySelector('#update-download').href=result.downloadUrl;
    document.querySelector('#update-notes').href=result.releaseUrl;
    banner.hidden=false;
  };
  const check=async manual=>{
    button.disabled=true;
    try{const result=await api(manual?'/api/updates/check':'/api/updates',manual?{}:undefined);show(result);
      if(!manual)return;
      if(result.status==='not_published'){toast('GitHub 项目里还没有发布版本，已为你打开项目页。');openRepository(result.repositoryUrl);}
      else if(result.status==='available')toast('发现更新，下载入口已显示。');
      else if(result.status==='up_to_date')toast('当前已是最新版本。');
      else toast('暂时无法连接更新服务，请稍后再试。');
    }catch{if(manual)toast('更新检查暂时不可用，请稍后再试。');}
    finally{button.disabled=false;}
  };
  button.addEventListener('click',()=>check(true));
  document.querySelector('#dismiss-update').addEventListener('click',()=>{banner.hidden=true;});
  void check(false);
}
