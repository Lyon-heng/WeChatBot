// Muse 视频 · 本地网页下单台（只监听 127.0.0.1）。
// 由项目根目录的 start-muse-studio.cmd 单独启动，不在插件子进程里运行。
// 链路：网页下单 → muse2api 异步任务 → 后台轮询 → 下载 mp4 → FileTransfers 入队 → 微信。
// 关掉网页后后台仍会继续生成与投递。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import {
  normalizeSettings, createTask, getTask, createImageTask, getImageTask,
  downloadVideo, imageExtension, health, describeError, cleanId,
} from './lib/muse-client.mjs';
import { listSessions, deliverVideo, deliveryStatus, CHAT_KEY } from './lib/delivery.mjs';
import { TaskStore } from './lib/task-store.mjs';
import { startGateway, stopGateway, locateInstall, readPluginConfig, maybeAutoStartGateway, adminUrl, openAdmin } from './lib/gateway.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, '../..');
const WEB_DIR = path.join(MODULE_DIR, 'web');
const MEDIA_DIR = path.join(ROOT, 'state/media/video/muse-video');
const RELATIVE_DIR = 'state/media/video/muse-video';
const PORT = Number(process.env.MUSE_STUDIO_PORT || 18760);
const POLL_MS = 8000;
const STALE_MS = 30 * 60000;

const store = new TaskStore(ROOT);
const inflight = new Set();
let gatewayCache = { at: 0, value: { online: false, ready: false, reason: '尚未检测' } };

function readEnvFile() {
  const candidates = [
    // 已有的、带汉化管理页与账号密码登录的定制部署优先。
    path.join(os.homedir(), 'muse2api/.env'),
    path.join(ROOT, '../../muse2api/.env'),
    path.join(ROOT, '../muse2api/.env'),
  ];
  for (const file of candidates) {
    try {
      const result = {};
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) result[match[1]] = match[2];
      }
      return result;
    } catch { /* 尝试下一个候选位置 */ }
  }
  return {};
}

/** 共用控制台里填的插件配置（兼容 v2 DPAPI 加密）；环境变量优先；最后回退到 muse2api 自己的 .env。 */
function pluginSettings() {
  const decoded = readPluginConfig(ROOT);
  const raw = decoded.settings ?? {};
  const env = readEnvFile();
  const endpoint = process.env.MUSE2API_ENDPOINT
    || raw.endpoint
    || 'http://127.0.0.1:' + (env.MUSE2API_PORT || '18610');
  const apiKey = process.env.MUSE2API_KEY || raw.apiKey || env.MUSE2API_KEY || '';
  return normalizeSettings({
    endpoint,
    apiKey,
    model: raw.model ?? '',
    duration: raw.duration ?? 10,
    vertical: raw.vertical ?? false,
    autoSend: true,
    autoStartGateway: raw.autoStartGateway !== false,
  });
}

async function gatewayState(force = false) {
  if (!force && Date.now() - gatewayCache.at < 10000) return gatewayCache.value;
  const value = await health(pluginSettings());
  gatewayCache = { at: Date.now(), value };
  return value;
}

const publicTask = task => ({
  id: task.id, kind: task.kind || 'video', prompt: task.prompt, duration: task.duration, vertical: task.vertical,
  aspect: task.aspect, conversationKey: task.conversationKey, autoSend: task.autoSend,
  stage: task.stage, status: task.status, progress: task.progress ?? 0,
  createdAt: task.createdAt, updatedAt: task.updatedAt,
  url: task.url, file: task.file, bytes: task.bytes,
  delivery: task.delivery ?? null, deliveryError: task.deliveryError ?? '',
  error: task.error ?? '', lastError: task.lastError ?? '',
});

async function autoDeliver(task) {
  if (!task.file || task.deliveredAt || !task.autoSend || !task.conversationKey) return task;
  try {
    const delivery = await deliverVideo(ROOT, {
      key: task.conversationKey, file: RELATIVE_DIR + '/' + task.file,
      name: task.file, seed: task.id,
    });
    return store.patch(task.id, {
      delivery, deliveredAt: Date.now(), stage: 'delivered', error: '', lastError: '', deliveryError: '',
    });
  } catch (error) {
    return store.patch(task.id, { deliveryError: describeError(error), stage: 'completed' });
  }
}

