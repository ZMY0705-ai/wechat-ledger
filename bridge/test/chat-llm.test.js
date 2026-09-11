/**
 * 陪聊 LLM 客户端单测：不发真请求，用一个假 fetch 把「模型返回了什么」变成可控输入。
 *
 * 重点三件事：
 *   · 请求体必须真的是多轮（system 在最前、历史按顺序在后面）
 *   · 空内容和 5xx 要重试，401 不重试（密钥错了重试一百次还是错，只会拖慢回复）
 *   · 思考模式必须显式关掉——不关的话每句话要多等好几秒（docs/04 §9.5）
 */
import { ChatLlm, LlmError, LlmNotConfiguredError } from '../src/chat/llm.js';

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

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    const step = script.shift();
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (step.throws) throw Object.assign(new Error(step.throws), { name: step.throwsName ?? 'TypeError' });
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.payload ?? {},
      text: async () => step.text ?? '',
    };
  };
  impl.calls = calls;
  return impl;
}

const reply = (content) => ({ status: 200, payload: { choices: [{ message: { content } }] } });
const clientWith = (script, options = {}) =>
  new ChatLlm({
    baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'test-model',
    maxRetries: 2, timeoutMs: 1000, fetchImpl: fakeFetch(script), ...options,
  });

console.log('=== 配置 ===');
await check('没有 key 时明确拒绝，而不是发一个必然失败的请求', async () => {
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: '', model: 'm' });
  eq(client.configured, false);
  try {
    await client.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err instanceof LlmNotConfiguredError, true, '错误类型');
  }
  return true;
});
await check('缺 model 时报配置错误', async () => {
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: '' });
  try {
    await client.complete({ system: 's', messages: [] });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err instanceof LlmError, true, '错误类型');
    eq(err.retryable, false, '不该重试');
  }
  return true;
});

console.log('\n=== 请求体 ===');
await check('system 在最前，历史按顺序在后', async () => {
  const fetchImpl = fakeFetch([reply('在的')]);
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl });
  await client.complete({
    system: '你是小满',
    messages: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的' },
      { role: 'user', content: '[现在：2026-09-10 周四 21:30]\n今天好累' },
    ],
  });
  eq(fetchImpl.calls[0].body.messages, [
    { role: 'system', content: '你是小满' },
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在的' },
    { role: 'user', content: '[现在：2026-09-10 周四 21:30]\n今天好累' },
  ]);
  eq(fetchImpl.calls[0].url, 'https://x/chat/completions', 'endpoint');
  eq(fetchImpl.calls[0].headers.Authorization, 'Bearer k', '鉴权头');
  return true;
});
await check('温度、上限、关思考都进请求体', async () => {
  const fetchImpl = fakeFetch([reply('嗯')]);
  const client = new ChatLlm({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash',
    temperature: 0.85, maxTokens: 800, extraBody: { thinking: { type: 'disabled' } }, fetchImpl,
  });
  await client.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  eq(fetchImpl.calls[0].body.temperature, 0.85, 'temperature');
  eq(fetchImpl.calls[0].body.max_tokens, 800, 'max_tokens');
  eq(fetchImpl.calls[0].body.thinking, { type: 'disabled' }, '思考模式');
  eq(fetchImpl.calls[0].body.response_format, undefined, '聊天不该要求 JSON');
  return true;
});
await check('json 模式才带 response_format', async () => {
  const fetchImpl = fakeFetch([reply('{"facts":[]}')]);
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl });
  await client.complete({ system: 's', messages: [{ role: 'user', content: 'u' }], json: true });
  eq(fetchImpl.calls[0].body.response_format, { type: 'json_object' });
  return true;
});
await check('空内容的消息被丢掉（有些供应商会因此 400）', async () => {
  const fetchImpl = fakeFetch([reply('好')]);
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl });
  await client.complete({
    system: '',
    messages: [{ role: 'user', content: '  ' }, { role: 'tool', content: '奇怪的角色' }],
  });
  eq(fetchImpl.calls[0].body.messages, [{ role: 'user', content: '奇怪的角色' }]);
  return true;
});

console.log('\n=== 重试 ===');
await check('空内容重试后成功', async () => {
  const client = clientWith([reply(''), reply('在的')]);
  eq(await client.complete({ system: 's', messages: [] }), '在的');
  return true;
});
await check('一次成功就不重试', async () => {
  const fetchImpl = fakeFetch([reply('在的')]);
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl });
  await client.complete({ system: 's', messages: [] });
  eq(fetchImpl.calls.length, 1, '请求次数');
  return true;
});
await check('401 不重试', async () => {
  const fetchImpl = fakeFetch([{ status: 401, text: 'unauthorized' }]);
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm', maxRetries: 2, fetchImpl });
  try {
    await client.complete({ system: 's', messages: [] });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err.retryable, false, 'retryable');
    eq(err.status, 401, 'status');
    eq(err.message.includes('unauthorized'), true, '要带上服务端的原话');
  }
  eq(fetchImpl.calls.length, 1, '请求次数');
  return true;
});
await check('500 重试到用尽次数', async () => {
  const fetchImpl = fakeFetch([
    { status: 500, text: 'boom' }, { status: 500, text: 'boom' }, { status: 500, text: 'boom' },
  ]);
  const client = new ChatLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm', maxRetries: 2, fetchImpl });
  try {
    await client.complete({ system: 's', messages: [] });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err instanceof LlmError, true, '错误类型');
  }
  eq(fetchImpl.calls.length, 3, '1 次 + 2 次重试');
  return true;
});
await check('连不上可重试，超时也算可重试', async () => {
  const client = clientWith([{ throws: 'timeout', throwsName: 'TimeoutError' }, reply('来了')]);
  eq(await client.complete({ system: 's', messages: [] }), '来了');
  return true;
});

console.log('\n=== completeJson ===');
await check('抠得出 JSON', async () => {
  const client = clientWith([reply('```json\n{"facts":["用户怕冷"],"summary":"聊了天气"}\n```')]);
  eq(await client.completeJson({ system: 's', user: 'u' }), { facts: ['用户怕冷'], summary: '聊了天气' });
  return true;
});
await check('不是 JSON 时返回 null，交给上层跳过本次整理', async () => {
  const client = clientWith([reply('我想想啊')]);
  eq(await client.completeJson({ system: 's', user: 'u' }), null);
  return true;
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;