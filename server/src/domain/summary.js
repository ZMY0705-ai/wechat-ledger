/**
 * 聚合统计。口径全部来自 docs/02 §4，改这里必须同步改测试。
 *
 * 四条最容易踩的坑，本文件集中处理：
 *   1. 所有查询走 active_tx，绝不手写 status 条件
 *   2. 占比分母为 0 时返回 null（不是 0、不是 NaN）
 *   3. 跨月对比必须同期对齐，不能拿「本月至今」比「上月整月」
 *   4. 转入储蓄是 transfer，不计入收支，但必须单独可见
 */
import {
  monthOf, monthStart, monthEnd, prevMonth, samePeriodEndDate,
  daysElapsedInMonth, daysInMonth, addDays, diffDays, todayString,
} from './time.js';
import { CASH_ACCOUNT, SAVINGS_ACCOUNT, accountByName } from '../db/seed.js';

/** 计入收支统计的类型——transfer 与 modify_balance 不算（docs/02 §4.6 / §4.9） */
const FLOW_TYPES = ['expense', 'income'];

function share(cents, total) {
  if (!total) return null;
  return cents / total;
}

/**
 * 余额（docs/02 §4.1）。
 * 总余额 = Σ期初 + Σ收入 − Σ支出 + Σ转入 − Σ转出 + Σ余额校准
 *
 * 现金流与长期储蓄分开呈现，同时给总额——个人理财里这三个数各有各的用途。
 */
export function getBalance(db) {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.sort_order,
              a.initial_cents
              + COALESCE((SELECT SUM(amount_signed_cents) FROM active_tx
                          WHERE account_id = a.id AND type = 'income'), 0)
              - COALESCE((SELECT SUM(amount_signed_cents) FROM active_tx
                          WHERE account_id = a.id AND type = 'expense'), 0)
              + COALESCE((SELECT SUM(amount_signed_cents) FROM active_tx
                          WHERE to_account_id = a.id AND type = 'transfer'), 0)
              - COALESCE((SELECT SUM(amount_signed_cents) FROM active_tx
                          WHERE account_id = a.id AND type = 'transfer'), 0)
              + COALESCE((SELECT SUM(amount_signed_cents) FROM active_tx
                          WHERE account_id = a.id AND type = 'modify_balance'), 0)
                AS balance_cents
         FROM accounts a
        WHERE a.archived = 0
        ORDER BY a.sort_order, a.id`,
    )
    .all();

  const accounts = rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    initialCents: r.initial_cents,
    balanceCents: r.balance_cents,
    isSavings: r.name === SAVINGS_ACCOUNT,
    isCash: r.name === CASH_ACCOUNT,
  }));

  return {
    totalCents: rows.reduce((sum, r) => sum + r.balance_cents, 0),
    // 「现金流」指名道姓地取「现金流」账户，不是「所有非储蓄账户之和」——
    // 否则以后加一张信用卡，待还金额会被算进现金流里，越看越糊涂
    cashCents: accounts.find((a) => a.isCash)?.balanceCents ?? 0,
    savingsCents: accounts.find((a) => a.isSavings)?.balanceCents ?? 0,
    accounts,
  };
}

/** 一段日期区间的收支合计（含首含尾），transfer 与 modify_balance 天然被排除 */
export function getPeriodTotals(db, from, to) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income'  THEN amount_signed_cents END), 0) AS income_cents,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_signed_cents END), 0) AS expense_cents,
         COUNT(*) AS tx_count
       FROM active_tx
       WHERE occurred_date BETWEEN ? AND ? AND type IN ('expense','income')`,
    )
    .get(from, to);

  return {
    from,
    to,
    incomeCents: row.income_cents,
    expenseCents: row.expense_cents,
    netCents: row.income_cents - row.expense_cents,
    count: row.tx_count,
  };
}

