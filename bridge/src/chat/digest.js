/**
 * 长期记忆的整理（digest）：把最近的对话压成「事实清单 + 最近聊到」。
 *
 * 为什么不让模型自己决定记什么：它每轮都在忘。所以由一个独立步骤定期回头看，
 * 而且**只让它做压缩，不做发挥**——宁少勿滥，拿不准的宁可不写。
 *
 * 这一步是额外的一次调用（默认每 12 轮一次），不阻塞回复：走后台，
 * 失败了就留着下次再整理，用户看不到任何异常。
 */

export const DIGEST_SYSTEM = `你是对话记忆整理器。读一段微信聊天记录，把它压缩成能长期保存的两样东西，只输出 json。

输出格式：
{"facts":["用户…","用户…"],"summary":"…"}

字段说明：
- facts：关于对方的、值得长期记住的稳定信息（身份、工作、家人朋友、喜好、习惯、正在做的事、重要日期、他在意的事）。
  每条不超过 30 字，用「用户…」的第三人称句式，例如「用户在做记账项目」「用户不太喜欢打电话」。
  必须输出完整列表：把「已知的长期记忆」里仍然成立的保留，合并这次新出现的，去掉已经被推翻的。
  宁少勿滥——这一轮没聊到、或者拿不准的，就别写。没有就输出 []。
- summary：最近聊过什么，200 字以内，供下次接着聊。没有就输出 ""。

注意：
- 只写对话里明确出现过的信息，不推测、不补常识
- 时间、金额、人名这类细节要么照抄准确，要么不写
- 只输出 json，不要解释`;

/** 已有的记忆要一起给模型，不然它每轮都在重建，事实会飘 */
export function buildDigestUser({ profile = {}, turns = [], assistantName = '对方' } = {}) {
  const facts = (profile.facts ?? []).map((f) => `- ${f}`).join('\n') || '（空）';
  const summary = String(profile.summary ?? '').trim() || '（空）';
  const transcript = turns
    .map((t) => `${t.role === 'assistant' ? assistantName : '用户'}：${t.content}`)
    .join('\n');
  return [
    '已知的长期记忆：',
    facts,
    '',
    '最近聊过：',
    summary,
    '',
    '最近的聊天记录（从旧到新）：',
    transcript || '（空）',
    '',
    '请输出整理后的 json。',
  ].join('\n');
}

/**
 * 校验模型给的整理结果。字段类型不对就返回 null——
 * 记忆是会被写进以后每一轮提示词的东西，宁可这轮不更新，也不能把垃圾写进去。
 */
export function normalizeDigest(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const hasFacts = Array.isArray(parsed.facts);
  const hasSummary = typeof parsed.summary === 'string';
  if (!hasFacts && !hasSummary) return null;
  return {
    facts: hasFacts ? parsed.facts.filter((f) => typeof f === 'string') : [],
    summary: hasSummary ? parsed.summary : '',
    factsProvided: hasFacts,
  };
}