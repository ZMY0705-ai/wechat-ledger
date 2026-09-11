/**
 * 「这句话是账，还是闲聊」的闸门（docs/09 §4）。
 *
 * 背景：iLink 一个微信号只能挂一个 bot（扫新的会把旧的顶掉），所以记账和陪聊
 * 共用一张嘴，就必须判断每句话该走哪条路。
 *
 * 两条防线，一快一准：
 *   1. **词法**（本文件）：看不出任何金额线索的话直接当闲聊，省一次调用。
 *      原则是「宁可漏判，不可误判」，但这里的误判代价是不对称的——
 *        把账判成闲聊 → 这笔钱丢了，最坏
 *        把闲聊判成账 → 它回一句「这笔多少钱？」，烦，但没损失
 *      所以只有**完全没有**数字/钱的字样时才走闲聊，其余一律交给记账链路。
 *   2. **模型**：进了记账链路的话，模型会在抽取时多给一个 `is_ledger` 字段
 *      （见 llm/prompt.js），说「这根本不是一笔账」就转回陪聊（见 handler/record.js）。
 *      「等了三十分钟」这种词法上像账、其实是闲聊的句子就靠它兜住。
 *
 * LLM 没配时只剩第一层，那时行为与加陪聊之前完全一致（都走记账），不会更差。
 */

/** 阿拉伯数字：几乎只要出现就值得让模型看一眼 */
const DIGITS = /[0-9０-９]/;
/** 钱的数词：三十五 / 两百 / 十几块 —— 注意「一起」「两个」不算 */
const MONEY_NUMERALS = /[一二三四五六七八九十百千万两半壹贰叁肆伍陆柒捌玖拾佰仟]{2,}|[一二三四五六七八九十百千万两半]+\s*(?:块|元|毛|角)/;
/** 钱的字样 */
const MONEY_WORDS = /(块钱|块|元|毛|角|分钱|工资|收入|支出|花呗|信用卡|报销|红包|账单|发票|押金|房租|水电|话费|月供|贷款|利息|交税|缴税)/;
/** 收支动词：宁可多判，交给模型去细看（写窄一点，免得「还不错」「存在感」误伤） */
const LEDGER_VERBS = /(买了|买单|买菜|购买|花了|花钱|花费|花销|付了|付款|支付|付钱|充值|存了|存钱|存进|转账|转了|还款|还钱|报销|发工资|收款|退款|借了|借给|垫付|缴费|交了|交费)/;

/** 语料里带金额线索 → 走记账链路（再由模型判一次） */
export function looksLikeLedger(text) {
  const s = String(text ?? '');
  return DIGITS.test(s) || MONEY_NUMERALS.test(s) || MONEY_WORDS.test(s) || LEDGER_VERBS.test(s);
}

// 注意两处细节，都是踩过的：
//   · 长的词排前面（JS 的 | 是「先匹配到谁算谁」，不是「谁长算谁」）
//   · 后面必须跟空白或结束，否则 `/记忆` 会被 `/记` 这个前缀吃掉
const FORCE_PREFIXES = [
  { kind: 'chat', re: /^\s*\/\s*(?:聊天|说说|聊|chat)(?=\s|$)/i },
  { kind: 'record', re: /^\s*\/\s*(?:记账|记录|记|add)(?=\s|$)/i },
];

/**
 * 显式指定走哪条路：`/聊 xxx` 强制陪聊，`/记 xxx` 强制记账。
 * 闸门再准也会有你不同意的时候，得留个「我说了算」的开关。
 * @returns {{kind: 'chat'|'record'|null, text: string}}
 */
export function splitForcePrefix(text) {
  const s = String(text ?? '');
  for (const { kind, re } of FORCE_PREFIXES) {
    const matched = re.exec(s);
    if (matched) return { kind, text: s.slice(matched[0].length).trim() };
  }
  return { kind: null, text: s };
}

/** 记账指令前面带个 `/` 也认：`/余额` 和「余额」是一回事 */
export function stripLeadingSlash(text) {
  return String(text ?? '').replace(/^\s*\/\s*/, '');
}