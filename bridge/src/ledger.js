/**
 * 记账服务的 HTTP 客户端。
 *
 * 桥接**不碰数据库**，一律走记账服务的 API（docs/04 §3 的边界一）。
 * 这样桥接可以随时重写、替换（以后加 Telegram），账本一行不用动。
 * 零依赖，只用内置 fetch。
 */

/** 服务端明确返回的业务错误——调用方可以据 code / hint 自纠 */
export class LedgerError extends Error {
  constructor(message, { code = 'LEDGER_ERROR', hint = null, candidates = null, status = 0 } = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.hint = hint;
    this.candidates = candidates;
    this.status = status;
  }
}

/** 服务压根没起来 / 超时——和「参数不对」是两回事，别混在一起报 */
export class LedgerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerUnavailableError';
  }
}

export class LedgerClient {
  #baseUrl;
  #timeoutMs;

  constructor({ baseUrl = 'http://127.0.0.1:8787', timeoutMs = 10_000 } = {}) {
    this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  async #request(method, path, { query, body } = {}) {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new LedgerUnavailableError(
        `连不上记账服务 ${this.#baseUrl}（${err.name === 'TimeoutError' ? '超时' : err.message}）`,
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new LedgerError(`记账服务返回了非 JSON（HTTP ${response.status}）`, { status: response.status });
    }

    if (payload?.ok) return { data: payload.data, message: payload.message ?? null };

    const error = payload?.error ?? {};
    throw new LedgerError(error.message ?? `记账服务报错 HTTP ${response.status}`, {
      code: error.code ?? 'LEDGER_ERROR',
      hint: error.hint ?? null,
      candidates: error.candidates ?? null,
      status: response.status,
    });
  }

  health() {
    return this.#request('GET', '/api/health');
  }

  /** 分类清单：提示词里的清单与强校验用的都是这一份 */
  categories() {
    return this.#request('GET', '/api/categories');
  }

  balance() {
    return this.#request('GET', '/api/summary/balance');
  }

  daySummary(date) {
    return this.#request('GET', '/api/summary/day', { query: { date } });
  }

  monthSummary(month, { level = 1 } = {}) {
    return this.#request('GET', '/api/summary/month', { query: { month, level } });
  }

  /** 日报数据（docs/03 §5）。markSent 由推送方在**发送成功之后**才调用 */
  brief({ kind = 'morning', today, markSent = false, channel } = {}) {
    return this.#request('GET', '/api/report/brief', {
      query: { kind, today, channel, markSent: markSent ? 1 : undefined },
    });
  }

  listTransactions({ limit = 8, month, from, to, type } = {}) {
    return this.#request('GET', '/api/transactions', { query: { size: limit, month, from, to, type } });
  }

  /**
   * 干跑解析：只算不写。
   * 传 extracted 时服务端会做「分类校验 + 时间换算 + 置信度评分 + 硬规则」（docs/04 §5.2）。
   */
  parse(text, { extracted = null, today, confirmThresholdCents } = {}) {
    const body = { text };
    if (extracted) body.extracted = extracted;
    if (today) body.today = today;
    if (Number.isInteger(confirmThresholdCents)) body.confirmThresholdCents = confirmThresholdCents;
    return this.#request('POST', '/api/parse', { body });
  }

  addTransaction(payload) {
    return this.#request('POST', '/api/transactions', { body: payload });
  }

  /**
   * 撤销最近一笔。
   * 服务端只有「按 id 撤销」，所以先取最新一条再撤——两步之间不会有人插队（单机单人）。
   */
  async voidLast(reason = '用户撤销') {
    const { data } = await this.listTransactions({ limit: 1 });
    const latest = data?.transactions?.[0];
    if (!latest) throw new LedgerError('账本里还没有可撤销的流水', { code: 'NOTHING_TO_VOID' });
    return this.voidById(latest.id, reason);
  }

  voidById(id, reason = '用户撤销') {
    return this.#request('POST', `/api/transactions/${id}/void`, { body: { reason } });
  }
}
