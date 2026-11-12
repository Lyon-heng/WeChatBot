export function parseStickerTags(value) {
  const tags=[...new Set(value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean))];
  if(tags.length>6||tags.some(tag=>tag.length>16))throw Error('标签最多 6 个，每个最多 16 字，用逗号分隔。');
  return tags;
}
export function validateStickerFile(file) {
  if(!file.size||file.size>8*1024*1024)throw Error('每张图片需大于 0 字节且不超过 8 MB。');
  if(!/\.(gif|png|jpe?g|webp)$/i.test(file.name))throw Error('请选择 GIF、PNG、JPG 或 WebP 图片。');
}
async function fileBase64(file) {
  const bytes=new Uint8Array(await file.arrayBuffer());let text='';
  for(let offset=0;offset<bytes.length;offset+=16384)text+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
  return btoa(text);
}
export function createStickerManagerUI({api,modal,closeModal,escapeHtml:esc,icon,state,renderPage,toast}) {
  let pool,query='',generation=0;const thumbnails=new Map();
  const size=bytes=>bytes<1024*1024?Math.ceil(bytes/1024)+' KB':(bytes/1024/1024).toFixed(1)+' MB';
  const itemById=id=>pool?.items.find(item=>item.id===id);
  const requestBody=()=>({scope:pool.scope,revision:pool.revision});
  function cards() {
    const items=pool.items.filter(item=>[item.name,item.description,...item.tags].join(' ').toLowerCase().includes(query.toLowerCase()));
    return items.length?items.map(item=>`<article class="sticker-card"><button class="sticker-picture" data-sticker-preview="${item.id}" aria-label="预览：${esc(item.name)}"><img data-sticker-image="${item.id}" alt="${esc(item.description||item.name)}" width="160" height="160" loading="lazy"><span>${item.animated?'GIF 动图':'静态表情'}</span></button><div class="sticker-card-body"><h3 title="${esc(item.name)}">${esc(item.name)}</h3><p>${item.manual?'手动添加':(item.collectionOrigins??['legacy']).map(source=>({wechat:'微信收集',dsh:'WorkBuddy 图库',legacy:'历史来源未区分'}[source]??'历史来源未区分')).join(' · ')} · ${item.width} × ${item.height} · ${size(item.bytes)}</p><div class="sticker-tags">${item.tags.map(tag=>`<span>${esc(tag)}</span>`).join('')||'<span>可添加标签帮助选图</span>'}</div><div class="sticker-actions"><button class="button small" data-sticker-edit="${item.id}">编辑</button><button class="button small danger" data-sticker-delete="${item.id}" aria-label="删除：${esc(item.name)}">删除</button></div></div></article>`).join(''):
      `<div class="sticker-empty">${icon('image')}<strong>${query?'没有匹配的表情包':'表情池还是空的'}</strong><p>${query?'换个名称或标签试试。':'从本地添加图片，或在允许的聊天中收集表情。'}</p>${query?'':'<button class="button primary" data-sticker-import>添加表情包</button>'}</div>`;
  }
  async function page() {
    let loaded;try{loaded=await api('/api/sticker-manager');}catch(error){pool=null;generation++;thumbnails.clear();return `<section class="card sticker-library"><h2>表情服务暂不可用</h2><p class="card-description">${esc(error.message)}</p><p class="subtle">表情列表、收集和发送依赖微信读取与消息桥接服务。请先启动服务，再刷新列表。</p><div class="button-row"><button class="button primary" data-action="start">一键启动服务</button><button class="button" id="retry-page">刷新列表</button><button class="button" data-sticker-diagnostics>检查表情服务</button></div></section>`;}if(pool?.scope!==loaded.scope)thumbnails.clear();pool=loaded;
    return `<section class="card sticker-library"><div class="sticker-toolbar"><div><h2>账号共享表情池 <span class="status-tag">${pool.count} / ${pool.limit}</span></h2><p class="card-description">管理当前微信账号的表情，供已允许的好友与群聊选用。</p></div><button class="button primary" data-sticker-import>${icon('plus')}添加表情包</button></div><div class="sticker-help"><p>支持 GIF、PNG、JPG、WebP，每张最多 8 MB。动图保留动画；图片会转换为微信发送所需的 GIF。</p><p>手动添加的表情对所有已允许聊天可用；聊天收集的表情沿用共享开关。满 50 张需先删除；后续自动收集的满池评选仍由 DS 选择保留。${pool.waiting?' 当前另有 '+pool.waiting+' 张等待评选。':''}</p></div><div class="field sticker-search"><label for="sticker-search">查找表情</label><input id="sticker-search" type="search" placeholder="搜索名称、描述或标签" value="${esc(query)}"></div><p id="sticker-feedback" class="card-description" role="status"></p><div class="sticker-grid" id="sticker-grid">${cards()}</div></section>`;
  }
  function mount() {
    if(!pool)return;const thisGeneration=++generation;let next=0;
    const images=[...document.querySelectorAll('[data-sticker-image]')];
    const scope=pool?.scope;
    async function run() {
      while(next<images.length&&thisGeneration===generation&&state.page==='stickers') {
        const image=images[next++];
        try {
          const id=image.dataset.stickerImage,key=scope+':'+id;
          if(!thumbnails.has(key)) {
            const pending=api('/api/sticker-manager/image?id='+id+'&scope='+scope).catch(error=>{thumbnails.delete(key);throw error;});
            thumbnails.set(key,pending);while(thumbnails.size>64)thumbnails.delete(thumbnails.keys().next().value);
          }
          const value=await thumbnails.get(key);
          if(thisGeneration===generation&&image.isConnected)image.src='data:'+value.mime+';base64,'+value.base64;
        } catch {
          if(image.isConnected){image.alt='预览暂不可用，点击重试';const feedback=document.querySelector('#sticker-feedback');if(feedback)feedback.textContent='部分预览暂不可用，可点击图片重试或刷新列表。';}
        }
      }
    }
    for(let index=0;index<3;index++)void run();
    document.querySelector('#sticker-search')?.addEventListener('input',event=>{query=event.target.value;document.querySelector('#sticker-grid').innerHTML=cards();mount();},{once:true});
  }
  function importDialog() {
    if(!pool)return;
    const scope=pool.scope;let files=[],busy=false;
    modal('添加表情包',`<form id="sticker-import-form"><p class="modal-description">添加到当前账号的共享池。当前 ${pool.count}/${pool.limit} 张，手动添加不调用模型。</p><div class="field"><label for="sticker-files">选择本地图片（一次最多 20 张）</label><input id="sticker-files" type="file" accept=".gif,.png,.jpg,.jpeg,.webp" multiple required><small>单张最多 8 MB、最多 64 帧、边长不超过 4096 像素。文件名作为默认描述，添加后可以编辑。</small></div><ul id="sticker-import-results" class="sticker-import-results" aria-live="polite"></ul><p id="sticker-form-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button" data-close>关闭</button><button class="button primary" type="submit">开始添加</button></div></form>`,{beforeClose:()=>{if(busy){toast('正在添加图片，请等本次完成。');return false;}return true;}});
    const form=document.querySelector('#sticker-import-form'),input=form.querySelector('#sticker-files'),results=form.querySelector('#sticker-import-results'),error=form.querySelector('#sticker-form-error');
    input.addEventListener('change',()=>{files=[...input.files];error.hidden=true;results.innerHTML=files.map((file,index)=>`<li data-import-row="${index}"><span>${esc(file.name)}</span><small>待添加 · ${size(file.size)}</small></li>`).join('');});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;error.hidden=true;
      try{if(!files.length||files.length>20)throw Error('请选择 1–20 张图片。');for(const file of files)validateStickerFile(file);}
      catch(cause){error.textContent=cause.message;error.hidden=false;return;}
      busy=true;input.disabled=true;const submit=form.querySelector('[type="submit"]');submit.disabled=true;let added=0;
      for(let index=0;index<files.length;index++) {
        const file=files[index],row=results.querySelector(`[data-import-row="${index}"] small`);row.textContent='正在校验并添加…';
        try {
          if(!pool||pool.scope!==scope)throw Error('微信账号或连接已变化，请重新打开添加窗口。');
          const name=file.name.replace(/[\x00-\x1f/\\]/g,'').slice(0,120)||'本地表情';
          pool=await api('/api/sticker-manager/import',{...requestBody(),name,description:name.replace(/\.[^.]+$/,''),tags:[],base64:await fileBase64(file)});
          row.textContent='已添加（重复图片自动合并）';added++;
        } catch(cause) {
          row.textContent='未添加：'+cause.message;
          if([401,409,503].includes(cause.status)||!cause.status){error.textContent='连接或账号状态已变化，本次已暂停；已添加的图片已保存，未处理的图片可稍后重新选择。';error.hidden=false;break;}
        }
      }
      busy=false;input.disabled=false;submit.disabled=false;submit.textContent='重新选择后添加';files=[];input.value='';
      if(added)toast('已处理 '+added+' 张表情，重复图片合并。');
      if(state.page==='stickers')await renderPage();
    });
  }
  function editDialog(id) {
    const item=itemById(id);if(!item)return;const binding=requestBody();let busy=false;
    modal('编辑表情信息',`<form id="sticker-edit-form"><div class="field"><label for="sticker-name">名称</label><input id="sticker-name" maxlength="120" required value="${esc(item.name)}"></div><div class="field"><label for="sticker-description">内容描述</label><input id="sticker-description" maxlength="120" required value="${esc(item.description||item.name)}"><small>简短描述画面和含义，帮助机器人选择合适的表情。</small></div><div class="field"><label for="sticker-tags">标签</label><input id="sticker-tags" value="${esc(item.tags.join('，'))}" placeholder="开心，赞同，打招呼"><small>最多 6 个，每个最多 16 字，用逗号分隔。</small></div><p id="sticker-form-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存信息</button></div></form>`,{beforeClose:()=>!busy});
    const form=document.querySelector('#sticker-edit-form');
    form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const button=form.querySelector('[type="submit"]');button.disabled=true;busy=true;
      try{pool=await api('/api/sticker-manager/edit',{...binding,id,name:form.querySelector('#sticker-name').value,description:form.querySelector('#sticker-description').value,tags:parseStickerTags(form.querySelector('#sticker-tags').value)});busy=false;closeModal();await renderPage();toast('表情信息已保存。');}
      catch(cause){const error=form.querySelector('#sticker-form-error');error.textContent=cause.message;error.hidden=false;}
      finally{busy=false;button.disabled=false;}
    });
  }
  function deleteDialog(id) {
    const item=itemById(id);if(!item)return;const binding=requestBody();let busy=false;
    modal('删除这张表情？',`<p class="modal-description">将从当前账号的共享池移除“${esc(item.name)}”，其他会话也将无法从池中选用。原始图片和微信聊天记录保留；已经开始发送的消息可能继续完成。</p><p class="card-description">删除后不会因同一图片的自动收集立即回到池子。需要时可手动重新导入。</p><p id="sticker-form-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button danger" id="sticker-confirm-delete">确认删除</button></div>`,{beforeClose:()=>!busy});
    document.querySelector('#sticker-confirm-delete').addEventListener('click',async event=>{
      if(busy)return;busy=true;event.currentTarget.disabled=true;
      try{pool=await api('/api/sticker-manager/delete',{...binding,id});busy=false;closeModal();await renderPage();toast('表情已从共享池移除。');}
      catch(cause){busy=false;const error=document.querySelector('#sticker-form-error');if(error){error.textContent=cause.message;error.hidden=false;}event.target.disabled=false;}
    });
  }
  async function preview(id) {
    const item=itemById(id);if(!item)return;
    const scope=pool.scope;let open=true;
    modal('预览表情',`<div class="sticker-full-preview" role="status">正在读取原图…</div><p class="card-description">${esc(item.name)} · ${item.animated?'GIF 动图':'静态表情'}</p>`,{onClose:()=>{open=false;}});
    try{const result=await api('/api/sticker-manager/image?id='+id+'&scope='+scope+'&animated=1');if(open){const target=document.querySelector('.sticker-full-preview');target.innerHTML=`<img alt="${esc(item.description||item.name)}" src="data:${result.mime};base64,${result.base64}">`;}}
    catch(cause){if(open)document.querySelector('.sticker-full-preview').textContent=cause.message;}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-sticker-diagnostics')){button.disabled=true;void api('/api/sticker-diagnostics').then(result=>modal('表情服务检查',`<p class="modal-description">此检查只读取状态，不会向微信发送消息。</p><div class="section-stack">${result.checks.map(check=>`<div class="tool-row"><div><h3>${esc(check.label)}</h3><p>${esc(check.detail)}</p></div><span class="status-tag ${check.ok?'ok':'warning'}">${check.ok?'正常':'需检查'}</span></div>`).join('')}</div>${result.lastError?`<p class="subtle">最近错误：${esc(result.lastError)}</p>`:''}<div class="modal-actions"><button class="button" data-close>关闭</button></div>`)).catch(error=>toast(error.message)).finally(()=>{if(button.isConnected)button.disabled=false;});}
    if(button.hasAttribute('data-sticker-import'))importDialog();
    if(button.dataset.stickerEdit)editDialog(button.dataset.stickerEdit);
    if(button.dataset.stickerDelete)deleteDialog(button.dataset.stickerDelete);
    if(button.dataset.stickerPreview)void preview(button.dataset.stickerPreview);
  });
  return {page,mount};
}

