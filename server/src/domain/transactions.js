/**
 * 流水读写。
 *
 * 铁律（docs/02 §1）：
 *   · 所有聚合必须带 status = 'active' —— 一律走 active_tx 视图
 *   · 软删除，永不物理删除
 *   · idem_key 命中不报错，返回既有记录并标 deduplicated: true
 *   · occurred_date / occurred_month 由服务端算，不接受调用方传
 */
import { tx as inTx } from '../db/index.js';
import { findCategoryByName } from '../db/seed.js';
import { monthOf, isValidDate, toDateTimeString, todayString, toDateString, toTimeString } from './time.js';

export const TX_TYPES = ['expense', 'income', 'transfer', 'modify_balance'];

/** 这三种类型的金额恒正，方向由 type 表达；只有余额校准可正可负 */
const SIGNED_TYPES = new Set(['modify_balance']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const SELECT_TX = `
  SELECT t.id, t.occurred_at, t.occurred_date, t.occurred_month,
         t.type, t.amount_signed_cents,
         t.category_id, c.name AS category_name, pc.name AS parent_category_name,
         t.account_id, a.name AS account_name,
         t.to_account_id, ta.name AS to_account_name,
         t.note, t.raw_text, t.tags,
         t.source, t.source_msg_id, t.idem_key, t.refund_of,
         t.status, t.voided_at, t.void_reason, t.created_at, t.updated_at
    FROM transactions t
    LEFT JOIN categories c  ON c.id  = t.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    LEFT JOIN accounts   a  ON a.id  = t.account_id
    LEFT JOIN accounts   ta ON ta.id = t.to_account_id
`;

/** 对外形态：金额同时给出「分」与「元」，前端和回执都不用自己换算 */
export function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    amountCents: row.amount_signed_cents,
    amountSignedCents: row.amount_signed_cents,
    categoryPath: row.parent_category_name ? `${row.parent_category_name}/${row.category_name}` : row.category_name,
  };
}

export function findByIdemKey(db, idemKey) {
  if (!idemKey) return null;
  return decorate(db.prepare(`${SELECT_TX} WHERE t.idem_key = ?`).get(idemKey));
}

export function getById(db, id) {
  return decorate(db.prepare(`${SELECT_TX} WHERE t.id = ?`).get(id));
}

/**
 * 记一笔。
 * @param {object} input
 * @param {'expense'|'income'|'transfer'|'modify_balance'} input.type
 * @param {number} input.amountCents 分。expense/income/transfer 传正数；modify_balance 可正可负
 * @param {string} [input.occurredDate] 'YYYY-MM-DD'，默认今天（服务端时区）
 * @param {string} [input.occurredTime] 'HH:MM:SS'，默认当前时刻
 * @param {number} [input.categoryId] 与 categoryName 二选一
 * @param {string} [input.categoryName]
 * @returns {{ transaction: object, deduplicated: boolean }}
 */
