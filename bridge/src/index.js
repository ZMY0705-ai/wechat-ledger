/**
 * 记账桥接入口（M2：微信说一句 → LLM 抽取 → 服务端校验 → 落库 → 回执）。
 *
 * 这个进程只做两件事：收发微信消息，以及把消息翻译成记账服务的一次 HTTP 调用。
 * **它不碰数据库**，也不做任何算术——账本的正确性只由记账服务负责。
 *
 * 用 `node src/index.js --echo` 可以回到 M-1 的回显模式，
 * 用来单独验证微信通道（不写账本），排障时很有用。
 *
 * `node src/index.js --brief` 只把今天的日报打印到终端（不发微信、不标记已推），
 * 想看看「今晚会收到什么」而不打扰自己时用它。
 */
import { CHAT_MEMORY_PATH, CONTEXT_STORE_PATH, DRAFT_STORE_PATH, loadConfig, requireWeixinToken } from './config.js';
import { createChatFeature } from './chat/index.js';
import { WeixinClient } from './weixin/client.js';
import { LedgerClient } from './ledger.js';
import { LlmClient } from './llm/client.js';
import { DraftStore } from './handler/drafts.js';
import { createRouter } from './handler/router.js';
import { createBriefPusher } from './handler/brief.js';

const ECHO = process.argv.includes('--echo');
/** 只打印今天的日报，不发微信、不写数据库——排查格式时用 */
const BRIEF_ONLY = process.argv.includes('--brief');
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });

const config = loadConfig();
const token = requireWeixinToken(config);

const client = new WeixinClient({
  token,
  baseUrl: config.weixin.baseUrl,
  contextStorePath: CONTEXT_STORE_PATH,
  allowedUserIds: config.weixin.allowedUserIds,
});

const ledger = new LedgerClient({ baseUrl: config.ledgerBaseUrl });
const llm = new LlmClient({ ...config.llm });
const drafts = new DraftStore(DRAFT_STORE_PATH, { ttlMinutes: config.draftTtlMinutes ?? 30 });
const briefPusher = createBriefPusher({ ledger, llm, client, config });
// 陪聊和记账共用这一个进程、这一个 token——iLink 一个微信号只挂得下一个 bot（docs/09 §2）
const chat = createChatFeature({ config, memoryPath: CHAT_MEMORY_PATH });
const router = createRouter({ ledger, llm, drafts, chat, briefPusher, config });

if (BRIEF_ONLY) {
  try {
    console.log((await briefPusher.compose()).text);
    process.exit(0);
  } catch (err) {
    console.error(`读日报失败：${err.message}`);
    process.exit(1);
  }
}

console.log('─'.repeat(64));
console.log(ECHO ? '记账桥接 · M-1 连通性验证（回显模式，不写账本）' : '记账桥接 · M2（微信说一句就记账）');
console.log('─'.repeat(64));
console.log(`微信     : ${config.weixin.baseUrl}`);
console.log(`Token    : ${token.slice(0, 6)}…${token.slice(-4)}`);
console.log(
  `白名单   : ${client.allowedUserIds.length ? client.allowedUserIds.join(', ') : '（未设置，任何人都能记账）'}`,
);
console.log(`记账服务 : ${ledger.baseUrl}`);
console.log(
  `LLM      : ${llm.configured ? `${config.llm.provider} / ${llm.model}` : `未配置 ${config.llm.apiKeyEnv}`}`,
);
console.log(
  `陪聊     : ${config.chat.enabled
    ? `${config.chat.persona.name}${chat.llm.configured ? `（${chat.llm.model}）` : '（没配 key，只能记账）'}`
    : '已关闭（config/bridge.json → chat.enabled）'}`,
);
console.log(`草稿     : ${DRAFT_STORE_PATH}`);
console.log(`记忆     : ${CHAT_MEMORY_PATH}`);
console.log('');

/**
 * 等服务上线。开机时两个进程是一起被拉起来的，谁先谁后说不准：
 * 记账服务要开 SQLite、要绑端口，通常比桥接慢几秒。
 * 不等待的话，开机那天就会因为「抢跑」白白丢掉一次日报。
 */
