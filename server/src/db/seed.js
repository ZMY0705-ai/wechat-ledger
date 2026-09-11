/**
 * 初始数据：账户 + 初始分类体系。
 *
 * 分类清单在 categories.js（依据 docs/02 §3）。全量幂等，可反复执行。
 *
 * 账户模型：两个资产账户
 *   · 现金流    —— 每月进出的钱，日常消费都挂这里
 *   · 长期储蓄  —— 攒下来的钱，只通过「转账」从现金流进来
 *
 * 「现金流 → 长期储蓄」是 transfer，不是支出（docs/02 §4.6）。
 * 这一点很关键：把存钱记成支出会让月度支出虚高、理财进度失真。
 */
import { tx } from './index.js';

export const CASH_ACCOUNT = '现金流';
export const SAVINGS_ACCOUNT = '长期储蓄';

export const ACCOUNT_SPEC = [
  { name: CASH_ACCOUNT, kind: 'asset', sortOrder: 0, desc: '每月进出的钱' },
  { name: SAVINGS_ACCOUNT, kind: 'asset', sortOrder: 1, desc: '攒下来的钱，靠转账从现金流进来' },
];

// 分类清单在 categories.js 里：新库要建、老库要迁移，两边共用同一份定义

/**
 * 确保账户齐全。
 * 早期版本只建了一个「日常」账户；如果它还空着（没有任何流水），
 * 就直接改名成「现金流」，而不是留下一个用不上的空账户。
 */
function ensureAccounts(db, nowStr) {
  const existing = db.prepare('SELECT id, name FROM accounts ORDER BY id').all();
  const names = new Set(existing.map((a) => a.name));
  const renamed = [];

  const only = existing.length === 1 ? existing[0] : null;
  const isPlanned = (name) => ACCOUNT_SPEC.some((s) => s.name === name);
  if (only && !isPlanned(only.name)) {
    const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    if (txCount === 0) {
      db.prepare('UPDATE accounts SET name = ?, sort_order = 0 WHERE id = ?').run(CASH_ACCOUNT, only.id);
      renamed.push(`「${only.name}」→「${CASH_ACCOUNT}」`);
      names.delete(only.name);
      names.add(CASH_ACCOUNT);
    }
  }

  const created = [];
  for (const spec of ACCOUNT_SPEC) {
    if (names.has(spec.name)) continue;
    db.prepare(
      `INSERT INTO accounts(name, kind, initial_cents, sort_order, created_at)
       VALUES(?, ?, 0, ?, ?)`,
    ).run(spec.name, spec.kind, spec.sortOrder, nowStr);
    created.push(spec.name);
  }

  return { created, renamed };
}

export function seed(db, nowStr) {
  return tx(db, () => {
    const accounts = ensureAccounts(db, nowStr);

    // 分类由 openDatabase() 的迁移负责建齐（categories.js）；这里只报一下现在的规模
    const categories = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE archived = 0').get().n;
    return { ...accounts, categories };
  });
}

export function accountByName(db, name) {
  return db
    .prepare('SELECT id, name, kind, initial_cents FROM accounts WHERE name = ? AND archived = 0')
    .get(name) ?? null;
}

/** 日常消费默认挂「现金流」 */
export function defaultAccountId(db) {
  const cash = accountByName(db, CASH_ACCOUNT);
  if (cash) return cash.id;
  const row = db.prepare('SELECT id FROM accounts WHERE archived = 0 ORDER BY sort_order, id LIMIT 1').get();
  if (!row) throw new Error('没有可用账户，先跑一次 seed()');
  return row.id;
}

export function savingsAccountId(db) {
  return accountByName(db, SAVINGS_ACCOUNT)?.id ?? null;
}

/** 按名字找分类（含一级与二级），找不到返回 null */
export function findCategoryByName(db, name, direction = null) {
  if (!name) return null;
  const rows = db
    .prepare(
      `SELECT id, name, parent_id, direction FROM categories
       WHERE name = ? AND archived = 0
       ORDER BY (parent_id IS NULL) DESC, id`,
    )
    .all(name);
  if (!rows.length) return null;
  if (!direction) return rows[0];
  // 方向不符时也把分类返回去：让调用方抛出「支出不能用收入分类」这种精确错误，
  // 而不是含糊的「分类不存在」
  return rows.find((r) => r.direction === direction || r.direction === 'both') ?? rows[0];
}