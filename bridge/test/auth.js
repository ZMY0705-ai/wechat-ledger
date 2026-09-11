/**
 * token 有效性诊断：不需要等人发消息，直接打一次 getupdates。
 *
 * 用法：cd bridge && npm run auth
 *   · 401      → token 已失效，重跑 `npm run login`
 *   · 超时     → token 有效（长轮询在正常等待）
 *   · 有消息   → token 有效，且立刻打印出来信
 */
import { loadConfig, requireWeixinToken } from '../src/config.js';
import { parseInbound } from '../src/weixin/client.js';

const TIMEOUT_MS = 12_000;
const mask = (s) => (s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-6)}`);

const config = loadConfig();
const token = requireWeixinToken(config);
const baseUrl = config.weixin.baseUrl.replace(/\/+$/, '');
const allow = config.weixin.allowedUserIds;

console.log('─'.repeat(64));
console.log('微信 token 诊断');
console.log('─'.repeat(64));
console.log(`Base URL : ${baseUrl}`);
console.log(`Token    : ${mask(token)}`);
console.log(`白名单   : ${allow.length ? allow.join(', ') : '（未设置，任何人都能记账）'}`);
if (!allow.length) {
  console.log('           ⚠️  建议把 ilink_user_id 填进 WEIXIN_ALLOWED_USER_IDS');
}
console.log('');

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
const started = Date.now();

try {
  const resp = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token}`,
      'X-WECHAT-UIN': String(Math.floor(Math.random() * 1_000_000_000)),
    },
    body: JSON.stringify({ get_updates_buf: '', base_info: { channel_version: '0.1.0' } }),
    signal: controller.signal,
  });

  const elapsed = Date.now() - started;

  if (resp.status === 401) {
    console.log(`✗ HTTP 401（${elapsed}ms）—— token 已失效`);
    console.log('  处理：cd bridge && npm run login，重新扫码换新 token');
    process.exitCode = 1;
  } else if (!resp.ok) {
    console.log(`✗ HTTP ${resp.status} ${resp.statusText}（${elapsed}ms）`);
    process.exitCode = 1;
  } else {
    const data = await resp.json();
    const msgs = Array.isArray(data.msgs) ? data.msgs : [];
    console.log(`✓ token 有效（HTTP 200，${elapsed}ms）`);
    console.log(`  本次待处理消息：${msgs.length} 条`);
    for (const update of msgs) {
      const msg = parseInbound(update);
      if (!msg) { console.log('    · (跳过：bot 自己发的或空消息)'); continue; }
      const ok = !allow.length || allow.includes(msg.senderId);
      console.log(`    · ${msg.text}   [${ok ? '白名单内 ✓' : '白名单外，会被忽略'}]`);
    }
  }
} catch (err) {
  if (err?.name === 'AbortError') {
    console.log(`✓ token 有效（${TIMEOUT_MS}ms 内无新消息，长轮询正常等待）`);
  } else {
    console.log(`✗ 请求失败：${err.message}`);
    console.log('  检查网络 / 代理 / DNS 能否访问 ilinkai.weixin.qq.com');
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
}