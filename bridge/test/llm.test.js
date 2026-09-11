/**
 * LLM 客户端单测：不发真请求，用一个假的 fetch 把「模型返回了什么」变成可控输入。
 *
 * 重点验证三件事：
 *   · 空内容要重试（DeepSeek 官方承认 JSON Output 偶尔返回空）
 *   · 401/403 不能重试（密钥错了重试一百次还是错，只会拖慢回执）
 *   · 请求体里必须显式关掉思考模式（docs/04 §5.3）
 */
import { LlmClient, LlmError, LlmNotConfiguredError, parseJsonLoose } from '../src/llm/client.js';
import { buildSystemPrompt, buildUserMessage } from '../src/llm/prompt.js';

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

/** 按脚本依次返回响应的假 fetch，并记录每次请求体 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    const step = script.shift();
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (step.throws) throw Object.assign(new Error(step.throws), { name: 'TypeError' });
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
  new LlmClient({
    baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'test-model',
    maxRetries: 2, timeoutMs: 1000, fetchImpl: fakeFetch(script), ...options,
  });

console.log('=== parseJsonLoose ===');
await check('纯 JSON', () => eq(parseJsonLoose('{"amount":35}'), { amount: 35 }));
await check('```json 围栏', () => eq(parseJsonLoose('```json\n{"amount":35}\n```'), { amount: 35 }));
await check('前后带解释也能认', () => eq(parseJsonLoose('好的，结果如下 {"amount":35} 完毕'), { amount: 35 }));
await check('空内容 -> null', () => eq(parseJsonLoose(''), null));
await check('不是 JSON -> null', () => eq(parseJsonLoose('我不知道'), null));
await check('非字符串 -> null', () => eq(parseJsonLoose(null), null));

console.log('\n=== 提示词 ===');
await check('提示词里有 json 字样（DeepSeek 的硬要求）', () => includes(buildSystemPrompt({}), 'json'));
await check('分类清单按方向分别进系统提示词，占位符不留痕', () => {
  const prompt = buildSystemPrompt({ expense: ['食品餐饮', '出行交通'], income: ['工资'] });
  includes(prompt, '支出：食品餐饮 出行交通', '支出行');
  includes(prompt, '收入：工资', '收入行');
  if (prompt.includes('%EXPENSE%') || prompt.includes('%INCOME%')) throw new Error('占位符没替换掉');
  return true;
});
await check('用户消息只带今天与这一句', () => {
  const text = buildUserMessage({ text: '午饭35', today: '2026-09-10' });
  eq(text, '今天是 2026-09-10。用户消息：「午饭35」');
  return true;
});

console.log('\n=== 调用与重试 ===');
await check('没配 key 时明确跳过，而不是发一个必然失败的请求', async () => {
  const client = new LlmClient({ baseUrl: 'https://x', apiKey: '', model: 'm' });
  eq(client.configured, false);
  try {
    await client.chat({ system: 's', user: 'u' });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err instanceof LlmNotConfiguredError, true, '错误类型');
  }
  return true;
});

await check('空内容重试后成功（DeepSeek 偶发返回空）', async () => {
  const client = clientWith([reply(''), reply('{"amount":35}')]);
  eq(await client.extract({ system: 's', user: 'u' }), { amount: 35 });
  eq(client.configured, true);
  return true;
});

await check('一次调用就成功时不重试', async () => {
  const fetchImpl = fakeFetch([reply('{"amount":35}')]);
  const client = new LlmClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl });
  await client.extract({ system: 's', user: 'u' });
  eq(fetchImpl.calls.length, 1, '请求次数');
  return true;
});

await check('401 不重试：密钥错了重试多少次都一样', async () => {
  const fetchImpl = fakeFetch([{ status: 401, text: 'unauthorized' }]);
  const client = new LlmClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm', maxRetries: 2, fetchImpl });
  try {
    await client.chat({ system: 's', user: 'u' });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err.retryable, false, 'retryable');
  }
  eq(fetchImpl.calls.length, 1, '请求次数');
  return true;
});

await check('500 会重试到用尽次数', async () => {
  const fetchImpl = fakeFetch([
    { status: 500, text: 'boom' }, { status: 500, text: 'boom' }, { status: 500, text: 'boom' },
  ]);
  const client = new LlmClient({ baseUrl: 'https://x', apiKey: 'k', model: 'm', maxRetries: 2, fetchImpl });
  try {
    await client.chat({ system: 's', user: 'u' });
    throw new Error('应该抛错');
  } catch (err) {
    eq(err instanceof LlmError, true, '错误类型');
  }
  eq(fetchImpl.calls.length, 3, '1 次 + 2 次重试');
  return true;
});

await check('请求体：json_object + 关闭思考模式 + 上限', async () => {
  const fetchImpl = fakeFetch([reply('{}')]);
  const client = new LlmClient({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-v4-flash',
    maxTokens: 500, extraBody: { thinking: { type: 'disabled' } }, fetchImpl,
  });
  await client.chat({ system: 'S', user: 'U' });

  const { body, url, headers } = fetchImpl.calls[0];
  eq(url, 'https://api.deepseek.com/chat/completions', 'endpoint');
  eq(headers.Authorization, 'Bearer k', '鉴权头');
  eq(body.response_format, { type: 'json_object' }, 'response_format');
  eq(body.thinking, { type: 'disabled' }, '思考模式必须显式关掉');
  eq(body.max_tokens, 500, 'max_tokens');
  eq(body.messages[0], { role: 'system', content: 'S' }, '系统提示词');
  return true;
});

await check('模型返回的不是 JSON 时返回 null，交给上层降级', async () => {
  const client = clientWith([reply('我猜你想记一笔')]);
  eq(await client.extract({ system: 's', user: 'u' }), null);
  return true;
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
