// 朋友圈发布（小鱼原生方案）：写稿 → 生成定稿报文 → 授权加载 → 单次投递 → 回读核对。
//
// 重要约束：宿主对聊天工具的单次调用上限是 8 秒（plugin-api 里 toolTimeoutMs 最大就是 8000），
// 而调用模型写一条朋友圈通常要 6～20 秒。所以：
//   · 聊天工具一律「短预算」运行，写不出来就如实说，绝不硬等（硬等就是用户看到的“卡住”）；
//   · 需要完整生成的动作注册成 action（35 秒预算），由控制台/接口触发，每日计划也走这个预算。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './lib/state.mjs';
import {composeText, shanghaiDate} from './lib/content.mjs';
import {buildPostPacket, sha256, selfCheck, SUPPORTED_CORE} from './lib/protocol.mjs';
import {loadSession, MomentsComponent} from './lib/native-client.mjs';
import {describeChannels, probeGateway, publishGateway, publishNative, publishNativeAuto, resolveChannel} from './lib/publish.mjs';
import {publishViaUi, uiaStatus} from './lib/uia.mjs';
import {diagnose, formatReport, resolveAccount, compatLine} from './lib/diagnose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const store = new Store(path.join(ROOT, 'state/moments-native'));

/** 聊天工具预算：宿主上限 8000ms，这里留 2.8 秒给上下文、序列化与返回。 */
const TOOL_BUDGET_MS = 5200;
/** 动作预算：宿主给 action 35 秒，但模型接口自己上限 25 秒，取 24 秒。 */
const ACTION_TIMEOUT_MS = 24000;
const TIMED_OUT = Symbol('timed-out');

const dailyLimit = settings => Math.max(1, Math.min(3, Number(settings.maxPostsPerDay) || 1));
const message = text => ({content: String(text).slice(0, 32000)});
const today = () => shanghaiDate();

