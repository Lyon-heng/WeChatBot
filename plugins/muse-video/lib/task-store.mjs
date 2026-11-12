// 网页下单台的任务状态持久化。放在 state/media/video/muse-video/ 下，与生成的 mp4 同目录。
// 服务重启后仍能接着轮询未完成任务、补发已生成但未投递的视频。
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

export class TaskStore {
  constructor(root, { relativeDir = 'state/media/video/muse-video', max = 100, retentionMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, relativeDir);
    this.file = path.join(this.dir, 'tasks.json');
    this.max = max;
    this.retentionMs = retentionMs;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      if (data?.version !== VERSION || !Array.isArray(data.tasks)) return { version: VERSION, tasks: [] };
      return data;
    } catch { return { version: VERSION, tasks: [] }; }
  }

  write(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  list() { return this.read().tasks; }

  get(id) { return this.read().tasks.find(task => task.id === String(id)) ?? null; }

  put(task) {
    if (!task?.id) throw Error('TASK_ID_REQUIRED');
    const now = Date.now();
    const state = this.read();
    const others = state.tasks.filter(item => item.id !== task.id && now - (item.createdAt ?? now) < this.retentionMs);
    const next = { ...task, updatedAt: now };
    others.push(next);
    others.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    this.write({ version: VERSION, tasks: others.slice(0, this.max) });
    return next;
  }

  patch(id, changes) {
    const current = this.get(id);
    if (!current) return null;
    return this.put({ ...current, ...changes, id: current.id, createdAt: current.createdAt });
  }

  remove(id) {
    const state = this.read();
    this.write({ version: VERSION, tasks: state.tasks.filter(task => task.id !== String(id)) });
  }
}
