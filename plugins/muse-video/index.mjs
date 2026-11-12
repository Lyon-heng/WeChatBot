// Muse 视频插件（微信对话侧）。
// 调用本机 muse2api（127.0.0.1:18610）驱动自己登录的 muse.ai 网页账号生成短视频，
// 完成后把 mp4 交给宿主的文件投递管线发到当前微信聊天。
// 网页下单台见同目录 server.mjs；两者共用 lib/ 下的适配层与任务目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, createTask, getTask, createImageTask, getImageTask, downloadVideo, downloadMedia, imageExtension, describeError, cleanId } from './lib/muse-client.mjs';
import { deliverVideo } from './lib/delivery.mjs';
import { autoStartServices } from './lib/gateway.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, '../..');
const MEDIA_DIR = path.join(ROOT, 'state/media/video/muse-video');
const RELATIVE_DIR = 'state/media/video/muse-video';
const BUSY_MS = 15 * 60000;
// 宿主对聊天插件工具是 8 秒硬上限（plugin-api toolTimeoutMs 最大 8000）。
// 主动在 6.5 秒收口，让工具返回明确错误，而不是被宿主掐断成看不懂的异常。
const TOOL_GUARD_MS = 6500;

const output = value => ({ content: JSON.stringify(value) });
// 宿主 storage 键只接受 /^[a-zA-Z0-9_-]{1,64}$/（packages/plugin-api/index.mjs）。
// 早期用 CURRENT_KEY / 'task:<id>'，冒号会让每次调用抛 PLUGIN_STORAGE_KEY_INVALID。
const CURRENT_KEY = 'current_task';
const CURRENT_IMAGE_KEY = 'current_image';
const taskKey = id => 'task_' + String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
const imageTaskKey = id => 'img_' + String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
const guardSignal = ctx => ctx.signal
  ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TOOL_GUARD_MS)])
  : AbortSignal.timeout(TOOL_GUARD_MS);

/** 把被宿主吞掉的真实错误落盘，便于下次直接定位。 */
function logPluginError(tool, error) {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const entry = {
      at: new Date().toISOString(), tool,
      code: String(error?.code ?? ''),
      message: String(error?.message ?? error).slice(0, 500),
      detail: String(error?.detail ?? '').slice(0, 300),
    };
    fs.appendFileSync(path.join(MEDIA_DIR, 'plugin-errors.log'), JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 日志失败不影响工具结果 */ }
}

function cleanupOldMedia(keepName) {
  try {
    for (const entry of fs.readdirSync(MEDIA_DIR)) {
      if (entry === keepName) continue;
      // 视频只清 mp4；图片按网关实际产物清 png/jpg/webp/gif。
      if (!/\.(mp4|png|jpe?g|webp|gif)$/i.test(entry)) continue;
      const full = path.join(MEDIA_DIR, entry);
      try { if (Date.now() - fs.statSync(full).mtimeMs > 72 * 3600 * 1000) fs.rmSync(full, { force: true }); } catch { /* 忽略单个文件清理失败 */ }
    }
  } catch { /* 目录还不存在 */ }
}

/**
 * 优先走宿主授权的 ctx.video.enqueue。
 * 旧版宿主 queueVideoFile 的 batchId 兜底值不是 64 位十六进制，会抛 FILE_RELATIVE_PATH_REQUIRED；
 * 遇到这种情况直接复用项目自带的 FileTransfers 管线投递，保证老版本也能发。
 */
async function enqueueVideo(ctx, fileName) {
  const request = { file: RELATIVE_DIR + '/' + fileName, name: fileName };
  try {
    return await ctx.video.enqueue(request);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/FILE_RELATIVE_PATH_REQUIRED|VIDEO_FILE_PATH_INVALID/.test(message)) throw error;
    return deliverVideo(ROOT, {
      key: ctx.chat.key, file: request.file, name: fileName, seed: 'plugin-' + fileName,
    });
  }
}

async function generate(ctx, args) {
  const settings = normalizeSettings(ctx.config());
  const current = await ctx.storage.get(CURRENT_KEY);
  if (current?.id && current.chat === ctx.chat.key && Date.now() - current.createdAt < BUSY_MS) {
    return output({
      stage: 'busy', taskId: current.id, elapsedSeconds: Math.round((Date.now() - current.createdAt) / 1000),
      message: '已有一个生成中的任务，先用 collect 查询或领取，不要重复创建。',
    });
  }
  const vertical = args.vertical === undefined ? settings.vertical : !!args.vertical;
  const task = await createTask(settings, {
    prompt: args.prompt, duration: args.duration, vertical, signal: guardSignal(ctx),
  });
  const record = {
    id: task.id, prompt: task.prompt.slice(0, 200), chat: ctx.chat.key,
    createdAt: Date.now(), duration: task.duration, vertical, aspect: task.aspect,
  };
  await ctx.storage.set(taskKey(task.id), record);
  await ctx.storage.set(CURRENT_KEY, record);
  cleanupOldMedia();
  return output({
    stage: 'queued', taskId: task.id, duration: task.duration, aspect: task.aspect,
    message: '任务已创建，通常 1-3 分钟完成。先简短告知用户正在生成；之后调用 collect 查询进度并领取，完成前不得声称视频已发出。',
  });
}

