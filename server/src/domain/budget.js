/**
 * 月度预算（表结构见 docs/02 §2，口径见 §4）。
 *
 * 范围：只做「本月总预算」一件事。
 * `budgets` 表留了 `category_id`（NULL = 总预算），但分类预算还没有任何地方能设，
 * 就先不暴露——API 上多一个用不上的参数，只会让「我设了怎么没生效」变得难查。
 *
 * 两个口径写清楚，免得以后自己看糊涂：
 *
 * · **已过天数含今天**（9 月 10 日 = 已过 10/30 天，和网页上那行「已过 X/Y 天」一致），
 *   所以 `daysLeft` 不含今天：9 月 10 日 → 20 天。
 * · **节奏比的是比例，不是金额**：花了 20% 而时间过了 33% 是省着花，
 *   反过来才叫「快」。金额大小只说明预算总量，比例才是可比的。
 *
 * 刻意**不给**「按当前速度月底会花到多少」这种线性外推：交一次房租就能把它顶到
 * 月支出的两倍，看着像真数字，其实是把一次性支出摊到整月。宁可少说一句。
 *
 * 这里只算事实；「要不要提醒」是 signals 的事（那边的预算进度规则引用这里的阈值）。
 */
import { getMonthSummary } from './summary.js';

/**
 * 「花得比时间进度快多少」算超速。
 * signals 的 `DEFAULT_RULES.budgetPaceGapPp` 直接引用这个常量——
 * 一个阈值两处各写一遍，迟早会对不上。
 */
export const BUDGET_PACE_GAP_PP = 0.15;

/** 读某个月的预算（分）。没设返回 0：0 元和「没设」在业务上是同一件事 */
export function getBudget(db, month) {
  const row = db
    .prepare('SELECT amount_cents FROM budgets WHERE period_month = ? AND category_id IS NULL')
    .get(month);
  return row?.amount_cents ?? 0;
}

/**
 * 设置某个月的预算。传 0 或负数 = 取消（删掉这一行，而不是留个 0 在那儿）。
 *
 * 用 UPDATE + INSERT 而不是 `ON CONFLICT`：唯一索引建在表达式
 * `(period_month, COALESCE(category_id, 0))` 上，冲突目标要不要写成表达式各版本行为不一致，
 * 而这两句在任何版本上都对，读起来也不用想「它到底撞上哪条索引了」。
 */
export function setBudget(db, { month, amountCents }) {
  if (!Number.isInteger(amountCents)) throw new TypeError('amountCents 必须是整数（分）');
  if (amountCents <= 0) return clearBudget(db, { month });

  const updated = db
    .prepare('UPDATE budgets SET amount_cents = ? WHERE period_month = ? AND category_id IS NULL')
    .run(amountCents, month);
  if (updated.changes === 0) {
    db.prepare('INSERT INTO budgets(period_month, category_id, amount_cents) VALUES(?, NULL, ?)')
      .run(month, amountCents);
  }
  return amountCents;
}

/** 取消某个月的预算，返回删掉的行数（0 = 本来就没设） */
export function clearBudget(db, { month }) {
  return db
    .prepare('DELETE FROM budgets WHERE period_month = ? AND category_id IS NULL')
    .run(month).changes;
}

/**
 * 纯计算：预算 + 本月已花 + 时间进度 → 一份可以直接渲染的状态。
 *
 * 抽成纯函数是为了能穷举边界（没预算 / 刚好花完 / 超支 / 最后一天），
 * 不用为了测一个除法去建库。
 *
 * @param {{month:string, budgetCents:number, spentCents:number, daysElapsed:number,
 *          daysInMonth:number, gapPp?:number}} input
 */
export function computeBudgetStatus({
  month, budgetCents, spentCents, daysElapsed, daysInMonth, gapPp = BUDGET_PACE_GAP_PP,
}) {
  const hasBudget = budgetCents > 0;
  const timeProgress = daysInMonth ? daysElapsed / daysInMonth : 0;
  const spentProgress = hasBudget ? spentCents / budgetCents : null;
  const remainingCents = hasBudget ? budgetCents - spentCents : null;
  // 今天是本月最后一天时按 1 天算，否则「每天还能花」会除以 0
  const daysLeft = Math.max(1, daysInMonth - daysElapsed);
  const dailyAllowanceCents = hasBudget ? Math.floor(remainingCents / daysLeft) : null;
  const paceGapPp = hasBudget ? spentProgress - timeProgress : null;

  /** none = 没设预算；over = 已超；watch = 比时间进度快；ok = 正常 */
  let status = 'none';
  if (hasBudget) {
    status = spentCents > budgetCents ? 'over' : paceGapPp >= gapPp ? 'watch' : 'ok';
  }

  return {
    month,
    status,
    budgetCents,
    spentCents,
    remainingCents,
    dailyAllowanceCents,
    daysElapsed,
    daysInMonth,
    daysLeft,
    timeProgress,
    spentProgress,
    paceGapPp,
  };
}

/** 从库里读数，交给 computeBudgetStatus 算 */
export function getBudgetStatus(db, { month, today, gapPp } = {}) {
  const detail = getMonthSummary(db, month, today);
  return computeBudgetStatus({
    month,
    budgetCents: getBudget(db, month),
    spentCents: detail.expenseCents,
    daysElapsed: detail.daysElapsed,
    daysInMonth: detail.daysInMonth,
    gapPp,
  });
}