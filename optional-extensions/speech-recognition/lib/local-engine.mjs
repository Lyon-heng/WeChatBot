/**
 * 本地识别引擎管理器：运行在 speech-recognition 插件自己的进程里。
 *
 * 职责：
 * - 拉起/停止 local-server.mjs sidecar（ELECTRON_RUN_AS_NODE，与插件宿主同一运行时）
 * - 维护 state/speech-local-engine/engine.json 状态文件（控制台配置页读取展示）
 * - 轮询 control.json 执行控制台下发的 启动/停止/下载 组件指令
 * - 转写前 ensure()：引擎不在运行时按 localAutostart 设置自动拉起
 *
 * 约定：engine.json 只由本模块写；control.json 只由控制台写；双方通过 nonce 对应请求。
 * 插件进程退出后 sidecar 由父进程看护自动退出（local-server 内置）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {atomicWrite, readJson, fastProvisionCheck, enginePaths} from './local-provision.mjs';

const serverPath = fileURLToPath(new URL('./local-server.mjs', import.meta.url));
const CONTROL_COMMANDS = Object.freeze(['start', 'stop', 'download', 'restart']);

let engine = null;
export function configureLocalEngine({root, log = () => {}, settings = () => ({})}) {
  engine = new LocalEngine({root, log, settings});
  return engine;
}
export function localEngine() { return engine; }

function fail(code) { return Object.assign(Error(code), {code}); }

export class LocalEngine {
  constructor({root, log, settings}) {
    this.root = path.resolve(root);
    this.log = log;
    this.settings = settings;
    this.paths = enginePaths(this.root);
    this.child = null;
    this.port = 0;
    this.token = '';
    this.state = 'stopped';
    this.error = '';
    this.startedAt = 0;
    this.nonce = '';
    this.starting = null;
    this.watcher = null;
    this.lastHandledNonce = '';
    this.disposed = false;
  }

  writeStatus(patch = {}) {
    const provisioned = fastProvisionCheck(this.root);
    const payload = {
      version: 1,
      state: this.state,
      error: this.error,
      port: this.port,
      pid: this.child?.pid ?? 0,
      token: this.token,
      nonce: this.nonce,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      provisioned: provisioned.ready,
      provisionReason: provisioned.ready ? '' : provisioned.reason,
      download: this.download ?? null,
      ...patch,
    };
    try { atomicWrite(this.paths.engineFile, JSON.stringify(payload, null, 2) + '\n'); } catch (error) { this.log('engine.json 写入失败: ' + error.message); }
    return payload;
  }

  appendLog(text) {
    try {
      fs.mkdirSync(this.paths.state, {recursive: true});
      const previous = fs.existsSync(this.paths.logFile) ? fs.readFileSync(this.paths.logFile, 'utf8') : '';
      fs.writeFileSync(this.paths.logFile, (previous + '[' + new Date().toISOString() + '] ' + text + '\n').slice(-256 * 1024));
    } catch { /* 日志失败不影响引擎 */ }
  }

  /** 初始化：建目录、写初始状态、开始轮询控制指令。setup() 调用，幂等。 */
  init() {
    if (this.watcher || this.disposed) return;
    fs.mkdirSync(this.paths.state, {recursive: true});
    if (!fs.existsSync(this.paths.engineFile)) this.writeStatus();
    this.watcher = setInterval(() => { this.pollControl().catch(() => {}); }, 2000);
    this.watcher.unref?.();
  }

  /** 转写链路使用：已运行返回端口；未运行时尝试自动启动（受 localAutostart 控制）。 */
  async ensure(signal) {
    if (this.state === 'running' && this.port) return {port: this.port};
    if (this.starting) return this.starting;
    const settings = this.settings?.() ?? {};
    if (settings.localAutostart === false && this.state !== 'running') throw fail('VOICE_LOCAL_NOT_RUNNING');
    const {port} = await this.start(signal);
    return {port};
  }

  start(signal) {
    if (this.state === 'running' && this.port) return Promise.resolve({port: this.port, reused: true});
    if (this.starting) return this.starting;
    this.starting = this.startOnce(signal).finally(() => { this.starting = null; });
    return this.starting;
  }

  async startOnce(signal) {
    if (this.disposed) throw fail('VOICE_LOCAL_UNAVAILABLE');
    const provisioned = fastProvisionCheck(this.root);
    if (!provisioned.ready) { this.state = 'missing'; this.error = ''; this.writeStatus(); throw fail('VOICE_LOCAL_NOT_PROVISIONED'); }
    this.token = crypto.randomBytes(24).toString('hex');
    this.state = 'starting';
    this.error = '';
    this.writeStatus();
    const startedAt = Date.now();
    await new Promise((resolve, reject) => {
      let settled = false, stdout = '';
      const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      env.ELECTRON_RUN_AS_NODE = '1';
      let child;
      const finish = (error, port = 0) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child?.stdout?.removeListener('data', onData);
        child?.stderr?.removeListener('data', onError);
        child?.removeListener('exit', onExit);
        error ? reject(error) : resolve(port);
      };
      const onData = chunk => {
        stdout = (stdout + chunk.toString('utf8')).slice(-4096);
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.event === 'listening' && Number.isInteger(message.port)) {
              this.port = message.port;
              this.state = 'running';
              this.error = '';
              this.startedAt = Date.now();
              this.writeStatus();
              this.log(`[local-engine] listening on 127.0.0.1:${message.port}`);
              finish(null, message.port);
            }
          } catch { /* 非状态行忽略 */ }
        }
      };
      const onError = chunk => this.appendLog(String(chunk).slice(0, 2000));
      const onExit = code => {
        const wasStarting = this.state === 'starting';
        this.port = 0;
        this.state = wasStarting && code !== 0 ? 'error' : 'stopped';
        if (wasStarting && code !== 0) this.error = 'VOICE_LOCAL_START_FAILED';
        this.writeStatus();
        finish(fail(wasStarting && code !== 0 ? 'VOICE_LOCAL_START_FAILED' : 'VOICE_LOCAL_EXITED'));
      };
      const timer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch {}
        this.state = 'error';
        this.error = 'VOICE_LOCAL_START_TIMEOUT';
        this.writeStatus();
        finish(fail('VOICE_LOCAL_START_TIMEOUT'));
      }, 45000);
      try {
        child = this.child = fork(serverPath, [
          '--vendor', this.paths.vendor,
          '--models', this.paths.models,
          '--token', this.token,
          '--ppid', String(process.pid),
          '--threads', '2',
        ], {cwd: this.paths.state, env, silent: true, windowsHide: true, execArgv: []});
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onError);
        child.on('exit', onExit);
        child.on('error', error => {
          this.state = 'error';
          this.error = String(error.message ?? error).slice(0, 200);
          this.writeStatus();
          finish(fail('VOICE_LOCAL_START_FAILED'));
        });
        signal?.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, {once: true});
      } catch (error) {
        clearTimeout(timer);
        this.state = 'error';
        this.error = String(error.message ?? error).slice(0, 200);
        this.writeStatus();
        finish(fail('VOICE_LOCAL_START_FAILED'));
      }
    });
    return {port: this.port};
  }

  async stop({silent = false} = {}) {
    this.disposed = this.disposed || !silent && this._disposeRequested === true;
    const child = this.child;
    this.child = null;
    this.port = 0;
    this.state = 'stopped';
    this.error = '';
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => {
        const timer = setTimeout(resolve, 800);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      try { child.kill('SIGTERM'); } catch {}
      await exited;
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
    }
    this.writeStatus();
    return {stopped: true};
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.watcher);
    this.watcher = null;
    return this.stop({silent: true});
  }

  /** 下载组件：进度写入 engine.json，供配置页轮询展示。 */
  async download(onProgress = () => {}) {
    const {downloadAll} = await import('./local-provision.mjs');
    this.download = {phase: 'download', received: 0, total: 0, name: '', percent: 0};
    this.state = 'downloading';
    this.error = '';
    let lastWrite = 0;
    const report = progress => {
      const percent = progress.total ? Math.min(100, Math.round(progress.received * 100 / progress.total)) : 0;
      this.download = {...progress, percent};
      if (Date.now() - lastWrite > 1200) { lastWrite = Date.now(); this.writeStatus(); }
      onProgress({...progress, percent});
    };
    try {
      this.writeStatus();
      await downloadAll(this.root, {signal: this.downloadSignal, onProgress: report});
      this.download = null;
      this.state = 'stopped';
      this.error = '';
      this.writeStatus();
      return {ok: true};
    } catch (error) {
      this.download = null;
      this.state = 'stopped';
      this.error = String(error.message ?? error).slice(0, 300);
      this.writeStatus();
      throw error;
    }
  }

  /** 控制台指令轮询：control.json 存在且 nonce 未处理时执行一次。 */
  async pollControl() {
    if (this.disposed || this.busy) return;
    const control = readJson(this.paths.controlFile);
    if (!control || typeof control.request !== 'string' || !CONTROL_COMMANDS.includes(control.request)) return;
    if (!control.nonce || control.nonce === this.lastHandledNonce) return;
    if (control.at && Date.now() - control.at > 10 * 60 * 1000) return;
    this.busy = true;
    this.nonce = control.nonce;
    try {
      if (control.request === 'start' || control.request === 'restart') {
        if (control.request === 'restart') await this.stop({silent: true});
        await this.start();
      } else if (control.request === 'stop') {
        await this.stop({silent: true});
      } else if (control.request === 'download') {
        await this.download();
      }
      this.lastHandledNonce = control.nonce;
    } catch (error) {
      this.error = String(error.message ?? error).slice(0, 300);
      if (!['start', 'restart'].includes(control.request)) this.state = 'stopped';
      this.writeStatus();
    } finally { this.busy = false; }
  }
}
