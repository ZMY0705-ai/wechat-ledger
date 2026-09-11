/**
 * 分流集成测试：把 router 接上「假账本 + 假抽取模型 + 真陪聊引擎 + 假聊天模型」，
 * 验证一句话到底进了哪个抽屉，以及那条不能破的线——
 * **有金额线索的话绝不能因为「像聊天」而被丢掉**（docs/09 §4）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatFeature } from '../src/chat/index.js';
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
  if (!String(haystack).includes(needle)) throw new Error(`${label} 不含「${needle}」：${haystack}`);
}

const dir = mkdtempSync(join(tmpdir(), 'chat-router-'));
let seq = 0;

function fakeLedger(parseData) {
  const calls = { parse: 0, add: 0, brief: 0 };
  return {
    calls,
    baseUrl: 'http://stub',
    async health() { return { data: { today: '2026-09-10' } }; },
    async categories() {
      return { data: { categories: [{ id: 1, name: '食品餐饮', direction: 'expense', parentId: null }] } };
    },
    async parse() { calls.parse += 1; return { data: parseData() }; },
    async addTransaction() { calls.add += 1; return { data: { id: 1 }, message: '✅ 已记：午饭 35.00 元' }; },
    async brief() { calls.brief += 1; return { data: { alreadySentToday: false } }; },
    async balance() { return { data: { cashCents: 100000, savingsCents: 50000, totalCents: 150000 } }; },
  };
}

const recordOk = () => ({
  decision: 'record', type: 'expense', amountCents: 3500, categoryName: '食品餐饮',
  date: '2026-09-10', confidence: 0.9, note: '午饭',
});

function build({ parseData = recordOk, extracted = { is_ledger: true }, chatEnabled = true, chatReply = '在的' } = {}) {
  const ledger = fakeLedger(typeof parseData === 'function' ? parseData : () => parseData);
  const extractor = {
    configured: true,
    seen: [],
    async extract({ user }) { this.seen.push(user); return typeof extracted === 'function' ? extracted(user) : extracted; },
  };
  const chatLlm = {
    configured: true,
    model: 'fake-chat',
    calls: [],
    async complete(args) { this.calls.push(args); return typeof chatReply === 'function' ? chatReply(args) : chatReply; },
    async completeJson() { return null; },
  };
  const drafts = new DraftStore(join(dir, `d${++seq}.json`), { ttlMinutes: 30 });
  const chat = createChatFeature({
    config: {
      chat: {
        enabled: chatEnabled,
        llm: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
        persona: { name: '小满', description: '一个朋友。' },
        memory: { maxTurns: 20, digestEveryTurns: 999 },
      },
    },
    memoryPath: join(dir, `m${seq}.json`),
    llm: chatLlm,
    log: () => {},
  });
  const router = createRouter({
    ledger, llm: extractor, drafts, chat, config: { confirmThresholdCents: 20_000 }, log: () => {},
  });
  return { router, ledger, extractor, chat, chatLlm };
}

const msg = (text, attachments = []) => ({ senderId: 'u1', text, messageId: `m${++seq}`, attachments, raw: {} });

console.log('=== 分流 ===');
await check('没有金额线索 → 陪聊，账本一次都不碰', async () => {
  const { router, ledger, extractor, chatLlm } = build();
  eq(await router.handle(msg('今天好累')), '在的');
  eq(chatLlm.calls.length, 1, '陪聊模型调用');
  eq(ledger.calls.parse, 0, '不该调 /api/parse');
  eq(extractor.seen.length, 0, '不该花这一次抽取');
  return true;
});
await check('有金额 → 记账，陪聊模型一次都不碰', async () => {
  const { router, ledger, chatLlm } = build();
  const reply = await router.handle(msg('午饭35'));
  includes(reply, '已记', '回执');
  eq(ledger.calls.parse, 1, '/api/parse');
  eq(ledger.calls.add, 1, '落库');
  eq(chatLlm.calls.length, 0, '不该调陪聊模型');
  return true;
});
await check('词法像账、模型说是闲聊 → 转陪聊，且不落库', async () => {
  const { router, ledger, chatLlm } = build({ extracted: { is_ledger: false } });
  eq(await router.handle(msg('等了三十分钟')), '在的');
  eq(chatLlm.calls.length, 1, '陪聊接管');
  eq(ledger.calls.parse, 0, '不该问服务端');
  eq(ledger.calls.add, 0, '更不能落库');
  return true;
});
await check('模型说是账 → 照常记账', async () => {
  const { router, ledger, chatLlm } = build({ extracted: { is_ledger: true } });
  includes(await router.handle(msg('等了三十分钟')), '已记', '回执');
  eq(ledger.calls.parse, 1);
  eq(chatLlm.calls.length, 0);
  return true;
});
await check('is_ledger 缺席时按记账处理（老行为，不冒险）', async () => {
  const { router, ledger } = build({ extracted: { amount: 35, type: 'expense' } });
  await router.handle(msg('超市35'));
  eq(ledger.calls.parse, 1);
  return true;
});

console.log('=== 我说了算 ===');
await check('/聊 强制陪聊（哪怕带着数字）', async () => {
  const { router, ledger, chatLlm } = build();
  eq(await router.handle(msg('/聊 午饭35块钱，但我就是想吐槽')), '在的');
  eq(chatLlm.calls.length, 1);
  eq(ledger.calls.parse, 0);
  eq(chatLlm.calls[0].messages.at(-1).content.includes('午饭35块钱'), true, '前缀要剥掉');
  return true;
});
await check('/记 强制记账（哪怕看着像闲聊）', async () => {
  const { router, ledger } = build();
  await router.handle(msg('/记 今天好累'));
  eq(ledger.calls.parse, 1);
  return true;
});
await check('/聊 后面没内容时给提示', async () => {
  const { router, ledger } = build();
  includes(await router.handle(msg('/聊')), '想聊什么', '提示');
  eq(ledger.calls.parse, 0);
  return true;
});
await check('陪聊关掉时 /聊 会说清楚', async () => {
  const { router } = build({ chatEnabled: false });
  includes(await router.handle(msg('/聊 你好')), 'chat.enabled', '提示');
  return true;
});

console.log('=== 指令层 ===');
await check('/记忆 本地办完，两边模型都不调', async () => {
  const { router, ledger, extractor, chatLlm } = build();
  includes(await router.handle(msg('/记忆')), '还空着', '记忆回执');
  eq(chatLlm.calls.length, 0, '不用调模型');
  eq(extractor.seen.length, 0);
  eq(ledger.calls.parse, 0);
  return true;
});
await check('/记住 写进记忆，下次就看得见', async () => {
  const { router } = build();
  includes(await router.handle(msg('/记住 怕冷')), '记下了', '回执');
  includes(await router.handle(msg('/记忆')), '怕冷', '清单');
  return true;
});
await check('没见过的 / 指令：陪聊给提示，不丢给模型', async () => {
  const { router, chatLlm } = build();
  includes(await router.handle(msg('/唱歌')), '没有「唱歌」', '提示');
  eq(chatLlm.calls.length, 0);
  return true;
});
await check('/余额 还是记账的指令（带斜杠也认）', async () => {
  const { router, ledger, chatLlm } = build();
  const reply = await router.handle(msg('/余额'));
  eq(reply.includes('余额'), true, '记账的余额回复');
  eq(chatLlm.calls.length, 0);
  return true;
});
await check('帮助：一份回复里同时有记账和陪聊', async () => {
  const { router } = build();
  const reply = await router.handle(msg('帮助'));
  includes(reply, '午饭35', '记账部分');
  includes(reply, '陪聊', '陪聊部分');
  includes(reply, '/记忆', '陪聊指令');
  return true;
});
await check('陪聊关掉时，帮助里不该出现陪聊', async () => {
  const { router } = build({ chatEnabled: false });
  eq((await router.handle(msg('帮助'))).includes('陪聊'), false);
  return true;
});

console.log('=== 边界 ===');
await check('草稿最优先：「是」是对上一笔的回答，不是闲聊', async () => {
  const { router, ledger, chatLlm } = build({
    parseData: () => ({ decision: 'confirm', type: 'expense', amountCents: 50_000, categoryName: '食品餐饮', date: '2026-09-10', confidence: 0.9 }),
  });
  await router.handle(msg('买了个大件5000'));
  eq(ledger.calls.add, 0, '还没落库，在等确认');
  const reply = await router.handle(msg('是'));
  includes(reply, '已记', '确认后落库');
  eq(ledger.calls.add, 1, '落库一次');
  eq(chatLlm.calls.length, 0, '全程没陪聊什么事');
  return true;
});
await check('「你好」开着陪聊时是打招呼，不是日报', async () => {
  const { router, ledger, chatLlm } = build();
  eq(await router.handle(msg('你好')), '在的');
  eq(chatLlm.calls.length, 1);
  eq(ledger.calls.brief, 0, '不该推日报');
  return true;
});
await check('只有图片：直说看不清，两边都不动', async () => {
  const { router, ledger, chatLlm } = build();
  includes(await router.handle(msg('（收到图片）', ['图片'])), '只看得见文字', '提示');
  eq(chatLlm.calls.length, 0);
  eq(ledger.calls.parse, 0);
  return true;
});
await check('陪聊关掉时，「今天好累」回到老行为（进记账链路）', async () => {
  const { router, ledger, chatLlm } = build({ chatEnabled: false });
  await router.handle(msg('今天好累'));
  eq(ledger.calls.parse, 1, '还是交给服务端');
  eq(chatLlm.calls.length, 0);
  return true;
});
await check('关掉陪聊且模型说不是账 → 也不会转陪聊', async () => {
  const { router, ledger } = build({ chatEnabled: false, extracted: { is_ledger: false } });
  await router.handle(msg('超级市场 35'));
  eq(ledger.calls.parse, 1);
  return true;
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;