// muse2api 网关进程控制：定位部署目录、后台启动（uvicorn，与 start-muse2api.cmd 同参）、
// 停止（按端口找 PID，校验进程确属 muse2api 后再杀整棵树）。
// 供网页下单台（server.mjs 的 启动/停止 按钮）与插件启动钩子（随微信服务自动拉起）共用。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settingsCodec } from '../../../packages/plugin-api/settings-protection.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const run = (command, timeoutMs = 15000) => new Promise(resolve => {
  exec(command, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') });
  });
});

/** 与 start-muse2api.cmd 相同的候选顺序：已有定制部署优先。pythonw 用于后台静默启动（不创建控制台窗口）。 */
export function locateInstall(root) {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'muse2api'),
    path.resolve(root, '../../muse2api'),
    path.resolve(root, '../muse2api'),
  ];
  for (const dir of candidates) {
    for (const venv of ['venv', '.venv']) {
      const python = path.join(dir, venv, 'Scripts', 'python.exe');
      if (fs.existsSync(python) && fs.existsSync(path.join(dir, 'app.py'))) {
        const pythonw = path.join(dir, venv, 'Scripts', 'pythonw.exe');
        return { dir, python, pythonw: fs.existsSync(pythonw) ? pythonw : python };
      }
    }
  }
  return null;
}

export function endpointParts(endpoint) {
  try {
    const url = new URL(String(endpoint || 'http://127.0.0.1:18610'));
    return { host: url.hostname || '127.0.0.1', port: Number(url.port) || 18610 };
  } catch {
    return { host: '127.0.0.1', port: 18610 };
  }
}

/** 直接探测 /healthz（不需要 API Key，启动按钮在 Key 未配置时也要能用）。 */
export async function probe(endpoint, timeoutMs = 4000) {
  const { host, port } = endpointParts(endpoint);
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return { online: response.ok, status: response.status };
  } catch (error) {
    return { online: false, reason: String(error?.message ?? error) };
  }
}

