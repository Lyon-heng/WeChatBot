// 环境诊断：这台机器现在能不能真正发朋友圈，卡在哪一步。
// 只读：不加载组件、不改微信目录、不发消息。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {SUPPORTED_CORE, SUPPORTED_CORES, coreFor} from './protocol.mjs';
import {loadSession, MomentsComponent, verifyDll} from './native-client.mjs';

const CANDIDATE_ROOTS = [
  'C:/Program Files/Tencent/Weixin',
  'C:/Program Files (x86)/Tencent/Weixin',
  path.join(process.env.LOCALAPPDATA ?? 'C:/Users/Default/AppData/Local', 'Tencent/Weixin'),
];

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 找本机所有 Weixin.dll：官方安装目录 + 应用自带 Hook 用的那份微信。 */
export function findWeChatCores(root) {
  const found = [];
  const push = file => {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 20 * 1024 * 1024) found.push({file, size: stat.size, mtime: stat.mtimeMs});
    } catch {}
  };
  for (const base of CANDIDATE_ROOTS) {
    push(path.join(base, 'Weixin.dll'));
    try {
      for (const item of fs.readdirSync(base, {withFileTypes: true})) {
        if (!item.isDirectory()) continue;
        push(path.join(base, item.name, 'Weixin.dll'));
      }
    } catch {}
  }
  const hookRoot = path.join(root, 'state/hook');
  try {
    for (const item of fs.readdirSync(hookRoot, {withFileTypes: true})) {
      if (!item.isDirectory()) continue;
      const dir = path.join(hookRoot, item.name);
      push(path.join(dir, 'Weixin.dll'));
      push(path.join(dir, 'Weixin.exe'));
      try {
        for (const inner of fs.readdirSync(dir, {withFileTypes: true})) {
          if (inner.isDirectory()) push(path.join(dir, inner.name, 'Weixin.dll'));
        }
      } catch {}
    }
  } catch {}
  const seen = new Set();
  return found.filter(item => {
    const key = item.file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return item.file.toLowerCase().endsWith('weixin.dll');
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 从应用配置里取当前微信账号（wxid），插件自己拿不到明文账号。 */
/**
 * 当前真正登录的账号：微信数据目录里最近被写过的那个 wxid_*。
 * 配置里的 administrators 是“机器人管理员”，不一定是这台机器登录的号——
 * 报文里的 username 与登录账号不一致，服务端会直接回 201「发送失败」。
 */
export function activeAccount() {
  const base = path.join(process.env.USERPROFILE ?? 'C:/Users/Default', 'Documents/xwechat_files');
  try {
    let best = null;
    for (const item of fs.readdirSync(base, {withFileTypes: true})) {
      if (!item.isDirectory() || !item.name.startsWith('wxid_')) continue;
      const match = /^(wxid_[A-Za-z0-9]+)_/.exec(item.name);
      if (!match) continue;
      const stat = fs.statSync(path.join(base, item.name));
      if (!best || stat.mtimeMs > best.mtime) best = {wxid: match[1], mtime: stat.mtimeMs, dir: item.name};
    }
    return best;
  } catch {
    return null;
  }
}

export function resolveAccount(root, settings = {}) {
  const explicit = String(settings.accountWxid ?? '').trim();
  if (/^wxid_[A-Za-z0-9_]{1,100}$/.test(explicit)) return {wxid: explicit, source: '插件设置'};
  const active = activeAccount();
  if (active) return {wxid: active.wxid, source: `微信数据目录（${active.dir}，最近活跃）`};
  const config = readJson(path.join(root, 'config/wechatagent.json'));
  const list = config?.wechat?.assistant?.administrators;
  const first = Array.isArray(list) ? list.find(item => /^wxid_[A-Za-z0-9_]{1,100}$/.test(String(item))) : null;
  if (first) return {wxid: String(first), source: 'config/wechatagent.json 管理员账号'};
  return {wxid: '', source: '未找到'};
}

/** 哈希缓存：微信核心快 200MB，聊天工具只有 8 秒预算，同一份文件不重复算。 */
function cacheFile(root) {
  return path.join(root, 'state/moments-native/diagnose-cache.json');
}

function readCache(root) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(root), 'utf8').replace(/^\uFEFF/, '')) ?? {};
  } catch {
    return {};
  }
}

function writeCache(root, value) {
  try {
    fs.mkdirSync(path.dirname(cacheFile(root)), {recursive: true});
    fs.writeFileSync(cacheFile(root), JSON.stringify(value, null, 2), 'utf8');
  } catch {}
}

async function hashWithCache(file, size, mtime, cache) {
  const key = file.toLowerCase();
  const hit = cache[key];
  if (hit && hit.size === size && hit.mtime === mtime && typeof hit.sha256 === 'string') return {sha256: hit.sha256, cached: true};
  const sha256 = await hashFile(file);
  cache[key] = {size, mtime, sha256};
  return {sha256, cached: false};
}

/**
 * 完整诊断。
 * sessionFile：加载器写下的会话文件；没有它就只能走网关或发件箱。
 */
