// 写稿：人设 + 当天聊天片段 -> 一条朋友圈正文。
// 只做“写”，不做“发”；发布由 publish.mjs 负责，方便先看稿再决定。
import crypto from 'node:crypto';

const MAX_LENGTH = 600;
const CLEAN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const textHash = text => crypto.createHash('sha256').update(String(text)).digest('hex');

export function shanghaiDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = name => parts.find(part => part.type === name).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function shanghaiDateOffset(offsetDays, now = Date.now()) {
  const base = shanghaiDate(now);
  if (!offsetDays) return base;
  const [year, month, day] = base.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10);
}

function historyBlock(rows, cap = 3600) {
  const lines = [];
  let chars = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const body = String(row?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const line = `${String(row?.who ?? '对方').slice(0, 20)}：${body.slice(0, 160)}`;
    if (chars + line.length > cap) break;
    chars += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

export function buildPrompt({personaName, persona, rows, styleExtra, yesterday, maxLength, compact = false}) {
  const name = String(personaName || '我').slice(0, 40);
  const character = String(persona || '').slice(0, compact ? 900 : 3000);
  const chat = historyBlock(rows, compact ? 900 : 3600);
  const extra = String(styleExtra || '').trim().slice(0, 300);
  return [
    `你是「${name}」，现在要发一条自己的微信朋友圈。`,
    character ? `【你的人设】\n${character}` : '',
    chat ? `【${yesterday ? '昨天' : '今天'}的聊天片段】\n${chat}` : '',
    '【写作要求】',
    `- 用第一人称，像随手发的动态，${maxLength} 个汉字上下，1～3 句；`,
    '- 只写当下的感受、一件小事或一点轻吐槽，不要总结聊天、不要复述对话、不要点名任何人；',
    '- 不出现“朋友圈”三个字，不加话题标签，不出现链接、@、电话号码；',
    '- 不编造具体的地点、金额、日期和他人隐私，宁可写得笼统；',
    '- 不要引号包裹全文，不要 Markdown，不要任何解释或前缀，直接输出正文。',
    extra ? `- 额外要求：${extra}` : '',
  ].filter(Boolean).join('\n');
}

/** 收口：去控制字符、去包裹引号、压空行、限长。 */
export function sanitize(raw, maxLength = MAX_LENGTH) {
  let text = String(raw ?? '').replace(CLEAN, '').replace(/\r\n?/g, '\n').trim();
  text = text.replace(/^```[\s\S]*?\n|```$/g, '').trim();
  text = text.replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();
  text = text.replace(/^朋友圈[:：]\s*/u, '').replace(/[ \t]+/g, ' ');
  text = text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 4).join('\n');
  const limit = Math.max(20, Math.min(MAX_LENGTH, Number(maxLength) || MAX_LENGTH));
  if (text.length > limit) text = text.slice(0, limit).trim() + '…';
  return text;
}

/** 生成一条；与最近发过的撞车时最多重写一次。timeoutMs 由调用方决定（聊天工具 8 秒上限）。 */
export async function composeText(ctx, settings, store, {yesterday = false, timeoutMs = 20000, compact = false} = {}) {
  let persona = {personaName: '', persona: ''};
  try {
    persona = (await ctx.persona()) ?? persona;
  } catch {}
  let rows = [];
  try {
    rows = await ctx.history.day({date: shanghaiDateOffset(yesterday ? -1 : 0), limit: 120, maxChars: 12000});
  } catch {}
  const maxLength = Math.max(20, Math.min(300, Number(settings.textLength) || 80));
  const prompt = buildPrompt({
    personaName: persona.personaName, persona: persona.persona, rows,
    styleExtra: settings.styleExtra, yesterday, maxLength, compact,
  });
  const recent = new Set((store.snapshot().history ?? []).slice(-6).map(item => item.hash).filter(Boolean));
  let text = '';
  const attempts = compact ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const draft = await ctx.model.generate({
      prompt: attempt && text ? `${prompt}\n\n（上一条太像之前发过的了，换个角度重写。）` : prompt,
      maxTokens: compact ? 220 : 400, maxChars: MAX_LENGTH, timeoutMs,
    });
    text = sanitize(typeof draft === 'string' ? draft : draft?.text ?? '', maxLength);
    if (!text || !recent.has(textHash(text))) break;
  }
  if (!text) throw new Error('模型没有返回可用的正文');
  return {text, hash: textHash(text), personaName: String(persona.personaName ?? '')};
}
