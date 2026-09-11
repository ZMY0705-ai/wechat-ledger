/**
 * 时间处理：全部按 Asia/Shanghai，且「今天/昨天/本月」一律由服务端算。
 *
 * 依据 docs/02 §1 与 §4.8：桥接与 LLM 都不计算日期，避免时区/时钟不一致导致漏账。
 * 日期运算统一走 UTC 毫秒做加减（中国无夏令时，日期字符串运算不会漂移）。
 */

export const TZ = 'Asia/Shanghai';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });

const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD'（按上海时区） */
export function toDateString(date = new Date()) {
  return dateFmt.format(date);
}

/** Date -> 'HH:MM:SS'（按上海时区） */
export function toTimeString(date = new Date()) {
  return timeFmt.format(date);
}

/** Date -> 'YYYY-MM-DD HH:MM:SS' —— 数据库里统一的本地时间格式 */
export function toDateTimeString(date = new Date()) {
  return `${toDateString(date)} ${toTimeString(date)}`;
}

export const nowString = () => toDateTimeString();
export const todayString = (date = new Date()) => toDateString(date);

/** 'YYYY-MM-DD' -> 当天 00:00:00 的 UTC 毫秒（只用于日期加减） */
function toUtcMillis(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 反查，挡住 2026-02-30 这种非法日期
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

function fromUtcMillis(ms) {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function isValidDate(dateStr) {
  return toUtcMillis(dateStr) !== null;
}

export function addDays(dateStr, n) {
  const ms = toUtcMillis(dateStr);
  if (ms === null) return null;
  return fromUtcMillis(ms + n * 86_400_000);
}

/** b - a，单位天 */
export function diffDays(a, b) {
  const ma = toUtcMillis(a);
  const mb = toUtcMillis(b);
  if (ma === null || mb === null) return null;
  return Math.round((mb - ma) / 86_400_000);
}

export const yesterdayString = (date = new Date()) => addDays(toDateString(date), -1);

/** 'YYYY-MM-DD' -> 'YYYY-MM' */
export function monthOf(dateStr) {
  return isValidDate(dateStr) ? String(dateStr).slice(0, 7) : null;
}

export function isValidMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month));
}

export function daysInMonth(month) {
  if (!isValidMonth(month)) return null;
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const monthStart = (month) => `${month}-01`;
export const monthEnd = (month) => `${month}-${pad2(daysInMonth(month))}`;

export function shiftMonth(month, delta) {
  if (!isValidMonth(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

export const prevMonth = (month) => shiftMonth(month, -1);
export const nextMonth = (month) => shiftMonth(month, 1);

/**
 * 跨月同期对齐（docs/02 §4.5）——极易出错，单独封装。
 * 例如「9 月 1 日至今」对比「8 月 1 日 ~ 8 月 9 日」。
 * 上月没有对应日号时（3 月 31 日对 2 月）取上月最后一天。
 */
export function samePeriodEndDate(month, dayOfMonth) {
  const total = daysInMonth(month);
  if (total === null) return null;
  return `${month}-${pad2(Math.min(dayOfMonth, total))}`;
}

/** 该月已过去多少天（用于月内进度百分比） */
export function daysElapsedInMonth(month, today = toDateString()) {
  const total = daysInMonth(month);
  if (total === null) return null;
  if (monthOf(today) === month) return Number(today.slice(8, 10));
  if (month < monthOf(today)) return total;
  return 0;
}

/** 0=周日 … 6=周六 */
export function weekdayOf(dateStr) {
  const ms = toUtcMillis(dateStr);
  if (ms === null) return null;
  return new Date(ms).getUTCDay();
}

export function weekdayZh(dateStr) {
  const w = weekdayOf(dateStr);
  return w === null ? null : WEEKDAY_ZH[w];
}

/** 相对日期词 -> 具体日期。服务端算，不接受客户端传（docs/02 §4.8） */
const RELATIVE_WORDS = {
  今天: 0, 今日: 0, 当天: 0,
  昨天: -1, 昨日: -1,
  前天: -2,
  大前天: -3,
  明天: 1, 明日: 1,
  后天: 2,
  大后天: 3,
};

export function resolveRelativeDate(word, today = toDateString()) {
  if (!(word in RELATIVE_WORDS)) return null;
  return addDays(today, RELATIVE_WORDS[word]);
}

/** '2026-09-10' -> '9月10日 星期四'，回执里用 */
export function formatDateZh(dateStr) {
  if (!isValidDate(dateStr)) return dateStr;
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}月${Number(d)}日 ${weekdayZh(dateStr)}`;
}

/** '2026-09' -> '2026年9月' */
export function formatMonthZh(month) {
  if (!isValidMonth(month)) return month;
  const [y, m] = month.split('-');
  return `${y}年${Number(m)}月`;
}