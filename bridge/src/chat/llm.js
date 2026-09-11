/**
 * 陪聊用的 LLM 客户端：多轮 messages + 温度 + 自由文本。
 *
 * 为什么不复用记账那边那个 `LlmClient`：那个类的契约是「一次调用换一段 JSON，
 * 不发历史」——两条都是为抽取定的规矩。聊天要的恰恰是历史、温度和不带
 * response_format 的自由文本。把两种用途塞进一个类，两边都说不清了。
 * 共用的只有 `parseJsonLoose`（记忆整理也要抠 JSON）。
 */
import { parseJsonLoose } from '../llm/client.js';

export class LlmError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.status = status;
  }
}

export class LlmNotConfiguredError extends LlmError {
  constructor(apiKeyEnv) {
    super(`没有配置 ${apiKeyEnv}，聊不了`, { retryable: false });
    this.name = 'LlmNotConfiguredError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 只留 role/content，并且丢掉空内容——空 content 有些供应商会直接 400 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

export class ChatLlm {
  #baseUrl;
  #apiKey;
  #apiKeyEnv;
  #model;
  #temperature;
  #maxTokens;
  #timeoutMs;
  #maxRetries;
  #extraBody;
  #fetch;

  constructor({
    baseUrl, apiKey, apiKeyEnv = 'API_KEY', model, temperature = 0.85, maxTokens = 800,
    timeoutMs = 45_000, maxRetries = 2, extraBody = null, fetchImpl = null,
  } = {}) {
    this.#baseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    this.#apiKey = apiKey ?? '';
    this.#apiKeyEnv = apiKeyEnv;
    this.#model = model;
    this.#temperature = temperature;
    this.#maxTokens = maxTokens;
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = Math.max(0, Number(maxRetries) || 0);
    this.#extraBody = extraBody ?? {};
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  get configured() {
    return Boolean(this.#apiKey && this.#baseUrl && this.#model);
  }

  get model() {
    return this.#model;
  }

  /**
   * 一次多轮对话调用。
   * @param {{system: string, messages: Array<{role: string, content: string}>, json?: boolean}} args
   * @returns {Promise<string>} assistant 的文本
   */
  async complete({ system, messages, json = false }) {
    if (!this.#apiKey) throw new LlmNotConfiguredError(this.#apiKeyEnv);
    if (!this.#baseUrl || !this.#model) throw new LlmError('llm.baseUrl 或 llm.model 没配');

    let lastError = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(400 * attempt);
      try {
        return await this.#once({ system, messages, json });
      } catch (err) {
        lastError = err;
        if (!err.retryable) throw err;
      }
    }
    throw lastError ?? new LlmError('LLM 调用失败');
  }

  /** 需要 JSON 的场合（目前只有记忆整理），模型没给出合法 JSON 时返回 null */
  async completeJson({ system, user }) {
    const content = await this.complete({
      system,
      messages: [{ role: 'user', content: user }],
      json: true,
    });
    return parseJsonLoose(content);
  }

  async #once({ system, messages, json }) {
    const body = {
      model: this.#model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...normalizeMessages(messages),
      ],
      temperature: this.#temperature,
      max_tokens: this.#maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...this.#extraBody,
    };

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new LlmError(
        `连不上 LLM（${err.name === 'TimeoutError' ? '超时' : err.message}）`,
        { retryable: true },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // 401/403 是密钥或权限问题，重试一百次还是错，只会拖慢回复
      const retryable = response.status >= 500 || response.status === 429;
      throw new LlmError(
        `LLM 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
        { retryable, status: response.status },
      );
    }

    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    // 空内容按「可重试」处理：供应商偶发返回空是已知现象（docs/08 §9.5）
    if (!content) throw new LlmError('LLM 返回了空内容', { retryable: true });
    return content;
  }
}