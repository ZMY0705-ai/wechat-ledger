/**
 * 建议规则引擎：确定性信号（docs/04 §11「建议来自规则，不来自灵感」）。
 *
 * 这里只产出**结构化信号**，不写任何自然语言。措辞是 LLM（或模板）的事。
 * 好处是建议的触发条件可以被测试、被解释、被调整——「为什么今天冒出这条建议」
 * 永远能追溯到一条 SQL，而不是模型的即兴发挥。
 *
 * 所有数字都来自 SQL 聚合，本文件不做任何算术推断。
 */
import { BUDGET_PACE_GAP_PP, getBudget } from './budget.js';
import { getBalance, getMonthSummary, getPeriodTotals, getDailyExpenseSeries } from './summary.js';
import { addDays, monthOf, todayString } from './time.js';

/** 阈值集中在配置里，调参不用改代码（docs/03 §1 的 rules 段） */
/**
 * 服务端能产出的全部信号。
 *
 * 这份清单的唯一用途是「守卫测试」：桥接必须为每个 code 准备一句文案，
 * 否则 `renderSignal` 返回 null，信号会被静默丢掉——曾经就漏过 budget_absent。
 * 加信号时**连同文案一起加**，这条清单会替你把关。
 */
export const SIGNAL_CODES = [
  'expense_spike',
  'balance_low',
  'budget_pace',
  'budget_absent',
  'savings_none',
  'big_category',
  'month_over_prev',
  'no_record',
  'never_recorded',
];

export const DEFAULT_RULES = {
  /** 昨天支出 ≥ 近期日均的多少倍，算「突增」 */
  expenseSpikeRatio: 1.8,
  /** 但绝对金额太小就不提了，免得「昨天多喝了杯奶茶」也来报警 */
  expenseSpikeMinCents: 10000,
  /** 本月实际支出进度比时间进度超出多少（百分点）才算超支 */
  budgetPaceGapPp: BUDGET_PACE_GAP_PP,
  /** 现金流还能撑几天就该提醒 */
  balanceLowDays: 7,
  /** 连续多少天没记账就提醒一下 */
  noRecordMinDays: 2,
  /** 单一分类占比超过这个比例，值得单独说一句 */
  bigCategoryShare: 0.4,
  bigCategoryMinCents: 50000,
  /** 对比窗口：算日均支出用最近多少天 */
  lookbackDays: 30,
};

const SEVERITY_ORDER = { warn: 0, info: 1 };

/**
 * 算出今天的信号。
 * @returns {Array<{code:string, severity:'warn'|'info', params:object}>}
 */
export function buildSignals(db, { today = todayString(), rules = DEFAULT_RULES } = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  const yesterday = addDays(today, -1);
  const month = monthOf(today);
  const signals = [];

  const balance = getBalance(db);
  const detail = getMonthSummary(db, month, today);
  const yesterdayTotals = getPeriodTotals(db, yesterday, yesterday);

  // 近期日均（不含昨天），作为「突增」和「能撑几天」的基准
  const series = getDailyExpenseSeries(db, addDays(yesterday, -(r.lookbackDays - 1)), yesterday);
  const spentDays = series.filter((d) => d.cents > 0);
  const avgDailyCents = series.length ? Math.round(series.reduce((s, d) => s + d.cents, 0) / series.length) : 0;

  // ── 支出突增 ──────────────────────────────────────────────────────
  if (avgDailyCents > 0 && yesterdayTotals.expenseCents >= r.expenseSpikeMinCents) {
    const ratio = yesterdayTotals.expenseCents / avgDailyCents;
    if (ratio >= r.expenseSpikeRatio) {
      signals.push({
        code: 'expense_spike',
        severity: 'warn',
        params: { yesterdayCents: yesterdayTotals.expenseCents, avgDailyCents, ratio: Number(ratio.toFixed(2)) },
      });
    }
  }

  // ── 现金流余量 ────────────────────────────────────────────────────
  if (avgDailyCents > 0) {
    const days = balance.cashCents / avgDailyCents;
    if (days < r.balanceLowDays) {
      signals.push({
        code: 'balance_low',
        severity: 'warn',
        params: { cashCents: balance.cashCents, avgDailyCents, days: Number(days.toFixed(1)) },
      });
    }
  }

  // ── 预算进度 ──────────────────────────────────────────────────────
  const budget = getBudget(db, month);
  const timeProgress = detail.daysElapsed / detail.daysInMonth;
  if (budget > 0) {
    const spentProgress = detail.expenseCents / budget;
    const gap = spentProgress - timeProgress;
    if (gap >= r.budgetPaceGapPp) {
      signals.push({
        code: 'budget_pace',
        severity: 'warn',
        params: {
          spentCents: detail.expenseCents, budgetCents: budget,
          timeProgress: Number(timeProgress.toFixed(3)), spentProgress: Number(spentProgress.toFixed(3)),
        },
      });
    }
  } else if (detail.expenseCents > 0) {
    // 没预算就没法谈「快了慢了」，但值得提醒一次——建议质量强依赖预算
    signals.push({ code: 'budget_absent', severity: 'info', params: { month } });
  }

  // ── 本月还没存钱 ──────────────────────────────────────────────────
  if (detail.incomeCents > 0 && detail.savingsInCents === 0 && detail.daysElapsed >= 5) {
    signals.push({
      code: 'savings_none',
      severity: 'info',
      params: { incomeCents: detail.incomeCents, daysElapsed: detail.daysElapsed },
    });
  }

  // ── 单一分类占比过高 ──────────────────────────────────────────────
  const top = detail.expenseByCategory?.[0];
  if (top && top.share >= r.bigCategoryShare && top.cents >= r.bigCategoryMinCents) {
    signals.push({
      code: 'big_category',
      severity: 'info',
      params: { name: top.name, cents: top.cents, share: Number(top.share.toFixed(3)) },
    });
  }

  // ── 比上月同期花得多 ──────────────────────────────────────────────
  const deltaPct = detail.prevMonthSamePeriod?.deltaPct;
  if (typeof deltaPct === 'number' && deltaPct >= 0.3 && detail.expenseCents > 0) {
    signals.push({
      code: 'month_over_prev',
      severity: 'info',
      params: { deltaPct: Number(deltaPct.toFixed(3)), monthExpenseCents: detail.expenseCents },
    });
  }

  // ── 好几天没记账 ──────────────────────────────────────────────────
  const last = db.prepare("SELECT MAX(occurred_date) AS d FROM active_tx WHERE type IN ('expense','income')").get().d;
  if (!last) {
    signals.push({ code: 'never_recorded', severity: 'info', params: { days: null } });
  } else {
    const gapDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000);
    if (gapDays >= r.noRecordMinDays) {
      signals.push({ code: 'no_record', severity: 'info', params: { last, days: gapDays } });
    }
  }

  return signals.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
