/**
 * 微信回复状态记录（工作台「回复状态」用）
 *
 * 只记录状态与耗时，不记录任何聊天正文：
 *   thinking → 已开始处理；done → 已回复（带耗时）；failed → 处理失败。
 * 由消息桥接进程写入，控制台只读；每次整文件原子替换，最多保留 60 条。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LIMIT = 60;
const FILE = root => path.join(root, 'state', 'activity.json');
const PHASES = new Set(['thinking', 'done', 'failed']);

function readItems(root) {
  try {
    const value = JSON.parse(fs.readFileSync(FILE(root), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(value?.items) ? value.items.filter(item => item && PHASES.has(item.phase)) : [];
  } catch {
    return [];
  }
}

export function recordActivity(root, event = {}) {
  try {
    if (!root) return;
    const items = readItems(root);
    items.push({
      id: crypto.randomUUID(),
      at: Number(event.at) || Date.now(),
      key: String(event.key ?? '').slice(0, 120),
      name: String(event.name ?? event.key ?? '微信聊天').slice(0, 80),
      phase: PHASES.has(event.phase) ? event.phase : 'thinking',
      ms: Math.max(0, Math.round(Number(event.ms) || 0)),
      detail: String(event.detail ?? '').slice(0, 160),
    });
    fs.mkdirSync(path.dirname(FILE(root)), { recursive: true });
    const temp = FILE(root) + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, items: items.slice(-LIMIT) }), 'utf8');
    fs.renameSync(temp, FILE(root));
  } catch {
    /* 状态记录失败不影响聊天 */
  }
}

export function listActivity(root, limit = 24) {
  const size = Math.max(1, Math.min(LIMIT, Number(limit) || 24));
  return readItems(root).slice(-size).reverse();
}
