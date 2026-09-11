/**
 * 分类体系与迁移。
 *
 * 这套断言的价值在于**挡住漂移**：分类清单有几个使用方（模型提示词、规则关键词表、
 * 落库校验、网页下拉），任何一处跟不上都会表现成「模型说得出、落库不认」这种
 * 只有用户才会撞上的问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, accountId, TODAY } from './helpers.js';
import { EXPENSE_TREE, INCOME_LIST, reconcileCategories } from '../src/db/categories.js';
import { EXPENSE_KEYWORDS, INCOME_KEYWORDS } from '../src/domain/parse.js';
import { addTransaction } from '../src/domain/transactions.js';

/** 库里的支出一级分类，按 sort_order */
function expenseTops(db) {
  return db.prepare(
    `SELECT name FROM categories
      WHERE direction = 'expense' AND parent_id IS NULL AND archived = 0
      ORDER BY sort_order, id`,
  ).all().map((r) => r.name);
}

/** 流水现在挂在哪个分类上（node:sqlite 返回的是 null 原型对象，这里转成普通对象好断言） */
function categoryOf(db, txId) {
  const row = db.prepare(
    `SELECT c.name AS name, p.name AS parent
       FROM transactions t JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
      WHERE t.id = ?`,
  ).get(txId);
  return { name: row?.name ?? null, parent: row?.parent ?? null };
}

test('新库的支出一级分类就是这套体系，顺序也一致', () => {
  const db = freshDb();
  assert.deepEqual(expenseTops(db), Object.keys(EXPENSE_TREE));
  assert.equal(expenseTops(db).at(-1), '待分类', '兜底分类必须在，且排在最后');

  const income = db.prepare(
    `SELECT name FROM categories
      WHERE direction = 'income' AND parent_id IS NULL AND archived = 0 ORDER BY sort_order, id`,
  ).all().map((r) => r.name);
  assert.deepEqual(income, INCOME_LIST);
});

test('二级分类挂在正确的一级分类下面', () => {
  const db = freshDb();
  const stray = db.prepare(
    `SELECT c.name, p.name AS parent FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
      WHERE c.direction = 'expense' AND c.parent_id IS NOT NULL AND c.archived = 0`,
  ).all().filter((r) => !(EXPENSE_TREE[r.parent] ?? []).includes(r.name));
  assert.deepEqual(stray, [], '有二级分类挂到了没定义它的父分类下');

  for (const [parent, children] of Object.entries(EXPENSE_TREE)) {
    for (const child of children) {
      const row = db.prepare(
        `SELECT 1 AS ok FROM categories c JOIN categories p ON p.id = c.parent_id
          WHERE c.name = ? AND p.name = ? AND c.archived = 0`,
      ).get(child, parent);
      assert.ok(row, `「${parent}」下面应该有「${child}」`);
    }
  }
});

test('规则关键词表的每个分类都真实存在——否则模型/规则说得出，落库不认', () => {
  const db = freshDb();
  const expense = new Set(expenseTops(db));
  const income = new Set(
    db.prepare(
      `SELECT name FROM categories WHERE direction = 'income' AND archived = 0`,
    ).all().map((r) => r.name),
  );

  for (const name of Object.keys(EXPENSE_KEYWORDS)) {
    assert.ok(expense.has(name), `支出关键词表里的「${name}」不是一级支出分类`);
  }
  for (const name of Object.keys(INCOME_KEYWORDS)) {
    assert.ok(income.has(name), `收入关键词表里的「${name}」不是收入分类`);
  }
});

test('老库迁移：旧分类原地改名、孩子搬新家、历史流水一条不动', () => {
  const db = freshDb();
  // 把库倒回旧体系：真实账本迁移前长的就是这个样子
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM categories');
  const insert = db.prepare(
    `INSERT INTO categories(name, parent_id, direction, sort_order) VALUES(?, ?, 'expense', ?)`,
  );
  const oldTree = {
    餐饮: ['午饭', '外卖'],
    居住: ['房租', '水电燃气'],
    通讯: ['话费'],
    待分类: [],
  };
  let order = 0;
  const oldIds = {};
  for (const [parent, children] of Object.entries(oldTree)) {
    oldIds[parent] = Number(insert.run(parent, null, order++).lastInsertRowid);
    for (const child of children) insert.run(child, oldIds[parent], order++);
  }

  const { transaction } = addTransaction(db, {
    type: 'expense', amountCents: 5700, categoryName: '餐饮',
    occurredDate: TODAY, accountId: accountId(db),
  });
  assert.deepEqual(categoryOf(db, transaction.id), { name: '餐饮', parent: null });

  const log = reconcileCategories(db);

  assert.ok(log.renamed.includes('餐饮→食品餐饮'), '餐饮 应该原地改名');
  assert.deepEqual(expenseTops(db), Object.keys(EXPENSE_TREE));
  assert.deepEqual(log.archived.sort(), ['居住', '通讯']);

  // 改名是「原地」的：id 没变，所以流水的外键一动不动
  const renamed = db.prepare("SELECT id FROM categories WHERE name = '食品餐饮'").get();
  assert.equal(renamed.id, oldIds.餐饮);
  assert.deepEqual(categoryOf(db, transaction.id), { name: '食品餐饮', parent: null },
    '历史流水应该跟着改名');

  // 旧一级分类的孩子搬到新家，而不是跟着被归档
  for (const [child, parent] of [['房租', '生活必需'], ['水电燃气', '生活必需'], ['话费', '生活必需']]) {
    const row = db.prepare(
      `SELECT p.name AS parent FROM categories c JOIN categories p ON p.id = c.parent_id
        WHERE c.name = ? AND c.archived = 0`,
    ).get(child);
    assert.equal(row?.parent, parent, `${child} 应该挂到「${parent}」下面`);
  }
});

test('迁移可反复执行：第二次什么都不改', () => {
  const db = freshDb();
  const before = db.prepare('SELECT id, name, parent_id, sort_order, archived FROM categories ORDER BY id').all();

  const log = reconcileCategories(db);

  assert.deepEqual(
    { added: log.added, renamed: log.renamed, moved: log.moved, archived: log.archived },
    { added: [], renamed: [], moved: [], archived: [] },
  );
  assert.deepEqual(
    db.prepare('SELECT id, name, parent_id, sort_order, archived FROM categories ORDER BY id').all(),
    before,
  );
});

test('迁移不碰用户自己加的分类', () => {
  const db = freshDb();
  db.prepare("INSERT INTO categories(name, parent_id, direction, sort_order) VALUES('宠物', NULL, 'expense', 99)").run();

  reconcileCategories(db);

  assert.equal(db.prepare("SELECT archived FROM categories WHERE name = '宠物'").get().archived, 0);
});

test('每个二级分类的 sort_order 都大于它的一级分类——否则子分类会排到父分类前面', () => {
  const db = freshDb();
  const bad = db.prepare(
    `SELECT c.name AS child, c.sort_order AS child_order, p.name AS parent, p.sort_order AS parent_order
       FROM categories c JOIN categories p ON p.id = c.parent_id
      WHERE c.archived = 0 AND c.sort_order <= p.sort_order`,
  ).all();
  assert.deepEqual(bad, []);
});