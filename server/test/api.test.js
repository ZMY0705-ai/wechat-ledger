import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/index.js';
import { CASH_ACCOUNT, SAVINGS_ACCOUNT } from '../src/db/seed.js';

/**
 * 服务层测试。
 * 用内存库 + 随机端口，起一个真的 HTTP 服务打真的请求——
 * 路由、JSON 编解码、错误码这些地方，只有跑起来才测得到。
 */
let app;
let base;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
  base = app.url;
});

after(() => {
  app.server.close();
  app.db.close();
});

async function get(path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

async function post(path, payload) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function put(path, payload) {
  const response = await fetch(base + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

const balance = async () => (await get('/api/summary/balance')).body.data;
const accountId = async (name) => (await get('/api/accounts')).body.data.accounts.find((a) => a.name === name).id;

test('健康检查', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.data.status, 'ok');
  assert.ok(body.data.today);
});

test('记一笔支出：余额、快照、回执一次给全', async () => {
  const before = (await balance()).cashCents;
  const { status, body } = await post('/api/transactions', {
    type: 'expense', amountText: '35', category: '食品餐饮', note: '午饭',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.amountCents, 3500);
  assert.equal(body.data.categoryPath, '食品餐饮');
  assert.equal(body.data.deduplicated, false);
  assert.equal(body.data.snapshot.balanceCashCents, before - 3500);
  assert.match(body.message, /午饭/);
  assert.match(body.message, /¥35\.00/);
});

test('分类可以写「食品餐饮/午饭」这种路径', async () => {
  const { body } = await post('/api/transactions', {
    type: 'expense', amountText: '12', category: '食品餐饮/午饭',
  });
  assert.equal(body.data.category_name, '午饭');
  assert.equal(body.data.categoryPath, '食品餐饮/午饭');
});

test('幂等键命中：返回 200 和既有记录，不当成错误', async () => {
  const payload = { type: 'expense', amountText: '9', category: '出行交通', idemKey: 'api-test:idem-1' };
  const first = await post('/api/transactions', payload);
  const second = await post('/api/transactions', payload);

  assert.equal(first.body.data.deduplicated, false);
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.data.deduplicated, true);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.match(second.body.message, /已经记过了/);
});

test('错误响应带错误码，调用方能照着自纠', async () => {
  const badAmount = await post('/api/transactions', { type: 'expense', amountText: '不知道多少', category: '食品餐饮' });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error.code, 'BAD_AMOUNT');
  assert.ok(badAmount.body.error.hint);

  const badCategory = await post('/api/transactions', { type: 'expense', amountText: '10', category: '瞎写的' });
  assert.equal(badCategory.status, 400);
  assert.equal(badCategory.body.error.code, 'CATEGORY_NOT_FOUND');

  const badAccount = await post('/api/transactions', { type: 'expense', amountText: '10', category: '食品餐饮', accountId: 9999 });
  assert.equal(badAccount.status, 400);
  assert.equal(badAccount.body.error.code, 'ACCOUNT_NOT_FOUND');
});

test('转账走 HTTP：不进收支，只动两边余额', async () => {
  const beforeBalance = await balance();
  const beforeMonth = (await get('/api/summary/month')).body.data;

  const { body } = await post('/api/transactions', {
    type: 'transfer', amountText: '2000', note: '存钱',
  });

  assert.equal(body.data.type, 'transfer');
  assert.equal(body.data.to_account_name, SAVINGS_ACCOUNT);   // 不传 to 就默认存长期储蓄

  const after = await balance();
  assert.equal(after.cashCents, beforeBalance.cashCents - 200000);
  assert.equal(after.savingsCents, beforeBalance.savingsCents + 200000);
  assert.equal(after.totalCents, beforeBalance.totalCents);    // 只是换了个地方放

  const afterMonth = (await get('/api/summary/month')).body.data;
  assert.equal(afterMonth.expenseCents, beforeMonth.expenseCents);
  assert.equal(afterMonth.savingsInCents, beforeMonth.savingsInCents + 200000);
  assert.match(body.message, /长期储蓄/);
});

