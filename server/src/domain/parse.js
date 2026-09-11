/**
 * 规则解析：中文口语 -> 结构化账目 + 置信度 + 处置决策。
 *
 * 依据 docs/07：
 *   · 置信度 = 金额0.45 + 类型0.25 + 分类0.20 + 时间0.10 的加权求和，阈值 0.6
 *   · 硬规则优先于分数（金额缺失 / 大额 / 转账 / 未来时间）
 *
 * 这一层是**确定性**的：同样的输入永远得到同样的输出，可回归测试。
 * LLM 只在 M2 接手这里判不了的情况，且必须服从本文件产出的口径。
 */
import { parseAmountToCents } from './money.js';
import {
  todayString, addDays, isValidDate, weekdayOf, monthOf, isValidMonth,
} from './time.js';

export const CONFIDENCE_THRESHOLD = 0.6;
export const CONFIRM_THRESHOLD_CENTS = 20_000; // 200 元
export const UNCATEGORIZED = '待分类';

const W = { amount: 0.45, type: 0.25, category: 0.2, date: 0.1 };

// ── 分类关键词表（一级分类，与 categories.js 的 EXPENSE_TREE 对应；长词优先匹配）──
//
// 这张表**不是**分类的主要判断者——有 LLM 时由模型判断（提示词里只列一级分类），
// 它负责两件事：模型不可用时的降级路径，以及模型没给分类时的兜底。
// 键必须是一级分类名，模型和规则产出的分类名才能在同一个粒度上比较。
export const EXPENSE_KEYWORDS = {
  生活必需: ['日用品', '卫生纸', '洗发水', '牙膏', '房租', '房贷', '水费', '电费', '水电', '燃气',
            '煤气', '物业', '取暖', '维修', '宽带', '话费', '流量', '充值', '网费',
            '书籍', '课程', '培训', '学费', '考试', '文具', '网课', '书店', '书',
            '手续费', '利息', '保险', '税费', '年费', '罚款', '滞纳金'],
  食品餐饮: ['午饭', '早饭', '晚饭', '夜宵', '早点', '外卖', '奶茶', '咖啡', '吃饭', '食堂', '快餐',
            '火锅', '烧烤', '拉面', '零食', '饮料', '水果', '请客', '餐费', '聚餐', '买菜', '饭'],
  购物消费: ['超市', '淘宝', '京东', '拼多多', '衣服', '服饰', '鞋', '数码', '网购', '快递'],
  健康医疗: ['医院', '挂号', '体检', '看病', '门诊', '牙医', '买药', '药'],
  出行交通: ['打车', '滴滴', '出租车', '网约车', '公交', '地铁', '油费', '加油', '停车', '高铁',
            '火车', '机票', '飞机', '过路费', '车费', '路费'],
  休闲娱乐: ['电影', '游戏', '健身', '旅行', '旅游', '演出', '门票', '运动', '唱歌', '剧本杀', 'KTV',
            '会员', '订阅'],
  人情送礼: ['随礼', '份子钱', '礼物', '送礼', '请客随礼', '人情'],
};

export const INCOME_KEYWORDS = {
  工资: ['工资', '薪资', '月薪', '薪水', '发了工资'],
  奖金: ['年终奖', '奖金', '提成', '绩效'],
  兼职: ['兼职', '稿费', '佣金', '外快', '私活', '接单'],
  报销: ['报销'],
  投资收益: ['分红', '基金', '理财收益', '股票', '投资收益', '利息收入'],
  红包收入: ['红包'],
  退款: ['退款', '退货', '退钱', '退了'],
  其他收入: ['收入', '进账', '到账'],
};

/** 明确表示收入的动词/词 */
const INCOME_HINTS = ['收到', '收了', '赚了', '赚到', '发了', '报销', '退款', '进账', '到账', '收入', '返现', '中奖'];
/** 转账/还款类，不计入收支 */
const TRANSFER_HINTS = ['还信用卡', '还花呗', '还白条', '信用卡还款', '花呗还款', '还款', '转账',
                        '转给', '转了', '提现', '借出', '借给', '还钱', '还了', '充值到'];
/** 余额校准 */
const MODIFY_HINTS = ['余额校准', '校准余额', '余额调整', '调整余额', '余额对不上', '对不上账', '修正余额'];
/** 模糊金额词 */
const FUZZY_HINTS = ['大概', '大约', '差不多', '左右', '几十', '几百', '上千', '一百多', '两百多', '几百块', '若干'];