async function collect(ctx, args) {
  const settings = normalizeSettings(ctx.config());
  const requested = cleanId(args.taskId);
  const record = requested ? await ctx.storage.get(taskKey(requested)) : await ctx.storage.get(CURRENT_KEY);
  if (!record?.id) return output({ stage: 'none', message: '当前没有可领取的视频任务；先用 generate 创建。' });
  const id = record.id;
  if (record.chat !== ctx.chat.key) return output({ stage: 'foreign', taskId: id, message: '该任务属于其他聊天，不能在这里领取。' });
  const signal = guardSignal(ctx);
  const info = await getTask(settings, id, signal);
  if (info.stage === 'failed') {
    await ctx.storage.set(CURRENT_KEY, null);
    return output({ stage: 'failed', taskId: id, error: info.error, message: '生成失败，占位已清除；把原因简短转告用户即可。' });
  }
  if (info.stage !== 'completed') {
    return output({
      stage: info.status || 'processing', taskId: id, progress: info.progress,
      message: '仍在生成中（' + info.progress + '%）。告知用户再等一会儿，稍后再次调用 collect。',
    });
  }
  const fileName = 'muse-' + id + '.mp4';
  const target = path.join(MEDIA_DIR, fileName);
  const bytes = await downloadVideo(settings, { url: info.url, target, signal });
  const result = { stage: 'completed', taskId: id, bytes, url: info.url };
  if (!settings.autoSend) {
    await ctx.storage.set(CURRENT_KEY, null);
    result.message = '视频已生成（按设置不自动发文件）。预览链接：' + info.url;
    return output(result);
  }
  try {
    result.delivery = await enqueueVideo(ctx, fileName);
  } catch (error) {
    result.sent = false;
    result.error = String(error?.message ?? error);
    result.message = describeError(error) + ' 预览链接：' + info.url;
    return output(result);
  }
  await ctx.storage.set(CURRENT_KEY, null);
  cleanupOldMedia(fileName);
  result.sent = true;
  result.message = '视频已生成并进入微信文件投递队列（' + (result.delivery?.state ?? 'queued') + '）；文件确认送达前不要声称对方已收到。预览链接：' + info.url;
  return output(result);
}

async function generateImage(ctx, args) {
  const settings = normalizeSettings(ctx.config());
  const current = await ctx.storage.get(CURRENT_IMAGE_KEY);
  if (current?.id && current.chat === ctx.chat.key && Date.now() - current.createdAt < BUSY_MS) {
    return output({
      stage: 'busy', taskId: current.id, elapsedSeconds: Math.round((Date.now() - current.createdAt) / 1000),
      message: '已有一个生成中的图片任务，先用 collect_image 查询或领取，不要重复创建。',
    });
  }
  const aspect = ['9:16', '16:9', '3:4', '4:3'].includes(String(args.aspect)) ? String(args.aspect) : '1:1';
  const task = await createImageTask(settings, { prompt: args.prompt, aspect, signal: guardSignal(ctx) });
  const record = {
    kind: 'image', id: task.id, prompt: task.prompt.slice(0, 200), chat: ctx.chat.key,
    createdAt: Date.now(), aspect,
  };
  await ctx.storage.set(imageTaskKey(task.id), record);
  await ctx.storage.set(CURRENT_IMAGE_KEY, record);
  cleanupOldMedia();
  return output({
    stage: 'queued', taskId: task.id, aspect: task.aspect,
    message: '生图任务已创建，通常几十秒到两分钟完成。先简短告知用户正在生成；之后调用 collect_image 领取，完成前不得声称图片已发出。',
  });
}