test('撤销：软删除，统计立刻回退', async () => {
  const before = (await balance()).cashCents;
  const created = await post('/api/transactions', { type: 'expense', amountText: '66', category: '食品餐饮' });
  assert.equal((await balance()).cashCents, before - 6600);

  const voided = await post(`/api/transactions/${created.body.data.id}/void`, { reason: '记错了' });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.data.transaction.status, 'voided');
  assert.equal((await balance()).cashCents, before);

  // 记录还在，只是状态变了
  const listed = await get('/api/transactions?all=1');
  assert.ok(listed.body.data.transactions.some((t) => t.id === created.body.data.id));
});

test('余额校准必须写清原因', async () => {
  const missingNote = await post('/api/adjust', { amount: '100' });
  assert.equal(missingNote.status, 400);
  assert.match(missingNote.body.error.message, /原因/);

  const account = await accountId(CASH_ACCOUNT);
  const current = (await balance()).accounts.find((a) => a.id === account).balanceCents;
  const { body } = await post('/api/adjust', { account, amount: ((current + 5000) / 100).toFixed(2), note: '9 月漏记对齐' });
  const after = (await balance()).accounts.find((a) => a.id === account).balanceCents;
  assert.equal(after, current + 5000);
  assert.match(body.message, /已校准/);
});

test('可以按分类筛选流水', async () => {
  const categories = (await get('/api/categories')).body.data.categories;
  const meals = categories.find((c) => c.name === '食品餐饮' && !c.parentName);
  const filtered = await get(`/api/transactions?categoryId=${meals.id}`);

  assert.ok(filtered.body.data.count > 0);
  for (const tx of filtered.body.data.transactions) {
    assert.ok(String(tx.categoryPath).startsWith('食品餐饮'), `${tx.categoryPath} 不该出现在食品餐饮筛选里`);
  }
});

test('仪表盘一次给齐余额、今日、昨日、本月与折线', async () => {
  const { body } = await get('/api/summary/dashboard?trendDays=14');
  const data = body.data;

  // 测试库里只有现金流和长期储蓄两个账户，所以合计必然等于两者之和
  assert.equal(data.balance.totalCents, data.balance.cashCents + data.balance.savingsCents);
  assert.equal(data.trend.dailyExpense.length, 14);
  assert.ok(data.month.expenseByCategory.length > 0);
  assert.ok(Array.isArray(data.yesterday.byCategory));
  // 折线补 0：没有流水的日子也在，否则曲线会跳
  assert.ok(data.trend.dailyExpense.every((d) => typeof d.cents === 'number'));
});

test('静态资源：首页、样式、脚本都能取到，且类型正确', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'text/javascript'], ['/charts.js', 'text/javascript']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), new RegExp(type), path);
  }
});

test('静态资源不允许越界读工作区里的其他文件', async () => {
  for (const path of ['/%2e%2e%2fpackage.json', '/../package.json', '/..%2fREADME.md']) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.ok([403, 404].includes(response.status), `${path} 竟然返回了 ${response.status}`);
  }
});