export function addTransaction(db, input) {
  const {
    type,
    amountCents,
    occurredDate,
    occurredTime,
    categoryId = null,
    categoryName = null,
    accountId,
    toAccountId = null,
    note = null,
    rawText = null,
    tags = null,
    source = 'web',
    sourceMsgId = null,
    idemKey = null,
    refundOf = null,
  } = input ?? {};

  // ── 幂等：命中就直接返回，绝不报错（Agent 重试、网络抖动都靠这个）──
  const existing = findByIdemKey(db, idemKey);
  if (existing) return { transaction: existing, deduplicated: true };

  if (!TX_TYPES.includes(type)) {
    throw new ValidationError(`type 必须是 ${TX_TYPES.join(' / ')} 之一，收到 ${JSON.stringify(type)}`);
  }
  if (!Number.isInteger(amountCents)) {
    throw new ValidationError(`amountCents 必须是整数分，收到 ${JSON.stringify(amountCents)}`);
  }
  if (amountCents === 0) throw new ValidationError('金额不能为 0');
  if (!SIGNED_TYPES.has(type) && amountCents < 0) {
    throw new ValidationError(`${type} 的金额必须为正数，方向由 type 表达；需要调减余额请用 modify_balance`);
  }

  if (!Number.isInteger(accountId)) {
    throw new ValidationError('缺少 accountId（单账户模式下由服务层自动补默认账户）');
  }
  if (type === 'transfer') {
    if (!Number.isInteger(toAccountId)) throw new ValidationError('transfer 必须指定 toAccountId');
    if (toAccountId === accountId) throw new ValidationError('transfer 的转出与转入账户不能相同');
  }

  const date = occurredDate ?? todayString();
  if (!isValidDate(date)) throw new ValidationError(`occurredDate 不是合法日期：${JSON.stringify(date)}`);

  // ── 分类：只允许既有的，不得自创（docs/02 §3）──
  let resolvedCategoryId = categoryId;
  if (!resolvedCategoryId && categoryName) {
    const direction = type === 'income' ? 'income' : type === 'expense' ? 'expense' : null;
    const found = findCategoryByName(db, categoryName, direction);
    if (!found) throw new ValidationError(`分类「${categoryName}」不存在，不能自创分类`);
    resolvedCategoryId = found.id;
  }
  if (resolvedCategoryId != null) {
    const cat = db.prepare('SELECT id, direction FROM categories WHERE id = ?').get(resolvedCategoryId);
    if (!cat) throw new ValidationError(`categoryId ${resolvedCategoryId} 不存在`);
    if (type === 'expense' && cat.direction === 'income') throw new ValidationError('支出不能用收入分类');
    if (type === 'income' && cat.direction === 'expense') throw new ValidationError('收入不能用支出分类');
  }

  // ── modify_balance 的额外约束（docs/02 §4.9）──
  if (type === 'modify_balance') {
    if (resolvedCategoryId != null) throw new ValidationError('余额校准不能带分类');
    if (!note || !String(note).trim()) throw new ValidationError('余额校准必须写清原因（note）');
  }
  if ((type === 'expense' || type === 'income') && resolvedCategoryId == null) {
    throw new ValidationError(`${type} 必须有分类，判断不了请用「待分类」`);
  }

  const now = toDateTimeString();
  const occurredAt = `${date} ${occurredTime ?? toTimeString()}`;

  const info = db
    .prepare(
      `INSERT INTO transactions(
         occurred_at, occurred_date, occurred_month, type, amount_signed_cents,
         category_id, account_id, to_account_id, note, raw_text, tags,
         source, source_msg_id, idem_key, refund_of, status, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
    )
    .run(
      occurredAt, date, monthOf(date), type, amountCents,
      resolvedCategoryId, accountId, toAccountId, note, rawText,
      tags ? JSON.stringify(tags) : null,
      source, sourceMsgId, idemKey, refundOf,
      now, now,
    );

  return { transaction: getById(db, Number(info.lastInsertRowid)), deduplicated: false };
}

/**
 * 改一笔的分类 / 备注。
 *
 * 有意**不支持改金额和日期**：那两样牵动余额和当月统计，改错了不容易看出来，
 * 而且「改金额」在记账语义上更接近「改错了重记一遍」。撤销重记比原地改更诚实。
 *
 * 校验与 addTransaction 同一套：分类必须真实存在、支出不能挂收入分类。
 */
export function updateTransaction(db, { id, categoryName, note }) {
  const target = getById(db, id);
  if (!target) throw new ValidationError(`找不到流水 #${id}`);
  if (target.status === 'voided') throw new ValidationError(`流水 #${id} 已撤销，改不了`);

  const sets = [];
  const params = [];

  if (categoryName !== undefined) {
    if (target.type === 'transfer' || target.type === 'modify_balance') {
      throw new ValidationError(`${target.type} 没有分类，改不了分类`);
    }
    const direction = target.type === 'income' ? 'income' : 'expense';
    const found = findCategoryByName(db, categoryName, direction);
    if (!found) throw new ValidationError(`分类「${categoryName}」不存在，不能自创分类`);
    if (target.type === 'expense' && found.direction === 'income') throw new ValidationError('支出不能用收入分类');
    if (target.type === 'income' && found.direction === 'expense') throw new ValidationError('收入不能用支出分类');
    sets.push('category_id = ?');
    params.push(found.id);
  }

  if (note !== undefined) {
    const text = note === null ? '' : String(note).trim();
    sets.push('note = ?');
    params.push(text || null);
  }

  if (!sets.length) throw new ValidationError('没有要改的字段：可改 --category（分类）/ --note（备注）');

  sets.push('updated_at = ?');
  params.push(toDateTimeString(), id);
  db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return getById(db, id);
}

/** 软删除。返回被撤销的流水；已经撤销过就原样返回（幂等） */
export function voidTransaction(db, { id, reason = null, idemKey = null }) {
  const target = id != null ? getById(db, id) : findByIdemKey(db, idemKey);
  if (!target) throw new ValidationError(`找不到要撤销的流水：${JSON.stringify({ id, idemKey })}`);
  if (target.status === 'voided') return target;

  const now = toDateTimeString();
  db.prepare(
    "UPDATE transactions SET status='voided', voided_at=?, void_reason=?, updated_at=? WHERE id=?",
  ).run(now, reason, now, target.id);

  return getById(db, target.id);
}

/** 最近一笔有效流水（「撤销」指令用） */
export function lastActiveTransaction(db) {
  const row = db
    .prepare(`${SELECT_TX} WHERE t.status='active' ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1`)
    .get();
  return decorate(row);
}

/**
 * 查流水。
 * @param {object} opts
 * @param {string} [opts.from] 'YYYY-MM-DD' 含
 * @param {string} [opts.to]   'YYYY-MM-DD' 含
 * @param {string} [opts.month] 'YYYY-MM'
 * @param {string} [opts.type]
 * @param {boolean} [opts.includeVoided]
 */
export function listTransactions(db, opts = {}) {
  const { from, to, month, type, categoryId, limit = 50, offset = 0, includeVoided = false } = opts;
  const where = [];
  const params = [];

  if (!includeVoided) where.push("t.status = 'active'");
  if (month) { where.push('t.occurred_month = ?'); params.push(month); }
  if (from) { where.push('t.occurred_date >= ?'); params.push(from); }
  if (to) { where.push('t.occurred_date <= ?'); params.push(to); }
  if (type) { where.push('t.type = ?'); params.push(type); }
  // 点饼图筛选时传的是一级分类 id，二级明细也得跟着出来
  if (categoryId) {
    where.push('(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
    params.push(categoryId, categoryId);
  }

  const sql =
    SELECT_TX +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY t.occurred_at DESC, t.id DESC LIMIT ? OFFSET ?';

  return db.prepare(sql).all(...params, limit, offset).map(decorate);
}

export function countTransactions(db, opts = {}) {
  const { from, to, includeVoided = false } = opts;
  const where = [];
  const params = [];
  if (!includeVoided) where.push("status = 'active'");
  if (from) { where.push('occurred_date >= ?'); params.push(from); }
  if (to) { where.push('occurred_date <= ?'); params.push(to); }
  const sql = `SELECT COUNT(*) AS n FROM transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return db.prepare(sql).get(...params).n;
}

/** 撤销「最近一笔」——微信里说「撤销」时的默认目标 */
export function voidLast(db, reason = '用户撤销') {
  const last = lastActiveTransaction(db);
  if (!last) throw new ValidationError('还没有任何可撤销的流水');
  return voidTransaction(db, { id: last.id, reason });
}

export { inTx };