/**
 * 记账服务：REST API + 静态页面。契约见 docs/03。
 *
 * 几个刻意的选择：
 *   · 零依赖，只用 node:http —— 不装 node_modules 也能跑
 *   · 默认只监听 127.0.0.1：账本是私事，不主动出网
 *   · 不设 Access-Control-Allow-Origin，防止别的网页偷读本地账本
 *   · 写操作一律落到 domain 层：金额、日期、幂等由服务端说了算，不信客户端
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDatabase, DB_PATH, REPO_DIR } from './db/index.js';
import {
  seed, defaultAccountId, savingsAccountId, accountByName, CASH_ACCOUNT, SAVINGS_ACCOUNT,
} from './db/seed.js';
import {
  addTransaction, voidTransaction, listTransactions, ValidationError,
} from './domain/transactions.js';
import {
  getBalance, getDaySummary, getMonthSummary, getDashboard, categoryBreakdown,
} from './domain/summary.js';
import { parseAmountToCents } from './domain/money.js';
import { todayString, nowString, monthOf, isValidDate, isValidMonth } from './domain/time.js';
import { renderReceipt, snapshotAfter } from './domain/receipt.js';
import { parseLedgerText, applyExtracted, CONFIRM_THRESHOLD_CENTS } from './domain/parse.js';
import { getBrief, BRIEF_KINDS } from './domain/brief.js';
import { clearBudget, getBudgetStatus, setBudget } from './domain/budget.js';

const WEB_DIR = join(REPO_DIR, 'web');
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const sendOk = (res, data, message) =>
  sendJson(res, 200, message ? { ok: true, data, message } : { ok: true, data });

const sendErr = (res, status, code, message, hint) =>
  sendJson(res, status, { ok: false, error: { code, message, ...(hint ? { hint } : {}) } });

/** 把 domain 层的中文报错翻译成调用方能据以自纠的错误码（docs/03 §3.2） */
function codeOf(message) {
  if (/金额/.test(message)) return 'BAD_AMOUNT';
  if (/分类/.test(message)) return 'CATEGORY_NOT_FOUND';
  if (/账户/.test(message)) return 'ACCOUNT_NOT_FOUND';
  if (/日期/.test(message)) return 'BAD_DATE';
  return 'BAD_REQUEST';
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 请求体：小、必须是 JSON、有上限（这是个本地服务，但不是没有底线的服务） */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError('请求体过大');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('请求体必须是一个对象');
    }
    return parsed;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError('请求体不是合法 JSON');
  }
}

