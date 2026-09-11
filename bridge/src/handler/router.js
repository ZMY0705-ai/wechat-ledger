/**
 * 消息 → 意图 → 动作（docs/04 §4、docs/09 §4）。
 *
 * 一个 bot，两副面孔（记账 / 陪聊），所以分层的顺序就是分流本身：
 *   1. 未决草稿 —— 确认/取消/补金额，都在这一层收口（这里最优先，别让「是」被当闲聊）
 *   2. 显式指定 —— `/记 xxx` 强制记账、`/聊 xxx` 强制陪聊；闸门再准也会有你不同意的时候
 *   3. 记账指令 —— 撤销/余额/报表/帮助，不过 LLM（「你好」在陪聊开着时转陪聊）
 *   4. 陪聊指令 —— /记忆 /记住 /重说…，同样不过 LLM
 *   5. 词法闸门 —— 看不出任何金额线索的话直接当闲聊，省一次抽取调用（chat/gate.js）
 *   6. 记账链路 —— LLM 抽取 + 服务端强校验；模型还会再判一次 is_ledger，说不是账就转陪聊
 *
 * 「今天」这种日期不在这里算：一律问服务端的 /api/health（它按 Asia/Shanghai 给口径）。
 * 桥接自己算日期，就是给自己埋时区 bug。
 */
import { buildSystemPrompt } from '../llm/prompt.js';
import { LedgerError, LedgerUnavailableError } from '../ledger.js';
import { isCancel, isConfirm, matchCommand } from './commands.js';
import {
  renderBalance, renderBrief, renderDay, renderGreeting, renderHelp, renderList, renderMonth,
} from './compose.js';
import { commit, handleRecord } from './record.js';

const CATEGORY_TTL_MS = 10 * 60_000;
const TODAY_TTL_MS = 60_000;

