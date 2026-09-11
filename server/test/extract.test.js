import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExtracted, matchCategory } from '../src/domain/parse.js';
import { freshDb } from './helpers.js';

const TODAY = '2026-09-10';

/** 真库里的分类清单——强校验必须对着它做，不能另起一份 */
function categories() {
  const db = freshDb();
  const rows = db
    .prepare(
      `SELECT c.name, c.direction, p.name AS parent_name
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
        WHERE c.archived = 0`,
    )
    .all()
    .map((r) => ({ name: r.name, direction: r.direction, parentName: r.parent_name }));
  db.close();
  return rows;
}
const CATS = categories();

const merge = (text, extracted) => applyExtracted(text, extracted, { categories: CATS, today: TODAY });

test('模型说对了：金额、类型、分类、备注都采纳', () => {
  const r = merge('中午吃了碗面', { amount: 32, type: 'expense', category: '食品餐饮', note: '中午吃面', confidence: 0.9 });
  assert.equal(r.amountCents, 3200);
  assert.equal(r.type, 'expense');
  assert.equal(r.categoryName, '食品餐饮');
  assert.equal(r.note, '中午吃面');
  assert.equal(r.decision, 'record');
});

test('模型自创分类：落「待分类」并如实降低置信度', () => {
  const r = merge('午饭35', { amount: 35, type: 'expense', category: '吃放', confidence: 1 });
  assert.equal(r.categoryName, '待分类');
  assert.equal(r.categoryMatched, null);
  // 分类维度只拿 0.2，整体分数要掉下来，不能因为模型自报 1.0 就蒙混过关
  assert.ok(r.confidence < 0.9, `置信度应被拉低，实际 ${r.confidence}`);
});

test('模糊唯一命中：用匹配到的分类，分数打折', () => {
  const r = merge('买了个键盘', { amount: 300, type: 'expense', category: '数码产品', confidence: 1 });
  assert.equal(r.categoryName, '数码');
  assert.equal(r.scores.category, 0.5);
});

test('有歧义的模糊匹配宁可退回「待分类」，不猜', () => {
  const r = matchCategory('费', CATS, { direction: 'expense' });
  assert.equal(r.name, '待分类');
  assert.equal(r.matched, false);
});

test('模型给不出金额时退回规则抽取，而不是丢掉这一笔', () => {
  const r = merge('午饭35', { amount: null, type: 'expense', category: '食品餐饮', confidence: 0.9 });
  assert.equal(r.amountCents, 3500);
});

test('金额确实没有：追问金额，不落账', () => {
  const r = merge('买了点东西', { amount: null, type: 'expense', category: '待分类', confidence: 0.9 });
  assert.equal(r.amountCents, null);
  assert.equal(r.decision, 'ask_amount');
});

test('相对时间由服务端换算，模型说不说都不影响', () => {
  assert.equal(merge('昨天超市买菜76.5', { amount: 76.5, type: 'expense', category: '购物消费', date: null }).date, '2026-09-09');
  // 模型硬报一个日期也没用：原话里的相对表达优先
  assert.equal(merge('昨天打车18', { amount: 18, type: 'expense', category: '出行交通', date: '2020-01-01' }).date, '2026-09-09');
});

test('用户明说了绝对日期、规则没识别出来时，才用模型补位', () => {
  const r = merge('2026-08-03 买了本书', { amount: 45, type: 'expense', category: '书籍', date: '2026-08-03' });
  assert.equal(r.date, '2026-08-03');
  assert.equal(r.categoryName, '书籍');
});

test('类型非法就退回规则，不看模型脸色', () => {
  const r = merge('还信用卡2000', { amount: 2000, type: '还款', category: null, confidence: 1 });
  assert.equal(r.type, 'transfer');
  assert.equal(r.decision, 'ask_account');
});

test('方向不对的分类不采纳：支出不能挂收入分类', () => {
  const r = merge('随便记一笔', { amount: 50, type: 'expense', category: '工资', confidence: 1 });
  assert.equal(r.categoryName, '待分类');
});

test('硬规则压倒分数：大额支出必须确认', () => {
  const r = merge('前天房租3500', { amount: 3500, type: 'expense', category: '生活必需', confidence: 1 });
  assert.equal(r.decision, 'confirm');
  assert.equal(r.reason, 'large_amount');
});

test('存钱识别为转账，且不走账户追问', () => {
  const r = merge('存了2000', { amount: 2000, type: 'transfer', category: null, confidence: 1 });
  assert.equal(r.type, 'transfer');
  assert.equal(r.transferToSavings, true);
  assert.equal(r.categoryName, null);
});

test('置信度取模型与服务端评分的较低值', () => {
  const r = merge('午饭35', { amount: 35, type: 'expense', category: '食品餐饮', confidence: 0.4 });
  assert.equal(r.confidence, 0.4);
  assert.equal(r.decision, 'confirm');
  assert.equal(r.reason, 'low_confidence');
});

test('模型返回垃圾（字符串 / 空对象）不炸，退回纯规则', () => {
  assert.equal(merge('午饭35', {}).amountCents, 3500);
  assert.equal(merge('午饭35', null).categoryName, '食品餐饮');
  assert.equal(merge('午饭35', 'oops').type, 'expense');
});

test('排障信息保留模型原话，但落库只认服务端的判定', () => {
  const r = merge('午饭35', { amount: 35, type: 'expense', category: '吃放', confidence: 0.8 });
  assert.equal(r.llm.category, '吃放');
  assert.equal(r.categoryName, '待分类');
});