/**
 * 存钱意图。
 *
 * 「存了 2000」里既没有「转账」也没有「转给」，光靠 TRANSFER_HINTS 抓不到，
 * 但语义上就是一笔「现金流 → 长期储蓄」。这笔钱并没有花掉，只是换了个地方放，
 * 所以必须按 transfer 处理（不计入收支），绝不能记成支出。
 */
const SAVINGS_HINTS = ['储蓄', '存款', '存钱', '存起来', '存进', '存入', '转存', '存了', '攒起来'];

// ── 时间表达 ─────────────────────────────────────────────────────────────
const WEEKDAY_CHARS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

const RELATIVE = {
  大前天: -3, 前天: -2, 昨天: -1, 昨日: -1, 今天: 0, 今日: 0, 当天: 0,
  明天: 1, 明日: 1, 后天: 2, 大后天: 3,
};

function resolveWeekday(targetDow, today, weekOffset) {
  const wd = weekdayOf(today); // 0=周日 … 6=周六
  const isoToday = (wd + 6) % 7; // 周一=0 … 周日=6
  const isoTarget = (targetDow + 6) % 7;
  let delta = isoTarget - isoToday;
  if (weekOffset === undefined) {
    // 没写限定词：不取未来，落在未来就回退一周
    if (delta > 0) delta -= 7;
  } else {
    delta += weekOffset * 7;
  }
  return delta;
}

/** 抽出时间表达 -> { date, specified, matched } */
export function extractDate(text, today = todayString()) {
  const s = String(text ?? '');

  // YYYY-MM-DD
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (isValidDate(d)) return { date: d, specified: true, matched: m[0] };
  }

  // N 天前 / N 天后
  m = /(\d+)\s*天\s*[前后]/.exec(s);
  if (m) {
    const n = Number(m[1]) * (m[0].includes('前') ? -1 : 1);
    return { date: addDays(today, n), specified: true, matched: m[0] };
  }

  // M 月 D 日/号（未来则算去年）
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(s);
  if (m) {
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    const year = today.slice(0, 4);
    let d = `${year}-${mm}-${dd}`;
    if (!isValidDate(d)) return { date: null, specified: true, matched: m[0], invalid: true };
    if (d > today) d = `${Number(year) - 1}-${mm}-${dd}`;
    return { date: d, specified: true, matched: m[0] };
  }

  // 周X / 星期X / 礼拜X，可带 上/本/这/下 限定
  m = /(上|本|这|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(s);
  if (m) {
    const target = WEEKDAY_CHARS[m[2]];
    const off = m[1] === '上' ? -1 : m[1] === '下' ? 1 : m[1] ? 0 : undefined;
    return { date: addDays(today, resolveWeekday(target, today, off)), specified: true, matched: m[0] };
  }

  // 相对词（长词优先，避免「前天」被「天」误伤）
  for (const word of Object.keys(RELATIVE).sort((a, b) => b.length - a.length)) {
    if (s.includes(word)) return { date: addDays(today, RELATIVE[word]), specified: true, matched: word };
  }

  return { date: today, specified: false, matched: null };
}

/** 抽出金额表达 -> { cents, specified, fuzzy, matched } */
export function extractAmount(text) {
  const s = String(text ?? '');
  const fuzzy = FUZZY_HINTS.some((w) => s.includes(w));

  // 优先匹配带货币单位的（「35元」「35块」「¥35」）
  const candidates = [];
  const unitRe = /(?:[¥￥$]\s*\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*(?:元|块钱|块|圆|毛|角|分))|(?:[零〇一二两三四五六七八九十百千万亿]{1,12}(?:点[零〇一二两三四五六七八九]+)?\s*(?:元|块钱|块|圆|毛|角|分))/g;
  for (const m of s.matchAll(unitRe)) candidates.push({ text: m[0], hasUnit: true });

  // 再匹配裸数字（要求是独立数字，不能被中文数字/字母包围）
  const bareRe = /(?<![\d.])-?\d+(?:\.\d+)?(?![\d.])/g;
  for (const m of s.matchAll(bareRe)) {
    if (candidates.some((c) => c.text.includes(m[0]))) continue;
    candidates.push({ text: m[0], hasUnit: false });
  }
  if (!candidates.length) {
    return { cents: null, specified: false, fuzzy, matched: null };
  }

  // 有单位的优先；都没单位时取第一个裸数字
  const withUnit = candidates.filter((c) => c.hasUnit);
  const pick = (withUnit.length ? withUnit : candidates)[0];
  const cents = parseAmountToCents(pick.text);

  return { cents, specified: true, fuzzy, matched: pick.text };
}

