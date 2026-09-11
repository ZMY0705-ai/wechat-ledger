/**
 * iLink 接口连通性探测（不做登录，只确认接口可达）。
 * 用法：node test/probe.js
 */
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const baseUrl = config.weixin.baseUrl.replace(/\/+$/, '');
const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;

console.log(`探测: ${url}\n`);
const started = Date.now();

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const resp = await fetch(url, { signal: controller.signal });
  clearTimeout(timer);

  const ms = Date.now() - started;
  console.log(`HTTP     : ${resp.status} ${resp.statusText}`);
  console.log(`耗时     : ${ms}ms`);

  const text = await resp.text();
  console.log(`响应长度 : ${text.length}`);

  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }

  if (data) {
    const keys = Object.keys(data);
    console.log(`字段     : ${keys.join(', ')}`);
    console.log(`有 qrcode : ${Boolean(data.qrcode)}`);
    console.log(`有二维码内容: ${Boolean(data.qrcode_img_content)}`);
    if (data.qrcode_img_content) {
      const c = String(data.qrcode_img_content);
      console.log(`内容预览 : ${c.length > 120 ? c.slice(0, 120) + '…' : c}`);
    }
    if (data.ret !== undefined) console.log(`ret      : ${data.ret}`);
    if (data.errmsg) console.log(`errmsg   : ${data.errmsg}`);
  } else {
    console.log(`响应体   : ${text.slice(0, 300)}`);
  }

  console.log(`\n结论：接口${resp.ok && data?.qrcode ? '可达，可以跑 npm run login' : '返回异常，需要排查'}`);
} catch (err) {
  const ms = Date.now() - started;
  console.log(`HTTP     : 失败（${ms}ms）`);
  console.log(`错误     : ${err.name}: ${err.message}`);
  console.log('\n结论：网络不通。可能需要检查代理、DNS 或网络环境。');
  process.exitCode = 1;
}