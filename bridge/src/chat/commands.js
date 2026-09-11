/**
 * 确定性指令：/清空 /重置 /记忆 /记住 /忘记 /人设 /重说 /帮助。
 *
 * 和记账那边同一个思路——**这些不经过模型**：既省钱，又不会出现
 * 「说好的清空记忆，模型却答得很得体但什么都没清」这种事故。
 *
 * 匹配原则同样是「宁可漏判，不可误判」：无斜杠的别名只保留几句
 * 意思不会有歧义的整句（「你是谁」），其余一律要求带 `/`，
 * 免得把「重来一遍」这种日常口语当指令吃掉。
 */

const SLASH_COMMANDS = {
  help: ['帮助', 'help', 'h', '?', '？', '指令', '说明'],
  clear: ['清空', '清空对话', 'clear'],
  reset: ['重置', '清空全部', '清空记忆', 'reset', '忘掉一切'],
  memory: ['记忆', '记忆本', '记住的', 'memory'],
  remember: ['记住', '记一下', 'remember'],
  forget: ['忘记', '忘了', 'forget'],
  persona: ['人设', '你是谁', 'persona'],
  retry: ['重说', '重来', '重来一遍', '重新说', 'regenerate'],
};

/** 不带斜杠也认的整句（必须整句相等） */
const BARE_COMMANDS = {
  help: ['帮助', '指令', '使用说明'],
  reset: ['清空记忆', '忘记一切', '忘掉一切'],
  memory: ['你记得我什么', '你记得什么', '你都记得我什么'],
  persona: ['你是谁', '你的人设'],
  retry: ['重说', '重来一遍'],
};

/** 掐掉首尾空白与标点，只留正文 */
function clean(text) {
  return String(text ?? '')
    .trim()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s，,。.！!？?~～、；;：:]+|[\s，,。.！!？?~～、；;：:]+$/g, '');
}

/**
 * 匹配指令。
 * @returns {{intent: string, arg: string}|null}
 */
export function matchCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  if (raw.startsWith('/')) {
    const matched = /^\/\s*([^\s]+)\s*([\s\S]*)$/.exec(raw);
    if (!matched) return null;
    const word = matched[1].toLowerCase();
    const arg = matched[2].trim();
    for (const [intent, words] of Object.entries(SLASH_COMMANDS)) {
      if (words.includes(word)) return { intent, arg };
    }
    return { intent: 'unknown', arg: matched[1] };
  }

  const bare = clean(raw).toLowerCase();
  for (const [intent, words] of Object.entries(BARE_COMMANDS)) {
    if (words.includes(bare)) return { intent, arg: '' };
  }
  return null;
}

export function renderHelp() {
  return [
    '我就是陪你聊天的，想说什么说什么 🙂',
    '',
    '几个开关要带斜杠：',
    '/清空      忘掉最近这段对话，长期记忆还留着',
    '/重置      连长期记忆一起清掉，从头来过',
    '/记忆      看看我现在记得你什么',
    '/记住 xxx  让我专门记一条',
    '/忘记 xxx  删掉记错了的那条',
    '/人设      看看我是个什么角色',
    '/重说      上一句答得不好，换个说法再来',
  ].join('\n');
}

export function renderMemory(profile = {}) {
  const facts = Array.isArray(profile.facts) ? profile.facts.filter(Boolean) : [];
  const summary = String(profile.summary ?? '').trim();
  if (!facts.length && !summary) {
    return '我这边还空着——聊着聊着就会记住一些，也可以直接说「/记住 xxx」。';
  }
  const lines = ['我记得你这些：'];
  facts.forEach((fact, i) => lines.push(`${i + 1}. ${fact}`));
  if (summary) lines.push('', `最近聊到：${summary}`);
  lines.push('', '要加就说「/记住 xxx」，记错了就说「/忘记 关键词」。');
  return lines.join('\n');
}

export function renderPersona(persona = {}) {
  const style = (persona.style ?? []).map((s) => `· ${s}`).join('\n');
  return [
    `我是「${persona.name}」。${persona.description ?? ''}`,
    style ? `\n我的说话方式：\n${style}` : '',
    '',
    '想换个人设？改 config/bridge.json 里的 chat.persona 就行。',
  ].filter(Boolean).join('\n');
}

/** 并进记账那份「帮助」里的一段——同一个 bot，指令得在一处能看全 */
export function renderHelpSection() {
  return [
    '『陪聊』',
    '  直接说人话就行，我会接话（记得住以前聊过的事）',
    '  /记忆  /记住 xxx  /忘记 xxx    看 / 加 / 删长期记忆',
    '  /清空  /重置                   忘掉最近这段对话 / 连记忆一起清',
    '  /人设  /重说                   看人设 / 上一句换个说法重答',
  ].join('\n');
}
export function renderUnknownCommand(word) {
  return `没有「${word}」这个指令，发 /帮助 看看有哪些。`;
}