/**
 * 金额处理：一切以**整数「分」**为唯一内部表示。
 *
 * 设计约束（docs/02 §1）：
 *   · 绝不出现浮点金额参与运算或存储
 *   · 输入格式要宽容（「35」「￥35」「三十五」「三十五块五」都要认）
 *   · 解析失败一律返回 null，由调用方决定是追问还是报错
 */

/** 单笔金额上限：1000 亿元。超过基本可以断定是解析错误 */
export const MAX_CENTS = 1e13;

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_SMALL_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const CN_BIG_UNITS = { 万: 10000, 亿: 1e8, 億: 1e8 };

const CN_NUM_CHARS = '零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟';

/**
 * 解析中文数字，支持口语省略。
 *   十五 -> 15      一百二 -> 120     一百零二 -> 102
 *   一千二 -> 1200   两万三 -> 23000   三十五点五 -> 35.5
 */
export function parseChineseNumber(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;

  let intPart = s;
  let decPart = '';
  const dot = s.search(/[点點]/);
  if (dot >= 0) {
    intPart = s.slice(0, dot);
    decPart = s.slice(dot + 1);
    if (!decPart) return null;
  }

  const intVal = parseIntPart(intPart);
  if (intVal === null) return null;
  if (dot < 0) return intVal;

  let frac = 0;
  let scale = 0.1;
  for (const ch of decPart) {
    if (!(ch in CN_DIGITS)) return null;
    frac += CN_DIGITS[ch] * scale;
    scale /= 10;
  }
  return Number((intVal + frac).toFixed(10));
}

function parseIntPart(s) {
  if (!s) return null;
  let result = 0;
  let section = 0;
  let current = 0;
  let lastUnit = 0;
  let sawZero = false;

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      const v = CN_DIGITS[ch];
      if (v === 0) sawZero = true;
      current = v;
    } else if (ch in CN_SMALL_UNITS) {
      const u = CN_SMALL_UNITS[ch];
      // 「十五」的十前面没有数字，按 1 处理
      section += (current === 0 ? 1 : current) * u;
      current = 0;
      lastUnit = u;
    } else if (ch in CN_BIG_UNITS) {
      const b = CN_BIG_UNITS[ch];
      result += (section + current) * b;
      section = 0;
      current = 0;
      lastUnit = b;
    } else {
      return null;
    }
  }

  if (current === 0) return result + section;

  // 口语省略：一百二 = 120、一千二 = 1200、两万三 = 23000，但一百零二 = 102
  if (!sawZero && lastUnit >= 100) return result + section + current * (lastUnit / 10);
  return result + section + current;
}

const YUAN_UNITS = new Set(['元', '块', '圆', '園']);
const JIAO_UNITS = new Set(['毛', '角']);
const FEN_UNITS = new Set(['分']);

/**
 * 把任意常见写法解析成整数分。
 * @returns {number|null} 分；解析不了返回 null
 */
export function parseAmountToCents(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return checkRange(Math.round(input * 100));
  }

  let s = String(input).trim();
  if (!s) return null;

  s = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.')
    .replace(/[￥¥$，,、\s]/g, '')
    .replace(/[钱整]$/, '');

  // 中文小数必须「点」后面还有中文数字，免得把「点了外卖」这种词吃进来
  const re = new RegExp(
    `([0-9]+(?:\\.[0-9]+)?|[${CN_NUM_CHARS}]+(?:[点點][${CN_NUM_CHARS}]+)?)(元|块|圆|園|毛|角|分)?`,
    'g',
  );
  const tokens = [...s.matchAll(re)];
  if (!tokens.length) return null;
  // 整串必须被完全识别，避免「35abc」被安安静静地当成 35
  if (tokens.map((t) => t[0]).join('') !== s) return null;

  let total = 0;
  let seenYuan = false;

  for (const [, numStr, unit] of tokens) {
    const v = /^[0-9]/.test(numStr) ? Number(numStr) : parseChineseNumber(numStr);
    if (v === null || !Number.isFinite(v)) return null;

    if (unit && YUAN_UNITS.has(unit)) {
      total += v;
      seenYuan = true;
    } else if (unit && JIAO_UNITS.has(unit)) {
      total += v / 10;
      seenYuan = true;
    } else if (unit && FEN_UNITS.has(unit)) {
      total += v / 100;
      seenYuan = true;
    } else if (tokens.length === 1) {
      total += v; // 光秃秃一个数，当元
    } else if (seenYuan) {
      total += v / 10; // 「三十五块五」——块后面跟的单个数是角
    } else {
      return null; // 多个无单位数字并列，语义不明
    }
  }

  return checkRange(Math.round(total * 100));
}

function checkRange(cents) {
  if (!Number.isFinite(cents)) return null;
  if (Math.abs(cents) > MAX_CENTS) return null;
  return cents;
}

/** 3500 -> '35.00'（不带货币符号、不带千分位，用于存储与比较） */
export function formatCents(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 3500 -> '¥35.00' */
export function formatYuan(cents) {
  const n = Number(cents) || 0;
  return `${n < 0 ? '-' : ''}¥${formatCents(Math.abs(n))}`;
}

/** 423150 -> '¥4,231.50'，给页面和回执用 */
export function formatYuanGrouped(cents) {
  const n = Number(cents) || 0;
  const [int, frac] = formatCents(Math.abs(n)).split('.');
  return `${n < 0 ? '-' : ''}¥${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** 0.2987 -> '29.9%'；null -> '—'（分母为 0 时前面就已经是 null） */
export function formatShare(share) {
  if (share === null || share === undefined || !Number.isFinite(share)) return '—';
  return `${(share * 100).toFixed(1)}%`;
}

/** 比率的展示舍入，口径见 docs/02 §4.4 —— 存储与传输用精确值，只在展示时舍入 */
export function roundShare(share) {
  if (share === null || !Number.isFinite(share)) return null;
  return Number(share.toFixed(4));
}