export function createFishNotebookUI({api,state,escapeHtml:esc,icon,renderPage,toast,onSave}){
  let selected='',offset=0,snapshot,busy=false;
  const name=chat=>state.names.get(chat.key)||(chat.kind==='groups'?'群聊':'好友')+' · '+chat.id.slice(-4);
  const download='<a class="button" href="/plugin-packages/fish-notebook.zip" download="fish-notebook-1.0.0.zip">下载鱼的记事本 ZIP</a>';
  async function page(){
    snapshot=await api('/api/fish-notebook?offset='+offset+(selected?'&conversationKey='+encodeURIComponent(selected):''));selected=snapshot.conversationKey??'';
    if(!snapshot.available)return `<section class="card"><h2>鱼的小本本还没准备好</h2><p>${esc(snapshot.message)}</p><div class="button-row"><a class="button" href="#settings/connections">连接微信</a>${download}</div></section>`;
    const settings=snapshot.settings,options=snapshot.chats.map(chat=>`<option value="${esc(chat.key)}" ${chat.key===selected?'selected':''}>${esc(name(chat))}</option>`).join('');
    const toolbar=`<div class="notebook-toolbar"><div class="field"><label for="notebook-chat">选择聊天的小本本</label><select id="notebook-chat" ${snapshot.chats.length?'':'disabled'}>${options||'<option>尚无允许的聊天</option>'}</select></div><div class="button-row"><button class="button" data-notebook-refresh>${icon('refresh')}刷新</button><button class="button primary" data-notebook-write ${snapshot.effectiveEnabled&&!busy?'':'disabled'}>${icon('plus')}写下今天</button></div></div>`;
    const controls=`<section class="card notebook-settings"><h2>鱼的记事本插件</h2><p id="notebook-enabled" class="subtle">${snapshot.installed?settings.enabled?'插件已开启，按已分配的聊天生效。':'插件当前关闭，已有日记仍可查看。':'记事本已拆为可选 ZIP 插件，安装后再选择权限和聊天。已有日记继续保留。'}</p><p>晚间整理时间（北京时间）：${esc(settings.writeTime)}</p><div class="button-row">${snapshot.installed?'<button class="button" data-plugin-settings="fish-notebook">配置插件</button>':download+'<a class="button" href="#extensions/catalog">前往安装插件</a>'}</div><p class="subtle">模型按当前人格写日记，会使用模型额度。开关、时间和聊天范围统一在插件配置中设置。</p><p id="notebook-error" class="inline-error" role="alert"></p><details><summary>微信怎么翻小本本</summary><p>发送“看看你的日记”等询问。前两次由模型按人设害羞回应，第三次分享当天日记；之后可直接看。</p><p>按账号、聊天、人设、日期及询问者分别计数。前端查看不计数。关闭或卸载保留旧日记。</p><p>提前写成后当晚不重复生成；没有当天聊天时不自动写，也不会主动将日记发送到微信。</p></details></section>`;
    const entries=snapshot.entries.map(entry=>`<article class="notebook-paper"><header><time>${esc(entry.date)}</time><h2>${esc(entry.personaName)}的小本本</h2><p>写于 ${new Date(entry.createdAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false})} · ${entry.sourceCount} 条当天聊天片段</p></header><div class="notebook-prose">${esc(entry.text)}</div><footer>以人设视角记录的心情与联想，事件依据有限聊天记录。</footer></article>`).join('')||'<section class="notebook-paper notebook-empty"><span class="notebook-date">今天这一页</span><h2>这页还空着</h2><p>安装并启用插件后，有聊天记录的日子会在晚间写下。也可以在微信问起，或点击“写下今天”。</p></section>';
    const paging=snapshot.total>12?`<div class="memory-pagination"><span>${snapshot.total} 篇日记 · 第 ${Math.floor(offset/12)+1} 页</span><div class="button-row"><button class="button" data-notebook-page="-1" ${offset===0?'disabled':''}>上一页</button><button class="button" data-notebook-page="1" ${offset+12>=snapshot.total?'disabled':''}>下一页</button></div></div>`:'';
    return `<div class="section-stack fish-notebook">${toolbar}${!settings.enabled?'<p class="scope-note">插件未启用。已保存日记仍可查看。</p>':''}${snapshot.errors?'<p class="inline-error" role="alert">部分日记暂时无法读取，原文件已保留。</p>':''}<div class="notebook-layout">${controls}<div class="section-stack notebook-pages">${entries}${paging}</div></div></div>`;
  }
  const fail=error=>{const target=document.getElementById('notebook-error');if(target)target.textContent=error.message;else toast(error.message);};
  function mount(){document.getElementById('notebook-chat')?.addEventListener('change',event=>{selected=event.target.value;offset=0;void renderPage();});}
  function click(button){
    if(button.hasAttribute('data-notebook-refresh')){void renderPage();return true;}
    if(button.dataset.notebookPage){offset=Math.max(0,offset+Number(button.dataset.notebookPage)*12);void renderPage();return true;}
    if(button.hasAttribute('data-notebook-write')){if(busy)return true;busy=true;button.disabled=true;button.textContent='正在写下今天…';void api('/api/fish-notebook/write',{scope:snapshot.accountScope,key:selected}).then(()=>{busy=false;toast('今天的日记已保存');return renderPage();}).catch(fail).finally(()=>{busy=false;button.disabled=!snapshot.effectiveEnabled;button.textContent='写下今天';});return true;}
    return false;
  }
  return {page,mount,click};
}
