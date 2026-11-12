import {fontSize} from './interface-model.mjs';
const normalize = value => ({
  imageDataUrl: /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value?.imageDataUrl ?? '') ? value.imageDataUrl : '',
  name: typeof value?.name === 'string' ? value.name : '',
  strength: Number.isFinite(value?.strength) ? Math.max(0,Math.min(100,Math.round(value.strength))) : 40,
});

export function initAppearance({ api, modal, closeModal, toast, escapeHtml, icon }) {
  const desktop = window.desktop, button = document.getElementById('appearance-button');
  const hasWallpaper = !!desktop?.chooseBackground;
  const colors = window.consoleColors;
  let appearance = normalize(desktop?.initialAppearance), saving;
  const layer = document.getElementById('app-background');
  function apply() {
    layer.style.backgroundImage = appearance.imageDataUrl ? `url("${appearance.imageDataUrl}")` : '';
    layer.style.opacity = String(appearance.strength / 100);
    document.body.classList.toggle('has-wallpaper', !!appearance.imageDataUrl);
  }
  let interfaceSettings;
  const applyFont=value=>document.documentElement.style.setProperty('--ui-font-scale',String(fontSize(value)/14));
  void api('/api/interface-preferences').then(value=>{interfaceSettings=value;applyFont(value.fontSize);}).catch(()=>{});
  function render() {
    const current = colors.get();
    document.querySelector('.topbar-more')?.removeAttribute('open');
    modal('外观与阅读', `<p class="modal-description">调整字号、显示模式与配色。修改自动保存，只在本机生效。</p>
      <section class="appearance-section"><div class="appearance-section-heading"><h3>字体大小</h3><span>立即预览，自动保存，重开保留</span></div><label class="field">字号（12–22）<input id="appearance-font-size" type="range" min="12" max="22" step="1" value="${interfaceSettings?.fontSize??14}"><output id="appearance-font-value">${interfaceSettings?.fontSize??14}px</output></label><button class="button small" id="appearance-font-reset">恢复标准字号</button><p class="subtle">放大页面文字、按钮和表单；不改变发送给聊天对象的文字格式。</p></section><section class="appearance-section"><div class="appearance-section-heading"><h3>显示模式</h3><span>明亮或沉静，都清晰舒适</span></div><div class="appearance-modes" role="group" aria-label="显示模式">${[['light','sun','浅色'],['dark','moon','深色']].map(([theme,symbol,label])=>`<button class="appearance-mode" data-appearance-theme="${theme}" aria-pressed="${document.documentElement.dataset.theme===theme}">${icon(symbol)}${label}</button>`).join('')}</div></section>
      <section class="appearance-section"><div class="appearance-section-heading"><h3>灵感配色</h3><span id="appearance-preset-label">${colors.presets.find(([,a,b])=>a===current.accent&&b===current.background)?.[0] || '自定义'}</span></div><div class="appearance-presets" role="group" aria-label="预设配色">${colors.presets.map(([name,a,b],i)=>`<button class="appearance-swatch" data-color-preset="${i}" aria-label="${name}配色" aria-pressed="${a===current.accent&&b===current.background}"><span aria-hidden="true"><i></i><i></i><i></i></span><strong>${name}</strong></button>`).join('')}</div>
      <div class="appearance-colors">${[['accent','主题色'],['background','背景底色']].map(([key,label])=>`<div class="appearance-color-field"><label for="appearance-${key}">${label}</label><div><input type="color" id="appearance-${key}" value="${current[key]}" aria-label="选择${label}"><input type="text" id="appearance-${key}-hex" value="${current[key]}" maxlength="7" spellcheck="false" aria-label="${label}十六进制色值" aria-describedby="appearance-color-help"></div></div>`).join('')}</div><p class="subtle" id="appearance-color-help">支持 #RRGGBB 色值。背景底色会柔和融入界面，按钮文字自动适配对比度。</p>
      <div class="appearance-sample" aria-label="当前配色预览"><span class="appearance-sample-icon">${icon('person')}</span><div><strong>你的专属工作空间</strong><small>让每一次打开，都有熟悉的温度。</small></div><span class="appearance-sample-button">已就绪</span></div>
      <button class="link-button" id="appearance-colors-reset">恢复默认配色</button></section>
      ${hasWallpaper ? `<section class="appearance-section"><div class="appearance-section-heading"><h3>背景图片</h3><span>添加一点个人风格</span></div>
      <div class="appearance-preview${appearance.imageDataUrl ? ' has-image' : ''}" id="appearance-preview" role="img" aria-label="背景图片预览"><span>${icon('image')}<strong>默认背景</strong></span></div>
      <div class="appearance-file"><span id="appearance-name">${escapeHtml(appearance.name || '还没有选择图片')}</span><div class="button-row"><button class="button primary" id="appearance-choose">${icon('image')}选择图片</button><button class="button" id="appearance-reset" ${appearance.imageDataUrl ? '' : 'disabled'}>恢复默认</button></div></div>
      <div class="appearance-slider"><label for="appearance-strength">背景显示强度</label><output id="appearance-strength-value" for="appearance-strength">${appearance.strength}%</output><input id="appearance-strength" type="range" min="0" max="100" step="1" value="${appearance.strength}" ${appearance.imageDataUrl ? '' : 'disabled'} aria-describedby="appearance-help"></div>
      <p class="subtle" id="appearance-help">强度越低，背景越淡。界面保留柔和遮罩，便于阅读。支持 PNG、JPG，最大 20 MB。</p>
      <p class="appearance-note">图片仅保存在本机，不会发送给模型。</p></section>` : '<p class="appearance-note">桌面版还支持选择本地图片作为背景。</p>'}
      <p id="appearance-error" class="inline-error" role="alert" hidden></p>
      <div class="modal-actions"><button class="button" id="appearance-done">完成</button></div>`);
    document.querySelectorAll('[data-color-preset]').forEach(el=>{const [,a,b]=colors.presets[Number(el.dataset.colorPreset)];const preview=el.querySelector('span');preview.style.setProperty('--swatch',a);preview.style.setProperty('--swatch-bg',b);});
    const error = message => { const el = document.getElementById('appearance-error'); if(el){el.hidden=false;el.textContent=message;} };
    let fontSaving;
    async function saveFont(value){try{const current=await api('/api/interface-preferences');interfaceSettings=await api('/api/interface-preferences',{revision:current.revision,fontSize:value});applyFont(value);}catch(cause){if(interfaceSettings){applyFont(interfaceSettings.fontSize);const input=document.getElementById('appearance-font-size'),output=document.getElementById('appearance-font-value');if(input)input.value=String(interfaceSettings.fontSize);if(output)output.textContent=interfaceSettings.fontSize+'px';}error(cause.message);}}
    const fontInput=document.getElementById('appearance-font-size');
    fontInput.oninput=()=>{const value=Number(fontInput.value);applyFont(value);document.getElementById('appearance-font-value').textContent=value+'px';};
    fontInput.onchange=()=>{const value=Number(fontInput.value);fontSaving=(fontSaving??Promise.resolve()).then(()=>saveFont(value));};
    document.getElementById('appearance-font-reset').onclick=()=>{fontInput.value='14';fontInput.oninput();fontInput.onchange();};
    async function updateColors(next) {
      try {
        await colors.set(next);
        document.getElementById('appearance-error').hidden=true;
        for(const key of ['accent','background'])for(const suffix of ['','-hex']) {
          const input=document.getElementById(`appearance-${key}${suffix}`);
          input.value=next[key];input.removeAttribute('aria-invalid');
        }
        document.querySelectorAll('[data-color-preset]').forEach(el=>{
          const [,a,b]=colors.presets[Number(el.dataset.colorPreset)];el.setAttribute('aria-pressed',String(a===next.accent&&b===next.background));
        });
        document.getElementById('appearance-preset-label').textContent=colors.presets.find(([,a,b])=>a===next.accent&&b===next.background)?.[0] || '自定义';
      } catch { error('配色保存失败，请检查本机存储是否可用后重试。'); }
    }
    document.querySelectorAll('[data-appearance-theme]').forEach(el=>el.addEventListener('click',()=>{
      if(document.documentElement.dataset.theme!==el.dataset.appearanceTheme)document.getElementById('theme-button').click();
      document.querySelectorAll('[data-appearance-theme]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.appearanceTheme===document.documentElement.dataset.theme)));
    }));
    document.querySelectorAll('[data-color-preset]').forEach(el=>el.addEventListener('click',()=>{const [,accent,background]=colors.presets[Number(el.dataset.colorPreset)];updateColors({accent,background});}));
    for(const key of ['accent','background']) {
      document.getElementById(`appearance-${key}`).addEventListener('input',event=>updateColors({...colors.get(),[key]:event.target.value}));
      document.getElementById(`appearance-${key}-hex`).addEventListener('input',event=>{
        const value=event.target.value.trim();
        if(/^#[\da-f]{6}$/i.test(value))updateColors({...colors.get(),[key]:value.toLowerCase()});
        else {event.target.setAttribute('aria-invalid','true');error('请输入完整的十六进制颜色，例如 #7660ad。');}
      });
    }
    document.getElementById('appearance-colors-reset').addEventListener('click',()=>updateColors({...colors.defaults}));
    document.getElementById('appearance-done').addEventListener('click',closeModal);
    if (!hasWallpaper) return;
    const preview = document.getElementById('appearance-preview');
    preview.style.backgroundImage = appearance.imageDataUrl ? `url("${appearance.imageDataUrl}")` : '';
    const choose = document.getElementById('appearance-choose'), reset = document.getElementById('appearance-reset');
    choose.addEventListener('click',async()=>{
      clearTimeout(saving); choose.disabled=true; reset.disabled=true; choose.textContent='正在选择…';
      try {
        await desktop.setBackgroundStrength(appearance.strength);
        const result=await desktop.chooseBackground();
        if(!result?.canceled){appearance=normalize(result);apply();toast('背景已更新。');}
        if(document.getElementById('modal').open)render();
      }catch(e){choose.disabled=false;reset.disabled=!appearance.imageDataUrl;choose.innerHTML=icon('image')+'选择图片';error(e.message || '图片选择失败，请重试。');}
    });
    reset.addEventListener('click',async()=>{
      clearTimeout(saving);reset.disabled=true;
      try{appearance=normalize(await desktop.resetBackground());apply();render();toast('已恢复默认背景。');}catch(e){reset.disabled=false;error(e.message||'恢复默认失败，请重试。');}
    });
    document.getElementById('appearance-strength').addEventListener('input',event=>{
      appearance.strength=Number(event.target.value);document.getElementById('appearance-strength-value').textContent=appearance.strength+'%';apply();
      clearTimeout(saving);const value=appearance.strength;
      saving=setTimeout(()=>desktop.setBackgroundStrength(value).catch(e=>error(e.message||'外观设置保存失败，请重试。')),150);
    });
  }
  apply();button.addEventListener('click',render);
}
