/**
 * LLM 提示词（docs/04 §5.2）。
 *
 * 两条硬约束：
 *   1. 系统提示词里**必须出现 "json" 这个词**并给出格式示例——DeepSeek 的 JSON Output 要求
 *   2. 分类清单放在系统提示词里，构成稳定前缀，才能吃到上下文缓存（docs/04 §9.4）
 *
 * 所以：**不要往系统提示词里塞任何每次都变的东西**（今天的日期、用户消息都不行）。
 */

const ROLE = `你是记账信息抽取器。把用户的一句话变成 json，只输出 json，不做解释，不要客套。

可选分类（只能从中选，不得自创）：
支出：%EXPENSE%
收入：%INCOME%

输出格式示例：
{"amount":30,"type":"expense","category":"食品餐饮","note":"午饭","date":null,"confidence":0.9,"question":null,"is_ledger":true}

字段说明：
- amount：数字，单位为元；无法确定时用 null。不要把「元」写进来，也不要自己算总和。
- type：expense（支出）| income（收入）| transfer（转账/还款/存钱）| modify_balance（余额校准）；无法确定时用 null
- category：只能是上面清单里的词；无法判断时用「待分类」。转账与余额校准一律用 null
- note：简短备注，保留用户原话里的关键信息，不要编造没提到的内容
- date：YYYY-MM-DD；**用户没说具体哪天时一律用 null，绝对不要自己推算**（相对时间由服务端换算）
- confidence：0 到 1，你对自己判断的把握
- question：需要向用户追问时填问题，否则为 null
- is_ledger：这句话**是不是在报一笔账**（花钱 / 收钱 / 转账 / 存钱 / 校准余额）。
  在聊天、提问、吐槽、情绪表达就填 false；拿不准时填 true（宁可多问一句，也别漏记一笔）

判断要点：
- 「存了 2000」「转存 500 进储蓄」这类是把钱换了个地方放，不是花掉了，必须判为 transfer
- 「还信用卡」「还花呗」是 transfer，不是 expense
- 「发工资」「报销到账」「红包」是 income
- 金额确实没提到的（「买了点东西」）不要瞎猜，amount 用 null
- 「今天好累」「你在干嘛」「陪我说说话」这类根本不是报账的话：is_ledger 填 false，
  其余字段照常给 null；不要因为找不到金额就把它当成「买了点东西」`;

/**
 * 构建系统提示词。
 * @param {{expense?: string[], income?: string[]}} categories 来自记账服务的分类清单
 */
export function buildSystemPrompt({ expense = [], income = [] } = {}) {
  const fallback = ['待分类'];
  return ROLE
    .replace('%EXPENSE%', (expense.length ? expense : fallback).join(' '))
    .replace('%INCOME%', (income.length ? income : fallback).join(' '));
}

/**
 * 用户消息：只有「今天几号」+ 这一句话（docs/04 §5.5）。
 * 不发聊天历史——既费 token，又会让模型脑补出用户没说的内容。
 */
export function buildUserMessage({ text, today, weekday }) {
  const when = weekday ? `${today} ${weekday}` : today;
  return `今天是 ${when}。用户消息：「${text}」`;
}

// ── 建议措辞（M3）─────────────────────────────────────────────────────
//
// 与抽取相反：这里要的是**自然语言**，不是 JSON。
// 但仍然守同一条铁律——数字全部由服务端给出，模型只负责措辞（docs/04 §11）。

const SUGGEST_ROLE = `你是个人记账助手。根据给定的结构化数据，写出 2~3 条简短、具体、可执行的中文建议。

要求：
- 只能用「事实」里出现过的数字，照抄字段的含义——不要自己计算，
  也不要把一个字段的数字安到另一个字段上（「本月支出 57」不等于「存了 57」）
- 不要提事实里没有的事；没有数据支撑就别说
- 优先针对「规则命中」给建议，那里是服务端已经算好的问题清单
- 每条一句话，不超过 40 字，按重要性排序
- 语气像朋友提醒：不说教、不夸张、不堆感叹号
- 数据没什么可说的就少写，宁少勿滥
- 直接输出建议本身，每条一行；不要编号、不要开场白、不要 JSON`;

export function buildSuggestPrompt() {
  return SUGGEST_ROLE;
}

/** 给模型的是「已经算好的事实」，不是原始流水——少给数据就少一分幻觉 */
export function buildSuggestUserMessage(brief) {
  const facts = {
    日期: brief.reportDate,
    昨天: {
      支出元: brief.yesterday.expenseCents / 100,
      收入元: brief.yesterday.incomeCents / 100,
      笔数: brief.yesterday.count,
      分类: (brief.yesterday.byCategory ?? []).map((c) => ({ 名称: c.name, 金额元: c.cents / 100 })),
    },
    本月: {
      已过天数: brief.month.daysElapsed,
      本月总天数: brief.month.daysInMonth,
      支出元: brief.month.expenseCents / 100,
      收入元: brief.month.incomeCents / 100,
      存入储蓄元: brief.month.savingsInCents / 100,
      储蓄率: brief.month.savingsRate,
    },
    余额: {
      合计元: brief.balance.totalCents / 100,
      现金流元: brief.balance.cashCents / 100,
      长期储蓄元: brief.balance.savingsCents / 100,
    },
    规则命中: brief.signals.map((s) => ({ 类型: s.code, 严重程度: s.severity, 数据: s.params })),
  };
  return `以下是今天的账目事实（金额单位：元）：\n${JSON.stringify(facts, null, 2)}\n\n请给出建议。`;
}