async function waitForLedger({ attempts = 6, delayMs = 1500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return (await ledger.health()).data;
    } catch (err) {
      if (i === attempts) return { error: err.message };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { error: '未知错误' };
}

/** 启动自检：两个依赖（记账服务、LLM）都不致命，但要如实报出来，别等用户记账失败才发现 */
async function preflight() {
  const health = await waitForLedger();
  if (health.today) {
    console.log(`✅ 记账服务在线（服务端今天：${health.today}）`);
  } else {
    console.warn(`⚠️  ${health.error}`);
    console.warn('   记账会失败，先把服务起起来：npm run serve');
  }

  if (llm.configured) {
    console.log(`✅ LLM 已配置：${config.llm.provider} / ${llm.model}`);
  } else {
    console.warn(`⚠️  没读到 ${config.llm.apiKeyEnv}，本轮只用服务端规则解析。`);
    console.warn('   规则解析对「午饭35」「昨天超市买菜76.5」这类说法够用，口语化的会差一些。');
  }
  if (config.chat.enabled && !chat.llm.configured) {
    console.warn(`⚠️  陪聊没读到 ${config.chat.llm.apiKeyEnv}：这个号现在只会记账，聊天会回「我还没接上大脑」。`);
  }
  console.log('');
  console.log(ECHO
    ? '用手机微信给这个号发任意一句话，看能不能收到回执。按 Ctrl+C 退出。'
    : '用手机微信给这个号发一句「午饭35」试试，记账、闲聊都行。按 Ctrl+C 退出。');
  console.log('─'.repeat(64));
}

/**
 * 开机跟他说句话（可选，默认关）。
 * 日报是「账」，这个是「人」；只在确实有一阵子没聊过时才发，免得反复重启就反复骚扰。
 */
async function greetOnStart() {
  if (ECHO || !config.chat.enabled || !config.chat.greetOnStart) return;
  if (!chat.llm.configured) return;

  const idleMs = Math.max(1, config.chat.greetIdleHours ?? 8) * 3_600_000;
  const targets = client.knownSenders.filter((id) => client.allows(id));
  if (!targets.length) return;

  for (const userId of targets) {
    const stats = chat.stats(userId);
    if (stats.turns && Date.now() - stats.lastActiveAt < idleMs) continue;
    const text = await chat.greet(userId);
    if (!text) continue;
    try {
      await client.sendProactive(userId, text);
      console.log(`✅ 已跟 ${userId} 打了声招呼`);
      for (const line of text.split('\n')) console.log(`   ${line}`);
    } catch (err) {
      console.warn(`⚠️  打招呼失败：${err.message}`);
    }
  }
}

async function onMessage(msg) {
  if (ECHO) {
    const reply = [
      '✅ 桥接已连通（M-1 回显，没有写账本）',
      `收到：${msg.text}`,
      `时间：${now()}`,
      '',
      '你的发送者 ID 是：',
      msg.senderId,
    ].join('\n');
    await client.reply(msg.senderId, reply);
    console.log(`[${now()}] 已回复：是`);
    return;
  }

  const started = Date.now();
  const reply = await router.handle(msg);
  if (!reply) return;

  await client.reply(msg.senderId, reply);
  const cost = Date.now() - started;
  console.log(`[${now()}] ${msg.senderId}`);
  console.log(`  ← ${msg.text}`);
  for (const line of reply.split('\n')) console.log(`  → ${line}`);
  console.log(`  (${cost}ms)`);
}

client.start(
  async (msg) => {
    if (!ECHO) {
      console.log(`\n[${now()}] 收到消息：${msg.senderId}${msg.attachments.length ? `（${msg.attachments.join('、')}）` : ''}`);
    }
    try {
      await onMessage(msg);
    } catch (err) {
      console.error(`[${now()}] 处理消息失败：`, err);
    }
  },
  () => {
    console.error('微信 token 失效了，跑 `npm run login` 重新扫码。');
    process.exitCode = 1;
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在停止桥接…');
    client.stop().finally(() => process.exit(0));
  });
}

await preflight();

// ── 开机推日报 ──────────────────────────────────────────────────────────
// 电脑不是 24 小时开着，用「桥接启动」当触发比定时 cron 可靠：定时任务在关机时
// 只会白白错过，而它保证了「开机后一定会看到今天的账」。
// report_log 保证一天只推一次，所以反复重启也不会重复打扰。
if (!ECHO && config.pushBriefOnStart !== false) {
  // 开机是一次性事件：这一刻没推出去，当天就没了。
  // 「网络还没起来」「context_token 恰好过期」都是会自愈的，所以给它几分钟重试。
  const attempts = 6;
  const retryDelayMs = 60_000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result;
    try {
      result = await briefPusher.push();
    } catch (err) {
      result = { sent: false, reason: 'error', error: err.message };
    }

    if (result.sent) {
      console.log(`✅ 已推送今日日报 → ${result.sentTo.join(', ')}`);
      for (const line of result.text.split('\n')) console.log(`   ${line}`);
    } else if (result.reason === 'already_sent') {
      console.log('ℹ️  今天已经推过日报了，不重复打扰。');
    } else if (result.reason === 'no_target') {
      console.log('ℹ️  还没有可推送的对象——先用手机给 bot 发一条消息。');
    } else if (result.reason === 'error') {
      console.warn(`⚠️  日报推送失败：${result.error}`);
    }
    for (const failure of result.failed ?? []) {
      console.warn(`⚠️  推送给 ${failure.userId} 失败：${failure.error}`);
    }

    // 只有「该推但没推成」才重试；「已经推过」「没人可推」都是一次性结论
    const retryable = !result.sent && result.reason !== 'already_sent' && result.reason !== 'no_target';
    if (!retryable) break;

    if (attempt === attempts) {
      console.warn(`⚠️  日报重试 ${attempts} 次仍未发出，今天先这样（不影响记账）。`);
      break;
    }
    console.log(`   ${retryDelayMs / 1000} 秒后重试…`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

// ── 日报看门狗：管「电脑只是休眠了一下」这种情况 ────────────────────────────
// 休眠唤醒时进程还活着，不会走上面的启动推送；而定时器在恢复后会立刻补跑，
// 所以这里每隔一段时间问一句「今天推过没」，没推过就补上。
// 凌晨不推（人不在电脑前，推了也没用），去重仍然由服务端 report_log 负责。
if (!ECHO && config.pushBriefOnStart !== false) {
  const checkIntervalMs = Math.max(1, config.briefCheckMinutes ?? 15) * 60_000;
  const earliestHour = 6;
  const timer = setInterval(async () => {
    if (new Date().getHours() < earliestHour) return;
    try {
      const result = await briefPusher.push();
      if (result.sent) console.log(`[${now()}] ✅ 补推今日日报 → ${result.sentTo.join(', ')}`);
    } catch (err) {
      // 看门狗只负责补，不负责报错——记账服务没起来时每 15 分钟刷一行日志太吵
      if (err.name !== 'LedgerUnavailableError') console.warn(`[${now()}] ⚠️  日报补推失败：${err.message}`);
    }
  }, checkIntervalMs);
  timer.unref?.();
}
await greetOnStart();
console.log('');
