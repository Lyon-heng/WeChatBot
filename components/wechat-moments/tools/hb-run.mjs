// 入口布防编排：arm <rva> / status / dump / clear
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIR = path.resolve(HERE, '..');
// 微信进程里一旦加载过 DLL，该文件就被锁住无法覆盖；所以按版本号出新文件，脚本自动取最新的
const pickDll = () => {
  const dir = path.join(DIR, 'build');
  const files = fs.readdirSync(dir).filter(n => /^moments-hb\d*\.dll$/i.test(n))
    .map(n => ({n, at: fs.statSync(path.join(dir, n)).mtimeMs})).sort((a, b) => b.at - a.at);
  return files.length ? path.join(dir, files[0].n) : null;
};
const DLL = process.env.HB_DLL || pickDll();
const OUT = path.join(os.tmpdir(), 'wechatwb-moments-hwbreak.txt');

function pids() {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'], {encoding: 'utf8'});
  return out.split('\n').map(l => l.replace(/"/g, '').split(',')[1])
    .filter(v => v && /^\d+$/.test(v.trim())).map(v => v.trim());
}

function call(pid, names, arg = '0') {
  const out = execFileSync('python',
    ['inject.py', '--pid', pid, '--dll', DLL, '--exports', names.join(','), '--arg', String(arg)],
    {cwd: DIR, encoding: 'utf8', timeout: 30000});
  return JSON.parse(out);
}

function pick(a) {
  return a.steps.filter(s => s.return !== undefined);
}

function mainPid() {
  for (const pid of pids()) {
    try {
      const r = call(pid, ['HbCount']);
      if (pick(r).length) return pid;
    } catch {}
  }
  return null;
}

const mode = process.argv[2] ?? 'status';
const pid = mainPid();
if (!pid) { console.log(JSON.stringify({ok: false, error: '没有找到微信进程'})); process.exit(1); }

if (mode === 'arm') {
  // 支持一次布防多个入口：arm 0x4D90050,0x2C3BF40,...
  const list = String(process.argv[3] || '').split(',').filter(Boolean).map(x => Number(x));
  if (!list.length) { console.log(JSON.stringify({ok: false, error: '需要至少一个 RVA'})); process.exit(1); }
  fs.rmSync(OUT, {force: true});
  const results = [];
  for (const rva of list) {
    const r = call(pid, ['HbArm'], String(rva));
    const steps = pick(r);
    const code = steps.length ? steps[steps.length - 1].return : -1;
    results.push({rva: '0x' + rva.toString(16).toUpperCase(), code});
  }
  const ok = results.every(x => x.code === 0);
  console.log(JSON.stringify({ok, pid, results}, null, 2));
  process.exit(ok ? 0 : 1);
}

if (mode === 'dump') {
  const r = call(pid, ['HbHits', 'HbCount', 'HbDumpDefault', 'HbArgsDump']);
  const steps = Object.fromEntries(pick(r).map(s => [s.export, s.return]));
  const lines = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  console.log(JSON.stringify({pid, hits: steps.HbHits, records: steps.HbCount, lines: lines.length, file: OUT}, null, 2));
  const rows = lines.map(line => {
    const p = line.split(' ');
    return {tid: p[0], rip: p[1], args: [p[2], p[3], p[4], p[5]], depth: p[6], frames: p.slice(7)};
  });
  for (const r2 of rows.slice(0, 12)) {
    console.log(`  tid=${r2.tid} rip=0x${r2.rip} args=${r2.args.map(a => '0x' + a).join(',')} depth=${r2.depth}`);
    console.log(`     ${r2.frames.slice(0, 8).map(f => '0x' + f).join(' ')}`);
  }
  const argFile = path.join(os.tmpdir(), 'wechatwb-moments-hwargs.txt');
  if (fs.existsSync(argFile)) {
    const argLines = fs.readFileSync(argFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    console.log(`  参数内存快照 ${argLines.length} 条 -> ${argFile}`);
  }
  process.exit(0);
}

if (mode === 'cover') {
  // cover <起始RVA> <页数>：把起始页号与页数打包成单参数
  const startRva = Number(process.argv[3]);
  const pages = Number(process.argv[4] || 1);
  const packed = ((startRva >> 12) << 8) | (pages & 0xff);
  fs.rmSync(OUT, {force: true});
  const r = call(pid, ['HbCoverSpan'], String(packed));
  const steps = pick(r);
  const code = steps.length ? steps[steps.length - 1].return : -1;
  console.log(JSON.stringify({ok: code === 0, pid, start: '0x' + (startRva & ~0xfff).toString(16).toUpperCase(), pages, code}, null, 2));
  process.exit(code === 0 ? 0 : 1);
}

if (mode === 'profile') {
  const r = call(pid, ['HbHits', 'HbCoverUsed', 'HbCoverDump']);
  const steps = Object.fromEntries(pick(r).map(s => [s.export, s.return]));
  const file = path.join(os.tmpdir(), 'wechatwb-moments-cover.txt');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  console.log(JSON.stringify({pid, hits: steps.HbHits, unique: steps.HbCoverUsed, lines: lines.length, file}, null, 2));
  process.exit(0);
}

if (mode === 'clear') {
  const r = call(pid, ['HbClear']);
  console.log(JSON.stringify({pid, cleared: pick(r).map(s => s.return)}));
  process.exit(0);
}

const r = call(pid, ['HbHits', 'HbCount']);
const steps = Object.fromEntries(pick(r).map(s => [s.export, s.return]));
console.log(JSON.stringify({pid, hits: steps.HbHits, records: steps.HbCount}));