/** 抽出分类与方向 */
export function extractCategory(text) {
  const s = String(text ?? '');

  const hit = (table) => {
    let best = null;
    for (const [category, words] of Object.entries(table)) {
      for (const w of words) {
        if (!s.includes(w)) continue;
        // 长词优先：命中更长关键词的胜出
        if (!best || w.length > best.word.length) best = { category, word: w };
      }
    }
    return best;
  };

  const incomeHit = hit(INCOME_KEYWORDS);
  const expenseHit = hit(EXPENSE_KEYWORDS);

  // 「红包」两边都有：带随礼/份子语义时算支出，否则算收入
  if (incomeHit?.word === '红包' && /随礼|份子|送礼/.test(s)) {
    return { category: '人情送礼', matched: '红包', exact: true, direction: 'expense' };
  }

  if (incomeHit && (!expenseHit || incomeHit.word.length >= expenseHit.word.length)) {
    return { category: incomeHit.category, matched: incomeHit.word, exact: true, direction: 'income' };
  }
  if (expenseHit) {
    return { category: expenseHit.category, matched: expenseHit.word, exact: true, direction: 'expense' };
  }
  return { category: UNCATEGORIZED, matched: null, exact: false, direction: null };
}

/** 抽出交易类型 */
export function extractType(text, categoryDirection) {
  const s = String(text ?? '');
  const has = (list) => list.some((w) => s.includes(w));

  if (has(MODIFY_HINTS)) return { type: 'modify_balance', score: 1 };
  if (has(TRANSFER_HINTS)) return { type: 'transfer', score: 1 };
  if (categoryDirection === 'income' || has(INCOME_HINTS)) return { type: 'income', score: 1 };
  if (categoryDirection === 'expense') return { type: 'expense', score: 0.6 };
  return { type: 'expense', score: 0.3 }; // 记账场景默认是支出，但置信度给低
}

/** 去掉已识别的金额与时间表达，剩下的当备注 */
function extractNote(text, amountMatched, dateMatched, categoryMatched) {
  let s = String(text ?? '');
  if (amountMatched) s = s.replace(amountMatched, ' ');
  if (dateMatched) s = s.replace(dateMatched, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[，,、。.：:\-\s]+|[，,、。.：:\-\s]+$/g, '');
  return s || categoryMatched || null;
}

/**
 * 主入口：解析一句话。
 * @returns 结构化结果 + confidence + decision
 */
export function parseLedgerText(text, { today = todayString(), confirmThresholdCents = CONFIRM_THRESHOLD_CENTS } = {}) {
  const raw = String(text ?? '').trim();

  // 先抽时间，并把时间表达从文本里遮掉再抽金额。
  // 否则「6月5日看电影45」里的 6 会被当成金额。
  const date = extractDate(raw, today);
  const amount = extractAmount(date.matched ? raw.replace(date.matched, ' ') : raw);
  const cat = extractCategory(raw);

  // 存钱不是花钱：这类表达一律按「现金流 → 长期储蓄」的转账处理。
  // 余额校准优先级最高，不能被「存入」这类词带跑。
  const savingsIntent = SAVINGS_HINTS.some((w) => raw.includes(w));
  let ty = extractType(raw, cat.direction);
  if (savingsIntent && ty.type !== 'modify_balance') ty = { type: 'transfer', score: 1 };

  const note = extractNote(raw, amount.matched, date.matched, cat.matched);

  const scoreAmount = amount.cents !== null && amount.cents > 0 ? 1 : amount.fuzzy ? 0.2 : 0;
  const scoreCategory = cat.exact ? 1 : 0.2;
  const scoreDate = date.specified ? 1 : 0.5;
  const scoreType = ty.score;

  const confidence = Number(
    (W.amount * scoreAmount + W.type * scoreType + W.category * scoreCategory + W.date * scoreDate).toFixed(4),
  );

  const result = {
    raw,
    amountCents: amount.cents,
    amountSpecified: amount.specified,
    amountFuzzy: amount.fuzzy,
    type: ty.type,
    categoryName: cat.exact ? cat.category : UNCATEGORIZED,
    categoryMatched: cat.matched,
    date: date.date,
    dateSpecified: date.specified,
    /** 是不是往「长期储蓄」里存钱——决定这笔 transfer 落在哪两个账户之间 */
    transferToSavings: savingsIntent,
    note,
    confidence,
    scores: { amount: scoreAmount, type: scoreType, category: scoreCategory, date: scoreDate },
  };

  // 转账与余额校准不参与分类统计，一律不带分类（docs/02 §4.6 / §4.9）
  const categoryName =
    ty.type === 'transfer' || ty.type === 'modify_balance'
      ? null
      : cat.exact ? cat.category : UNCATEGORIZED;
  result.categoryName = categoryName;

  return { ...result, ...decide(result, { today, confirmThresholdCents }) };
}

