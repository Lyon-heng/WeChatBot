// 栈采样编排：start（开始采样 45 秒）/ stop（停止并导出）/ count
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIR = path.resolve(HERE, '..');
const pickDll = () => {
  const dir = path.join(DIR, 'build');
  const files = fs.readdirSync(dir).filter(n => /^moments-sampler.*\.dll$/i.test(n))
    .map(n => ({n, at: fs.statSync(path.join(dir, n)).mtimeMs})).sort((a, b) => b.at - a.at);
  return files.length ? path.join(dir, files[0].n) : null;
};
const DLL = process.env.SAMPLER_DLL || pickDll();
const OUT = path.join(os.tmpdir(), 'wechatwb-moments-samples.txt');

function pids() {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'], {encoding: 'utf8'});
  return out.split('\n').map(l => l.replace(/"/g, '').split(',')[1]).filter(v => v && /^\d+$/.test(v.trim())).map(v => v.trim());
}

function call(pid, names) {
  const out = execFileSync('python', ['inject.py', '--pid', pid, '--dll', DLL, '--exports', names.join(',')],
    {cwd: DIR, encoding: 'utf8', timeout: 30000});
  return JSON.parse(out);
}

function mainPid() {
  // 主进程才有 Weixin.dll；用采样器自己的 CoreBase 判断更麻烦，这里沿用探针的判据：逐个试
  for (const pid of pids()) {
    try {
      const result = call(pid, ['SamplerCoreBase']);
      const step = result.steps.find(s => s.export === 'SamplerCoreBase' && s.return !== undefined);
      if (step && step.return !== 0) return pid;
    } catch {}
  }
  return null;
}

const mode = process.argv[2] ?? 'count';
const pid = mainPid();
if (!pid) { console.log(JSON.stringify({ok: false, error: '没有找到微信主进程'})); process.exit(1); }

if (mode === 'start') {
  fs.rmSync(OUT, {force: true});
  const r = call(pid, ['SamplerStartDefault']);
  const step = r.steps.find(s => s.export === 'SamplerStartDefault' && s.return !== undefined);
  console.log(JSON.stringify({ok: step && step.return === 0, pid, started: step && step.return}, null, 2));
  process.exit(step && step.return === 0 ? 0 : 1);
}

if (mode === 'stop') {
  const r = call(pid, ['SamplerStop', 'SamplerDumpDefault']);
  const steps = Object.fromEntries(r.steps.filter(s => s.export).map(s => [s.export, s.return]));
  const lines = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  console.log(JSON.stringify({pid, steps, samples: lines.length, file: OUT}, null, 2));
  process.exit(lines.length ? 0 : 2);
}

const r = call(pid, ['SamplerCount']);
const step = r.steps.find(s => s.export === 'SamplerCount' && s.return !== undefined);
console.log(JSON.stringify({pid, samples: step ? step.return : 0}));
