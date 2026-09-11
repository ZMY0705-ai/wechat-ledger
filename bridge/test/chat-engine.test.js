/**
 * 引擎单测：不碰微信、不碰真模型，用假的 LLM 把「模型说了什么」变成可控输入。
 *
 * 覆盖的是那几条设计线：
 *   · 指令不过模型（省钱，也不会「回得很得体但什么都没做」）
 *   · 时间戳只贴最后一条用户消息，系统提示词保持稳定前缀
 *   · 模型挂了要有话说，而且不能把对话记成「我答过了」
 *   · 长期记忆的整理走后台、失败有冷却、写回前有安全阀
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/chat/engine.js';
import { LlmError, LlmNotConfiguredError } from '../src/chat/llm.js';
import { MemoryStore } from '../src/chat/memory.js';
import { ATTACHMENT_REPLY } from '../src/chat/reply.js';

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
function ok(cond, label = '') {
  if (!cond) throw new Error(`断言为 false ${label}`);
}
function includes(haystack, needle, label = '') {
  if (!String(haystack).includes(needle)) throw new Error(`${label} 不含「${needle}」：${haystack}`);
}

const dir = mkdtempSync(join(tmpdir(), 'chat-engine-'));
let fileSeq = 0;
let clock = Date.parse('2026-09-10T13:30:00Z');
const now = () => clock;

/** 假 LLM：记录被问了什么，回答由测试指定 */
function fakeLlm({ reply = '在的', jsonReply = null, jsonFail = null, jsonGate = null, fail = null, configured = true } = {}) {
  return {
    configured,
    calls: [],
    jsonCalls: [],
    async complete(args) {
      this.calls.push(args);
      if (fail) throw fail;
      return typeof reply === 'function' ? reply(args) : reply;
    },
    async completeJson(args) {
      this.jsonCalls.push(args);
      if (jsonGate) await jsonGate;
      if (jsonFail) throw jsonFail;
      return jsonReply;
    },
  };
}

const PERSONA = { name: '小满', description: '一个朋友。', style: ['短句'] };

function build({ llm = fakeLlm(), memory: memoryOpts = {}, memoryConfig = {}, config = {}, persona = PERSONA } = {}) {
  const memory = new MemoryStore(join(dir, `m${++fileSeq}.json`), { now, ...memoryOpts });
  const pending = [];
  const logs = [];
  const engine = createEngine({
    llm,
    memory,
    persona,
    now,
    log: (m) => logs.push(String(m)),
    config: {
      memory: { maxTurns: 20, digestEveryTurns: 12, maxFacts: 40, digestCooldownMinutes: 10, ...memoryConfig },
      llm: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      onBackground: (p) => pending.push(p),
      ...config,
    },
  });
  return { engine, memory, llm, pending, logs, settle: () => Promise.all(pending.splice(0)) };
}

console.log('=== 不该回的消息 ===');
await check('空文本不回，也不调模型', async () => {
  const { engine, llm } = build();
  eq(await engine.respond({ userId: 'u1', text: '   ' }), null);
  eq(llm.calls.length, 0);
  return true;
});
await check('没有 userId 不回', async () => {
  const { engine } = build();
  eq(await engine.respond({ userId: '', text: '在吗' }), null);
  return true;
});
await check('只有图片：直说看不清，不浪费一次调用', async () => {
  const { engine, llm, memory } = build();
  eq(await engine.respond({ userId: 'u1', text: '（收到图片）', attachments: ['图片'] }), ATTACHMENT_REPLY);
  eq(llm.calls.length, 0);
  eq(memory.history('u1').length, 0, '不该写进上下文');
  return true;
});
await check('图片带文字时照常聊', async () => {
  const { engine, llm } = build();
  await engine.respond({ userId: 'u1', text: '（收到图片）你看这个', attachments: ['图片'] });
  eq(llm.calls.length, 1);
  return true;
});

