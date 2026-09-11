/**
 * 人设与提示词单测。
 *
 * 重点是那条**稳定前缀**：同一份人设 + 同一份记忆，构建出来的系统提示词必须
 * 逐字相同（时间不能混进去），否则每轮都换前缀，供应商的上下文缓存永远不命中。
 */
import { buildSystemPrompt, buildTimePrefix, formatNow } from '../src/chat/persona.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond) { check(name, Boolean(cond), true); }

console.log('=== formatNow（一律按 Asia/Shanghai 算，不看机器时区）===');
check('UTC 13:30 = 北京 21:30', formatNow(new Date('2026-09-10T13:30:00Z')), '2026-09-10 周四 21:30');
check('跨零点：UTC 16:00 = 北京次日 00:00', formatNow(new Date('2026-09-09T16:00:00Z')), '2026-09-10 周四 00:00');
check('月份补零', formatNow(new Date('2026-01-05T01:05:00Z')), '2026-01-05 周一 09:05');
check('周日', formatNow(new Date('2026-09-13T04:00:00Z')), '2026-09-13 周日 12:00');

console.log('\n=== buildTimePrefix ===');
ok('带方括号与「现在」', buildTimePrefix(new Date('2026-09-10T13:30:00Z')).startsWith('[现在：'));
ok('末尾换行', buildTimePrefix(new Date('2026-09-10T13:30:00Z')).endsWith('\n'));

console.log('\n=== buildSystemPrompt ===');
const persona = { name: '小满', description: '一个朋友。', style: ['短句'] };
const base = buildSystemPrompt({ persona, profile: { facts: [], summary: '' } });
ok('带人设名', base.includes('小满'));
ok('带描述', base.includes('一个朋友。'));
ok('带自定义风格', base.includes('- 短句'));
ok('没有记忆时说明「还没有」', base.includes('目前还没有'));
ok('不塞时间戳', !base.includes('现在：'));

const withMemory = buildSystemPrompt({
  persona,
  profile: { facts: ['用户在做记账项目', '用户不爱打电话'], summary: '最近在折腾微信机器人' },
});
ok('事实进提示词', withMemory.includes('- 用户在做记账项目') && withMemory.includes('- 用户不爱打电话'));
ok('摘要进提示词', withMemory.includes('最近在折腾微信机器人'));

console.log('\n=== 稳定前缀 ===');
check(
  '同一份输入 → 逐字相同',
  buildSystemPrompt({ persona, profile: withMemory ? { facts: ['a'], summary: 'b' } : {} }),
  buildSystemPrompt({ persona, profile: { facts: ['a'], summary: 'b' } }),
);

console.log('\n=== 完全自写人设 ===');
const custom = buildSystemPrompt({ persona: { systemPrompt: '你是一只会说话的猫。' }, profile: { facts: ['用户喜欢猫'], summary: '' } });
ok('整段替换默认人设', custom.startsWith('你是一只会说话的猫。'));
ok('记忆仍然自动追加', custom.includes('- 用户喜欢猫'));
const placed = buildSystemPrompt({
  persona: { systemPrompt: '你是一只会说话的猫。\n%MEMORY%\n就这些。' },
  profile: { facts: ['用户喜欢猫'], summary: '' },
});
ok('%MEMORY% 按指定位置插入', placed.indexOf('用户喜欢猫') < placed.indexOf('就这些。'));
ok('%MEMORY% 占位符被替换掉', !placed.includes('%MEMORY%'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;