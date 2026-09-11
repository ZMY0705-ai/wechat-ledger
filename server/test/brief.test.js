import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, accountId, CASH_ACCOUNT, SAVINGS_ACCOUNT, FIXED_NOW } from './helpers.js';
import { addTransaction } from '../src/domain/transactions.js';
import { buildSignals } from '../src/domain/signals.js';
import { getBrief, markSent, alreadySentToday } from '../src/domain/brief.js';

const TODAY = '2026-09-10';
const daysAgo = (n) => {
  const [y, m, d] = TODAY.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - n));
  return dt.toISOString().slice(0, 10);
};

/** 记一笔支出/收入，账户默认挂现金流 */
function add(db, { type = 'expense', yuan, date, category = '食品餐饮', account = CASH_ACCOUNT, to = null }) {
  return addTransaction(db, {
    type,
    amountCents: Math.round(yuan * 100),
    occurredDate: date,
    categoryName: type === 'transfer' || type === 'income' ? (type === 'income' ? category : null) : category,
    accountId: accountId(db, account),
    toAccountId: to ? accountId(db, to) : null,
  });
}

const codes = (signals) => signals.map((s) => s.code);
const has = (signals, code) => codes(signals).includes(code);

test('空账本：只提醒「还没记过账」', () => {
  const db = freshDb();
  const signals = buildSignals(db, { today: TODAY });
  assert.deepEqual(codes(signals), ['never_recorded']);
  db.close();
});

test('支出突增：昨天远超近期日均时报 warn', () => {
  const db = freshDb();
  db.prepare('UPDATE accounts SET initial_cents = 100000000 WHERE name = ?').run(CASH_ACCOUNT);
  for (let i = 2; i <= 25; i++) add(db, { yuan: 100, date: daysAgo(i) });
  add(db, { yuan: 500, date: daysAgo(1) });

  const spike = buildSignals(db, { today: TODAY }).find((s) => s.code === 'expense_spike');
  assert.ok(spike, `没报突增：${codes(buildSignals(db, { today: TODAY }))}`);
  assert.equal(spike.severity, 'warn');
  assert.equal(spike.params.yesterdayCents, 50000);
  assert.ok(spike.params.ratio >= 1.8);
  db.close();
});

test('支出突增：金额太小就不打扰（绝对值下限兜住）', () => {
  const db = freshDb();
  db.prepare('UPDATE accounts SET initial_cents = 100000000 WHERE name = ?').run(CASH_ACCOUNT);
  add(db, { yuan: 150, date: daysAgo(1) });   // 日均只有 5 元，比值超 30 倍
  const signals = buildSignals(db, { today: TODAY, rules: { expenseSpikeMinCents: 100000 } });
  assert.ok(!has(signals, 'expense_spike'), '低于下限不该报');
  db.close();
});

test('现金流余量：按近期日均算出撑不了几天', () => {
  const db = freshDb();
  for (let i = 1; i <= 30; i++) add(db, { yuan: 100, date: daysAgo(i) });
  // 花掉 3000，留 300 —— 按日均 100 算只够 3 天
  db.prepare('UPDATE accounts SET initial_cents = 330000 WHERE name = ?').run(CASH_ACCOUNT);

  const low = buildSignals(db, { today: TODAY }).find((s) => s.code === 'balance_low');
  assert.ok(low, `没报余量不足：${codes(buildSignals(db, { today: TODAY }))}`);
  assert.equal(low.params.cashCents, 30000);
  assert.ok(low.params.days < 7);
  db.close();
});

test('预算进度：花得比时间进度快就报', () => {
  const db = freshDb();
  db.prepare('UPDATE accounts SET initial_cents = 100000000 WHERE name = ?').run(CASH_ACCOUNT);
  add(db, { yuan: 4000, date: TODAY });
  db.prepare('INSERT INTO budgets(period_month, category_id, amount_cents) VALUES(?, NULL, ?)').run('2026-09', 500000);

  const pace = buildSignals(db, { today: TODAY }).find((s) => s.code === 'budget_pace');
  assert.ok(pace, `没报预算超速：${codes(buildSignals(db, { today: TODAY }))}`);
  assert.equal(pace.params.budgetCents, 500000);
  assert.equal(pace.params.spentCents, 400000);
  db.close();
});

test('没设预算但本月有支出：提醒一次（建议质量强依赖预算）', () => {
  const db = freshDb();
  add(db, { yuan: 50, date: TODAY });
  assert.ok(has(buildSignals(db, { today: TODAY }), 'budget_absent'));
  db.close();
});

test('本月有收入却没往储蓄转钱', () => {
  const db = freshDb();
  add(db, { type: 'income', yuan: 12000, date: TODAY, category: '工资' });
  assert.ok(has(buildSignals(db, { today: TODAY }), 'savings_none'));
  db.close();
});

test('存过钱就不再念叨', () => {
  const db = freshDb();
  add(db, { type: 'income', yuan: 12000, date: TODAY, category: '工资' });
  db.prepare('UPDATE accounts SET initial_cents = 1000000 WHERE name = ?').run(CASH_ACCOUNT);
  add(db, { type: 'transfer', yuan: 2000, date: TODAY, to: SAVINGS_ACCOUNT });
  assert.ok(!has(buildSignals(db, { today: TODAY }), 'savings_none'));
  db.close();
});