/** 刷新单个任务：查询 → 下载 → 投递。查询类网络错误只记 lastError，不误判为生成失败。 */
async function refreshTask(task) {
  if (!task || inflight.has(task.id)) return task;
  if (task.stage === 'failed' || task.stage === 'delivered') {
    if (task.stage === 'delivered' && task.delivery?.id && task.delivery?.state !== 'confirmed') {
      try {
        const status = deliveryStatus(ROOT, { key: task.conversationKey, id: task.delivery.id });
        return store.patch(task.id, { delivery: { ...task.delivery, ...status } });
      } catch { /* 回执查询失败不影响任务本身 */ }
    }
    return task;
  }
  inflight.add(task.id);
  try {
    const settings = pluginSettings();
    if (!task.file) {
      if (task.kind === 'image') {
        const info = await getImageTask(settings, task.id);
        if (info.stage === 'failed') return store.patch(task.id, { stage: 'failed', status: info.status, error: info.error, lastError: '' });
        if (info.stage === 'pending') {
          return store.patch(task.id, {
            stage: info.status === 'queued' ? 'queued' : 'processing',
            status: info.status, progress: info.progress, lastError: '',
          });
        }
        const fileName = 'muse-img-' + cleanId(task.id) + imageExtension(info.url);
        const bytes = await downloadVideo(settings, { url: info.url, target: path.join(MEDIA_DIR, fileName) });
        const updated = store.patch(task.id, {
          stage: 'completed', status: 'completed', progress: 100,
          url: info.url, file: fileName, bytes, error: '', lastError: '',
        });
        return autoDeliver(updated);
      }
      const info = await getTask(settings, task.id);
      if (info.stage === 'failed') return store.patch(task.id, { stage: 'failed', status: info.status, error: info.error, lastError: '' });
      if (info.stage === 'pending') {
        return store.patch(task.id, {
          stage: info.status === 'queued' ? 'queued' : 'processing',
          status: info.status, progress: info.progress, lastError: '',
        });
      }
      const fileName = 'muse-' + cleanId(task.id) + '.mp4';
      const bytes = await downloadVideo(settings, { url: info.url, target: path.join(MEDIA_DIR, fileName) });
      const updated = store.patch(task.id, {
        stage: 'completed', status: 'completed', progress: 100,
        url: info.url, file: fileName, bytes, error: '', lastError: '',
      });
      return autoDeliver(updated);
    }
    return autoDeliver(task);
  } catch (error) {
    const lastError = describeError(error);
    const stale = Date.now() - (task.createdAt ?? Date.now()) > STALE_MS;
    return store.patch(task.id, {
      lastError, ...(stale ? { stage: 'failed', error: '持续轮询失败：' + lastError } : {}),
    });
  } finally {
    inflight.delete(task.id);
  }
}

async function refreshAll() {
  const tasks = store.list();
  const pending = tasks.filter(task => !['failed', 'delivered'].includes(task.stage) || (task.stage === 'delivered' && task.delivery?.state !== 'confirmed'));
  for (const task of pending) await refreshTask(task);
  return store.list();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(Error('请求体不是合法 JSON'), { status: 400 }); }
}

