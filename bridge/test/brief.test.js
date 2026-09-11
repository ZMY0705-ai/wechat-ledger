/**
 * 日报推送（M3）测试：真服务 + 假微信客户端 + 假 LLM。
 *
 * 这里不打真微信、不打真模型——要验证的是「推不推、推什么、推过之后还推不推」。
 * 记账服务是真的（内存库 + 随机端口），因为日报里的每个数字都由它算出来。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { startServer } from '../../server/src/index.js';
import { LedgerClient } from '../src/ledger.js';
import { DraftStore } from '../src/handler/drafts.js';
import { createBriefPusher } from '../src/handler/brief.js';
import { renderSignal } from '../src/handler/compose.js';
import { SIGNAL_CODES } from '../../server/src/domain/signals.js';
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
    throw new Error(`${label} 里没有「${needle}」：\n${haystack}`);
  }
}
function excludes(haystack, needle, label = '') {
  if (String(haystack).includes(needle)) {
    throw new Error(`${label} 里不该出现「${needle}」：\n${haystack}`);
  }
}

const app = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
const ledger = new LedgerClient({ baseUrl: app.url });

/** 假微信客户端：记下发了什么，也能按需演一次发送失败 */
function fakeClient({ allowed = ['u1'], known = ['u1'] } = {}) {
  return {
    sent: [],
    failNext: null,
    allowedUserIds: allowed,
    knownSenders: known,
    async sendProactive(userId, text) {
      if (this.failNext) {
        const reason = this.failNext;
        this.failNext = null;
        throw new Error(reason);
      }
      this.sent.push({ userId, text });
    },
  };
}

const pusherFor = (client, llm = { configured: false }) =>
  createBriefPusher({ ledger, llm, client, log: () => {} });

const sentToday = async (date) => (await ledger.brief({ today: date })).data.alreadySentToday;

// ── 推送 ────────────────────────────────────────────────────────────────
console.log('=== 推送：什么时候推、推给谁 ===');

await check('没人给 bot 发过消息时不硬推', async () => {
  const client = fakeClient({ allowed: [], known: [] });
  const result = await pusherFor(client).push({ today: '2026-03-01' });
  eq(result.sent, false, 'sent');
  eq(result.reason, 'no_target', '原因');
  includes(result.text, '记账日报', '日报');
  eq(client.sent.length, 0, '发送次数');
  return true;
});

await check('白名单为空时退回到「主动给 bot 发过消息的人」', async () => {
  const client = fakeClient({ allowed: [], known: ['u9'] });
  const result = await pusherFor(client).push({ today: '2026-03-02' });
  eq(result.sent, true, 'sent');
  eq(result.sentTo, ['u9'], '收件人');
  eq(client.sent[0].userId, 'u9', '收件人');
  return true;
});

await check('日报带上昨日、本月、余额与建议', async () => {
  const client = fakeClient();
  const result = await pusherFor(client).push({ today: '2026-03-03' });
  const text = result.text;
  includes(text, '记账日报', '日报');
  includes(text, '本月至今', '日报');
  includes(text, '余额', '日报');
  includes(text, '现金流', '日报');
  includes(text, '储蓄', '日报');
  includes(text, '💡 建议', '日报');
  includes(text, '还没记过账', '空账本的确定性建议');
  return true;
});

await check('日报压得住长度（微信不是读长文的地方）', async () => {
  const client = fakeClient();
  const result = await pusherFor(client).push({ today: '2026-03-04' });
  const lines = result.text.split('\n');
  eq(lines.length <= 10, true, `行数 ${lines.length}`);
  return true;
});

await check('推过之后服务端认账，当天不再打扰', async () => {
  const client = fakeClient();
  const pusher = pusherFor(client);
  eq(await sentToday('2026-03-05'), false, '推之前');
  eq((await pusher.push({ today: '2026-03-05' })).sent, true, '第一次');
  eq(await sentToday('2026-03-05'), true, '推之后');

  const second = await pusher.push({ today: '2026-03-05' });
  eq(second.sent, false, '第二次 sent');
  eq(second.reason, 'already_sent', '第二次原因');
  eq(client.sent.length, 1, '总共只该发一条');
  return true;
});

await check('force 时无视「今天推过了」', async () => {
  const client = fakeClient();
  const pusher = pusherFor(client);
  await pusher.push({ today: '2026-03-06' });
  const forced = await pusher.push({ today: '2026-03-06', force: true });
  eq(forced.sent, true, 'sent');
  eq(client.sent.length, 2, '发送次数');
  return true;
});

await check('发送失败不标记「推过了」，下次还能补上', async () => {
  const client = fakeClient();
  const pusher = pusherFor(client);
  client.failNext = 'context_token 已过期';

  const failed = await pusher.push({ today: '2026-03-07' });
  eq(failed.sent, false, 'sent');
  eq(failed.failed.length, 1, '失败条数');
  includes(failed.failed[0].error, 'context_token', '失败原因');
  eq(await sentToday('2026-03-07'), false, '失败后不该标记');

  const retry = await pusher.push({ today: '2026-03-07' });
  eq(retry.sent, true, '重试 sent');
  eq(client.sent.length, 1, '最终只发成功一条');
  return true;
});

