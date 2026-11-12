/**
 * 本地识别引擎组件准备：固定版本下载、SHA-256 校验与落盘。
 *
 * 所有组件固定版本并记录校验和（对齐 voice-codec/silk-wasm 的 PROVENANCE 约定）。
 * 运行时目录：<root>/state/speech-local-engine/
 *   vendor/node_modules/sherpa-onnx-node        识别运行时（Node 原生插件）
 *   vendor/node_modules/sherpa-onnx-win-x64     Windows x64 二进制（onnxruntime 等）
 *   models/model.int8.onnx                      SenseVoice Small int8 ONNX 模型
 *   models/tokens.txt                           词表
 *   .provisioned.json                           安装完成后的校验记录
 *
 * 组件与模型不在插件 ZIP 中分发；下载由用户在配置页显式触发，不后台静默下载。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const PROVISION_VERSION = 'sensevoice-int8-sherpa2.0.1';

const MODELSCOPE = 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/';
const HFMIRROR = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/';
const NPM_MIRROR = 'https://registry.npmmirror.com/';
const NPM = 'https://registry.npmjs.org/';

export const ASSETS = Object.freeze({
  'sherpa-onnx-node': Object.freeze({
    kind: 'npm', package: 'sherpa-onnx-node', version: '2.0.1',
    bytes: 12709, sha256: '06ef8dfb9ea0f3cc77c1866620cbe05bf11b7dd70a973a454b77ce4a66cbcee1',
    urls: [NPM_MIRROR + 'sherpa-onnx-node/-/sherpa-onnx-node-2.0.1.tgz', NPM + 'sherpa-onnx-node/-/sherpa-onnx-node-2.0.1.tgz'],
  }),
  'sherpa-onnx-win-x64': Object.freeze({
    kind: 'npm', package: 'sherpa-onnx-win-x64', version: '2.0.1',
    bytes: 8779375, sha256: '217cec234c6026dbfd2b9c06523507180796fe4227c7cc9d11cfe218260a2519',
    urls: [NPM_MIRROR + 'sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-2.0.1.tgz', NPM + 'sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-2.0.1.tgz'],
  }),
  'tokens.txt': Object.freeze({
    kind: 'raw', file: 'tokens.txt',
    bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    urls: [MODELSCOPE + 'tokens.txt', HFMIRROR + 'tokens.txt'],
  }),
  'model.int8.onnx': Object.freeze({
    kind: 'raw', file: 'model.int8.onnx',
    bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    urls: [MODELSCOPE + 'model.int8.onnx', HFMIRROR + 'model.int8.onnx'],
  }),
});

export function enginePaths(root) {
  const state = path.join(root, 'state', 'speech-local-engine');
  return Object.freeze({
    state,
    vendor: path.join(state, 'vendor', 'node_modules'),
    models: path.join(state, 'models'),
    cache: path.join(state, 'cache'),
    marker: path.join(state, '.provisioned.json'),
    engineFile: path.join(state, 'engine.json'),
    controlFile: path.join(state, 'control.json'),
    logFile: path.join(state, 'server.log'),
  });
}

export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** 启动前快速自检：安装标记存在、版本匹配、关键文件在位且大小正确（不做全量哈希）。 */
export function fastProvisionCheck(root) {
  const paths = enginePaths(root);
  const marker = readJson(paths.marker);
  if (!marker || marker.version !== PROVISION_VERSION) return {ready: false, reason: 'NOT_PROVISIONED'};
  const checks = [];
  for (const [name, asset] of Object.entries(ASSETS)) {
    const target = asset.kind === 'npm'
      ? path.join(paths.vendor, asset.package, 'package.json')
      : path.join(paths.models, asset.file);
    try {
      if (fs.statSync(target).size !== (asset.kind === 'npm' ? marker.assets?.[name]?.targetBytes ?? -1 : asset.bytes)) throw Error();
    } catch { return {ready: false, reason: 'INCOMPLETE', missing: name}; }
    checks.push(name);
  }
  if (!fs.existsSync(path.join(paths.vendor, 'sherpa-onnx-win-x64', 'sherpa-onnx.node'))) return {ready: false, reason: 'INCOMPLETE', missing: 'sherpa-onnx.node'};
  return {ready: true, assets: checks};
}

function fetchAsset(asset, {signal, onProgress} = {}) {
  return new Promise(async (resolve, reject) => {
    let lastError = null;
    for (const url of asset.urls) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { resolve(await fetchToCache(url, asset, {signal, onProgress})); return; }
        catch (error) {
          if (signal?.aborted) { reject(Object.assign(Error('下载已取消。'), {code: 'CANCELLED'})); return; }
          lastError = error;
        }
      }
    }
    reject(lastError ?? Error('所有下载地址均不可用。'));
  });
}

