export function visionModelGroups(models){
  const suitable=row=>!/(?:gpt-image|qwen-image|imagine-(?:image|video)|seedance|jimeng|kling-|speech-|(?:^|[-_.])(?:tts|asr|voiceclone)(?:$|[-_.]))/i.test(row.model);
  const supports=row=>row.supportsImages===true||row.inputModalities?.includes('image');
  const known=row=>row.supportsImages===false||Array.isArray(row.inputModalities);
  return [
    {label:'支持图片输入',models:models.filter(row=>suitable(row)&&supports(row))},
    {label:'能力待核验，可选择后测试',models:models.filter(row=>suitable(row)&&!supports(row)&&!known(row))},
    {label:'不支持或不适合图片理解',disabled:true,models:models.filter(row=>!suitable(row)||(!supports(row)&&known(row)))},
  ];
}
const same=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model;
export function createDshModelsUI({api,state,escapeHtml:esc,icon,modal,closeModal,toast,renderPage,updateDraftUI}){
  let catalog=null,loadSequence=0;
  const label=selection=>catalog?.models?.find(row=>same(row,selection))?.name??selection?.model??'未选择';
  const card=()=>`<section class="card dsh-model-card"><div class="card-header"><div><h2>默认聊天模型</h2><p class="card-description">自动读取 WorkBuddy 内置模型列表。保存后从下一次请求开始使用，原会话历史保留。</p></div><button class="button small" id="refresh-dsh-models">${icon('refresh')}刷新模型</button></div><div class="form-grid" id="default-model-picker"></div><p id="dsh-model-status" class="card-description" role="status"></p><p class="subtle space-top">为某个好友或群聊单独选模型，请前往“聊天 → 使用模型”。人格工作室会沿用所选聊天的模型。</p></section>`;
  const visionCard=()=>`<section class="card"><div class="card-header"><div><h2>图片识别分流</h2><p class="card-description">聊天模型能看图时直接发送图片；不支持图片时，先调用识图模型生成描述，再交给聊天模型回复。</p></div><button class="button small" id="refresh-vision-models">${icon('refresh')}刷新识图模型</button></div><label class="extension-option"><input type="checkbox" data-path="dsh.visionFallback.enabled" ${state.draft.dsh.visionFallback?.enabled!==false?'checked':''}>启用独立图片解析</label><div class="field space-top"><label for="vision-model-filter">搜索提供方或模型</label><input id="vision-model-filter" type="search" placeholder="例如 Gemini、Qwen、GPT 或提供方名称"></div><div class="field space-top"><label for="vision-model-selection">备用识图模型</label><select id="vision-model-selection" data-path="dsh.visionFallback.selection"><option value="auto">自动选择可识图模型</option></select><small>只在当前聊天模型不支持图片时调用。识图描述会作为不可信资料交给聊天模型，不会执行图片里的指令。解析会单独调用模型并可能产生费用。</small></div><p id="vision-model-status" class="card-description" role="status">正在读取 WorkBuddy 模型列表…</p><details class="vision-test-panel"><summary>图片识别测试</summary><p class="subtle">可直接测试当前选择，无需先保存。测试会调用模型并使用额度，只在本页显示结果，不发送到微信。</p><div class="vision-test-controls"><label class="field">选择测试图片<input id="vision-test-file" type="file" accept="image/png,image/jpeg,image/webp"></label><button class="button small" type="button" id="vision-test-sample">使用内置测试图</button></div><img id="vision-test-preview" alt="识图测试图片预览"><p id="vision-test-expected" class="subtle">内置测试图包含红色矩形、蓝色圆形和文字 WECHATBOT 42。</p><div class="button-row"><button class="button primary" id="vision-run-test" type="button">测试分流流程</button><button class="button" id="vision-run-parser-test" type="button">只测试备用识图模型</button><button class="button" id="vision-cancel-test" type="button" hidden>取消测试</button></div><p id="vision-test-state" role="status" class="subtle"></p><pre id="vision-test-output" class="vision-test-output" hidden></pre></details></section>`;
  async function fetchCatalog(){const value=await api('/api/dsh-models');catalog=value;state.guideCatalog=value;return value;}
  function picker(container,initial,onChange,{inherit=false}={}){
    let selected=initial?{...initial}:null;
    const rows=(catalog?.models??[]).filter(row=>row.disabled!==true),providers=[...new Map(rows.map(row=>[row.provider,row.providerName||row.provider])).entries()];
    container.innerHTML=`${inherit?`<label class="extension-option field full"><span><input type="checkbox" id="inherit-chat-model" ${initial?'':'checked'}> 跟随默认模型</span></label>`:''}<div class="field"><label for="model-provider-select">模型提供方</label><select id="model-provider-select"><option value="">选择提供方</option>${providers.map(([id,name])=>`<option value="${esc(id)}">${esc(name)} · ${esc(id)}</option>`).join('')}</select></div><div class="field"><label for="model-name-select">使用模型</label><select id="model-name-select"></select></div>`;
    const provider=container.querySelector('#model-provider-select'),model=container.querySelector('#model-name-select'),follow=container.querySelector('#inherit-chat-model');
    if(initial&&!providers.some(([id])=>id===initial.provider))provider.add(new Option(initial.provider+'（当前未列出）',initial.provider));
    provider.value=initial?.provider??'';
    function models(){const available=rows.filter(row=>row.provider===provider.value);model.innerHTML='<option value="">选择模型</option>'+available.map(row=>`<option value="${esc(row.model)}">${esc(row.name)}${row.name!==row.model?' · '+esc(row.model):''}</option>`).join('');if(selected?.provider===provider.value&&!available.some(row=>row.model===selected.model))model.add(new Option(selected.model+'（当前未列出）',selected.model));model.value=selected?.provider===provider.value?selected.model:'';}
    function emit(){const inherited=follow?.checked;provider.disabled=model.disabled=!!inherited||!catalog?.available;selected=inherited?null:provider.value&&model.value?{provider:provider.value,model:model.value}:undefined;onChange(selected,selected===null||!!selected&&rows.some(row=>same(row,selected)));}
    provider.onchange=()=>{selected=undefined;models();emit();};model.onchange=emit;if(follow)follow.onchange=emit;models();emit();
    return ()=>selected;
  }
  async function mount(){
    const box=document.querySelector('#default-model-picker'),visionBox=document.querySelector('#vision-model-selection');if(!box&&!visionBox)return;const request=++loadSequence;
    const status=document.querySelector('#dsh-model-status'),visionStatus=document.querySelector('#vision-model-status');
    const refreshButtons=[document.querySelector('#refresh-dsh-models'),document.querySelector('#refresh-vision-models')].filter(Boolean);for(const button of refreshButtons){button.onclick=()=>mount();button.disabled=true;}
    if(status)status.textContent='正在从 WorkBuddy 获取模型…';if(visionStatus)visionStatus.textContent='正在读取 WorkBuddy 模型列表…';
    if(visionBox)bindVisionTest();
    try{await fetchCatalog();if(request!==loadSequence||(box&&!box.isConnected)||(visionBox&&!visionBox.isConnected))return;
      if(box){picker(box,state.draft.dsh,(selection,valid)=>{state.modelSelectionIncomplete=selection===undefined;if(valid&&selection){state.draft.dsh.provider=selection.provider;state.draft.dsh.model=selection.model;}updateDraftUI();});if(status)status.textContent=catalog.available?'已读取 '+new Set(catalog.models.map(row=>row.provider)).size+' 个提供方、'+catalog.models.length+' 个模型。当前默认：'+label(state.draft.dsh)+'。':catalog.message;}
      if(visionBox){
        const filter=document.querySelector('#vision-model-filter');
        const render=()=>{const current=state.draft.dsh.visionFallback?.selection,selected=current?encodeURIComponent(JSON.stringify(current)):'auto',query=(filter?.value??'').trim().toLowerCase(),rows=(catalog.models??[]).filter(row=>!query||[row.name,row.model,row.provider,row.providerName].join(' ').toLowerCase().includes(query)),groups=visionModelGroups(rows);
          visionBox.innerHTML='<option value="auto">自动选择可识图模型</option>'+groups.map(group=>'<optgroup label="'+esc(group.label)+'">'+group.models.map(row=>'<option value="'+esc(encodeURIComponent(JSON.stringify({provider:row.provider,model:row.model})))+'" '+(group.disabled?'disabled':'')+'>'+esc(row.name??row.model)+' · '+esc(row.providerName??row.provider)+' · '+esc(row.model)+'</option>').join('')+'</optgroup>').join('');
          if(current&&!rows.some(row=>same(row,current)))visionBox.add(new Option(current.model+' · '+current.provider+'（当前选择）',selected));visionBox.value=selected;
          const all=visionModelGroups(catalog.models??[]);if(visionStatus)visionStatus.textContent=catalog.available?'共 '+(catalog.models??[]).length+' 个模型：'+all[0].models.length+' 个标记支持识图，'+all[1].models.length+' 个能力待核验，'+all[2].models.length+' 个不适合识图。未标记的模型也可选择并测试。'+(catalog.providerErrors?.length?' 部分提供方未返回列表，请刷新重试。':''):catalog.message??'暂时无法获取模型列表，请确认应用内的模型连接已就绪。';
        };if(filter)filter.oninput=render;render();
      }
    }catch(error){if(request===loadSequence){if(status?.isConnected)status.textContent=error.message;if(visionStatus?.isConnected)visionStatus.textContent=error.message;}}finally{if(request===loadSequence)for(const button of refreshButtons)if(button.isConnected)button.disabled=false;}
  }
  function bindVisionTest(){
    const run=document.querySelector('#vision-run-test'),parserRun=document.querySelector('#vision-run-parser-test'),file=document.querySelector('#vision-test-file'),sample=document.querySelector('#vision-test-sample'),preview=document.querySelector('#vision-test-preview'),line=document.querySelector('#vision-test-state'),output=document.querySelector('#vision-test-output'),expected=document.querySelector('#vision-test-expected'),cancel=document.querySelector('#vision-cancel-test');if(!run||run.dataset.bound)return;run.dataset.bound='true';let image,controller,isSample=true,changing=false;
    const setSample=()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=320;const context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,640,320);context.fillStyle='#e53434';context.fillRect(50,40,210,135);context.fillStyle='#2767e8';context.beginPath();context.arc(450,110,70,0,Math.PI*2);context.fill();context.fillStyle='#111111';context.font='bold 42px Arial';context.fillText('WECHATBOT 42',80,260);const url=canvas.toDataURL('image/png');image={mime:'image/png',b64:url.split(',')[1]};preview.src=url;isSample=true;expected.textContent='内置测试图包含红色矩形、蓝色圆形和文字 WECHATBOT 42。';file.value='';};
    setSample();sample.onclick=setSample;
    file.onchange=async()=>{const selected=file.files[0];if(!selected)return;if(changing)return;changing=true;run.disabled=parserRun.disabled=true;let url;try{if(!['image/png','image/jpeg','image/webp'].includes(selected.type)||selected.size>10*1024*1024)throw Error('请选择10 MiB以内的 PNG、JPEG 或 WebP 图片。');url=URL.createObjectURL(selected);const img=new Image();img.src=url;await img.decode();if(!preview.isConnected)return;const scale=Math.min(1,1280/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',0.85);if(data.split(',')[1].length>1048576)throw Error('图片压缩后仍过大，请截取需要识别的区域。');image={mime:'image/jpeg',b64:data.split(',')[1]};preview.src=data;isSample=false;expected.textContent='使用你选择的图片进行测试，不会向微信发送。';line.textContent='图片已就绪。';}catch(error){line.textContent=error.message;}finally{if(url)URL.revokeObjectURL(url);changing=false;if(run.isConnected)run.disabled=parserRun.disabled=false;}};
    const cancelOnRoute=()=>controller?.abort();window.addEventListener('hashchange',cancelOnRoute);const observer=new MutationObserver(()=>{if(!run.isConnected){controller?.abort();window.removeEventListener('hashchange',cancelOnRoute);observer.disconnect();}});observer.observe(document.querySelector('#page-body'),{childList:true,subtree:true});
    const test=async mode=>{if(controller||!image||changing)return;controller=new AbortController();run.disabled=parserRun.disabled=file.disabled=sample.disabled=true;cancel.hidden=false;output.hidden=true;line.textContent='正在检查模型能力并解析图片…';try{const result=await api('/api/vision-test',{...image,mode,chatSelection:{provider:state.draft.dsh.provider,model:state.draft.dsh.model},selection:state.draft.dsh.visionFallback?.selection??null,enabled:state.draft.dsh.visionFallback?.enabled!==false},true,{signal:controller.signal});if(!run.isConnected)return;line.textContent=(result.route==='direct'?'当前聊天模型可直接识图，已跳过备用模型。':result.route==='parser-test'?'备用识图模型测试完成。':'聊天模型需要分流，备用模型已解析图片。')+' 使用 '+result.parserModel.provider+' / '+result.parserModel.model+'，耗时 '+(result.elapsedMs/1000).toFixed(1)+' 秒。'+(isSample?(/42|四十二/.test(result.text)?' 已读取测试文字42。':' 本次未核对到测试文字42，请查看结果。'):'');output.textContent=result.text;output.hidden=false;}catch(error){if(line.isConnected)line.textContent=controller.signal.aborted?'测试已取消。':error.message==='识图测试未完成，请检查模型连接和应用日志。'?'该提供方当前未完成模型调用。模型列表可见不代表服务可用，请检查登录、连接和额度，或换一个提供方再测试。':error.message;}finally{controller=null;if(run.isConnected){run.disabled=parserRun.disabled=file.disabled=sample.disabled=false;cancel.hidden=true;}}};run.onclick=()=>test('route');parserRun.onclick=()=>test('parser');cancel.onclick=()=>controller?.abort();
  }
  async function dialog(key){
    if(state.job?.state==='running'||state.savingAll)return toast('请等待当前操作完成。');
    try{
      const [saved]=await Promise.all([api('/api/config'),fetchCatalog()]);const original=saved.config.dsh.chats?.[key]??null;
      modal('选择此聊天的模型',`<p class="modal-description">${esc(state.names.get(key)??key)} · 默认使用 ${esc(label(saved.config.dsh))}。选择独立模型后，此聊天的回复、图片理解和人格工作室会使用它。</p><div id="chat-model-picker" class="form-grid"></div><p class="card-description space-top">${catalog.available?'来自 WorkBuddy 当前模型列表；保存后下一次请求生效。正在执行的回复继续使用原模型。':esc(catalog.message)}</p><p id="chat-model-error" class="inline-error" role="alert"></p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="save-chat-model" disabled>保存模型</button></div>`);
      const save=document.querySelector('#save-chat-model');let selected=original,valid=false,busy=false;
      picker(document.querySelector('#chat-model-picker'),original,(value,ok)=>{selected=value;valid=ok;save.disabled=busy||!valid;},{inherit:true});
      save.onclick=async()=>{if(!valid||busy)return;busy=true;save.disabled=true;
        try{const value=await api('/api/chat-model',{key,selection:selected,revision:saved.revision});state.draft.dsh.chats??={};if(selected===null)delete state.draft.dsh.chats[key];else state.draft.dsh.chats[key]={...selected};state.config=value.config;state.revision=value.revision;closeModal();await renderPage();updateDraftUI();toast('此聊天的模型已保存，下一次请求生效。');}
        catch(error){document.querySelector('#chat-model-error').textContent=error.message;busy=false;save.disabled=false;}
      };
    }catch(error){toast(error.message);}
  }
  document.addEventListener('click',event=>{const target=event.target.closest('[data-model-chat]');if(target)dialog(target.dataset.modelChat);});
  document.addEventListener('click',async event=>{if(!event.target.closest('[data-people-memory]'))return;try{const data=await api('/api/people-memory');modal('跨聊天人物记忆',`<p class="modal-description">按经核验的微信身份关联，同名不合并。仅当前聊天的记忆不会带入别的聊天；跨聊天记忆需本人明确允许，180 天后过期。删除会保留本机可恢复记录。</p><div class="section-stack">${data.people.map(person=>`<section class="card"><h3>${esc(person.names.join(' / ')||'未命名人物')}</h3><small class="subtle">${esc(person.id.slice(0,12))}</small>${person.notes.map(note=>`<article class="space-top"><p>${esc(note.text)}</p><small class="subtle">${note.visibility==='person'?'本人允许跨聊天使用':'仅原聊天'} · ${new Date(note.at).toLocaleDateString()}</small><button class="button small" data-forget-person-note="${esc(note.id)}">忘记此条</button></article>`).join('')}</section>`).join('')||'<p class="empty-state">还没有人物记忆。可在已授权聊天中明确说“记住……”；需要跨聊天使用时请明确说明。</p>'}</div>`);for(const button of document.querySelectorAll('[data-forget-person-note]'))button.onclick=async()=>{if(!button.dataset.confirmed){button.dataset.confirmed='true';button.textContent='再次点击确认忘记';return;}try{await api('/api/people-memory/forget',{scope:data.scope,id:button.dataset.forgetPersonNote,confirmed:true});button.closest('article').remove();toast('已忘记此条记忆。');}catch(error){toast(error.message);}};}catch(error){toast(error.message);}});
  return {card,visionCard,mount,label};
}

// ---- WeChatBot: WorkBuddy 模型选择器；与上方「默认聊天模型」共用 dsh.model 字段 ----
/**
 * WorkBuddy 模型选择器（同文件导出，避免新增静态资源依赖）
 *
 * 模型目录来自 /api/dsh-models（应用进程内读取 WorkBuddy 云端列表）。
 * 选择通过 /api/workbuddy-model 写入 config/wechatagent.json 的 dsh.model；
 * 消息桥接每次请求实时读取该文件，因此保存后下一条消息立即生效，无需重启。
 */
const RECOMMENDED = ['auto', 'fast-model', 'balanced-model', 'deep-model'];

export function createWorkbuddyModelsUI({ api, state, escapeHtml: esc, icon, toast, onSaved }) {
  const $ = selector => document.querySelector(selector);
  let catalog = null;
  let chosen = null;
  let loadSequence = 0;
  let busy = false;

  const card = () => `<section class="card workbuddy-model-card"><div class="card-header"><div><h2>WorkBuddy 模型</h2><p class="card-description">选择用于微信回复的模型。列表来自 WorkBuddy 云端，保存后下一条消息立即生效，无需重启或重新应用设置。</p></div><button class="button small" id="wb-model-refresh" type="button">${icon('refresh')}刷新列表</button></div>
    <div class="notice plain" id="wb-model-current" role="status">正在读取当前模型…</div>
    <div class="form-grid space-top"><div class="field"><label for="wb-model-search">搜索模型</label><input id="wb-model-search" type="search" placeholder="按名称、ID 或说明搜索，例如 免费、GLM、DeepSeek" autocomplete="off"></div><div class="field"><label for="wb-model-select">可用模型</label><select id="wb-model-select"></select><small>积分倍率由 WorkBuddy 提供，按实际调用计费。图片或视频生成模型不适合聊天，已标记为不可选。</small></div></div>
    <div class="notice plain space-top" id="wb-model-detail">选择一个模型查看说明。</div>
    <div class="button-row space-top"><button class="button primary" id="wb-model-save" type="button" disabled>保存并立即生效</button><button class="button" id="wb-model-test" type="button">测试当前选择</button><button class="button" id="wb-model-revert" type="button">恢复已生效模型</button></div>
    <p class="card-description space-top" id="wb-model-status" role="status"></p>
    <p class="subtle space-top">测试会向 WorkBuddy 发送一条极短消息，不写入聊天记录，但可能产生积分消耗。想给某个好友或群聊单独指定模型，请到「聊天 → 使用模型」，单独指定的模型优先于这里的默认模型。</p></section>`;

  const rowOf = id => (catalog?.models ?? []).find(row => row.model === id) ?? null;
  const display = id => { const row = rowOf(id); return row ? `${row.name}（${row.model}）` : String(id ?? 'auto'); };
  const cheap = row => /x\s*0\.0[0-4]\b/i.test(row.credits ?? '') || /x0\.00/i.test(row.credits ?? '');
  const unsuitable = row => row.chat === false || row.disabled === true;

  function groups(rows) {
    const recommended = rows.filter(row => (row.isDefault === true || RECOMMENDED.includes(row.model)) && !unsuitable(row));
    const free = rows.filter(row => !recommended.includes(row) && cheap(row) && !unsuitable(row));
    const others = rows.filter(row => !recommended.includes(row) && !free.includes(row) && !unsuitable(row));
    const blocked = rows.filter(unsuitable);
    return [
      { label: '推荐 · 自动与常用', rows: recommended },
      { label: '免费 / 低倍率', rows: free },
      { label: '其他文字对话模型', rows: others },
      { label: '不适合聊天（图片 / 视频生成）', rows: blocked, disabled: true },
    ].filter(group => group.rows.length);
  }

  function render() {
    const select = $('#wb-model-select');
    if (!select || !catalog) return;
    const query = ($('#wb-model-search')?.value ?? '').trim().toLowerCase();
    const rows = (catalog.models ?? []).filter(row => !query
      || [row.name, row.model, row.description, row.credits].join(' ').toLowerCase().includes(query));
    select.innerHTML = groups(rows).map(group => `<optgroup label="${esc(group.label)}">${group.rows.map(row =>
      `<option value="${esc(row.model)}" ${group.disabled ? 'disabled' : ''}>${esc(row.name)} · ${esc(row.model)}${row.credits ? ' · ' + esc(row.credits) : ''}${row.isDefault ? ' · 默认' : ''}${group.disabled ? ' · 不可用于聊天' : ''}</option>`
    ).join('')}</optgroup>`).join('');
    if (chosen && !rows.some(row => row.model === chosen)) {
      select.add(new Option(display(chosen) + '（当前选择）', chosen));
    }
    select.value = chosen ?? '';
    const row = rowOf(chosen);
    if (!row) { $('#wb-model-detail').textContent = '暂时没有这个模型的说明，仍可保存后使用。'; }
    else {
      const tags = [row.supportsImages ? '图片输入' : '', row.supportsToolCall ? '工具调用' : '', row.supportsReasoning ? '深度思考' : ''].filter(Boolean);
      $('#wb-model-detail').innerHTML = `<strong>${esc(row.name)}</strong> · <code>${esc(row.model)}</code><br>${esc(row.description || 'WorkBuddy 未提供模型说明。')}<br><span class="subtle">${row.credits ? '积分倍率：' + esc(row.credits) + ' · ' : ''}${row.maxInputTokens ? '最大输入 ' + Math.round(row.maxInputTokens / 1000) + 'K tokens · ' : ''}${tags.length ? '能力：' + tags.map(esc).join(' / ') : '文字对话'}${unsuitable(row) ? ' · 此模型不能用于聊天回复' : ''}</span>`;
    }
    const changed = !!chosen && chosen !== catalog.current;
    const save = $('#wb-model-save');
    if (save) save.disabled = busy || !catalog.available || !changed || unsuitable(rowOf(chosen) ?? { chat: true });
    $('#wb-model-current').innerHTML = `当前生效：<strong>${esc(display(catalog.current))}</strong>${changed ? ` · 待保存：<strong>${esc(display(chosen))}</strong>` : ''}`;
    const status = $('#wb-model-status');
    if (status) status.textContent = catalog.available
      ? `已读取 ${(catalog.models ?? []).length} 个模型。切换模型不需要重启服务。`
      : (catalog.message ?? '暂时无法读取 WorkBuddy 模型列表。');
  }

  function setBusy(value) {
    busy = value;
    for (const id of ['#wb-model-refresh', '#wb-model-save', '#wb-model-test', '#wb-model-revert']) {
      const button = $(id);
      if (button) button.disabled = value || (id === '#wb-model-save' && (!catalog?.available || !chosen || chosen === catalog.current || unsuitable(rowOf(chosen) ?? { chat: true })));
    }
  }

  async function load(force = false) {
    const select = $('#wb-model-select');
    if (!select) return;
    const request = ++loadSequence;
    const status = $('#wb-model-status');
    if (status) status.textContent = '正在读取 WorkBuddy 模型列表…';
    try {
      catalog = await api('/api/dsh-models' + (force ? '?refresh=1' : ''));
      if (request !== loadSequence || !$('#wb-model-select')?.isConnected) return;
      chosen = catalog.current ?? state.config?.dsh?.model ?? state.draft?.dsh?.model ?? 'auto';
      if (state.guideCatalog) state.guideCatalog = catalog;
      render();
    } catch (error) {
      if (request !== loadSequence) return;
      catalog = { available: false, models: [], current: state.config?.dsh?.model ?? 'auto', message: error.message };
      chosen = catalog.current;
      if ($('#wb-model-select')?.isConnected) render();
    }
  }

  function applySaved(value) {
    state.config = value.config;
    state.revision = value.revision;
    if (state.draft?.dsh) { state.draft.dsh.provider = 'workbuddy'; state.draft.dsh.model = chosen; }
    state.guideCatalog = catalog;
    catalog.current = chosen;
    onSaved?.(value);
    render();
  }

  async function save() {
    if (busy || !catalog?.available || !chosen || chosen === catalog.current) return;
    setBusy(true);
    const status = $('#wb-model-status');
    if (status) status.textContent = '正在保存模型设置…';
    try {
      let value;
      try {
        value = await api('/api/workbuddy-model', { model: chosen, revision: state.revision });
      } catch (error) {
        if (error.status !== 409) throw error;
        // 其他窗口或向导刚保存过设置：读取最新版本号后自动重试一次。
        const latest = await api('/api/config');
        state.config = latest.config;
        state.revision = latest.revision;
        value = await api('/api/workbuddy-model', { model: chosen, revision: state.revision });
      }
      applySaved(value);
      if (status) status.textContent = `已切换到 ${display(chosen)}，下一条消息立即生效。`;
      toast('WorkBuddy 模型已保存，下一条消息立即生效。');
    } catch (error) {
      const hint = error.status === 404
        ? '模型保存接口尚未加载：请完全退出并重启 WeChatBot.exe，再回到本页保存模型。'
        : '保存失败：' + error.message;
      if (status) status.textContent = hint;
      toast(hint);
    } finally { setBusy(false); }
  }

  async function test() {
    if (busy || !chosen) return;
    setBusy(true);
    const status = $('#wb-model-status');
    if (status) status.textContent = `正在测试 ${display(chosen)}，最多等待 45 秒…`;
    try {
      const result = await api('/api/workbuddy-model/test', { model: chosen });
      if (!$('#wb-model-status')?.isConnected) return;
      if (result.ok) status.textContent = `测试成功（${(result.elapsedMs / 1000).toFixed(1)} 秒）：模型回复「${String(result.text).slice(0, 80)}」`;
      else status.textContent = `测试失败：${result.error}。可换一个模型，或稍后重试。`;
    } catch (error) {
      if ($('#wb-model-status')?.isConnected) status.textContent = error.status === 404
        ? '测试接口尚未加载：请重启 WeChatBot.exe 后再测试。'
        : '测试失败：' + error.message;
    } finally { setBusy(false); }
  }

  function mount() {
    const select = $('#wb-model-select');
    if (!select) return;
    const refresh = $('#wb-model-refresh'), search = $('#wb-model-search');
    if (refresh) refresh.onclick = () => load(true);
    if (search) search.oninput = () => render();
    select.onchange = () => { chosen = select.value; render(); };
    const saveButton = $('#wb-model-save'), testButton = $('#wb-model-test'), revert = $('#wb-model-revert');
    if (saveButton) saveButton.onclick = save;
    if (testButton) testButton.onclick = test;
    if (revert) revert.onclick = () => { chosen = catalog?.current ?? state.config?.dsh?.model ?? 'auto'; render(); };
    void load();
  }

  const accountCard = () => `<section class="card"><div class="card-header"><div><h2>WorkBuddy 账号与密钥</h2><p class="card-description">本发行包不内置任何共享 Key。Key 属于「应用」而不是个人账号：登录后在自己的 WorkBuddy 里创建一个应用并开启云服务，就能拿到专属的 endpoint 与 publishableKey。</p></div><span class="status-tag" id="wb-account-badge">读取中</span></div><p id="wb-account-status" class="card-description" role="status">正在读取当前密钥…</p><div class="button-row"><button class="button primary" id="wb-account-login">登录 WorkBuddy 账号</button><button class="button" id="wb-account-edit">使用我的 Key</button><button class="button" id="wb-account-reset" hidden>改回未配置</button></div><form id="wb-account-form" class="form-grid space-top" hidden><div class="field"><label for="wb-account-endpoint">应用地址 endpoint</label><input id="wb-account-endpoint" type="url" placeholder="https://你的应用.app.workbuddy.host" required><small>只接受 https://*.app.workbuddy.host，避免把 Key 发到其它地址。</small></div><div class="field"><label for="wb-account-key">publishableKey</label><input id="wb-account-key" type="password" placeholder="wbpk_…" autocomplete="off" required><small>在 WorkBuddy 应用的云服务设置里复制；只保存在本机。</small></div><p id="wb-account-error" class="inline-error" role="alert" hidden></p><div class="button-row"><button class="button primary" type="submit" id="wb-account-save">测试并保存</button><button class="button" type="button" id="wb-account-cancel">取消</button></div></form><p class="subtle space-top">登录按钮只会打开本机 WorkBuddy 客户端，应用无法代替你在 WorkBuddy 内完成账号登录。publishableKey 是应用级公开标识，不是账号密码。</p></section>`;

  async function mountAccount() {
    const badge = document.querySelector('#wb-account-badge'), line = document.querySelector('#wb-account-status'), form = document.querySelector('#wb-account-form');
    if (!badge || !line || !form) return;
    const reset = document.querySelector('#wb-account-reset'), edit = document.querySelector('#wb-account-edit'), login = document.querySelector('#wb-account-login');
    let info = null;
    const paint = value => {
      info = value;
      const custom = value.source === 'custom';
      badge.textContent = custom ? '我的 Key' : '未配置';
      badge.className = 'status-tag ' + (custom ? 'ok' : 'warn');
      line.textContent = custom
        ? `正在使用你自己的应用：${value.endpoint} · ${value.keyMasked}${value.models ? ' · ' + value.models + ' 个模型' : ''}${value.verifiedAt ? ' · 验证于 ' + new Date(value.verifiedAt).toLocaleString() : ''}`
        : `尚未配置 WorkBuddy 应用。填写自己的 endpoint 与 publishableKey 后才能使用模型通道；额度与责任都归你自己。`;
      if (reset) reset.hidden = !custom;
    };
    try { paint(await api('/api/workbuddy-account')); } catch (error) { line.textContent = error.message; return; }
    login.onclick = async () => {
      login.disabled = true;
      try {
        const result = await api('/api/workbuddy-account/login', {});
        toast(result.ok ? '已打开本机 WorkBuddy。登录后创建应用并开启云服务，复制 endpoint 与 publishableKey。' : '没有找到本机 WorkBuddy 客户端，请先安装并登录。');
      } catch (error) { toast(error.message); }
      finally { login.disabled = false; }
    };
    edit.onclick = () => {
      form.hidden = false; edit.hidden = true;
      const endpoint = document.querySelector('#wb-account-endpoint');
      if (endpoint && !endpoint.value) endpoint.value = info?.endpoint ?? '';
      document.querySelector('#wb-account-key')?.focus();
    };
    document.querySelector('#wb-account-cancel').onclick = () => {
      form.hidden = true; edit.hidden = false;
      const error = document.querySelector('#wb-account-error'); if (error) error.hidden = true;
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const save = document.querySelector('#wb-account-save'), error = document.querySelector('#wb-account-error');
      error.hidden = true; save.disabled = true; save.textContent = '正在校验…';
      try {
        const value = await api('/api/workbuddy-account', {
          endpoint: document.querySelector('#wb-account-endpoint').value.trim(),
          publishableKey: document.querySelector('#wb-account-key').value.trim(),
        });
        paint(value); toast('已换用你的 Key，下一次模型请求立即生效。');
        form.hidden = true; edit.hidden = false;
      } catch (cause) { error.textContent = cause.message; error.hidden = false; }
      finally { save.disabled = false; save.textContent = '测试并保存'; }
    };
    reset.onclick = async () => {
      reset.disabled = true;
      try { paint(await api('/api/workbuddy-account/reset', {})); toast('已恢复共享默认 Key。'); }
      catch (error) { toast(error.message); }
      finally { reset.disabled = false; }
    };
  }

  return { card, mount, label: display, accountCard, mountAccount };
}
