import { parseInbound, splitMessage, MAX_MESSAGE_LENGTH } from '../src/weixin/client.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
}

console.log('=== parseInbound ===');
const textMsg = parseInbound({ message_type: 1, from_user_id: 'u1', client_id: 'm1',
  context_token: 'ct1', item_list: [{ type: 1, text_item: { text: '午饭35' } }] });
check('文本消息', [textMsg.senderId, textMsg.messageId, textMsg.text, textMsg.contextToken],
  ['u1', 'm1', '午饭35', 'ct1']);
check('保留原始报文', textMsg.raw.message_type, 1);

console.log('  -- 应被跳过的 --');
check('bot 自己发的 (type 2)', parseInbound({ message_type: 2, from_user_id: 'u1', item_list: [] }), null);
check('无发送者', parseInbound({ message_type: 1, item_list: [{ type: 1, text_item: { text: 'x' } }] }), null);
check('空 item_list', parseInbound({ message_type: 1, from_user_id: 'u1', item_list: [] }), null);
check('null 输入', parseInbound(null), null);

console.log('  -- 多媒体 --');
const voice = parseInbound({ message_type: 1, from_user_id: 'u1', client_id: 'm2',
  item_list: [{ type: 3, voice_item: { text: '打车十八块五' } }] });
check('语音已转写', voice.text, '打车十八块五');

const img = parseInbound({ message_type: 1, from_user_id: 'u1', client_id: 'm3',
  item_list: [{ type: 2, image_item: {} }] });
check('图片 -> 占位文本', img.text, '（收到图片）');
check('图片 -> attachments', img.attachments, ['图片']);

const mixed = parseInbound({ message_type: 1, from_user_id: 'u1', client_id: 'm4',
  item_list: [{ type: 1, text_item: { text: '这是账单' } }, { type: 2, image_item: {} }] });
check('文本+图片', [mixed.text, mixed.attachments], ['这是账单', ['图片']]);

console.log('\n=== splitMessage （2000 字符上限）===');
check('短消息不切分', splitMessage('hello').length, 1);
check('正好 2000 不切分', splitMessage('a'.repeat(MAX_MESSAGE_LENGTH)).length, 1);
check('2001 切成 2 条', splitMessage('a'.repeat(MAX_MESSAGE_LENGTH + 1)).length, 2);
const long = Array.from({ length: 400 }, (_, i) => `第${i}行内容`).join('\n');
const chunks = splitMessage(long);
check('长文本全部内容保留', chunks.join('').replace(/\n/g, ''), long.replace(/\n/g, ''));
check('每块都不超限', chunks.every(c => c.length <= MAX_MESSAGE_LENGTH), true);

const multi = splitMessage('a'.repeat(4500));
check('4.5k 切成 3 条', multi.length, 3);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;