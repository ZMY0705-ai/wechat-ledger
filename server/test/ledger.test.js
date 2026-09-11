import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshDb, accountId, setInitial, addCreditAccount, CASH_ACCOUNT, SAVINGS_ACCOUNT, TODAY,
} from './helpers.js';
import {
  addTransaction, updateTransaction, voidTransaction, voidLast, listTransactions,
  lastActiveTransaction, ValidationError,
} from '../src/domain/transactions.js';
import {
  getBalance, getPeriodTotals, getDaySummary, getMonthSummary, getDailyExpenseSeries,
  categoryBreakdown, getDashboard,
} from '../src/domain/summary.js';

/** 记一笔的简写 */
function put(db, input) {
  return addTransaction(db, {
    occurredDate: TODAY,
    source: 'web',
    accountId: accountId(db),
    ...input,
  });
}

test('余额 = 期初 + 收入 − 支出', () => {
  const db = freshDb();
  db.prepare('UPDATE accounts SET initial_cents = 500000 WHERE id = ?').run(accountId(db));
  put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });
  put(db, { type: 'expense', amountCents: 1850, categoryName: '出行交通' });
  put(db, { type: 'income', amountCents: 1200000, categoryName: '工资' });
  assert.equal(getBalance(db).totalCents, 500000 - 3500 - 1850 + 1200000);
});

test('幂等键命中时不报错、不重复写入', () => {
  const db = freshDb();
  const a = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮', idemKey: 'wx:1:2:abc' });
  assert.equal(a.deduplicated, false);
  const b = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮', idemKey: 'wx:1:2:abc' });
  assert.equal(b.deduplicated, true);
  assert.equal(b.transaction.id, a.transaction.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 1);
  assert.equal(getBalance(db).totalCents, -3500);
});

test('软删除：撤销后不计入任何统计，但记录还在', () => {
  const db = freshDb();
  const { transaction } = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });
  voidTransaction(db, { id: transaction.id, reason: '记错了' });

  assert.equal(getBalance(db).totalCents, 0);
  assert.equal(getPeriodTotals(db, TODAY, TODAY).expenseCents, 0);
  assert.equal(listTransactions(db, {}).length, 0);
  assert.equal(listTransactions(db, { includeVoided: true }).length, 1);  // 审计痕迹保留
  assert.equal(db.prepare('SELECT status FROM transactions WHERE id = ?').get(transaction.id).status, 'voided');
});

test('撤销是幂等的', () => {
  const db = freshDb();
  const { transaction } = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });
  voidTransaction(db, { id: transaction.id });
  const again = voidTransaction(db, { id: transaction.id });
  assert.equal(again.status, 'voided');
});

test('transfer 不计入收支，但改变两个账户的余额', () => {
  const db = freshDb();
  const cash = accountId(db, CASH_ACCOUNT);
  const savings = accountId(db, SAVINGS_ACCOUNT);
  const before = getBalance(db).totalCents;

  put(db, { type: 'transfer', amountCents: 100000, accountId: cash, toAccountId: savings });

  const totals = getPeriodTotals(db, TODAY, TODAY);
  assert.equal(totals.incomeCents, 0);
  assert.equal(totals.expenseCents, 0);

  const bal = getBalance(db);
  assert.equal(bal.cashCents, -100000);    // 转出
  assert.equal(bal.savingsCents, 100000);  // 转入
  assert.equal(bal.totalCents, before);    // 只是换了个地方放，净额不变
});

test('信用卡还款也是 transfer，同样不进收支', () => {
  const db = freshDb();
  const cash = accountId(db, CASH_ACCOUNT);
  const card = addCreditAccount(db);

  put(db, { type: 'transfer', amountCents: 50000, accountId: cash, toAccountId: card });

  assert.equal(getPeriodTotals(db, TODAY, TODAY).expenseCents, 0);
  const bal = getBalance(db);
  assert.equal(bal.cashCents, -50000);
  assert.equal(bal.accounts.find((a) => a.name === '信用卡').balanceCents, -30000);  // 期初 -80000，还掉 50000
  assert.equal(bal.totalCents, -50000 - 30000);
});

