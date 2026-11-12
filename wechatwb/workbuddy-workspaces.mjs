/**
 * wechatwb — WorkBuddy 工作空间读取与聊天分配
 *
 * 数据源：本机 WorkBuddy 用户目录（默认 ~/.workbuddy）
 *   - workbuddy.db 的 workspaces 表：用户打开过的工作空间（path + last_opened_at）
 *   - workbuddy.db 的 sessions 表：近期会话的 cwd，用于补全临时/项目工作空间
 *   - workspace-display-names.json：WorkBuddy 里自定义的显示名
 *   - sessions/*.json：数据库不可用时的最小回退（活跃会话心跳中的 cwd）
 *
 * 分配持久化：state/workbuddy-workspaces.json（不写 config/wechatagent.json，
 * 因此切换工作空间不会触发配置 revision 变更，也不需要重启或重新应用设置）。
 *
 * 每次聊天请求实时读取分配，选中后下一条消息立即生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const assignmentFile = path.join(root, 'state', 'workbuddy-workspaces.json');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalize = value => {
  try { return path.normalize(String(value || '').trim()).replace(/[\\/]+$/, '') || String(value || '').trim(); }
  catch { return String(value || '').trim(); }
};
const fold = value => normalize(value).toLowerCase().replace(/\//g, '\\');

/** WorkBuddy 用户目录：允许通过环境变量指向便携版或测试副本 */
export function workbuddyHome() {
  const override = process.env.WORKBUDDY_USER_HOME || process.env.WORKBUDDY_HOME;
  if (override && typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return path.join(process.env.USERPROFILE || os.homedir() || '', '.workbuddy');
}

/** 路径 → 稳定 id（12 位），避免把绝对路径直接塞进 HTML 属性或配置 */
export function workspaceId(value) {
  return sha(fold(value)).slice(0, 12);
}

function displayNames(home) {
  const result = new Map();
  try {
    const raw = readJson(path.join(home, 'workspace-display-names.json'));
    for (const [key, value] of Object.entries(raw?.workspaces ?? {})) {
      const name = typeof value === 'string' ? value : value?.name ?? value?.title;
      if (!name || typeof name !== 'string' || !name.trim()) continue;
      const trimmed = name.trim().slice(0, 80);
      if (/^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(key)) result.set(fold(key), trimmed);
      else result.set('id:' + key, trimmed);
    }
  } catch { /* 文件不存在或格式变化时忽略 */ }
  return result;
}

/** 只读打开 WorkBuddy 数据库；WAL 存在时优先只读，失败再退回普通只读查询 */
function queryDatabase(dbFile) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (error) { return { error }; }
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    try { db = new DatabaseSync(dbFile); } catch (error) { return { error }; }
  }
  try {
    db.exec('PRAGMA query_only = ON');
    const workspaces = db.prepare('SELECT path, last_opened_at FROM workspaces').all()
      .map(row => ({ path: String(row.path ?? ''), lastOpenedAt: Number(row.last_opened_at) || 0 }));
    let sessionCwds = [];
    try {
      sessionCwds = db.prepare("SELECT cwd, MAX(COALESCE(last_activity_at, updated_at, 0)) AS t, COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL AND cwd IS NOT NULL AND cwd <> '' GROUP BY cwd").all()
        .map(row => ({ path: String(row.cwd ?? ''), lastOpenedAt: Number(row.t) || 0, sessionCount: Number(row.n) || 0 }));
    } catch { /* 旧版表结构缺少列时忽略 */ }
    return { workspaces, sessionCwds };
  } catch (error) {
    return { error };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 数据库不可用时的最小回退：读取活跃会话心跳文件里的 cwd */
function fallbackPaths(home) {
  const rows = [];
  try {
    for (const name of fs.readdirSync(path.join(home, 'sessions'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = readJson(path.join(home, 'sessions', name));
        if (value?.cwd) rows.push({ path: String(value.cwd), lastOpenedAt: Number(value.updatedAt) || 0 });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return rows;
}

let cache = { at: 0, stamp: '', home: '', payload: null };

/** 读取 WorkBuddy 工作空间列表（带 3 秒缓存 + 数据库文件变化检测） */
export function listWorkspaces({ refresh = false } = {}) {
  const home = workbuddyHome();
  const dbFile = path.join(home, 'workbuddy.db');
  let stat = null;
  try { stat = fs.statSync(dbFile); } catch { /* db 不存在 */ }
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
  if (!refresh && cache.payload && Date.now() - cache.at < 3000 && cache.stamp === stamp && cache.home === home) {
    return cache.payload;
  }

  const names = displayNames(home);
  const rows = new Map();
  let source = 'workbuddy.db';
  let error = '';
  const db = stat ? queryDatabase(dbFile) : { error: new Error('WORKSPACE_DB_NOT_FOUND') };
  if (db.error) {
    source = stat ? 'sessions-fallback' : 'none';
    error = String(db.error?.message || db.error);
    for (const item of fallbackPaths(home)) add(item);
  } else {
    for (const item of db.sessionCwds ?? []) add(item);
    for (const item of db.workspaces) add(item, true);
  }

  function add(item, primary = false) {
    const p = normalize(item.path);
    if (!p || !path.isAbsolute(p)) return;
    const key = fold(p);
    const existing = rows.get(key) ?? { path: p, lastOpenedAt: 0, sessionCount: 0, primary: false };
    existing.lastOpenedAt = Math.max(existing.lastOpenedAt, Number(item.lastOpenedAt) || 0);
    existing.sessionCount = Math.max(existing.sessionCount, Number(item.sessionCount) || 0);
    existing.primary = existing.primary || primary;
    rows.set(key, existing);
  }

  const workspaces = [...rows.values()].map(item => {
    const id = workspaceId(item.path);
    const base = path.basename(item.path) || item.path;
    const custom = names.get(fold(item.path)) ?? names.get('id:' + id) ?? names.get('id:' + item.path);
    let exists = false;
    try { exists = fs.statSync(item.path).isDirectory(); } catch { /* 目录已移除或不可访问 */ }
    const parent = path.dirname(item.path);
    return {
      id, title: custom || base, path: item.path, parent,
      isCustomName: !!custom, exists,
      lastOpenedAt: item.lastOpenedAt, sessionCount: item.sessionCount,
      kind: /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(base) ? 'scratch' : 'folder',
    };
  }).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.title.localeCompare(b.title, 'zh-CN'));

  const payload = {
    available: workspaces.length > 0,
    source, home, workspaces,
    message: workspaces.length ? '' : stat
      ? '已连接 WorkBuddy，但暂未读取到工作空间。请在 WorkBuddy 中打开一个文件夹后刷新。'
      : '未找到 WorkBuddy 用户目录（workbuddy.db）。请确认已安装并登录 WorkBuddy。',
    ...(error && !workspaces.length ? { reason: error } : {}),
    updatedAt: Date.now(),
  };
  cache = { at: Date.now(), stamp, home, payload };
  return payload;
}

/** 读取聊天 → 工作空间分配（原始存储，值为规范化路径） */
export function assignments() {
  try {
    const value = readJson(assignmentFile);
    const chats = value?.chats && typeof value.chats === 'object' && !Array.isArray(value.chats) ? value.chats : {};
    const clean = {};
    for (const [key, p] of Object.entries(chats)) {
      if (typeof p === 'string' && p.trim()) clean[String(key)] = normalize(p);
    }
    return { version: 1, defaultPath: typeof value?.defaultPath === 'string' && value.defaultPath.trim() ? normalize(value.defaultPath) : null, chats: clean };
  } catch {
    return { version: 1, defaultPath: null, chats: {} };
  }
}

function persist(value) {
  const target = assignmentFile;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  cache = { at: 0, stamp: '', home: '', payload: null };
  return value;
}

/** 查找 id 或路径对应的工作空间 */
export function findWorkspace(value, { refresh = false } = {}) {
  if (!value || typeof value !== 'string') return null;
  const key = fold(value);
  const list = listWorkspaces({ refresh }).workspaces;
  return list.find(item => item.id === value) ?? list.find(item => fold(item.path) === key) ?? null;
}

/** 为单个聊天设置工作空间；传 null / 'default' 表示跟随默认 */
export function setChatWorkspace(conversationKey, value) {
  if (typeof conversationKey !== 'string' || !/^wechat:(private|group):[A-Za-z0-9_.-]{1,80}$/.test(conversationKey)) {
    throw Object.assign(new Error('请选择有效的聊天。'), { status: 400 });
  }
  const stored = assignments();
  let next = null;
  if (value && value !== 'default' && value !== '__default__') {
    const workspace = findWorkspace(value);
    if (!workspace) throw Object.assign(new Error('此工作空间已不在 WorkBuddy 列表中，请刷新后重选。'), { status: 409 });
    next = workspace.path;
  }
  if (next) stored.chats[conversationKey] = next;
  else delete stored.chats[conversationKey];
  persist(stored);
  return { ok: true, conversationKey, path: next };
}

/** 设置默认工作空间（未单独指定的聊天都跟随它） */
export function setDefaultWorkspace(value) {
  const stored = assignments();
  if (!value || value === 'none' || value === '__none__') stored.defaultPath = null;
  else {
    const workspace = findWorkspace(value);
    if (!workspace) throw Object.assign(new Error('此工作空间已不在 WorkBuddy 列表中，请刷新后重选。'), { status: 409 });
    stored.defaultPath = workspace.path;
  }
  persist(stored);
  return { ok: true, path: stored.defaultPath };
}

/** 解析某轮聊天实际生效的工作空间：单聊指定 > 默认 > 无 */
export function resolveWorkspace(conversationKey = '') {
  const stored = assignments();
  const p = (conversationKey && stored.chats[conversationKey]) || stored.defaultPath;
  if (!p) return null;
  const workspace = findWorkspace(p);
  return workspace ?? { id: workspaceId(p), title: path.basename(p) || p, path: p, parent: path.dirname(p), exists: false, source: 'stale' };
}

/** 工作空间顶层内容概览（让模型知道"在哪个目录里工作"），10 秒缓存 */
const briefCache = new Map();
export function workspaceBrief(workspacePath, limit = 24) {
  const p = normalize(workspacePath);
  const hit = briefCache.get(p);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  let value = { entries: [], truncated: false, error: '' };
  try {
    const names = fs.readdirSync(p).filter(name => !name.startsWith('.')).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    value = { entries: names.slice(0, limit), truncated: names.length > limit, error: '' };
  } catch (error) {
    value = { entries: [], truncated: false, error: '目录当前不可读取' };
  }
  briefCache.set(p, { at: Date.now(), value });
  return value;
}

/** 控制台 /api/session-groups 使用的快照（兼容原前端字段形状） */
export function workspaceSnapshot({ refresh = false } = {}) {
  const list = listWorkspaces({ refresh });
  const stored = assignments();
  const byPath = new Map(list.workspaces.map(item => [fold(item.path), item.id]));
  const groups = list.workspaces.map(item => ({
    id: item.id, title: item.title, path: item.path, parent: item.parent,
    exists: item.exists, lastOpenedAt: item.lastOpenedAt, sessionCount: item.sessionCount,
    isCustomName: item.isCustomName, kind: item.kind,
    sessionIds: [], updatedAt: item.lastOpenedAt,
  }));
  const assignmentsById = {};
  const stale = {};
  for (const [key, p] of Object.entries(stored.chats)) {
    const id = byPath.get(fold(p));
    if (id) assignmentsById[key] = id;
    else stale[key] = p;
  }
  const defaultId = stored.defaultPath ? byPath.get(fold(stored.defaultPath)) ?? null : null;
  return {
    available: list.available, workbuddy: true, source: list.source, home: list.home,
    groups, assignments: assignmentsById, defaultId,
    defaultPath: stored.defaultPath, stale,
    revision: sha(JSON.stringify(groups.map(item => [item.id, item.title, item.path, item.lastOpenedAt]))),
    message: list.message, updatedAt: list.updatedAt,
  };
}
