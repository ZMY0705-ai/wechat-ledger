/**
 * 桥接主链路测试：真服务 + 真 LedgerClient + 假 LLM。
 *
 * 刻意不起 WeChat、不打真 API：微信通道已由 M-1 验证，这里要验证的是
 * 「一句话进来 → 服务端怎么判定 → 回执怎么写 → 账本变成什么样」。
 * 所以记账服务是**真的**（内存库 + 随机端口），LLM 是**假的**（可控、免费、确定性）。
 *
 * 复用 ../../server 的领域代码是有意的：桥接与服务的契约就是这个仓库里最强的那条线，
 * 用桩去测它等于自欺欺人。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { startServer } from '../../server/src/index.js';
import { LedgerClient } from '../src/ledger.js';
import { DraftStore } from '../src/handler/drafts.js';
import { createRouter } from '../src/handler/router.js';

let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok === false) throw new Error('断言为 false');
    pass++; console.log(`  OK   ${name}`);
  } catch (err) {
    fail++; console.log(`  FAIL ${name}\n        ${err.message}`);
  }
}
function eq(got, want, label = '') {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label} 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
}
function includes(haystack, needle, label = '') {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label} 回执里没有「${needle}」：\n${haystack}`);
  }
}

// ── 搭台 ────────────────────────────────────────────────────────────────
const app = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
const ledger = new LedgerClient({ baseUrl: app.url });
const draftPath = join(tmpdir(), `bridge-drafts-${process.pid}.json`);
const drafts = new DraftStore(draftPath, { ttlMinutes: 30 });

/** 假 LLM：结果可切换，用来分别测「模型说对了」「模型挂了」两条路 */
let llmResult = null;
let llmThrows = null;
const llm = {
  configured: true,
  async extract() {
    if (llmThrows) throw llmThrows;
    return llmResult;
  },
};
const llmOff = { configured: false };

const routerFor = (llmImpl) =>
  createRouter({ ledger, llm: llmImpl, drafts, config: {}, log: () => {} });

const router = routerFor(llm);
const noLlmRouter = routerFor(llmOff);

let seq = 0;
const msg = (text, senderId = 'me') => ({
  senderId, text, messageId: `m${++seq}`, attachments: [], contextToken: '',
});

const send = (text, r = router, senderId = 'me') => r.handle(msg(text, senderId));

const balance = async () => (await ledger.balance()).data;
const expenses = async () => (await ledger.listTransactions({ limit: 50 })).data.transactions;

// ── 主链路 ──────────────────────────────────────────────────────────────
console.log('=== 一句话 → 记账 ===');

await check('「午饭35」记成支出，回执用服务端渲染的那句', async () => {
  llmResult = { amount: 35, type: 'expense', category: '食品餐饮', note: '午饭', confidence: 0.95 };
  const reply = await send('午饭35');
  includes(reply, '已记', '回执');
  includes(reply, '¥35.00', '回执');
  includes(reply, '食品餐饮', '回执');

  const rows = await expenses();
  eq(rows[0].amountCents, 3500, '金额');
  eq(rows[0].type, 'expense', '类型');
  eq(rows[0].categoryPath, '食品餐饮', '分类');
  eq(rows[0].occurred_date, (await ledger.health()).data.today, '日期');
  return true;
});

await check('同一笔重发不会重复记账（幂等键 = 微信 client_id）', async () => {
  const before = (await expenses()).length;
  const same = msg('午饭35');
  await router.handle(same);
  await router.handle(same);
  eq((await expenses()).length, before + 1, '重发两次只该多一条');
  return true;
});

await check('「昨天超市买菜76.5」记到昨天，分类听服务端的', async () => {
  llmResult = { amount: 76.5, type: 'expense', category: '购物消费', note: '超市买菜', confidence: 0.9 };
  const reply = await send('昨天超市买菜76.5');
  includes(reply, '已记', '回执');
  const today = (await ledger.health()).data.today;
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const row = (await expenses()).find((t) => t.note === '超市买菜');
  eq(row.occurred_date, yesterday, '日期');
  return true;
});

await check('模型自创分类落「待分类」，服务端不认就是不让写', async () => {
  llmResult = { amount: 12, type: 'expense', category: '玄学消费', confidence: 0.99 };
  await send('随手记一笔12');
  eq((await expenses())[0].categoryPath, '待分类', '分类');
  return true;
});

await check('「发工资12000」记成收入', async () => {
  llmResult = { amount: 12000, type: 'income', category: '工资', note: '发工资', confidence: 0.95 };
  await send('发工资12000');
  const row = (await expenses())[0];
  eq(row.type, 'income', '类型');
  eq(row.categoryPath, '工资', '分类');
  return true;
});

await check('「存了2000」是转账而不是支出，两个余额一起动', async () => {
  const before = await balance();
  llmResult = { amount: 2000, type: 'transfer', category: null, note: '存了2000', confidence: 0.95 };
  // 大额储蓄转账按硬规则先确认一次（转错会同时污染两个余额）
  const preview = await send('存了2000');
  includes(preview, '转账', '预览');
  includes(preview, '确认', '预览');
  eq(await balance().then((b) => b.cashCents), before.cashCents, '确认前不该动余额');

  const reply = await send('是');
  includes(reply, '长期储蓄', '回执');

  const after = await balance();
  eq(after.cashCents, before.cashCents - 200000, '现金流');
  eq(after.savingsCents, before.savingsCents + 200000, '长期储蓄');
  eq(after.totalCents, before.totalCents, '合计不该变');
  return true;
});

