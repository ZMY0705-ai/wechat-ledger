/**
 * 长期记忆：会话历史 + 从对话里攒下来的「关于他」。
 *
 * 分两层，理由和记账里的草稿/context_token 一样——**进程重启不能失忆**：
 *   · turns   —— 最近的原始对话，直接当多轮上下文发给模型（滚动窗口，会丢老的）
 *   · profile —— 事实清单 + 最近聊过什么，由模型定期整理，不随窗口滚掉
 *
 * 只保窗口、不做「全量历史」是刻意的：聊天要的是接得上话，不是完整档案。
 * 真需要翻旧账的场景，模型整理出的 facts/summary 才是那条线索。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;
const MAX_FACT_LENGTH = 60;
const MAX_SUMMARY_LENGTH = 400;

const emptyProfile = () => ({ facts: [], summary: '', updatedAt: null });

export class MemoryStore {
  #path;
  #maxTurns;
  #maxFacts;
  #now;
  #users;

  constructor(path, { maxTurns = 24, maxFacts = 40, now = () => Date.now() } = {}) {
    this.#path = path;
    this.#maxTurns = Math.max(2, Number(maxTurns) || 24);
    this.#maxFacts = Math.max(1, Number(maxFacts) || 40);
    this.#now = now;
    this.#users = this.#load();
  }

  #load() {
    if (!this.#path || !existsSync(this.#path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
      return parsed?.version === VERSION && parsed.users ? parsed.users : {};
    } catch (err) {
      // 记忆文件坏了就当没聊过：不能让一个坏文件把整个 bot 卡死
      console.error(`[memory] 读取 ${this.#path} 失败，按空处理：${err.message}`);
      return {};
    }
  }

  /** 原子写：先写临时文件再改名。聊天是随时可能断电的场景，半截 JSON 最麻烦 */
  #save() {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: VERSION, users: this.#users }, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      console.error(`[memory] 保存 ${this.#path} 失败：${err.message}`);
    }
  }

  #entry(userId) {
    const key = String(userId);
    if (!this.#users[key]) {
      this.#users[key] = {
        updatedAt: this.#now(),
        turns: [],
        sinceDigest: 0,
        lastDigestAt: 0,
        digestFailedAt: 0,
        profile: emptyProfile(),
      };
    }
    const entry = this.#users[key];
    // 兼容手工编辑过的文件：缺字段就补上，别让后面的代码到处判空
    entry.turns ??= [];
    entry.sinceDigest ??= 0;
    entry.lastDigestAt ??= 0;
    entry.digestFailedAt ??= 0;
    entry.profile = { ...emptyProfile(), ...(entry.profile ?? {}) };
    return entry;
  }

  /** 发给模型的多轮上下文（最近 limit 条） */
  history(userId, limit = this.#maxTurns) {
    const entry = this.#entry(userId);
    return entry.turns.slice(-Math.max(1, limit)).map((t) => ({ role: t.role, content: t.content }));
  }

  append(userId, role, content) {
    const text = String(content ?? '').trim();
    if (!text) return null;
    const entry = this.#entry(userId);
    entry.turns.push({ role: role === 'assistant' ? 'assistant' : 'user', at: this.#now(), content: text });
    if (entry.turns.length > this.#maxTurns) entry.turns = entry.turns.slice(-this.#maxTurns);
    if (role === 'assistant') entry.sinceDigest += 1;
    entry.updatedAt = this.#now();
    this.#save();
    return entry;
  }

  /** 撤掉最后 n 条（「/重说」用：把上一句回答扔掉，拿同一句话重新问一遍） */
  dropLast(userId, n = 1) {
    const entry = this.#entry(userId);
    const dropped = entry.turns.splice(Math.max(0, entry.turns.length - Math.max(0, n)));
    this.#save();
    return dropped;
  }

  stats(userId) {
    const entry = this.#entry(userId);
    return {
      turns: entry.turns.length,
      sinceDigest: entry.sinceDigest,
      lastDigestAt: entry.lastDigestAt,
      digestFailedAt: entry.digestFailedAt,
      lastActiveAt: entry.updatedAt,
      lastUserText: [...entry.turns].reverse().find((t) => t.role === 'user')?.content ?? '',
    };
  }

  /** 整理成功：清零计数，并记住这次整理的时间 */
  noteDigest(userId) {
    const entry = this.#entry(userId);
    entry.sinceDigest = 0;
    entry.lastDigestAt = this.#now();
    entry.digestFailedAt = 0;
    this.#save();
  }

  /** 整理失败：不清零计数，但留个失败时间，靠冷却避免每句都重试 */
  noteDigestFailure(userId) {
    const entry = this.#entry(userId);
    entry.digestFailedAt = this.#now();
    this.#save();
  }

  profile(userId) {
    const { facts, summary } = this.#entry(userId).profile;
    return { facts: [...facts], summary };
  }

  /** 模型整理回来的长期记忆。facts 是**完整列表**（含旧的），不是增量 */
  mergeProfile(userId, { facts, summary } = {}) {
    const entry = this.#entry(userId);
    // facts 不是数组（模型只回了 summary）时，**保留旧的清单**——
    // 宁可这一轮不更新，也不能因为模型少写一个字段就把记忆清空
    const incoming = Array.isArray(facts) ? facts : entry.profile.facts;
    const cleaned = [];
    for (const raw of incoming) {
      if (typeof raw !== 'string') continue;
      const fact = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_FACT_LENGTH);
      if (!fact || cleaned.includes(fact)) continue;
      cleaned.push(fact);
    }
    // 超上限时丢最老的：模型按重要性排序的输出习惯是把要紧的放前面
    const kept = cleaned.slice(0, this.#maxFacts);
    const nextSummary = typeof summary === 'string'
      ? summary.trim().replace(/\s+/g, ' ').slice(0, MAX_SUMMARY_LENGTH)
      : entry.profile.summary;

    entry.profile = { facts: kept, summary: nextSummary, updatedAt: this.#now() };
    entry.updatedAt = this.#now();
    this.#save();
    return { ...entry.profile };
  }

  /** 手写一条记忆（「/记住 xxx」），排在最前面——用户自己说的优先级最高 */
  addFact(userId, text) {
    const entry = this.#entry(userId);
    const fact = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_FACT_LENGTH);
    if (!fact) return null;
    if (entry.profile.facts.includes(fact)) return fact;
    entry.profile.facts = [fact, ...entry.profile.facts].slice(0, this.#maxFacts);
    entry.profile.updatedAt = this.#now();
    entry.updatedAt = this.#now();
    this.#save();
    return fact;
  }

  /** 删掉包含关键词的记忆，返回删掉的条数 */
  forget(userId, keyword) {
    const entry = this.#entry(userId);
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (!needle) return 0;
    const before = entry.profile.facts.length;
    entry.profile.facts = entry.profile.facts.filter((f) => !f.toLowerCase().includes(needle));
    const removed = before - entry.profile.facts.length;
    if (removed) {
      entry.profile.updatedAt = this.#now();
      entry.updatedAt = this.#now();
      this.#save();
    }
    return removed;
  }

  /** 清空。keepProfile=true 只忘掉最近的对话，长期记忆留着 */
  clear(userId, { keepProfile = true } = {}) {
    const entry = this.#entry(userId);
    entry.turns = [];
    entry.sinceDigest = 0;
    if (!keepProfile) {
      entry.profile = emptyProfile();
      entry.lastDigestAt = 0;
    }
    entry.updatedAt = this.#now();
    this.#save();
  }
}