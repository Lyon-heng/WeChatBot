/**
 * 网络音源 / 本地整曲导入
 *
 * 网易云之外的第二条音源：直接给音频直链或含音频的网页，下载后规范化成 44.1k 立体声 WAV，
 * 作为「整曲音源」存进曲库；点歌时走人声分离 → 换声 → 混音，和网易云完全同一条链路。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {directory, atomicJson} from '../plugin-api/catalog.mjs';
import {voiceError} from './jobs.mjs';
import {runMusicTool} from './music.mjs';
import {resolveFfmpeg} from './wav-resample.mjs';
import {searchBilibili, downloadBilibiliAudio} from './song-search.mjs';

const MAX_BYTES = 140 * 1024 * 1024;
const MAX_SECONDS = 600;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|webm)(\?|#|$)/i;

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

/** 只允许公网 http(s)，拒绝本机与内网地址，避免被当成内网探测器 */
function assertPublicUrl(raw) {
  let target;
  try { target = new URL(String(raw).trim()); } catch { throw voiceError('WEB_SOURCE_URL_INVALID'); }
  if (!/^https?:$/.test(target.protocol)) throw voiceError('WEB_SOURCE_URL_INVALID');
  if (target.username || target.password) throw voiceError('WEB_SOURCE_URL_INVALID');
  const host = target.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw voiceError('WEB_SOURCE_URL_BLOCKED');
  if (host === '[::1]' || host === '::1') throw voiceError('WEB_SOURCE_URL_BLOCKED');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0) {
      throw voiceError('WEB_SOURCE_URL_BLOCKED');
    }
  }
  return target;
}

