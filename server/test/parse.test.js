import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLedgerText, extractAmount, extractDate, CONFIDENCE_THRESHOLD } from '../src/domain/parse.js';

const TODAY = '2026-09-10';
const p = (text) => parseLedgerText(text, { today: TODAY });

/**
 * docs/07 §3 的 12 条回归语料。
 * 只解析、不写入；改任何解析逻辑都必须先跑这组。
 */
const CORPUS = [
  { input: '午饭35',           cents: 3500,     category: '食品餐饮',     type: 'expense',  date: '2026-09-10', decision: 'record' },
  { input: '打车18.5',         cents: 1850,     category: '出行交通',     type: 'expense',  date: '2026-09-10', decision: 'record' },
  { input: '¥30 奶茶',         cents: 3000,     category: '食品餐饮',     type: 'expense',  date: '2026-09-10', decision: 'record' },
  { input: '昨天超市买菜76.5',  cents: 7650,     category: '食品餐饮',     type: 'expense',  date: '2026-09-09', decision: 'record' },
  { input: '发工资12000',      cents: 1200000,  category: '工资',     type: 'income',   date: '2026-09-10', decision: 'record' },
  { input: '前天房租3500',      cents: 350000,   category: '生活必需',     type: 'expense',  date: '2026-09-08', decision: 'confirm' },
  { input: '还信用卡2000',      cents: 200000,   category: null,       type: 'transfer', date: '2026-09-10', decision: 'ask_account' },
  { input: '买了点东西',        cents: null,     category: '待分类',    type: 'expense',  date: '2026-09-10', decision: 'ask_amount' },
  { input: '大概一百多',        cents: null,     category: '待分类',    type: 'expense',  date: '2026-09-10', decision: 'ask_amount' },
  { input: '老板发了500红包',   cents: 50000,    category: '红包收入',  type: 'income',   date: '2026-09-10', decision: 'record' },
  { input: '上周五加油200',     cents: 20000,    category: '出行交通',     type: 'expense',  date: '2026-09-04', decision: 'confirm' },
  { input: '6月5日看电影45',    cents: 4500,     category: '休闲娱乐',     type: 'expense',  date: '2026-06-05', decision: 'record' },
];

for (const c of CORPUS) {
  test(`语料：${c.input}`, () => {
    const r = p(c.input);
    assert.equal(r.amountCents, c.cents, '金额');
    assert.equal(r.categoryName, c.category, '分类');
    assert.equal(r.type, c.type, '类型');
    assert.equal(r.date, c.date, '日期');
    assert.equal(r.decision, c.decision, '处置');
  });
}

test('日期里的数字不能被当成金额', () => {
  assert.equal(p('6月5日看电影45').amountCents, 4500);
  assert.equal(p('3天前话费50').amountCents, 5000);
  assert.equal(p('3天前话费50').date, '2026-09-07');
});

test('大额确认只针对支出——收入不该被反复打扰', () => {
  assert.equal(p('发工资12000').decision, 'record');
  assert.equal(p('老板发了500红包').decision, 'record');
  assert.equal(p('前天房租3500').decision, 'confirm');
});

test('转账与余额校准不带分类', () => {
  assert.equal(p('还信用卡2000').categoryName, null);
  assert.equal(p('余额校准').type, 'modify_balance');
  assert.equal(p('余额校准').categoryName, null);
});

test('模糊金额要标注出来，便于追问时换措辞', () => {
  assert.equal(p('大概一百多').amountFuzzy, true);
  assert.equal(p('午饭35').amountFuzzy, false);
  assert.match(p('大概一百多').question, /模糊/);
});

test('未来的日期要追问，不能悄悄记到未来', () => {
  const r = p('明天买菜30');
  assert.equal(r.date, '2026-09-11');
  assert.equal(r.decision, 'ask_date');
});

test('置信度：要素齐全就高，缺要素就低', () => {
  assert.ok(p('昨天超市买菜76.5').confidence >= CONFIDENCE_THRESHOLD);
  assert.ok(p('买了点东西').confidence < CONFIDENCE_THRESHOLD);
  assert.ok(p('昨天午饭35').confidence > p('午饭35').confidence);
});

test('抽取器可单独调用', () => {
  assert.equal(extractAmount('午饭35').cents, 3500);
  assert.equal(extractAmount('没有数字').cents, null);
  assert.equal(extractDate('前天房租3500', TODAY).date, '2026-09-08');
  assert.equal(extractDate('随机一句话', TODAY).specified, false);
});
test('存钱的说法按转账处理，目标是长期储蓄', () => {
  const r = p('存了50');
  assert.equal(r.type, 'transfer');
  assert.equal(r.transferToSavings, true);
  assert.equal(r.categoryName, null);
  assert.equal(r.decision, 'record');
  assert.equal(r.reason, 'transfer_savings');

  assert.equal(p('昨天转存500进储蓄').type, 'transfer');
  assert.equal(p('昨天转存500进储蓄').date, '2026-09-09');
  assert.equal(p('攒起来300').transferToSavings, true);

  // 大额储蓄转账仍然确认一次：转错会同时污染两个余额，而且不容易发现
  assert.equal(p('存了2000').decision, 'confirm');
  assert.equal(p('存了2000').reason, 'large_amount');

  // 普通转账不受影响，仍然要问账户
  assert.equal(p('还信用卡2000').transferToSavings, false);
  assert.equal(p('还信用卡2000').decision, 'ask_account');

  // 余额校准优先级最高，不能被「存入」这类词带跑
  assert.equal(p('余额校准').type, 'modify_balance');
});

test('存钱没写金额时先追问金额，不要瞎猜', () => {
  const r = p('存了点钱');
  assert.equal(r.type, 'transfer');
  assert.equal(r.transferToSavings, true);
  assert.equal(r.amountCents, null);
  assert.equal(r.decision, 'ask_amount');
});
