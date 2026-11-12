/**
 * 联网搜歌（B 站音频源）
 *
 * 网易云版权曲常常拿不到音频，只给歌名时无法完成翻唱。这里补一条不依赖账号的公开音源：
 * 搜索视频 → 用 wbi 签名取 dash 音频流 → 下载音轨，交给上层转成 44.1k WAV 后进入曲库。
 * 只访问固定的 B 站接口与 B 站 CDN 域名，不接受调用方传入的任意地址。
 */
import crypto from 'node:crypto';
import {voiceError} from './jobs.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const MAX_BYTES = 140 * 1024 * 1024;
const BILI_HOSTS = ['bilivideo.com', 'bilivideo.cn', 'biliapi.net', 'szbdyd.com', 'akamaized.net', 'hdslb.com'];
// 搜索引擎喜欢把「伴奏 / 教学 / 翻唱」排前面，这些都不适合作为翻唱底稿
const BAD = /(伴奏|纯音乐|钢琴曲|钢琴版|吉他弹唱|吉他谱|简谱|曲谱|教学|教程|讲解|翻唱|cover|串烧|合集|歌单|直播|reaction|翻跳|舞蹈|演奏|铃声|remix|慢摇|dj版|8d|加速版|降调|变调|鬼畜|ai翻唱|修音|卡拉ok|ktv|消音|去人声|去伴奏|无人声|试听版|广告|预告|花絮|高能|混剪)/i;
const GOOD = /(原曲|原版|完整版|官方|mv|高清|无损|hires|hi-res|4k|原唱|现场|live|正版|ost)/i;
// bilibili 官方 wbi 签名用的混淆表
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, s => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[s])
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' };
/** B 站对无设备指纹的接口请求会返回 412；这里取一次 buvid 并缓存一小时 */
let cookieCache = { value: '', at: 0 };
async function deviceCookie(fetcher, signal) {
  if (cookieCache.value && Date.now() - cookieCache.at < 60 * 60000) return cookieCache.value;
  try {
    const response = await fetcher(API + '/x/frontend/finger/spi', { headers, signal: compact(signal, 6000) });
    const data = await response.json().catch(() => null);
    const b3 = String(data?.data?.b_3 ?? '').slice(0, 64);
    const b4 = String(data?.data?.b_4 ?? '').slice(0, 128);
    if (b3.length > 16) cookieCache = { value: 'buvid3=' + b3 + (b4 ? '; buvid4=' + b4 : ''), at: Date.now() };
  } catch { /* 没有指纹也继续尝试，失败时再报错 */ }
  return cookieCache.value;
}

const withCookie = (cookie, extra = {}) => ({ ...headers, ...(cookie ? { Cookie: cookie } : {}), ...extra });

/** "5:17" / "1:02:33" / 数字 → 秒 */
function durationSeconds(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value ?? '').trim();
  const parts = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(text);
  if (parts) return Number(parts[1] ?? 0) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
  return 0;
}

function assertBiliUrl(raw) {
  let target;
  try { target = new URL(String(raw)); } catch { throw voiceError('BILI_SOURCE_BLOCKED'); }
  if (target.protocol !== 'https:' || target.username || target.password) throw voiceError('BILI_SOURCE_BLOCKED');
  const host = target.hostname.toLowerCase();
  if (!BILI_HOSTS.some(suffix => host === suffix || host.endsWith('.' + suffix))) throw voiceError('BILI_SOURCE_BLOCKED');
  return target;
}

