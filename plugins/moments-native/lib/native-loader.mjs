// 组件加载器：不依赖 Python。
// 流程：写令牌+授权哈希+期望账号 → wb_load.exe 注入（只 LoadLibraryW）→ 组件自启动 →
//       读组件回报的端口 → 健康核验 → 写会话。
// 一条正文一次加载：组件一次只放行一条，这是防重发设计，不绕过。
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const PORT = 32000;
export const BUILD_TAG = 'r8';   // 只跟这一版组件说话，避免连到上一个还在跑的旧实例   // 组件的起始端口；实际端口以组件写出的 port 文件为准
const TMP = process.env.TEMP || 'C:\\Windows\\Temp';
const CONFIG = path.join(TMP, 'wb-moments-token.txt');
const PORT_FILE = path.join(TMP, 'wb-moments-port.txt');

function request(port, token, route, timeout = 4000) {
  return new Promise(resolve => {
    const req = http.request({hostname: '127.0.0.1', port, path: route, method: 'GET', timeout,
      headers: {Authorization: 'Bearer ' + token}}, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 组件启动时会把实际监听端口写进 PORT_FILE；老实例复用时该文件已在。 */
async function resolvePort(waitMs = 4000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(PORT_FILE, 'utf8').trim();
      if (/^\d+$/.test(text)) return Number(text);
    } catch {}
    await sleep(120);
  }
  return PORT;
}

/** 加载组件并授权“这一包”。wxid 非空时组件会拒收账号不符的报文（防换号发错）。 */
export async function loadComponent({root, packet, wxid = '', port = 0, timeout = 20000}) {
  const dir = path.join(root, 'plugins/moments-native/native');
  const exe = path.join(dir, 'bin', 'wb_load.exe');
  const dll = path.join(dir, 'bin', 'wb_moments_r8.dll');
  if (!fs.existsSync(exe) || !fs.existsSync(dll)) return {ok: false, detail: '注入器或组件缺失：' + dir};

  const token = crypto.randomBytes(32).toString('hex');
  const approved = crypto.createHash('sha256').update(packet).digest('hex');
  fs.writeFileSync(CONFIG, token + '\n' + approved + '\n' + wxid + '\n', 'utf8');

  const outFile = path.join(root, 'state/moments-native/load-result.json');
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  try { fs.unlinkSync(outFile); } catch {}

  const run = spawnSync(exe, ['--dll', dll, '--out', outFile], {encoding: 'utf8', timeout});
  let injected = null;
  try { injected = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
  if (!injected) {
    return {ok: false, detail: '注入器没有写出结果' + (run.error ? '：' + run.error.message : '')};
  }
  if (!injected.ok) return {ok: false, detail: '注入失败：' + (injected.error || '未知')};

  // 端口候选：写死的（有就优先）→ port 文件回报的 → PORT..PORT+9 全扫。
  // 微信重启后 port 文件是旧的，所以不能只信它，必须扫一遍看谁还活着。
  const wanted = port ? [port] : [];
  const fromFile = await resolvePort(port ? 200 : 2500);
  const candidates = [...new Set([...wanted, fromFile, ...Array.from({length: 10}, (_, i) => PORT + i)])]
    .filter(Boolean);

  let health = null;
  let actualPort = candidates[0];
  outer: for (let round = 0; round < 16; round++) {
    for (const candidate of candidates) {
      const probe = await request(candidate, token, '/health', 1200);
      // 旧实例读的是同一份配置，令牌也能通过；必须核 buildTag，否则会接到上一个版本上
      if (probe && probe.verified && probe.buildTag === BUILD_TAG) { health = probe; actualPort = candidate; break outer; }
    }
    await sleep(250);
  }
  if (!health) {
    return {ok: false, detail: `健康核验未通过（试过端口 ${candidates.join('/')}）：组件没起来或微信已退出`};
  }
  if (health.expect !== undefined && health.expect !== String(wxid)) {
    // 组件读到的期望账号和加载器写的不一致，说明配置没落到位——宁可报错也不带病投递
    return {ok: false, detail: `账号护栏未生效：组件读到 expect="${health.expect}"，期望 "${wxid}"`};
  }

  const session = {
    pid: injected.pid,
    port: actualPort,
    token,
    approvedHash: approved,
    accountDirectory: '',
    wxid,
    dllPath: dll,
    dllSha256: crypto.createHash('sha256').update(fs.readFileSync(dll)).digest('hex'),
    healthVerified: true,
    guard: health.guard === true,
    buildTag: health.buildTag || '',
    operation: 'post',
    proposalId: approved.slice(0, 12),
    loaded: true,
  };
  const sessionFile = path.join(root, 'state/moments-native/session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf8');
  return {ok: true, session: {...session, sessionFile},
    detail: `已加载：进程 ${injected.pid}，端口 ${actualPort}，账号护栏 ${session.guard ? '已开启' : '未开启'}`};
}
