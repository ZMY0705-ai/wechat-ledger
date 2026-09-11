/**
 * 记忆存储单测：窗口滚动、事实增删、重启后还在不在。
 * 「重启后还在」是这一层的存在意义——不然每开一次机它就重新认识你一遍。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/chat/memory.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond) { check(name, Boolean(cond), true); }

const dir = mkdtempSync(join(tmpdir(), 'chat-memory-'));
const file = (name) => join(dir, name);
let clock = 1_000_000;
const now = () => clock;

console.log('=== 会话窗口 ===');
{
  const m = new MemoryStore(file('a.json'), { maxTurns: 4, now });
  m.append('u1', 'user', '在吗');
  m.append('u1', 'assistant', '在的');
  check('两条都在', m.history('u1'), [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在的' },
  ]);
  m.append('u1', 'user', '今天好累');
  m.append('u1', 'assistant', '怎么了');
  m.append('u1', 'user', '加班');
  check('超出窗口丢最老的', m.history('u1').map((t) => t.content), ['在的', '今天好累', '怎么了', '加班']);
  check('history(limit) 只取最近 n 条', m.history('u1', 2).map((t) => t.content), ['怎么了', '加班']);
  check('空内容不记', m.append('u1', 'user', '   '), null);
  check('不同用户互不干扰', m.history('u2'), []);
}

console.log('\n=== 「问一句」的计数（决定什么时候整理记忆）===');
{
  const m = new MemoryStore(file('b.json'), { now });
  m.append('u1', 'user', '在吗');
  check('user 不计数', m.stats('u1').sinceDigest, 0);
  m.append('u1', 'assistant', '在的');
  m.append('u1', 'assistant', '嗯？');
  check('assistant 计数', m.stats('u1').sinceDigest, 2);
  m.noteDigest('u1');
  check('整理后清零', m.stats('u1').sinceDigest, 0);
  check('记下整理时间', m.stats('u1').lastDigestAt, clock);
  m.noteDigestFailure('u1');
  check('失败时间也记（用来做冷却）', m.stats('u1').digestFailedAt, clock);
  m.noteDigest('u1');
  check('成功后清掉失败标记', m.stats('u1').digestFailedAt, 0);
  check('lastUserText 用于 /重说', m.stats('u1').lastUserText, '在吗');
}

console.log('\n=== 长期记忆 ===');
{
  const m = new MemoryStore(file('c.json'), { maxTurns: 10, maxFacts: 3, now });
  check('默认空', m.profile('u1'), { facts: [], summary: '' });
  m.mergeProfile('u1', { facts: ['用户在做记账项目', '用户在做记账项目', '  ', 42], summary: ' 最近在折腾  机器人 ' });
  check('去重 + 去空 + 去非字符串', m.profile('u1').facts, ['用户在做记账项目']);
  check('摘要压空白', m.profile('u1').summary, '最近在折腾 机器人');
  check('没有 updatedAt 字段就不暴露', Object.keys(m.profile('u1')).sort(), ['facts', 'summary']);

  m.mergeProfile('u1', { facts: ['甲', '乙', '丙', '丁'], summary: '' });
  check('超出上限截断', m.profile('u1').facts.length, 3);
  m.mergeProfile('u1', { facts: ['x'.repeat(200)], summary: 'ok' });
  check('单条事实截到 60 字', m.profile('u1').facts[0].length, 60);
  m.mergeProfile('u1', { summary: '只更新摘要' });
  check('facts 不是数组时保留旧清单', m.profile('u1').facts.length, 1);
  check('但摘要更新了', m.profile('u1').summary, '只更新摘要');

  m.mergeProfile('u1', { facts: ['丙', '丁'], summary: '' });
  m.addFact('u1', '用户怕冷');
  check('手写的排最前', m.profile('u1').facts[0], '用户怕冷');
  check('手写重复不加', (m.addFact('u1', '用户怕冷'), m.profile('u1').facts.filter((f) => f === '用户怕冷').length), 1);
  check('手写空值返回 null', m.addFact('u1', '  '), null);

  check('关键词删掉 1 条', m.forget('u1', '丙'), 1);
  check('删完剩下的', m.profile('u1').facts, ['用户怕冷', '丁']);
  check('找不到就返回 0', m.forget('u1', '不存在的词'), 0);
  check('空关键词不删', m.forget('u1', '  '), 0);
}

console.log('\n=== 清空 ===');
{
  const m = new MemoryStore(file('d.json'), { now });
  m.append('u1', 'user', '在吗');
  m.append('u1', 'assistant', '在的');
  m.addFact('u1', '用户怕冷');
  m.clear('u1', { keepProfile: true });
  check('清空对话后记忆还在', m.profile('u1').facts, ['用户怕冷']);
  check('对话没了', m.history('u1'), []);
  check('整理计数也归零', m.stats('u1').sinceDigest, 0);
  m.clear('u1', { keepProfile: false });
  check('彻底清空后记忆也没了', m.profile('u1'), { facts: [], summary: '' });
}

console.log('\n=== 落盘 ===');
{
  const path = file('e.json');
  const m = new MemoryStore(path, { now });
  m.append('u1', 'user', '记住了吗');
  m.append('u1', 'assistant', '记住了');
  m.addFact('u1', '用户怕冷');
  m.mergeProfile('u1', { facts: ['用户怕冷'], summary: '刚认识' });

  const reopened = new MemoryStore(path, { now });
  check('重启后对话还在', reopened.history('u1').map((t) => t.content), ['记住了吗', '记住了']);
  check('重启后记忆还在', reopened.profile('u1').facts, ['用户怕冷']);
  check('重启后整理计数还在', reopened.stats('u1').sinceDigest, 1);

  const broken = file('f.json');
  writeFileSync(broken, '{ 这不是 json', 'utf8');
  const fromBroken = new MemoryStore(broken, { now });
  check('文件坏了当空处理，不炸', fromBroken.history('u1'), []);

  const noPath = new MemoryStore(null, { now });
  noPath.append('u1', 'user', 'hi');
  check('没有路径时也能用（纯内存）', noPath.history('u1').length, 1);

  reopened.dropLast('u1', 1);
  check('dropLast 去掉最后一条', reopened.history('u1').map((t) => t.content), ['记住了吗']);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;