/** 日期加减：只做 YYYY-MM-DD 的整数运算，不经过本地时区，避免跨零点漂移 */
export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function createRouter({ ledger, llm, drafts, chat = null, briefPusher = null, config = {}, log = console.log }) {
  let categoryCache = null;
  let todayCache = null;

  const deps = {
    ledger,
    llm,
    drafts,
    chat,
    log,
    confirmThresholdCents: config.confirmThresholdCents,
  };

  /** 提示词里的分类清单来自服务端——两边用同一份，才不会出现「模型说得出、落库不认」 */
  async function systemPrompt() {
    if (categoryCache && Date.now() - categoryCache.at < CATEGORY_TTL_MS) return categoryCache.prompt;
    const { data } = await ledger.categories();
    const all = data.categories ?? [];
    const prompt = buildSystemPrompt({
      // 只列一级分类：与规则解析器保持同一粒度，饼图也不会被二级分类打碎（docs/05 风险表）
      expense: all.filter((c) => c.direction === 'expense' && c.parentId === null).map((c) => c.name),
      income: all.filter((c) => c.direction === 'income').map((c) => c.name),
    });
    categoryCache = { at: Date.now(), prompt };
    return prompt;
  }

  async function today() {
    if (todayCache && Date.now() - todayCache.at < TODAY_TTL_MS) return todayCache.value;
    const { data } = await ledger.health();
    todayCache = { at: Date.now(), value: data.today };
    return data.today;
  }

  /** 补金额：用户回了个数字，把原话连同这个金额重新走一遍 */
  async function mergeAmount(draft, text, msg) {
    const { data } = await ledger.parse(text, { today: await today() });
    if (data.amountCents === null || data.amountCents <= 0) return null;
    if (!['expense', 'income', 'transfer'].includes(data.type)) return null;

    drafts.cancel(msg.senderId);
    return handleRecord({
      text: draft.raw,
      msg,
      deps: { ...deps, systemPrompt: await systemPrompt(), today: await today() },
      preset: { amount: data.amountCents / 100, type: data.type, confidence: 0.9 },
    });
  }

  async function confirmDraft(draft, msg) {
    if (draft.awaiting === 'amount') return '这笔还差个金额呢，回复数字就行，比如「35」。';
    if (!draft.parsed) {
      drafts.cancel(msg.senderId);
      return '这条草稿过期了，麻烦再说一遍。';
    }
    drafts.cancel(msg.senderId);
    return commit({
      parsed: draft.parsed,
      text: draft.raw,
      msg,
      userId: msg.senderId,
      deps: { ...deps, degraded: false },
    });
  }

  async function runCommand(intent, msg) {
    switch (intent) {
      case 'help':
        // 一个 bot 两副面孔，帮助得一次看全（嘴只有一张，指令得分得清）
        return [renderHelp(), chat?.enabled ? chat.helpSection() : null].filter(Boolean).join('\n\n');

      case 'greeting': {
        // 当天第一次打招呼给完整日报；再来一次就只报数字，别刷屏（docs/03 §5）
        if (briefPusher) {
          const { data: brief } = await ledger.brief({ kind: 'greeting' });
          if (!brief.alreadySentToday) {
            await ledger.brief({ kind: 'greeting', markSent: true });
            return renderBrief(brief, { suggestions: await briefPusher.suggestions(brief) });
          }
        }
        const [balance, day] = await Promise.all([ledger.balance(), ledger.daySummary(await today())]);
        return renderGreeting({ balance: balance.data, today: day.data });
      }

      case 'balance':
        return renderBalance((await ledger.balance()).data);

      case 'today': {
        const date = await today();
        return renderDay((await ledger.daySummary(date)).data, { label: '今天' });
      }

      case 'yesterday': {
        const date = addDays(await today(), -1);
        return renderDay((await ledger.daySummary(date)).data, { label: '昨天' });
      }

      case 'month': {
        const month = (await today()).slice(0, 7);
        return renderMonth((await ledger.monthSummary(month)).data);
      }

      case 'list':
        return renderList((await ledger.listTransactions({ limit: 8 })).data);

      case 'undo': {
        const { data, message } = await ledger.voidLast('微信撤销');
        const tx = data.transaction;
        return [
          message ?? `已撤销 #${tx.id}`,
          `  ${tx.occurred_date} ${tx.note ?? ''} ${(Math.abs(tx.amountCents) / 100).toFixed(2)} 元`,
          '',
          '恢复这笔要去网页上操作：http://127.0.0.1:8787',
        ].join('\n');
      }

      default:
        return null;
    }
  }

  return {
    /** @returns {Promise<string|null>} 回复文本；null 表示这条消息不该回 */
    async handle(msg) {
      const userId = msg.senderId;
      const text = String(msg.text ?? '').trim();
      if (!text) return null;

      try {
        const draft = drafts.pending(userId);
        if (draft) {
          if (isConfirm(text)) return await confirmDraft(draft, msg);
          if (isCancel(text)) {
            drafts.cancel(userId);
            return '好的，这笔不记了。';
          }
          if (draft.awaiting === 'amount') {
            const merged = await mergeAmount(draft, text, msg);
            if (merged !== null) return merged;
          }
          // 既不是确认也不是取消：撤销草稿，把这句话当新消息继续处理（docs/04 §4）
          drafts.cancel(userId);
        }

        // 2) 说不清的时候你说了算
        const forced = chat ? chat.splitForcePrefix(text) : { kind: null, text };
        if (forced.kind === 'chat') {
          if (!chat.enabled) return '陪聊是关着的（config/bridge.json → chat.enabled）。';
          if (!forced.text) return '想聊什么？写在 /聊 后面就行。';
          return await chat.respond({ userId, text: forced.text, attachments: msg.attachments });
        }
        if (forced.kind === 'record' && !forced.text) return '要记哪一笔？写在 /记 后面就行。';
        const body = forced.kind === 'record' ? forced.text : text;

        // 3) 记账的确定性指令（撤销/余额/本月/帮助…）；前面带个 / 也认
        const command = matchCommand(chat ? chat.stripLeadingSlash(body) : body);
        if (command) {
          // 「你好」「在吗」在陪聊开着时就是打招呼，不该甩一份报表回去
          if (command.intent === 'greeting' && chat?.enabled) {
            return await chat.respond({ userId, text: body, attachments: msg.attachments });
          }
          return await runCommand(command.intent, msg);
        }

        // 4) 陪聊自己的指令（/记忆 /记住 /重说…）——同样不过模型
        if (chat?.enabled && chat.isCommand(body)) {
          return await chat.respond({ userId, text: body, attachments: msg.attachments });
        }

        // 5) 看不出任何金额线索 → 当闲聊（省一次抽取调用）
        if (chat?.enabled && !forced.kind && !chat.looksLikeLedger(body)) {
          return await chat.respond({ userId, text: body, attachments: msg.attachments });
        }

        // 6) 记账链路：LLM 抽取 + 服务端强校验。模型在里面还会再判一次 is_ledger，
        //    说「这根本不是账」就转回陪聊（handle/record.js）
        return await handleRecord({
          text: body,
          msg,
          deps: { ...deps, systemPrompt: await systemPrompt(), today: await today() },
        });
      } catch (err) {
        if (err instanceof LedgerUnavailableError) {
          return '😴 记账服务没在跑，先启动它：\n  npm run serve';
        }
        if (err instanceof LedgerError) {
          log(`[router] 记账服务报错 ${err.code}：${err.message}`);
          return `❌ 记账服务说：${err.message}`;
        }
        log(`[router] 处理消息出错：${err.stack ?? err.message}`);
        return '😵 刚才那句我没处理成功，稍后再试一次？';
      }
    },
  };
}
