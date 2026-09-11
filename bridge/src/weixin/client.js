/**
 * 微信 iLink Bot 客户端：长轮询收消息、HTTP 发消息。
 *
 * 协议规格见 docs/04-自写微信桥接与LLM接入.md §2。
 * 零运行时依赖，只用 Node 内置的 fetch 与 node:crypto。
 */
import { randomUUID } from 'node:crypto';
import { ContextStore } from './context.js';
import { isSenderAllowed, parseIdList } from '../util.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '0.1.0';
const POLL_TIMEOUT_MS = 40_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_SEEN_IDS = 500;

export const MAX_MESSAGE_LENGTH = 2000;

export class TokenExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export class SenderNotAllowedError extends Error {
  constructor(senderId) {
    super(`发送者 ${senderId} 不在白名单里，已拒绝`);
    this.name = 'SenderNotAllowedError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从一条 update 里取出我们关心的东西。
 * message_type 1 = 用户消息；2 及以上是 bot 自己发的，必须跳过。
 */
export function parseInbound(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.message_type !== undefined && update.message_type !== 1) return null;

  const senderId = update.from_user_id;
  if (!senderId) return null;

  const items = Array.isArray(update.item_list) ? update.item_list : [];
  let text = '';
  const attachments = [];

  for (const item of items) {
    switch (item?.type) {
      case 1:
        text += item.text_item?.text ?? '';
        break;
      case 2:
        attachments.push('图片');
        break;
      case 3:
        text += item.voice_item?.text ?? '';
        break;
      case 4:
        attachments.push('文件');
        break;
      case 5:
        attachments.push('视频');
        break;
      default:
        break;
    }
  }

  if (!text && attachments.length === 0) return null;

  return {
    senderId,
    messageId: update.client_id ?? '',
    text: text || `（收到${attachments.join('、')}）`,
    attachments,
    contextToken: update.context_token ?? '',
    raw: update,
  };
}

/** 微信单条上限 2000 字符，超长按换行处切分 */
export function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class WeixinClient {
  #token;
  #baseUrl;
  #contexts;
  #allow;
  #seen = new Set();
  #running = false;
  #abort = null;
  #cursor = '';
  #onMessage = null;
  #onFatal = null;

  constructor({ token, baseUrl = DEFAULT_BASE_URL, contextStorePath, allowedUserIds = [] }) {
    if (!token) throw new Error('WeixinClient 需要 token');
    this.#token = token;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#contexts = new ContextStore(contextStorePath);
    this.#allow = parseIdList(allowedUserIds);
  }

  /** 白名单：只有这些人发来的消息会被处理，也只有这些人收得到回复 */
  get allowedUserIds() {
    return this.#allow;
  }

  allows(senderId) {
    return isSenderAllowed(this.#allow, senderId);
  }

  /** 曾经给 bot 发过消息的人（对应「主动发送的收件人」） */
  get knownSenders() {
    return this.#contexts.keys();
  }

  start(onMessage, onFatal) {
    if (this.#running) return;
    this.#running = true;
    this.#onMessage = onMessage;
    this.#onFatal = onFatal;

    if (this.#allow.length === 0) {
      console.warn('[weixin] ⚠️ 未设置 WEIXIN_ALLOWED_USER_IDS：任何人都能给 bot 发消息记账。');
      console.warn('[weixin]    跑 `npm run login` 拿到 ilink_user_id 后填进 .env 即可锁死。');
    } else {
      console.log(`[weixin] 白名单已启用：${this.#allow.join(', ')}`);
    }

    this.#pollLoop().catch((err) => console.error('[weixin] 轮询循环异常退出：', err));
  }

  async stop() {
    this.#running = false;
    this.#abort?.abort();
    this.#abort = null;
  }

  /** 回复一条来信 */
  async reply(senderId, text) {
    if (!this.allows(senderId)) throw new SenderNotAllowedError(senderId);
    const contextToken = this.#contexts.get(senderId);
    if (!contextToken) {
      throw new Error(`没有 ${senderId} 的 context_token，无法回复（对方需先给 bot 发过消息）`);
    }
    await this.#send(senderId, text, contextToken);
  }

  /** 主动发送（晨报）。失败通常意味着 context_token 已过期。 */
  async sendProactive(senderId, text) {
    if (!this.allows(senderId)) throw new SenderNotAllowedError(senderId);
    const contextToken = this.#contexts.get(senderId);
    if (!contextToken) {
      throw new Error(`没有 ${senderId} 的 context_token——该用户从未给 bot 发过消息，主动发送不可用`);
    }
    await this.#send(senderId, text, contextToken);
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  #headers() {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.#token}`,
      'X-WECHAT-UIN': String(Math.floor(Math.random() * 1_000_000_000)),
    };
  }

  async #pollLoop() {
    let consecutiveErrors = 0;

    while (this.#running) {
      try {
        const updates = await this.#fetchUpdates();
        consecutiveErrors = 0;
        for (const update of updates) {
          await this.#handleUpdate(update);
        }
      } catch (err) {
        if (err instanceof TokenExpiredError) {
          this.#running = false;
          console.error('\n[weixin] Token 已失效，轮询停止。');
          console.error('[weixin] 请重新执行 `npm run login` 扫码换取新 token。\n');
          this.#onFatal?.(err);
          return;
        }

        // 客户端主动 abort：停止时正常退出；超时时立刻重试
        if (err?.name === 'AbortError') {
          if (!this.#running) break;
          continue;
        }

        consecutiveErrors += 1;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveErrors - 1), BACKOFF_MAX_MS);
        console.error(
          `[weixin] 轮询失败（第 ${consecutiveErrors} 次）：${err.message}，${delay}ms 后重试`,
        );
        await sleep(delay);
      }
    }
  }

  async #fetchUpdates() {
    this.#abort = new AbortController();
    const timer = setTimeout(() => this.#abort?.abort(), POLL_TIMEOUT_MS);

    try {
      const resp = await fetch(`${this.#baseUrl}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          get_updates_buf: this.#cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        signal: this.#abort.signal,
      });

      if (resp.status === 401) throw new TokenExpiredError('getupdates 返回 401');
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

      const data = await resp.json();
      if (data.get_updates_buf) this.#cursor = data.get_updates_buf;
      return Array.isArray(data.msgs) ? data.msgs : [];
    } finally {
      clearTimeout(timer);
    }
  }

  async #handleUpdate(update) {
    const msg = parseInbound(update);
    if (!msg) return;

    // 白名单先于一切：非白名单消息连 context_token 都不记，
    // 免得日后晨报误发给陌生人。
    if (!this.allows(msg.senderId)) {
      console.warn(`[weixin] 已忽略非白名单发送者的消息：${msg.senderId}`);
      return;
    }

    if (msg.messageId) {
      if (this.#seen.has(msg.messageId)) return;
      this.#seen.add(msg.messageId);
      if (this.#seen.size > MAX_SEEN_IDS) {
        this.#seen = new Set([...this.#seen].slice(-(MAX_SEEN_IDS >> 1)));
      }
    }

    if (msg.contextToken) this.#contexts.set(msg.senderId, msg.contextToken);

    try {
      await this.#onMessage(msg);
    } catch (err) {
      console.error('[weixin] 处理消息出错：', err);
    }
  }

  async #send(toUserId, text, contextToken) {
    for (const chunk of splitMessage(text)) {
      const resp = await fetch(`${this.#baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
      });

      if (resp.status === 401) throw new TokenExpiredError('sendmessage 返回 401');
      if (!resp.ok) throw new Error(`sendmessage HTTP ${resp.status} ${resp.statusText}`);
    }
  }
}