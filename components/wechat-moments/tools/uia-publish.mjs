// 通过真实界面发一条纯文字朋友圈（RPA）：不注入、不改内存。
// 流程：置前主窗口 → 长按相机图标 → 编辑窗口出现 → 粘贴正文 → 点发表 → 校验窗口关闭。
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIR = path.resolve(HERE, '..');
const RPA = path.join(DIR, 'build/rpa.exe');
const SHOT = path.join(DIR, 'build/shot.exe');
const WINLIST = path.join(DIR, 'build/winlist.exe');

const MAIN_CLASS = 'Qt51514QWindowIcon';
const MAIN_TITLE = '微信';
const COMPOSE_TITLE = '朋友圈';

// 窗口内的相对落点（按 736x626 主窗口实测，其余按比例同样适用）
const CAMERA = {dx: -40, dy: 55};
const INPUT = {dx: 150, dy: 90};
const POST = {dx: 144, dy: 377};

function sleep(ms) {
  // Node 里同步睡眠：不启子进程，靠 Atomics.wait
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(exe, args, timeout = 30000) {
  return execFileSync(exe, args, {encoding: 'utf8', timeout, windowsHide: true});
}

function windows() {
  const file = path.join(os.tmpdir(), 'wb-uia-wins.txt');
  try { fs.rmSync(file, {force: true}); } catch {}
  run(WINLIST, [file]);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const m = line.match(/^hwnd=(0x[0-9A-Fa-f]+) pid=(\d+) class=(\S+) title=\[(.*)\] rect=(-?\d+),(-?\d+) (\d+)x(\d+)/);
    if (!m) return null;
    return {hwnd: m[1], pid: +m[2], cls: m[3], title: m[4], x: +m[5], y: +m[6], w: +m[7], h: +m[8]};
  }).filter(Boolean);
}

function findCompose(list) {
  return list.find(w => w.cls === MAIN_CLASS && w.title === COMPOSE_TITLE)
      || list.find(w => w.cls === MAIN_CLASS && w.title !== MAIN_TITLE && w.w < 700);
}

function main() {
  const textFile = process.argv[2];
  if (!textFile) { console.log(JSON.stringify({ok: false, error: '需要正文文件路径（UTF-8）'})); process.exit(1); }
  const text = fs.readFileSync(textFile, 'utf8').trim();
  if (!text) { console.log(JSON.stringify({ok: false, error: '正文为空'})); process.exit(1); }

  const list = windows();
  const mainWin = list.find(w => w.cls === MAIN_CLASS && w.title === MAIN_TITLE);
  if (!mainWin) { console.log(JSON.stringify({ok: false, error: '没找到微信主窗口，请先打开微信并停在“发现-朋友圈”'})); process.exit(2); }

  // 若上一次留下的编辑窗口还在，先取消掉（点“取消”，不发表）
  const stale = findCompose(list);
  if (stale) {
    run(RPA, ['click', String(stale.x + 265), String(stale.y + 377)]);
    sleep(1000);
  }

  run(RPA, ['fg', '@' + mainWin.hwnd]);
  
  const camX = mainWin.x + mainWin.w + CAMERA.dx;
  const camY = mainWin.y + CAMERA.dy;
  run(RPA, ['hold', String(camX), String(camY), '900']);

  // 等编辑窗口出现
  let compose = null;
  for (let i = 0; i < 12; i++) {
    sleep(1000);
    compose = findCompose(windows());
    if (compose) break;
  }
  if (!compose) { console.log(JSON.stringify({ok: false, error: '长按相机后没等到编辑窗口'})); process.exit(3); }

  run(RPA, ['click', String(compose.x + INPUT.dx), String(compose.y + INPUT.dy)]);
  run(RPA, ['paste', path.resolve(textFile)]);
  sleep(1000);

  const shotFile = path.join(os.tmpdir(), 'wb-uia-filled.bmp');
  run(SHOT, ['@' + compose.hwnd, shotFile]);

  run(RPA, ['click', String(compose.x + POST.dx), String(compose.y + POST.dy)]);
  sleep(3000);

  const after = windows();
  const stillOpen = after.some(w => w.hwnd === compose.hwnd || (w.cls === MAIN_CLASS && w.title === COMPOSE_TITLE));
  console.log(JSON.stringify({
    ok: !stillOpen,
    text,
    mainWindow: mainWin.hwnd,
    composeWindow: compose.hwnd,
    composeRect: [compose.x, compose.y, compose.w, compose.h],
    stillOpen,
    note: stillOpen ? '编辑窗口仍开着：可能没点到发表，请人工确认' : '已点击发表并关闭编辑窗口',
  }, null, 2));
  process.exit(stillOpen ? 4 : 0);
}

main();
