import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmountToCents, parseChineseNumber, formatCents, formatYuan, formatYuanGrouped, formatShare,
} from '../src/domain/money.js';

test('阿拉伯数字写法', () => {
  assert.equal(parseAmountToCents('35'), 3500);
  assert.equal(parseAmountToCents('35.5'), 3550);
  assert.equal(parseAmountToCents('35.50'), 3550);
  assert.equal(parseAmountToCents('0.01'), 1);
  assert.equal(parseAmountToCents('1,234.56'), 123456);
  assert.equal(parseAmountToCents('1200'), 120000);
  assert.equal(parseAmountToCents(35.5), 3550);
});

test('带货币单位', () => {
  assert.equal(parseAmountToCents('￥35'), 3500);
  assert.equal(parseAmountToCents('¥35'), 3500);
  assert.equal(parseAmountToCents('35元'), 3500);
  assert.equal(parseAmountToCents('35块'), 3500);
  assert.equal(parseAmountToCents('35.5元'), 3550);
  assert.equal(parseAmountToCents('35元5角'), 3550);
  assert.equal(parseAmountToCents('五毛'), 50);
  assert.equal(parseAmountToCents('3分'), 3);
});

test('中文数字', () => {
  assert.equal(parseAmountToCents('三十五'), 3500);
  assert.equal(parseAmountToCents('十五'), 1500);
  assert.equal(parseAmountToCents('二十'), 2000);
  assert.equal(parseAmountToCents('三十五块五'), 3550);
  assert.equal(parseAmountToCents('一百零二'), 10200);
  assert.equal(parseAmountToCents('一百二'), 12000);   // 口语省略
  assert.equal(parseAmountToCents('一千二'), 120000);
  assert.equal(parseAmountToCents('两万三'), 2300000);
  assert.equal(parseAmountToCents('三十五点五'), 3550);
});

test('中文数字解析器单独可用', () => {
  assert.equal(parseChineseNumber('三百五十七'), 357);
  assert.equal(parseChineseNumber('一万零五'), 10005);
  assert.equal(parseChineseNumber('二百万'), 2000000);
  assert.equal(parseChineseNumber('瞎写'), null);
});

test('解析失败一律返回 null，绝不猜', () => {
  assert.equal(parseAmountToCents(''), null);
  assert.equal(parseAmountToCents(null), null);
  assert.equal(parseAmountToCents('银行卡'), null);
  assert.equal(parseAmountToCents('35abc'), null);   // 不能悄悄当成 35
  assert.equal(parseAmountToCents('-5'), null);
  assert.equal(parseAmountToCents('大概一百多'), null);
  assert.equal(parseAmountToCents('几十块'), null);
  assert.equal(parseAmountToCents('999999999999999'), null); // 超上限
});

test('零是合法值，由调用方决定是否接受', () => {
  assert.equal(parseAmountToCents('0'), 0);
  assert.equal(parseAmountToCents('0元'), 0);
});

test('格式化', () => {
  assert.equal(formatCents(3500), '35.00');
  assert.equal(formatCents(-3500), '-35.00');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatYuan(3500), '¥35.00');
  assert.equal(formatYuanGrouped(423150), '¥4,231.50');
  assert.equal(formatYuanGrouped(-423150), '-¥4,231.50');
  assert.equal(formatYuanGrouped(0), '¥0.00');
});

test('占比展示：分母为 0 显示破折号，不是 0% 也不是 NaN', () => {
  assert.equal(formatShare(0.2987), '29.9%');
  assert.equal(formatShare(null), '—');
  assert.equal(formatShare(undefined), '—');
  assert.equal(formatShare(NaN), '—');
});