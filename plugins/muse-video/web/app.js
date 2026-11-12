const $ = id => document.getElementById(id);
const STAGE = { queued: '排队中', processing: '生成中', completed: '已生成', delivered: '已投递', failed: '失败' };
const state = { gateway: {}, sessions: [], tasks: [], hasKey: false, endpoint: '', transport: '', autoStartGateway: true, install: null };
let submitting = false;
let gatewayBusy = false;
let lastSignature = '';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({ error: '服务返回了无法解析的响应' }));
  if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(label, ok, detail) {
  const node = el('div', 'chip ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'warn'));
  node.appendChild(el('span', 'dot'));
  node.appendChild(el('span', '', label + (detail ? ' · ' + detail : '')));
  return node;
}

function renderGatewayBar() {
  const gateway = state.gateway ?? {};
  const stateEl = $('gatewayState');
  stateEl.className = 'gwstate' + (gatewayBusy ? ' busy' : gateway.online ? ' ok' : ' bad');
  stateEl.textContent = gatewayBusy
    ? '操作中…'
    : gateway.online
      ? (gateway.ready ? '运行中 · 账号就绪' : '运行中 · 账号未就绪')
      : '未运行';
  $('gwStart').disabled = gatewayBusy || !!gateway.online;
  $('gwStop').disabled = gatewayBusy || !gateway.online;
  $('gwAdmin').disabled = gatewayBusy;
  if (!gatewayBusy) {
    const bits = [];
    bits.push(state.autoStartGateway === false ? '「随服务自动启动」已关闭' : '随服务自动启动：开');
    if (state.install?.dir) bits.push('部署：' + state.install.dir);
    $('gatewayHint').textContent = bits.join(' · ');
  }
}

function renderStatus() {
  const bar = $('statusBar');
  bar.replaceChildren();
  const gateway = state.gateway ?? {};
  bar.appendChild(chip('muse2api', gateway.online, gateway.online ? (gateway.ready ? '账号就绪' : '账号未就绪') : (gateway.reason ? '离线' : '未检测')));
  bar.appendChild(chip('API Key', state.hasKey, state.hasKey ? state.endpoint : '未配置'));
  const usable = (state.sessions ?? []).filter(item => item.authorized).length;
  bar.appendChild(chip('可投递会话', usable > 0, usable + '/' + (state.sessions ?? []).length));
  renderGatewayBar();

  const notices = [];
  if (!gateway.online) notices.push('本机 muse2api 没有响应：点上方「启动服务」即可拉起，无需再出去点 cmd。');
  else if (!gateway.ready) notices.push('muse2api 在线但账号未就绪：点上方「打开管理页」会自动带上 API Key，用「方式四：账号密码登录」重新登录 muse.ai。');
  if (!state.hasKey) notices.push('还没配置 API Key：在 wechatwb 控制台「Muse 视频」插件设置里填 MUSE2API_KEY，或设置环境变量 MUSE2API_KEY。');
  if (!usable) notices.push('还没有可投递的微信会话：请在控制台给目标聊天开启「助理模式 + 文件传输」，然后点右上角刷新状态。');
  if (state.transport === 'foreground') notices.push('当前是前台发送模式，项目禁止投递文件，请切回 native 模式。');
  const notice = $('notice');
  if (notices.length) {
    notice.textContent = notices.join(' ');
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
  const blocked = submitting || !gateway.online || !state.hasKey;
  $('submit').disabled = blocked;
  $('submitImg').disabled = blocked;
  const blockedText = blocked && !submitting ? '网关或 API Key 未就绪，暂时无法提交。' : '';
  $('formHint').textContent = blockedText;
  $('formImgHint').textContent = blockedText;
}

function fillChatSelect(select, hintEl) {
  const previous = select.value;
  select.replaceChildren();
  const list = state.sessions ?? [];
  if (!list.length) {
    const option = el('option', '', '没有可用会话（请先在控制台配置白名单）');
    option.value = '';
    select.appendChild(option);
    if (hintEl) hintEl.textContent = '';
    return;
  }
  for (const item of list) {
    const option = el('option', '', item.label + (item.authorized ? ' · 可投递' : ' · ' + (item.reason || '未授权')));
    option.value = item.key;
    select.appendChild(option);
  }
  if (previous && list.some(item => item.key === previous)) select.value = previous;
  else {
    const firstReady = list.find(item => item.authorized);
    if (firstReady) select.value = firstReady.key;
  }
}

function renderSessions() {
  fillChatSelect($('chat'), $('chatHint'));
  fillChatSelect($('chatImg'), $('chatImgHint'));
  updateChatHint();
}

function chatHintText(key) {
  const item = (state.sessions ?? []).find(entry => entry.key === key);
  if (!key || !item) return '';
  return item.authorized
    ? '已授权文件投递，生成完成后会自动发到这个会话。'
    : '未授权：' + item.reason + '。仍会生成，可在任务卡片上授权后点「补发」。';
}

function updateChatHint() {
  $('chatHint').textContent = chatHintText($('chat').value);
  $('chatImgHint').textContent = chatHintText($('chatImg').value);
}

function messageFor(task) {
  if (task.stage === 'failed') return { text: task.error || task.lastError || '生成失败', kind: 'err' };
  if (task.deliveryError) return { text: task.deliveryError, kind: 'err' };
  if (task.lastError) return { text: '查询暂时失败，会自动重试：' + task.lastError, kind: '' };
  if (task.stage === 'delivered' && task.delivery) return { text: '已入队：' + (task.delivery.notice || task.delivery.state || '等待微信回执'), kind: 'ok' };
  if (task.stage === 'completed' && !task.autoSend) return { text: '按设置未自动发送，可点「补发」。', kind: '' };
  if (task.stage === 'completed') return { text: '视频已生成，等待投递或授权。', kind: '' };
  return null;
}

function taskCard(task) {
  const isImage = task.kind === 'image';
  const card = el('div', 'task');
  const head = el('div', 'taskhead');
  head.appendChild(el('p', 'taskprompt', task.prompt));
  const badge = el('span', 'badge ' + (task.stage in STAGE ? task.stage : 'queued'), (isImage ? '图 · ' : '') + (STAGE[task.stage] || task.stage));
  head.appendChild(badge);
  card.appendChild(head);

  const bits = [task.aspect || (isImage ? '1:1' : '16:9')];
  if (!isImage) bits.splice(1, 0, (task.duration || 10) + ' 秒');
  if (task.bytes) bits.push(task.bytes > 1024 * 1024 ? (task.bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(task.bytes / 1024) + ' KB');
  if (task.conversationKey) {
    const session = (state.sessions ?? []).find(item => item.key === task.conversationKey);
    bits.push('发送至 ' + (session ? session.label : task.conversationKey));
  } else bits.push('未指定会话');
  bits.push(new Date(task.createdAt || Date.now()).toLocaleString('zh-CN', { hour12: false }));
  card.appendChild(el('p', 'meta', bits.join(' · ')));

  if (['queued', 'processing'].includes(task.stage)) {
    const bar = el('div', 'bar');
    const inner = el('i');
    inner.style.width = Math.max(4, Math.min(100, Number(task.progress) || 0)) + '%';
    bar.appendChild(inner);
    card.appendChild(bar);
  }
  if (task.file && isImage) {
    const image = el('img');
    image.alt = task.prompt || '生成的图片';
    image.loading = 'lazy';
    image.src = '/media/' + encodeURIComponent(task.file);
    image.style.maxWidth = '100%';
    image.style.borderRadius = '8px';
    card.appendChild(image);
  } else if (task.file) {
    const video = el('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = '/media/' + encodeURIComponent(task.file);
    card.appendChild(video);
  }
  const msg = messageFor(task);
  if (msg) card.appendChild(el('p', 'msg ' + msg.kind, msg.text));

  const actions = el('div', 'actions');
  const add = (label, action, className) => {
    const button = el('button', 'mini' + (className ? ' ' + className : ''), label);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = task.id;
    actions.appendChild(button);
  };
  if (!['failed', 'delivered'].includes(task.stage)) add('立即刷新', 'refresh');
  if (task.file && task.stage !== 'delivered') add(task.deliveryError ? '补发' : '补发到微信', 'deliver');
  if (task.stage === 'delivered' && task.delivery?.id) add('查回执', 'delivery');
  add('移除', 'remove', 'danger');
  card.appendChild(actions);
  return card;
}

function renderTasks(tasks, force = false) {
  const container = $('tasks');
  const list = tasks ?? [];
  $('taskCount').textContent = list.length ? list.length + ' 个任务' : '';
  // 3 秒轮询不应重绘正在播放的 <video>；只在可见字段真正变化时重建卡片。
  const signature = JSON.stringify(list.map(task => [
    task.id, task.stage, task.file, task.progress, task.delivery?.state,
    task.error, task.lastError, task.deliveryError, task.bytes, task.conversationKey,
  ]));
  if (!force && signature === lastSignature && container.childNodes.length) return;
  lastSignature = signature;
  if (!list.length) {
    container.replaceChildren(el('p', 'empty', '还没有任务，先在左边写一句画面描述。'));
    return;
  }
  container.replaceChildren(...list.map(taskCard));
}

async function loadState(force = false) {
  try {
    const data = await api('/api/state' + (force ? '?force=1' : ''));
    Object.assign(state, data);
    renderStatus();
    renderSessions();
    lastSignature = '';
    renderTasks(data.tasks, true);
  } catch (error) {
    $('notice').textContent = '本地服务未就绪（' + error.message + '）：请在项目根目录双击 start-muse-studio.cmd，启动后刷新本页。';
    $('notice').hidden = false;
  }
}

async function poll() {
  if (document.hidden || submitting) return;
  try {
    const data = await api('/api/tasks');
    state.tasks = data.tasks;
    renderTasks(data.tasks);
  } catch { /* 服务暂时不可用时保留上一次渲染 */ }
}

$('chat').addEventListener('change', updateChatHint);
$('refresh').addEventListener('click', () => loadState(true));

async function gatewayControl(action) {
  if (gatewayBusy) return;
  gatewayBusy = true;
  renderGatewayBar();
  $('gatewayHint').textContent = action === 'start'
    ? '正在启动 muse2api（uvicorn 后台进程，最多约 45 秒）…'
    : '正在停止 muse2api（会连同它管理的浏览器一起结束）…';
  try {
    const data = await api('/api/gateway/' + action, { method: 'POST', body: '{}' });
    if (data.error) $('gatewayHint').textContent = data.error;
    else if (action === 'start') {
      $('gatewayHint').textContent = data.started
        ? '已启动' + (data.pid ? '（PID ' + data.pid + '，部署 ' + data.dir + '）' : '') + '。首次冷启动后账号就绪还需要一点时间。'
        : (data.reason || '网关已在运行');
    } else {
      $('gatewayHint').textContent = data.stopped ? '已停止（PID ' + (data.pid ?? '?') + '）' : (data.reason || '网关未在运行');
    }
    await loadState(true);
  } catch (error) {
    $('gatewayHint').textContent = '操作失败：' + error.message;
  } finally {
    gatewayBusy = false;
    renderGatewayBar();
  }
}

$('gwStart').addEventListener('click', () => gatewayControl('start'));
$('gwStop').addEventListener('click', () => gatewayControl('stop'));

// 等价于 open-muse-admin.cmd：服务端带上 .env / 插件设置里的 API Key 打开管理页，
// Key 不下发到浏览器；网关没起时先自动拉起。
$('gwAdmin').addEventListener('click', async () => {
  const button = $('gwAdmin');
  button.disabled = true;
  $('gatewayHint').textContent = '正在打开管理页（网关未运行时会先启动）…';
  let line = '';
  try {
    const data = await api('/api/admin/open', { method: 'POST', body: '{}' });
    line = data.opened
      ? '已用默认浏览器打开管理页' + (data.started ? '（顺带启动了 muse2api）' : '') + '：' + data.admin
      : '打开失败：' + (data.reason || data.error || '未知原因');
    if (data.started) await loadState(true);
  } catch (error) {
    line = '打开失败：' + error.message;
  } finally {
    button.disabled = false;
    $('gatewayHint').textContent = line;
  }
});

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (prompt.length < 2) { $('formHint').textContent = '请先写一句画面描述。'; return; }
  submitting = true;
  $('submit').disabled = true;
  $('submit').textContent = '提交中…';
  $('formHint').textContent = '';
  try {
    await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        duration: Number($('duration').value),
        vertical: $('aspect').value === 'portrait',
        conversationKey: $('chat').value,
        autoSend: $('autoSend').checked,
      }),
    });
    $('prompt').value = '';
    await poll();
  } catch (error) {
    $('formHint').textContent = '提交失败：' + error.message;
  } finally {
    submitting = false;
    $('submit').textContent = '开始生成';
    $('submit').disabled = !(state.gateway && state.gateway.online) || !state.hasKey;
  }
});

