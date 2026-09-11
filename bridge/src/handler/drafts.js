/**
 * 未决草稿：大额 / 低置信度 / 等金额的「先问再记」（docs/04 §4 的第二层）。
 *
 * 落盘保存（`data/bridge-drafts.json`），理由和 context_token 一样：
 * 桥接进程重启后草稿不能凭空消失，否则用户回一句「是」会石沉大海。
 *
 * 键是发送者 ID——单机单人，但白名单允许多个用户，各人的草稿必须互不干扰。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;

export class DraftStore {
  #path;
  #ttlMs;
  #now;
  #drafts;

  constructor(path, { ttlMinutes = 30, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#ttlMs = Math.max(1, ttlMinutes) * 60_000;
    this.#now = now;
    this.#drafts = this.#load();
  }

  #load() {
    if (!this.#path || !existsSync(this.#path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
      return parsed?.version === VERSION && parsed.drafts ? parsed.drafts : {};
    } catch {
      // 草稿是易失数据，文件坏了就当没有；不要因为一个坏文件让整个桥接起不来
      return {};
    }
  }

  #save() {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, `${JSON.stringify({ version: VERSION, drafts: this.#drafts }, null, 2)}\n`);
    } catch (err) {
      console.error('[draft] 落盘失败：', err.message);
    }
  }

  /** 未决草稿；过期的顺手清掉 */
  pending(userId) {
    const draft = this.#drafts[String(userId)];
    if (!draft) return null;
    if (this.#now() - draft.createdAt > this.#ttlMs) {
      delete this.#drafts[String(userId)];
      this.#save();
      return null;
    }
    return draft;
  }

  create(userId, draft) {
    const record = { ...draft, createdAt: this.#now() };
    this.#drafts[String(userId)] = record;
    this.#save();
    return record;
  }

  update(userId, patch) {
    const current = this.pending(userId);
    if (!current) return null;
    const next = { ...current, ...patch, createdAt: this.#now() };
    this.#drafts[String(userId)] = next;
    this.#save();
    return next;
  }

  cancel(userId) {
    const draft = this.pending(userId);
    if (!draft) return null;
    delete this.#drafts[String(userId)];
    this.#save();
    return draft;
  }
}
