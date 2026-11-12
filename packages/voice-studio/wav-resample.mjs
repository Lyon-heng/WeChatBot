/**
 * wechatwb — WAV 转 24kHz 单声道 s16le 的本地工具。
 *
 * 绿色版把语音处理需要的 ffmpeg 打包在 app/resources/runtime 里，但原版代码
 * 只会去 state/voice/tools/ffmpeg.exe 找它，导致外接 TTS 返回 WAV 后抛
 * VOICE_RESAMPLER_NOT_READY。这里统一负责：
 *   1. resolveFfmpeg() 在多个位置自动发现可用的 ffmpeg；
 *   2. wavToPcm24k() 提供纯 JS 回退——普通 WAV 只需重采样，不必启动外部进程，
 *      即使 ffmpeg 缺失，外接语音也依然可用（需要变调/EQ 等滤镜时仍需 ffmpeg）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { voiceError } from './jobs.mjs';

const fail = code => Object.assign(new Error(code), { code });
const BINARIES_REL = path.join('python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
const discovered = new Map();

function firstExecutable(dir) {
  try {
    const name = fs.readdirSync(dir).find(entry => /^ffmpeg.*\.exe$/i.test(entry));
    if (!name) return null;
    const file = path.join(dir, name);
    return fs.statSync(file).size > 1024 * 1024 ? file : null;
  } catch { return null; }
}

/** 返回可执行的 ffmpeg 绝对路径，找不到返回 null。 */
export function resolveFfmpeg(root, { refresh = false } = {}) {
  const cacheKey = String(root || '');
  if (!refresh && discovered.has(cacheKey)) {
    const cached = discovered.get(cacheKey);
    if (!cached || fs.existsSync(cached)) return cached;
    discovered.delete(cacheKey);
  }
  const candidates = [];
  if (process.env.WECHATWB_FFMPEG) candidates.push(process.env.WECHATWB_FFMPEG);
  candidates.push(path.join(root, 'state/voice/tools/ffmpeg.exe'));
  // 从本模块所在目录逐级向上，兼容「模板根目录」和「data/workspace 运行根目录」两种布局。
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 8; level++) {
    candidates.push(path.join(dir, 'app/resources/runtime', BINARIES_REL));
    const runtimes = path.join(dir, 'data/runtimes');
    try {
      for (const entry of fs.readdirSync(runtimes)) candidates.push(path.join(runtimes, entry, BINARIES_REL));
    } catch { /* 该层没有 data/runtimes */ }
    dir = path.dirname(dir);
  }
  let found = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.toLowerCase().endsWith('.exe')) {
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1024 * 1024) { found = candidate; break; } } catch { /* 忽略不可访问项 */ }
    } else {
      found = firstExecutable(candidate);
      if (found) break;
    }
  }
  discovered.set(cacheKey, found);
  return found;
}

const sinc = x => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);

/** 解析 RIFF/WAVE，返回 { channels, sampleRate, format, bits, dataStart, dataSize }。 */
function readWavHeader(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw fail('WAV_INVALID');
  let fmt = null;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const declared = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const size = Math.min(declared, wav.length - start);
    if (id === 'fmt ') fmt = { start, size };
    else if (id === 'data') {
      if (!fmt || size < 2) throw fail('WAV_INVALID');
      if (fmt.size < 16) throw fail('WAV_UNSUPPORTED');
      let format = wav.readUInt16LE(fmt.start);
      if (format === 0xFFFE && fmt.size >= 40) format = wav.readUInt16LE(fmt.start + 24); // WAVE_FORMAT_EXTENSIBLE
      const channels = wav.readUInt16LE(fmt.start + 2);
      const sampleRate = wav.readUInt32LE(fmt.start + 4);
      const bits = wav.readUInt16LE(fmt.start + 14);
      if (![1, 3].includes(format) || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000 || ![8, 16, 24, 32].includes(bits)) throw fail('WAV_UNSUPPORTED');
      if (format === 3 && bits !== 32) throw fail('WAV_UNSUPPORTED');
      return { channels, sampleRate, format, bits, dataStart: start, dataSize: size };
    }
    if (declared > wav.length - start) break; // 流式 WAV 的 chunk 长度可能不准
    offset = start + declared + (declared & 1);
  }
  throw fail('WAV_INVALID');
}

