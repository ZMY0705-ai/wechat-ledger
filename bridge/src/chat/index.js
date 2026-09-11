/**
 * 陪聊，装成记账桥接能直接调用的一件东西。
 *
 * 记账那边只认这四个入口（都不依赖微信，所以能单测）：
 *   isCommand(text)      这句是不是陪聊自己的指令（/记忆 /记住 …），本地就能办完
 *   looksLikeLedger(text) 这句像不像一笔账（词法快筛，见 gate.js）
 *   respond(...)         出回复：指令走本地，其余走人设 + 记忆 + 模型
 *   greet(userId)        主动打个招呼（开机问候，可选）
 */
import { matchCommand, renderHelpSection } from './commands.js';
import { createEngine } from './engine.js';
import { looksLikeLedger, splitForcePrefix, stripLeadingSlash } from './gate.js';
import { ChatLlm } from './llm.js';
import { MemoryStore } from './memory.js';

export function createChatFeature({
  config = {}, memoryPath, log = console.log, now, llm = null,
} = {}) {
  const chatConfig = config.chat ?? {};
  const enabled = chatConfig.enabled !== false;
  const chatLlm = llm ?? new ChatLlm({ ...(chatConfig.llm ?? {}) });
  const memory = new MemoryStore(memoryPath, {
    maxTurns: chatConfig.memory?.maxTurns,
    maxFacts: chatConfig.memory?.maxFacts,
    ...(now ? { now } : {}),
  });
  const engine = createEngine({
    llm: chatLlm,
    memory,
    persona: chatConfig.persona ?? {},
    config: { memory: chatConfig.memory ?? {}, llm: chatConfig.llm ?? {} },
    ...(now ? { now } : {}),
    log,
  });

  return {
    /** 关了之后：路由完全回到「只用记账」的老行为 */
    enabled,
    llm: chatLlm,
    memory,
    /** 陪聊指令（本地办完，不过模型） */
    isCommand: (text) => Boolean(matchCommand(text)),
    looksLikeLedger,
    splitForcePrefix,
    stripLeadingSlash,
    helpSection: renderHelpSection,
    respond: ({ userId, text, attachments = [] }) => engine.respond({ userId, text, attachments }),
    greet: (userId) => engine.greet(userId),
    digest: (userId) => engine.digest(userId),
    stats: (userId) => memory.stats(userId),
  };
}