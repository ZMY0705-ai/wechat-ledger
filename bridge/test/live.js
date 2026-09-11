/**
 * 真打一次模型：验证 key / 供应商 / 提示词 / 服务端强校验整条链路。
 *
 * 只干跑：不发微信、不写账本（走 `/api/parse`，只算不落库）。
 * 配完 key 先跑这个，别等记账失败了才发现 key 是错的。
 *
 * 用法：
 *   node test/live.js                          # 默认例句
 *   node test/live.js "请老王吃饭花了两百多"     # 换一句
 */
import { loadConfig } from '../src/config.js';
import { LlmClient, parseJsonLoose } from '../src/llm/client.js';
import { LedgerClient } from '../src/ledger.js';
import {
  buildSuggestPrompt, buildSuggestUserMessage, buildSystemPrompt, buildUserMessage,
} from '../src/llm/prompt.js';

const text = process.argv[2] ?? '请老王吃饭花了两百多';
const config = loadConfig();
const llm = new LlmClient({ ...config.llm });
const ledger = new LedgerClient({ baseUrl: config.ledgerBaseUrl });

console.log(`供应商  : ${config.llm.provider} / ${config.llm.model}`);
console.log(`记账服务: ${ledger.baseUrl}`);
console.log(`输入    : ${text}`);
console.log('─'.repeat(64));

if (!llm.configured) {
  console.error(`✋ 没读到 ${config.llm.apiKeyEnv}，先把它填进 bridge/.env`);
  process.exit(1);
}

try {
  // ── ① 抽取：分类清单必须来自服务端，和线上是同一份 ─────────────────────
  const health = (await ledger.health()).data;
  const all = (await ledger.categories()).data.categories ?? [];
  const system = buildSystemPrompt({
    expense: all.filter((c) => c.direction === 'expense' && c.parentId === null).map((c) => c.name),
    income: all.filter((c) => c.direction === 'income').map((c) => c.name),
  });

  let started = Date.now();
  const raw = await llm.chat({ system, user: buildUserMessage({ text, today: health.today }) });
  console.log(`\n① 模型原始输出（${Date.now() - started}ms）`);
  console.log(raw.trim());

  // ── ② 服务端强校验：模型说了不算，服务端认了才算（docs/04 §5.2）──────────
  const extracted = parseJsonLoose(raw);
  console.log('\n② 服务端强校验（干跑，不落库）');
  const verdict = (await ledger.parse(text, { extracted, today: health.today })).data;
  console.log(
    JSON.stringify(
      {
        amountCents: verdict.amountCents,
        type: verdict.type,
        category: verdict.categoryName ?? verdict.category,
        occurredDate: verdict.occurredDate,
        confidence: verdict.confidence,
        needsConfirm: verdict.needsConfirm,
      },
      null,
      2,
    ),
  );

  // ── ③ 建议措辞：拿真实的日报数据喂给模型 ──────────────────────────────
  const brief = (await ledger.brief({ kind: 'morning' })).data;
  const facts = buildSuggestUserMessage(brief);
  console.log('\n③-a 模型实际看到的输入');
  console.log(facts);
  started = Date.now();
  const advice = await llm.chat({
    system: buildSuggestPrompt(),
    user: buildSuggestUserMessage(brief),
    json: false,
  });
  console.log(`\n③ 建议措辞（${Date.now() - started}ms）`);
  console.log(advice.trim());
  console.log('\n✅ 这条链路是通的。用手机给 bot 发一句正式记一笔吧。');
} catch (err) {
  console.error(`\n❌ 失败：${err.message}`);
  console.error('   · HTTP 401/402 → key 不对或余额不足');
  console.error('   · HTTP 404 → 模型名不对，改 config/bridge.json 的 llm.model');
  console.error('   · 连不上记账服务 → 先 npm run serve');
  process.exitCode = 1;
}