async function decodeMono(wav, header, signal) {
  const { channels, bits, format, dataStart, dataSize } = header;
  const bytes = bits / 8, frameSize = bytes * channels;
  const frames = Math.floor(dataSize / frameSize);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // 长音频分块让出事件循环，避免阻塞控制台/微信消息处理。
    if ((i & 0xFFFF) === 0) { signal?.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
    const base = dataStart + i * frameSize;
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = base + c * bytes;
      let sample;
      if (format === 3) sample = wav.readFloatLE(at);
      else if (bits === 8) sample = (wav.readUInt8(at) - 128) / 128;
      else if (bits === 16) sample = wav.readInt16LE(at) / 32768;
      else if (bits === 24) {
        const raw = wav.readUInt8(at) | (wav.readUInt8(at + 1) << 8) | (wav.readUInt8(at + 2) << 16);
        sample = ((raw << 8) >> 8) / 8388608;
      } else sample = wav.readInt32LE(at) / 2147483648;
      sum += sample;
    }
    mono[i] = sum / channels;
  }
  return mono;
}

/**
 * 把 WAV 转成 24kHz 单声道 s16le PCM（与 SILK 编码器约定一致）。
 * 不依赖任何外部程序；只支持常见 PCM / IEEE float WAV。
 */
export async function wavToPcm24k(wav, { maxSeconds = 60, signal } = {}) {
  const header = readWavHeader(wav);
  const { channels, sampleRate, format, bits, dataStart, dataSize } = header;
  const limitBytes = 24000 * 2 * maxSeconds;
  // 已经是目标格式时直接拷贝，避免无谓的重采样。
  if (sampleRate === 24000 && channels === 1 && format === 1 && bits === 16) {
    const bytes = dataSize - (dataSize % 2);
    if (bytes > limitBytes) throw fail('VOICE_EXCEEDS_60_SECONDS');
    if (bytes < 960) throw fail('VOICE_RESAMPLING_FAILED');
    signal?.throwIfAborted();
    return Buffer.from(wav.subarray(dataStart, dataStart + bytes));
  }
  const mono = await decodeMono(wav, header, signal);
  const ratio = sampleRate / 24000;
  const outFrames = Math.floor(mono.length / ratio);
  if (outFrames * 2 > limitBytes) throw fail('VOICE_EXCEEDS_60_SECONDS');
  if (outFrames * 2 < 960) throw fail('VOICE_RESAMPLING_FAILED');
  const out = Buffer.allocUnsafe(outFrames * 2);
  const half = 12, cutoff = Math.min(1, 1 / ratio); // 降采样时压低截止频率抗混叠
  for (let i = 0; i < outFrames; i++) {
    if ((i & 0x3FFF) === 0) { signal?.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
    const center = i * ratio, base = Math.floor(center);
    let sum = 0, weightSum = 0;
    for (let k = base - half + 1; k <= base + half; k++) {
      if (k < 0 || k >= mono.length) continue;
      const x = center - k;
      const weight = sinc(x * cutoff) * sinc(x / half);
      sum += mono[k] * weight;
      weightSum += weight;
    }
    const value = Math.abs(weightSum) > 1e-6 ? sum / weightSum : 0;
    const clamped = Math.max(-1, Math.min(1, value));
    out.writeInt16LE(Math.round(clamped * (clamped < 0 ? 32768 : 32767)), i * 2);
  }
  return out;
}

/** 24kHz 单声道 s16le PCM 包装成 WAV，供本机后处理与试听使用。 */
export function pcmToWav(pcm){const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);}
/** 把任意 WAV 转成 24kHz 单声道 PCM；无滤镜时走纯 JS，变调/EQ 时交给 ffmpeg。 */
export async function wavToPcm(root,wav,{signal,pitchSemitones=0,speed=1,volume=1,bassDb=0,trebleDb=0,normalize=false,trimSilence=false,lightVoice=false,maxSeconds=60}={}){
  if(!Number.isInteger(maxSeconds)||maxSeconds<1||maxSeconds>600)throw voiceError('VOICE_DURATION_LIMIT_INVALID');
  if(!Number.isFinite(pitchSemitones)||pitchSemitones<0||pitchSemitones>5)throw voiceError('VOICE_PITCH_INVALID');
  if(!Number.isFinite(speed)||speed<0.75||speed>1.25)throw voiceError('VOICE_SPEED_INVALID');
  for(const [value,min,max]of [[volume,0.5,1.5],[bassDb,-6,6],[trebleDb,-6,6]])if(!Number.isFinite(value)||value<min||value>max)throw voiceError('VOICE_EFFECT_INVALID');
  if(typeof normalize!=='boolean'||typeof trimSilence!=='boolean'||typeof lightVoice!=='boolean')throw voiceError('VOICE_EFFECT_INVALID');
  const filters=[];
  if(pitchSemitones||speed!==1)filters.push(`rubberband=pitch=${2**(pitchSemitones/12)}:tempo=${speed}:formant=preserved`);
  if(trimSilence)filters.push('silenceremove=start_periods=1:start_duration=0:start_threshold=-48dB:start_silence=0.08','areverse','silenceremove=start_periods=1:start_duration=0:start_threshold=-48dB:start_silence=0.08','areverse');
  if(lightVoice)filters.push('highpass=f=85','equalizer=f=320:t=q:w=0.9:g=-2.2');
  if(bassDb)filters.push('bass=g='+bassDb);if(trebleDb)filters.push('treble=g='+trebleDb);
  if(normalize)filters.push('dynaudnorm=f=150:g=7:p=0.9');if(volume!==1)filters.push('volume='+volume);
  if(volume!==1||bassDb||trebleDb||normalize||lightVoice)filters.push('alimiter=limit=0.95:level=0:latency=1');
  const executable=resolveFfmpeg(root);
  if(!filters.length){
    try{return await wavToPcm24k(wav,{maxSeconds,signal});}
    catch(error){
      if(signal?.aborted)throw voiceError('VOICE_CANCELLED');
      if(!['WAV_INVALID','WAV_UNSUPPORTED'].includes(error.code))throw voiceError(error.code??'VOICE_RESAMPLING_FAILED');
      if(!executable)throw voiceError('VOICE_RESAMPLER_NOT_READY');
    }
  }else if(!executable)throw voiceError('VOICE_RESAMPLER_NOT_READY');
  const filter=filters.length?['-af',filters.join(',')]:[];
  return new Promise((resolve,reject)=>{const child=spawn(executable,['-hide_banner','-loglevel','error','-nostdin','-i','pipe:0',...filter,'-ac','1','-ar','24000','-f','s16le','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});const chunks=[];let size=0,failed=false;child.stderr.resume();child.stdout.on('data',bytes=>{size+=bytes.length;if(size>24000*2*maxSeconds){failed=true;child.kill();reject(voiceError('VOICE_EXCEEDS_60_SECONDS'));}else chunks.push(bytes);});child.on('error',()=>reject(voiceError('VOICE_RESAMPLING_FAILED')));child.on('close',code=>{if(!failed){if(code!==0||size<960)reject(voiceError('VOICE_RESAMPLING_FAILED'));else resolve(Buffer.concat(chunks));}});child.stdin.on('error',()=>{});child.stdin.end(wav);});
}