const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function serveMedia(req, res, route, baseHeaders) {
  const name = decodeURIComponent(route.slice('/media/'.length));
  // 视频 mp4 与生图产物 png/jpg/webp/gif 都放行，仍限定本插件媒体目录。
  if (!/^[A-Za-z0-9._-]+\.(mp4|png|jpe?g|webp|gif)$/i.test(name)) return { status: 400, body: { error: '文件名不合法' } };
  const type = /\.mp4$/i.test(name) ? 'video/mp4'
    : /\.png$/i.test(name) ? 'image/png'
    : /\.jpe?g$/i.test(name) ? 'image/jpeg'
    : /\.webp$/i.test(name) ? 'image/webp'
    : 'image/gif';
  const file = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: 404, body: { error: '媒体文件不存在' } };
  const stat = fs.statSync(file);
  const common = { ...baseHeaders, 'Content-Type': type };
  if (!/\.mp4$/i.test(name)) {
    res.writeHead(200, { ...common, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
    return null;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...common, 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */' + stat.size });
      res.end();
      return null;
    }
    res.writeHead(206, { ...common, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...common, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const baseHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  };
  const reply = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  try {
    const host = String(req.headers.host ?? '');
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) return reply(403, { error: '只允许本机访问' });
    const origin = String(req.headers.origin ?? '');
    if (origin && !origin.startsWith(`http://127.0.0.1:${PORT}`) && !origin.startsWith(`http://localhost:${PORT}`)) {
      return reply(403, { error: '请求来源不被允许' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'GET' && ASSETS[route]) {
      const [name, type] = ASSETS[route];
      return reply(200, fs.readFileSync(path.join(WEB_DIR, name)), type);
    }
    if (req.method === 'GET' && route.startsWith('/media/')) {
      const result = serveMedia(req, res, route, baseHeaders);
      if (result) return reply(result.status, result.body);
      return;
    }
    if (!route.startsWith('/api/')) return reply(404, { error: '未找到' });

    const settings = pluginSettings();

    if (req.method === 'GET' && route === '/api/state') {
      const [gateway, chats] = await Promise.all([gatewayState(url.searchParams.has('force')), Promise.resolve(listSessions(ROOT))]);
      const install = locateInstall(ROOT);
      const admin = adminUrl({ root: ROOT, endpoint: settings.endpoint });
      return reply(200, {
        ok: true, port: PORT, hasKey: !!settings.apiKey, endpoint: settings.endpoint,
        gateway, sessions: chats.sessions, sender: chats.sender, transport: chats.transport,
        autoStartGateway: settings.autoStartGateway !== false,
        install: install ? { dir: install.dir } : null,
        // 只给打码地址与纯地址；带 Key 的链接留在服务端进程内，由 /api/admin/open 代打开。
        admin: admin.masked, adminBase: admin.base,
        tasks: store.list().map(publicTask),
      });
    }

    // 等价于 open-muse-admin.cmd：网关没起就先拉起，再用默认浏览器打开带 Key 的管理页。
    if (req.method === 'POST' && route === '/api/admin/open') {
      const body = await readBody(req);
      const result = await openAdmin({ root: ROOT, endpoint: settings.endpoint, startIfOffline: body.start !== false });
      if (result.started || result.online) gatewayCache = { at: 0, value: { online: false, ready: false, reason: '尚未检测' } };
      return reply(200, { ok: true, ...result });
    }

    if (req.method === 'POST' && route === '/api/gateway/start') {
      const result = await startGateway({ endpoint: settings.endpoint, root: ROOT });
      gatewayCache = { at: 0, value: { online: false, ready: false, reason: '尚未检测' } };
      const errorText = result.started === false && !result.online && result.reason ? result.reason : '';
      return reply(200, { ok: true, ...result, error: errorText });
    }

    if (req.method === 'POST' && route === '/api/gateway/stop') {
      const result = await stopGateway({ endpoint: settings.endpoint, root: ROOT });
      gatewayCache = { at: 0, value: { online: false, ready: false, reason: '尚未检测' } };
      return reply(200, { ok: true, ...result });
    }

    if (req.method === 'GET' && route === '/api/tasks') {
      const tasks = await refreshAll();
      return reply(200, { ok: true, tasks: tasks.map(publicTask) });
    }

    if (req.method === 'POST' && route === '/api/generate') {
      const body = await readBody(req);
      const key = String(body.conversationKey ?? '');
      if (key && !CHAT_KEY.test(key)) return reply(400, { error: '目标会话格式不合法' });
      const created = await createTask(settings, {
        prompt: body.prompt,
        duration: body.duration,
        vertical: body.vertical === undefined ? settings.vertical : !!body.vertical,
      });
      const now = Date.now();
      const task = store.put({
        id: created.id, kind: 'video', prompt: created.prompt, duration: created.duration,
        vertical: !!body.vertical, aspect: created.aspect,
        conversationKey: key, autoSend: body.autoSend !== false,
        stage: created.status === 'queued' ? 'queued' : 'processing', status: created.status,
        progress: 0, createdAt: now, updatedAt: now,
        url: '', file: '', bytes: 0, error: '', lastError: '',
      });
      void refreshTask(task).catch(() => {});
      return reply(200, { ok: true, task: publicTask(task) });
    }

    // 生图：网关 POST /v1/images/tasks 的异步队列，任务进同一个 TaskStore（kind=image），
    // 由后台轮询下载 png/jpg 后走同一条 FileTransfers 投递管线。
    if (req.method === 'POST' && route === '/api/generate-image') {
      const body = await readBody(req);
      const key = String(body.conversationKey ?? '');
      if (key && !CHAT_KEY.test(key)) return reply(400, { error: '目标会话格式不合法' });
      const created = await createImageTask(settings, {
        prompt: body.prompt,
        aspect: ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(String(body.aspect)) ? String(body.aspect) : '1:1',
      });
      const now = Date.now();
      const task = store.put({
        id: created.id, kind: 'image', prompt: created.prompt, duration: 0,
        vertical: created.aspect === '9:16', aspect: created.aspect,
        conversationKey: key, autoSend: body.autoSend !== false,
        stage: created.status === 'queued' ? 'queued' : 'processing', status: created.status,
        progress: 0, createdAt: now, updatedAt: now,
        url: '', file: '', bytes: 0, error: '', lastError: '',
      });
      void refreshTask(task).catch(() => {});
      return reply(200, { ok: true, task: publicTask(task) });
    }

    const taskMatch = /^\/api\/tasks\/([A-Za-z0-9._-]+)\/(refresh|deliver|remove|delivery)$/.exec(route);
    if (req.method === 'POST' && taskMatch) {
      const [, id, action] = taskMatch;
      const task = store.get(id);
      if (!task) return reply(404, { error: '任务不存在' });
      const body = await readBody(req);
      if (action === 'remove') { store.remove(id); return reply(200, { ok: true }); }
      if (action === 'delivery') {
        if (!task.delivery?.id) return reply(409, { error: '该任务还没有投递记录' });
        try {
          return reply(200, { ok: true, delivery: deliveryStatus(ROOT, { key: task.conversationKey, id: task.delivery.id }) });
        } catch (error) { return reply(400, { error: describeError(error) }); }
      }
      if (action === 'deliver') {
        if (!task.file) return reply(409, { error: '视频还没生成完成，暂时无法投递' });
        const key = String(body.conversationKey ?? task.conversationKey ?? '');
        if (!CHAT_KEY.test(key)) return reply(400, { error: '请先选择合法的微信会话' });
        const target = store.patch(id, { conversationKey: key, autoSend: true, deliveredAt: null, deliveryError: '' });
        const updated = await autoDeliver(target);
        return reply(200, { ok: true, task: publicTask(updated) });
      }
      const updated = await refreshTask(store.get(id));
      return reply(200, { ok: true, task: publicTask(updated) });
    }

    return reply(404, { error: '未找到该接口' });
  } catch (error) {
    return reply(error?.status ?? 500, { error: describeError(error), code: String(error?.code ?? '') });
  }
});

server.on('error', error => {
  if (/EADDRINUSE/.test(String(error?.code))) {
    // 端口被占用：如果占用者就是已在运行的工作台，直接打开页面正常退出，不报错。
    (async () => {
      const already = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false);
      if (already) {
        console.log(`[muse-studio] 网页工作台已在运行：http://127.0.0.1:${PORT}/`);
        if (process.platform === 'win32' && process.env.MUSE_STUDIO_NO_OPEN !== '1') {
          exec(`start "" "http://127.0.0.1:${PORT}/"`, { shell: 'cmd.exe' }, () => {});
        }
        setTimeout(() => process.exit(0), 400);
        return;
      }
      console.error('[muse-studio] 启动失败：端口 ' + PORT + ' 被其他程序占用，可设置环境变量 MUSE_STUDIO_PORT 换一个。');
      process.exitCode = 1;
    })();
    return;
  }
  console.error('[muse-studio] 启动失败：' + String(error?.message ?? error));
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}/`;
  const settings = pluginSettings();
  const chats = listSessions(ROOT);
  console.log('[muse-studio] Muse 视频网页下单台已启动：' + address);
  console.log('[muse-studio] muse2api：' + settings.endpoint + ' | API Key：' + (settings.apiKey ? '已配置' : '未配置（请在控制台填写）'));
  console.log('[muse-studio] 可投递会话：' + chats.sessions.filter(item => item.authorized).length + '/' + chats.sessions.length + '（需助理模式 + 文件传输授权）');
  console.log('[muse-studio] 关掉网页也会继续生成与投递；Ctrl+C 停止服务。');
  // 设置里开了「随服务自动启动」时，网页服务一起来就拉起 muse2api（已在线则跳过）。
  if (settings.autoStartGateway !== false) {
    void maybeAutoStartGateway({ root: ROOT, delayMs: 2500, settingsOverride: settings })
      .then(decision => console.log('[muse-studio] muse2api 自动启动：' + (decision.attempted ? decision.reason : '跳过（' + decision.reason + '）')))
      .catch(() => {});
  }
  if (process.platform === 'win32' && process.env.MUSE_STUDIO_NO_OPEN !== '1') {
    exec(`start "" "${address}"`, { shell: 'cmd.exe' }, () => {});
  }
});

const timer = setInterval(() => { void refreshAll().catch(() => {}); }, POLL_MS);
timer.unref?.();