/** 硬规则优先于分数（docs/07 §2.1） */
function decide(r, { today, confirmThresholdCents }) {
  if (r.date && r.date > today) {
    return { decision: 'ask_date', question: `「${r.date}」是将来的日期，确定要记到那天吗？` };
  }
  if (r.type === 'modify_balance') {
    return { decision: 'confirm', question: null, reason: 'modify_balance' };
  }
  if (r.amountCents === null || r.amountCents <= 0) {
    return {
      decision: 'ask_amount',
      question: r.amountFuzzy ? '金额有点模糊，具体是多少？' : '这笔花了多少？',
    };
  }
  if (r.type === 'transfer') {
    if (r.transferToSavings) {
      // 现金流 → 长期储蓄是固定路线，不用问账户；但大额仍然确认一次，
      // 因为转错会同时污染两个余额，而且不容易被发现。
      if (r.amountCents >= confirmThresholdCents) {
        return { decision: 'confirm', question: null, reason: 'large_amount' };
      }
      return { decision: 'record', question: null, reason: 'transfer_savings' };
    }
    return { decision: 'ask_account', question: '这笔是转账/还款，请确认转账的账户。' };
  }
  // 大额确认只针对支出：收入金额通常明确且数额大是常态，
  // 每笔工资都弹确认会把体验毁掉（docs/07 §3 的语料也是这么期望的）。
  if (r.type === 'expense' && r.amountCents >= confirmThresholdCents) {
    return { decision: 'confirm', question: null, reason: 'large_amount' };
  }
  if (r.type === 'expense' && r.categoryName === UNCATEGORIZED && r.amountCents >= 10_000) {
    return { decision: 'confirm', question: null, reason: 'uncategorized' };
  }
  if (r.confidence < CONFIDENCE_THRESHOLD) {
    return { decision: 'confirm', question: null, reason: 'low_confidence' };
  }
  return { decision: 'record', question: null };
}

// ── 服务端强校验：把 LLM 的抽取结果并到规则口径上（docs/04 §5.2）──────────

export const TX_TYPE_SET = new Set(['expense', 'income', 'transfer', 'modify_balance']);

/** 模型给的日期只可能是「用户明说了的绝对日期」，相对时间一律由服务端换算 */
function normalizeModelDate(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isValidDate(d) ? d : null;
}