async function fetchLimited(url, {fetcher, signal, maxBytes = MAX_BYTES}) {
  let current = assertPublicUrl(url);
  for (let redirect = 0; redirect < 4; redirect += 1) {
    const response = await fetcher(current.href, {
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw voiceError('WEB_SOURCE_UNAVAILABLE');
      current = assertPublicUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw voiceError('WEB_SOURCE_HTTP_' + response.status);
    }
    const type = String(response.headers.get('content-type') ?? '').toLowerCase();
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw voiceError('WEB_SOURCE_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), contentType: type, finalUrl: current.href };
  }
  throw voiceError('WEB_SOURCE_REDIRECT_LIMIT');
}

/** 在页面 HTML 里找可能的音频地址 */
function pickAudioFromHtml(html, baseUrl) {
  const found = [];
  const push = raw => {
    if (!raw) return;
    const value = String(raw).replace(/&amp;/g, '&').trim();
    if (!value || /^data:/i.test(value)) return;
    try { found.push(new URL(value, baseUrl).href); } catch { /* ignore */ }
  };
  for (const match of html.matchAll(/<(?:audio|source)[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) push(match[1]);
  for (const match of html.matchAll(/property\s*=\s*["']og:audio(?::url)?["'][^>]*content\s*=\s*["']([^"']+)["']/gi)) push(match[1]);
  for (const match of html.matchAll(/content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:audio(?::url)?["']/gi)) push(match[1]);
  for (const match of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.(?:mp3|m4a|aac|flac|wav|ogg|opus)(?:\?[^"'\s]*)?)["']/gi)) push(match[1]);
  return [...new Set(found)].filter(item => AUDIO_EXT.test(item)).slice(0, 5);
}

async function resolveAudio(url, {fetcher, signal}) {
  const first = await fetchLimited(url, {fetcher, signal});
  const isAudio = first.contentType.startsWith('audio/') || first.contentType.startsWith('video/') || /^video\//.test(first.contentType) || AUDIO_EXT.test(first.finalUrl);
  if (isAudio) return {bytes: first.bytes, origin: first.finalUrl};
  const html = first.bytes.subarray(0, 600000).toString('utf8');
  const candidates = pickAudioFromHtml(html, first.finalUrl);
  for (const candidate of candidates) {
    try {
      const next = await fetchLimited(candidate, {fetcher, signal});
      if (next.bytes.length > 64 * 1024) return {bytes: next.bytes, origin: candidate};
    } catch { /* 试下一个 */ }
  }
  throw voiceError('WEB_SOURCE_AUDIO_NOT_FOUND');
}

/** 把任意音频转成 44.1k 立体声 WAV 并入库 */
async function storeSong(root, {bytes, title, origin, source, signal, run}) {
  const folder = directory(root, 'state/voice/songs');
  const temp = path.join(folder, 'import-' + crypto.randomUUID() + '.bin');
  const wav = path.join(folder, 'import-' + crypto.randomUUID() + '.wav');
  fs.writeFileSync(temp, bytes, {mode: 0o600});
  try {
    await run(resolveFfmpeg(root) ?? (() => { throw voiceError('VOICE_RESAMPLER_NOT_READY'); })(),
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', temp, '-t', String(MAX_SECONDS), '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', wav],
      {signal, timeoutMs: 180000});
    const audio = fs.readFileSync(wav);
    if (audio.length < 44 * 100) throw voiceError('WEB_SOURCE_AUDIO_INVALID');
    const id = digest(audio).slice(0, 24);
    const target = path.join(folder, id + '.wav');
    fs.writeFileSync(target, audio, {mode: 0o600});
    const durationSeconds = Math.max(0, Math.round(((audio.length - 44) / (44100 * 2 * 2)) * 10) / 10);
    atomicJson(path.join(folder, id + '.json'), {
      title: String(title || '网络音源').slice(0, 80),
      durationSeconds,
      kind: 'full-song',
      source,
      origin: String(origin || '').slice(0, 500),
      createdAt: Date.now(),
    });
    return { id, title: String(title || '网络音源').slice(0, 80), durationSeconds, source };
  } finally {
    for (const file of [temp, wav]) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  }
}

/** 从链接导入：音频直链直接用，普通网页会自动找页面里的音频 */
export async function importAudioFromUrl(root, {url, title, fetcher = fetch, signal, run = runMusicTool} = {}) {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) throw voiceError('WEB_SOURCE_URL_INVALID');
  const resolved = await resolveAudio(url.trim(), {fetcher, signal});
  const guess = title?.trim() || decodeURIComponent((resolved.origin.split('/').pop() || '').replace(AUDIO_EXT, '')) || '网络音源';
  return storeSong(root, {bytes: resolved.bytes, title: guess, origin: resolved.origin, source: 'web', signal, run});
}

/** 本地上传整首歌：直接转码入库 */
export async function importAudioFromBytes(root, {bytes, name, title, signal, run = runMusicTool} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024) throw voiceError('WEB_SOURCE_AUDIO_INVALID');
  if (bytes.length > MAX_BYTES) throw voiceError('WEB_SOURCE_TOO_LARGE');
  const guess = title?.trim() || String(name || '').replace(/\.[^.]+$/, '').slice(0, 80) || '本地歌曲';
  return storeSong(root, {bytes, title: guess, origin: name ? 'local:' + String(name).slice(0, 200) : 'local', source: 'local', signal, run});
}

/** 把视频标题洗成可读曲名：去掉【4K修复】、MV/2160P 之类的标注 */
function displayTitle(raw) {
  const text = String(raw ?? '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:4k|8k|2160p|1440p|1080p|720p|60fps|hi-?res|hdr|mv|official|live)\b/gi, ' ')
    .replace(/(?:修复版|重制版|高清版|完整版|无损音质|高音质|无损|纯享|收藏级|动态歌词|歌词版|官方版|官方|超清)/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[|｜《》「」“”"]/g, ' ')
    .replace(/[\s-]+$/g, '')
    .replace(/\s*[-–—]+\s*$/g, '')
    .replace(/^[\s-–—]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || String(raw ?? '').trim()).slice(0, 80) || '网络音源';
}

/** 从 B 站视频导入音轨（公开音源，不需要账号） */
export async function importAudioFromBilibili(root, {bvid, title, fetcher = fetch, signal, run = runMusicTool} = {}) {
  const audio = await downloadBilibiliAudio({bvid, fetcher, signal});
  const name = displayTitle(title || audio.title);
  return storeSong(root, {
    bytes: audio.bytes,
    title: name,
    origin: 'https://www.bilibili.com/video/' + bvid + '/',
    source: 'bilibili',
    signal,
    run,
  });
}

/**
 * 全自动找歌：只给一句话（歌名/歌手），自己联网搜、挑版本、下载、入库。
 * 返回入库后的整曲音源，可直接用于点歌翻唱。
 */
export async function autoImportSong(root, {query, fetcher = fetch, signal, run = runMusicTool, limit = 6} = {}) {
  const text = String(query ?? '').trim();
  if (!text || text.length > 100) throw voiceError('SONG_SEARCH_INVALID');
  const found = await searchBilibili({query: text, limit, fetcher, signal});
  const best = found.items.find(item => item.score > 0) ?? found.items[0];
  if (!best) throw voiceError('SONG_SEARCH_NOT_FOUND');
  const imported = await importAudioFromBilibili(root, {bvid: best.bvid, title: best.title, fetcher, signal, run});
  return {
    ...imported,
    matched: {
      provider: 'bilibili',
      title: best.title,
      author: best.author,
      durationSeconds: best.durationSeconds,
      url: best.url,
    },
  };
}

/** 列出可用于翻唱的整曲音源（本地文件必须仍存在） */
export function listFullSongs(root) {
  const folder = directory(root, 'state/voice/songs');
  const items = [];
  for (const file of fs.readdirSync(folder)) {
    if (!/^[a-z0-9]{24}\.json$/.test(file)) continue;
    const id = file.slice(0, -5);
    const wav = path.join(folder, id + '.wav');
    if (!fs.existsSync(wav)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
      if (meta.kind !== 'full-song') continue;
      items.push({
        id,
        title: String(meta.title ?? '网络音源').slice(0, 80),
        durationSeconds: Number(meta.durationSeconds) || 0,
        source: meta.source === 'local' ? 'local' : meta.source === 'bilibili' ? 'bilibili' : 'web',
        origin: String(meta.origin ?? '').slice(0, 200),
        createdAt: Number(meta.createdAt) || 0,
      });
    } catch { /* 跳过损坏条目 */ }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
}

/** 读取整曲音源文件，供点歌时分离 */
export function readFullSong(root, id) {
  if (typeof id !== 'string' || !/^[a-z0-9]{24}$/.test(id)) throw voiceError('WEB_SOURCE_ID_INVALID');
  const folder = directory(root, 'state/voice/songs');
  const wav = path.join(folder, id + '.wav');
  if (!fs.existsSync(wav) || fs.lstatSync(wav).isSymbolicLink()) throw voiceError('WEB_SOURCE_MISSING');
  const metaFile = path.join(folder, id + '.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* ignore */ }
  if (meta.kind !== 'full-song') throw voiceError('WEB_SOURCE_MISSING');
  return { id, file: wav, title: String(meta.title ?? '网络音源'), durationSeconds: Number(meta.durationSeconds) || 0 };
}
