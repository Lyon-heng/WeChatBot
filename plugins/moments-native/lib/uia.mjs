// 界面通道（uia）：通过真实微信窗口发一条纯文字朋友圈。
//
// 与另外两条通道的区别：
//   native —— 往微信进程里注入组件，调微信内部的 SNS 发送函数（需要精确版本常量，且曾导致客户端自行退出）
//   gateway —— 交给外部 Pad 协议服务
//   uia    —— 只操作界面：长按相机图标 → 粘贴正文 → 点发表。不注入、不改内存，最坏情况是没点中
//
// 代价：需要电脑解锁、微信在前台、“发现-朋友圈”页面处于打开状态。
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NEEDED = ['rpa.exe', 'winlist.exe', 'shot.exe'];

export function uiaPaths(root) {
  const base = path.join(root, 'components', 'wechat-moments');
  return {
    base,
    build: path.join(base, 'build'),
    script: path.join(base, 'tools', 'uia-publish.mjs'),
  };
}

export function uiaStatus(root) {
  const {base, build, script} = uiaPaths(root);
  const missing = [];
  if (!fs.existsSync(script)) missing.push('tools/uia-publish.mjs');
  for (const name of NEEDED) {
    if (!fs.existsSync(path.join(build, name))) missing.push('build/' + name);
  }
  return {available: missing.length === 0, base, missing};
}

/** 发一条。返回 {ok, state, reason, detail}。绝不谎报成功。 */
export async function publishViaUi({root, text}) {
  const status = uiaStatus(root);
  if (!status.available) {
    return {ok: false, state: 'not-submitted', reason: '界面通道还没部署好，缺：' + status.missing.join('、')};
  }
  const body = String(text ?? '').trim();
  if (!body) return {ok: false, state: 'not-submitted', reason: '正文是空的'};

  const file = path.join(os.tmpdir(), 'wb-moment-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(file, body, 'utf8');
  } catch (error) {
    return {ok: false, state: 'not-submitted', reason: '写临时正文失败：' + error.message};
  }

  let result;
  try {
    result = spawnSync(process.execPath, [uiaPaths(root).script, file], {
      cwd: uiaPaths(root).base, encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
  } finally {
    // 临时文件留着也无害，但及时清掉更干净
    setTimeout(() => { try { fs.rmSync(file, {force: true}); } catch {} }, 5000);
  }

  const stdout = String(result?.stdout ?? '');
  const start = stdout.indexOf('{');
  let parsed = null;
  if (start >= 0) {
    try { parsed = JSON.parse(stdout.slice(start)); } catch {}
  }
  if (!parsed) {
    const stderr = String(result?.stderr ?? '').split('\n').slice(0, 3).join(' ').slice(0, 300);
    return {ok: false, state: 'unknown', reason: '界面发布脚本没返回结果' + (stderr ? '：' + stderr : '')};
  }
  if (!parsed.ok) {
    return {ok: false, state: 'not-submitted', reason: parsed.error || parsed.note || '界面操作没完成', detail: parsed};
  }
  return {
    ok: true,
    state: 'accepted',
    detail: '已在界面上点过“发表”，编辑窗口已关闭；最终以手机上的朋友圈为准',
    composeRect: parsed.composeRect,
  };
}
