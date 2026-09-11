/**
 * 本地试聊：不连微信、不写账本，只验证「人设 + 记忆 + 模型」这条链路。
 *
 *   cd bridge
 *   npm run say  -- "今天好累"       试一句（真调模型、真写记忆）
 *   npm run say  -- "/记忆"          看它记住了什么
 *   npm run chat -- --digest         手动整理一次长期记忆
 *   npm run chat -- --greet          看看开机问候会说成什么样（不发出去）
 *
 * 身份默认用你自己那个号（白名单里的第一个），所以试出来的记忆跟微信里是同一份。
 */
import { CHAT_MEMORY_PATH, loadConfig } from '../config.js';
import { createChatFeature } from './index.js';

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}

const SAY = argOf('--say');
const AS = argOf('--as');
const GREET_ONLY = process.argv.includes('--greet');
const DIGEST_ONLY = process.argv.includes('--digest');

const config = loadConfig();
const chat = createChatFeature({ config, memoryPath: CHAT_MEMORY_PATH });
const userId = AS || config.weixin.allowedUserIds[0] || 'local';

console.log('─'.repeat(64));
console.log('陪聊 · 本地试聊（不连微信，不记账）');
console.log('─'.repeat(64));
console.log(`身份     : ${userId}`);
console.log(`人设     : ${config.chat.persona.name}`);
console.log(
  `模型     : ${chat.llm.configured ? `${config.chat.llm.provider} / ${chat.llm.model}` : `未配置 ${config.chat.llm.apiKeyEnv}`}`,
);
console.log(`记忆     : ${CHAT_MEMORY_PATH}`);
console.log(`陪聊开关 : ${chat.enabled ? '开' : '关（config/bridge.json → chat.enabled）'}`);
console.log('');

if (SAY !== null) {
  if (!SAY.trim()) {
    console.error('用法：npm run say -- "今天好累"');
    process.exit(1);
  }
  const reply = await chat.respond({ userId, text: SAY });
  console.log(`你说：${SAY}`);
  console.log('─'.repeat(64));
  console.log(reply ?? '（没有回复）');
  console.log('─'.repeat(64));
  process.exit(0);
}

if (GREET_ONLY) {
  const text = await chat.greet(userId);
  console.log(text ? `它会说：${text}` : '（现在没法打招呼：要么没配模型，要么模型出错了）');
  process.exit(0);
}

if (DIGEST_ONLY) {
  const merged = await chat.digest(userId);
  if (!merged) {
    console.error('整理失败（模型没给出可用 JSON，或调用出错），记忆保持原样。');
    process.exit(1);
  }
  console.log('整理后的长期记忆：');
  console.log(merged.facts.length ? merged.facts.map((f) => `- ${f}`).join('\n') : '（空）');
  console.log(`\n最近聊到：${merged.summary || '（空）'}`);
  process.exit(0);
}

console.log('用法：');
console.log('  npm run say  -- "今天好累"    试一句');
console.log('  npm run chat -- --digest      整理一次长期记忆');
console.log('  npm run chat -- --greet       预览开机问候');
console.log(`  npm run chat -- --say "..." --as <发送者ID>   换个身份试（默认 ${userId}）`);