/** wbi 签名密钥，30 分钟缓存 */
let keyCache = { value: '', at: 0 };
async function mixinKey(fetcher, signal) {
  if (keyCache.value && Date.now() - keyCache.at < 30 * 60000) return keyCache.value;
  const cookie = await deviceCookie(fetcher, signal);
  const response = await fetcher(API + '/x/web-interface/nav', { headers: withCookie(cookie), signal: compact(signal, 8000) });
  if (!response.ok) throw voiceError('BILI_SEARCH_UNAVAILABLE');
  const data = await response.json().catch(() => null);
  const img = String(data?.data?.wbi_img?.img_url ?? '').split('/').pop()?.split('.')[0] ?? '';
  const sub = String(data?.data?.wbi_img?.sub_url ?? '').split('/').pop()?.split('.')[0] ?? '';
  if (img.length < 16 || sub.length < 16) throw voiceError('BILI_SEARCH_UNAVAILABLE');
  const raw = img + sub;
  const value = MIXIN_TAB.map(index => raw[index]).join('').slice(0, 32);
  keyCache = { value, at: Date.now() };
  return value;
}

function signed(params, key) {
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all).sort().map(name => encodeURIComponent(name) + '=' + encodeURIComponent(String(all[name]).replace(/[!'()*]/g, ''))).join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + key).digest('hex');
}

function compact(signal, ms) {
  return AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
}

/** 标题与查询的匹配度打分；分数用于自动挑版本 */
function scoreItem(item, tokens) {
  const title = item.title;
  let score = 0;
  for (const token of tokens) if (title.includes(token)) score += 18;
  const flat = value => value.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  if (tokens.length && flat(title).includes(flat(tokens.join('')))) score += 12;
  const seconds = item.durationSeconds;
  if (seconds >= 90 && seconds <= 420) score += 18;
  else if (seconds >= 60 && seconds <= 600) score += 6;
  else if (seconds > 0 && seconds < 45) score -= 40;
  else if (seconds > 900) score -= 30;
  if (BAD.test(title)) score -= 55;
  if (GOOD.test(title)) score += 12;
  score += Math.min(10, Math.log10(Math.max(1, Number(item.play) || 0)) * 2);
  return score;
}

/** 搜索缓存：同一关键词 5 分钟内不重复请求，降低被风控的概率 */
const searchCache = new Map();

/**
 * 在 B 站搜索可作为翻唱底稿的音轨
 * @returns {Promise<{items:Array,note:string}>}
 */
export async function searchBilibili({ query, limit = 8, fetcher = fetch, signal } = {}) {
  const text = String(query ?? '').trim();
  if (!text || text.length > 100) throw voiceError('SONG_SEARCH_INVALID');
  const size = Math.min(20, Math.max(limit * 2, 10));
  const cacheKey = text + '|' + size;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60000) return { ...structuredClone(cached.value), cached: true };
  const tokens = text.split(/\s+/).filter(Boolean).slice(0, 5);
  const cookie = await deviceCookie(fetcher, signal);
  let payload;
  try {
    let key = '';
    try { key = await mixinKey(fetcher, signal); } catch { key = ''; }
    const route = key
      ? API + '/x/web-interface/wbi/search/type?' + signed({ search_type: 'video', keyword: text, page: 1 }, key)
      : API + '/x/web-interface/search/type?search_type=video&page=1&keyword=' + encodeURIComponent(text);
    const response = await fetcher(route, { headers: withCookie(cookie), signal: compact(signal, 9000) });
    if (!response.ok) throw voiceError('BILI_SEARCH_HTTP_' + response.status);
    payload = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.code) throw error;
    if (/timeout|abort/i.test(String(error?.name ?? '') + String(error?.message ?? ''))) throw voiceError('BILI_SEARCH_TIMEOUT');
    throw voiceError('BILI_SEARCH_UNAVAILABLE');
  }
  const rows = Array.isArray(payload?.data?.result) ? payload.data.result : [];
  const items = rows.flatMap(row => {
    const bvid = String(row.bvid ?? '');
    if (!/^BV[A-Za-z0-9]{10}$/.test(bvid)) return [];
    const title = clean(row.title);
    if (!title) return [];
    return [{
      provider: 'bilibili',
      bvid,
      title,
      author: clean(row.author),
      durationSeconds: durationSeconds(row.duration),
      play: Number(row.play) || 0,
      cover: /^https:\/\/[^\s"']+$/.test(String(row.pic ?? '')) ? String(row.pic) : '',
      url: 'https://www.bilibili.com/video/' + bvid + '/',
    }];
  }).map(item => ({ ...item, score: scoreItem(item, tokens) }))
    .sort((a, b) => b.score - a.score || b.play - a.play)
    .slice(0, Math.max(1, Math.min(20, limit)));
  const result = {
    items,
    note: items.length ? '' : 'B 站没有检索到可用音轨，可以补充歌手或换个写法。',
  };
  if (items.length) {
    if (searchCache.size >= 64) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(cacheKey, { at: Date.now(), value: structuredClone(result) });
  }
  return result;
}

/** 取某个视频的音频直链（dash 最高码率音轨，或老视频的整体流） */
export async function resolveBilibiliAudio({ bvid, fetcher = fetch, signal } = {}) {
  if (!/^BV[A-Za-z0-9]{10}$/.test(String(bvid ?? ''))) throw voiceError('BILI_VIDEO_INVALID');
  const cookie = await deviceCookie(fetcher, signal);
  const viewResponse = await fetcher(API + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { headers: withCookie(cookie), signal: compact(signal, 9000) });
  if (!viewResponse.ok) throw voiceError('BILI_VIDEO_UNAVAILABLE');
  const view = await viewResponse.json().catch(() => null);
  const page = view?.data?.pages?.[0];
  const cid = Number(page?.cid);
  if (!Number.isSafeInteger(cid) || cid <= 0) throw voiceError('BILI_VIDEO_UNAVAILABLE');
  let key;
  try { key = await mixinKey(fetcher, signal); } catch { key = ''; }
  const params = { bvid, cid, fnval: 16, fnver: 0, fourk: 1 };
  const route = key
    ? API + '/x/player/wbi/playurl?' + signed(params, key)
    : API + '/x/player/playurl?' + new URLSearchParams(Object.entries(params).map(([name, value]) => [name, String(value)])).toString();
  const response = await fetcher(route, { headers: withCookie(cookie), signal: compact(signal, 12000) });
  if (!response.ok) throw voiceError('BILI_AUDIO_UNAVAILABLE');
  const data = await response.json().catch(() => null);
  if (Number(data?.code) !== 0) throw voiceError('BILI_AUDIO_UNAVAILABLE');
  const dash = data?.data?.dash;
  const streams = Array.isArray(dash?.audio) ? dash.audio.filter(stream => typeof (stream?.baseUrl ?? stream?.base_url) === 'string') : [];
  let url = '';
  let quality = 'audio';
  if (streams.length) {
    const best = [...streams].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0];
    url = String(best.baseUrl ?? best.base_url);
    quality = String(best.id ?? 'dash');
  } else {
    const durl = Array.isArray(data?.data?.durl) ? data.data.durl.find(item => typeof item?.url === 'string') : null;
    if (!durl) throw voiceError('BILI_AUDIO_UNAVAILABLE');
    url = String(durl.url);
    quality = 'durl';
  }
  assertBiliUrl(url);
  return {
    url,
    quality,
    durationSeconds: Number(page?.duration) || Math.round(Number(data?.data?.timelength ?? 0) / 1000) || 0,
    title: clean(view?.data?.title) || 'B 站音源',
    author: clean(view?.data?.owner?.name),
  };
}

/** 下载音轨字节（带 B 站 Referer，限制体积） */
export async function downloadBilibiliAudio({ bvid, fetcher = fetch, signal } = {}) {
  const source = await resolveBilibiliAudio({ bvid, fetcher, signal });
  const response = await fetcher(source.url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Accept: '*/*' },
    signal: compact(signal, 60000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw voiceError('BILI_AUDIO_HTTP_' + response.status);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      await response.body.cancel().catch(() => {});
      throw voiceError('WEB_SOURCE_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 32 * 1024) throw voiceError('BILI_AUDIO_INVALID');
  return { ...source, bytes };
}