/** 分类允许写「食品餐饮」「午饭」或「食品餐饮/午饭」，一律取叶子名交给 domain 层校验 */
function leafCategory(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createApp({ dbPath = DB_PATH } = {}) {
  const db = openDatabase(dbPath);
  seed(db, nowString());

  const sseClients = new Set();

  /** SSE 只在事务提交之后广播，避免前端看到还没落库的数据 */
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(frame); } catch { sseClients.delete(client); }
    }
  }

  /**
   * 分类清单：提示词里的清单与落库前的强校验共用这一份，避免两边口径漂移。
   * 桥接通过 GET /api/categories 拿到的是同一份数据。
   */
  const categoryRows = () =>
    db
      .prepare(
        `SELECT c.name, c.direction, c.parent_id, p.name AS parent_name
           FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
          WHERE c.archived = 0
          ORDER BY c.direction, COALESCE(p.sort_order, c.sort_order), c.sort_order, c.id`,
      )
      .all()
      .map((r) => ({
        name: r.name,
        direction: r.direction,
        parentName: r.parent_name,
        path: r.parent_name ? `${r.parent_name}/${r.name}` : r.name,
      }));

  const accountIdFrom = (raw, fallback) => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) {
      const row = db.prepare('SELECT id, name FROM accounts WHERE id = ? AND archived = 0').get(Number(s));
      if (!row) throw new ValidationError(`账户 id ${s} 不存在`);
      return row.id;
    }
    const row = accountByName(db, s);
    if (!row) throw new ValidationError(`账户「${s}」不存在`);
    return row.id;
  };

  const centsFrom = (body) => {
    if (Number.isInteger(body.amountCents)) return body.amountCents;
    const text = body.amountText ?? body.amount;
    if (text === undefined || text === null || text === '') return null;
    return parseAmountToCents(String(text));
  };

  /**
   * 校准的目标余额可以是负的（信用卡欠着钱也是常态），
   * 但 parseAmountToCents 是给「这笔花了多少」用的，只认正数 —— 符号在这里单独处理。
   */
  const signedCentsFrom = (body) => {
    if (Number.isInteger(body.amountCents)) return body.amountCents;
    const text = body.amountText ?? body.amount;
    if (text === undefined || text === null || text === '') return null;
    const raw = String(text).trim();
    const negative = /^[-\u2212]/.test(raw);
    const cents = parseAmountToCents(negative ? raw.slice(1) : raw);
    if (cents === null) return null;
    return negative ? -cents : cents;
  };

  // ── API ────────────────────────────────────────────────────────────────
  async function handleApi(req, res, url) {
    const { pathname: path } = url;
    const q = url.searchParams;
    const method = req.method;

    if (method === 'GET' && path === '/api/health') {
      return sendOk(res, { status: 'ok', serverTime: nowString(), dbPath, today: todayString() });
    }

    if (method === 'GET' && path === '/api/summary/dashboard') {
      const today = q.get('today') ?? todayString();
      if (!isValidDate(today)) return sendErr(res, 400, 'BAD_DATE', `日期不合法：${today}`, '格式应为 YYYY-MM-DD');
      const data = getDashboard(db, {
        today,
        trendDays: clampInt(q.get('trendDays'), 1, 366, 30),
      });
      // 预算跟着 dashboard 一起下发：网页只拉这一个接口，少一次往返、也少一次时序问题
      data.budget = getBudgetStatus(db, { month: monthOf(today), today });
      return sendOk(res, data);
    }

    if (method === 'GET' && path === '/api/summary/balance') {
      return sendOk(res, getBalance(db));
    }

    if (method === 'GET' && path === '/api/summary/day') {
      const date = q.get('date') ?? todayString();
      if (!isValidDate(date)) return sendErr(res, 400, 'BAD_DATE', `日期不合法：${date}`, '格式应为 YYYY-MM-DD');
      return sendOk(res, getDaySummary(db, date));
    }

    if (method === 'GET' && path === '/api/summary/month') {
      const month = q.get('month') ?? monthOf(todayString());
      if (!isValidMonth(month)) return sendErr(res, 400, 'BAD_MONTH', `月份不合法：${month}`, '格式应为 YYYY-MM');
      const data = getMonthSummary(db, month);
      if (Number(q.get('level') ?? 1) === 2) {
        data.expenseBySubcategory = categoryBreakdown(db, { from: data.from, to: data.to, direction: 'expense', level: 2 });
        data.incomeBySubcategory = categoryBreakdown(db, { from: data.from, to: data.to, direction: 'income', level: 2 });
      }
      return sendOk(res, data);
    }

    // ── 干跑解析（只算不写）──
    // 两个用途（docs/03 §6）：给桥接做「LLM 结果的服务端强校验」，
    // 以及不污染账本地验证解析规则。传 extracted 就走强校验，不传就是纯规则解析。
    if (method === 'POST' && path === '/api/parse') {
      const body = await readJson(req);
      const text = String(body.text ?? '').trim();
      if (!text) return sendErr(res, 400, 'BAD_REQUEST', '缺少 text', '例：{"text":"午饭35"}');
      const today = body.today ?? todayString();
      if (!isValidDate(today)) {
        return sendErr(res, 400, 'BAD_DATE', `日期不合法：${today}`, '格式应为 YYYY-MM-DD');
      }
      const opts = {
        today,
        confirmThresholdCents: Number.isInteger(body.confirmThresholdCents)
          ? body.confirmThresholdCents
          : CONFIRM_THRESHOLD_CENTS,
      };
      const data = body.extracted
        ? applyExtracted(text, body.extracted, { ...opts, categories: categoryRows() })
        : parseLedgerText(text, opts);
      return sendOk(res, data);
    }

    // ── 日报（供桥接措辞，docs/03 §5）──
    // markSent=1 时才写 report_log，用来保证「一天只主动推一次」。
    if (method === 'GET' && path === '/api/report/brief') {
      const kind = q.get('kind') ?? 'morning';
      if (!BRIEF_KINDS.includes(kind)) {
        return sendErr(res, 400, 'BAD_KIND', `kind 只能是 ${BRIEF_KINDS.join(' / ')}`, '默认 morning');
      }
      const today = q.get('today') ?? todayString();
      if (!isValidDate(today)) {
        return sendErr(res, 400, 'BAD_DATE', `日期不合法：${today}`, '格式应为 YYYY-MM-DD');
      }
      return sendOk(res, getBrief(db, {
        kind,
        today,
        markSent: q.get('markSent') === '1',
        channel: q.get('channel') ?? 'wechat',
      }));
    }

    // ── 月度预算（docs/02 §2 表结构）──
    // 读：本月预算 + 已花 + 节奏；写：设/改预算，传 0 就是取消。
    if (method === 'GET' && path === '/api/budgets') {
      const month = q.get('month') ?? monthOf(todayString());
      if (!isValidMonth(month)) return sendErr(res, 400, 'BAD_MONTH', `月份不合法：${month}`, '格式应为 YYYY-MM');
      return sendOk(res, getBudgetStatus(db, { month }));
    }

    if (method === 'PUT' && path === '/api/budgets') {
      const body = await readJson(req);
      const month = body.month ?? monthOf(todayString());
      if (!isValidMonth(month)) return sendErr(res, 400, 'BAD_MONTH', `月份不合法：${month}`, '格式应为 YYYY-MM');

      const cents = centsFrom(body);
      if (cents === null) {
        return sendErr(res, 400, 'BAD_AMOUNT', `预算金额解析失败：${body.amountText ?? body.amount ?? '(空)'}`,
          '传 amountCents（整数分）或 amountText（"3000"）；传 0 表示取消预算');
      }

      if (cents > 0) setBudget(db, { month, amountCents: cents });
      else clearBudget(db, { month });

      const status = getBudgetStatus(db, { month });
      broadcast('budget.updated', { month, budgetCents: status.budgetCents });
      return sendOk(res, status, cents > 0 ? `已设置 ${month} 预算` : `已取消 ${month} 预算`);
    }

    // ── 流水 ──
    if (method === 'GET' && path === '/api/transactions') {
      const size = clampInt(q.get('size') ?? q.get('limit'), 1, 500, 50);
      const page = clampInt(q.get('page'), 1, 100000, 1);
      const categoryId = q.get('categoryId');
      const rows = listTransactions(db, {
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
        month: q.get('month') ?? undefined,
        type: q.get('type') ?? undefined,
        categoryId: categoryId ? Number(categoryId) : undefined,
        limit: size,
        offset: (page - 1) * size,
        includeVoided: q.get('all') === '1',
      });
      return sendOk(res, { count: rows.length, page, size, transactions: rows });
    }

    if (method === 'POST' && path === '/api/transactions') {
      const body = await readJson(req);
      const type = body.type ?? 'expense';
      const cents = centsFrom(body);
      if (cents === null) {
        return sendErr(res, 400, 'BAD_AMOUNT', `金额解析失败：${body.amountText ?? body.amount ?? '(空)'}`, '可以传 amountCents（整数分）或 amountText（"35" / "35.5"）');
      }
      const date = body.date ?? body.occurredDate ?? todayString();
      if (!isValidDate(date)) return sendErr(res, 400, 'BAD_DATE', `日期不合法：${date}`, '格式应为 YYYY-MM-DD');

      const accountId = accountIdFrom(body.accountId ?? body.account, defaultAccountId(db));
      let toAccountId = null;
      if (type === 'transfer') {
        toAccountId = accountIdFrom(body.toAccountId ?? body.to, savingsAccountId(db));
        if (toAccountId === null) return sendErr(res, 400, 'ACCOUNT_NOT_FOUND', '转账需要指定转入账户', '默认是「长期储蓄」');
      }

      const { transaction, deduplicated } = addTransaction(db, {
        type,
        amountCents: cents,
        occurredDate: date,
        categoryId: Number.isInteger(body.categoryId) ? body.categoryId : null,
        categoryName: leafCategory(body.category ?? body.categoryName),
        accountId,
        toAccountId,
        note: body.note ?? null,
        rawText: body.rawText ?? null,
        source: body.source ?? 'web',
        sourceMsgId: body.sourceMsgId ?? null,
        idemKey: body.idemKey ?? null,
      });

      const snapshot = snapshotAfter(db, { date: transaction.occurred_date });
      const message = renderReceipt(db, transaction, { deduplicated });

      if (!deduplicated) {
        broadcast('tx.created', {
          id: transaction.id,
          date: transaction.occurred_date,
          type: transaction.type,
          amountCents: transaction.amountCents,
          categoryName: transaction.categoryPath,
        });
      }
      return sendOk(res, { ...transaction, deduplicated, snapshot }, message);
    }

    const voidMatch = /^\/api\/transactions\/(\d+)\/void$/.exec(path);
    if (method === 'POST' && voidMatch) {
      const body = await readJson(req).catch(() => ({}));
      const tx = voidTransaction(db, {
        id: Number(voidMatch[1]),
        reason: body.reason ?? '网页撤销',
      });
      broadcast('tx.voided', { id: tx.id });
      return sendOk(res, { transaction: tx, snapshot: snapshotAfter(db) }, `已撤销 #${tx.id}`);
    }

    // ── 基础数据 ──
    if (method === 'GET' && path === '/api/categories') {
      const rows = db
        .prepare(
          `SELECT c.id, c.name, c.direction, c.parent_id, p.name AS parent_name, c.sort_order
             FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
            WHERE c.archived = 0
            ORDER BY c.direction, COALESCE(p.sort_order, c.sort_order), c.sort_order, c.id`,
        )
        .all();
      return sendOk(res, {
        categories: rows.map((r) => ({
          id: r.id,
          name: r.name,
          direction: r.direction,
          parentId: r.parent_id,
          parentName: r.parent_name,
          path: r.parent_name ? `${r.parent_name}/${r.name}` : r.name,
        })),
      });
    }

    if (method === 'GET' && path === '/api/accounts') {
      return sendOk(res, { accounts: getBalance(db).accounts });
    }

    if (method === 'POST' && path === '/api/adjust') {
      const body = await readJson(req);
      const target = signedCentsFrom(body);
      if (target === null) return sendErr(res, 400, 'BAD_AMOUNT', `目标余额解析失败：${body.amount ?? '(空)'}`);
      const accountId = accountIdFrom(body.accountId ?? body.account, defaultAccountId(db));
      const note = body.note;
      if (!note) return sendErr(res, 400, 'BAD_REQUEST', '余额校准必须写清原因', '用 note 字段说明为什么要校准');

      const current = getBalance(db).accounts.find((a) => a.id === accountId)?.balanceCents ?? 0;
      const delta = target - current;
      if (delta === 0) return sendOk(res, { changed: false, balanceCents: current }, '余额已经对上了，无需校准');

      const { transaction } = addTransaction(db, {
        type: 'modify_balance',
        amountCents: delta,
        occurredDate: body.date ?? todayString(),
        accountId,
        note,
        source: 'web',
      });
      broadcast('tx.created', { id: transaction.id, type: 'modify_balance', amountCents: delta });
      return sendOk(
        res,
        { transaction, snapshot: snapshotAfter(db) },
        `已校准：${formatMoney(current)} → ${formatMoney(target)}（${note}）`,
      );
    }

    if (method === 'GET' && path === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: nowString() })}\n\n`);
      sseClients.add(res);
      const beat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* 断线由 close 事件收尾 */ }
      }, 25_000);
      req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
      return undefined;
    }

    if (method === 'GET' && path === '/api/export') {
      const rows = listTransactions(db, { limit: 100000, includeVoided: true });
      const header = 'id,日期,时间,类型,金额(元),分类,账户,转入账户,备注,原文,来源,状态';
      const body = [
        header,
        ...rows.map((t) => [
          t.id, t.occurred_date, String(t.occurred_at ?? '').slice(11), t.type,
          (t.amountCents / 100).toFixed(2), t.categoryPath ?? '', t.account_name ?? '',
          t.to_account_name ?? '', t.note ?? '', t.raw_text ?? '', t.source ?? '', t.status,
        ].map(csvCell).join(',')),
      ].join('\r\n');
      const buf = Buffer.from(`\uFEFF${body}`, 'utf8');   // BOM：Excel 打开中文才不乱码
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="ledger.csv"',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }

    return sendErr(res, 404, 'NOT_FOUND', `没有这个接口：${method} ${path}`);
  }

  function formatMoney(cents) {
    const yuan = cents / 100;
    return `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // ── 静态页面 ───────────────────────────────────────────────────────────
  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendErr(res, 405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET');
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
    if (rel === '/' || rel === '') rel = '/index.html';

    const target = resolve(WEB_DIR, `.${normalize(rel)}`);
    if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) {
      return sendErr(res, 403, 'FORBIDDEN', '路径越界');
    }

    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        'Content-Length': body.length,
        // no-store 而不是 no-cache：改完样式刷新就一定是最新的，
        // 本地工具不需要为静态资源留任何副本
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      if (extname(rel)) return sendErr(res, 404, 'NOT_FOUND', `找不到 ${rel}`);
      // 单页应用：路径写错也回首页，省得看到一片空白
      try {
        const html = await readFile(join(WEB_DIR, 'index.html'));
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': html.length,
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      } catch {
        return sendErr(res, 404, 'NOT_FOUND', '网页目录还不存在，先启动一次服务');
      }
    }
  }

  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, `http://${req.headers.host ?? DEFAULT_HOST}`);
    const route = url.pathname.startsWith('/api/') ? handleApi : serveStatic;
    Promise.resolve(route(req, res, url)).catch((error) => {
      if (res.headersSent) { try { res.end(); } catch { /* 已经断了 */ } return; }
      if (error instanceof ValidationError) {
        return sendErr(res, 400, codeOf(error.message), error.message);
      }
      console.error('[server] 未预期的错误', error);
      return sendErr(res, 500, 'INTERNAL', '服务出错了，看控制台日志');
    });
  });

  // SSE 是长连接，不能被「请求超时」掐断
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  return { db, server, broadcast };
}

export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, dbPath = DB_PATH } = {}) {
  const app = createApp({ dbPath });
  return new Promise((resolvePromise, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      const actual = app.server.address();
      resolvePromise({ ...app, port: actual.port, host: actual.address, url: `http://${host}:${actual.port}` });
    });
  });
}

// 只有直接运行时才启动；测试里 import 这个模块不应该顺带监听端口
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  startServer({ port, host })
    .then(({ url, db }) => {
      console.log(`记账服务已启动：${url}`);
      console.log(`  数据库：${DB_PATH}`);
      console.log(`  账户：${db.prepare('SELECT name FROM accounts WHERE archived = 0 ORDER BY sort_order, id').all().map((a) => a.name).join(' / ')}`);
      console.log('  停止：Ctrl+C');
    })
    .catch((error) => {
      if (error?.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用。换一个：PORT=8788 npm run serve`);
      } else {
        console.error(error);
      }
      process.exitCode = 1;
    });
}