test('不设 Access-Control-Allow-Origin，防止别的网页偷读账本', async () => {
  const response = await fetch(base + '/api/summary/balance');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
test('干跑解析：只算不写，账本一行不动', async () => {
  const before = await get('/api/transactions?limit=1');
  const { status, body } = await post('/api/parse', { text: '午饭35', today: '2026-09-10' });

  assert.equal(status, 200);
  assert.equal(body.data.amountCents, 3500);
  assert.equal(body.data.categoryName, '食品餐饮');
  assert.equal(body.data.decision, 'record');
  assert.equal((await get('/api/transactions?limit=1')).body.data.count, before.body.data.count);
});

test('干跑解析：缺 text 直接报错，不要猜', async () => {
  const { status, body } = await post('/api/parse', { text: '   ' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'BAD_REQUEST');
});

test('干跑解析 + extracted：分类与日期由服务端拍板', async () => {
  const { status, body } = await post('/api/parse', {
    text: '昨天打车18',
    today: '2026-09-10',
    extracted: { amount: 18, type: 'expense', category: '乱写的分类', date: '2020-01-01', confidence: 0.95 },
  });

  assert.equal(status, 200);
  assert.equal(body.data.amountCents, 1800);
  assert.equal(body.data.categoryName, '待分类', '自创分类必须落待分类');
  assert.equal(body.data.date, '2026-09-09', '相对时间由服务端按原话换算');
  assert.equal(body.data.llm.category, '乱写的分类');
});

test('干跑解析 + extracted：模型乱报类型时退回规则，转账仍然要问账户', async () => {
  const { body } = await post('/api/parse', {
    text: '还信用卡2000',
    today: '2026-09-10',
    extracted: { amount: 2000, type: '还款', category: null, confidence: 1 },
  });
  assert.equal(body.data.type, 'transfer');
  assert.equal(body.data.decision, 'ask_account');
});

test('日报接口：结构完整，markSent 才写去重表', async () => {
  const first = await get('/api/report/brief?kind=morning&today=2026-09-10');
  assert.equal(first.status, 200);
  assert.equal(first.body.data.alreadySentToday, false);
  assert.ok(first.body.data.fallbackText);
  assert.ok(Array.isArray(first.body.data.signals));
  assert.equal(first.body.data.month.key, '2026-09');

  const marked = await get('/api/report/brief?kind=morning&today=2026-09-10&markSent=1');
  assert.equal(marked.body.data.alreadySentToday, false, '标记的那一次返回的是「推之前」的状态');

  const again = await get('/api/report/brief?kind=morning&today=2026-09-10');
  assert.equal(again.body.data.alreadySentToday, true, '推过之后必须知道');
});

test('日报接口：kind 和日期都要校验', async () => {
  const bad = await get('/api/report/brief?kind=noon');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_KIND');

  const badDate = await get('/api/report/brief?today=2026-13-99');
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.error.code, 'BAD_DATE');
});

// ── 月度预算 ────────────────────────────────────────────────────────────
// 特意用 2026-01 这个和「今天」无关的月份：这些用例会写库，
// 别去动 dashboard 正在统计的那个月，免得给别的用例添乱。
test('预算接口：没设过的时候是 none，不是 0 元预算', async () => {
  const { status, body } = await get('/api/budgets?month=2026-01');
  assert.equal(status, 200);
  assert.equal(body.data.status, 'none');
  assert.equal(body.data.budgetCents, 0);
  assert.equal(body.data.remainingCents, null);
});

test('预算接口：设置 → 读回 → 取消', async () => {
  const set = await put('/api/budgets', { month: '2026-01', amountText: '3000' });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.budgetCents, 300000);
  assert.equal(set.body.data.remainingCents, 300000);
  assert.match(set.body.message, /已设置/);

  const read = await get('/api/budgets?month=2026-01');
  assert.equal(read.body.data.budgetCents, 300000);

  // 改预算：同一行覆盖，不是再插一行
  const changed = await put('/api/budgets', { month: '2026-01', amountCents: 500000 });
  assert.equal(changed.body.data.budgetCents, 500000);

  const cleared = await put('/api/budgets', { month: '2026-01', amountText: '0' });
  assert.equal(cleared.body.data.budgetCents, 0);
  assert.equal(cleared.body.data.status, 'none');
  assert.match(cleared.body.message, /已取消/);
});

test('预算接口：金额和月份都要校验', async () => {
  // 注意别拿「三千」当非法输入：它是能解析的（中文数字是解析器的正经能力）
  const badAmount = await put('/api/budgets', { month: '2026-01', amountText: 'abc' });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error.code, 'BAD_AMOUNT');

  const noAmount = await put('/api/budgets', { month: '2026-01' });
  assert.equal(noAmount.status, 400);
  assert.equal(noAmount.body.error.code, 'BAD_AMOUNT');

  const badMonth = await put('/api/budgets', { month: '2026-13', amountText: '100' });
  assert.equal(badMonth.status, 400);
  assert.equal(badMonth.body.error.code, 'BAD_MONTH');

  const badMonthRead = await get('/api/budgets?month=2026-13');
  assert.equal(badMonthRead.status, 400);
  assert.equal(badMonthRead.body.error.code, 'BAD_MONTH');
});

test('预算跟着 dashboard 一起下发（网页不用多发一次请求）', async () => {
  const { data } = (await get('/api/summary/dashboard')).body;
  assert.ok(data.budget, 'dashboard 里应该有 budget');
  assert.equal(data.budget.month, data.asOf.slice(0, 7));
  assert.ok(['none', 'ok', 'watch', 'over'].includes(data.budget.status));
  assert.equal(data.budget.spentCents, data.month.expenseCents, '已花必须和本月支出是同一个数');
});