test('modify_balance 不计入收支，但改变余额，且可正可负', () => {
  const db = freshDb();
  put(db, { type: 'modify_balance', amountCents: 123456, note: '期初修正' });
  assert.equal(getPeriodTotals(db, TODAY, TODAY).expenseCents, 0);
  assert.equal(getPeriodTotals(db, TODAY, TODAY).incomeCents, 0);
  assert.equal(getBalance(db).totalCents, 123456);

  put(db, { type: 'modify_balance', amountCents: -23456, note: '再对齐一次' });
  assert.equal(getBalance(db).totalCents, 100000);
});

test('校验：非法输入必须被挡下，且错误信息说人话', () => {
  const db = freshDb();
  assert.throws(() => put(db, { type: 'expense', amountCents: 0, categoryName: '食品餐饮' }), ValidationError);
  assert.throws(() => put(db, { type: 'expense', amountCents: -100, categoryName: '食品餐饮' }), /必须为正数/);
  assert.throws(() => put(db, { type: 'income', amountCents: -100, categoryName: '工资' }), /必须为正数/);
  assert.throws(() => put(db, { type: 'expense', amountCents: 100, categoryName: '瞎写的分类' }), /不存在/);
  assert.throws(() => put(db, { type: 'expense', amountCents: 100 }), /必须有分类/);
  assert.throws(() => put(db, { type: 'expense', amountCents: 100, categoryName: '工资' }), /支出不能用收入分类/);
  assert.throws(() => put(db, { type: 'income', amountCents: 100, categoryName: '食品餐饮' }), /收入不能用支出分类/);
  assert.throws(() => put(db, { type: 'modify_balance', amountCents: 100 }), /必须写清原因/);
  assert.throws(() => put(db, { type: 'modify_balance', amountCents: 100, note: 'x', categoryName: '食品餐饮' }), /不能带分类/);
  assert.throws(() => put(db, { type: 'transfer', amountCents: 100 }), /toAccountId/);
  assert.throws(() => put(db, { type: 'transfer', amountCents: 100, toAccountId: accountId(db) }), /不能相同/);
  assert.throws(() => put(db, { type: 'income', amountCents: 1.5, categoryName: '工资' }), /整数分/);
  assert.throws(() => put(db, { type: 'expense', amountCents: 100, categoryName: '食品餐饮', occurredDate: '2026-02-30' }), /日期/);
});

test('金额一律整数分，杜绝浮点误差累积', () => {
  const db = freshDb();
  for (let i = 0; i < 10; i++) {
    put(db, { type: 'expense', amountCents: 10, categoryName: '食品餐饮' }); // 0.10 元 x10
  }
  assert.equal(getBalance(db).totalCents, -100);
  assert.equal(getPeriodTotals(db, TODAY, TODAY).expenseCents, 100);
});

test('日收支与分类占比', () => {
  const db = freshDb();
  put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });
  put(db, { type: 'expense', amountCents: 1500, categoryName: '食品餐饮' });
  put(db, { type: 'expense', amountCents: 5000, categoryName: '出行交通' });
  put(db, { type: 'income', amountCents: 10000, categoryName: '工资' });

  const day = getDaySummary(db, TODAY);
  assert.equal(day.expenseCents, 10000);
  assert.equal(day.incomeCents, 10000);
  assert.equal(day.netCents, 0);
  assert.equal(day.count, 4);

  const dining = day.expenseByCategory.find((c) => c.name === '食品餐饮');
  assert.equal(dining.cents, 5000);
  assert.equal(dining.share, 0.5);
  assert.equal(dining.txCount, 2);
});

test('没有数据时占比是 null，不是 0 也不是 NaN', () => {
  const db = freshDb();
  assert.deepEqual(categoryBreakdown(db, { from: TODAY, to: TODAY }), []);

  const day = getDaySummary(db, TODAY);
  assert.equal(day.expenseCents, 0);
  assert.equal(day.incomeCents, 0);
  const month = getMonthSummary(db, '2026-09', TODAY);
  assert.equal(month.expenseByCategory.length, 0);
  assert.equal(month.prevMonthSamePeriod.deltaPct, null);
});

