/**
 * 微信 iLink Bot 扫码登录，换取 bearer token。
 *
 * 流程见 docs/04-自写微信桥接与LLM接入.md §2.2。
 * 用法：cd bridge && npm run login
 */
import { loadConfig } from '../config.js';

const POLL_INTERVAL_MS = 3_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 35_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchQrCode(baseUrl) {
  const resp = await fetch(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
  if (!resp.ok) throw new Error(`获取二维码失败：HTTP ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  if (!data.qrcode) throw new Error(`响应里没有 qrcode 字段：${JSON.stringify(data)}`);
  return { token: data.qrcode, content: data.qrcode_img_content };
}

async function pollStatus(baseUrl, qrcodeToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeToken)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function showQrCode(content) {
  if (!content) return;
  try {
    const mod = await import('qrcode-terminal');
    const qrTerminal = mod.default ?? mod;
    qrTerminal.generate(content, { small: true });
    console.log('\n请用手机微信扫描上面的二维码。\n');
  } catch {
    console.log('（未安装 qrcode-terminal，跳过终端渲染）');
    console.log('请把下面这串内容生成二维码后扫描：\n');
    console.log(`  ${content}\n`);
  }
}

function printResult(status, baseUrl) {
  console.log('\n\n🎉 登录成功\n');
  console.log('─'.repeat(64));
  console.log(`Token     : ${status.bot_token}`);
  if (status.baseurl) console.log(`Base URL  : ${status.baseurl}`);
  if (status.ilink_bot_id) console.log(`Bot ID    : ${status.ilink_bot_id}`);
  if (status.ilink_user_id) console.log(`User ID   : ${status.ilink_user_id}`);
  console.log('─'.repeat(64));
  console.log('\n把下面两行填进 bridge/.env：\n');
  console.log(`  WEIXIN_BOT_TOKEN=${status.bot_token}`);
  if (status.ilink_user_id) {
    console.log(`  WEIXIN_ALLOWED_USER_IDS=${status.ilink_user_id}`);
    console.log('\n第二行是白名单：填上之后，只有你这个号能记账，别人给 bot');
    console.log('发消息一律忽略，晨报也只会发给你。强烈建议填。');
  } else {
    console.log('\n⚠️  响应里没有 ilink_user_id，无法自动生成白名单。');
    console.log('   先跑 `npm start`，给你自己发一条消息，控制台会打印出');
    console.log('   「发送者: xxx」，把它填进 WEIXIN_ALLOWED_USER_IDS。');
  }
  console.log('');

  if (status.baseurl && status.baseurl !== baseUrl) {
    console.log(`⚠️  服务端返回了不同的 baseUrl（${status.baseurl}）`);
    console.log('   请在 config/bridge.json 里设置 weixin.baseUrl，否则连不上。\n');
  }
}

async function main() {
  const config = loadConfig();
  const baseUrl = config.weixin.baseUrl.replace(/\/+$/, '');

  console.log(`正在向 ${baseUrl} 申请二维码...\n`);
  const { token: qrcodeToken, content } = await fetchQrCode(baseUrl);
  await showQrCode(content);

  console.log('等待扫码...');

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let scannedNotified = false;

  while (Date.now() < deadline) {
    const status = await pollStatus(baseUrl, qrcodeToken);

    if (status?.status === 'wait') {
      process.stdout.write('.');
    } else if (status?.status === 'scaned') {
      if (!scannedNotified) {
        console.log('\n已扫码，请在手机上点确认...');
        scannedNotified = true;
      }
    } else if (status?.status === 'expired') {
      console.error('\n\n二维码已过期，请重新运行 npm run login');
      process.exitCode = 1;
      return;
    } else if (status?.status === 'confirmed') {
      printResult(status, baseUrl);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.error('\n\n登录超时（5 分钟），请重试。');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n登录失败：${err.message}`);
  process.exitCode = 1;
});