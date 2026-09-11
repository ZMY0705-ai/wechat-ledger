/**
 * 白名单与配置链路单测。
 * 核心诉求：只有指定对话框能记账，陌生人既记不了账也收不到晨报。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIdList, isSenderAllowed } from '../src/util.js';
import { WeixinClient, SenderNotAllowedError } from '../src/weixin/client.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`); }
}

console.log('=== parseIdList ===');
check('空值', parseIdList(''), []);
check('null', parseIdList(null), []);
check('单值', parseIdList('u1'), ['u1']);
check('中英文逗号/顿号/分号/空白混用', parseIdList('u1, u2，u3、u4;u5 u6'), ['u1','u2','u3','u4','u5','u6']);
check('去重且保序', parseIdList('b, a, b , a'), ['b','a']);
check('数组入参', parseIdList(['x', ' y ']), ['x','y']);

console.log('\n=== isSenderAllowed ===');
check('空白名单 = 不限制', isSenderAllowed([], 'anyone'), true);
check('空串白名单 = 不限制', isSenderAllowed('', 'anyone'), true);
check('命中', isSenderAllowed(['u1','u2'], 'u2'), true);
check('未命中', isSenderAllowed(['u1','u2'], 'u9'), false);
check('字符串白名单', isSenderAllowed('u1,u2', 'u1'), true);
check('senderId 为 undefined', isSenderAllowed(['u1'], undefined), false);

console.log('\n=== WeixinClient 白名单 ===');
const ctxPath = join(tmpdir(), `ledger-gate-${process.pid}.json`);
const locked = new WeixinClient({ token: 't', contextStorePath: ctxPath, allowedUserIds: 'u1, u2' });
check('allowedUserIds 已规范化', locked.allowedUserIds, ['u1','u2']);
check('allows(u1)', locked.allows('u1'), true);
check('allows(陌生人)', locked.allows('u9'), false);

const open = new WeixinClient({ token: 't', contextStorePath: ctxPath });
check('默认不限制', open.allows('anyone'), true);

let rejected = null;
try { await locked.reply('u9', '你好'); } catch (err) { rejected = err; }
check('拒绝对陌生人回复', rejected instanceof SenderNotAllowedError, true);

let proactiveRejected = null;
try { await locked.sendProactive('u9', '晨报'); } catch (err) { proactiveRejected = err; }
check('拒绝向陌生人主动推送', proactiveRejected instanceof SenderNotAllowedError, true);

console.log('\n=== loadConfig 读取 .env 里的白名单 ===');
process.env.WEIXIN_ALLOWED_USER_IDS = 'ilink_user_123 , ilink_user_456';
const cfg = loadConfig();
check('env 覆盖到 config.weixin', cfg.weixin.allowedUserIds, ['ilink_user_123','ilink_user_456']);
check('llm 默认供应商', cfg.llm.provider, 'deepseek');
check('llm 默认关闭思考模式', cfg.llm.extraBody, { thinking: { type: 'disabled' } });
check('apiKey 从 apiKeyEnv 指定', cfg.llm.apiKeyEnv, 'DEEPSEEK_API_KEY');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail > 0 ? 1 : 0;