import {draftIssue,draftMarkdown,studioChats} from './persona-studio-model.mjs';

export function createPersonaStudio({api,state,modal,closeModal,escapeHtml:esc,icon,toast,importRole}){
  let draft=null,prompt='',history=[],undo=[],chat='',opening=false,busy=false,exported='',active=false;
  const copy=value=>structuredClone(value),$=selector=>document.querySelector(selector);
  const hasDraft=()=>!!prompt.trim()||!!draft&&JSON.stringify(draft)!==exported;
  const entry=()=>`<section class="studio-entry"><div class="studio-entry-copy"><span class="studio-entry-icon">${icon('person')}</span><div><h2>AI 人格工作室</h2><p>从一个想法开始，把性格、语气和互动习惯慢慢打磨成你喜欢的样子。</p></div></div><button class="button primary" data-persona-studio>${icon('plus')}设计我的人格</button></section>`;
  async function open(){
    if(opening)return;opening=true;
    try{
      const catalog=await api('/api/plugins'),plugin=catalog.plugins.find(item=>item.id==='persona-studio');
      const chats=studioChats(state.config,plugin);if(!chats.includes(chat))chat=chats[0]??'';
      const available=!!plugin?.active&&chats.length>0;
      active=true;
      modal('AI 人格工作室',`<div class="studio-topline"><span>描述想法 → 打磨草稿 → 确认导入</span><span class="status-tag ${available?'ok':'warn'}">${available?'工作室已连接':'需要启用插件'}</span></div><div class="studio-workspace"><section class="studio-compose"><div><p class="studio-eyebrow">PERSONA STUDIO</p><h3>你想遇见怎样的助手？</h3></div><p>说说它的性格、语气，或你希望怎样相处。每次修改都会保留草稿中的其他设定。</p><div class="field"><label for="studio-chat">使用哪个聊天的模型与授权</label><select id="studio-chat">${chats.length?chats.map(key=>`<option value="${esc(key)}" ${key===chat?'selected':''}>${esc(state.names.get(key)??(key.includes(':private:')?'私聊':'群聊'))}</option>`).join(''):'<option value="">尚未授权聊天</option>'}</select></div><div class="field"><label for="studio-prompt">${draft?'继续打磨你的想法':'描述你的人格想法'}<span class="studio-count" id="studio-prompt-count"></span></label><textarea id="studio-prompt" maxlength="3000" placeholder="例如：温柔但有主见，喜欢音乐，回复简短，偶尔开个小玩笑。">${esc(prompt)}</textarea></div><div class="studio-examples" aria-label="灵感提示"><button type="button" data-studio-idea="温柔但有主见，喜欢音乐，回复简短自然，尊重彼此的边界。">温柔的音乐搭子</button><button type="button" data-studio-idea="理性可靠，遇到问题先梳理思路，用清楚易懂的语言给出建议，适当幽默。">可靠的生活助手</button><button type="button" data-studio-idea="活泼、好奇，善于接话，偶尔俏皮地吐槽，但不挖苦对方。">有趣的聊天伙伴</button></div><button class="button primary" id="studio-generate" ${available?'':'disabled'}>${icon('plus')}生成第一版</button><button class="button studio-seed" id="studio-seed">从当前选中的人格开始</button><div id="studio-generation-state" class="studio-state" role="status">${available?'使用当前已配置模型；点击生成会使用模型额度。':'请在“能力 → 能力目录”启用 AI 人格工作室，并为自己的私聊授权。'}</div><div id="studio-error" class="studio-inline-error" role="alert"></div><div class="studio-history" id="studio-history" aria-label="本次修改记录"></div><p class="studio-session-note">草稿在本窗口内保留。导入前可自由编辑、撤销或下载；只有确认导入后才会写入人格库。</p></section><section class="studio-preview"><div class="studio-preview-toolbar"><h3>人格草稿</h3><div class="segmented" role="tablist" aria-label="草稿视图"><button id="studio-edit-tab" class="selected" role="tab" aria-selected="true" aria-controls="studio-editor">编辑草稿</button><button id="studio-markdown-tab" role="tab" aria-selected="false" aria-controls="studio-markdown">Markdown</button></div></div><div id="studio-empty" class="studio-empty"><span>${icon('person')}</span><h3>先种下一点想法</h3><p>生成后的名字、人格设定和对话示例会出现在这里，你可以随时修改每一处细节。</p></div><div id="studio-editor" class="studio-editor" role="tabpanel" aria-labelledby="studio-edit-tab" hidden><div class="field"><label for="studio-name">人格名称</label><input id="studio-name" maxlength="60" placeholder="给它起一个名字"></div><div class="field"><label for="studio-description">一句话介绍<span class="studio-count" id="studio-description-count"></span></label><textarea id="studio-description" maxlength="300" placeholder="它是谁，有什么特别之处"></textarea></div><div class="field"><label for="studio-system">人格与互动设定<span class="studio-count" id="studio-system-count"></span></label><textarea id="studio-system" maxlength="2200" placeholder="身份、语气、互动方式与边界"></textarea></div><div><div class="studio-preview-toolbar"><label class="field-label">对话示例 <span class="subtle">最多 4 条</span></label><button class="button small" id="studio-add-example">${icon('plus')}添加示例</button></div><div id="studio-example-rows"></div></div></div><pre id="studio-markdown" class="studio-markdown" role="tabpanel" aria-labelledby="studio-markdown-tab" tabindex="0" hidden></pre><p id="studio-validation" class="studio-inline-error" role="status"></p><div class="studio-preview-footer"><small>导入会进入确认预览。当前使用的人格与聊天绑定由你决定。</small><div class="button-row"><button class="button small" id="studio-undo" disabled>撤销</button><button class="button small" id="studio-download" disabled>${icon('download')}下载</button><button class="button primary" id="studio-import" disabled>导入人格库</button></div></div></section></div>`,{className:'persona-studio-modal',beforeClose:()=>!busy,onClose:()=>{active=false;}});
      const error=message=>{if(active)$('#studio-error').textContent=message;};
      const remember=()=>{undo.push(draft?copy(draft):null);undo=undo.slice(-10);};
      function examples(){
        $('#studio-example-rows').innerHTML=(draft?.examples??[]).map((row,index)=>`<div class="studio-dialogue"><select aria-label="示例 ${index+1} 的角色" data-studio-role="${index}"><option value="user" ${row.role==='user'?'selected':''}>用户</option><option value="assistant" ${row.role==='assistant'?'selected':''}>角色</option></select><textarea aria-label="示例 ${index+1} 的内容" data-studio-content="${index}" maxlength="180">${esc(row.content)}</textarea><button class="icon-button" data-studio-remove="${index}" aria-label="删除示例 ${index+1}">${icon('close')}</button></div>`).join('');
      }
      function fill(){
        for(const [id,key]of [['name','display_name'],['description','description'],['system','system_prompt']])$('#studio-'+id).value=draft?.[key]??'';
        examples();paint();
      }
      function paint(){
        const issue=draftIssue(draft),markdownTab=$('#studio-markdown-tab').getAttribute('aria-selected')==='true';
        $('#studio-empty').hidden=!!draft;$('#studio-editor').hidden=!draft||markdownTab;$('#studio-markdown').hidden=!draft||!markdownTab;
        $('#studio-markdown').textContent=draft&&!issue?draftMarkdown(draft):issue;
        $('#studio-validation').textContent=draft?issue:'';
        for(const id of ['download','import'])$('#studio-'+id).disabled=busy||!!issue;
        $('#studio-undo').disabled=busy||!undo.length;$('#studio-add-example').disabled=busy||!draft||draft.examples.length>=4;
        $('#studio-prompt-count').textContent=prompt.length+'/3000';$('#studio-description-count').textContent=(draft?.description.length??0)+'/300';$('#studio-system-count').textContent=(draft?.system_prompt.length??0)+'/2200';
        $('#studio-generate').disabled=busy||!available||!prompt.trim()||!!draft&&!!issue;$('#studio-generate').innerHTML=busy?'<span class="studio-busy"></span>正在构思…':icon('plus')+(draft?'按描述修改草稿':'生成第一版');
        $('#studio-history').innerHTML=history.slice(-3).map(item=>`<article><small>第 ${item.version} 次打磨</small>${esc(item.message)}</article>`).join('');
      }
      function lock(value){busy=value;$('#modal-close').disabled=value;for(const input of $('#modal-content').querySelectorAll('input,textarea,select,[data-studio-idea],[data-studio-remove],#studio-seed'))input.disabled=value;paint();}
      $('#studio-prompt').addEventListener('input',event=>{prompt=event.target.value;paint();});
      $('#studio-chat').addEventListener('change',event=>{chat=event.target.value;});
      for(const button of document.querySelectorAll('[data-studio-idea]'))button.addEventListener('click',()=>{prompt=button.dataset.studioIdea;$('#studio-prompt').value=prompt;paint();$('#studio-prompt').focus();});
      for(const [id,key]of [['name','display_name'],['description','description'],['system','system_prompt']])$('#studio-'+id).addEventListener('input',event=>{if(draft){draft[key]=event.target.value;paint();}});
      $('#studio-example-rows').addEventListener('input',event=>{if(event.target.dataset.studioRole!==undefined)draft.examples[Number(event.target.dataset.studioRole)].role=event.target.value;if(event.target.dataset.studioContent!==undefined)draft.examples[Number(event.target.dataset.studioContent)].content=event.target.value;paint();});
      $('#studio-example-rows').addEventListener('click',event=>{const button=event.target.closest('[data-studio-remove]');if(button&&!busy){remember();draft.examples.splice(Number(button.dataset.studioRemove),1);examples();paint();}});
      $('#studio-add-example').onclick=()=>{if(!draft||draft.examples.length>=4||busy)return;remember();draft.examples.push({role:draft.examples.length%2?'assistant':'user',content:''});examples();paint();};
      function switchTab(markdown){$('#studio-edit-tab').setAttribute('aria-selected',String(!markdown));$('#studio-markdown-tab').setAttribute('aria-selected',String(markdown));$('#studio-edit-tab').classList.toggle('selected',!markdown);$('#studio-markdown-tab').classList.toggle('selected',markdown);paint();}
      $('#studio-edit-tab').onclick=()=>switchTab(false);$('#studio-markdown-tab').onclick=()=>switchTab(true);
      for(const [id,other]of [['edit','markdown'],['markdown','edit']])$('#studio-'+id+'-tab').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'edit':event.key==='End'?'markdown':other;switchTab(target==='markdown');$('#studio-'+target+'-tab').focus();}});
      $('#studio-seed').onclick=()=>{const role=state.roles.find(item=>item.name===state.selectedRole);if(!role){error('请先在人格库选择一个人格。');return;}const content=state.roleDrafts.get(role.name)?.content??role.content;if(content.trim().length>2200){error('当前人格超过 2200 字，请先精简后再继续打磨。原内容已保留。');return;}remember();draft={display_name:role.name,description:'从现有人格继续打磨',system_prompt:content,examples:[]};error('');fill();};
      $('#studio-undo').onclick=()=>{if(!busy&&undo.length){draft=undo.pop();fill();}};
      $('#studio-generate').onclick=async()=>{
        if(busy||!available||!prompt.trim())return;
        const message=prompt.trim();lock(true);error('');$('#studio-generation-state').textContent='正在生成预览，通常需要几秒到半分钟。可以继续查看草稿。';
        try{
          const value=await api('/api/plugins/persona-studio/actions/generate',{key:chat,args:{message,...(draft?{draft}: {})}});
          if(!value?.draft)throw Error('插件未返回草稿，请在能力目录检查启用状态。');const issue=draftIssue(value.draft);if(issue)throw Error(issue);
          remember();draft=copy(value.draft);history.push({version:history.length+1,message});prompt='';$('#studio-prompt').value='';fill();$('#studio-generation-state').textContent='草稿已生成，可直接编辑或继续描述修改。';
        }catch(cause){error(cause.name==='TimeoutError'?'生成等待超时，草稿已保留。请确认连接状态；不会自动重复生成。':cause.message);$('#studio-generation-state').textContent='本次未更新草稿，已有内容保留。';}
        finally{lock(false);}
      };
      $('#studio-download').onclick=()=>{try{const blob=new Blob([draftMarkdown(draft)],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=draft.display_name.trim()+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);exported=JSON.stringify(draft);toast('已准备下载人格 Markdown。');}catch(cause){error(cause.message);}};
      $('#studio-import').onclick=()=>{try{const initial={name:draft.display_name.trim(),content:draftMarkdown(draft),onImported:()=>{exported=JSON.stringify(draft);}};importRole(initial);}catch(cause){error(cause.message);}};
      fill();
    }catch(cause){toast(cause.message);}finally{opening=false;}
  }
  document.addEventListener('click',event=>{if(event.target.closest('[data-persona-studio]'))open();});
  return {entry,open,hasDraft,isBusy:()=>busy};
}
