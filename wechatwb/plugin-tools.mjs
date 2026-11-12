/**
 * wechatwb — 插件工具桥接（WorkBuddy 内置宿主）
 *
 * 绿色版把模型换成进程内 WorkBuddy 云端接口后，插件不再由外部 DSH 宿主加载。
 * 这里在应用进程内直接实例化 PluginRuntime：
 *   - 插件的 tools 通过 openaiTools() 暴露给 WorkBuddy 模型（function calling）
 *   - 插件需要的「独立模型调用」由 generateText() 走 WorkBuddy 云端
 *   - 网页/网易云/B 站、人格、聊天历史等宿主服务由本机模块提供
 *   - 控制台的插件动作、能力清单、日记写入等 API 也在这里本地实现
 * 任何一项宿主服务加载失败都只降级该能力，不影响插件工具与聊天本身。
 */
import fs from 'node:fs';
import path from 'node:path';

let cache = { root: '', runtime: null, ready: null, lastSync: 0 };
let apiCache = { root: '', runtime: null, ready: null, lastSync: 0 };

function readAccountScope(root) {
  try {
    const file = path.join(root, 'state/weflow/active-account.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data.id || data.legacyId || '';
  } catch {
    return '';
  }
}

function readBufferRows(root, key) {
  try {
    const file = path.join(root, 'state/social-messages.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const rows = data?.chats?.[key];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

const shapeRow = row => ({
  id: String(row?.id ?? '').slice(0, 200),
  text: String(row?.text ?? ''),
  sender_wxid: String(row?.sender_wxid ?? row?.sender_id ?? ''),
  sender_name: String(row?.sender_name ?? ''),
  timestamp: Number(row?.timestamp) || 0,
  outgoing: !!row?.outgoing,
  forwardedRecord: !!row?.forwardedRecord,
  quoteReply: !!row?.quoteReply,
  delivery_status: row?.delivery_status,
});

function shanghaiDate(timestamp) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date((Number(timestamp) || 0) * 1000));
  } catch {
    return '';
  }
}

/** 插件宿主原本由 DSH 提供的服务，现在全部改由本机 + WorkBuddy 提供 */
async function hostServices(root, getRuntime = () => null) {
  const [model, mediaMod, neteaseMod, policyMod, memesMod] = await Promise.all([
    import('./workbuddy-model.mjs'),
    import('../packages/public-media/index.mjs'),
    import('../packages/netease/client.mjs'),
    import('../packages/dsh-social-bridge-plugin/local-policy.mjs'),
    import('../packages/workbuddy-memes/index.mjs'),
  ]);
  let media = null;
  try { media = mediaMod.createPublicMedia({ neteaseClient: neteaseMod.createNeteaseClient(root) }); }
  catch { media = mediaMod.publicMediaRequest; }
  return {
    /** 表情包来源与搜索：搜索、下载校验、共享表情池入库全部在本机完成 */
    memesHost: memesMod.createMemeSources({ root }),
    /** PluginRuntime.model.generate → WorkBuddy 云端免密钥接口（纯净输出，无协议前缀） */
    generateText: ({ prompt, key, signal, maxChars, timeoutMs, allowed }) => {
      if (typeof allowed === 'function' && !allowed()) throw new Error('PLUGIN_PERMISSION_DENIED');
      return model.generateText(prompt, { conversationKey: key, signal, maxChars, timeoutMs });
    },
    /** 网易云 / B 站公开内容：只访问构造好的固定公开端点 */
    requestMedia: (action, args, options) => media(action, args, options ?? {}),
    personaFor: key => {
      try { return policyMod.localPersona(root, key); }
      catch { return { persona: '你是一个友好的微信聊天助手，回复口语化、简洁、自然。', personaName: '默认人格' }; }
    },
    historyFor: (key, limit = 20) => readBufferRows(root, key).slice(-Math.max(1, Math.min(100, limit))).map(shapeRow),
    rowsForDate: (key, date) => readBufferRows(root, key).filter(row => shanghaiDate(row?.timestamp) === date).map(shapeRow),
    /** 管理员 WorkBuddy 助手：返回本聊天真实可用的 WorkBuddy 工具与任务状态，不依赖旧 DSH 任务队列 */
    workbuddyTasks: async (action, body = {}) => {
      const conversationKey = String(body?.conversationKey ?? '');
      const key = /^wechat:(private|group):[1-9]\d*$/.test(conversationKey) ? conversationKey : '';
      const runtime = getRuntime();
      const definitions = runtime && key ? runtime.toolDefinitions(key) : [];
      const tools = definitions
        .map(tool => ({ name: String(tool.name ?? ''), description: String(tool.description ?? '').slice(0, 160) }))
        .filter(tool => tool.name);
      let currentModel = '';
      try { currentModel = String(model.activeModel?.() ?? ''); } catch { /* 模型信息不可用时留空 */ }
      const base = { source: 'workbuddy', conversationKey: key, model: currentModel };
      if (action === 'capabilities') return { ok: true, ...base, tools, note: '这些是本聊天已授权、由 WorkBuddy 模型在当轮通过 function calling 调用的本机工具。' };
      if (action === 'list') return { ok: true, ...base, tasks: [], note: 'WorkBuddy 在当前对话轮次直接调用工具执行任务，没有后台任务队列；进度请看本轮回复。' };
      if (action === 'status' || action === 'result') return { ok: false, ...base, task: null, reason: 'NO_BACKGROUND_TASK', note: 'WorkBuddy 没有后台任务队列，无法查询历史任务状态或结果。' };
      if (action === 'cancel') return { ok: false, ...base, reason: 'NO_BACKGROUND_TASK', note: 'WorkBuddy 没有后台任务队列，没有可取消的任务。' };
      throw new Error('WORKBUDDY_TASKS_ACTION_UNSUPPORTED');
    },
  };
}

async function createRuntime(root, store, { schedule }) {
  const resolved = path.resolve(root);
  if (store.running && store.root === resolved) return store.running;
  store.root = resolved;
  store.running = (async () => {
    const [{ PluginRuntime }, { VoiceJobs }] = await Promise.all([
      import('../packages/plugin-api/index.mjs'),
      import('../packages/voice-studio/jobs.mjs'),
    ]);
    let services = {}, currentRuntime = null;
    try { services = await hostServices(resolved, () => currentRuntime); }
    catch (error) { console.warn('[plugin] 宿主服务部分不可用：' + String(error?.message ?? error)); }
    const runtime = new PluginRuntime({
      root: resolved,
      accountScope: readAccountScope(resolved) || 'unbound',
      isAllowed: () => true,
      voiceJobs: new VoiceJobs(resolved),
      log: line => console.warn('[plugin]', line),
      ...services,
    });
    currentRuntime = runtime;
    await runtime.sync();
    if (schedule) { try { runtime.start(); } catch { /* 调度器非关键 */ } }
    return runtime;
  })();
  try {
    const runtime = await store.running;
    store.runtime = runtime;
    store.lastSync = Date.now();
    return runtime;
  } catch (error) {
    store.root = ''; store.runtime = null; store.running = null;
    throw error;
  }
}

/**
 * 取得（或创建）当前数据目录的插件运行时。
 * 消息桥接进程用默认参数（启动每日计划），控制台传 {schedule:false} 避免重复调度。
 */
export async function getPluginRuntime(root, { schedule = true } = {}) {
  const store = schedule ? cache : apiCache;
  const resolved = path.resolve(root);
  if (store.runtime && store.root === resolved) {
    if (Date.now() - store.lastSync < 60000) return store.runtime;
    store.lastSync = Date.now();
    try { await store.runtime.sync(); } catch { /* 保持旧记录 */ }
    return store.runtime;
  }
  return createRuntime(resolved, store, { schedule });
}

/** 把插件工具转成 OpenAI tools 结构；无授权工具时返回空数组 */
export function openaiTools(runtime, conversationKey) {
  if (!runtime || typeof conversationKey !== 'string') return [];
  try {
    return runtime.toolDefinitions(conversationKey).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: String(tool.description ?? '').slice(0, 900),
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      },
    }));
  } catch {
    return [];
  }
}

