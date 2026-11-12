// 组件协议自测：把模拟 DLL 加载进独立宿主进程，用真实 XYM1 报文打它的 HTTP 口。
// 全程不接触微信：模拟模式下 submit_native 永远返回 0（不调用任何微信函数）。
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').replace(/\\/g, '/');
const DIR = ROOT + '/components/wechat-moments';
const {buildPostPacket, sha256} = await import('file:///' + ROOT + '/plugins/moments-native/lib/protocol.mjs');

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`);

const token = crypto.randomBytes(32).toString('hex');
const account = 'wxid_test_account';
const accountDir = account + '_abcd';
const good = buildPostPacket({account, text: '风把楼下的桂花吹了一地，加班回来正好闻到。'});
const other = buildPostPacket({account, text: '这一条没有经过授权。'});
const port = 55443;

const host = spawn(path.join(DIR, 'build/mock-host.exe'), [
  path.join(DIR, 'build/WeChatMomentsMock.dll'), String(port), token, accountDir, account, good.sha256,
], {stdio: ['ignore', 'pipe', 'pipe']});

const ready = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('宿主启动超时')), 15000);
  host.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.includes('READY')) { clearTimeout(timer); resolve(buffer); }
  });
  host.on('exit', code => { clearTimeout(timer); reject(new Error('宿主退出 ' + code)); });
});
check('模拟组件启动成功', ready.includes('start=0'), ready.trim().split('\n')[0]);
check('动态库里确有模拟标记', ready.includes('start=0'));

function request(method, route, {body, headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port, path: route, method, timeout: 9000,
      headers: {'Authorization': 'Bearer ' + token, ...(body ? {'Content-Length': body.length} : {}), ...headers}},
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({status: res.statusCode, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })()}));
      });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

const health = await request('GET', '/health');
check('health 返回 200', health.status === 200);
check('组件标识正确', health.json?.integration === 'wechatwb-moments-1', health.json?.integration);
check('模拟标记为 true', health.json?.offlineTest === true);
check('限额为单条', health.json?.limit === 1);
check('常量未就绪时如实报告', health.json?.constantsReady === false, 'constantsReady=' + health.json?.constantsReady);

const noAuth = await new Promise((resolve, reject) => {
  const req = http.request({hostname: '127.0.0.1', port, path: '/health', method: 'GET'}, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({status: res.statusCode, body: d}));
  });
  req.on('error', reject); req.end();
});
check('没有令牌被拒绝', noAuth.status === 403);

const withOrigin = await request('GET', '/health', {headers: {Origin: 'http://evil.example'}});
check('带 Origin 的请求被拒绝', withOrigin.status === 403);

const wrongHash = await request('POST', '/submit', {body: other.packet});
check('未授权正文被拒', wrongHash.status === 403, wrongHash.body.slice(0, 40));

const accepted = await request('POST', '/submit', {body: good.packet});
check('授权正文被受理（返回 200）', accepted.status === 200, accepted.body.slice(0, 80));
check('回执 id 与请求一致', accepted.json?.id === good.requestId, accepted.json?.id);
check('模拟模式不谎报已发布', accepted.json?.state === 'not-submitted', 'state=' + accepted.json?.state);

const again = await request('POST', '/submit', {body: good.packet});
check('第二次提交被拒（409，不重复发）', again.status === 409, again.body.slice(0, 40));

const result = await request('GET', '/result');
check('result 可查询', result.status === 200, result.json?.state);

const object = await request('GET', '/object');
check('object 在模拟模式下为空', object.status === 200 && object.json?.protobufHex === '');

host.kill();
await new Promise(r => setTimeout(r, 300));

const dllInfo = fs.statSync(path.join(DIR, 'build/WeChatMoments.dll'));
check('生产版 DLL 已生成', dllInfo.size > 20000, Math.round(dllInfo.size / 1024) + 'KB');
check('生产版与模拟版哈希不同',
  sha256(fs.readFileSync(path.join(DIR, 'build/WeChatMoments.dll'))) !== sha256(fs.readFileSync(path.join(DIR, 'build/WeChatMomentsMock.dll'))));

console.log(results.join('\n'));
const failed = results.filter(line => line.startsWith('FAIL'));
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exitCode = failed.length ? 1 : 0;
