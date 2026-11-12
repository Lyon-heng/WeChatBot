/**
 * WeChatBot — WorkBuddy 工作空间选择（原「工作区分组」）
 *
 * 列表来自本机 WorkBuddy（workbuddy.db 的 workspaces / sessions），
 * 微信端不再自建、改名或删除工作空间，只负责为每个聊天指定在哪个工作空间进行。
 * 选择写进 state/workbuddy-workspaces.json，下一条消息立即生效，无需重启。
 */
export function createSessionGroupUI({api,modal,closeModal,escapeHtml:esc,icon,renderPage,toast,query=s=>document.querySelector(s)}) {
  let data={available:false,groups:[],assignments:{},defaultId:null,stale:{},message:'正在读取 WorkBuddy 工作空间…'},sessions=[],keys=[],selected='all',refreshing=false,applyingDefault=false;

  const groupId = key => sessions.find(item=>item.conversationKey===key)?.groupId ?? data.assignments?.[key] ?? null;
  const groupOf = id => (data.groups??[]).find(group=>group.id===id)??null;
  const defaultGroup = () => groupOf(data.defaultId);
  const effectiveGroup = key => groupOf(groupId(key)??data.defaultId);
  const short = (value, limit=64) => String(value??'').length>limit?String(value).slice(0,limit-1)+'…':String(value??'');
  const dateText = value => {try{return new Date(Number(value)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}catch{return '';}};

  function prepare(value,items,allowed) {
    data=value&&typeof value==='object'?value:{available:false,groups:[],assignments:{},stale:{},message:'工作空间列表暂不可用。'};
    data.groups??=[];data.assignments??={};data.stale??={};
    // 旧进程仍返回 DSH 分组的 503 降级结果，此时明确提示重启而不是误报「没有工作空间」。
    if(!data.workbuddy&&!data.available)data.message='当前运行的还是旧版服务，请重启 WeChatBot.exe 后再读取 WorkBuddy 工作空间。';
    sessions=items??[];keys=[...allowed];
    if(!['all','unassigned',...data.groups.map(group=>group.id)].includes(selected))selected='all';
  }
  function visible(key) {if(selected==='all')return true;return selected==='unassigned'?!groupId(key):groupId(key)===selected;}
  function countOf(id) {return keys.filter(key=>id==='all'||id==='unassigned'&&!groupId(key)||groupId(key)===id).length;}

  function defaultOptions() {
    const current=data.defaultId??'__none__';
    return [`<option value="__none__" ${current==='__none__'?'selected':''}>不指定（不使用工作空间）</option>`,
      ...data.groups.map(group=>`<option value="${esc(group.id)}" ${current===group.id?'selected':''}>${esc(group.title)}${group.exists?'':' · 目录不可访问'}</option>`)].join('');
  }

  function toolbar() {
    if(!data.available)return `<section class="card session-groups"><div class="card-header"><div><h2>WorkBuddy 工作空间</h2><p class="card-description">读取本机 WorkBuddy 已打开的工作空间，让每个聊天在指定工作空间进行。</p></div><button class="button" data-session-group-refresh>重新读取</button></div><p class="subtle">${esc(data.message??'暂时没有可用的工作空间。')}</p></section>`;
    const active=groupOf(selected);
    const filters=[{id:'all',title:'全部会话'},{id:'unassigned',title:'跟随默认'},...data.groups];
    const source=data.source==='workbuddy.db'?'WorkBuddy 工作空间数据库':data.source==='sessions-fallback'?'WorkBuddy 会话记录':'WorkBuddy';
    return `<section class="card session-groups"><div class="card-header"><div><h2>WorkBuddy 工作空间</h2><p class="card-description">读取本机 WorkBuddy 工作空间，可为每个聊天指定在哪个工作空间进行；保存后下一条消息立即生效。</p></div><button class="button" data-session-group-refresh>刷新列表</button></div><div class="session-group-default"><label for="wb-default-workspace">默认工作空间</label><select id="wb-default-workspace">${defaultOptions()}</select><button class="button primary" data-session-group-default>应用</button><small>未单独指定的聊天跟随默认；工作空间路径与目录概览会随每轮消息提供给模型。</small></div><nav class="session-group-filters" aria-label="按工作空间筛选会话">${filters.map(group=>`<button class="session-group-filter" data-session-group-filter="${esc(group.id)}" aria-pressed="${selected===group.id}" title="${esc(group.path??'')}">${esc(group.title)}<span>${countOf(group.id)}</span></button>`).join('')}</nav>${active?`<div class="session-group-location"><div><span class="subtle">工作空间目录${active.exists?'':' · 当前不可访问'}</span><p>${esc(active.path)}</p><small class="subtle">${active.lastOpenedAt?'最近打开 '+esc(dateText(active.lastOpenedAt))+' · ':''}${active.sessionCount??0} 个 WorkBuddy 会话</small></div><div class="button-row"><button class="button" data-session-group-default-focus>设为默认</button></div></div>`:''}<p class="session-group-source">已读取 ${data.groups.length} 个工作空间 · 来源：${esc(source)} · ${esc(short(data.home,70))}</p></section>`;
  }

  function control(key) {
    if(!data.available)return '';
    const own=groupOf(groupId(key)),effective=effectiveGroup(key),stale=data.stale?.[key];
    const label=stale?`已失效：${short(stale,40)}`:own?own.title:effective?`跟随默认 · ${effective.title}`:'未设置';
    return `<div class="session-group-membership"><span>工作空间：${esc(label)}</span><button class="button small" data-session-group-move="${esc(key)}">选择工作空间</button></div>`;
  }

  function form(title,markup,onSave,successText) {
    let saving=false;
    modal(title,`<form id="session-group-form">${markup}<p id="session-group-error" class="inline-error" role="alert"></p><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit" id="session-group-submit">保存</button></div></form>`,{beforeClose:()=>!saving});
    const element=query('#session-group-form');
    element.addEventListener('submit',async event=>{
      event.preventDefault();if(saving)return;saving=true;
      const button=query('#session-group-submit');button.disabled=true;button.textContent='正在保存…';
      element.querySelectorAll('input,select,button').forEach(input=>{input.disabled=true;});
      try{const result=await onSave();saving=false;closeModal();await renderPage();toast(typeof successText==='function'?successText(result):successText??'已保存工作空间设置，下一条消息立即生效。');}
      catch(error){query('#session-group-error').textContent=error.message;}
      finally{saving=false;element.querySelectorAll('input,select,button').forEach(input=>{input.disabled=false;});button.textContent='保存';}
    });
    return element;
  }

  function options(current) {
    const d=defaultGroup();
    const head=`<option value="__default__" ${current==='__default__'?'selected':''}>跟随默认${d?`（${esc(d.title)}）`:'（当前未设置，不指定工作空间）'}</option>`;
    return head+data.groups.map(group=>`<option value="${esc(group.id)}" ${current===group.id?'selected':''}>${esc(group.title)} · ${esc(short(group.parent,56))}${group.exists?'':'（目录不可访问）'}</option>`).join('');
  }

  function move(key) {
    if(!data.groups.length){toast('还没有读取到 WorkBuddy 工作空间，请先在 WorkBuddy 中打开一个文件夹，再刷新列表。');return;}
    const current=groupId(key)??'__default__',session=sessions.find(item=>item.conversationKey===key);
    const stale=data.stale?.[key];
    const element=form('选择聊天的工作空间',`<p class="modal-description">${esc(session?.title??key)}</p><label class="field-label" for="session-group-target">在哪个工作空间进行</label><select id="session-group-target">${options(current)}</select><div class="notice plain space-top">选择后，该聊天每轮回复会以所选工作空间为上下文，并把目录路径与顶层内容提供给模型；聊天历史、人格与技能保持不变，切换不需要重启。未单独指定时跟随默认工作空间。</div>${stale?`<p class="inline-error">原工作空间已不在 WorkBuddy 列表中：${esc(short(stale,90))}</p>`:''}<p id="session-group-path-preview" class="card-description"></p>`,()=>api('/api/session-groups/move',{conversationKey:key,groupId:query('#session-group-target').value,expectedSessionId:session?.sessionId??null,confirmed:true}),result=>result?.path?'已切换工作空间，下一条消息立即生效。':'已改为跟随默认工作空间，下一条消息立即生效。');
    const select=element.querySelector('#session-group-target'),preview=element.querySelector('#session-group-path-preview');
    const show=()=>{const chosen=select.value||'__default__',group=groupOf(chosen),d=defaultGroup();preview.textContent=group?`目录：${group.path}`:d&&chosen==='__default__'?`目录：${d.path}`:'当前不指定工作空间，回复不会携带工作空间上下文。';};
    select.addEventListener('change',show);show();
  }

  async function refresh() {
    if(refreshing)return;refreshing=true;
    try{
      const value=await api('/api/session-groups?refresh=1');
      prepare(value,sessions,keys);await renderPage();
      toast(value.available?`已重新读取 ${value.groups?.length??0} 个 WorkBuddy 工作空间。`:value.workbuddy?'仍未读取到 WorkBuddy 工作空间，请确认已在 WorkBuddy 中打开过文件夹。':'当前是旧版服务，请重启 WeChatBot.exe 后再试。');
    }catch(error){toast('刷新失败：'+error.message);}
    finally{refreshing=false;}
  }

  async function applyDefault(value) {
    if(applyingDefault)return;applyingDefault=true;
    try{
      await api('/api/workbuddy-workspaces/default',{workspaceId:value});
      prepare(await api('/api/session-groups'),sessions,keys);await renderPage();
      toast(value==='__none__'?'已取消默认工作空间。':'默认工作空间已保存，未单独指定的聊天立即跟随。');
    }catch(error){toast('保存失败：'+error.message);}
    finally{applyingDefault=false;}
  }

  function click(button) {
    if(button.dataset.sessionGroupFilter!==undefined){selected=button.dataset.sessionGroupFilter;void renderPage();return true;}
    if(button.hasAttribute('data-session-group-refresh')){void refresh();return true;}
    if(button.hasAttribute('data-session-group-default')){void applyDefault(query('#wb-default-workspace')?.value??'__none__');return true;}
    if(button.hasAttribute('data-session-group-default-focus')&&selected&&selected!=='all'&&selected!=='unassigned'){void applyDefault(selected);return true;}
    if(button.dataset.sessionGroupMove){move(button.dataset.sessionGroupMove);return true;}
    return false;
  }
  return {prepare,visible,toolbar,control,click};
}
