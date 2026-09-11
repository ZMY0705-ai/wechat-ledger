/**
 * 日报数据结构（docs/03 §5）。服务端负责把数字摆齐 + 给一段兜底文案，
 * 措辞交给桥接（有 LLM 就润色，没有就直接用 fallbackText）。
 *
 * 「一天只主动推一次」由 report_log 表保证：调用方带 markSent 时才写，
 * 写完再查 alreadySentToday 就是 true——所以重复调用不会重复打扰用户。
 */
import { getBalance, getDaySummary, getMonthSummary, getPeriodTotals } from './summary.js';
import { buildSignals, DEFAULT_RULES } from './signals.js';
import { formatYuanGrouped } from './money.js';
import { addDays, monthOf, nowString, todayString } from './time.js';

/**
 * report_log.kind 的取值受 CHECK 约束（morning | greeting）。
 * 「开机推的日报」和「08:30 的晨报」本质是同一件事——当天第一次推送，
 * 所以共用 morning，不为了改个名字去动已有的表结构。
 */
export const BRIEF_KINDS = ['morning', 'greeting'];

export function alreadySentToday(db, { kind = 'morning', reportDate, channel = 'wechat' } = {}) {
  const row = db
    .prepare('SELECT 1 AS hit FROM report_log WHERE kind = ? AND report_date = ? AND channel = ?')
    .get(kind, reportDate, channel);
  return Boolean(row);
}

/** 记一笔「今天推过了」。唯一索引兜底，重复写不会炸。 */
export function markSent(db, { kind = 'morning', reportDate, channel = 'wechat' } = {}) {
  db.prepare(
    `INSERT INTO report_log(kind, report_date, channel, sent_at) VALUES(?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(kind, reportDate, channel, nowString());
}

/**
 * 组装日报。
 *
 * @param {object} db
 * @param {{kind?: string, today?: string, markSent?: boolean, rules?: object, channel?: string}} opts
 */
export function getBrief(db, {
  kind = 'morning', today = todayString(), markSent: shouldMark = false,
  rules = DEFAULT_RULES, channel = 'wechat',
} = {}) {
  const reportDate = today;
  const yesterday = addDays(today, -1);
  const month = monthOf(today);

  const alreadySent = alreadySentToday(db, { kind, reportDate, channel });
  if (shouldMark && !alreadySent) markSent(db, { kind, reportDate, channel });

  const yTotals = getPeriodTotals(db, yesterday, yesterday);
  const yDay = getDaySummary(db, yesterday);
  const detail = getMonthSummary(db, month, today);
  const balance = getBalance(db);
  const signals = buildSignals(db, { today, rules });

  const brief = {
    kind,
    reportDate,
    alreadySentToday: alreadySent,
    yesterday: {
      date: yesterday,
      incomeCents: yTotals.incomeCents,
      expenseCents: yTotals.expenseCents,
      netCents: yTotals.netCents,
      count: yTotals.count,
      byCategory: yDay.expenseByCategory ?? [],
    },
    month: {
      key: month,
      daysElapsed: detail.daysElapsed,
      daysInMonth: detail.daysInMonth,
      incomeCents: detail.incomeCents,
      expenseCents: detail.expenseCents,
      netCents: detail.netCents,
      savingsInCents: detail.savingsInCents,
      savingsRate: detail.savingsRate,
      expenseByCategory: detail.expenseByCategory,
      prevMonthSamePeriod: detail.prevMonthSamePeriod,
    },
    balance: { totalCents: balance.totalCents, cashCents: balance.cashCents, savingsCents: balance.savingsCents },
    signals,
  };

  return { ...brief, fallbackText: renderFallback(brief) };
}

/**
 * 兜底文案（docs/03 §5）：LLM 不可用或超时也必须把核心数字送到。
 * 这里只做拼装，不做任何计算——所有数字都是上层已经算好的。
 */
export function renderFallback(brief) {
  const { yesterday, month, balance } = brief;
  const parts = [];

  if (yesterday.count === 0) {
    parts.push('昨天没有记账');
  } else if (yesterday.expenseCents === 0) {
    parts.push(`昨天没有支出，收入 ${formatYuanGrouped(yesterday.incomeCents)}`);
  } else {
    const top = yesterday.byCategory?.[0];
    const tail = top ? `，主要是${top.name} ${formatYuanGrouped(top.cents)}` : '';
    parts.push(`昨天支出 ${formatYuanGrouped(yesterday.expenseCents)}${tail}`);
  }

  parts.push(`本月至今支出 ${formatYuanGrouped(month.expenseCents)}，收入 ${formatYuanGrouped(month.incomeCents)}`);
  parts.push(`总余额 ${formatYuanGrouped(balance.totalCents)}`);

  return `${parts.join('。')}。`;
}