function log(root, message) {
  try {
    const file = path.join(root, 'state/logs/muse-gateway.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, new Date().toISOString() + ' ' + message + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 启动网关。已在线时直接返回；启动后轮询 /healthz 直到就绪或超时。 */
export async function startGateway({ endpoint, root, waitMs = 45000 } = {}) {
  const { host, port } = endpointParts(endpoint);
  const first = await probe(endpoint, 3000);
  if (first.online) return { started: false, online: true, reason: '网关已在运行' };

  const install = locateInstall(root);
  if (!install) {
    const error = Object.assign(Error('MUSE2API_NOT_FOUND'), { code: 'MUSE2API_NOT_FOUND' });
    throw error;
  }

  const logFile = path.join(root, 'state/logs/muse-gateway-stdout.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  let fd;
  try { fd = fs.openSync(logFile, 'a'); } catch { fd = 'ignore'; }

  // 用 pythonw（GUI 子系统）静默启动：venv 的 python.exe 启动器会再派生真正的
  // python.exe 并新开一个控制台窗口，windowsHide 拦不住；pythonw 从不创建控制台。
  const child = spawn(install.pythonw, ['-m', 'uvicorn', 'app:app', '--host', host, '--port', String(port)], {
    cwd: install.dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  child.unref();
  log(root, `start: pid=${child.pid} dir=${install.dir} port=${port}`);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 900));
    const state = await probe(endpoint, 2500);
    if (state.online) return { started: true, online: true, pid: child.pid, dir: install.dir, port };
    // 进程秒退（比如端口被占、依赖损坏）时不要干等满 45 秒。
    try { if (child.exitCode !== null && child.pid) break; } catch { /* 回退继续轮询端口 */ }
  }
  return { started: false, online: false, reason: '启动命令已发出，但 45 秒内 /healthz 仍未就绪；详见 state/logs/muse-gateway-stdout.log' };
}

async function listeningPid(port) {
  const { stdout } = await run('netstat -ano -p tcp');
  for (const line of stdout.split(/\r?\n/)) {
    const match = new RegExp('^\\s*TCP\\s+127\\.0\\.0\\.1:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$', 'i').exec(line);
    if (match) return Number(match[1]);
  }
  return 0;
}

async function processInfo(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}') | Select-Object -First 1 Name,CommandLine | ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell -NoProfile -Command "' + script.replace(/"/g, '\\"') + '"');
  try { return JSON.parse(stdout); } catch { return null; }
}

/** 停止网关：按端口定位 PID，校验确属 muse2api 的 python 进程后杀整棵树。 */
export async function stopGateway({ endpoint, root } = {}) {
  const { port } = endpointParts(endpoint);
  const pid = await listeningPid(port);
  if (!pid) return { stopped: false, reason: '端口 ' + port + ' 上没有监听的进程，网关本来就没在运行。' };

  const info = await processInfo(pid);
  const name = String(info?.Name ?? '');
  const commandLine = String(info?.CommandLine ?? '');
  if (!/python/i.test(name) || !/muse2api|uvicorn|app[.:]app/i.test(commandLine)) {
    throw Object.assign(
      Error('端口 ' + port + ' 被 ' + (name || '未知进程') + ' (PID ' + pid + ') 占用，且不是 muse2api 的进程；为安全起见未执行停止，请手动处理。'),
      { code: 'MUSE_STOP_REFUSED' },
    );
  }

  const { stderr } = await run('taskkill /PID ' + pid + ' /T /F', 20000);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await listeningPid(port))) {
      log(root, `stop: pid=${pid} ok`);
      return { stopped: true, pid };
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw Object.assign(Error('停止命令已执行但端口仍被占用：' + (stderr || 'taskkill 返回异常')), { code: 'MUSE_STOP_UNCONFIRMED' });
}

/** 读取控制台里保存的 muse-video 配置（兼容 v2 DPAPI 加密与明文 v1）。 */
export function readPluginConfig(root) {
  try {
    const file = path.join(root, 'config/plugins.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    let decoded;
    try { decoded = settingsCodec.decode(raw); } catch { decoded = raw; }
    return decoded?.plugins?.['muse-video'] ?? {};
  } catch {
    return {};
  }
}

const pluginEndpoint = root => String(readPluginConfig(root)?.settings?.endpoint || 'http://127.0.0.1:18610');

/* ---------------- 管理页（等价于 open-muse-admin.cmd） ---------------- */

/** 依次读取 muse2api 部署目录的 .env，与 start-muse2api.cmd / open-muse-admin.cmd 同一套候选位置。 */
export function readMuseEnv(root) {
  const files = [
    path.join(os.homedir(), 'muse2api/.env'),
    path.resolve(String(root ?? ''), '../../muse2api/.env'),
    path.resolve(String(root ?? ''), '../muse2api/.env'),
  ];
  for (const file of files) {
    try {
      const result = {};
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
      return result;
    } catch { /* 试下一个候选位置 */ }
  }
  return {};
}

/** API Key 解析顺序与下单台一致：环境变量 > 控制台插件设置 > muse2api 的 .env。 */
export function resolveApiKey(root) {
  const settings = readPluginConfig(root)?.settings ?? {};
  return String(process.env.MUSE2API_KEY || settings.apiKey || readMuseEnv(root).MUSE2API_KEY || '').trim();
}

const maskKey = key => (key ? key.slice(0, 6) + '***' : '');

/**
 * 管理页地址。`url` 带 Key，只允许在本机服务端进程内使用（不要在接口响应里下发）；
 * 对外一律给 `masked` 版本。
 */
export function adminUrl({ root, endpoint } = {}) {
  const target = String(endpoint || pluginEndpoint(root));
  const { host, port } = endpointParts(target);
  const base = 'http://' + host + ':' + port + '/admin';
  const key = resolveApiKey(root);
  return { base, key, hasKey: !!key, url: key ? base + '?key=' + encodeURIComponent(key) : base, masked: key ? base + '?key=' + maskKey(key) : base };
}

/**
 * 等价于 open-muse-admin.cmd：网关没起就先拉起，然后用默认浏览器打开带 Key 的管理页。
 * 不把 Key 返回给调用方，只返回打码后的地址。
 */
export async function openAdmin({ root, endpoint, startIfOffline = true } = {}) {
  const target = String(endpoint || pluginEndpoint(root));
  const admin = adminUrl({ root, endpoint: target });
  const base = { online: false, opened: false, started: false, hasKey: admin.hasKey, admin: admin.masked };
  let state = await probe(target, 3000);
  if (!state.online && startIfOffline) {
    try {
      const result = await startGateway({ endpoint: target, root, waitMs: 30000 });
      state = { online: !!result.online, reason: result.reason };
      base.started = !!result.started;
    } catch (error) {
      return { ...base, error: String(error?.code ?? error?.message ?? error), reason: '启动 muse2api 失败：' + String(error?.message ?? error) };
    }
  }
  if (!state.online) {
    return { ...base, reason: 'muse2api 未运行：' + String(state.reason || '请先启动服务') };
  }
  base.online = true;
  if (process.platform !== 'win32') {
    return { ...base, reason: '当前系统不是 Windows，请手动在浏览器打开 ' + admin.base };
  }
  try {
    // 与 server.mjs 打开工作台同一套做法：cmd 的 start 交给默认浏览器，不占用本进程。
    exec('start "" "' + admin.url + '"', { shell: 'cmd.exe' }, () => {});
  } catch (error) {
    return { ...base, reason: '打开浏览器失败：' + String(error?.message ?? error) };
  }
  base.opened = true;
  log(root, 'open-admin: ' + admin.masked);
  return base;
}

/* ---------------- 网页工作台（server.mjs，18760） ---------------- */

export const STUDIO_PORT_DEFAULT = 18760;
export function studioPort() {
  const n = Number(process.env.MUSE_STUDIO_PORT);
  return Number.isInteger(n) && n > 1024 && n < 65536 ? n : STUDIO_PORT_DEFAULT;
}

/** 探测网页工作台：/api/state 返回 200 即在线（只绑本机，无需鉴权）。 */
export async function probeStudio(port = studioPort()) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3500) });
    return { online: response.ok, status: response.status };
  } catch (error) {
    return { online: false, reason: String(error?.message ?? error) };
  }
}

