import {pluginCategory,DEFAULT_CATEGORIES} from './interface-model.mjs';
import {pluginCard} from './plugins.js';
export function createExtensionMarket({api,modal,toast,escapeHtml:esc,icon}){
  let query='',category='all',filter='all',items=[],memeStatus={available:false},runtimeConnected=false;
  let preferences={categories:DEFAULT_CATEGORIES,assignments:{}};
  let groups=[['all','全部'],['custom','本机插件'],['network','联网与阅读'],['media','表情与素材'],['chat','聊天与会话'],['dsh','WorkBuddy 插件']];
  const emptyMarkup='<div class="extension-empty"><h3>没有匹配的能力</h3><p>换个关键词，或调整分类和状态筛选。</p><button class="button" data-extension-reset>清除筛选</button></div>';
  const group=item=>item.management==='wechatagent'?'pc-'+pluginCategory(item.id,preferences):item.id==='native-stickers'?'media':['native-search','native-web-reader'].includes(item.id)?'network':'chat';
  const installed=item=>!item.requiresInstall||memeStatus.available===true;
  const shown=()=>items.filter(item=>(category==='all'||category==='custom'&&item.management==='wechatagent'||category==='dsh'&&item.requiresInstall||category===group(item))&&(filter==='all'||filter==='installed'&&installed(item)||filter==='enabled'&&(item.management==='wechatagent'?item.enabled:item.featureState?.effectiveCount>0)||filter==='disabled'&&!item.enabled)&&[item.name,item.description,item.author,item.id].join(' ').toLowerCase().includes(query.toLowerCase().trim()));
  function card(item){
    if(item.management==='wechatagent')return pluginCard({...item,uiCategoryName:preferences.categories.find(c=>c.id===pluginCategory(item.id,preferences))?.name},esc,icon);
    const ready=installed(item),effective=item.featureState?.effectiveCount??0,total=item.featureState?.totalCount??0;
    const label=item.requiresInstall&&!ready?(memeStatus.reason==='DSH_PLUGIN_UNAVAILABLE'?(runtimeConnected?'外部插件未就绪':'未检测到外部插件'):'未检测到插件'):item.statusLabel;
    const tone=item.requiresInstall&&!ready?'warn':item.statusTone;
    const repository=item.repository??'https://github.com/Lyon-heng/wechatwb';
    return `<article class="extension-tile" data-extension-card="${esc(item.id)}"><div class="extension-tile-top"><div class="extension-tile-heading"><h2><button class="extension-title" data-extension="${esc(item.id)}">${esc(item.name)}</button></h2><a class="extension-source-link" href="${esc(repository)}" target="_blank" rel="noopener noreferrer" aria-label="查看 ${esc(item.name)} 项目">${icon('arrow')}</a></div><button class="button extension-card-action ${item.requiresInstall&&!ready?'primary':''}" ${item.requiresInstall&&!ready?'data-meme-guide':`data-extension="${esc(item.id)}"`}>${item.requiresInstall&&!ready?'查看替代方案':'配置'}</button></div><p class="extension-byline">${icon(item.requiresInstall?'plug':'shield')}<span>${esc(item.author??'WeChatBot')} · ${item.requiresInstall?'外部可选插件':'内置能力'}</span></p><p class="extension-card-state"><span class="status-tag ${esc(tone??'')}">${esc(label??'已关闭')}</span><span>${effective} / ${total} 个聊天${item.requiresInstall&&!ready?'已配置':'开启'}</span></p><p class="extension-card-description">${esc(item.description)}</p><div class="extension-card-tags"><span>${groups.find(([id])=>id===group(item))?.[1]??'功能'}</span><span>${item.requiresInstall?'需外部插件宿主':'项目内置'}</span></div>${item.requiresInstall?'<footer class="extension-card-footer"><button class="text-link" data-meme-guide>安装说明</button></footer>':''}</article>`;
  }
  function paint(){
    const grid=document.querySelector('#extension-grid');if(!grid)return;const selected=shown();
    grid.innerHTML=selected.map(card).join('')||emptyMarkup;
    document.querySelector('#extension-result-count').textContent=`显示 ${selected.length} 项，共 ${items.length} 项`;
    document.querySelectorAll('[data-extension-category]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.extensionCategory===category)));
  }
  async function page(catalog,overview){
    preferences=await api('/api/interface-preferences');groups=[['all','全部'],['custom','全部本机插件'],...preferences.categories.map(c=>['pc-'+c.id,c.name]),['network','联网与阅读'],['media','表情与素材'],['chat','内置能力'],['dsh','WorkBuddy 插件']];if(!groups.some(([id])=>id===category))category='all';
    items=[...(catalog.plugins??[]),...catalog.extensions];runtimeConnected=!!catalog.runtimeConnected;try{memeStatus=await api('/api/meme-library-status');}catch{memeStatus={available:false,reason:'DSH_PLUGIN_UNAVAILABLE'};}
    const markup=`<section class="extension-market" aria-label="能力目录"><div class="extension-search-row"><label class="extension-search">${icon('search')}<input id="extension-search" type="search" value="${esc(query)}" placeholder="搜索能力，例如：联网、表情、上下文…" aria-label="搜索能力"></label><select id="extension-status-filter" aria-label="筛选能力状态">${[['all','全部状态'],['installed','已具备'],['enabled','聊天已开启'],['disabled','已关闭']].map(([value,label])=>`<option value="${value}" ${filter===value?'selected':''}>${label}</option>`).join('')}</select></div><button class="button small" data-plugin-categories>管理插件分类</button><nav class="extension-category-tabs" aria-label="能力分类">${groups.map(([value,label])=>`<button data-extension-category="${value}" aria-pressed="${value===category}">${label}${value==='all'?' ('+items.length+')':''}</button>`).join('')}</nav><div class="extension-market-meta"><span id="extension-result-count">显示 ${shown().length} 项，共 ${items.length} 项</span><span>${catalog.runtimeConnected?'WorkBuddy 已连接':'插件宿主未连接'} · 开关按聊天生效</span></div><div class="extension-card-grid" id="extension-grid">${shown().map(card).join('')||emptyMarkup}</div><details class="extension-help"><summary>WorkBuddy 能力与会话授权</summary>${overview}</details></section>`;
    return markup;
  }
  function guide(){
    modal('表情包来源与搜索',`<div class="meme-install-guide"><p class="modal-description">本机已内置「WorkBuddy 表情包来源与搜索」插件，不依赖外部插件宿主。WorkBuddy 云端模型只决定何时搜、搜什么、要不要入库，搜索与图片处理都在本机完成。</p><ol><li><strong>启用插件</strong><p>在「能力」目录找到「WorkBuddy 表情包来源与搜索」，启用并为需要的聊天分配范围。search / save / status 三个工具只对已授权聊天开放。</p></li><li><strong>搜索与加入</strong><p>进入「表情包 → 来源与搜索」，输入简短关键词搜索公开图片页；也可以直接粘贴 HTTPS 图片直链。图片经格式、文件头与 8 MB 大小校验后写入账号共享表情池（最多 50 张，每天最多自动加入 12 张）。</p></li><li><strong>发送</strong><p>保持「表情发送」开启。入池图片会在后续聊天轮次进入候选，由模型按名称与标签文本挑选，再经微信原生表情链路发送；搜索或入库的当轮不会发送图片。</p></li></ol><div class="notice plain">${icon('info')}<span>WorkBuddy 云端模型没有视觉能力，不能看图；搜索标题来自公开网页、未经内容审查，请自行确认后再加入表情池。本机不需要安装外部图库插件。</span></div><p id="meme-connection-check" role="status" aria-live="polite" class="meme-connection-check"></p><div class="button-row"><button class="button" data-meme-check>检查本机插件状态</button><a class="button" href="#stickers/sources">打开来源与搜索</a></div><p class="subtle space-top">图片来源受公开网站可用性影响；Bing 图片页为默认来源，Openverse 与 Imgflip 在部分网络环境可能超时。</p></div>`);
  }
  document.addEventListener('input',event=>{if(event.target.id==='extension-search'){query=event.target.value;paint();}});
  document.addEventListener('change',event=>{if(event.target.id==='extension-status-filter'){filter=event.target.value;paint();}});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.extensionCategory){category=button.dataset.extensionCategory;paint();}
    if(button.hasAttribute('data-extension-reset')){query='';category='all';filter='all';document.querySelector('#extension-search').value='';document.querySelector('#extension-status-filter').value='all';paint();}
    if(button.hasAttribute('data-meme-guide'))guide();
    if(button.hasAttribute('data-meme-check')){button.disabled=true;const field=document.querySelector('#meme-connection-check');try{const result=await api('/api/extensions/meme-search');if(field)field.textContent=result.pluginEnabled?`本机插件已启用 · 共享表情池 ${result.pool?result.pool.count+' / '+result.pool.limit+' 张':'读取服务未连接'} · 今日加入 ${result.savesToday} 张。`:'本机插件尚未启用，请到「能力」目录启用并分配聊天。';}catch(error){if(field)field.textContent='状态检查失败：'+error.message;}finally{button.disabled=false;}}
  });
  return {page,guide};
}
