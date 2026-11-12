/**
 * 本地识别引擎 sidecar：由 speech-recognition 插件进程拉起的独立 Node 进程。
 *
 * - 只监听 127.0.0.1，所有请求需要 x-engine-token（由插件进程随机生成并写入 engine.json）
 * - 模型常驻内存，单条转写在百毫秒级完成
 * - POST /v1/audio/transcriptions 接收 multipart（file 字段）或 JSON {"audio_base64": "..."}
 *   返回 {"text": "..."}，与 openai-transcriptions 兼容，便于插件复用同一转写管线
 * - GET /status 返回运行状态
 * - 每 5 秒检查父进程存活，父进程消失时自动退出，避免孤儿进程占用内存
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';

function argument(name, fallback = '') {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const vendor = argument('vendor');
const models = argument('models');
const token = argument('token');
const ppid = Number(argument('ppid', '0')) || 0;
const threads = Math.max(1, Math.min(4, Number(argument('threads', '2')) || 2));
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES = 60 * 16000;

if (!vendor || !models || !token) { console.error('缺少 --vendor/--models/--token 参数'); process.exit(2); }
if (!fs.existsSync(path.join(vendor, 'sherpa-onnx-node', 'package.json'))) { console.error('识别运行时未安装：' + vendor); process.exit(2); }
if (!fs.existsSync(path.join(models, 'model.int8.onnx')) || !fs.existsSync(path.join(models, 'tokens.txt'))) { console.error('模型文件缺失：' + models); process.exit(2); }

let recognizer = null;
const requireFromVendor = createRequire(path.join(vendor, 'sherpa-onnx-node', 'noop.js'));
try {
  const sherpa = requireFromVendor('sherpa-onnx-node');
  const startedAt = Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {senseVoice: {model: path.join(models, 'model.int8.onnx'), language: '', useInverseTextNormalization: 1}, tokens: path.join(models, 'tokens.txt'), numThreads: threads, debug: 0, provider: 'cpu'},
    featsConfig: {sampleRate: 16000, featureDim: 80},
  });
  console.error('模型加载完成：' + (Date.now() - startedAt) + 'ms');
} catch (error) {
  console.error('模型加载失败：' + (error?.stack ?? error));
  process.exit(3);
}

function decodeWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw Error('VOICE_LOCAL_AUDIO_INVALID');
  let offset = 12, format = null, data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = {format: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10), sampleRate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22)};
    else if (id === 'data') { data = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length)); break; }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data || !format.channels) throw Error('VOICE_LOCAL_AUDIO_INVALID');
  const bytes = format.bits / 8;
  if (![8, 16, 32].includes(format.bits) || (format.bits === 32 && format.format !== 3)) throw Error('VOICE_LOCAL_AUDIO_INVALID');
  const frames = Math.floor(data.length / bytes / format.channels);
  if (!frames) throw Error('VOICE_LOCAL_AUDIO_INVALID');
  let samples = new Float32Array(frames);
  for (let index = 0; index < frames; index++) {
    let value = 0;
    for (let channel = 0; channel < format.channels; channel++) {
      const position = (index * format.channels + channel) * bytes;
      value += format.bits === 16 ? data.readInt16LE(position) / 32768
        : format.bits === 8 ? (data.readUInt8(position) - 128) / 128
        : data.readFloatLE(position);
    }
    samples[index] = value / format.channels;
  }
  if (format.sampleRate !== 16000) {
    const ratio = format.sampleRate / 16000;
    const target = Math.max(1, Math.floor(samples.length / ratio));
    const resampled = new Float32Array(target);
    for (let index = 0; index < target; index++) {
      const source = index * ratio, left = Math.floor(source), weight = source - left;
      resampled[index] = (samples[left] ?? 0) * (1 - weight) + (samples[left + 1] ?? samples[left] ?? 0) * weight;
    }
    samples = resampled;
  }
  if (samples.length > MAX_SAMPLES) samples = samples.subarray(0, MAX_SAMPLES);
  return samples;
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!match) throw Error('VOICE_LOCAL_AUDIO_INVALID');
  const boundary = Buffer.from('--' + (match[1] ?? match[2]).trim());
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start >= 0) {
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    let segment = buffer.subarray(start + boundary.length, next);
    if (segment.subarray(0, 2).toString() === '\r\n') segment = segment.subarray(2);
    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const header = segment.subarray(0, headerEnd).toString('utf8');
      const body = segment.subarray(headerEnd + 4, segment.length - 2);
      const name = /name="([^"]*)"/i.exec(header)?.[1] ?? '';
      const filename = /filename="([^"]*)"/i.exec(header)?.[1] ?? '';
      parts.push({name, filename, body});
    }
    start = next;
  }
  return parts;
}

let decoding = null;
function transcribe(samples) {
  const run = decoding ?? Promise.resolve();
  const task = run.catch(() => {}).then(() => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({sampleRate: 16000, samples});
    recognizer.decode(stream);
    return recognizer.getResult(stream).text ?? '';
  });
  decoding = task;
  return task;
}

const startedAt = Date.now();
const server = http.createServer((request, response) => {
  const fail = (code, message) => {
    response.writeHead(code, {'content-type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify({error: message, code}));
  };
  if ((request.headers['x-engine-token'] ?? '') !== token) return fail(401, 'VOICE_LOCAL_TOKEN_INVALID');
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/status') {
    response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    return response.end(JSON.stringify({ok: true, model: 'sensevoice-int8', pid: process.pid, uptimeMs: Date.now() - startedAt}));
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/audio/transcriptions') return fail(404, 'VOICE_LOCAL_NO_ROUTE');
  const chunks = [];
  let size = 0, aborted = false;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { aborted = true; fail(413, 'VOICE_LOCAL_AUDIO_TOO_LARGE'); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('error', () => { aborted = true; });
  request.on('end', () => {
    if (aborted) return;
    let samples;
    try {
      const buffer = Buffer.concat(chunks);
      const contentType = request.headers['content-type'] ?? '';
      if (/multipart\/form-data/i.test(contentType)) {
        const file = parseMultipart(buffer, contentType).find(part => part.name === 'file' || /audio/i.test(part.filename));
        if (!file) throw Error('VOICE_LOCAL_AUDIO_INVALID');
        samples = decodeWav(file.body);
      } else {
        const body = JSON.parse(buffer.toString('utf8') || '{}');
        const b64 = typeof body.audio_base64 === 'string' ? body.audio_base64 : typeof body.audio === 'string' ? body.audio : '';
        if (!b64 || b64.length > MAX_BODY_BYTES) throw Error('VOICE_LOCAL_AUDIO_INVALID');
        samples = decodeWav(Buffer.from(b64, 'base64'));
      }
    } catch (error) {
      return fail(400, String(error?.message ?? 'VOICE_LOCAL_AUDIO_INVALID'));
    }
    transcribe(samples).then(text => {
      response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify({text}));
    }, error => fail(500, String(error?.message ?? 'VOICE_LOCAL_FAILED')));
  });
});

const parentCheck = setInterval(() => {
  if (!ppid) return;
  try { process.kill(ppid, 0); } catch { console.error('父进程已退出，本地引擎自动停止。'); process.exit(0); }
}, 5000);
parentCheck.unref?.();
for (const signalName of ['SIGTERM', 'SIGINT']) try { process.on(signalName, () => process.exit(0)); } catch {}

server.listen(0, '127.0.0.1', () => {
  const {port} = server.address();
  process.stdout.write(JSON.stringify({event: 'listening', port, pid: process.pid}) + '\n');
});