console.log('\n=== 指令不过模型 ===');
await check('/帮助', async () => {
  const { engine, llm } = build();
  const reply = await engine.respond({ userId: 'u1', text: '/帮助' });
  includes(reply, '/记忆', '帮助');
  includes(reply, '/重置', '帮助');
  eq(llm.calls.length, 0);
  return true;
});
await check('/记住 → /记忆 → /忘记 全链路', async () => {
  const { engine, memory } = build();
  includes(await engine.respond({ userId: 'u1', text: '/记住 他不太喜欢打电话' }), '记下了', '记住回执');
  eq(memory.profile('u1').facts, ['他不太喜欢打电话']);
  includes(await engine.respond({ userId: 'u1', text: '/记忆' }), '他不太喜欢打电话', '记忆清单');
  includes(await engine.respond({ userId: 'u1', text: '/忘记 打电话' }), '删掉了 1 条', '忘记回执');
  eq(memory.profile('u1').facts, []);
  includes(await engine.respond({ userId: 'u1', text: '/记忆' }), '还空着', '清空后的记忆');
  return true;
});
await check('/记住 不带内容会追问写法', async () => {
  const { engine, memory } = build();
  includes(await engine.respond({ userId: 'u1', text: '/记住' }), '/记住', '提示');
  eq(memory.profile('u1').facts, []);
  return true;
});
await check('/清空 留记忆，/重置 连记忆一起清', async () => {
  const { engine, memory } = build();
  await engine.respond({ userId: 'u1', text: '/记住 怕冷' });
  await engine.respond({ userId: 'u1', text: '在吗' });
  await engine.respond({ userId: 'u1', text: '/清空' });
  eq(memory.history('u1').length, 0, '对话清掉');
  eq(memory.profile('u1').facts, ['怕冷'], '记忆留着');
  await engine.respond({ userId: 'u1', text: '/重置' });
  eq(memory.profile('u1').facts, [], '记忆也清掉');
  return true;
});
await check('「你是谁」不带斜杠也认', async () => {
  const { engine, llm } = build();
  includes(await engine.respond({ userId: 'u1', text: '你是谁？' }), '小满', '人设');
  eq(llm.calls.length, 0);
  return true;
});
await check('没见过的指令给提示，别装没看见', async () => {
  const { engine, llm } = build();
  includes(await engine.respond({ userId: 'u1', text: '/唱歌' }), '没有「唱歌」', '提示');
  eq(llm.calls.length, 0);
  return true;
});
await check('「重来一遍」这种日常话不该被当指令吃掉', async () => {
  const { engine, llm } = build();
  await engine.respond({ userId: 'u1', text: '重来一次吧' });
  eq(llm.calls.length, 1, '应该走模型');
  return true;
});

