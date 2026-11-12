// muse2api 接口适配层。
// 两个主流分支（www222fff 原版 / czg86389-hub 中文增强版）在画幅字段、完成状态、
// 结果地址上并不一致；这里统一成插件与网页下单台都能用的形状。
// 只访问本机回环地址，凭据与视频文件都不出本机。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:18610';
export const FILE_LIMIT = 50 * 1024 * 1024;

const OK_STATES = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished']);
const FAIL_STATES = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'interrupted', 'timeout', 'timed_out', 'expired']);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || min)));
export const cleanId = value => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);

export function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    endpoint: String(source.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    apiKey: String(source.apiKey || ''),
    // 两个分支都不需要 model 字段；留空时不发送，避免被严格校验拒绝。
    model: String(source.model || ''),
    duration: clamp(source.duration || 10, 4, 20),
    vertical: !!source.vertical,
    autoSend: source.autoSend !== false,
    // 随微信服务自动启动 muse2api；默认开启（用户明确要求）。
    autoStartGateway: source.autoStartGateway !== false,
  };
}

function authHeaders(settings, hasBody) {
  return {
    Authorization: 'Bearer ' + settings.apiKey,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function request(settings, methodPath, { method = 'GET', body, timeoutMs = 15000, signal } = {}) {
  if (!settings.apiKey) throw Object.assign(Error('MUSE_API_KEY_MISSING'), { code: 'MUSE_API_KEY_MISSING' });
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await fetch(settings.endpoint + methodPath, {
      method,
      headers: authHeaders(settings, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    const code = timedOut ? 'MUSE_TIMEOUT' : 'MUSE_CONNECTION_FAILED';
    throw Object.assign(Error(code + ': ' + String(error?.message ?? error)), { code });
  }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    const message = String(data?.error?.message ?? data?.error ?? data?.detail ?? data?.message ?? ('HTTP ' + response.status)).slice(0, 300);
    throw Object.assign(Error('MUSE_HTTP_' + response.status + ': ' + message), { code: 'MUSE_HTTP_' + response.status, detail: message });
  }
  return data;
}

/** 创建视频任务。画幅字段先试 size，被严格校验拒绝时自动退回 aspect_ratio。 */
export async function createTask(settings, { prompt, duration, vertical, signal } = {}) {
  const text = String(prompt ?? '').trim();
  if (text.length < 2) throw Object.assign(Error('MUSE_PROMPT_REQUIRED'), { code: 'MUSE_PROMPT_REQUIRED' });
  const seconds = clamp(duration || settings.duration, 4, 20);
  const aspect = vertical ? '9:16' : '16:9';
  const base = { prompt: text, duration: seconds };
  if (settings.model) base.model = settings.model;
  let data;
  try {
    data = await request(settings, '/v1/videos', { method: 'POST', body: { ...base, size: aspect }, timeoutMs: 20000, signal });
  } catch (error) {
    if (!/MUSE_HTTP_(400|415|422)/.test(String(error.code))) throw error;
    data = await request(settings, '/v1/videos', { method: 'POST', body: { ...base, aspect_ratio: aspect }, timeoutMs: 20000, signal });
  }
  const id = cleanId(data?.id ?? data?.task_id ?? data?.taskId ?? data?.task?.id);
  if (!id) throw Object.assign(Error('MUSE_TASK_ID_MISSING'), { code: 'MUSE_TASK_ID_MISSING' });
  return { id, status: String(data?.status ?? 'queued'), aspect, duration: seconds, prompt: text };
}

function resultUrl(data, endpoint) {
  const candidates = [
    data?.result?.url, data?.result?.video_url, data?.result?.download_url,
    data?.video_url, data?.url, data?.download_url,
    data?.result?.data?.[0]?.url, data?.result?.assets?.[0]?.url,
    data?.data?.[0]?.url,
  ];
  const raw = candidates.find(value => typeof value === 'string' && value.trim());
  if (!raw) return '';
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return value;
  return endpoint + (value.startsWith('/') ? value : '/' + value);
}

/** 查询任务，归一成 {stage, status, progress, url, error}。 */
export async function getTask(settings, id, signal) {
  const data = await request(settings, '/v1/videos/' + encodeURIComponent(id), { timeoutMs: 15000, signal });
  const status = String(data?.status ?? '').toLowerCase();
  const stage = OK_STATES.has(status) ? 'completed' : FAIL_STATES.has(status) ? 'failed' : 'pending';
  const progress = Number(data?.progress);
  return {
    stage,
    status: status || 'queued',
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : 0,
    url: stage === 'completed' ? resultUrl(data, settings.endpoint) : '',
    error: stage === 'failed' ? String(data?.error?.message ?? data?.error ?? data?.message ?? '生成失败').slice(0, 300) : '',
  };
}

const IMAGE_ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);

/** 创建生图任务：POST /v1/images/tasks（网关异步队列，返回任务 ID）。画幅靠提示词注入实现。 */
export async function createImageTask(settings, { prompt, aspect, signal } = {}) {
  const text = String(prompt ?? '').trim();
  if (text.length < 2) throw Object.assign(Error('MUSE_PROMPT_REQUIRED'), { code: 'MUSE_PROMPT_REQUIRED' });
  const ratio = IMAGE_ASPECTS.has(String(aspect)) ? String(aspect) : '1:1';
  const body = { prompt: text, response_format: 'url', aspect_ratio: ratio };
  const data = await request(settings, '/v1/images/tasks', { method: 'POST', body, timeoutMs: 20000, signal });
  const id = cleanId(data?.id ?? data?.task_id ?? data?.taskId ?? data?.task?.id);
  if (!id) throw Object.assign(Error('MUSE_TASK_ID_MISSING'), { code: 'MUSE_TASK_ID_MISSING' });
  return { id, status: String(data?.status ?? 'queued'), aspect: ratio, prompt: text };
}

/** 查询生图任务：完成后 data[0].url 是图片地址（相对路径时补上 endpoint 前缀）。 */
export async function getImageTask(settings, id, signal) {
  const data = await request(settings, '/v1/images/tasks/' + encodeURIComponent(id), { timeoutMs: 15000, signal });
  const status = String(data?.status ?? '').toLowerCase();
  const stage = OK_STATES.has(status) ? 'completed' : FAIL_STATES.has(status) ? 'failed' : 'pending';
  const progress = Number(data?.progress);
  return {
    stage,
    status: status || 'queued',
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : 0,
    url: stage === 'completed' ? resultUrl(data, settings.endpoint) : '',
    error: stage === 'failed' ? String(data?.error?.message ?? data?.error ?? data?.message ?? '生成失败').slice(0, 300) : '',
  };
}

/** 从结果地址推断图片扩展名（网关落盘文件名自带扩展名；拿不到就按 png 处理）。 */
export function imageExtension(url) {
  const match = /\.(png|jpe?g|webp|gif)(?=$|[?#])/i.exec(String(url ?? ''));
  if (!match) return '.png';
  const ext = match[1].toLowerCase();
  return ext === 'jpeg' ? '.jpg' : '.' + ext;
}

/** 下载媒体文件（视频 mp4 / 图片 png·jpg·webp 通用）：先写 .part 再原子改名，返回字节数。 */
export const downloadMedia = downloadVideo;

/** 下载 mp4 到 target（先写 .part 再原子改名），返回字节数。 */
export async function downloadVideo(settings, { url, target, signal, limit = FILE_LIMIT } = {}) {
  const address = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(address)) throw Object.assign(Error('MUSE_RESULT_URL_MISSING'), { code: 'MUSE_RESULT_URL_MISSING' });
  const signals = [AbortSignal.timeout(120000)];
  if (signal) signals.push(signal);
  const response = await fetch(address, {
    headers: { Authorization: 'Bearer ' + settings.apiKey },
    signal: AbortSignal.any(signals),
    redirect: 'error',
  });
  if (!response.ok) throw Object.assign(Error('MUSE_DOWNLOAD_HTTP_' + response.status), { code: 'MUSE_DOWNLOAD_HTTP_' + response.status });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > limit) throw Object.assign(Error('MUSE_MEDIA_SIZE_INVALID'), { code: 'MUSE_MEDIA_SIZE_INVALID' });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.part';
  fs.writeFileSync(temporary, buffer, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return buffer.length;
}

/** 网关健康探测：/healthz 判断在线，/readyz 附带账号池状态。 */
export async function health(settings) {
  if (!settings.apiKey) return { online: false, ready: false, reason: 'MUSE_API_KEY_MISSING' };
  try {
    const signals = [AbortSignal.timeout(4000)];
    const response = await fetch(settings.endpoint + '/healthz', { signal: AbortSignal.any(signals) });
    if (!response.ok) return { online: false, ready: false, reason: 'HTTP ' + response.status };
    let ready = null;
    try {
      const probe = await fetch(settings.endpoint + '/readyz', {
        headers: authHeaders(settings, false), signal: AbortSignal.any([AbortSignal.timeout(4000)]),
      });
      if (probe.ok) ready = await probe.json().catch(() => null);
    } catch { /* readyz 是可选能力 */ }
    return { online: true, ready: ready?.ready !== false, detail: ready ?? null };
  } catch (error) {
    return { online: false, ready: false, reason: String(error?.message ?? error) };
  }
}

/** 把底层错误码转成给用户看的一句话。 */
export function describeError(error) {
  const code = String(error?.code ?? error?.message ?? error);
  if (code === 'MUSE_API_KEY_MISSING') return '还没配置 API Key：请在控制台「Muse 视频」插件设置里填写 muse2api 的 MUSE2API_KEY。';
  if (/MUSE_HTTP_401|MUSE_HTTP_403/.test(code)) return 'muse2api 拒绝了鉴权：API Key 与 muse2api 的 .env 里的 MUSE2API_KEY 不一致。';
  if (code === 'MUSE_CONNECTION_FAILED') return '连不上本机 muse2api：请在 Muse 视频工作台页面上点「启动服务」，或确认 start-muse2api.cmd 已在运行。';
  if (code === 'MUSE_TIMEOUT') return 'muse2api 响应超时（微信对话里的插件工具最多 8 秒）；请确认网关与账号状态，或改用本地网页下单台生成。';
  if (/MUSE_HTTP_404/.test(code)) return '任务不存在或网关已重启，任务队列被清空了，请重新生成。';
  if (/MUSE_HTTP_429|MUSE_HTTP_503/.test(code)) return 'muse2api 正忙或账号额度/并发已满，请稍后重试。';
  if (/MUSE_HTTP_5\d\d/.test(code)) return 'muse2api 内部错误，通常是账号会话失效或浏览器 CDP 未就绪，请去管理面板测试账号。';
  if (/FILE_TRANSFER_NOT_ALLOWED/.test(code)) return '视频已生成，但目标聊天没有开启「助理模式 + 文件传输」授权；开启后点补发即可。';
  if (/FILE_DISABLED_IN_FOREGROUND/.test(code)) return '当前是前台发送模式，项目禁止投递文件；请切回 native 模式。';
  if (/FILE_TOO_LARGE/.test(code)) return '视频超过 50 MB 的项目文件投递上限。';
  if (/MUSE_MEDIA_SIZE_INVALID/.test(code)) return '下载到的视频大小异常，可能不是 mp4。';
  if (/MUSE_TASK_ID_MISSING/.test(code)) return 'muse2api 没有返回任务 ID，请检查网关版本与请求字段。';
  if (/MUSE_RESULT_URL_MISSING/.test(code)) return '任务显示完成但没有可下载的视频地址，请到 muse2api 管理面板查看任务日志。';
  return code + (error?.detail ? '：' + error.detail : '');
}
