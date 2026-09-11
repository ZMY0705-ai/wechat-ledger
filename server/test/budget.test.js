import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, accountId, CASH_ACCOUNT } from './helpers.js';
import { addTransaction } from '../src/domain/transactions.js';
import {
  BUDGET_PACE_GAP_PP, clearBudget, computeBudgetStatus, getBudget, getBudgetStatus, setBudget,
} from '../src/domain/budget.js';
import { buildSignals } from '../src/domain/signals.js';

const TODAY = '2026-09-10';
const MONTH = '2026-09';

function add(db, { type = 'expense', yuan, date }) {
  return addTransaction(db, {
    type,
    amountCents: Math.round(yuan * 100),
    occurredDate: date,
    categoryName: type === 'income' ? '工资' : '食品餐饮',
    accountId: accountId(db, CASH_ACCOUNT),
    toAccountId: null,
  });
}

/** 纯计算部分：默认「9 月 10 日，30 天的月份」，只覆盖要测的字段 */
const status = (input) => computeBudgetStatus({
  month: MONTH, daysInMonth: 30, daysElapsed: 10, ...input,
});

const codes = (signals) => signals.map((s) => s.code);

// ── 纯计算 ──────────────────────────────────────────────────────────────
test('没设预算：跟预算有关的数一律是 null，而不是 0', () => {
  const s = status({ budgetCents: 0, spentCents: 7490 });
  assert.equal(s.status, 'none');
  assert.equal(s.remainingCents, null);
  assert.equal(s.spentProgress, null);
  assert.equal(s.dailyAllowanceCents, null);
  assert.equal(s.paceGapPp, null);
  // 「花了多少」和预算无关，照常给
  assert.equal(s.spentCents, 7490);
  assert.equal(s.daysLeft, 20);
});

test('花得比时间进度慢 = 节奏正常', () => {
  const s = status({ budgetCents: 400000, spentCents: 80000 });   // 20% vs 33.3%
  assert.equal(s.status, 'ok');
  assert.equal(s.remainingCents, 320000);
  assert.equal(s.dailyAllowanceCents, 16000);                    // 3200 元 / 20 天
});

test('比时间进度快 15pp 以上才提醒（阈值两边各测一次）', () => {
  // 时间过了 50%，花到 64.9% 还不吭声，65.1% 就该说了
  const base = { daysElapsed: 15, daysInMonth: 30, budgetCents: 100000 };
  assert.equal(status({ ...base, spentCents: 64900 }).status, 'ok');
  assert.equal(status({ ...base, spentCents: 65100 }).status, 'watch');
  assert.equal(BUDGET_PACE_GAP_PP, 0.15);
});

test('超支：花的比预算还多，剩余和每天额度都变成负数', () => {
  const s = status({ budgetCents: 100000, spentCents: 120000 });
  assert.equal(s.status, 'over');
  assert.equal(s.remainingCents, -20000);
  assert.equal(s.dailyAllowanceCents, -1000);
});

test('刚好花完不算超支——「花完了」和「花超了」是两件事', () => {
  const s = status({ budgetCents: 100000, spentCents: 100000 });
  assert.equal(s.remainingCents, 0);
  assert.notEqual(s.status, 'over');
});

test('本月最后一天不会除以 0', () => {
  const s = computeBudgetStatus({
    month: MONTH, budgetCents: 100000, spentCents: 90000, daysElapsed: 30, daysInMonth: 30,
  });
  assert.equal(s.daysLeft, 1);
  assert.equal(s.dailyAllowanceCents, 10000);
  assert.equal(s.timeProgress, 1);
});

test('每天还能花按剩余天数摊，向下取整（宁可少说一块）', () => {
  assert.equal(status({ budgetCents: 100000, spentCents: 0 }).dailyAllowanceCents, 5000);
  assert.equal(status({ budgetCents: 100001, spentCents: 0 }).dailyAllowanceCents, 5000);
});