function fetchToCache(url, asset, {signal, onProgress} = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(new Error('下载超时（90 秒无数据）。')); }, 90000);
    const controller = new AbortController();
    const cleanup = () => clearTimeout(timer);
    signal?.addEventListener('abort', () => controller.abort(new Error('下载已取消。')), {once: true});
    controller.signal.addEventListener('abort', () => cleanup(), {once: true});
    fetch(url, {redirect: 'follow', signal: controller.signal, headers: {'user-agent': 'WeChatBot-speech-recognition/1.4'}}).then(async response => {
      if (!response.ok || !response.body) { cleanup(); reject(Error('HTTP ' + response.status + ' ' + url)); return; }
      const chunks = [];
      let received = 0, lastReport = 0;
      let aborted = false;
      controller.signal.addEventListener('abort', () => { aborted = true; try { response.body.cancel(); } catch {} }, {once: true});
      try {
        for await (const chunk of response.body) {
          if (aborted) throw controller.signal.reason ?? Error('下载已取消。');
          received += chunk.length;
          if (received > asset.bytes) { throw Error('下载内容超过预期大小，可能不是目标文件。'); }
          chunks.push(chunk);
          if (onProgress && Date.now() - lastReport > 1500) { lastReport = Date.now(); onProgress({received, total: asset.bytes}); }
        }
      } catch (error) { cleanup(); reject(error); return; }
      cleanup();
      const buffer = Buffer.concat(chunks);
      if (buffer.length !== asset.bytes) { reject(Error('下载大小不符：期望 ' + asset.bytes + '，实际 ' + buffer.length + '。')); return; }
      const actual = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actual !== asset.sha256) { reject(Error('校验和不匹配，下载内容不可信：期望 ' + asset.sha256.slice(0, 12) + '，实际 ' + actual.slice(0, 12) + '。')); return; }
      resolve(buffer);
    }, error => { cleanup(); reject(error); });
  });
}

/** 最小 tar 解包：仅支持普通文件与目录，拒绝链接等特殊条目。 */
function extractTarGz(buffer, target) {
  const gunzipped = zlib.gunzipSync(buffer);
  let offset = 0;
  const longName = {pending: ''};
  while (offset + 512 <= gunzipped.length) {
    const header = gunzipped.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const rawName = longName.pending || header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    longName.pending = '';
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/[\0 ]/g, ''), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const data = gunzipped.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName.pending = data.toString('utf8').replace(/\0.*$/, ''); continue; }
    if (type === 'x' || type === 'g') continue;
    if (type === '5') { fs.mkdirSync(path.join(target, rawName.replace(/^package\//, '')), {recursive: true}); continue; }
    if (type !== '0' && type !== '\0') throw Error('压缩包包含不支持的条目类型（' + type + '），已中止安装。');
    const relative = rawName.replace(/^package\//, '');
    if (!relative) continue;
    const file = path.resolve(target, relative);
    if (!file.startsWith(path.resolve(target) + path.sep)) throw Error('压缩包路径越界，已中止安装。');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data);
  }
  if (!offset) throw Error('压缩包为空或格式不正确。');
}

/**
 * 下载并安装全部缺失组件。已安装且校验记录匹配的组件自动跳过。
 * onProgress({name, phase, received, total, index, count}) 用于配置页进度展示。
 */
export async function downloadAll(root, {signal, onProgress = () => {}} = {}) {
  const paths = enginePaths(root);
  for (const key of ['state', 'cache', 'vendor', 'models']) fs.mkdirSync(paths[key], {recursive: true});
  const marker = readJson(paths.marker) ?? {version: PROVISION_VERSION, assets: {}};
  marker.version = PROVISION_VERSION;
  const entries = Object.entries(ASSETS);
  for (let index = 0; index < entries.length; index++) {
    const [name, asset] = entries[index];
    const recorded = marker.assets?.[name];
    const target = asset.kind === 'npm'
      ? path.join(paths.vendor, asset.package, 'package.json')
      : path.join(paths.models, asset.file);
    if (recorded && recorded.sha256 === asset.sha256 && fs.existsSync(target)) { onProgress({name, phase: 'done', received: asset.bytes, total: asset.bytes, index, count: entries.length}); continue; }
    onProgress({name, phase: 'download', received: 0, total: asset.bytes, index, count: entries.length});
    const buffer = await fetchAsset(asset, {
      signal,
      onProgress: progress => onProgress({name, phase: 'download', ...progress, index, count: entries.length}),
    });
    if (asset.kind === 'npm') {
      onProgress({name, phase: 'install', received: buffer.length, total: buffer.length, index, count: entries.length});
      extractTarGz(buffer, path.join(paths.vendor, asset.package));
    } else {
      const temp = target + '.part';
      fs.writeFileSync(temp, buffer);
      const hash = await sha256File(temp);
      if (hash !== asset.sha256) throw Error('落盘后校验失败：' + name);
      fs.renameSync(temp, target);
    }
    marker.assets[name] = {sha256: asset.sha256, bytes: asset.bytes, at: Date.now()};
    if (asset.kind === 'npm') marker.assets[name].targetBytes = fs.statSync(target).size;
    atomicWrite(paths.marker, JSON.stringify(marker, null, 2) + '\n');
    onProgress({name, phase: 'done', received: asset.bytes, total: asset.bytes, index, count: entries.length});
  }
  return {ready: true};
}
