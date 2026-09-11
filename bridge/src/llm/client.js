/**
 * LLM 客户端：一次调用，把一句话变成结构化 JSON（docs/04 §5.1）。
 *
 * 刻意**不是 agent**：没有工具调用、没有多轮循环、不发聊天历史。
 * 每笔账只调一次，失败就降级，不在这里做任何业务判断。
 *
 * 供应商无关：只认「OpenAI 兼容的 /chat/completions」，DeepSeek 与 GLM 都是这个形状，
 * 换供应商只改 config/bridge.json（docs/04 §9.1）。
 */

/** 模型这一轮没给出可用结果——调用方应该降级到规则解析，而不是把错误抛给用户 */
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
    super(`没有配置 ${apiKeyEnv}，本次跳过 LLM 抽取`, { retryable: false });
    this.name = 'LlmNotConfiguredError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从模型输出里抠出 JSON。
 * 关掉了思考模式，理论上就是纯 JSON；但真返回 ```json 围栏或前后带解释也得能认。
 */
export function parseJsonLoose(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(body);
  } catch {
    // 再退一步：取第一个 { 到最后一个 } 之间的内容
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export class LlmClient {
  #baseUrl;
  #apiKey;
  #apiKeyEnv;
  #model;
  #maxTokens;
  #timeoutMs;
  #maxRetries;
  #extraBody;
  #fetch;

  constructor({
    baseUrl, apiKey, apiKeyEnv = 'API_KEY', model, maxTokens = 500,
    timeoutMs = 30_000, maxRetries = 2, extraBody = null, fetchImpl = null,
  } = {}) {
    this.#baseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    this.#apiKey = apiKey ?? '';
    this.#apiKeyEnv = apiKeyEnv;
    this.#model = model;
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
   * 一次 chat 调用，返回 assistant 的文本内容。
   * json 只在「结构化抽取」时需要；把 signals 措辞成人话时要关掉，
   * 否则模型会把建议也塞进 JSON 里。
   */
  async chat({ system, user, json = true }) {
    if (!this.#apiKey) throw new LlmNotConfiguredError(this.#apiKeyEnv);
    if (!this.#baseUrl || !this.#model) throw new LlmError('llm.baseUrl 或 llm.model 没配');

    let lastError = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(400 * attempt);
      try {
        return await this.#once({ system, user, json });
      } catch (err) {
        lastError = err;
        if (!err.retryable) throw err;
      }
    }
    throw lastError ?? new LlmError('LLM 调用失败');
  }

  async #once({ system, user, json }) {
    const body = {
      model: this.#model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
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
      // 401/403 是密钥或权限问题，重试多少次都一样——立刻停下并说清楚
      const retryable = response.status >= 500 || response.status === 429;
      throw new LlmError(
        `LLM 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
        { retryable, status: response.status },
      );
    }

    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    // DeepSeek 官方承认 JSON Output 偶尔返回空内容，所以空内容算「可重试」而不是「没听清」
    if (!content) throw new LlmError('LLM 返回了空内容', { retryable: true });

    return content;
  }

  /** 抽取入口：返回结构化对象；模型没给出合法 JSON 时返回 null，由调用方降级 */
  async extract({ system, user }) {
    const content = await this.chat({ system, user });
    return parseJsonLoose(content);
  }
}
