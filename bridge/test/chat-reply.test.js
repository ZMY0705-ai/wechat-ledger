/**
 * 回复清洗单测：微信不渲染 markdown，模型却总爱写。这些壳必须剥干净，
 * 但不许伤到正文——「**35**」要变成「35」，不能变成空。
 */
import { ATTACHMENT_REPLY, isAttachmentOnly, sanitizeReply } from '../src/chat/reply.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
}

console.log('=== 剥壳 ===');
check('普通文字原样', sanitizeReply('今天天气不错啊'), '今天天气不错啊');
check('**粗体**', sanitizeReply('**真的**很累'), '真的很累');
check('__粗体__', sanitizeReply('__真的__很累'), '真的很累');
check('### 标题', sanitizeReply('### 今日总结\n还行'), '今日总结\n还行');
check('无序列表', sanitizeReply('- 早饭\n- 午饭'), '早饭\n午饭');
check('有序列表', sanitizeReply('1. 早饭\n2. 午饭'), '早饭\n午饭');
check('行内代码', sanitizeReply('跑 `npm start` 就行'), '跑 npm start 就行');
check('``` 围栏整段包着', sanitizeReply('```\n你好呀\n```'), '你好呀');
check('```json 围栏', sanitizeReply('```json\n{"a":1}\n```'), '{"a":1}');
check('行尾空格', sanitizeReply('你好   \n在的'), '你好\n在的');
check('连续空行压成一段', sanitizeReply('甲\n\n\n\n乙'), '甲\n\n乙');
check('空字符串', sanitizeReply(''), '');
check('纯空白', sanitizeReply('   \n  '), '');
check('null 也认', sanitizeReply(null), '');

console.log('\n=== 人设名前缀 ===');
check('「小满：」被摘掉', sanitizeReply('小满：你好呀', { name: '小满' }), '你好呀');
check('「小满:」半角也算', sanitizeReply('小满: 你好呀', { name: '小满' }), '你好呀');
check('正文中间的冒号不动', sanitizeReply('小满：你好\n他说：明天见', { name: '小满' }), '你好\n他说：明天见');
check('别的名字不动', sanitizeReply('小圆：你好', { name: '小满' }), '小圆：你好');

console.log('\n=== 只有附件 ===');
check('图片占位无正文', isAttachmentOnly('（收到图片）', ['图片']), true);
check('图片+正文', isAttachmentOnly('（收到图片）看看这个', ['图片']), false);
check('纯文字', isAttachmentOnly('在吗', []), false);
check('没有附件时不受占位符影响', isAttachmentOnly('（收到图片）', []), false);
check('附件回复本身', ATTACHMENT_REPLY.includes('语音'), true);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;