/**
 * 一段时间内「转入长期储蓄」的合计。
 *
 * 这些是 transfer，按 docs/02 §4.6 不计入收支。
 * 但必须单独统计——否则「这个月存下多少钱」在账本上就凭空消失了，
 * 而它恰恰是个人理财里最该被看见的那个数。
 */
export function getSavingsInflow(db, { from, to }) {
  const savings = accountByName(db, SAVINGS_ACCOUNT);
  if (!savings) return 0;
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_signed_cents), 0) AS cents
         FROM active_tx
        WHERE type = 'transfer' AND to_account_id = ?
          AND occurred_date BETWEEN ? AND ?`,
    )
    .get(savings.id, from, to).cents;
}

/** 反向：从储蓄取回现金流（同样是 transfer，不算收入） */
export function getSavingsOutflow(db, { from, to }) {
  const savings = accountByName(db, SAVINGS_ACCOUNT);
  if (!savings) return 0;
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_signed_cents), 0) AS cents
         FROM active_tx
        WHERE type = 'transfer' AND account_id = ?
          AND occurred_date BETWEEN ? AND ?`,
    )
    .get(savings.id, from, to).cents;
}

/**
 * 分类明细。
 * @param {object} opts
 * @param {'expense'|'income'} [opts.direction]
 * @param {1|2} [opts.level] 1 = 按一级分类归并（默认，饼图用）；2 = 展开到二级
 */
export function categoryBreakdown(db, { from, to, direction = 'expense', level = 1 }) {
  if (level === 1) {
    const rows = db
      .prepare(
        `SELECT COALESCE(pc.id, c.id) AS category_id,
                COALESCE(pc.name, c.name) AS name,
                SUM(t.amount_signed_cents) AS cents,
                COUNT(*) AS tx_count
           FROM active_tx t
           JOIN categories c  ON c.id  = t.category_id
           LEFT JOIN categories pc ON pc.id = c.parent_id
          WHERE t.type = ? AND t.occurred_date BETWEEN ? AND ?
          GROUP BY COALESCE(pc.id, c.id)
          ORDER BY cents DESC`,
      )
      .all(direction, from, to);
    const total = rows.reduce((s, r) => s + r.cents, 0);
    return rows.map((r) => ({
      categoryId: r.category_id,
      name: r.name,
      cents: r.cents,
      txCount: r.tx_count,
      share: share(r.cents, total),
    }));
  }

  const rows = db
    .prepare(
      `SELECT c.id AS category_id, c.name AS name, pc.name AS parent_name,
              SUM(t.amount_signed_cents) AS cents,
              COUNT(*) AS tx_count
         FROM active_tx t
         JOIN categories c  ON c.id  = t.category_id
         LEFT JOIN categories pc ON pc.id = c.parent_id
        WHERE t.type = ? AND t.occurred_date BETWEEN ? AND ?
        GROUP BY c.id
        ORDER BY cents DESC`,
    )
    .all(direction, from, to);
  const total = rows.reduce((s, r) => s + r.cents, 0);
  return rows.map((r) => ({
    categoryId: r.category_id,
    name: r.parent_name ? `${r.parent_name}/${r.name}` : r.name,
    cents: r.cents,
    txCount: r.tx_count,
    share: share(r.cents, total),
  }));
}

/** 日收支（docs/02 §4.2） */
export function getDaySummary(db, date) {
  const totals = getPeriodTotals(db, date, date);
  return {
    date,
    ...totals,
    expenseByCategory: categoryBreakdown(db, { from: date, to: date, direction: 'expense' }),
    incomeByCategory: categoryBreakdown(db, { from: date, to: date, direction: 'income' }),
    savingsInCents: getSavingsInflow(db, { from: date, to: date }),
  };
}