/** 模型给的金额单位是「元」，转成整数分；给不出或非正数则退化为 null */
function centsFromModel(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return cents > 0 && cents <= 1e13 ? cents : null;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim();

/**
 * 分类强校验（docs/04 §5.2 的第二层防线）。
 *
 * 模型输出什么都有可能，但这里只接受数据库里真实存在的分类；匹配不上就落「待分类」，
 * 并如实降低分类维度的得分——不确定要体现在置信度上，而不是靠猜。
 *
 * @returns {{ name: string, score: number, matched: boolean }}
 */
export function matchCategory(rawName, categories, { direction = null } = {}) {
  const pool = categories.filter(
    (c) => !direction || c.direction === direction || c.direction === 'both',
  );
  if (!pool.length) return { name: UNCATEGORIZED, score: 0.2, matched: false };

  const query = norm(rawName);
  if (query) {
    const leaf = query.includes('/') ? query.slice(query.lastIndexOf('/') + 1) : query;

    const exact = pool.filter((c) => c.name === leaf);
    if (exact.length === 1) return { name: exact[0].name, score: 1, matched: true };

    // 模糊匹配：唯一命中就用它；命中多个说明有歧义，宁可退回「待分类」
    const fuzzy = pool.filter((c) => c.name.includes(leaf) || leaf.includes(c.name));
    if (fuzzy.length === 1) return { name: fuzzy[0].name, score: 0.5, matched: true };
  }
  return { name: UNCATEGORIZED, score: 0.2, matched: false };
}

/**
 * 把 LLM 的抽取结果并到规则口径上，产出与 parseLedgerText 完全同构的结果。
 *
 * 分工（docs/03 §6）：
 *   · 语言理解（金额 / 类型 / 分类 / 备注）—— 听模型的
 *   · 相对时间换算、分类校验、置信度评分、硬规则 —— 一律服务端说了算
 * 模型给不出金额或类型时退回规则抽取；置信度取模型与服务端评分的较低值（docs/04 §5.4）。
 *
 * @param {string} text 用户原话
 * @param {object} extracted 模型输出的结构化结果
 * @param {{categories?: object[], today?: string, confirmThresholdCents?: number}} opts
 */
export function applyExtracted(text, extracted = {}, opts = {}) {
  const {
    categories = [], today = todayString(), confirmThresholdCents = CONFIRM_THRESHOLD_CENTS,
  } = opts;
  const raw = String(text ?? '').trim();
  const model = extracted && typeof extracted === 'object' ? extracted : {};

  // 时间：服务端先按原话算；模型只在用户明说了绝对日期、而规则没识别出来时补位
  const dateInfo = extractDate(raw, today);
  let date = dateInfo.date;
  let dateSpecified = dateInfo.specified;
  if (!dateSpecified) {
    const modelDate = normalizeModelDate(model.date);
    if (modelDate) { date = modelDate; dateSpecified = true; }
  }

  // 金额：先信模型，模型给不出就退回规则。
  // 抽金额前先遮掉时间表达，免得「6月5日看电影45」里的 6 被当成金额。
  const amountSource = dateInfo.matched ? raw.replace(dateInfo.matched, ' ') : raw;
  let amountCents = centsFromModel(model.amount);
  let amountFuzzy;
  if (amountCents === null) {
    const fallback = extractAmount(amountSource);
    amountCents = fallback.cents;
    amountFuzzy = fallback.fuzzy;
  } else {
    amountFuzzy = FUZZY_HINTS.some((w) => raw.includes(w));
  }

  const ruleCat = extractCategory(raw);

  // 类型：模型的取值必须合法，否则退回规则
  const savingsIntent = SAVINGS_HINTS.some((w) => raw.includes(w));
  let typeScore;
  let type = TX_TYPE_SET.has(model.type) ? model.type : null;
  if (type) {
    typeScore = 1;
  } else {
    const guess = extractType(raw, ruleCat.direction);
    type = guess.type;
    typeScore = guess.score;
  }
  if (savingsIntent && type !== 'modify_balance') { type = 'transfer'; typeScore = 1; }

  // 分类：按方向过滤后做精确 / 模糊匹配，落库前才由服务端拍板
  const direction = type === 'income' ? 'income' : type === 'expense' ? 'expense' : null;
  let cat = matchCategory(model.category, categories, { direction });
  // 模型没说分类时退回规则抽取；但它给了个不存在的分类时要落「待分类」，
  // 不能拿规则结果去「补」，否则模型编造的分类会被悄悄抹平（docs/04 §5.2）
  if (!norm(model.category) && ruleCat.exact) {
    const fromRule = matchCategory(ruleCat.category, categories, { direction });
    if (fromRule.matched) cat = fromRule;
  }
  const categoryName = type === 'transfer' || type === 'modify_balance' ? null : cat.name;

  const note = typeof model.note === 'string' && model.note.trim()
    ? model.note.trim()
    : extractNote(raw, ruleCat.matched, dateInfo.matched, cat.name);

  const scores = {
    amount: amountCents !== null && amountCents > 0 ? 1 : amountFuzzy ? 0.2 : 0,
    type: typeScore,
    category: cat.score,
    date: dateSpecified ? 1 : 0.5,
  };
  const ruleConfidence = Number(
    (W.amount * scores.amount + W.type * scores.type + W.category * scores.category + W.date * scores.date)
      .toFixed(4),
  );

  // 模型自报的 confidence 与服务端评分取较低值（docs/04 §5.4）
  const modelConfidence =
    typeof model.confidence === 'number' && model.confidence >= 0 && model.confidence <= 1
      ? Number(model.confidence.toFixed(4))
      : null;
  const confidence = modelConfidence === null ? ruleConfidence : Math.min(ruleConfidence, modelConfidence);

  const result = {
    raw,
    amountCents,
    amountSpecified: amountCents !== null,
    amountFuzzy,
    type,
    categoryName,
    categoryMatched: cat.matched ? categoryName : null,
    date,
    dateSpecified,
    transferToSavings: savingsIntent,
    note,
    confidence,
    scores,
    /** 排障用：模型原本说了什么 */
    llm: {
      amount: model.amount ?? null,
      type: model.type ?? null,
      category: model.category ?? null,
      date: model.date ?? null,
      confidence: modelConfidence,
      question: model.question ?? null,
    },
  };

  return { ...result, ...decide(result, { today, confirmThresholdCents }) };
}

export { monthOf, isValidMonth, SAVINGS_HINTS };