// ── 硬规则与草稿 ────────────────────────────────────────────────────────
console.log('\n=== 硬规则：该问的必须问 ===');

await check('大额先出草稿，不直接记账', async () => {
  const before = (await expenses()).length;
  llmResult = { amount: 3500, type: 'expense', category: '生活必需', note: '房租', confidence: 0.95 };
  const reply = await send('前天房租3500');
  includes(reply, '确认', '回执');
  eq((await expenses()).length, before, '草稿阶段不该落库');
  includes((await drafts.pending('me')).awaiting ?? '', 'confirm', '草稿状态');
  return true;
});

await check('回「是」才落库', async () => {
  const before = (await expenses()).length;
  const reply = await send('是');
  includes(reply, '已记', '回执');
  eq((await expenses()).length, before + 1, '流水条数');
  eq(await drafts.pending('me'), null, '草稿应已清掉');
  return true;
});

await check('回「不对」取消草稿，不落库', async () => {
  const before = (await expenses()).length;
  llmResult = { amount: 3000, type: 'expense', category: '购物消费', note: '买东西', confidence: 0.95 };
  await send('昨天买东西3000');
  const reply = await send('不对');
  includes(reply, '不记了', '回执');
  eq((await expenses()).length, before, '流水条数');
  return true;
});

await check('金额缺失先追问，用户补了金额再记', async () => {
  const before = (await expenses()).length;
  llmResult = { amount: null, type: 'expense', category: '待分类', note: '买了点东西', confidence: 0.9 };
  const ask = await send('买了点东西');
  includes(ask, '花了多少', '追问');
  eq((await expenses()).length, before, '追问阶段不该落库');

  const reply = await send('35');
  includes(reply, '已记', '回执');
  const rows = await expenses();
  eq(rows.length, before + 1, '流水条数');
  eq(rows[0].amountCents, 3500, '金额');
  eq(rows[0].occurred_date, (await ledger.health()).data.today, '日期应按原话算');
  return true;
});

await check('转账要问账户，不在微信里硬记', async () => {
  const before = (await expenses()).length;
  llmResult = { amount: 2000, type: 'transfer', category: null, note: '还信用卡', confidence: 0.95 };
  const reply = await send('还信用卡2000');
  includes(reply, '转账', '回执');
  eq((await expenses()).length, before, '不该落库');
  return true;
});

// ── 确定性指令 ──────────────────────────────────────────────────────────
console.log('\n=== 确定性指令不过 LLM ===');

await check('「余额」直接报余额', async () => {
  const reply = await send('余额');
  includes(reply, '现金流', '回执');
  includes(reply, '合计', '回执');
  return true;
});

await check('「撤销」撤掉上一笔', async () => {
  const before = await expenses();
  const reply = await send('撤销');
  includes(reply, '已撤销', '回执');
  const after = await expenses();
  eq(after.length, before.length - 1, '流水条数');
  return true;
});

await check('「昨天」报昨天的账，且不动账本', async () => {
  const before = (await expenses()).length;
  const reply = await send('昨天');
  includes(reply, '昨天', '回执');
  eq((await expenses()).length, before, '流水条数');
  return true;
});

await check('「帮助」给用法', async () => {
  includes(await send('帮助'), '午饭35', '回执');
  return true;
});

await check('「你好」打招呼带今日概况', async () => {
  const reply = await send('你好');
  includes(reply, '在的', '回执');
  return true;
});

await check('账目话术不会被指令误吞：带「最近」的记账照常落库', async () => {
  const before = (await expenses()).length;
  llmResult = { amount: 35, type: 'expense', category: '购物消费', note: '买东西', confidence: 0.9 };
  await send('最近买了点东西花了35');
  eq((await expenses()).length, before + 1, '流水条数');
  return true;
});

// ── 降级 ────────────────────────────────────────────────────────────────
console.log('\n=== 降级：依赖挂了也不能让用户白说 ===');

await check('LLM 报错时退回规则解析，照样记账', async () => {
  llmResult = null;
  llmThrows = new Error('模型超时');
  const reply = await send('打车18.5');
  llmThrows = null;
  includes(reply, '已记', '回执');
  includes(reply, '出行交通', '回执');
  includes(reply, '没有用上模型', '降级提示');
  const row = (await expenses()).find((t) => t.note === '打车');
  eq(row.amountCents, 1850, '金额');
  return true;
});

await check('完全没配 LLM 也能用规则解析记账', async () => {
  const reply = await noLlmRouter.handle(msg('早饭10'));
  includes(reply, '已记', '回执');
  includes(reply, '食品餐饮', '回执');
  return true;
});

await check('记账服务连不上时明确提示，而不是含糊报错', async () => {
  const offline = new LedgerClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 800 });
  const r = createRouter({ ledger: offline, llm: llmOff, drafts, config: {}, log: () => {} });
  const reply = await r.handle(msg('午饭35'));
  includes(reply, '没在跑', '回执');
  return true;
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
app.server.close();
app.db.close();
try { rmSync(draftPath, { force: true }); } catch { /* 临时文件，删不掉也无所谓 */ }
process.exitCode = fail > 0 ? 1 : 0;
