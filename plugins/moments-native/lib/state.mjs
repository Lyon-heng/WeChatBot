// 插件自己的落盘：提案（正文 + 定稿报文）、发件箱、当天计数。
// 只写 state/moments-native，不碰宿主配置；写入走临时文件 + rename。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_HISTORY = 60;
const MAX_OUTBOX = 200;
const MAX_PROPOSALS = 60;

const ensure = folder => fs.mkdirSync(folder, {recursive: true});

function readJson(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return fallback;
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class Store {
  constructor(base) {
    this.base = base;
    this.file = path.join(base, 'state.json');
    this.outbox = path.join(base, 'outbox');
    this.proposals = path.join(base, 'proposals');
  }

  snapshot() {
    ensure(this.base);
    const value = readJson(this.file, {});
    return {
      date: typeof value.date === 'string' ? value.date : '',
      count: Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : 0,
      attempted: Array.isArray(value.attempted) ? value.attempted.filter(item => typeof item === 'string').slice(-40) : [],
      history: Array.isArray(value.history) ? value.history.slice(-MAX_HISTORY) : [],
      last: value.last && typeof value.last === 'object' ? value.last : null,
      lastError: typeof value.lastError === 'string' ? value.lastError : '',
    };
  }

  save(state) {
    ensure(this.base);
    writeJson(this.file, {
      date: state.date ?? '',
      count: state.count ?? 0,
      attempted: (state.attempted ?? []).slice(-40),
      last: state.last ?? null,
      lastError: state.lastError ?? '',
      history: (state.history ?? []).slice(-MAX_HISTORY),
    });
  }

  push(state, entry) {
    state.history = [...(state.history ?? []), entry].slice(-MAX_HISTORY);
    state.last = entry;
  }

  /**
   * 提案落盘：正文 JSON + 定稿报文 bin，交给加载器按哈希授权。
   * 字段与 xiaoyu 的 proposals/*.json 保持兼容（created 用毫秒、带 coreSha256），
   * 这样可以直接把本文件路径喂给他们的加载脚本。
   */
  writeProposal({account, text, visibility, packet, requestId, created, sha256, timeline, coreSha256}) {
    ensure(this.proposals);
    const id = crypto.randomUUID();
    const packetFile = path.join(this.proposals, id + '.bin');
    fs.writeFileSync(packetFile, packet, {mode: 0o600});
    const proposal = {
      schema: 1, id, kind: 'text', account, text, visibility, requestId,
      created: created * 1000, createTime: created,
      packetSha256: sha256, packetFile, file: path.join(this.proposals, id + '.json'),
      coreSha256, timeline, createdAt: new Date().toISOString(),
      notice: '这只是待授权的发布材料：组件还没加载、也还没发布。',
    };
    writeJson(proposal.file, proposal);
    this.pruneProposals();
    return proposal;
  }

  pruneProposals() {
    try {
      const files = fs.readdirSync(this.proposals).filter(item => item.endsWith('.json')).sort();
      for (const item of files.slice(0, Math.max(0, files.length - MAX_PROPOSALS))) {
        const id = item.replace(/\.json$/, '');
        try { fs.unlinkSync(path.join(this.proposals, id + '.bin')); } catch {}
        try { fs.unlinkSync(path.join(this.proposals, item)); } catch {}
      }
    } catch {}
  }

  readProposal(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id ?? ''))) return null;
    const proposal = readJson(path.join(this.proposals, id + '.json'), null);
    if (!proposal) return null;
    try {
      proposal.packet = fs.readFileSync(path.join(this.proposals, id + '.bin'));
    } catch {
      return null;
    }
    return proposal;
  }

  /** 发件箱：草稿/失败稿留一份，避免文案白写；只保留最近 200 条。 */
  writeOutbox(text, kind = 'draft') {
    ensure(this.outbox);
    const name = `${stamp()}-${kind}.md`;
    fs.writeFileSync(path.join(this.outbox, name), text + '\n', 'utf8');
    try {
      const files = fs.readdirSync(this.outbox).filter(item => item.endsWith('.md')).sort();
      for (const item of files.slice(0, Math.max(0, files.length - MAX_OUTBOX))) {
        fs.unlinkSync(path.join(this.outbox, item));
      }
    } catch {}
    return path.join('outbox', name).replaceAll(path.sep, '/');
  }

  outboxCount() {
    try {
      return fs.readdirSync(this.outbox).filter(item => item.endsWith('.md')).length;
    } catch {
      return 0;
    }
  }
}