async function collectImage(ctx, args) {
  const settings = normalizeSettings(ctx.config());
  const requested = cleanId(args.taskId);
  const record = requested ? await ctx.storage.get(imageTaskKey(requested)) : await ctx.storage.get(CURRENT_IMAGE_KEY);
  if (!record?.id) return output({ stage: 'none', message: '当前没有可领取的图片任务；先用 generate_image 创建。' });
  const id = record.id;
  if (record.chat !== ctx.chat.key) return output({ stage: 'foreign', taskId: id, message: '该图片任务属于其他聊天，不能在这里领取。' });
  const signal = guardSignal(ctx);
  const info = await getImageTask(settings, id, signal);
  if (info.stage === 'failed') {
    await ctx.storage.set(CURRENT_IMAGE_KEY, null);
    return output({ stage: 'failed', taskId: id, error: info.error, message: '生图失败，占位已清除；把原因简短转告用户即可。' });
  }
  if (info.stage !== 'completed') {
    return output({
      stage: info.status || 'processing', taskId: id, progress: info.progress,
      message: '仍在生成中（' + info.progress + '%）。告知用户再等一会儿，稍后再次调用 collect_image。',
    });
  }
  const fileName = 'muse-img-' + id + imageExtension(info.url);
  const target = path.join(MEDIA_DIR, fileName);
  const bytes = await downloadMedia(settings, { url: info.url, target, signal });
  const result = { stage: 'completed', taskId: id, bytes, url: info.url };
  if (!settings.autoSend) {
    await ctx.storage.set(CURRENT_IMAGE_KEY, null);
    result.message = '图片已生成（按设置不自动发文件）。预览链接：' + info.url;
    return output(result);
  }
  try {
    // 生图走同一条 FileTransfers 管线；deliverVideo 对任意白名单文件都适用。
    result.delivery = await deliverVideo(ROOT, {
      key: ctx.chat.key, file: RELATIVE_DIR + '/' + fileName, name: fileName, seed: 'plugin-img-' + fileName,
    });
  } catch (error) {
    result.sent = false;
    result.error = String(error?.message ?? error);
    result.message = describeError(error) + ' 预览链接：' + info.url;
    return output(result);
  }
  await ctx.storage.set(CURRENT_IMAGE_KEY, null);
  cleanupOldMedia(fileName);
  result.sent = true;
  result.message = '图片已生成并进入微信文件投递队列（' + (result.delivery?.state ?? 'queued') + '）；文件确认送达前不要声称对方已收到。预览链接：' + info.url;
  return output(result);
}

const safely = fn => async (ctx, args) => {
  try { return await fn(ctx, args); }
  catch (error) {
    logPluginError(fn.name || 'tool', error);
    return { isError: true, content: JSON.stringify({ error: String(error?.code ?? error?.message ?? error), message: describeError(error) }) };
  }
};

export function setup(api) {
  api.registerTool({
    id: 'generate',
    description: '用 Muse 生成一段 4-20 秒的短视频（走用户自己的 muse.ai 网页账号额度）。prompt 用一句话描述画面与运镜，任何语言都可以。创建成功只代表任务已排队（通常 1-3 分钟），必须之后调用 collect 领取；完成前不得向用户声称视频已发送。同一时间只允许一个任务。也可以在本地网页下单台里可视化生成。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 2, maxLength: 2000 },
        duration: { type: 'integer', minimum: 4, maximum: 20 },
        vertical: { type: 'boolean' },
      },
      required: ['prompt'], additionalProperties: false,
    },
    execute: safely(generate),
  });
  api.registerTool({
    id: 'collect',
    description: '查询并领取 Muse 视频任务：仍在生成则返回进度；已完成则下载 mp4 并按设置发送微信文件，返回预览链接。不带 taskId 时领取当前聊天最近一个任务。用户问「视频好了吗」时调用。',
    parameters: {
      type: 'object', properties: { taskId: { type: 'string', maxLength: 120 } }, additionalProperties: false,
    },
    execute: safely(collect),
  });
  api.registerTool({
    id: 'generate_image',
    description: '用 Muse 生成一张静态图片（走用户自己的 muse.ai 账号额度，支持参考图改图之外的纯文生图）。prompt 用一句话描述画面，aspect 可选 1:1（默认）/16:9/9:16/4:3/3:4。创建成功只代表任务已排队（通常几十秒到两分钟），必须之后调用 collect_image 领取；完成前不得向用户声称图片已发送。同一时间只允许一个图片任务。也可以在本地网页工作台里可视化生成。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 2, maxLength: 2000 },
        aspect: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
      },
      required: ['prompt'], additionalProperties: false,
    },
    execute: safely(generateImage),
  });
  api.registerTool({
    id: 'collect_image',
    description: '查询并领取 Muse 生图任务：仍在生成则返回进度；已完成则下载图片并按设置发送微信文件，返回预览链接。不带 taskId 时领取当前聊天最近一个图片任务。用户问「图片好了吗」时调用。',
    parameters: {
      type: 'object', properties: { taskId: { type: 'string', maxLength: 120 } }, additionalProperties: false,
    },
    execute: safely(collectImage),
  });
  // 设置里开了「随服务自动启动」（默认开）且插件已启用时，微信服务一起来就拉起
  // 网页工作台与 muse2api 网关（autoStartServices 内部逐个探测，已在线即跳过）。
  try {
    void autoStartServices({ root: ROOT, delayMs: 8000 }).catch(() => {});
  } catch { /* 自动启动失败不影响插件工具 */ }
}
