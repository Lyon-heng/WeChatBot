// 微信会话清单与视频文件投递。
// 复用项目自带的 FileTransfers 管线：入队后由 FileDeliveryWorker 走 /SendFileMsg 真正发送，
// 因此助理模式 / 文件传输授权 / 50 MB 上限 / 回执确认等安全规则全部沿用，不另开旁路。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileTransfers, filesAllowed, safeFileName } from '../../../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import { assistantSenderAllowed } from '../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';

export const CHAT_KEY = /^wechat:(private|group):[1-9]\d{0,15}$/;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function readWechatConfig(root) {
  return readJson(path.join(root, 'config/wechatagent.json'));
}

/** 文件投递必须由已登记的管理员身份发起，取第一个管理员的 wxid。 */
export function adminSender(config) {
  const list = config?.wechat?.assistant?.administrators;
  return Array.isArray(list) && list.length ? String(list[0]) : '';
}

function authorizedChats(root) {
  try {
    const config = readJson(path.join(root, 'config/plugins.json'));
    return config?.plugins?.['muse-video']?.chats ?? [];
  } catch { return []; }
}

/** 列出可作为投递目标的会话，并标出每个会话的授权状态与缺失项。 */
export function listSessions(root) {
  let config;
  try { config = readWechatConfig(root); }
  catch { return { sessions: [], sender: '', transport: 'unknown' }; }
  const w = config.wechat ?? {};
  const sender = adminSender(config);
  const keys = new Set();
  for (const id of w.whitelist?.private ?? []) keys.add('wechat:private:' + String(id));
  for (const id of w.whitelist?.groups ?? []) keys.add('wechat:group:' + String(id));
  for (const key of Object.keys(w.assistant?.fileTransferChats ?? {})) keys.add(key);
  for (const key of Object.keys(w.workModes ?? {})) keys.add(key);
  for (const key of authorizedChats(root)) keys.add(String(key));
  const sessions = [...keys].filter(key => CHAT_KEY.test(key)).map(key => {
    const reasons = [];
    if (w.workModes?.[key] !== 'assistant') reasons.push('未设为助理模式');
    if (w.assistant?.fileTransferChats?.[key] !== true) reasons.push('未开启文件传输');
    if (!sender) reasons.push('未配置管理员微信 ID');
    else if (!assistantSenderAllowed(w, key, sender)) reasons.push('会话不在白名单或管理员无效');
    let authorized = false;
    try { authorized = filesAllowed(w, key, sender); } catch { authorized = false; }
    return {
      key,
      kind: key.startsWith('wechat:group:') ? '群聊' : '私聊',
      id: key.split(':')[2],
      label: (key.startsWith('wechat:group:') ? '群聊 ' : '私聊 ') + key.split(':')[2],
      authorized,
      reason: authorized ? '' : reasons.join('、'),
    };
  }).sort((a, b) => Number(b.authorized) - Number(a.authorized) || a.key.localeCompare(b.key));
  return { sessions, sender, transport: String(w.textTransport?.mode ?? 'unknown') };
}

/**
 * 把已经落盘的 mp4 投递到指定微信会话。
 * file 必须是相对 workspace root 的路径；batchId 必须是 64 位十六进制（FileTransfers 的硬性校验）。
 */
export async function deliverVideo(root, { key, file, name, seed } = {}) {
  if (!CHAT_KEY.test(String(key))) throw Object.assign(Error('MUSE_CHAT_KEY_INVALID'), { code: 'MUSE_CHAT_KEY_INVALID' });
  const relative = String(file ?? '');
  if (!relative || path.isAbsolute(relative) || relative.includes('..')) throw Object.assign(Error('MUSE_FILE_PATH_INVALID'), { code: 'MUSE_FILE_PATH_INVALID' });
  const fileName = String(name ?? path.basename(relative));
  if (!safeFileName(fileName)) throw Object.assign(Error('MUSE_FILE_NAME_INVALID'), { code: 'MUSE_FILE_NAME_INVALID' });
  const config = readWechatConfig(root);
  const sender = adminSender(config);
  if (!sender) throw Object.assign(Error('MUSE_ADMIN_SENDER_MISSING'), { code: 'MUSE_ADMIN_SENDER_MISSING' });
  const batchId = crypto.createHash('sha256').update([key, fileName, seed ?? Date.now()].join('\0')).digest('hex');
  const transfers = new FileTransfers(root);
  const job = await transfers.queue({ key, sender, cwd: root, file: relative, name: fileName, batchId });
  return { ...job, conversationKey: key };
}

/** 查询某个投递任务的回执状态。 */
export function deliveryStatus(root, { key, id } = {}) {
  const config = readWechatConfig(root);
  const sender = adminSender(config);
  const transfers = new FileTransfers(root);
  return transfers.status(String(id), String(key), sender);
}
