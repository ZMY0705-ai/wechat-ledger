/**
 * 记账主链路：一句话 → LLM 抽取 → 服务端强校验 → 落库或追问（docs/04 §4）。
 *
 * 三条不能破的线：
 *   · LLM 只做语言理解，金额/日期/分类校验全在服务端（docs/04 §11）
 *   · 模型不可用时降级到服务端规则解析，不能让用户白说一句话
 *   · 硬规则（金额缺失 / 大额 / 转账）压倒分数，必须问
 */
import { buildUserMessage } from '../llm/prompt.js';
import { LedgerError } from '../ledger.js';
import {
  renderAskAccount, renderAskAmount, renderAskDate, renderConfirm, renderRecorded,
} from './compose.js';

const SAVINGS_ACCOUNT = '长期储蓄';

/** 记完一笔之后，把服务端返回的原话回给用户——数字只有服务端算的才作数 */
export function buildRecordPayload(parsed, { text, msg, userId }) {
  return {
    type: parsed.type,
    amountCents: parsed.amountCents,
    category: parsed.categoryName ?? undefined,
    date: parsed.date,
    note: parsed.note ?? undefined,
    rawText: text,
    source: 'wechat',
    sourceMsgId: msg.messageId || undefined,
    // 幂等键用微信 client_id：桥接重试、网络抖动都不会重复记账（docs/04 §11）
    idemKey: msg.messageId ? `wx:${userId}:${msg.messageId}` : undefined,
    // 存钱固定走「现金流 → 长期储蓄」；其他转账在决策阶段就被拦下问账户了
    ...(parsed.type === 'transfer' && parsed.transferToSavings ? { to: SAVINGS_ACCOUNT } : {}),
  };
}

/**
 * 处理一条记账消息。
 *
 * @param {object} args
 * @param {string} args.text 用户原话
 * @param {object} args.msg 微信来信
 * @param {object} args.deps { ledger, llm, drafts, today, systemPrompt, log }
 * @param {object|null} [args.preset] 已知的抽取结果（草稿补金额时用，跳过 LLM）
 * @returns {Promise<string>} 回复文本
 */
export async function handleRecord({ text, msg, deps, preset = null }) {
  const { ledger, llm, drafts, today, systemPrompt, log = () => {} } = deps;
  const userId = msg.senderId;

  let extracted = preset;
  let degraded = false;

  if (!extracted) {
    if (llm?.configured) {
      try {
        extracted = await llm.extract({
          system: systemPrompt,
          user: buildUserMessage({ text, today }),
        });
      } catch (err) {
        // 模型不可用不是用户的问题，降级到规则解析，别让这句话白说
        degraded = true;
        log(`[llm] 抽取失败，降级到规则解析：${err.message}`);
      }
    } else {
      degraded = true;
    }
    if (extracted === null) degraded = true;
  }

  // 模型说「这根本不是一笔账」→ 转给陪聊。
  // 词法闸门（chat/gate.js）只拦得住一眼就是闲聊的话，「等了三十分钟」这种
  // 长得像账、其实是吐槽的得靠模型这句话兜住。宁可多问一句「多少钱」，也别把闲聊记成账。
  if (!preset && extracted?.is_ledger === false && deps.chat?.enabled) {
    log('[record] 模型判定不是一笔账（is_ledger=false），转给陪聊');
    return deps.chat.respond({ userId, text, attachments: msg.attachments ?? [] });
  }

  // 服务端说了算：分类校验、相对时间换算、置信度评分、硬规则都在 /api/parse 里
  const { data: parsed } = await ledger.parse(text, {
    extracted: extracted ?? null,
    today,
    confirmThresholdCents: deps.confirmThresholdCents,
  });

  return dispatch({ parsed, text, msg, userId, deps, degraded });
}

async function dispatch({ parsed, text, msg, userId, deps, degraded }) {
  const { drafts } = deps;

  if (parsed.decision === 'ask_amount') {
    drafts.create(userId, { kind: 'record', awaiting: 'amount', raw: text, parsedAt: Date.now() });
    return renderAskAmount(parsed);
  }

  if (parsed.decision === 'ask_account') {
    // 转账要问清转出/转入两个账户，微信里问不明白，直接指路网页
    return renderAskAccount(parsed);
  }

  if (parsed.decision === 'ask_date') {
    drafts.create(userId, { kind: 'record', awaiting: 'confirm', raw: text, parsed });
    return renderAskDate(parsed);
  }

  if (parsed.decision === 'confirm') {
    drafts.create(userId, { kind: 'record', awaiting: 'confirm', raw: text, parsed });
    return renderConfirm(parsed);
  }

  return commit({ parsed, text, msg, userId, deps, degraded });
}

/** 真正落库。落完把服务端的 message 原样转发——回执里的数字必须来自服务端 */
export async function commit({ parsed, text, msg, userId, deps, degraded }) {
  const { ledger } = deps;
  try {
    const { data, message } = await ledger.addTransaction(
      buildRecordPayload(parsed, { text, msg, userId }),
    );
    return renderRecorded(parsed, { message, degraded: degraded && !data?.deduplicated });
  } catch (err) {
    if (err instanceof LedgerError) {
      if (err.code === 'BAD_AMOUNT') {
        return `🤔 金额我没算明白（${parsed.amountCents ?? '空'}）。\n换个写法，比如「午饭35」。`;
      }
      if (err.code === 'CATEGORY_NOT_FOUND') {
        const candidates = err.candidates?.length ? `\n候选：${err.candidates.join('、')}` : '';
        return `❌ ${err.message}${candidates}\n我把分类改成「待分类」重记一遍？直接说「是」即可。`;
      }
      if (err.code === 'ACCOUNT_NOT_FOUND') {
        return `❌ ${err.message}\n转账的账户得先在网页上建好：http://127.0.0.1:8787`;
      }
      log(`[record] 记账失败 ${err.code}：${err.message}`);
      return `❌ 记账服务说：${err.message}`;
    }
    throw err;
  }
}
