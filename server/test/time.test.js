import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toDateString, toDateTimeString, todayString, yesterdayString, addDays, diffDays,
  monthOf, isValidDate, isValidMonth, daysInMonth, monthStart, monthEnd,
  prevMonth, nextMonth, samePeriodEndDate, daysElapsedInMonth,
  weekdayOf, weekdayZh, resolveRelativeDate, formatDateZh, formatMonthZh,
} from '../src/domain/time.js';

test('日期与时间的本地格式', () => {
  assert.match(toDateString(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(toDateTimeString(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(addDays(todayString(), -1), yesterdayString());
});

test('日期加减与差值', () => {
  assert.equal(addDays('2026-09-10', 1), '2026-09-11');
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // 闰年
  assert.equal(diffDays('2026-09-01', '2026-09-10'), 9);
});

test('非法日期必须被拒绝', () => {
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-9-1'), false);
  assert.equal(isValidDate(''), false);
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(addDays('2026-02-30', 1), null);
});

test('月份边界', () => {
  assert.equal(daysInMonth('2026-09'), 30);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(monthStart('2026-09'), '2026-09-01');
  assert.equal(monthEnd('2026-09'), '2026-09-30');
  assert.equal(monthOf('2026-09-10'), '2026-09');
  assert.equal(prevMonth('2026-01'), '2025-12');
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(isValidMonth('2026-13'), false);
});

test('跨月同期对齐——3月31日对上2月要夹到最后一天', () => {
  assert.equal(samePeriodEndDate('2026-08', 10), '2026-08-10');
  assert.equal(samePeriodEndDate('2026-02', 31), '2026-02-28');
  assert.equal(samePeriodEndDate('2028-02', 31), '2028-02-29');
});

test('月内已过天数', () => {
  assert.equal(daysElapsedInMonth('2026-09', '2026-09-10'), 10);
  assert.equal(daysElapsedInMonth('2026-08', '2026-09-10'), 31);
  assert.equal(daysElapsedInMonth('2026-10', '2026-09-10'), 0);
});

test('星期', () => {
  assert.equal(weekdayOf('2026-09-10'), 4);        // 周四
  assert.equal(weekdayZh('2026-09-10'), '星期四');
  assert.equal(weekdayZh('2026-09-13'), '星期日');
});

test('相对日期词由服务端换算', () => {
  const today = '2026-09-10';
  assert.equal(resolveRelativeDate('今天', today), '2026-09-10');
  assert.equal(resolveRelativeDate('昨天', today), '2026-09-09');
  assert.equal(resolveRelativeDate('前天', today), '2026-09-08');
  assert.equal(resolveRelativeDate('大前天', today), '2026-09-07');
  assert.equal(resolveRelativeDate('后天', today), '2026-09-12');
  assert.equal(resolveRelativeDate('瞎写', today), null);
});

test('中文格式化', () => {
  assert.equal(formatDateZh('2026-09-10'), '9月10日 星期四');
  assert.equal(formatMonthZh('2026-09'), '2026年9月');
});