await check('多人群发：一个失败不影响其他人，且仍算推送成功', async () => {
  const client = fakeClient({ allowed: ['u1', 'u2'] });
  const pusher = pusherFor(client);
  const original = client.sendProactive.bind(client);
  client.sendProactive = async (userId, text) => {
    if (userId === 'u2') throw new Error('对方没有 context_token');
    return original(userId, text);
  };

  const result = await pusher.push({ today: '2026-03-08' });
  eq(result.sent, true, 'sent');
  eq(result.sentTo, ['u1'], '成功的人');
  eq(result.failed.length, 1, '失败的人');
  eq(await sentToday('2026-03-08'), true, '有人收到就算推过');
  return true;
});

// ── 建议措辞 ────────────────────────────────────────────────────────────
console.log('\n=== 建议：模型只负责措辞，数字不由它给 ===');

await check('模型给的建议会替换掉模板文案，并清洗编号与引号', async () => {
  const client = fakeClient();
  const llm = { configured: true, async chat() { return '1. 少点外卖\n2. 「本月先存一笔」\n'; } };
  const result = await pusherFor(client, llm).push({ today: '2026-03-09' });
  includes(result.text, '少点外卖', '日报');
  includes(result.text, '本月先存一笔', '日报');
  excludes(result.text, '1. 少点外卖', '编号');
  excludes(result.text, '还没记过账', '模板文案');
  return true;
});

await check('模型罢工时退回确定性文案，日报照样发得出去', async () => {
  const client = fakeClient();
  const llm = { configured: true, async chat() { throw new Error('503 Service Unavailable'); } };
  const result = await pusherFor(client, llm).push({ today: '2026-03-10' });
  eq(result.sent, true, 'sent');
  includes(result.text, '还没记过账', '兜底建议');
  return true;
});

await check('模型给出的超长废话会被丢掉，不是原样转发', async () => {
  const client = fakeClient();
  const long = '这是一段明显超过八十字的建议'.repeat(6);
  const llm = { configured: true, async chat() { return `少点外卖\n${long}`; } };
  const result = await pusherFor(client, llm).push({ today: '2026-03-11' });
  includes(result.text, '少点外卖', '日报');
  excludes(result.text, long, '超长行');
  return true;
});

await check('没配 LLM 时不发请求，直接用模板（省钱且不会必然失败）', async () => {
  const client = fakeClient();
  let called = 0;
  const llm = { configured: false, async chat() { called++; return ''; } };
  await pusherFor(client, llm).push({ today: '2026-03-12' });
  eq(called, 0, '调用次数');
  return true;
});

await check('服务端能产出的每条信号，桥接都有对应文案（漏一条就会被静默吞掉）', async () => {
  const missing = SIGNAL_CODES.filter((code) => !renderSignal({ code, params: {} }));
  eq(missing, [], '缺文案的信号');
  return true;
});

await check('本月花过钱但没设预算：日报告诉你这件事，而不是给个空建议', async () => {
  const app3 = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
  const ledger3 = new LedgerClient({ baseUrl: app3.url });
  const today3 = (await ledger3.health()).data.today;
  await ledger3.addTransaction({ type: 'expense', amountCents: 5700, category: '购物消费', note: '买菜', date: today3 });

  const client = fakeClient();
  const result = await createBriefPusher({ ledger: ledger3, llm: { configured: false }, client, log: () => {} })
    .push({ today: today3 });
  includes(result.text, '💡 建议', '日报');
  includes(result.text, '预算', '日报');

  app3.server.close();
  app3.db.close();
  return true;
});

// ── 打招呼顺带日报 ──────────────────────────────────────────────────────
console.log('\n=== 打招呼：当天第一次给完整日报 ===');

const app2 = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
const ledger2 = new LedgerClient({ baseUrl: app2.url });
const client2 = fakeClient();
const draftPath2 = join(tmpdir(), `bridge-brief-drafts-${process.pid}.json`);
const drafts2 = new DraftStore(draftPath2, { ttlMinutes: 30 });
const router2 = createRouter({
  ledger: ledger2,
  llm: { configured: false },
  drafts: drafts2,
  briefPusher: createBriefPusher({ ledger: ledger2, llm: { configured: false }, client: client2, log: () => {} }),
  config: {},
  log: () => {},
});
const say = (text) => router2.handle({ senderId: 'u1', text, messageId: text, attachments: [], contextToken: '' });

await check('第一次「你好」给完整日报', async () => {
  const reply = await say('你好');
  includes(reply, '记账日报', '回执');
  includes(reply, '余额', '回执');
  return true;
});

await check('第二次「你好」只报数字，不刷屏', async () => {
  const reply = await say('你好');
  excludes(reply, '记账日报', '回执');
  includes(reply, '在的', '回执');
  return true;
});

await check('没有 briefPusher 时，打招呼行为与以前一致', async () => {
  const plain = createRouter({ ledger: ledger2, llm: { configured: false }, drafts: drafts2, config: {}, log: () => {} });
  const reply = await plain.handle({ senderId: 'u2', text: '你好', messageId: 'x', attachments: [], contextToken: '' });
  includes(reply, '在的', '回执');
  return true;
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
app.server.close();
app.db.close();
app2.server.close();
app2.db.close();
try { rmSync(draftPath2, { force: true }); } catch { /* 临时文件，删不掉也无所谓 */ }
process.exitCode = fail > 0 ? 1 : 0;