// ── 落库 ────────────────────────────────────────────────────────────────
test('设预算：写一次、改一次，始终只有一行', () => {
  const db = freshDb();
  assert.equal(getBudget(db, MONTH), 0);

  setBudget(db, { month: MONTH, amountCents: 300000 });
  assert.equal(getBudget(db, MONTH), 300000);

  setBudget(db, { month: MONTH, amountCents: 400000 });
  assert.equal(getBudget(db, MONTH), 400000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budgets WHERE period_month = ?').get(MONTH).n, 1);
  db.close();
});

test('预算设为 0 = 取消：删掉那一行，而不是留个 0 在那儿', () => {
  const db = freshDb();
  setBudget(db, { month: MONTH, amountCents: 300000 });
  setBudget(db, { month: MONTH, amountCents: 0 });
  assert.equal(getBudget(db, MONTH), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budgets').get().n, 0);
  db.close();
});

test('clearBudget 返回删掉几行：本来没设就是 0', () => {
  const db = freshDb();
  assert.equal(clearBudget(db, { month: MONTH }), 0);
  setBudget(db, { month: MONTH, amountCents: 100000 });
  assert.equal(clearBudget(db, { month: MONTH }), 1);
  db.close();
});

test('各月各算各的', () => {
  const db = freshDb();
  setBudget(db, { month: '2026-09', amountCents: 300000 });
  setBudget(db, { month: '2026-10', amountCents: 500000 });
  assert.equal(getBudget(db, '2026-09'), 300000);
  assert.equal(getBudget(db, '2026-10'), 500000);
  assert.equal(getBudget(db, '2026-11'), 0);
  db.close();
});

test('金额必须是整数分，别让浮点数悄悄进来', () => {
  const db = freshDb();
  assert.throws(() => setBudget(db, { month: MONTH, amountCents: 3000.5 }), /整数/);
  db.close();
});

// ── 和账本对得上 ────────────────────────────────────────────────────────
test('状态里的「已花」就是本月支出合计，上个月的不算进来', () => {
  const db = freshDb();
  add(db, { yuan: 16.9, date: TODAY });
  add(db, { yuan: 3200, date: TODAY });
  add(db, { yuan: 500, date: '2026-08-15' });
  setBudget(db, { month: MONTH, amountCents: 400000 });

  const s = getBudgetStatus(db, { month: MONTH, today: TODAY });
  assert.equal(s.spentCents, 321690);
  assert.equal(s.remainingCents, 78310);
  assert.equal(s.daysElapsed, 10);
  assert.equal(s.daysInMonth, 30);
  assert.equal(s.status, 'watch');
  db.close();
});

test('收入不算花钱，别把预算吃掉', () => {
  const db = freshDb();
  add(db, { type: 'income', yuan: 5700, date: TODAY });
  setBudget(db, { month: MONTH, amountCents: 400000 });
  const s = getBudgetStatus(db, { month: MONTH, today: TODAY });
  assert.equal(s.spentCents, 0);
  assert.equal(s.status, 'ok');
  db.close();
});

// ── 和信号引擎联动 ──────────────────────────────────────────────────────
test('设了预算之后：budget_absent 消失，花快了会报 budget_pace', () => {
  const db = freshDb();
  add(db, { yuan: 3200, date: TODAY });

  assert.ok(codes(buildSignals(db, { today: TODAY })).includes('budget_absent'),
    '还没设预算时应该提醒一次');

  setBudget(db, { month: MONTH, amountCents: 400000 });
  const signals = buildSignals(db, { today: TODAY });
  assert.ok(!codes(signals).includes('budget_absent'), '设了就不该再念叨');
  assert.ok(codes(signals).includes('budget_pace'), `应该报预算超速：${codes(signals)}`);
  db.close();
});

test('预算够花就不报 budget_pace——设了预算不等于天天挨说', () => {
  const db = freshDb();
  add(db, { yuan: 100, date: TODAY });
  setBudget(db, { month: MONTH, amountCents: 400000 });
  assert.ok(!codes(buildSignals(db, { today: TODAY })).includes('budget_pace'));
  db.close();
});