function displayTime(value) {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

/** 在预算内等一个异步任务；超时返回 TIMED_OUT，不抛错、不继续占用调用。 */
async function withinBudget(task, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  // 兜住超时之后才落地的失败，避免出现未捕获的 Promise 拒绝。
  const settled = Promise.resolve(task).catch(error => ({__error: error}));
  try {
    const value = await Promise.race([settled, timeout]);
    if (value && value.__error) throw value.__error;
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function sessionPath(settings) {
  return String(settings.sessionFile ?? '').trim() || path.join(ROOT, 'state/moments-native/session.json');
}

function nativeState(settings) {
  const loaded = loadSession(sessionPath(settings));
  return loaded.session
    ? {available: true, session: loaded.session, detail: `会话在线（进程 ${loaded.session.pid}）`}
    : {available: false, session: null, detail: loaded.reason || '未加载'};
}

/** 最近一条草稿/待授权材料，工具超时时用它给个交代。 */
function latestDraft(state) {
  return (state.history ?? []).slice().reverse().find(item => typeof item.text === 'string' && item.text.trim()) ?? null;
}

/** 生成一份“已定稿、待授权”的发布材料；加载器只认它的哈希。 */
async function prepareProposal(ctx, settings, {compact = false, timeoutMs = 20000} = {}) {
  const account = resolveAccount(ROOT, settings);
  if (!account.wxid) throw new Error('还没拿到微信号：请在插件设置里填 accountWxid，或在管理员设置里选好微信身份');
  const draft = await composeText(ctx, settings, store, {
    yesterday: String(settings.postTime ?? '') === '00:00', compact, timeoutMs,
  });
  const value = buildPostPacket({account: account.wxid, text: draft.text, visibility: 'public'});
  const problem = selfCheck(value.packet, {account: account.wxid, text: draft.text, requestId: value.requestId});
  if (problem) throw new Error('报文自检未通过：' + problem);
  const proposal = store.writeProposal({
    account: account.wxid, text: draft.text, visibility: 'public',
    packet: value.packet, requestId: value.requestId, created: value.created,
    sha256: value.sha256, timeline: value.timeline, coreSha256: SUPPORTED_CORE.coreSha256,
  });
  return {proposal, draft, account};
}

function loaderHint(proposal) {
  return [
    `提案：${proposal.id}`,
    `正文：${proposal.text}`,
    `报文 SHA-256：${proposal.packetSha256.slice(0, 16)}…`,
    '',
    '这条只是编码留存，还没有发出去。要发的话直接说「发出去」：插件会自己在微信进程里加载组件、',
    '把这一包的哈希作为唯一授权内容投递，不需要你跑任何脚本，也不会重复发（一条一授权）。',
  ].join('\n');
}

/* ------------------------------------------------------------------ 每日计划 */

export async function daily(ctx) {
  const settings = ctx.config() ?? {};
  const state = store.snapshot();
  const date = today();
  if (state.date !== date) {
    state.date = date;
    state.count = 0;
    state.attempted = [];
  }

  if (String(settings.mode) === 'draft') {
    if ((state.history ?? []).some(item => item.date === date && item.status === 'draft')) {
      return {ok: true, status: 'skipped', reason: '今天已经写过草稿'};
    }
    try {
      const draft = await composeText(ctx, settings, store, {
        yesterday: String(settings.postTime ?? '') === '00:00', timeoutMs: ACTION_TIMEOUT_MS,
      });
      const file = store.writeOutbox(draft.text, 'draft');
      store.push(state, {at: new Date().toISOString(), date, text: draft.text, hash: draft.hash, channel: 'outbox', status: 'draft', file});
      state.lastError = '';
      store.save(state);
      return {ok: true, status: 'draft', file};
    } catch (error) {
      state.lastError = error.message;
      store.save(state);
      return {ok: false, status: 'failed_before_commit', retryLater: true, reason: error.message};
    }
  }

  if (state.count >= dailyLimit(settings)) return {ok: true, status: 'skipped', reason: '已达当天发布上限'};

  let channel = resolveChannel(settings);
  /* auto：界面通道可用就优先用它——不注入、不会让微信退出；否则回落到原生/网关 */
  if (channel === 'auto' && uiaStatus(ROOT).available) channel = 'uia';

  if (channel === 'native' || channel === 'auto') {
    const native = nativeState(settings);
    if (native.available && native.session.operation !== 'detail') {
      const pending = (state.history ?? []).find(item => item.packetSha256 === native.session.approvedHash && item.status === 'prepared');
      if (pending) {
        const proposal = store.readProposal(pending.proposalId);
        if (proposal) {
          const result = await publishNativeAuto({root: ROOT, packet: proposal.packet, text: proposal.text});
          state.attempted = [...(state.attempted ?? []), proposal.id].slice(-40);
          if (result.ok) state.count += 1;
          state.lastError = result.ok ? '' : String(result.reason ?? result.detail ?? '发布未确认');
          store.push(state, {
            at: new Date().toISOString(), date, text: proposal.text, hash: sha256(proposal.text),
            channel: 'native', status: result.ok ? 'accepted' : result.state ?? 'unknown',
            proposalId: proposal.id, packetSha256: proposal.packetSha256, objectId: result.objectId ?? null,
          });
          store.save(state);
          return {ok: result.ok, status: result.state ?? (result.ok ? 'accepted' : 'unknown'), channel: 'native'};
        }
      }
    }
    if (channel === 'native') {
      // 没有可复用的授权：按“生成待授权材料”处理，绝不谎报已发布。
      // 多个授权聊天会各触发一次每日计划，同一天只允许准备一条。
      if ((state.history ?? []).some(item => item.date === date && item.status === 'prepared')) {
        return {ok: true, status: 'skipped', reason: '今天已经生成过待授权材料'};
      }
      try {
        const {proposal} = await prepareProposal(ctx, settings, {compact: true, timeoutMs: ACTION_TIMEOUT_MS});
        store.push(state, {
          at: new Date().toISOString(), date, text: proposal.text, hash: sha256(proposal.text),
          channel: 'outbox', status: 'prepared', proposalId: proposal.id, packetSha256: proposal.packetSha256,
        });
        state.lastError = '原生通道需要人工授权加载这一条';
        store.save(state);
        return {ok: true, status: 'prepared', reason: '已生成待授权材料，需手动加载组件后发布'};
      } catch (error) {
        state.lastError = error.message;
        store.save(state);
        return {ok: false, status: 'failed_before_commit', retryLater: true, reason: error.message};
      }
    }
  }

  if (channel === 'uia') {
    let draft;
    try {
      draft = await composeText(ctx, settings, store, {compact: true, timeoutMs: ACTION_TIMEOUT_MS});
    } catch (error) {
      state.lastError = error.message;
      store.save(state);
      return {ok: false, status: 'failed_before_commit', retryLater: true, reason: error.message};
    }
    const ui = await publishViaUi({root: ROOT, text: draft.text});
    state.lastError = ui.ok ? '' : String(ui.reason ?? '');
    if (ui.ok) state.count += 1;
    const file = ui.ok ? null : store.writeOutbox(draft.text, 'failed');
    store.push(state, {
      at: new Date().toISOString(), date, text: draft.text, hash: draft.hash,
      channel: 'uia', status: ui.ok ? 'accepted' : 'not-submitted', file,
    });
    store.save(state);
    return {ok: ui.ok, status: ui.ok ? 'accepted' : 'failed_before_commit', channel: 'uia', reason: ui.reason};
  }

  if (channel === 'gateway' || channel === 'auto') {
    let draft;
    try {
      draft = await composeText(ctx, settings, store, {compact: true, timeoutMs: ACTION_TIMEOUT_MS});
    } catch (error) {
      state.lastError = error.message;
      store.save(state);
      return {ok: false, status: 'failed_before_commit', retryLater: true, reason: error.message};
    }
    const result = await publishGateway(settings, draft.text);
    const file = result.ok ? null : store.writeOutbox(draft.text, 'failed');
    state.lastError = result.ok ? '' : String(result.reason ?? '网关未确认');
    if (result.ok) state.count += 1;
    store.push(state, {
      at: new Date().toISOString(), date, text: draft.text, hash: draft.hash,
      channel: 'gateway', status: result.ok ? 'accepted' : result.state ?? 'unknown', file,
    });
    store.save(state);
    return {ok: result.ok, status: result.ok ? 'accepted' : 'failed_before_commit', channel: 'gateway'};
  }

  // 发件箱：只写稿。多个聊天各触发一次，同一天只写一份。
  if ((state.history ?? []).some(item => item.date === date && item.status === 'draft')) {
    return {ok: true, status: 'skipped', reason: '今天已经写过草稿'};
  }
  try {
    const draft = await composeText(ctx, settings, store, {compact: true, timeoutMs: ACTION_TIMEOUT_MS});
    const file = store.writeOutbox(draft.text, 'draft');
    store.push(state, {at: new Date().toISOString(), date, text: draft.text, hash: draft.hash, channel: 'outbox', status: 'draft', file});
    state.lastError = '';
    store.save(state);
    return {ok: true, status: 'draft', file};
  } catch (error) {
    state.lastError = error.message;
    store.save(state);
    return {ok: false, status: 'failed_before_commit', retryLater: true, reason: error.message};
  }
}

/* ------------------------------------------------------------------ 聊天工具（8 秒内） */

export async function status(ctx) {
  const settings = ctx.config() ?? {};
  const state = store.snapshot();
  const native = nativeState(settings);
  const gateway = await probeGateway(settings, {timeout: 1500});
  const account = resolveAccount(ROOT, settings);
  let nativeDetail = native.detail;
  if (native.available) {
    try {
      const health = await new MomentsComponent(native.session, {timeout: 2500}).health();
      nativeDetail = `在线 · 进程 ${health.pid} · 账号目录 ${health.accountDirectory} · 本次授权内容 ${String(native.session.approvedHash).slice(0, 12)}…`;
    } catch (error) {
      nativeDetail = '会话在但核验失败：' + error.message;
    }
  }
  const latest = latestDraft(state);
  const lines = [
    '【朋友圈发布 · 状态】',
    `模式：${String(settings.mode) === 'draft' ? '只写草稿' : '自动发布'} ｜ 时间：${settings.postTime} ｜ 每天上限：${dailyLimit(settings)} 条`,
    describeChannels(settings, {native: {available: native.available, detail: nativeDetail}, gateway}),
    `原生组件：${nativeDetail}`,
    `账号：${account.wxid || '未找到'}（${account.source}）`,
    `今日已发：${state.date === today() ? state.count : 0} 条`,
    `最近一条：${latest ? `${displayTime(latest.at)} · ${latest.status} · ${String(latest.text).slice(0, 40)}` : '无'}`,
    `发件箱：${store.outboxCount()} 个文件`,
    state.lastError ? `上次说明：${state.lastError}` : '',
  ].filter(Boolean);
  return message(lines.join('\n'));
}

/**
 * 短预算预览：能写出来就写，写不出来就明说，绝不拖到宿主 8 秒超时。
 * 硬上限来自宿主（toolTimeoutMs 最大 8000），不是插件小气。
 */
export async function preview(ctx) {
  const settings = ctx.config() ?? {};
  const state = store.snapshot();
  try {
    const draft = await withinBudget(composeText(ctx, settings, store, {
      yesterday: String(settings.postTime ?? '') === '00:00',
      compact: true, timeoutMs: TOOL_BUDGET_MS - 800,
    }), TOOL_BUDGET_MS);
    if (draft === TIMED_OUT) {
      const last = latestDraft(state);
      return message([
        '【这次没写成】模型没在 5 秒内返回。宿主给聊天工具的单次调用上限是 8 秒，硬等会一直被掐断。',
        last ? `最近一条（${displayTime(last.at)}）：\n${last.text}` : '目前还没有草稿。',
        '两个更稳的办法：① 等每日计划到点自动写（那个预算 35 秒）；② 让我用「生成草稿」动作跑一次完整生成。',
      ].join('\n'));
    }
    const account = resolveAccount(ROOT, settings);
    let packetNote = '';
    if (account.wxid) {
      const value = buildPostPacket({account: account.wxid, text: draft.text});
      packetNote = selfCheck(value.packet, {account: account.wxid, text: draft.text, requestId: value.requestId})
        ? '（报文自检未通过）' : `（可编码为 ${value.packet.length} 字节报文）`;
    }
    const file = store.writeOutbox(draft.text, 'preview');
    return message(`【预览，未发布】\n${draft.text}\n\n${packetNote}\n已存到 ${file}`);
  } catch (error) {
    return message('预览没成功：' + error.message);
  }
}

/** 短预算生成定稿报文；写不出来就解释，不硬等。 */
export async function prepare(ctx) {
  const settings = ctx.config() ?? {};
  const state = store.snapshot();
  try {
    const outcome = await withinBudget(prepareProposal(ctx, settings, {
      compact: true, timeoutMs: TOOL_BUDGET_MS - 800,
    }), TOOL_BUDGET_MS);
    if (outcome === TIMED_OUT) {
      return message('【没生成完】模型没在 5 秒内返回，聊天工具上限 8 秒。\n可以等每日计划（35 秒预算）自动生成，或让我用「生成待授权材料」动作跑一次。');
    }
    const {proposal} = outcome;
    if (state.date !== today()) {
      state.date = today();
      state.count = 0;
    }
    store.push(state, {
      at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
      channel: 'outbox', status: 'prepared', proposalId: proposal.id, packetSha256: proposal.packetSha256,
    });
    store.save(state);
    return message('【已生成待授权材料，未发布】\n' + loaderHint(proposal));
  } catch (error) {
    return message('生成失败：' + error.message);
  }
}

/** 投递：需要 confirm=true；只投一次，失败不重发。这一步不调用模型，所以很快。 */
export async function publishNow(ctx, args = {}) {
  const settings = ctx.config() ?? {};
  const state = store.snapshot();
  if (args?.confirm !== true) {
    return message('这一步会真的发一条公开朋友圈，需要确认：请带 confirm=true 再执行。');
  }
  const limit = dailyLimit(settings);
  if (!args?.force && state.date === today() && state.count >= limit) {
    return message(`今天已经发够 ${limit} 条了。确实要再发一条，请带 force=true。`);
  }

  const channel = resolveChannel(settings);

  // 网关通道：先准备一条待发正文（用最近生成的那条，避免在工具里调模型）。
  if (channel === 'gateway' || (channel === 'auto' && !nativeState(settings).available)) {
    const last = latestDraft(state);
    if (!last) return message('还没有可发的正文：先让我 preview 或等每日计划写一条。');
    const result = await publishGateway(settings, last.text);
    state.lastError = result.ok ? '' : String(result.reason ?? '');
    if (result.ok) state.count += 1;
    store.push(state, {
      at: new Date().toISOString(), date: today(), text: last.text, hash: sha256(last.text),
      channel: 'gateway', status: result.ok ? 'accepted' : result.state ?? 'unknown',
      file: result.ok ? null : store.writeOutbox(last.text, 'failed'),
    });
    store.save(state);
    return message(result.ok ? `【网关已接收】以手机上的朋友圈为准\n\n${last.text}` : `【发布未确认】${result.reason ?? ''}\n\n${last.text}`);
  }

  const native = nativeState(settings);
  if (!native.available) {
    return message('发不出去：' + native.detail + '\n' + compatLine(ROOT) + '\n可用 diagnose 看完整诊断。');
  }
  const proposal = args?.proposalId
    ? store.readProposal(String(args.proposalId))
    : (() => {
      const pending = (state.history ?? []).slice().reverse().find(item => item.status === 'prepared' && item.proposalId);
      return pending ? store.readProposal(pending.proposalId) : null;
    })();
  if (!proposal) return message('没有找到待投递的提案：请先 prepare 生成一条。');
  if (proposal.packetSha256 !== native.session.approvedHash) {
    return message('这包正文不是组件本次加载授权的那一条。\n需要重新加载组件并把授权哈希设成：' + proposal.packetSha256);
  }
  if (state.attempted.includes(proposal.id)) {
    return message('这条已经尝试投递过，不允许重发（重发可能造成两条重复动态）。');
  }
  const result = await publishNativeAuto({root: ROOT, packet: proposal.packet, text: proposal.text});
  state.attempted = [...(state.attempted ?? []), proposal.id].slice(-40);
  if (result.ok) state.count += 1;
  state.lastError = result.ok ? '' : String(result.reason ?? result.detail ?? '');
  store.push(state, {
    at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
    channel: 'native', status: result.ok ? 'accepted' : result.state ?? 'unknown',
    proposalId: proposal.id, packetSha256: proposal.packetSha256, objectId: result.objectId ?? null,
  });
  store.save(state);
  if (!result.ok) return message(`【未确认发布】${result.reason ?? result.detail}\n不重发，请先在手机上核对。\n\n${proposal.text}`);
  return message(`【服务端已受理】对象 ID ${result.objectId}（仍需在手机上看一眼真实内容）\n\n${proposal.text}\n\n（这条走原生通道：发出后微信可能被服务端下线、登录提示「新设备」，重新扫码即可，不影响其它功能。）`);
}

/* ------------------------------------------------------------------ 不调模型：正文由聊天模型给 */

/**
 * 这台机器上模型单次要 30 秒以上，超出插件能拿到的任何预算（工具 8 秒 / 模型接口 25 秒）。
 * 所以最靠谱的用法是：聊天里模型自己写正文，插件只负责编码 + 落提案 + 投递。
 */
async function encodeText(settings, text) {
  const account = resolveAccount(ROOT, settings);
  if (!account.wxid) throw new Error('还没拿到微信号：请在插件设置里填 accountWxid，或在管理员设置里选好微信身份');
  const value = buildPostPacket({account: account.wxid, text});
  const problem = selfCheck(value.packet, {account: account.wxid, text: value.text, requestId: value.requestId});
  if (problem) throw new Error('报文自检未通过：' + problem);
  const proposal = store.writeProposal({
    account: account.wxid, text: value.text, visibility: 'public',
    packet: value.packet, requestId: value.requestId, created: value.created,
    sha256: value.sha256, timeline: value.timeline, coreSha256: SUPPORTED_CORE.coreSha256,
  });
  return {proposal, value, account};
}

function recordPrepared(state, proposal) {
  if (state.date !== today()) {
    state.date = today();
    state.count = 0;
  }
  store.push(state, {
    at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
    channel: 'outbox', status: 'prepared', proposalId: proposal.id, packetSha256: proposal.packetSha256,
  });
  store.save(state);
}

/** 工具：把给定正文编码成定稿报文（不调模型、不发布）。 */
export async function prepareText(ctx, args = {}) {
  const settings = ctx.config() ?? {};
  const text = String(args?.text ?? '');
  if (!text.trim()) return message('正文是空的：把要发的文字放进 text 参数。');
  try {
    const {proposal} = await encodeText(settings, text);
    recordPrepared(store.snapshot(), proposal);
    return message('【已编码，未发布】\n' + loaderHint(proposal) + '\n' + compatLine(ROOT));
  } catch (error) {
    return message('没编成：' + error.message);
  }
}

/** 工具：直接投递给定正文（不调模型）。确认后走网关或已授权的原生组件。 */
export async function publishText(ctx, args = {}) {
  const settings = ctx.config() ?? {};
  const text = String(args?.text ?? '');
  if (!text.trim()) return message('正文是空的：把要发的文字放进 text 参数。');
  if (args?.confirm !== true) return message('这一步会真的发一条公开朋友圈，需要 confirm=true。');
  try {
    const {proposal} = await encodeText(settings, text);
    const state = store.snapshot();
    let channel = resolveChannel(settings);
    if (channel === 'auto' && uiaStatus(ROOT).available) channel = 'uia';
    const native = nativeState(settings);

    if (channel === 'native' || (channel === 'auto' && native.available)) {
      if (!native.available) {
        recordPrepared(state, proposal);
        return message('发不出去，原因在通道，不在文案：' + native.detail + '\n' + compatLine(ROOT) + '\n正文已编码留存，通道打通后可以直接投递：\n' + loaderHint(proposal));
      }
      if (proposal.packetSha256 !== native.session.approvedHash) {
        recordPrepared(state, proposal);
        return message('这包正文不是组件本次加载授权的那一条。\n已留作待授权材料，加载时把授权哈希设成：' + proposal.packetSha256);
      }
      const result = await publishNativeAuto({root: ROOT, packet: proposal.packet, text: proposal.text});
      state.attempted = [...(state.attempted ?? []), proposal.id].slice(-40);
      if (result.ok) state.count += 1;
      state.lastError = result.ok ? '' : String(result.reason ?? result.detail ?? '');
      store.push(state, {
        at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
        channel: 'native', status: result.ok ? 'accepted' : result.state ?? 'unknown',
        proposalId: proposal.id, packetSha256: proposal.packetSha256, objectId: result.objectId ?? null,
      });
      store.save(state);
      return message(result.ok
        ? `【服务端已受理】对象 ID ${result.objectId}（仍需在手机上看一眼）\n\n${proposal.text}\n\n（这条走原生通道：发出后微信可能被服务端下线、登录提示「新设备」，重新扫码即可，不影响其它功能。）`
        : `【未确认发布】${result.reason ?? result.detail}\n不重发。\n\n${proposal.text}`);
    }

    if (channel === 'uia') {
      const ui = await publishViaUi({root: ROOT, text: proposal.text});
      state.lastError = ui.ok ? '' : String(ui.reason ?? '界面发布未确认');
      if (ui.ok) state.count += 1;
      store.push(state, {
        at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
        channel: 'uia', status: ui.ok ? 'accepted' : 'not-submitted',
        file: ui.ok ? null : store.writeOutbox(proposal.text, 'failed'),
        proposalId: proposal.id, packetSha256: proposal.packetSha256,
      });
      store.save(state);
      return message(ui.ok
        ? `【已点“发表”】界面操作完成，编辑窗口已关闭。\n最终以手机上的朋友圈为准。\n\n${proposal.text}`
        : `【没发出去】${ui.reason}\n\n${proposal.text}`);
    }

    const result = await publishGateway(settings, proposal.text);
    state.lastError = result.ok ? '' : String(result.reason ?? '');
    if (result.ok) state.count += 1;
    store.push(state, {
      at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
      channel: 'gateway', status: result.ok ? 'accepted' : result.state ?? 'unknown',
      file: result.ok ? null : store.writeOutbox(proposal.text, 'failed'),
      proposalId: proposal.id, packetSha256: proposal.packetSha256,
    });
    store.save(state);
    return message(result.ok ? `【网关已接收】以手机上的朋友圈为准\n\n${proposal.text}` : `【发布未确认】${result.reason ?? ''}\n\n${proposal.text}`);
  } catch (error) {
    return message('没发成：' + error.message);
  }
}

export async function diagnoseTool(ctx) {
  const settings = ctx.config() ?? {};
  try {
    const report = await withinBudget(diagnose({root: ROOT, settings}), TOOL_BUDGET_MS + 1500);
    if (report === TIMED_OUT) return message('诊断没跑完（要逐个算微信核心的哈希，太慢）。等下游空闲再试，或让我用「环境诊断」动作跑。');
    return message(formatReport(report));
  } catch (error) {
    return message('诊断失败：' + error.message);
  }
}

/* ------------------------------------------------------------------ 动作（35 秒预算） */

/** 动作：完整生成一条草稿进发件箱。 */
export async function draftAction(ctx) {
  const settings = ctx.config() ?? {};
  try {
    const draft = await composeText(ctx, settings, store, {compact: true, timeoutMs: ACTION_TIMEOUT_MS});
    const file = store.writeOutbox(draft.text, 'draft');
    const state = store.snapshot();
    if (state.date !== today()) {
      state.date = today();
      state.count = 0;
    }
    store.push(state, {at: new Date().toISOString(), date: today(), text: draft.text, hash: draft.hash, channel: 'outbox', status: 'draft', file});
    state.lastError = '';
    store.save(state);
    return {ok: true, file, text: draft.text};
  } catch (error) {
    return {ok: false, error: error.message};
  }
}

/** 动作：完整生成待授权材料。 */
export async function prepareAction(ctx) {
  const settings = ctx.config() ?? {};
  try {
    const {proposal} = await prepareProposal(ctx, settings, {compact: true, timeoutMs: ACTION_TIMEOUT_MS});
    const state = store.snapshot();
    if (state.date !== today()) {
      state.date = today();
      state.count = 0;
    }
    store.push(state, {
      at: new Date().toISOString(), date: today(), text: proposal.text, hash: sha256(proposal.text),
      channel: 'outbox', status: 'prepared', proposalId: proposal.id, packetSha256: proposal.packetSha256,
    });
    state.lastError = '';
    store.save(state);
    return {ok: true, proposalId: proposal.id, packetSha256: proposal.packetSha256, text: proposal.text};
  } catch (error) {
    return {ok: false, error: error.message};
  }
}

/** 动作：投递最近一条待授权提案（等同 publish-now，但没有 8 秒限制的顾虑）。 */
export async function publishAction(ctx, args = {}) {
  const value = await publishNow(ctx, {...args, confirm: true});
  return {ok: true, message: value?.content ?? ''};
}

export function setup(api) {
  api.onSchedule(daily);
  api.registerTool({
    id: 'status',
    description: '查看朋友圈发布状态：通道、原生组件是否在线、今天发了几条、最近一条正文与失败原因。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: status,
  });
  api.registerTool({
    id: 'preview',
    description: '写一条朋友圈草稿给你看，不发布。受聊天工具 8 秒上限约束，模型太慢时会如实说明并给出上一条。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: preview,
  });
  api.registerTool({
    id: 'prepare',
    description: '生成定稿报文并留作待授权材料，不发布。随后可直接用 publish-now 投递（组件会自动加载）。受 8 秒上限约束。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: prepare,
  });
  api.registerTool({
    id: 'publish-now',
    description: '把一条已授权提案真正发布出去（需 confirm=true）。会自动在微信进程里加载组件再投递，只投一次、失败不重发，不调用模型。',
    parameters: {
      type: 'object',
      properties: {
        proposalId: {type: 'string', description: 'prepare 返回的提案 ID，留空用最近一条待授权提案'},
        confirm: {type: 'boolean', description: '确认这是一条真实的公开动态'},
        force: {type: 'boolean', description: '无视当天发布上限'},
      },
      additionalProperties: false,
    },
    execute: publishNow,
  });
  api.registerTool({
    id: 'prepare-text',
    description: '把你自己写好的朋友圈正文编码成定稿报文并留作待授权材料（不调模型、不发布）。正文太长或含控制字符会被拒绝。',
    parameters: {
      type: 'object',
      properties: {text: {type: 'string', description: '要发的正文，1～2000 字'}},
      required: ['text'],
      additionalProperties: false,
    },
    execute: prepareText,
  });
  api.registerTool({
    id: 'publish-text',
    description: '把你自己写好的正文直接发出去（不调模型，需 confirm=true）。会自动加载组件并投递；通道不可用时才编码留存并说明原因。',
    parameters: {
      type: 'object',
      properties: {
        text: {type: 'string', description: '要发的正文'},
        confirm: {type: 'boolean', description: '确认这是一条真实的公开动态'},
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: publishText,
  });
  api.registerTool({
    id: 'diagnose',
    description: '诊断本机能否真正发朋友圈：微信核心版本与哈希、组件会话、网关可用性，并给结论。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: diagnoseTool,
  });

  // 慢动作放这里：宿主给 action 35 秒，够模型写完一条。
  api.registerAction({
    id: 'prepare-text',
    description: '把传入正文编码成定稿报文（不调模型，毫秒级）。',
    parameters: {
      type: 'object',
      properties: {text: {type: 'string', description: '要编码的正文'}},
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (ctx, args = {}) => {
      const value = await prepareText(ctx, args);
      return {ok: !String(value?.content ?? '').startsWith('没编成'), message: value?.content ?? ''};
    },
  });
  api.registerAction({
    id: 'publish-text',
    description: '把传入正文直接投递（自动确认，不调模型）。',
    parameters: {
      type: 'object',
      properties: {text: {type: 'string', description: '要发的正文'}},
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (ctx, args = {}) => {
      const value = await publishText(ctx, {...args, confirm: true});
      return {ok: true, message: value?.content ?? ''};
    },
  });
  api.registerAction({
    id: 'draft',
    description: '完整生成一条朋友圈草稿并存入发件箱（35 秒预算，不发布）。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: draftAction,
  });
  api.registerAction({
    id: 'prepare',
    description: '完整生成定稿报文与待授权材料（35 秒预算，不发布）；要发继续调 publish-now。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: prepareAction,
  });
  api.registerAction({
    id: 'publish',
    description: '投递最近一条待授权提案（等同 publish-now 且自动确认）。',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: publishAction,
  });
}

export const hooks = {};
export function dispose() {}