/** 启动网页工作台（detached node server.mjs；它自己会按设置自动拉起网关）。 */
export async function startStudio({ root, port = studioPort(), waitMs = 20000 } = {}) {
  const before = await probeStudio(port);
  if (before.online) return { started: false, online: true, port, reason: '网页工作台已在运行' };
  const entry = path.join(MODULE_DIR, '..', 'server.mjs');
  if (!fs.existsSync(entry)) throw Object.assign(Error('找不到网页工作台入口 server.mjs'), { code: 'MUSE_STUDIO_ENTRY_MISSING' });
  const logFile = path.join(root, 'state/logs/muse-studio-stdout.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  let fd;
  try { fd = fs.openSync(logFile, 'a'); } catch { fd = 'ignore'; }
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    // 宿主是 Electron（wechatwb.exe）时 execPath 不是 node：加官方开关让它以纯
    // node 模式运行 server.mjs；真 node 会忽略该变量，两种环境都正确。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  log(root, `start-studio: pid=${child.pid} port=${port}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 800));
    const state = await probeStudio(port);
    if (state.online) return { started: true, online: true, pid: child.pid, port };
    try { if (child.exitCode !== null && child.pid) break; } catch { /* 继续轮询端口 */ }
  }
  return { started: false, online: false, port, reason: '启动命令已发出，但工作台端口仍未就绪；详见 state/logs/muse-studio-stdout.log' };
}

