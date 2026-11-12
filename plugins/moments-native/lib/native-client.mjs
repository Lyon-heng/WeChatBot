// 与小鱼原生朋友圈组件（XiaoyuMoments-1）通信的本机客户端。
// 组件只在 127.0.0.1 上监听、随机令牌、一次加载只放行一条已授权正文；
// 这里按它的规则做严格校验：宁可报错，也不假装发成功、不自动重发。
import fs from 'node:fs';
import http from 'node:http';
import {sha256, SUPPORTED_CORE} from './protocol.mjs';

const MAX_JSON = 8192;
const MAX_OBJECT = 132000;
const TIMEOUT = 11000;

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function parseSession(value) {
  if (!value || typeof value !== 'object') return null;
  const session = {
    pid: Number(value.pid),
    port: Number(value.port),
    token: String(value.token ?? ''),
    approvedHash: String(value.approvedHash ?? ''),
    accountDirectory: String(value.accountDirectory ?? ''),
    wxid: String(value.wxid ?? ''),
    dllPath: String(value.dllPath ?? ''),
    dllSha256: String(value.dllSha256 ?? ''),
    healthVerified: value.healthVerified === true,
    operation: String(value.operation ?? ''),
    proposalId: String(value.proposalId ?? ''),
  };
  if (!Number.isInteger(session.pid) || session.pid <= 0) return null;
  if (!Number.isInteger(session.port) || session.port < 1024 || session.port > 65535) return null;
  if (!/^[a-f0-9]{64}$/.test(session.token)) return null;
  if (!/^[a-f0-9]{64}$/.test(session.approvedHash)) return null;
  return session;
}

/** 会话文件由组件的加载器写入；不存在就说明“还没加载”，不是错误。 */
export function loadSession(file) {
  const raw = readJson(file);
  if (!raw) return {session: null, reason: '没有找到组件会话文件（组件尚未加载）', file};
  const session = parseSession(raw);
  if (!session) return {session: null, reason: '组件会话文件内容无效，拒绝使用', file};
  if (raw.loaded === true && raw.healthVerified !== true) return {session: null, reason: '会话记录显示加载后未通过健康核验，需重新加载', file};
  return {session, reason: '', file};
}

export class MomentsComponent {
  constructor(session, {timeout = TIMEOUT} = {}) {
    if (!session) throw new Error('组件会话缺失');
    this.session = session;
    this.timeout = timeout;
  }

  request(route, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(body) : null;
      const request = http.request({
        hostname: '127.0.0.1',
        port: this.session.port,
        path: route,
        method: payload ? 'POST' : 'GET',
        timeout: this.timeout,
        headers: {
          Authorization: 'Bearer ' + this.session.token,
          ...(payload ? {'Content-Type': 'application/octet-stream', 'Content-Length': payload.length} : {}),
        },
      }, response => {
        let data = '';
        const cap = route === '/object' ? MAX_OBJECT : MAX_JSON;
        response.on('data', chunk => {
          data += chunk;
          if (data.length > cap) response.destroy(new Error('组件返回内容过大'));
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('组件拒绝请求：HTTP ' + response.statusCode);
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('组件请求超时；结果未知，不自动重试')));
      request.end(payload);
    });
  }

  /**
   * 健康核验：除了端口和令牌，还要核对组件身份、进程、账号目录、单条限额。
   * 任何一项不符都直接失败——换进程、换账号、换版本都不该继续。
   */
  async health() {
    const health = await this.request('/health');
    const problems = [];
    if (health.integration !== SUPPORTED_CORE.component) problems.push('组件标识不是 ' + SUPPORTED_CORE.component);
    if (health.offlineTest !== false) problems.push('这是离线模拟组件，不能发布');
    if (health.verified !== true) problems.push('组件未通过自身精确版本核验');
    if (health.pid !== this.session.pid) problems.push('进程号与加载时不一致（微信可能重启过）');
    if (this.session.accountDirectory && health.accountDirectory !== this.session.accountDirectory) problems.push('账号目录与加载时不一致');
    if (health.limit !== 1) problems.push('组件限额不是单条');
    if (problems.length) throw new Error('组件身份未核验：' + problems.join('；'));
    return health;
  }

  /** 提交：只允许提交加载时被批准的那一条，哈希不符立刻拒绝。 */
  async submit(packet) {
    const buffer = Buffer.from(packet);
    if (sha256(buffer) !== this.session.approvedHash) throw new Error('这包正文不是本次加载授权的那一条，组件会拒绝');
    await this.health();
    const result = await this.request('/submit', buffer);
    if (result.id !== buffer.subarray(4, 40).toString('ascii')) throw new Error('回执标识与请求不匹配');
    return result;
  }

  result() {
    return this.request('/result');
  }

  object() {
    return this.request('/object');
  }
}

/** 组件动态库文件是否还是加载时那一份（防止被替换后仍在用旧会话）。 */
export function verifyDll(session) {
  if (!session.dllPath || !session.dllSha256) return {ok: false, detail: '会话里没有动态库路径/哈希，无法核对'};
  try {
    const actual = sha256(fs.readFileSync(session.dllPath));
    if (actual !== session.dllSha256) return {ok: false, detail: '动态库文件已被替换，拒绝使用旧会话'};
    return {ok: true, detail: '动态库哈希与会话一致'};
  } catch (error) {
    return {ok: false, detail: '读不到动态库：' + error.message};
  }
}
