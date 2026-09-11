/**
 * 日报：措辞 + 推送（M3）。
 *
 * 两个刻意的设计：
 *
 * 1. **建议优先由 LLM 措辞，但格式永远由服务端给。**
 *    模型只把 signals 写成 2~3 句人话；它罢工就退回确定性文案（compose.renderSignal）。
 *    任何情况下都不允许模型产出新数字——它拿到的输入里只有已经算好的事实。
 *
 * 2. **先发送，再标记「今天推过了」。**
 *    如果反过来（先标记再发），一旦微信发送失败，这条日报今天就永远补不回来了。
 *    顺序反了会重复打扰，顺序对了最坏情况只是「今天推了两次」——明显更轻。
 */
import { buildSuggestPrompt, buildSuggestUserMessage } from '../llm/prompt.js';
import { renderBrief } from './compose.js';

/** 模型输出清洗：去掉可能出现的编号、项目符号、引号 */
function tidySuggestions(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/^[\s·•*\-–—\d.、)）]+/, '').replace(/^["「『]|["」』]$/g, '').trim())
    .filter((line) => line && line.length <= 80)
    .slice(0, 3);
}

export function createBriefPusher({ ledger, llm, client, config = {}, log = console.log }) {
  /** 没有 LLM、没有信号、或模型失败时，一律返回空数组 → 上层用确定性文案 */
  async function suggestions(brief) {
    if (!llm?.configured || !brief.signals?.length) return [];
    try {
      const text = await llm.chat({
        system: buildSuggestPrompt(),
        user: buildSuggestUserMessage(brief),
        json: false,
      });
      return tidySuggestions(text);
    } catch (err) {
      log(`[brief] 建议措辞失败，改用确定性文案：${err.message}`);
      return [];
    }
  }

  /** 只组装不发送——调试时看一眼就知道要发什么 */
  async function compose({ kind = 'morning', today } = {}) {
    const { data: brief } = await ledger.brief({ kind, today });
    const text = renderBrief(brief, { suggestions: await suggestions(brief) });
    return { brief, text };
  }

  /**
   * 推送日报。已经推过就不打扰（返回值里说明原因）。
   * @returns {Promise<{sent:boolean, reason?:string, text:string, brief:object}>}
   */
  async function push({ kind = 'morning', force = false, today } = {}) {
    const { data: brief } = await ledger.brief({ kind, today });
    if (brief.alreadySentToday && !force) {
      return { sent: false, reason: 'already_sent', brief, text: '' };
    }

    const text = renderBrief(brief, { suggestions: await suggestions(brief) });

    // 白名单为空（调试期）时退回到「主动给 bot 发过消息的人」
    const targets = client.allowedUserIds.length ? client.allowedUserIds : client.knownSenders;
    if (!targets.length) return { sent: false, reason: 'no_target', brief, text };

    const sentTo = [];
    const failed = [];
    for (const userId of targets) {
      try {
        await client.sendProactive(userId, text);
        sentTo.push(userId);
      } catch (err) {
        failed.push({ userId, error: err.message });
      }
    }

    // 只要有人收到了才算推过；全军覆没就留着下次重试
    if (sentTo.length) await ledger.brief({ kind, today, markSent: true });
    return { sent: sentTo.length > 0, sentTo, failed, brief, text };
  }

  return { compose, push, suggestions };
}