test('占比之和在有数据时为 1（按精确比率，不做展示舍入）', () => {
  const db = freshDb();
  put(db, { type: 'expense', amountCents: 3333, categoryName: '食品餐饮' });
  put(db, { type: 'expense', amountCents: 3333, categoryName: '出行交通' });
  put(db, { type: 'expense', amountCents: 3334, categoryName: '购物消费' });
  const sum = getDaySummary(db, TODAY).expenseByCategory.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('跨月对比必须同期对齐——不能拿本月至今比上月整月', () => {
  const db = freshDb();
  // 上月 8/1 ~ 8/10 每天 10 元（今天 9/10，同期应含到 8/10 为止）
  for (let d = 1; d <= 10; d++) {
    put(db, { type: 'expense', amountCents: 1000, categoryName: '食品餐饮', occurredDate: `2026-08-${String(d).padStart(2, '0')}` });
  }
  // 上月 8/11 ~ 8/31 每天 100 元（必须被排除在同期之外）
  for (let d = 11; d <= 31; d++) {
    put(db, { type: 'expense', amountCents: 10000, categoryName: '食品餐饮', occurredDate: `2026-08-${d}` });
  }
  // 本月 9/1 ~ 9/10 每天 20 元
  for (let d = 1; d <= 10; d++) {
    put(db, { type: 'expense', amountCents: 2000, categoryName: '食品餐饮', occurredDate: `2026-09-${String(d).padStart(2, '0')}` });
  }

  const m = getMonthSummary(db, '2026-09', TODAY);
  assert.equal(m.expenseCents, 20000);                       // 本月 9/1~9/10，10 天 x 20
  assert.equal(m.prevMonthSamePeriod.expenseCents, 10000);    // 同期 8/1~8/10，10 天 x 10
  assert.equal(m.prevMonthSamePeriod.to, '2026-08-10');
  assert.equal(m.prevMonthSamePeriod.deltaPct, (20000 - 10000) / 10000);
});

test('跨月对齐在上月天数不足时夹到最后一天', () => {
  const db = freshDb();
  const m = getMonthSummary(db, '2026-03', '2026-03-31');
  assert.equal(m.prevMonthSamePeriod.to, '2026-02-28');
});

test('每日支出折线：区间内没有流水的日子补 0，保证折线连续', () => {
  const db = freshDb();
  put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮', occurredDate: '2026-09-01' });
  put(db, { type: 'expense', amountCents: 2000, categoryName: '出行交通', occurredDate: '2026-09-05' });

  const series = getDailyExpenseSeries(db, '2026-09-01', '2026-09-07');
  assert.equal(series.length, 7);
  assert.equal(series[0].cents, 3500);
  assert.equal(series[1].cents, 0);
  assert.equal(series[4].cents, 2000);
  assert.equal(series[6].cents, 0);
  assert.equal(series.at(-1).date, '2026-09-07');
});

test('列表过滤与最近一笔', () => {
  const db = freshDb();
  put(db, { type: 'expense', amountCents: 100, categoryName: '食品餐饮', occurredDate: '2026-09-01' });
  put(db, { type: 'expense', amountCents: 200, categoryName: '出行交通', occurredDate: '2026-09-05' });
  put(db, { type: 'income', amountCents: 300, categoryName: '工资', occurredDate: '2026-09-06' });

  assert.equal(listTransactions(db, { from: '2026-09-02', to: '2026-09-30' }).length, 2);
  assert.equal(listTransactions(db, { type: 'income' }).length, 1);
  assert.equal(listTransactions(db, { month: '2026-09' }).length, 3);
  assert.equal(lastActiveTransaction(db).amountCents, 300);

  const voided = voidLast(db);
  assert.equal(voided.amountCents, 300);
  assert.equal(listTransactions(db, {}).length, 2);
});

test('dashboard 是页面与晨报的唯一数据来源', () => {
  const db = freshDb();
  put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮', occurredDate: '2026-09-09' });
  put(db, { type: 'expense', amountCents: 2000, categoryName: '出行交通', occurredDate: TODAY });

  const d = getDashboard(db, { today: TODAY, trendDays: 7 });
  assert.equal(d.asOf, TODAY);
  assert.equal(d.today.expenseCents, 2000);
  assert.equal(d.yesterday.expenseCents, 3500);
  assert.equal(d.month.key, '2026-09');
  assert.equal(d.trend.dailyExpense.length, 7);
  assert.equal(d.balance.totalCents, -5500);
  assert.equal(d.yesterday.byCategory[0].name, '食品餐饮');
});

test('支出按一级分类归并，饼图扇区不会被二级分类切碎', () => {
  const db = freshDb();
  put(db, { type: 'expense', amountCents: 1000, categoryName: '午饭' });
  put(db, { type: 'expense', amountCents: 2000, categoryName: '外卖' });
  put(db, { type: 'expense', amountCents: 3000, categoryName: '打车' });

  const l1 = categoryBreakdown(db, { from: TODAY, to: TODAY, level: 1 });
  assert.deepEqual(l1.map((c) => c.name).sort(), ['出行交通', '食品餐饮']);
  assert.equal(l1.find((c) => c.name === '食品餐饮').cents, 3000);

  const l2 = categoryBreakdown(db, { from: TODAY, to: TODAY, level: 2 });
  assert.deepEqual(
    Object.fromEntries(l2.map((c) => [c.name, c.cents])),
    { '出行交通/打车': 3000, '食品餐饮/外卖': 2000, '食品餐饮/午饭': 1000 },
  );
});
test('现金流 -> 长期储蓄：存钱不算支出，但储蓄额单独可见', () => {
  const db = freshDb();
  setInitial(db, SAVINGS_ACCOUNT, 5000000);   // 已经攒了 5 万
  const cash = accountId(db, CASH_ACCOUNT);
  const savings = accountId(db, SAVINGS_ACCOUNT);

  put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });
  put(db, { type: 'income', amountCents: 1200000, categoryName: '工资' });
  put(db, { type: 'transfer', amountCents: 500000, accountId: cash, toAccountId: savings });

  const m = getMonthSummary(db, '2026-09', TODAY);
  assert.equal(m.incomeCents, 1200000);
  assert.equal(m.expenseCents, 3500);            // 存钱不是支出
  assert.equal(m.netCents, 1200000 - 3500);
  assert.equal(m.savingsInCents, 500000);        // 但存了多少必须看得见
  assert.equal(m.savingsOutCents, 0);
  assert.equal(m.savingsRate, 500000 / 1200000);

  const bal = getBalance(db);
  assert.equal(bal.savingsCents, 5500000);
  assert.equal(bal.cashCents, 1200000 - 3500 - 500000);
  assert.equal(bal.totalCents, bal.cashCents + bal.savingsCents);

  // 储蓄不参与分类占比
  assert.deepEqual(m.expenseByCategory.map((c) => c.name), ['食品餐饮']);
});

