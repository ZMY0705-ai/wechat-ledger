/**
 * context_token 持久化。
 *
 * golembot 把它放在内存里，进程重启就丢，导致重启后无法主动发送任何消息
 * （官方文档原话：重启后如果没人先发消息，定时任务将没有收件人）。
 * 我们落盘，重启后晨报仍然发得出去。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class ContextStore {
  #path;
  #entries = new Map();

  constructor(path) {
    this.#path = path;
    this.#load();
  }

  #load() {
    if (!existsSync(this.#path)) return;
    try {
      const obj = JSON.parse(readFileSync(this.#path, 'utf8'));
      for (const [senderId, entry] of Object.entries(obj)) {
        if (entry?.context_token) this.#entries.set(senderId, entry);
      }
    } catch (err) {
      console.error(`[weixin] 读取 ${this.#path} 失败，按空处理：${err.message}`);
    }
  }

  get(senderId) {
    return this.#entries.get(senderId)?.context_token;
  }

  set(senderId, contextToken) {
    if (!senderId || !contextToken) return;
    this.#entries.set(senderId, {
      context_token: contextToken,
      updated_at: new Date().toISOString(),
    });
    this.#flush();
  }

  keys() {
    return [...this.#entries.keys()];
  }

  /** 原子写：先写临时文件再改名，避免写一半被读到 */
  #flush() {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#entries), null, 2), 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      console.error(`[weixin] 保存 ${this.#path} 失败：${err.message}`);
    }
  }
}