export async function diagnose({root, settings = {}}) {
  const cores = findWeChatCores(root);
  const cache = readCache(root);
  const hashed = [];
  let dirty = false;
  for (const core of cores) {
    let digest = '';
    let cached = false;
    try {
      const value = await hashWithCache(core.file, core.size, core.mtime, cache);
      digest = value.sha256;
      cached = value.cached;
      if (!cached) dirty = true;
    } catch {}
    const registered = coreFor(digest);
    hashed.push({
      file: core.file,
      sizeMb: Math.round(core.size / 1048576),
      sha256: digest,
      cached,
      matched: Boolean(registered),
      ready: Boolean(registered?.nativeReady),
      version: registered?.wechatVersion ?? '',
      missing: registered?.missing ?? [],
      foundCount: registered?.found?.length ?? 0,
    });
  }
  if (dirty) writeCache(root, cache);

  const sessionFile = String(settings.sessionFile ?? '').trim() || path.join(root, 'state/moments-native/session.json');
  const loaded = loadSession(sessionFile);
  let component = {available: false, detail: loaded.reason || '未加载'};
  if (loaded.session) {
    const dll = verifyDll(loaded.session);
    if (!dll.ok) component = {available: false, detail: dll.detail};
    else {
      try {
        const health = await new MomentsComponent(loaded.session).health();
        component = {
          available: true,
          detail: `组件在线：进程 ${health.pid}，账号目录 ${health.accountDirectory || '组件未提供'}，限额 ${health.limit} 条`,
          approvedHash: loaded.session.approvedHash,
          operation: loaded.session.operation,
        };
      } catch (error) {
        component = {available: false, detail: error.message};
      }
    }
  }

  const account = resolveAccount(root, settings);
  const ready = hashed.filter(item => item.ready);
  const partial = hashed.filter(item => item.matched && !item.ready);
  const verdict = ready.length
    ? '本机有常量齐全的微信核心，可以按 README 的加载流程启用原生发布。'
    : partial.length
      ? `本机微信核心 ${partial[0].version} 已登记：已定位 ${partial[0].foundCount ?? 0} 项常量，还缺 ${partial[0].missing.join(' / ')}——原生通道暂不可投递（组件会自行拒绝加载，不会误发）。可先用界面通道（uia）发出去。`
      : `本机微信核心不在已核对清单里（登记的是 ${SUPPORTED_CORES.map(item => item.wechatVersion).join(' / ')}）：原生发布不可用。可先用界面通道（uia）或协议网关通道。`;
  return {
    supported: SUPPORTED_CORE,
    supportedList: SUPPORTED_CORES,
    account,
    cores: hashed,
    component,
    sessionFile,
    verdict,
  };
}

/**
 * 快速兼容性判断：只读配置和哈希缓存，不算哈希——专给聊天工具用（8 秒预算）。
 * 目的：让“发不出去”的回复直接说清是版本不符，而不是让人白折腾去加载组件。
 */
export function quickCompat(root) {
  const config = readJson(path.join(root, 'config/wechatagent.json'));
  const running = String(config?.hook?.expectedVersion ?? '').trim();
  const cache = readCache(root);
  const values = Object.values(cache).filter(item => item && typeof item.sha256 === 'string');
  const ready = values.some(item => coreFor(item.sha256)?.nativeReady === true);
  const partial = values.map(item => coreFor(item.sha256)).find(item => item && !item.nativeReady) ?? null;
  return {running, supported: SUPPORTED_CORE.wechatVersion, matched: ready, partial};
}

export function compatLine(root) {
  const {running, supported, matched, partial} = quickCompat(root);
  if (matched) return `本机有与组件匹配的微信核心（${supported}），只差把组件加载进微信进程。`;
  if (partial) return `本机在跑的微信是 ${partial.wechatVersion}：原生组件常量已定位 ${partial.found?.length ?? 0} 项，还缺 ${partial.missing.join(' / ')}，暂时投递不了；先用界面通道发。`;
  const who = running ? `本机在跑的微信是 ${running}（Hook 版）` : '本机微信版本没能确认';
  return `${who}，而组件只认已登记的核心：版本不符时组件会拒绝加载，光“加载一下”也发不出去。`;
}

export function formatReport(report) {
  const lines = ['【朋友圈发布 · 环境诊断】'];
  lines.push(`账号：${report.account.wxid || '未找到'}（${report.account.source}）`);
  if (!report.cores.length) lines.push('微信核心：一个都没找到（微信可能没装或用的是别的路径）');
  for (const core of report.cores) {
    const state = core.ready ? '常量齐全' : core.matched ? `已登记，缺 ${core.missing.join(' / ')}` : '未登记';
    lines.push(`微信核心：${core.file}`);
    lines.push(`  ${core.sizeMb}MB · ${core.sha256.slice(0, 16)}… · ${core.version || '未知版本'} · ${state}`);
  }
  lines.push(`原生组件：${report.component.available ? '可用' : '不可用'} — ${report.component.detail}`);
  lines.push(`结论：${report.verdict}`);
  return lines.join('\n');
}

// 命令行自检：node lib/diagnose.mjs [工作区根目录]
// 不传根目录时按插件所在位置推断（plugins/<id>/lib → 上三级即工作区）。
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../../..');
  const report = await diagnose({root});
  console.log(formatReport(report));
  console.log('\n原始数据：');
  console.log(JSON.stringify(report, null, 2));
}