test('单一分类占比过高', () => {
  const db = freshDb();
  add(db, { yuan: 600, date: TODAY, category: '食品餐饮' });
  add(db, { yuan: 100, date: TODAY, category: '出行交通' });
  const big = buildSignals(db, { today: TODAY }).find((s) => s.code === 'big_category');
  assert.ok(big, `没报大额分类：${codes(buildSignals(db, { today: TODAY }))}`);
  assert.equal(big.params.name, '食品餐饮');
  assert.equal(big.params.share, 0.857);
  db.close();
});

test('比上月同期花得多', () => {
  const db = freshDb();
  add(db, { yuan: 1000, date: '2026-08-05' });
  add(db, { yuan: 2000, date: '2026-09-05' });
  const over = buildSignals(db, { today: TODAY }).find((s) => s.code === 'month_over_prev');
  assert.ok(over, `没报同比：${codes(buildSignals(db, { today: TODAY }))}`);
  assert.equal(over.params.deltaPct, 1);
  db.close();
});

test('好几天没记账', () => {
  const db = freshDb();
  add(db, { yuan: 50, date: daysAgo(3) });
  const gap = buildSignals(db, { today: TODAY }).find((s) => s.code === 'no_record');
  assert.ok(gap, `没报断记：${codes(buildSignals(db, { today: TODAY }))}`);
  assert.equal(gap.params.days, 3);
  db.close();
});

test('warn 排在 info 前面——先说不好的消息', () => {
  const db = freshDb();
  for (let i = 1; i <= 30; i++) add(db, { yuan: 100, date: daysAgo(i) });
  db.prepare('UPDATE accounts SET initial_cents = 330000 WHERE name = ?').run(CASH_ACCOUNT);
  db.prepare('INSERT INTO budgets(period_month, category_id, amount_cents) VALUES(?, NULL, ?)').run('2026-09', 100000);

  const signals = buildSignals(db, { today: TODAY });
  const lastWarn = signals.map((s) => s.severity).lastIndexOf('warn');
  const firstInfo = signals.map((s) => s.severity).indexOf('info');
  assert.ok(lastWarn < firstInfo, `顺序不对：${signals.map((s) => `${s.severity}:${s.code}`).join(', ')}`);
  db.close();
});

// ── 日报 ────────────────────────────────────────────────────────────────
test('日报结构：昨天 / 本月 / 余额 / 信号 / 兜底文案都给齐', () => {
  const db = freshDb();
  db.prepare('UPDATE accounts SET initial_cents = 100000 WHERE name = ?').run(CASH_ACCOUNT);
  add(db, { yuan: 86, date: daysAgo(1), category: '食品餐饮' });
  add(db, { yuan: 100, date: TODAY, category: '出行交通' });

  const brief = getBrief(db, { today: TODAY });
  assert.equal(brief.reportDate, TODAY);
  assert.equal(brief.alreadySentToday, false);
  assert.equal(brief.yesterday.expenseCents, 8600);
  assert.equal(brief.yesterday.byCategory[0].name, '食品餐饮');
  assert.equal(brief.month.key, '2026-09');
  assert.equal(brief.month.daysElapsed, 10);
  assert.equal(brief.balance.totalCents, 100000 - 8600 - 10000);
  assert.ok(brief.fallbackText.includes('昨天支出 ¥86.00'));
  assert.ok(brief.fallbackText.includes('主要是食品餐饮 ¥86.00'));
  assert.ok(brief.fallbackText.includes('总余额'));
  db.close();
});

test('昨天没记账时兜底文案不说「支出 0」', () => {
  const db = freshDb();
  const brief = getBrief(db, { today: TODAY });
  assert.ok(brief.fallbackText.startsWith('昨天没有记账'), brief.fallbackText);
  db.close();
});

test('「一天只推一次」由 report_log 保证', () => {
  const db = freshDb();
  assert.equal(alreadySentToday(db, { reportDate: TODAY }), false);

  const first = getBrief(db, { today: TODAY, markSent: true });
  assert.equal(first.alreadySentToday, false, '第一次推送前应该是「还没推过」');

  const second = getBrief(db, { today: TODAY, markSent: true });
  assert.equal(second.alreadySentToday, true, '推过之后必须知道');

  const third = getBrief(db, { today: TODAY });
  assert.equal(third.alreadySentToday, true);
  db.close();
});

test('markSent 重复写不炸（唯一索引兜底）', () => {
  const db = freshDb();
  markSent(db, { reportDate: TODAY });
  markSent(db, { reportDate: TODAY });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_log').get().n, 1);
  db.close();
});

test('明天的推送不受今天影响', () => {
  const db = freshDb();
  getBrief(db, { today: TODAY, markSent: true });
  assert.equal(alreadySentToday(db, { reportDate: '2026-09-11' }), false);
  db.close();
});

test('greeting 与 morning 各自计数，互不干扰', () => {
  const db = freshDb();
  markSent(db, { kind: 'morning', reportDate: TODAY });
  assert.equal(alreadySentToday(db, { kind: 'morning', reportDate: TODAY }), true);
  assert.equal(alreadySentToday(db, { kind: 'greeting', reportDate: TODAY }), false);
  db.close();
});