test('储蓄率没有收入时返回 null，不返回 0、也不返回 NaN', () => {
  const db = freshDb();
  put(db, {
    type: 'transfer', amountCents: 100000,
    accountId: accountId(db, CASH_ACCOUNT), toAccountId: accountId(db, SAVINGS_ACCOUNT),
  });
  const m = getMonthSummary(db, '2026-09', TODAY);
  assert.equal(m.incomeCents, 0);
  assert.equal(m.savingsInCents, 100000);
  assert.equal(m.savingsRate, null);
});

test('从储蓄取回现金流：不算收入，但要同时改两个余额', () => {
  const db = freshDb();
  setInitial(db, SAVINGS_ACCOUNT, 1000000);
  put(db, {
    type: 'transfer', amountCents: 300000,
    accountId: accountId(db, SAVINGS_ACCOUNT), toAccountId: accountId(db, CASH_ACCOUNT),
  });

  const m = getMonthSummary(db, '2026-09', TODAY);
  assert.equal(m.incomeCents, 0);          // 取回自己的钱不是收入
  assert.equal(m.savingsInCents, 0);
  assert.equal(m.savingsOutCents, 300000);

  const bal = getBalance(db);
  assert.equal(bal.savingsCents, 700000);
  assert.equal(bal.cashCents, 300000);
});

