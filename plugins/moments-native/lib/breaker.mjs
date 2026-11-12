// 原生通道熔断器：把"发帖"这件事限速，并在出现被踢迹象时自动停手。
// 起因：2026-11-11 20:54 一条投递返回 ret=0 后，账号在同分钟被服务端下线（login_configv2 被重写），
// 客户端退回登录页并提示"此设备首次登录"，但进程并未崩溃（无 dump、钩子日志无重启记录）。
// 结论：这是风控，不是代码 bug。所以限制的是"频率与时机"，不是"能不能发"。
//
// 纯本地状态文件，不发网络请求、不改微信进程。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  minIntervalMinutes: 30,        // 两条之间至少隔这么久
  maxPerDay: 5,                  // 每天上限
  failuresBeforeCooldown: 2,     // 连续失败几次进入冷却
  cooldownHours: 6,              // 冷却时长
  sessionLossWindowMinutes: 15,  // 上次成功后这么久之内 pid 变了 → 判定"发帖后被重启/踢下线"
});

export function stateFile(root) {
  return path.join(root, 'state/moments-native/breaker.json');
}

function read(root) {
  const file = stateFile(root);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {schema: 1, history: [], ...data, limits: {...DEFAULTS, ...(data.limits || {})}};
  } catch {
    return {schema: 1, history: [], limits: {...DEFAULTS}};
  }
}

function write(root, data) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const minutes = ms => Math.round(ms / 60000);
const asTime = value => (value ? new Date(value).getTime() : 0);

function dayKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

/** 只读检查：现在能不能发。 */
export function checkBreaker(root, now = Date.now()) {
  const data = read(root);
  const {limits} = data;

  if (data.cooldownUntil && asTime(data.cooldownUntil) > now) {
    return {
      ok: false, state: 'cooldown', retryAt: data.cooldownUntil,
      reason: `熔断冷却中，${minutes(asTime(data.cooldownUntil) - now)} 分钟后才能再试（原因：${data.cooldownReason || '未知'}）`,
    };
  }

  // 间隔按「最近一次尝试或最近一次成功」里更晚的那个算，避免只发成功没记尝试时漏挡
  const last = Math.max(asTime(data.lastAttemptAt), asTime(data.lastSuccessAt));
  if (last) {
    const waitMs = limits.minIntervalMinutes * 60000 - (now - last);
    if (waitMs > 0) {
      return {
        ok: false, state: 'too-soon', retryAt: new Date(last + limits.minIntervalMinutes * 60000).toISOString(),
        reason: `距离上一条才 ${minutes(now - last)} 分钟，至少要隔 ${limits.minIntervalMinutes} 分钟`,
      };
    }
  }

  const today = dayKey(new Date(now).toISOString());
  const sentToday = (data.history || []).filter(item => item.result === 'accepted' && dayKey(item.at) === today).length;
  if (sentToday >= limits.maxPerDay) {
    return {ok: false, state: 'daily-cap', reason: `今天已经发了 ${sentToday} 条，达到上限 ${limits.maxPerDay}`};
  }

  return {ok: true, state: 'ready', sentToday, limits};
}

/**
 * 准备这一次尝试：记下时间与当前微信 pid，并判定"上次发完是不是被重启/踢了"。
 * 判定为"被踢"时直接拦住，不发这一条。
 */
export function recordAttempt(root, {pid = 0} = {}, now = Date.now()) {
  const data = read(root);
  const {limits} = data;

  if (data.lastSuccessPid && pid && pid !== data.lastSuccessPid) {
    const sinceSuccess = now - asTime(data.lastSuccessAt);
    if (sinceSuccess >= 0 && sinceSuccess <= limits.sessionLossWindowMinutes * 60000) {
      data.cooldownUntil = new Date(now + limits.cooldownHours * 3600000).toISOString();
      data.cooldownReason = `上次发布成功后 ${minutes(sinceSuccess)} 分钟内微信进程就变了（${data.lastSuccessPid} → ${pid}），判定为发布后掉线`;
      write(root, data);
      return {ok: false, state: 'session-lost', reason: data.cooldownReason, retryAt: data.cooldownUntil};
    }
  }

  data.lastAttemptAt = new Date(now).toISOString();
  data.lastAttemptPid = pid;
  write(root, data);
  return {ok: true};
}

export function recordSuccess(root, {pid = 0, objectId = ''} = {}, now = Date.now()) {
  const data = read(root);
  data.lastSuccessAt = new Date(now).toISOString();
  data.lastSuccessPid = pid;
  data.consecutiveFailures = 0;
  data.history = [...(data.history || []), {at: data.lastSuccessAt, result: 'accepted', pid, objectId}].slice(-50);
  write(root, data);
  return data;
}

export function recordFailure(root, {pid = 0, reason = ''} = {}, now = Date.now()) {
  const data = read(root);
  const {limits} = data;
  data.consecutiveFailures = (data.consecutiveFailures || 0) + 1;
  data.history = [...(data.history || []), {at: new Date(now).toISOString(), result: 'failed', pid, reason: String(reason).slice(0, 120)}].slice(-50);
  if (data.consecutiveFailures >= limits.failuresBeforeCooldown) {
    data.cooldownUntil = new Date(now + limits.cooldownHours * 3600000).toISOString();
    data.cooldownReason = `连续 ${data.consecutiveFailures} 次未确认成功：${String(reason).slice(0, 80)}`;
  }
  write(root, data);
  return data;
}

/** 人工解除熔断（比如确认账号已恢复、想立刻发一条）。 */
export function resetBreaker(root) {
  const data = read(root);
  delete data.cooldownUntil;
  delete data.cooldownReason;
  data.consecutiveFailures = 0;
  write(root, data);
  return data;
}

// 命令行：node lib/breaker.mjs <workspace> [--reset]
if (process.argv[1] && process.argv[1].endsWith('breaker.mjs')) {
  const root = process.argv[2];
  if (!root) {
    console.error('用法: node lib/breaker.mjs <workspace> [--reset]');
    process.exit(1);
  }
  if (process.argv.includes('--reset')) {
    console.log(JSON.stringify(resetBreaker(root), null, 2));
  } else {
    console.log(JSON.stringify({gate: checkBreaker(root), state: read(root)}, null, 2));
  }
}
