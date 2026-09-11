/**
 * 确定性指令：撤销 / 余额 / 本月 / 今天 / 昨天 / 最近 / 帮助 / 打招呼。
 *
 * 这些**根本不经过 LLM**（docs/04 §4 第三层）：既省钱，又不会出错。
 * LLM 只处理真正需要语言理解的部分。
 *
 * 匹配的原则是「宁可漏判，不可误判」：漏判只是多花一次 LLM 调用，
 * 误判会把「最近买了点东西花了35」当成查账请求，账就丢了。
 */

/** 掐掉首尾的标点与空白，只留正文 */
function clean(text) {
  return String(text ?? '')
    .trim()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s，,。.！!？?~～、；;：:]+|[\s，,。.！!？?~～、；;：:]+$/g, '');
}

export const CONFIRM_WORDS = new Set([
  '是', '是的', '对', '对的', '嗯', '嗯嗯', '好', '好的', '行', '可以', '确认', '确定',
  '没错', '正确', '记吧', '记上', '记下来', '就这样', '没问题', 'ok', 'OK', 'okay', 'yes', 'y',
]);

export const CANCEL_WORDS = new Set([
  '不', '不是', '不对', '不用', '不要', '取消', '算了', '错了', '别记', '不记了', '重来',
  '删掉', '删除', '撤销', 'no', 'n',
]);

/** 确认词：必须是「整句就是它」，避免「不对，是35」被当成确认 */
export function isConfirm(text) {
  return CONFIRM_WORDS.has(clean(text));
}

export function isCancel(text) {
  return CANCEL_WORDS.has(clean(text));
}

const PATTERNS = [
  // 撤销优先：整句里只要有撤销意图就处理，允许带 id（「撤销 10231」）
  { intent: 'undo', re: /(撤销|删掉|删除|记错|记反|不记了|回退|退掉|重新记)/ },
  { intent: 'help', re: /^(帮助|help|怎么用|使用说明|用法|指令|命令|说明)$/i },
  { intent: 'greeting', re: /^(你好|您好|在吗|在么|hi|hello|嗨|哈喽|早上好|早安|中午好|下午好|晚上好|晚安)$/i },
  { intent: 'balance', re: /(余额|总资产|总余额|还剩多少|还有多少钱|剩多少钱)/ },
  { intent: 'month', re: /^(本月|这个月|当月|月报|月报表|月度报表|月度)$/ },
  { intent: 'month', re: /(本月|这个月|当月)(的)?(支出|花销|花费|消费|收入|情况|报表|统计|账)/ },
  { intent: 'today', re: /^(今天|今日)(的)?(支出|花销|花费|消费|收入|情况|账|报表)?$/ },
  { intent: 'yesterday', re: /^(昨天|昨日)(的)?(支出|花销|花费|消费|收入|情况|账|报表)?$/ },
  { intent: 'list', re: /(流水|明细|账单|查账)/ },
  { intent: 'list', re: /^(最近|近期)(几笔|记录|几单)?$/ },
];

/**
 * 匹配确定性指令。
 * @returns {{intent: string}|null}
 */
export function matchCommand(text) {
  const s = clean(text);
  if (!s || s.length > 24) return null;
  for (const { intent, re } of PATTERNS) {
    if (re.test(s)) return { intent };
  }
  return null;
}