/** 「表情包 → 来源与搜索」：WorkBuddy 本机表情插件的搜索、预览与入库交互 */
export function mountMemeSources({api,escapeHtml:esc,toast}) {
  const $=selector=>document.querySelector(selector);
  const status=$('#meme-source-status'),results=$('#meme-search-results');
  if(!status||!results)return;
  let busy=false;
  const paintStatus=info=>{
    if(!info){status.textContent='表情来源状态暂不可用。';return;}
    const pool=info.pool?`${info.pool.count} / ${info.pool.limit} 张`:'读取服务未连接';
    status.textContent=`本机插件 ${info.pluginEnabled?'已启用':'未启用'} · 共享表情池 ${pool} · 今日已加入 ${info.savesToday}/${info.maxSavesPerDay} 张 · 缓存候选 ${info.candidates} 条${info.available?'':' · '+(info.reason||'表情池服务未就绪')}`;
  };
  const paintCandidates=list=>{
    if(!list.length){results.innerHTML='<p class="card-description">没有取得候选。可以换个关键词或来源，或直接使用图片直链。</p>';return;}
    results.innerHTML=`<div class="tool-row"><h3>搜索候选（${list.length}）</h3><span class="status-tag">图片内容未经查看</span></div>`+list.map((item,index)=>`<article class="tool-row"><div><h3>${esc(item.title)}</h3><p>${esc(item.provider)} · ${esc(item.formatHint)} · 授权 ${esc(item.license)}</p><small>${esc(item.pageUrl)}</small><p id="meme-result-${index}" class="card-description"></p></div><div class="button-row"><a class="button small" href="${esc(item.pageUrl)}" target="_blank" rel="noopener noreferrer">打开来源</a><button class="button small primary" data-meme-save="${esc(item.id)}" data-meme-result="${index}">加入表情池</button></div></article>`).join('');
  };
  const refresh=async()=>{try{paintStatus(await api('/api/extensions/meme-search'));}catch(error){status.textContent=error.message;}};
  void refresh();
  $('#meme-search-submit')?.addEventListener('click',async event=>{
    if(busy)return;
    const query=$('#meme-search-query')?.value.trim()??'';
    if(!query){toast('请输入搜索关键词。');return;}
    busy=true;event.currentTarget.disabled=true;
    results.innerHTML='<p class="card-description">正在搜索公开图片来源…</p>';
    try{
      const provider=$('#meme-search-provider')?.value??'auto',kind=$('#meme-search-kind')?.value??'any';
      const data=await api('/api/extensions/meme-search?query='+encodeURIComponent(query)+'&provider='+encodeURIComponent(provider)+'&kind='+encodeURIComponent(kind));
      if(data.status==='ok')paintCandidates(data.candidates);
      else results.innerHTML=`<p class="card-description">${esc(data.note||'未取得候选。')}${data.retryAfterSeconds?'（'+data.retryAfterSeconds+' 秒后可重试）':''}${data.browseUrl?' <a href="'+esc(data.browseUrl)+'" target="_blank" rel="noopener noreferrer">手动搜索</a>':''}</p>`;
    }catch(error){results.innerHTML=`<p class="card-description">${esc(error.message)}</p>`;}
    finally{busy=false;event.currentTarget.disabled=false;}
  });
  const save=async(payload,button,output)=>{
    if(busy)return;busy=true;button.disabled=true;output.textContent='正在下载并校验图片…';
    try{
      const data=await api('/api/extensions/meme-search',payload);
      output.textContent=`已加入共享表情池（${data.name}，${Math.ceil(data.bytes/1024)} KB）；本页不会发送图片。`;
      toast('已加入表情池。');await refresh();
    }catch(error){output.textContent='未加入：'+error.message;}
    finally{busy=false;button.disabled=false;}
  };
  results.addEventListener('click',event=>{
    const button=event.target.closest('[data-meme-save]');if(!button)return;
    const output=document.querySelector('#meme-result-'+button.dataset.memeResult);
    void save({id:button.dataset.memeSave},button,output);
  });
  $('#meme-direct-submit')?.addEventListener('click',event=>{
    const url=$('#meme-direct-url')?.value.trim()??'';
    if(!url){toast('请粘贴图片直链。');return;}
    const output=$('#meme-search-results');
    output.innerHTML='<p class="card-description" id="meme-direct-result">正在处理…</p>';
    void save({url,name:'网络表情'},event.currentTarget,document.querySelector('#meme-direct-result'));
  });
}