/** 停止网页工作台：按端口找 PID，校验确属本插件的 node server.mjs。 */
export async function stopStudio({ root, port = studioPort() } = {}) {
  const pid = await listeningPid(port);
  if (!pid) return { stopped: false, reason: '端口 ' + port + ' 上没有监听的进程，网页工作台本来就没在运行。' };
  const info = await processInfo(pid);
  const name = String(info?.Name ?? '');
  const commandLine = String(info?.CommandLine ?? '').replace(/"/g, '');
  // Electron 宿主下工作台进程名可能是 wechatwb.exe / electron.exe（ELECTRON_RUN_AS_NODE
  // 模式），真 node 环境下是 node.exe；命令行含 muse-video\server.mjs 是硬标识。
  if (!/node|wechatwb|electron/i.test(name) || !/muse-video[\\/]server\.mjs/i.test(commandLine)) {
    throw Object.assign(
      Error('端口 ' + port + ' 被 ' + (name || '未知进程') + ' (PID ' + pid + ') 占用，且不是 Muse 视频工作台；为安全起见未执行停止。'),
      { code: 'MUSE_STOP_REFUSED' },
    );
  }
  const { stderr } = await run('taskkill /PID ' + pid + ' /T /F', 20000);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await listeningPid(port))) {
      log(root, `stop-studio: pid=${pid} ok`);
      return { stopped: true, pid };
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw Object.assign(Error('停止命令已执行但端口仍被占用：' + (stderr || 'taskkill 返回异常')), { code: 'MUSE_STOP_UNCONFIRMED' });
}

/* ---------------- 聚合：控制台插件卡片上的 启动/停止 按钮 ---------------- */

/** 一键启动全部 muse 服务：先网关（失败不阻断），再网页工作台（其设置也会自动带网关）。 */
export async function startMuseServices({ root } = {}) {
  const endpoint = pluginEndpoint(root);
  const results = { action: 'start', endpoint };
  try {
    results.gateway = await startGateway({ endpoint, root, waitMs: 30000 });
  } catch (error) {
    results.gateway = { started: false, online: false, reason: String(error?.code ?? error?.message ?? error) };
  }
  try {
    results.studio = await startStudio({ root });
  } catch (error) {
    results.studio = { started: false, online: false, reason: String(error?.code ?? error?.message ?? error) };
  }
  return results;
}

/** 一键停止全部 muse 服务：先停工作台（避免它再拉起网关），再停网关。 */
export async function stopMuseServices({ root } = {}) {
  const endpoint = pluginEndpoint(root);
  const results = { action: 'stop', endpoint };
  try {
    results.studio = await stopStudio({ root });
  } catch (error) {
    results.studio = { stopped: false, reason: String(error?.code ?? error?.message ?? error) };
  }
  try {
    results.gateway = await stopGateway({ endpoint, root });
  } catch (error) {
    results.gateway = { stopped: false, reason: String(error?.code ?? error?.message ?? error) };
  }
  return results;
}

/** 控制台卡片状态：网关 + 工作台在线情况与部署目录。 */
export async function serviceStatus({ root } = {}) {
  const endpoint = pluginEndpoint(root);
  const [gateway, studio] = await Promise.all([probe(endpoint, 2500), probeStudio()]);
  const install = locateInstall(root);
  return {
    endpoint,
    gateway: { online: gateway.online, reason: gateway.online ? '' : String(gateway.reason ?? '离线') },
    studio: { online: studio.online, port: studioPort() },
    install: install ? { dir: install.dir } : null,
  };
}

/**
 * 插件侧随微信服务自动启动：网页工作台 + muse2api 网关（都只在未运行时拉起）。
 * 顺序：先拉工作台（它自己的启动回调会延迟拉起网关），再轮询等网关；
 * 网关若迟迟未起再直接兜底拉起。全部幂等，已在线即跳过。
 * 供插件 setup() fire-and-forget 调用，不抛错。
 */
