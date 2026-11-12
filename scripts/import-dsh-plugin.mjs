import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, updateDshPluginEntrypoints } from './project-config.mjs';
import { upsertAssistantPresetPatch } from '../packages/dsh-social-bridge-plugin/assistant-preset.mjs';
import { upsertToolCatalogPatch } from '../packages/dsh-social-bridge-plugin/plugin-catalog.mjs';
import { windowsPowerShellExecutable, windowsPowerShellEnvironment } from './console-process.mjs';

const exec = promisify(execFile);
const fault = (code, message) => Object.assign(new Error(message), { code });
export function importPlan(root, executable, env = process.env) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile() || path.basename(executable).toLowerCase() !== 'deepseek harness.exe') throw fault('DSH_NOT_CONFIGURED', '请先选择 DeepSeek Harness.exe 并保存设置。');
  const base = path.dirname(executable);
  const launcher = path.join(base, 'resources/runtime/cli/bin/dsh.cmd');
  // The supported Desktop launcher binds Electron, CLI, profile and package manager.
  if (!fs.existsSync(launcher) || !fs.readFileSync(launcher, 'utf8').includes('dsh-desktop-host\\lib\\cli.js')) throw fault('DSH_IMPORT_UNSUPPORTED', '此 DSH 版本未提供桌面插件导入命令。请升级 DSH，或使用下方“复制插件路径”手动添加。');
  const directory = path.join(root, 'packages/dsh-social-bridge-plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-social-bridge-plugin' || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw fault('DSH_IMPORT_BUNDLE_INVALID', '本项目插件文件不完整，请重新安装 WeChatBot。');
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  // Match launch-dsh.ps1 for retained, formerly bundled DSH installations.
  const distributionFile = path.join(root, 'config/distribution.json');
  if (fs.existsSync(distributionFile)) {
    const distribution = JSON.parse(fs.readFileSync(distributionFile, 'utf8'));
    if (typeof distribution.dsh === 'string' && path.resolve(distribution.dsh).toLowerCase() === path.resolve(executable).toLowerCase() && distribution.dshHome) childEnv.DSH_HOME = distribution.dshHome;
  }
  delete childEnv.NODE_OPTIONS;
  return { exe: executable, args: ['--expose-internals', path.join(base, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), 'plugin', '--profile', 'desktop', 'add', directory], env: childEnv, directory };
}

export function importFailure(output, code) {
  if (/incompatible-version|incompatible.*(?:version|peer)|unsatisfied.*peer|allow-version/i.test(output)) return 'DSH 与此插件版本不兼容，请更新到兼容版本后重试。没有自动忽略兼容性检查。';
  if (/initialize.*profile|uninitialized|Open DeepSeek Harness Desktop once/i.test(output)) return '请先打开 DSH 一次完成初始化，再从系统托盘退出 DSH，然后重试导入。';
  if (/lock|already running|in use|EBUSY/i.test(output)) return 'DSH 或另一个插件安装正在占用配置。请从系统托盘完整退出 DSH，等待安装结束后重试。';
  if (code === 124) return '导入等待超时。请打开 DSH 插件页检查是否已导入，再决定是否重试。';
  if (/network|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch|registry/i.test(output)) return 'DSH 下载插件依赖失败，请检查网络后重试。';
  return 'DSH 未完成导入。请在 DSH 插件页检查安装结果；也可使用“复制插件路径”手动添加。';
}

async function isRunning(executable) {
  const script = "$ErrorActionPreference='Stop'; $items=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue); if(@($items|Where-Object {$_.Path -eq $env:WECHATBOT_IMPORT_EXE}).Count){'running'}else{'closed'}";
  const { stdout } = await exec(windowsPowerShellExecutable(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...windowsPowerShellEnvironment(), WECHATBOT_IMPORT_EXE: executable }, windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  return stdout.trim() === 'running';
}

export function executeImport(spec, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.exe, spec.args, { cwd: path.dirname(spec.exe), env: spec.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, deadlineFallback;
    const collect = bytes => { output = (output + bytes.toString()).slice(-32000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      // Only this import command and its descendants; never the user's DSH UI.
      if (process.platform === 'win32' && child.pid) execFile(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill();
      deadlineFallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); resolve({ code: 124, output }); }, 5000);
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); clearTimeout(deadlineFallback); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(deadlineFallback); resolve({ code: timedOut ? 124 : code ?? 1, output }); });
  });
}

export async function importDshPlugin({ root = projectRoot, executable, env, probe = isRunning, execute = executeImport, onProgress = () => {} } = {}) {
  const plan = importPlan(root, executable, env);
  if (await probe(plan.exe)) throw fault('DSH_IMPORT_RUNNING', '请先从系统托盘完整退出 DSH，再点击一键导入。关闭主窗口可能仅收起到托盘。');
  const patchFile = path.join(plan.directory, 'cordis.patch.yml');
  const before = fs.readFileSync(patchFile, 'utf8');
  const patch = upsertAssistantPresetPatch(upsertToolCatalogPatch(before, root), root);
  const updated = updateDshPluginEntrypoints(patch, root, plan.directory);
  if (!updated.revision) throw fault('DSH_IMPORT_BUNDLE_INVALID', '插件源码不完整，请重新安装 WeChatBot。');
  if (updated.patch !== before) {
    const temp = patchFile + '.' + process.pid + '.import.tmp';
    try { fs.writeFileSync(temp, updated.patch, { flag: 'wx' }); fs.renameSync(temp, patchFile); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  onProgress('正在通过 DSH 官方命令导入本项目插件，依赖下载可能需要一些时间。\n');
  const result = await execute(plan);
  if (result.code !== 0) throw fault('DSH_IMPORT_FAILED', importFailure(result.output, result.code));
  onProgress('插件已导入 DSH。请点击“打开 DSH”，登录模型账号并返回“重新检查”。是否连接成功以实际检查为准。\n');
  return { imported: true, restartRequired: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const configFile = path.join(projectRoot, 'config/wechatagent.json');
    if (!fs.existsSync(configFile)) throw fault('DSH_NOT_CONFIGURED', '请先选择 DSH 程序位置并保存设置。');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
    await importDshPlugin({ executable: config.runtime?.dshDesktop, onProgress: message => process.stdout.write(message) });
  } catch (error) { console.error('[' + (error.code || 'DSH_IMPORT_FAILED') + '] ' + (error.code?.startsWith('DSH_') ? error.message : '导入失败，请检查 DSH 安装位置和文件权限后重试。')); process.exitCode = 1; }
}
