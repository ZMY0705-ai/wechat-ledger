/**
 * 分流闸门单测（docs/09 §4）。
 *
 * 这条线是「一句话到底进哪个抽屉」的第一道防线，判错一次就是一笔钱丢了
 * 或者一句闲聊被追问「多少钱」。所以断言写得比较细：**宁可多判是账**。
 */
import { looksLikeLedger, splitForcePrefix, stripLeadingSlash } from '../src/chat/gate.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
}

console.log('=== 像账的话（必须走记账链路）===');
for (const text of [
  '午饭35',
  '昨天超市买菜76.5',
  '发工资12000',
  '存了2000',
  '还信用卡2000',
  '房租',
  '水电费交了',
  '三十五',
  '两百块',
  '打车十八块五',
  '老板发了个红包',
  '花了三百多',
  '买了个键盘 399',
]) {
  check(text, looksLikeLedger(text), true);
}

console.log('\n=== 一眼就是闲聊（走陪聊，省一次调用）===');
for (const text of [
  '今天好累',
  '在吗',
  '你在干嘛',
  '我最近在看一部剧',
  '心里有点烦',
  '你觉得我该换工作吗',
  '一起吃饭吗',        // 「一」不算数词
  '两个都行',          // 「两」不算
  '一直这样',          // 「一」不算
  '还不错',            // 「还」不算（只有 还款/还钱 才算）
  '存在感有点低',      // 「存」不算（只有 存了/存钱/存进 才算）
  '他转告我了',        // 「转」不算（只有 转账/转了 才算）
  '晚安',
  '🙂',
  '',
]) {
  check(text, looksLikeLedger(text), false);
}

console.log('\n=== 词法像账、其实是闲聊（交给模型兜底）===');
check('等了三十分钟 也会先走记账，再由模型判', looksLikeLedger('等了三十分钟'), true);

console.log('\n=== 强制指定（说不清的时候你说了算）===');
check('/聊 今天好累', splitForcePrefix('/聊 今天好累'), { kind: 'chat', text: '今天好累' });
check('/聊天 随便说说', splitForcePrefix('/聊天 随便说说'), { kind: 'chat', text: '随便说说' });
check('/说说 心里烦', splitForcePrefix('/说说 心里烦'), { kind: 'chat', text: '心里烦' });
check('/记 今天好累', splitForcePrefix('/记 今天好累'), { kind: 'record', text: '今天好累' });
check('/记账 昨天买菜76', splitForcePrefix('/记账 昨天买菜76'), { kind: 'record', text: '昨天买菜76' });
check('/记录 买了个包', splitForcePrefix('/记录 买了个包'), { kind: 'record', text: '买了个包' });
check('不带前缀就交给闸门', splitForcePrefix('午饭35'), { kind: null, text: '午饭35' });
check('/帮助 不是强制前缀', splitForcePrefix('/帮助'), { kind: null, text: '/帮助' });
check('/记忆 不是强制前缀', splitForcePrefix('/记忆'), { kind: null, text: '/记忆' });
check('空字符串', splitForcePrefix(''), { kind: null, text: '' });

console.log('\n=== 记账指令前面带个 / 也认 ===');
check('/余额', stripLeadingSlash('/余额'), '余额');
check('余额', stripLeadingSlash('余额'), '余额');
check('/ 帮助', stripLeadingSlash('/ 帮助'), '帮助');
check('中间的斜杠不动', stripLeadingSlash('午饭/35'), '午饭/35');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;