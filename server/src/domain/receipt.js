/**
 * 中文回执渲染（docs/03 §3.1）。
 *
 * 回执由**服务端**渲染，而不是让 LLM 现编：即使模型这一轮发挥失常，
 * 用户收到的数字依然是准的。桥接把 message 原样转发即可，这是「降级可用」的保险。
 */
import { formatYuan, formatYuanGrouped } from './money.js';
import { getBalance, getPeriodTotals, getMonthSummary, getSavingsInflow } from './summary.js';
import { monthOf, todayString } from './time.js';

const TYPE_TEXT = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  modify_balance: '余额校准',
};

/** 记完一笔之后的即时快照：回执、网页、桥接都用它，口径只有这一处 */
export function snapshotAfter(db, { date = todayString() } = {}) {
  const day = getPeriodTotals(db, date, date);
  const month = getMonthSummary(db, monthOf(date), date);
  const balance = getBalance(db);
  return {
    balanceTotalCents: balance.totalCents,
    balanceCashCents: balance.cashCents,
    balanceSavingsCents: balance.savingsCents,
    todayExpenseCents: day.expenseCents,
    todayIncomeCents: day.incomeCents,
    todaySavingsInCents: getSavingsInflow(db, { from: date, to: date }),
    monthExpenseCents: month.expenseCents,
    monthIncomeCents: month.incomeCents,
    monthSavingsInCents: month.savingsInCents,
    monthSavingsRate: month.savingsRate,
  };
}

/** 一句话回执。桥接直接发给用户，不用自己拼字符串 */
export function renderReceipt(db, tx, { deduplicated = false } = {}) {
  const snap = snapshotAfter(db, { date: tx.occurred_date });
  const head = deduplicated ? '这笔已经记过了：' : '已记：';
  const prefix = tx.note ? `${tx.note} ` : '';

  let body;
  if (tx.type === 'transfer') {
    const from = tx.account_name ?? '账户';
    const to = tx.to_account_name ?? '账户';
    body = `${prefix}转账 ${formatYuan(Math.abs(tx.amountCents))}（${from} → ${to}）`;
  } else if (tx.type === 'modify_balance') {
    body = `${prefix}${TYPE_TEXT[tx.type]} ${formatYuan(tx.amountCents)}`;
  } else {
    const cat = tx.categoryPath ? `（${tx.categoryPath}）` : '';
    body = `${prefix}${TYPE_TEXT[tx.type] ?? tx.type} ${formatYuan(Math.abs(tx.amountCents))}${cat}`;
  }

  // 转账只影响余额、不影响收支，所以尾句报两边余额而不是「今日支出」
  const tail = tx.type === 'transfer' || tx.type === 'modify_balance'
    ? `现金流 ${formatYuanGrouped(snap.balanceCashCents)}｜长期储蓄 ${formatYuanGrouped(snap.balanceSavingsCents)}`
    : `今日支出 ${formatYuanGrouped(snap.todayExpenseCents)}｜现金流 ${formatYuanGrouped(snap.balanceCashCents)}`;

  return `${head}${body}｜${tail}`;
}