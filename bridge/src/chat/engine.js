/**
 * 陪聊引擎：一句话进，一句回复出。**不碰微信**，所以能单测、也能被别的入口复用。
 *
 * 处理顺序（越靠前的越确定，越不花钱）：
 *   1. 只有图片/文件 —— 直接说看不清，别浪费一次调用
 *   2. 指令 —— /清空 /记忆 /记住 … 全在本地办完，模型没机会搞错
 *   3. 其余 —— 人设 + 长期记忆 + 最近上下文，一次调用换一句回复
 *   4. 攒够轮数，后台整理一次长期记忆（不阻塞回复）
 */
import { matchCommand, renderHelp, renderMemory, renderPersona, renderUnknownCommand } from './commands.js';
import { buildDigestUser, DIGEST_SYSTEM, normalizeDigest } from './digest.js';
import { LlmNotConfiguredError } from './llm.js';
import { buildSystemPrompt, buildTimePrefix, DEFAULT_TIME_ZONE } from './persona.js';
import { ATTACHMENT_REPLY, isAttachmentOnly, sanitizeReply } from './reply.js';

/** 整理结果把记忆清空的保护线：原来有这么多条时，不接受「空列表」 */
const WIPE_GUARD_FACTS = 3;

export function createEngine({
  llm,
  memory,
  persona = {},
  config = {},
  log = console.log,
  now = () => Date.now(),
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const memoryConfig = config.memory ?? {};

  function scheduleBackground(promise) {
    if (!promise) return;
    if (typeof config.onBackground === 'function') config.onBackground(promise);
    else promise.catch((err) => log(`[engine] 后台任务失败：${err?.message ?? err}`));
  }

  /** 时间戳只贴在最后一条用户消息上，系统提示词保持稳定前缀（persona.js 顶部） */
  function buildMessages(userId) {
    const turns = memory.history(userId, memoryConfig.maxTurns);
    const prefix = buildTimePrefix(new Date(now()), timeZone);
    return turns.map((turn, i) =>
      i === turns.length - 1 && turn.role === 'user'
        ? { role: 'user', content: `${prefix}${turn.content}` }
        : turn,
    );
  }

  async function answer(userId, userText, { append = true } = {}) {
    if (!llm?.configured) return renderNotConfigured();
    if (append) memory.append(userId, 'user', userText);

    let reply;
    try {
      reply = await llm.complete({
        system: buildSystemPrompt({ persona, profile: memory.profile(userId) }),
        messages: buildMessages(userId),
      });
    } catch (err) {
      log(`[engine] 调用模型失败：${err.message}`);
      return err instanceof LlmNotConfiguredError ? renderNotConfigured() : renderLlmFailed(err);
    }

    const cleaned = sanitizeReply(reply, { name: persona.name });
    if (!cleaned) return '……刚走神了，你再说一遍？';

    memory.append(userId, 'assistant', cleaned);
    scheduleBackground(maybeDigest(userId));
    return cleaned;
  }

  /**
   * 攒够了就问模型整理一次长期记忆。这是**额外**的一次调用，所以：
   * 走后台、不阻塞回复；失败有冷却；写回前还要过一遍安全阀。
   */
  async function maybeDigest(userId, { force = false } = {}) {
    const everyTurns = memoryConfig.digestEveryTurns ?? 12;
    const cooldownMs = (memoryConfig.digestCooldownMinutes ?? 10) * 60_000;
    const stats = memory.stats(userId);
    // force 是给 --digest 用的：手动整理一次，不看轮数和冷却
    if (!force && stats.sinceDigest < everyTurns) return null;
    if (!force && stats.digestFailedAt && now() - stats.digestFailedAt < cooldownMs) return null;

    try {
      const parsed = await llm.completeJson({
        system: DIGEST_SYSTEM,
        user: buildDigestUser({
          profile: memory.profile(userId),
          turns: memory.history(userId, memoryConfig.maxTurns),
          assistantName: persona.name ?? '对方',
        }),
      });
      const digest = normalizeDigest(parsed);
      if (!digest) {
        memory.noteDigestFailure(userId);
        log('[engine] 整理记忆：模型没给出可用 JSON，本次跳过');
        return null;
      }

      const before = memory.profile(userId);
      // 安全阀：模型把清单吐空了，而记忆本来有一堆——多半是抽风，宁可这次不更新
      if (digest.factsProvided && !digest.facts.length && before.facts.length >= WIPE_GUARD_FACTS) {
        memory.noteDigestFailure(userId);
        log(`[engine] 整理记忆：结果把已有 ${before.facts.length} 条清空了，疑似异常，本次不更新`);
        return null;
      }

      const merged = memory.mergeProfile(userId, { facts: digest.facts, summary: digest.summary });
      memory.noteDigest(userId);
      log(`[engine] 已整理长期记忆：${merged.facts.length} 条事实`);
      return merged;
    } catch (err) {
      memory.noteDigestFailure(userId);
      log(`[engine] 整理记忆失败（不影响聊天）：${err?.message ?? err}`);
      return null;
    }
  }

  async function retryLast(userId) {
    const lastUserText = memory.stats(userId).lastUserText;
    if (!lastUserText) return '还没聊过呢，说什么都行。';
    const turns = memory.history(userId);
    if (turns.at(-1)?.role === 'assistant') memory.dropLast(userId, 1);
    // append=false：这句话已经在历史里了，别再插一条重复的
    return answer(userId, lastUserText, { append: false });
  }

  async function runCommand({ intent, arg }, userId) {
    switch (intent) {
      case 'help':
        return renderHelp();
      case 'clear':
        memory.clear(userId, { keepProfile: true });
        return '好，最近这段对话我忘了（更早记住的事还留着）。想连记忆一起清就说 /重置。';
      case 'reset':
        memory.clear(userId, { keepProfile: false });
        return '全都清掉了，就当我们刚认识 🙂';
      case 'memory':
        return renderMemory(memory.profile(userId));
      case 'remember': {
        if (!arg) return '记什么？写成「/记住 他不太喜欢打电话」这样就行。';
        const fact = memory.addFact(userId, arg);
        return fact ? `记下了：${fact}` : '这句我没抓到重点，换个说法？';
      }
      case 'forget': {
        if (!arg) return '忘掉哪条？写成「/忘记 打电话」，包含这几个字的记忆都会删掉。';
        const removed = memory.forget(userId, arg);
        return removed
          ? `删掉了 ${removed} 条跟「${arg}」有关的记忆。`
          : `没找到跟「${arg}」有关的记忆。`;
      }
      case 'persona':
        return renderPersona(persona);
      case 'retry':
        return retryLast(userId);
      default:
        return renderUnknownCommand(arg);
    }
  }

  function renderNotConfigured() {
    return `我还没接上大脑：bridge/.env 里缺 ${config.llm?.apiKeyEnv ?? 'API key'}，填好重启我就活了。`;
  }

  function renderLlmFailed(err) {
    const detail = String(err?.message ?? '').split('\n')[0].slice(0, 80);
    return `刚才没连上模型（${detail}），等会儿再说一次？`;
  }

  return {
    /** @returns {Promise<string|null>} 回复文本；null 表示这条消息不该回 */
    async respond({ userId, text, attachments = [] }) {
      const key = String(userId ?? '');
      if (!key) return null;
      const raw = String(text ?? '').trim();
      if (!raw) return null;
      if (isAttachmentOnly(raw, attachments)) return ATTACHMENT_REPLY;

      const command = matchCommand(raw);
      if (command) return runCommand(command, key);

      return answer(key, raw);
    },

    /** 供「开机打个招呼」用：只说一句，不进上下文（那是主动开口，不算接话） */
    async greet(userId) {
      if (!llm?.configured) return null;
      try {
        const reply = await llm.complete({
          system: buildSystemPrompt({ persona, profile: memory.profile(userId) }),
          messages: [
            {
              role: 'user',
              content:
                `${buildTimePrefix(new Date(now()), timeZone)}` +
                '（这是你自己主动发的消息：突然想起他，打个招呼。别提「系统」「提醒」「定时」，' +
                '一两句话，可以接着上次聊过的事问一句。）',
            },
          ],
        });
        const cleaned = sanitizeReply(reply, { name: persona.name });
        if (!cleaned) return null;
        memory.append(userId, 'assistant', cleaned);
        return cleaned;
      } catch (err) {
        log(`[engine] 打招呼失败：${err.message}`);
        return null;
      }
    },

    /** 手动整理一次记忆（cli: --digest）。返回整理后的 profile，失败返回 null */
    digest: (userId) => maybeDigest(userId, { force: true }),
  };
}