/** 构造一轮对话的 turn 对象（PluginRuntime 依赖这些字段） */
export function createTurn(conversationKey, metadata = {}) {
  return {
    conversationKey,
    conversationName: metadata.conversationName ?? metadata.chatName ?? conversationKey,
    engagement: metadata.engagement ?? { mode: 'social' },
    // WorkBuddy 主链路用 pluginSender 传递经校验的微信身份；补全管理员/身份相关能力。
    actorId: metadata.actorId ?? metadata.pluginSender ?? metadata.assistantSender ?? metadata.sender_wxid ?? '',
    replies: [],
    toolCalls: 0,
    voiceRequests: [],
    batchId: metadata.batchId ?? `turn-${Date.now()}`,
  };
}

/** 执行一个工具调用，异常转成结构化错误回给模型 */
export async function runToolStep(runtime, turn, name, args, signal) {
  try {
    const result = await runtime.execute(name, args, turn, signal);
    return { content: result?.content ?? '', isError: result?.isError === true };
  } catch (error) {
    return { content: JSON.stringify({ error: String(error?.message ?? error) }), isError: true };
  }
}

/** 把本轮暂存的语音请求真正入队，返回入队结果 */
export function commitTurnVoice(runtime, turn, signal) {
  try {
    return runtime.commitVoice(turn, signal) ?? [];
  } catch {
    return [];
  }
}