test('两个账户的期初余额各自独立', () => {
  const db = freshDb();
  setInitial(db, CASH_ACCOUNT, 800000);
  setInitial(db, SAVINGS_ACCOUNT, 5000000);
  const bal = getBalance(db);
  assert.equal(bal.cashCents, 800000);
  assert.equal(bal.savingsCents, 5000000);
  assert.equal(bal.totalCents, 5800000);
});

test('改分类：分类换了，金额、日期、账户一个不动', () => {
  const db = freshDb();
  const { transaction } = put(db, { type: 'expense', amountCents: 5700, categoryName: '购物消费', note: '买菜花了' });

  const updated = updateTransaction(db, { id: transaction.id, categoryName: '食品餐饮' });

  assert.equal(updated.categoryPath, '食品餐饮');
  assert.equal(updated.amountCents, 5700);
  assert.equal(updated.occurred_date, TODAY);
  assert.equal(updated.note, '买菜花了');
  assert.equal(updated.account_id, transaction.account_id);
  // 是原地改，不是「撤销 + 重记」：id 不变，余额也不受影响
  assert.equal(updated.id, transaction.id);
  assert.equal(getBalance(db).totalCents, -5700);
});

test('改备注；传空串等于清空', () => {
  const db = freshDb();
  const { transaction } = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮', note: '午饭' });

  assert.equal(updateTransaction(db, { id: transaction.id, note: '和同事吃饭' }).note, '和同事吃饭');
  assert.equal(updateTransaction(db, { id: transaction.id, note: '  ' }).note, null);
});

test('改分类走的是和记账同一套校验：不存在、方向不符都挡下', () => {
  const db = freshDb();
  const { transaction } = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });

  assert.throws(() => updateTransaction(db, { id: transaction.id, categoryName: '瞎写的' }), /不存在/);
  assert.throws(() => updateTransaction(db, { id: transaction.id, categoryName: '工资' }), /支出不能用收入分类/);
  assert.throws(() => updateTransaction(db, { id: transaction.id }), /没有要改的字段/);
  assert.throws(() => updateTransaction(db, { id: 999999, categoryName: '食品餐饮' }), /找不到流水/);
});

test('已撤销的流水改不了；转账没有分类可改', () => {
  const db = freshDb();
  const { transaction } = put(db, { type: 'expense', amountCents: 3500, categoryName: '食品餐饮' });
  voidTransaction(db, { id: transaction.id });
  assert.throws(() => updateTransaction(db, { id: transaction.id, note: 'x' }), /已撤销/);

  const moved = put(db, {
    type: 'transfer', amountCents: 200000,
    accountId: accountId(db), toAccountId: accountId(db, SAVINGS_ACCOUNT),
  });
  assert.throws(
    () => updateTransaction(db, { id: moved.transaction.id, categoryName: '食品餐饮' }),
    /没有分类/,
  );
  // 但备注能改
  assert.equal(updateTransaction(db, { id: moved.transaction.id, note: '存钱' }).note, '存钱');
});

test('晨报数据里现金流与储蓄分开给', () => {
  const db = freshDb();
  const cash = accountId(db, CASH_ACCOUNT);
  put(db, { type: 'income', amountCents: 1200000, categoryName: '工资' });
  put(db, { type: 'transfer', amountCents: 500000, accountId: cash, toAccountId: accountId(db, SAVINGS_ACCOUNT) });

  const dash = getDashboard(db, { today: TODAY });
  assert.equal(dash.balance.cashCents, 700000);
  assert.equal(dash.balance.savingsCents, 500000);
  assert.equal(dash.month.savingsInCents, 500000);
  assert.equal(dash.today.savingsInCents, 500000);
});