export async function autoStartServices({ root, delayMs = 4000, settingsOverride } = {}) {
  const decision = { attempted: false, reason: '', studioStarted: false, gatewayStarted: false };
  try {
    const config = readPluginConfig(root);
    const settings = settingsOverride ?? config.settings ?? {};
    if (config.enabled !== true) { decision.reason = '插件未启用'; return decision; }
    if (settings.autoStartGateway === false) { decision.reason = '设置里关闭了随服务自动启动'; return decision; }

    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

    // 1) 网页工作台（幂等；其启动回调会按需拉起网关）
    const studioBefore = await probeStudio();
    if (!studioBefore.online) {
      const result = await startStudio({ root });
      decision.studioStarted = !!result.started;
      if (!result.online) decision.reason = '工作台启动未确认：' + String(result.reason ?? '');
    }

    // 2) 网关：先给工作台的回调留几秒，没起来再自己兜底
    const endpoint = String(settings.endpoint || 'http://127.0.0.1:18610');
    let gatewayOnline = (await probe(endpoint, 2000)).online;
    if (!gatewayOnline && decision.studioStarted) {
      for (let i = 0; i < 8 && !gatewayOnline; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        gatewayOnline = (await probe(endpoint, 2000)).online;
      }
    }
    if (!gatewayOnline) {
      const result = await startGateway({ endpoint, root, waitMs: 30000 });
      decision.gatewayStarted = !!result.started;
      gatewayOnline = !!result.online;
      if (!gatewayOnline && !decision.reason) decision.reason = '网关启动未确认：' + String(result.reason ?? '');
    }

    decision.attempted = decision.studioStarted || decision.gatewayStarted;
    if (!decision.reason) decision.reason = decision.attempted ? '已自动启动' : '两个服务均已在运行';
    log(root, `auto-start-services: ${decision.reason} (studio=${decision.studioStarted}, gateway=${decision.gatewayStarted})`);
    return decision;
  } catch (error) {
    const reason = String(error?.code ?? error?.message ?? error);
    log(root, 'auto-start-services failed: ' + reason);
    return { attempted: false, reason, studioStarted: false, gatewayStarted: false, error: true };
  }
}

/**
 * 插件启用且设置允许时，随宿主服务自动拉起网关。
 * 内部自带预检：网关已在线、插件未启用、设置关闭都会直接跳过，绝不重复拉起。
 * 返回决策信息（不抛错），供 setup() fire-and-forget 调用。
 */
export async function maybeAutoStartGateway({ root, delayMs = 4000, settingsOverride } = {}) {
  try {
    const config = readPluginConfig(root);
    const settings = settingsOverride ?? config.settings ?? {};
    const autoStart = settings.autoStartGateway !== false;
    const decision = {
      attempted: false, reason: '', enabled: config.enabled === true, autoStart,
      onlineBefore: false,
    };
    if (!decision.enabled) { decision.reason = '插件未启用'; return decision; }
    if (!autoStart) { decision.reason = '设置里关闭了随服务自动启动'; return decision; }

    const endpoint = String(settings.endpoint || 'http://127.0.0.1:18610');
    const before = await probe(endpoint, 3000);
    decision.onlineBefore = before.online;
    if (before.online) { decision.reason = '网关已在线'; return decision; }

    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const after = await probe(endpoint, 2500);
    if (after.online) { decision.reason = '网关已在线（延迟复查）'; return decision; }

    decision.attempted = true;
    const result = await startGateway({ endpoint, root });
    decision.reason = result.started ? '已自动启动' : String(result.reason ?? '启动未确认');
    decision.result = result;
    log(root, 'auto-start: ' + decision.reason);
    return decision;
  } catch (error) {
    const reason = String(error?.code ?? error?.message ?? error);
    log(root, 'auto-start failed: ' + reason);
    return { attempted: false, reason, enabled: false, autoStart: false, onlineBefore: false, error: true };
  }
}

export { MODULE_DIR as GATEWAY_MODULE_DIR };