/** 月收支 + 分类占比 + 上月同期对比 + 储蓄进度（docs/02 §4.3 / §4.4 / §4.5） */
export function getMonthSummary(db, month, today = todayString()) {
  const from = monthStart(month);
  const daysElapsed = daysElapsedInMonth(month, today);
  const to = monthEnd(month);
  const totals = getPeriodTotals(db, from, to);
  const savingsInCents = getSavingsInflow(db, { from, to });
  const savingsOutCents = getSavingsOutflow(db, { from, to });

  const prev = prevMonth(month);
  let prevMonthSamePeriod = null;
  if (prev && daysElapsed > 0) {
    const prevEnd = samePeriodEndDate(prev, daysElapsed);
    const prevTotals = getPeriodTotals(db, monthStart(prev), prevEnd);
    const prevSavings = getSavingsInflow(db, { from: monthStart(prev), to: prevEnd });
    prevMonthSamePeriod = {
      month: prev,
      from: monthStart(prev),
      to: prevEnd,
      expenseCents: prevTotals.expenseCents,
      incomeCents: prevTotals.incomeCents,
      savingsInCents: prevSavings,
      // 上月同期为 0 时无从比较，返回 null 而不是 Infinity
      deltaPct: prevTotals.expenseCents
        ? (totals.expenseCents - prevTotals.expenseCents) / prevTotals.expenseCents
        : null,
    };
  }

  return {
    key: month,
    from,
    to,
    daysElapsed,
    daysInMonth: daysInMonth(month),
    incomeCents: totals.incomeCents,
    expenseCents: totals.expenseCents,
    netCents: totals.netCents,
    count: totals.count,
    expenseByCategory: categoryBreakdown(db, { from, to, direction: 'expense' }),
    incomeByCategory: categoryBreakdown(db, { from, to, direction: 'income' }),

    // 储蓄口径：不计入收支，但必须可见
    savingsInCents,
    savingsOutCents,
    /** 储蓄率 = 本月转入储蓄 / 本月收入。没有收入时无从谈起，返回 null */
    savingsRate: totals.incomeCents ? savingsInCents / totals.incomeCents : null,

    prevMonthSamePeriod,
  };
}

/** 每日支出折线图的数据。区间内没有流水的日子补 0，保证折线连续 */
export function getDailyExpenseSeries(db, from, to) {
  const rows = db
    .prepare(
      `SELECT occurred_date AS date,
              COALESCE(SUM(CASE WHEN type='expense' THEN amount_signed_cents END), 0) AS cents,
              COALESCE(SUM(CASE WHEN type='income'  THEN amount_signed_cents END), 0) AS income_cents
         FROM active_tx
        WHERE occurred_date BETWEEN ? AND ? AND type IN ('expense','income')
        GROUP BY occurred_date`,
    )
    .all(from, to);

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const span = diffDays(from, to);
  if (span === null || span < 0) return [];

  const out = [];
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const hit = byDate.get(date);
    out.push({ date, cents: hit?.cents ?? 0, incomeCents: hit?.income_cents ?? 0 });
  }
  return out;
}

/** 页面与晨报共用的总入口（对应 docs/02 §6 的响应契约） */
export function getDashboard(db, { today = todayString(), trendDays = 30 } = {}) {
  const month = monthOf(today);
  const day = getDaySummary(db, today);
  const yesterdayDate = addDays(today, -1);
  const yesterday = getDaySummary(db, yesterdayDate);

  return {
    asOf: today,
    balance: getBalance(db),
    today: {
      date: today,
      incomeCents: day.incomeCents,
      expenseCents: day.expenseCents,
      netCents: day.netCents,
      count: day.count,
      savingsInCents: day.savingsInCents,
    },
    yesterday: {
      date: yesterdayDate,
      incomeCents: yesterday.incomeCents,
      expenseCents: yesterday.expenseCents,
      netCents: yesterday.netCents,
      count: yesterday.count,
      byCategory: yesterday.expenseByCategory,
      savingsInCents: yesterday.savingsInCents,
    },
    month: getMonthSummary(db, month, today),
    trend: {
      dailyExpense: getDailyExpenseSeries(db, addDays(today, -(trendDays - 1)), today),
    },
  };
}

export { FLOW_TYPES, share };