console.log('\n=== 普通聊天 ===');
await check('一次调用，system 是人设，最后一条带时间戳', async () => {
  const { engine, llm } = build();
  eq(await engine.respond({ userId: 'u1', text: '今天好累' }), '在的');
  eq(llm.calls.length, 1, '调用次数');
  const { system, messages } = llm.calls[0];
  includes(system, '小满', 'system');
  includes(system, '目前还没有', 'system 里带「还没记忆」');
  eq(messages.length, 1);
  eq(messages[0].role, 'user');
  includes(messages[0].content, '[现在：2026-09-10 周四 21:30]', '时间戳');
  includes(messages[0].content, '今天好累');
  return true;
});
await check('上下文按顺序带上历史，时间戳只贴最后一条', async () => {
  const { engine, llm } = build();
  await engine.respond({ userId: 'u1', text: '在吗' });
  await engine.respond({ userId: 'u1', text: '今天好累' });
  const { messages } = llm.calls[1];
  eq(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  eq(messages[0].content, '在吗', '旧消息不带时间戳');
  eq(messages[1].content, '在的', '助手回复原样');
  includes(messages[2].content, '[现在：');
  includes(messages[2].content, '今天好累');
  return true;
});
await check('回复会剥掉 markdown', async () => {
  const { engine } = build({ llm: fakeLlm({ reply: '**真的**很累吧\n- 早点睡\n- 别硬撑' }) });
  eq(await engine.respond({ userId: 'u1', text: '好累' }), '真的很累吧\n早点睡\n别硬撑');
  return true;
});
await check('模型自报家门的前缀会被摘掉', async () => {
  const { engine } = build({ llm: fakeLlm({ reply: '小满：怎么了' }) });
  eq(await engine.respond({ userId: 'u1', text: '在吗' }), '怎么了');
  return true;
});
await check('长期记忆会进 system', async () => {
  const { engine, memory, llm } = build();
  memory.mergeProfile('u1', { facts: ['用户在做记账项目'], summary: '聊了加班' });
  await engine.respond({ userId: 'u1', text: '在吗' });
  includes(llm.calls[0].system, '用户在做记账项目', 'system');
  includes(llm.calls[0].system, '聊了加班', 'system');
  return true;
});
await check('回复进历史，供下一轮接话', async () => {
  const { engine, memory } = build();
  await engine.respond({ userId: 'u1', text: '今天好累' });
  eq(memory.history('u1').map((t) => [t.role, t.content]), [['user', '今天好累'], ['assistant', '在的']]);
  return true;
});

console.log('\n=== 模型不给力的时候 ===');
await check('没配 key：说清楚缺什么，不写历史', async () => {
  const { engine, memory } = build({ llm: fakeLlm({ configured: false }) });
  includes(await engine.respond({ userId: 'u1', text: '在吗' }), 'DEEPSEEK_API_KEY', '提示');
  eq(memory.history('u1').length, 0, '不该写历史');
  return true;
});
await check('调用失败：有话说，且不会假装答过', async () => {
  const { engine, memory } = build({ llm: fakeLlm({ fail: new LlmError('LLM 返回 HTTP 500', { status: 500 }) }) });
  includes(await engine.respond({ userId: 'u1', text: '在吗' }), '没连上模型', '提示');
  eq(memory.history('u1').map((t) => t.role), ['user'], '只留用户那句，不写助手');
  return true;
});
await check('没配上 key 的报错也走同一条提示', async () => {
  const { engine } = build({ llm: fakeLlm({ fail: new LlmNotConfiguredError('DEEPSEEK_API_KEY') }) });
  includes(await engine.respond({ userId: 'u1', text: '在吗' }), 'DEEPSEEK_API_KEY', '提示');
  return true;
});
await check('模型回了空白：给一句兜底，不留空的助手消息', async () => {
  const { engine, memory } = build({ llm: fakeLlm({ reply: '   ' }) });
  includes(await engine.respond({ userId: 'u1', text: '在吗' }), '走神', '兜底');
  eq(memory.history('u1').map((t) => t.role), ['user']);
  return true;
});
await check('/重说：撤掉上一句回答重问，不重复插用户消息', async () => {
  const { engine, memory, llm } = build({ llm: fakeLlm({ reply: (args) => `第${args.messages.length}版回答` }) });
  await engine.respond({ userId: 'u1', text: '今天好累' });
  const again = await engine.respond({ userId: 'u1', text: '/重说' });
  ok(again.startsWith('第'), '重说过后的回复');
  eq(memory.history('u1').map((t) => t.role), ['user', 'assistant'], '不多不少两条');
  eq(llm.calls.length, 2, '又调了一次模型');
  return true;
});
await check('/重说：还没聊过时给提示', async () => {
  const { engine, llm } = build();
  includes(await engine.respond({ userId: 'u1', text: '/重说' }), '还没聊过', '提示');
  eq(llm.calls.length, 0);
  return true;
});

console.log('\n=== 长期记忆整理 ===');
await check('攒够轮数才整理，且不阻塞回复', async () => {
  // 用一个「卡住不返回」的整理请求，证明回复根本没等它
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const { engine, memory, llm, settle } = build({
    memoryConfig: { digestEveryTurns: 2 },
    llm: fakeLlm({ jsonReply: { facts: ['用户在做记账项目'], summary: '聊了加班' }, jsonGate: gate }),
  });
  await engine.respond({ userId: 'u1', text: '在吗' });
  eq(llm.jsonCalls.length, 0, '第一轮还不该整理');
  const reply = await engine.respond({ userId: 'u1', text: '今天好累' });
  eq(reply, '在的', '回复不被整理拖住');
  eq(llm.jsonCalls.length, 1, '后台请求已经发出去了');
  eq(memory.profile('u1'), { facts: [], summary: '' }, '这一步还没整理完');
  releaseGate();
  await settle();
  eq(memory.profile('u1'), { facts: ['用户在做记账项目'], summary: '聊了加班' });
  eq(memory.stats('u1').sinceDigest, 0, '整理完计数归零');
  includes(llm.jsonCalls[0].user, '用户：在吗', '整理时带上对话原文');
  return true;
});
await check('整理结果把记忆清空时，拒绝写入并记一次失败', async () => {
  const { engine, memory, settle } = build({
    memoryConfig: { digestEveryTurns: 1 },
    llm: fakeLlm({ jsonReply: { facts: [], summary: '换个话题' } }),
  });
  memory.mergeProfile('u1', { facts: ['甲', '乙', '丙'], summary: '' });
  await engine.respond({ userId: 'u1', text: '在吗' });
  await settle();
  eq(memory.profile('u1').facts, ['甲', '乙', '丙'], '记忆必须原样保留');
  eq(memory.stats('u1').sinceDigest, 1, '计数不清零，下次再试');
  ok(memory.stats('u1').digestFailedAt > 0, '记下失败时间');
  return true;
});
await check('整理失败的冷却期内不重复烧钱', async () => {
  const { engine, llm, settle } = build({
    memoryConfig: { digestEveryTurns: 1, digestCooldownMinutes: 10 },
    llm: fakeLlm({ jsonFail: new LlmError('LLM 返回 HTTP 500', { status: 500 }) }),
  });
  await engine.respond({ userId: 'u1', text: '在吗' });
  await settle();
  eq(llm.jsonCalls.length, 1, '第一次尝试');
  await engine.respond({ userId: 'u1', text: '在吗' });
  await settle();
  eq(llm.jsonCalls.length, 1, '冷却期内不再试');

  clock += 11 * 60_000;
  await engine.respond({ userId: 'u1', text: '在吗' });
  await settle();
  eq(llm.jsonCalls.length, 2, '过了冷却再试一次');
  clock = Date.parse('2026-09-10T13:30:00Z');
  return true;
});
await check('整理返回的不是 JSON：跳过，不影响聊天', async () => {
  const { engine, memory, llm, settle } = build({
    memoryConfig: { digestEveryTurns: 1 },
    llm: fakeLlm({ jsonReply: null }),
  });
  await engine.respond({ userId: 'u1', text: '在吗' });
  await settle();
  eq(llm.jsonCalls.length, 1);
  eq(memory.profile('u1'), { facts: [], summary: '' });
  eq(memory.stats('u1').sinceDigest, 1, '留着下次再整理');
  return true;
});

console.log('\n=== 主动打招呼 ===');
await check('打招呼会带上时间与「别提系统」的交代，并记进历史', async () => {
  const { engine, memory, llm } = build();
  const text = await engine.greet('u1');
  eq(text, '在的');
  includes(llm.calls[0].messages[0].content, '[现在：', '时间');
  includes(llm.calls[0].messages[0].content, '别提', '交代');
  eq(memory.history('u1').map((t) => t.role), ['assistant']);
  return true;
});
await check('没配模型时不硬打招呼', async () => {
  const { engine, llm } = build({ llm: fakeLlm({ configured: false }) });
  eq(await engine.greet('u1'), null);
  eq(llm.calls.length, 0);
  return true;
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;