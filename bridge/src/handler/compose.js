/**
 * 回执与追问的措辞（docs/04 §11：回执优先复用服务端返回的 message）。
 *
 * 这里只负责把结构化结果排版成人话。**任何数字都不在这里计算**——
 * 金额、占比、余额全部来自服务端返回值，少一处算术就少一处幻觉。
 */

const TYPE_TEXT = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  modify_balance: '余额校准',
};

/** 1234567 -> ¥12,345.67 */
export function money(cents, { sign = false } = {}) {
  const value = Number(cents ?? 0);
  const text = `¥${(Math.abs(value) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  if (!sign) return value < 0 ? `-${text}` : text;
  return `${value >= 0 ? '+' : '-'}${text}`;
}

export function typeText(type) {
  return TYPE_TEXT[type] ?? type ?? '未知';
}

/** 草稿确认模板（docs/07 §1.4） */
export function renderPreview(parsed, { header = '📝 准备记录：' } = {}) {
  const lines = [header];
  lines.push(`  日期：${parsed.date}`);
  lines.push(`  金额：${parsed.amountCents === null ? '（还没听清）' : money(parsed.amountCents)}`);
  if (parsed.type !== 'transfer' && parsed.type !== 'modify_balance') {
    lines.push(`  分类：${parsed.categoryName ?? '待分类'}`);
  }
  if (parsed.note) lines.push(`  备注：${parsed.note}`);
  lines.push(`  类型：${typeText(parsed.type)}`);
  return lines.join('\n');
}

/** 低置信度 / 大额 / 转账：一律展示解析结果等确认（docs/07 §2.1） */
export function renderConfirm(parsed) {
  const reason = {
    large_amount: '金额不小，确认一下再记',
    low_confidence: '这句我没太大把握',
    uncategorized: '没认出来是哪一类',
    modify_balance: '余额校准会改动余额',
    future_date: '这笔的日期在未来',
  }[parsed.reason];

  return [
    renderPreview(parsed),
    '',
    reason ? `（${reason}）` : '',
    '确认请回复「是」，不对就直接把这句话重说一遍。',
  ].filter((l) => l !== '').join('\n');
}

export function renderAskAmount(parsed) {
  return [
    '🤔 这笔花了多少？',
    `  我听到的是：${parsed.note || parsed.raw}`,
    '',
    '回复金额就行，比如「35」。',
  ].join('\n');
}

export function renderAskAccount(parsed) {
  return [
    '🤝 这笔像是转账/还款，不是花掉了，所以不能计入支出。',
    `  金额：${parsed.amountCents === null ? '未识别' : money(parsed.amountCents)}`,
    '',
    '转账要记在两个账户之间，去网页上用「转账」记一下更稳妥：',
    '  http://127.0.0.1:8787',
  ].join('\n');
}

export function renderAskDate(parsed) {
  return [
    `📅 ${parsed.question ?? '这个日期有点奇怪，确认一下？'}`,
    '',
    renderPreview(parsed),
    '',
    '确认请回复「是」。',
  ].join('\n');
}

/** 落库成功：优先用服务端渲染的 message，它才是唯一准确的版本 */
export function renderRecorded(parsed, { message, degraded = false } = {}) {
  const lines = [message ?? `✅ 已记：${parsed.note ?? ''} ${typeText(parsed.type)} ${money(parsed.amountCents)}`];
  if (degraded) lines.push('（本轮没有用上模型，按本地规则解析）');
  return lines.join('\n');
}

export function renderBalance(data) {
  return [
    '💰 当前余额',
    `  现金流　　${money(data.cashCents)}`,
    `  长期储蓄　${money(data.savingsCents)}`,
    `  合计　　　${money(data.totalCents)}`,
  ].join('\n');
}

export function renderDay(data, { label = '今天' } = {}) {
  const rows = [
    `📅 ${label}（${data.date}）`,
    `  支出　${money(data.expenseCents)}`,
    `  收入　${money(data.incomeCents)}`,
  ];
  const cats = data.expenseByCategory ?? [];
  if (cats.length) {
    rows.push('  明细：');
    for (const c of cats.slice(0, 6)) {
      rows.push(`    ${c.name}　${money(c.cents)}`);
    }
  } else {
    rows.push('  这天还没有支出记录');
  }
  return rows.join('\n');
}

export function renderMonth(data) {
  const rows = [
    `📊 ${data.key}（已过 ${data.daysElapsed} 天）`,
    `  支出　${money(data.expenseCents)}`,
    `  收入　${money(data.incomeCents)}`,
  ];
  if (data.netCents !== undefined) rows.push(`  净额　${money(data.netCents, { sign: true })}`);
  if (data.savingsRate !== null && data.savingsRate !== undefined) {
    rows.push(`  储蓄率　${(data.savingsRate * 100).toFixed(1)}%`);
  }
  const cats = data.expenseByCategory ?? [];
  if (cats.length) {
    rows.push('  花费最多的：');
    for (const c of cats.slice(0, 5)) {
      rows.push(`    ${c.name}　${money(c.cents)}　${((c.share ?? 0) * 100).toFixed(0)}%`);
    }
  }
  if (data.prevMonthSamePeriod) {
    const delta = data.prevMonthSamePeriod.deltaPct;
    if (typeof delta === 'number') {
      rows.push(`  比上月同期${delta >= 0 ? '多' : '少'} ${Math.abs(delta * 100).toFixed(1)}%`);
    }
  }
  return rows.join('\n');
}

export function renderList(data) {
  const rows = data.transactions ?? [];
  if (!rows.length) return '账本里还没有流水。发一句「午饭35」试试？';
  const lines = [`🧾 最近 ${rows.length} 笔`];
  for (const t of rows) {
    const tag = t.categoryPath ?? (t.type === 'transfer' ? '转账' : typeText(t.type));
    const sign = t.type === 'expense' ? '-' : t.type === 'income' ? '+' : '';
    lines.push(`  ${t.occurred_date} ${sign}${money(Math.abs(t.amountCents)).slice(1)}　${tag}　${t.note ?? ''}`);
  }
  return lines.join('\n');
}

export function renderHelp() {
  return [
    '🐾 直接说人话就行，比如：',
    '  午饭35          记一笔支出',
    '  发工资12000     记一笔收入',
    '  存了2000        现金流 → 长期储蓄',
    '  昨天超市买菜76.5 补记昨天的账',
    '',
    '查账：',
    '  余额 / 本月 / 今天 / 昨天 / 最近',
    '  撤销            撤销上一笔',
    '',
    '网页版：http://127.0.0.1:8787',
  ].join('\n');
}

export function renderGreeting({ balance, today } = {}) {
  const lines = ['🐾 在的。'];
  if (today) {
    lines.push(`今天支出 ${money(today.expenseCents)}，收入 ${money(today.incomeCents)}。`);
  }
  if (balance) lines.push(`余额合计 ${money(balance.totalCents)}。`);
  lines.push('说一句「午饭35」就能记账，发「帮助」看全部用法。');
  return lines.join('\n');
}

// ── 日报 ────────────────────────────────────────────────────────────────

/** 2026-09-10 -> 9月10日 */
function shortDate(date) {
  const [, m, d] = String(date).split('-').map(Number);
  return `${m}月${d}日`;
}

/**
 * 每条规则的兜底措辞。
 * 有 LLM 时通常用不上——但它保证「模型不可用 / 超时」时建议依然送达，
 * 而且这些句子是确定性的，永远说得对（措辞依据全部来自服务端给的 params）。
 */
export function renderSignal(signal) {
  const p = signal.params ?? {};
  switch (signal.code) {
    case 'expense_spike':
      return `昨天花了 ${money(p.yesterdayCents)}，是近期日均的 ${p.ratio} 倍，看看是不是有笔大的`;
    case 'balance_low':
      return `现金流还剩 ${money(p.cashCents)}，按最近的花法只够 ${p.days} 天`;
    case 'budget_pace':
      return `本月已花 ${money(p.spentCents)}／预算 ${money(p.budgetCents)}，比时间进度快`;
    case 'budget_absent':
      // 没预算就没法谈「快了慢了」，但这条信号不该被静默吞掉（M4 之前没有预算 UI，先说清楚）
      return '本月还没设预算——记账页上「本月预算」里设一个，我才好提醒你花得快不快';
    case 'savings_none':
      return `本月还没往长期储蓄转钱，这个月收入 ${money(p.incomeCents)}，可以先存一笔`;
    case 'big_category':
      return `本月「${p.name}」花了 ${money(p.cents)}，占 ${(p.share * 100).toFixed(0)}%`;
    case 'month_over_prev':
      return `本月至今比上月同期多花 ${(p.deltaPct * 100).toFixed(0)}%`;
    case 'no_record':
      return `已经 ${p.days} 天没记账了，微信里说一句就行`;
    case 'never_recorded':
      return '还没记过账，发一句「午饭35」就能开始';
    default:
      return null;
  }
}

/**
 * 拼装日报。建议优先用模型措辞，模型没给出就退回确定性文案。
 * 整体压到 10 行以内——微信里没人愿意读长文（docs/04 §10）。
 */
export function renderBrief(brief, { suggestions = [], topN = 3 } = {}) {
  const lines = [`🐾 记账日报 · ${shortDate(brief.reportDate)}`, ''];

  const y = brief.yesterday;
  if (y.count === 0) {
    lines.push('昨天没有记账');
  } else if (y.expenseCents === 0) {
    lines.push(`昨天没有支出，收入 ${money(y.incomeCents)}`);
  } else {
    const top = y.byCategory?.[0];
    lines.push(`昨天支出 ${money(y.expenseCents)}${top ? `，主要是${top.name} ${money(top.cents)}` : ''}`);
  }

  const m = brief.month;
  lines.push(`本月至今 支出 ${money(m.expenseCents)} ｜ 收入 ${money(m.incomeCents)}`);
  lines.push(`余额 ${money(brief.balance.totalCents)}（现金流 ${money(brief.balance.cashCents)} ｜ 储蓄 ${money(brief.balance.savingsCents)}）`);

  const advice = (suggestions.length
    ? suggestions
    : brief.signals.map(renderSignal).filter(Boolean)
  ).slice(0, topN);

  if (advice.length) {
    lines.push('', '💡 建议');
    for (const item of advice) lines.push(`· ${item}`);
  }

  return lines.join('\n');
}