/** 本机插件能力清单（供「能力与权限」页分配工具） */
function localCatalog(runtime) {
  const records = [...runtime.records.values()];
  const plugins = records.map(record => ({
    id: record.id,
    name: String(record.name ?? record.id),
    kind: 'plugin',
    packageName: record.id,
    version: String(record.version ?? ''),
    enabled: !!record.process && !record.process.closed,
    description: String(record.description ?? ''),
  }));
  const tools = records.flatMap(record => (record.process?.tools ?? []).map(tool => ({
    name: record.id + '__' + tool.id,
    description: String(tool.description ?? ''),
    sourceId: record.id,
    loaded: !!record.process && !record.process.closed,
  })));
  return { tools, plugins, skills: [], presets: [], source: 'workbuddy-inprocess' };
}

/**
 * 控制台插件 API 的本地实现。返回 null 表示该路由未接管（调用方按未实现处理）。
 * 这些路由原本转发到 DSH 11230 端口，现在全部在应用进程内完成。
 */
export async function localPluginApi(route, body = {}, root, { signal } = {}) {
  const raw = String(route ?? '');
  const cut = raw.indexOf('?');
  const pathname = cut < 0 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1));
  const payload = body && typeof body === 'object' ? body : {};
  const runtime = await getPluginRuntime(root, { schedule: false });

  if (pathname === '/extensions') return { extensions: runtime.list() };

  if (pathname === '/dsh-catalog') {
    void query.get('conversationKey');
    return localCatalog(runtime);
  }

  if (pathname.startsWith('/plugin-actions/')) {
    const parts = pathname.split('/');
    const id = parts[2], name = parts[3];
    const key = payload.conversationKey ?? payload.key ?? '';
    if (!id || !name || !key) throw Object.assign(new Error('缺少插件动作参数。'), { status: 400 });
    const result = await runtime.invokeAction(id, name, payload.args ?? {}, createTurn(key), { signal });
    return result ?? { handled: false };
  }

  if (pathname === '/fish-notebook/write') {
    const key = payload.conversationKey ?? '';
    const result = await runtime.invokeAction('fish-notebook', 'write-today', {}, createTurn(key), { signal, timeoutMs: 120000 });
    if (result?.handled === false) throw Object.assign(new Error('请先安装并为此聊天启用鱼的记事本插件。'), { status: 409 });
    return { ok: true };
  }

  if (pathname === '/sessions') return { sessions: [] };
  if (pathname === '/configure') return { ok: true, modeReady: true };

  if (pathname.startsWith('/assistant-task/')) {
    if (pathname.endsWith('/list')) return { tasks: [] };
    return { ok: false, unavailable: true, task: null };
  }

  if (pathname.startsWith('/session-groups/')) {
    throw Object.assign(new Error('工作空间由 WorkBuddy 管理，请在 WorkBuddy 中打开或重命名文件夹后回到这里刷新。'), { status: 410 });
  }

  if (pathname === '/meme-library/status') {
    // 外部 dsh-meme 图库确实未安装；同时如实上报本机 WorkBuddy 表情插件状态
    let localPlugin = null;
    try {
      const { memeSources } = await import('../packages/workbuddy-memes/index.mjs');
      localPlugin = await memeSources(root).status();
    } catch { /* 状态读取失败不影响其它能力 */ }
    return { available: false, installed: false, reason: 'DSH_PLUGIN_UNAVAILABLE', localPlugin };
  }

  return null;
}
