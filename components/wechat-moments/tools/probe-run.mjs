// 动态捕获编排：arm（布防）/ status（看是否已捕获）/ dump（导出 RIP 并撤防）。
// 只对微信主进程做三件事：加载探针、给目标字符串那一页加守卫、把捕获到的 RIP 写文件。
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIR = path.resolve(HERE, '..');
const pickDll = () => {
  const dir = path.join(DIR, 'build');
  const files = fs.readdirSync(dir).filter(name => /^moments-probe.*\.dll$/i.test(name))
    .map(name => ({name, at: fs.statSync(path.join(dir, name)).mtimeMs}))
    .sort((a, b) => b.at - a.at);
  return files.length ? path.join(dir, files[0].name) : null;
};
const DLL = process.env.PROBE_DLL || pickDll();
const DUMP = path.join(os.tmpdir(), 'wechatwb-moments-probe.jsonl');
const PREFIX = 'WeChatMomentsProbe';

function pids(image = 'Weixin.exe') {
  const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {encoding: 'utf8'});
  return out.split('\n').map(line => line.replace(/"/g, '').split(',')[1])
    .filter(value => value && /^\d+$/.test(value.trim())).map(value => value.trim());
}

function call(pid, exports) {
  const out = execFileSync('python', ['inject.py', '--pid', pid, '--dll', DLL, '--exports', exports.join(',')],
    {cwd: DIR, encoding: 'utf8', timeout: 25000});
  return JSON.parse(out);
}

/** 找到能读到目标字符串的那个进程（主进程才有 Weixin.dll）。 */
function mainPid() {
  for (const pid of pids()) {
    try {
      const result = call(pid, [PREFIX + 'HasPostString']);
      const step = result.steps.find(item => item.export === PREFIX + 'HasPostString' && item.return !== undefined);
      if (step && step.return === 1) return pid;
    } catch {}
  }
  return null;
}

const mode = process.argv[2] ?? 'status';

if (mode === 'armall') {
  const pid = mainPid();
  if (!pid) { console.log(JSON.stringify({ok: false, error: '没找到带 Weixin.dll 的微信主进程'})); process.exit(1); }
  fs.rmSync(DUMP, {force: true});
  const result = call(pid, [PREFIX + 'ArmAll']);
  const step = result.steps.find(item => item.export === PREFIX + 'ArmAll' && item.return !== undefined);
  const pages = step ? step.return : 0;
  console.log(JSON.stringify({ok: pages > 0, pid, pages, dump: DUMP}, null, 2));
  process.exit(pages > 0 ? 0 : 1);
}

if (mode === 'arm') {
  const pid = mainPid();
  if (!pid) { console.log(JSON.stringify({ok: false, error: '没找到带 Weixin.dll 的微信主进程'})); process.exit(1); }
  fs.rmSync(DUMP, {force: true});
  const result = call(pid, [PREFIX + 'ArmPost']);
  const steps = Object.fromEntries(result.steps.filter(s => s.export).map(s => [s.export, s.return]));
  const armed = steps[PREFIX + 'ArmPost'] === 0;
  console.log(JSON.stringify({ok: armed, pid, steps, dump: DUMP}, null, 2));
  process.exit(armed ? 0 : 1);
}

if (mode === 'status') {
  const pid = mainPid();
  if (!pid) { console.log(JSON.stringify({ok: false, error: '没有微信主进程'})); process.exit(1); }
  const result = call(pid, [PREFIX + 'Count']);
  const step = result.steps.find(item => item.export === PREFIX + 'Count' && item.return !== undefined);
  const captured = step ? step.return : 0;
  console.log(JSON.stringify({pid, captured, dumpExists: fs.existsSync(DUMP)}, null, 2));
  process.exit(captured > 0 ? 0 : 2);
}

if (mode === 'dump') {
  const pid = mainPid();
  if (!pid) { console.log(JSON.stringify({ok: false, error: '没有微信主进程'})); process.exit(1); }
  const result = call(pid, [PREFIX + 'DumpDefault', PREFIX + 'Disarm']);
  const lines = fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').trim().split('\n').filter(Boolean) : [];
  console.log(JSON.stringify({pid, steps: result.steps.filter(s => s.export), dumps: lines}, null, 2));
  process.exit(lines.length ? 0 : 2);
}
