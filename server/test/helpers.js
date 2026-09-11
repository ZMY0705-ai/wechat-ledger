import { openDatabase } from '../src/db/index.js';
import { seed, accountByName, CASH_ACCOUNT, SAVINGS_ACCOUNT } from '../src/db/seed.js';

export const FIXED_NOW = '2026-09-10 12:00:00';
export const TODAY = '2026-09-10';
export { CASH_ACCOUNT, SAVINGS_ACCOUNT };

/** 内存库 + 初始分类，用完即弃，不碰真实账本 */
export function freshDb() {
  const db = openDatabase(':memory:');
  seed(db, FIXED_NOW);
  return db;
}

/**
 * 按名字取账户 id，默认「现金流」——日常消费都挂这里。
 * 用名字而不是 ORDER BY id：以后调整账户顺序时，测试不会莫名其妙地挂掉。
 */
export function accountId(db, name = CASH_ACCOUNT) {
  const row = accountByName(db, name);
  if (!row) throw new Error(`测试库里没有账户「${name}」`);
  return row.id;
}

/** 给账户设期初余额（期初是余额的起点，不是一笔流水） */
export function setInitial(db, name, cents) {
  db.prepare('UPDATE accounts SET initial_cents = ? WHERE id = ?').run(cents, accountId(db, name));
}

/**
 * 只有需要「第三个账户」时才新建（信用卡还款这类场景）。
 * 现金流与长期储蓄已经由 seed 建好，不要再建一个同名的。
 */
export function addCreditAccount(db, name = '信用卡') {
  const info = db
    .prepare('INSERT INTO accounts(name, kind, initial_cents, sort_order, created_at) VALUES(?,?,?,?,?)')
    .run(name, 'credit', -80000, 9, FIXED_NOW);
  return Number(info.lastInsertRowid);
}
