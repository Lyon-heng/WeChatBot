// 发布通道：原生组件（小鱼方案）/ 协议网关 / 发件箱。
// 共同原则：
//   1. 不自动重试——发出去就是一条真实的公开动态，重试等于可能发两条；
//   2. 不把“已存发件箱”说成“已发布”；
//   3. 服务端返回对象 ID 也只算“已受理”，真实内容要另做回读核对。
import {MomentsComponent, loadSession, verifyDll} from './native-client.mjs';
import {loadComponent} from './native-loader.mjs';
import {activeAccount} from './diagnose.mjs';
import {checkBreaker, recordAttempt, recordFailure, recordSuccess} from './breaker.mjs';
import path from 'node:path';
import {parseObject, timelineText, sha256} from './protocol.mjs';

const TIMEOUT = 8000;
const MAX_BODY = 800 * 1024;

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, '') + '/' + String(suffix || '').replace(/^\/+/, '');
}

async function request(url, options = {}) {
  const {timeout = TIMEOUT, ...rest} = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {...rest, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

function responseOk(status, payload) {
  if (status < 200 || status >= 300) return false;
  if (!payload || typeof payload !== 'object') return true;
  if (payload.Success === true || payload.success === true || payload.ok === true) return true;
  if (payload.Success === false || payload.success === false || payload.ok === false) return false;
  const good = new Set([0, 200, 1000]);
  for (const key of ['ret', 'code', 'errcode', 'status', 'Code']) {
    const value = payload[key];
    if (typeof value === 'number' && !good.has(value)) return false;
  }
  return true;
}

/** 网关探测：只探一次，失败也如实返回，不当成错误。timeout 要小——它是在聊天工具 8 秒预算里跑的。 */
export async function probeGateway(settings, {timeout = 2500} = {}) {
  const base = String(settings.gatewayUrl || '').trim();
  if (!base) return {configured: false, reachable: false, detail: '未填写网关地址'};
  let url;
  try {
    url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('地址必须以 http/https 开头');
  } catch (error) {
    return {configured: true, reachable: false, detail: '地址无效：' + error.message};
  }
  const headers = settings.gatewayToken ? {authorization: 'Bearer ' + String(settings.gatewayToken).trim()} : {};
  try {
    const response = await request(base.replace(/\/+$/, '') + '/', {method: 'GET', headers, timeout});
    return {configured: true, reachable: true, status: response.status, detail: '网关有响应（HTTP ' + response.status + '）'};
  } catch (error) {
    return {configured: true, reachable: false, detail: '连不上：' + (error.name === 'AbortError' ? '超时' : error.message)};
  }
}

/**
 * 全自动原生投递：先加载组件（授权本次这一包）再提交。
 * 组件一次加载只认一包，所以每条都要重新加载——这是防重发设计，不绕过。
 */
export async function publishNativeAuto({root, packet, text, port = 0}) {  // port 0 = 让组件自己确定并回报
  // 1) 频率闸门：限速、日限、冷却。挡住的都是"现在不该发"，不是"发不了"。
  const gate = checkBreaker(root);
  if (!gate.ok) {
    return {ok: false, channel: 'native', state: 'blocked', reason: gate.reason, retryAt: gate.retryAt};
  }

  const wxid = activeAccount()?.wxid ?? '';
  const loaded = await loadComponent({root, packet, wxid, port});
  if (!loaded.ok) {
    return {ok: false, channel: 'native', state: 'not-submitted', reason: '组件加载失败：' + loaded.detail};
  }
  const {session, reason} = loadSession(path.join(root, 'state/moments-native/session.json'));
  if (!session) return {ok: false, channel: 'native', state: 'not-submitted', reason: reason || '会话无效'};

  // 2) 掉线识别：上次发成功后 15 分钟内微信进程变了，说明发完被重启/踢了——这一条不发。
  const attempt = recordAttempt(root, {pid: session.pid});
  if (!attempt.ok) {
    return {ok: false, channel: 'native', state: 'blocked', reason: attempt.reason, retryAt: attempt.retryAt};
  }

  const result = await publishNative({session, packet, text});
  if (result.ok) {
    recordSuccess(root, {pid: session.pid, objectId: result.objectId || ''});
  } else if (result.state !== 'not-submitted') {
    // 已经派发出去的失败才算数；加载失败/授权不对不算发布失败
    recordFailure(root, {pid: session.pid, reason: result.reason || result.detail || result.state});
  }
  return result;
}

export function resolveChannel(settings) {
  const channel = String(settings.channel || 'auto');
  if (['native', 'gateway', 'outbox', 'uia', 'auto'].includes(channel)) return channel;
  if (String(settings.gatewayUrl || '').trim()) return 'gateway';
  return 'outbox';
}

/**
 * 原生通道：把已授权的报文交给已在微信进程里加载的组件。
 * 组件一次加载只认一条正文，所以这里不做任何“重试 / 换正文 / 换通道”的兜底。
 */
export async function publishNative({session, packet, text}) {
  const dll = verifyDll(session);
  if (!dll.ok) return {ok: false, channel: 'native', state: 'not-submitted', reason: dll.detail};
  if (sha256(packet) !== session.approvedHash) {
    return {ok: false, channel: 'native', state: 'not-submitted', reason: '这包正文不是组件本次加载授权的那一条'};
  }
  const client = new MomentsComponent(session);
  try {
    const reply = await client.submit(packet);
    const accepted = reply.state === 'server-accepted' && reply.ret === 0
      && /^[1-9][0-9]{0,19}$/.test(String(reply.objectId ?? ''))
      && BigInt(reply.objectId) <= 0xffffffffffffffffn;
    const state = accepted ? 'accepted'
      : reply.state === 'not-submitted' ? 'not-submitted'
      : reply.state === 'server-rejected' ? 'rejected' : 'unknown';
    return {
      ok: accepted,
      channel: 'native',
      state,
      objectId: accepted ? String(reply.objectId) : null,
      detail: accepted ? '服务端已受理并返回对象 ID；真实内容仍需在手机核对'
        : reply.state === 'submitted'
          ? '已派发给微信网络层，但没有等到服务端回执（任务完成=' + (reply.completed ?? '?') +
            '，释放=' + (reply.destroyed ?? '?') + '）。常见原因是限流或超时：先在手机核对时间线，不要直接重发。'
          : '未确认发布成功，请先核对再说，不重发',
      raw: {ret: reply.ret, state: reply.state, submitted: reply.submitted,
        completed: reply.completed, destroyed: reply.destroyed, respBytes: reply.respBytes},
    };
  } catch (error) {
    return {ok: false, channel: 'native', state: 'unknown', reason: error.message};
  }
}

/**
 * 回读核对：按 objectId 拉回线上那条，比对账号与正文是否与提案一致。
 * 组件只放行“加载时授权的那一包”，所以回读也必须用一次只读会话（operation=detail）：
 * 提交只读报文 -> GET /object 取回响应字节 -> 解析 TimelineObject。
 */
export async function readBack({session, packet, objectId, text, account}) {
  if (session.operation !== 'detail') {
    return {ok: false, detail: '当前是发布会话，不能回读；核对线上内容需另开一次只读会话'};
  }
  const health = verifyDll(session);
  if (!health.ok) return {ok: false, detail: health.detail};
  const client = new MomentsComponent(session);
  try {
    await client.submit(packet);
    const raw = await client.object();
    const hex = String(raw?.protobufHex ?? '');
    if (!hex) return {ok: false, detail: '组件没有返回回读数据'};
    const object = parseObject(Buffer.from(hex, 'hex'));
    const body = timelineText(object.timeline);
    const matched = body === text;
    return {
      ok: object.objectId === objectId && matched,
      objectId: object.objectId,
      username: object.username,
      matched,
      accountMatched: object.username === account,
      detail: matched ? '线上内容与提案一致' : '线上内容与提案不一致，请人工确认',
    };
  } catch (error) {
    return {ok: false, detail: '回读失败：' + error.message};
  }
}

export async function publishGateway(settings, text) {
  const base = String(settings.gatewayUrl || '').trim();
  if (!base) return {ok: false, channel: 'gateway', state: 'not-submitted', reason: '未配置网关地址'};
  const format = String(settings.gatewayFormat || 'wechatpadpro');
  const token = String(settings.gatewayToken || '').trim();
  let endpoint = joinUrl(base, settings.gatewayPath || '/sns/SendFriendCircle');
  const headers = {'content-type': 'application/json'};
  let body;
  if (format === 'wechatpadpro') {
    if (token) endpoint += (endpoint.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(token);
    body = JSON.stringify({Content: text, Privacy: Number(settings.gatewayPrivacy ?? 0) === 1 ? 1 : 0});
  } else {
    if (token) headers.authorization = 'Bearer ' + token;
    body = JSON.stringify({content: text});
  }
  try {
    const response = await request(endpoint, {method: 'POST', headers, body});
    const raw = await response.text();
    let payload = null;
    if (raw && raw.length <= MAX_BODY) {
      try { payload = JSON.parse(raw); } catch {}
    }
    if (responseOk(response.status, payload)) {
      return {ok: true, channel: 'gateway', state: 'accepted', detail: '网关已接收（是否真实发布以手机上的朋友圈为准）'};
    }
    return {
      ok: false, channel: 'gateway', state: 'rejected',
      reason: 'HTTP ' + response.status + (raw ? ' · ' + raw.slice(0, 160) : ''),
    };
  } catch (error) {
    return {ok: false, channel: 'gateway', state: 'unknown', reason: error.name === 'AbortError' ? '请求超时' : error.message};
  }
}

export function describeChannels(settings, {native, gateway}) {
  const channel = resolveChannel(settings);
  if (channel === 'outbox') return '当前通道：发件箱（只写稿不发布）。';
  if (channel === 'native') return native.available ? `当前通道：原生组件 — ${native.detail}` : `当前通道：原生组件，但${native.detail}。`;
  if (channel === 'auto') return '当前通道：自动（界面通道可用时优先用它，其次原生组件，再次网关，最后发件箱）。';
  if (channel === 'uia') return '当前通道：界面操作（长按相机 → 粘贴 → 点发表；不注入、不会让微信退出）。';
  if (channel === 'gateway') return gateway.reachable ? `当前通道：协议网关 ${String(settings.gatewayUrl).trim()}（${gateway.detail}）` : `当前通道：协议网关，但${gateway.detail}。`;
  return '当前通道：自动（有原生组件走原生，其次网关，最后发件箱）';
}