// 生图：走网关 /v1/images/tasks 异步队列，后台轮询/投递与视频共用同一套任务管线。
$('formImg').addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = $('promptImg').value.trim();
  if (prompt.length < 2) { $('formImgHint').textContent = '请先写一句画面描述。'; return; }
  submitting = true;
  $('submitImg').disabled = true;
  $('submitImg').textContent = '提交中…';
  $('formImgHint').textContent = '';
  try {
    await api('/api/generate-image', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        aspect: $('aspectImg').value,
        conversationKey: $('chatImg').value,
        autoSend: $('autoSendImg').checked,
      }),
    });
    $('promptImg').value = '';
    await poll();
  } catch (error) {
    $('formImgHint').textContent = '提交失败：' + error.message;
  } finally {
    submitting = false;
    $('submitImg').textContent = '开始生成图片';
    $('submitImg').disabled = !(state.gateway && state.gateway.online) || !state.hasKey;
  }
});

$('tasks').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  button.disabled = true;
  try {
    if (action === 'delivery') {
      const data = await api(`/api/tasks/${encodeURIComponent(id)}/delivery`, { method: 'POST', body: '{}' });
      $('notice').textContent = '投递状态：' + (data.delivery?.state ?? '未知') + ' · ' + (data.delivery?.notice ?? '');
      $('notice').hidden = false;
    } else {
      const task = (state.tasks ?? []).find(item => item.id === id);
      const body = action === 'deliver'
        ? JSON.stringify({ conversationKey: (task && task.conversationKey) || $('chat').value })
        : '{}';
      await api(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
      await poll();
    }
  } catch (error) {
    $('notice').textContent = '操作失败：' + error.message;
    $('notice').hidden = false;
    button.disabled = false;
  }
});

loadState();
setInterval(poll, 3000);
