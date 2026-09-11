/**
 * 桥接配置：从 bridge/.env 与 config/bridge.json 读取。
 * 自己解析 .env，不引入 dotenv —— 保持运行时零依赖。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIdList } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));

export const BRIDGE_DIR = resolve(here, '..');
export const REPO_DIR = resolve(BRIDGE_DIR, '..');
export const DATA_DIR = join(REPO_DIR, 'data');
export const CONTEXT_STORE_PATH = join(DATA_DIR, 'weixin-context.json');
export const DRAFT_STORE_PATH = join(DATA_DIR, 'bridge-drafts.json');
/** 陪聊的对话与长期记忆（和记账的草稿/游标分开存） */
export const CHAT_MEMORY_PATH = join(DATA_DIR, 'chat-memory.json');

/** 极简 .env 解析：KEY=VALUE，支持 # 注释与成对引号 */
export function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function parseJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} 不是合法 JSON：${err.message}`);
  }
}

const DEFAULTS = {
  weixin: {
    baseUrl: 'https://ilinkai.weixin.qq.com',
    allowedUserIds: [],
  },
  llm: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-v4-flash',
    // DeepSeek 默认开思考模式且 effort=high，抽取任务必须显式关掉（贵、慢、无收益）。
    // 换 GLM 时在 config/bridge.json 里把 extraBody 覆盖成 {}。
    extraBody: { thinking: { type: 'disabled' } },
    maxTokens: 500,
    timeoutMs: 30_000,
    maxRetries: 2,
  },
  /**
   * 陪聊。**同一个 bot、同一个 token、同一个进程**——iLink 一个微信号只能挂一个 bot
   * （扫新的会把旧的顶掉），所以记账和聊天只能是同一张嘴（docs/09 §2）。
   * 这里只管「人设、记忆、聊天用的模型参数」；密钥、baseUrl、白名单和记账共用。
   */
  chat: {
    enabled: true,
    /** 覆盖上面 llm 里的同名项；baseUrl / apiKey / extraBody 自动继承 */
    llm: {
      model: 'deepseek-v4-flash',
      temperature: 0.85,
      maxTokens: 800,
      timeoutMs: 45_000,
    },
    persona: {
      name: '小满',
      description: '你在微信里认识很久的一个朋友，说话随意、有点幽默，会关心人但不腻歪。',
      style: [],
      /** 想完全自己写人设就填这一段，会整段替换默认人设；里面写 %MEMORY% 可指定记忆插在哪 */
      systemPrompt: null,
    },
    memory: {
      /** 最近多少条消息（一问一答算两条）留在上下文里 */
      maxTurns: 24,
      /** 攒够多少轮就问模型整理一次长期记忆 */
      digestEveryTurns: 12,
      /** 长期记忆最多留多少条 */
      maxFacts: 40,
      /** 整理失败后的冷却（分钟）：别每来一句就重试，那是白烧钱 */
      digestCooldownMinutes: 10,
    },
    /** 启动（= 你开机）时要不要主动打声招呼（日报之外的额外一条） */
    greetOnStart: false,
    /** 距上次聊天超过这么多小时才打招呼，免得反复重启就反复骚扰 */
    greetIdleHours: 8,
  },
  ledgerBaseUrl: 'http://127.0.0.1:8787',
  confirmThresholdCents: 20_000,
  draftTtlMinutes: 30,
  /** 桥接启动（= 你开机）后自动推一次日报。电脑不是 24 小时开着，用开机触发比定时 cron 可靠 */
  pushBriefOnStart: true,
  /** 日报看门狗检查间隔（分钟）：休眠唤醒后靠它补推当天那份 */
  briefCheckMinutes: 15,
};

export function loadConfig() {
  const env = { ...parseEnvFile(join(BRIDGE_DIR, '.env')), ...process.env };
  const fileCfg = parseJsonFile(join(REPO_DIR, 'config', 'bridge.json'));

  const weixin = {
    ...DEFAULTS.weixin,
    ...fileCfg.weixin,
    token: env.WEIXIN_BOT_TOKEN || '',
  };
  // 允许从 .env 覆盖白名单：改权限不用动配置文件
  weixin.allowedUserIds = parseIdList(env.WEIXIN_ALLOWED_USER_IDS || weixin.allowedUserIds);

  const llm = { ...DEFAULTS.llm, ...fileCfg.llm };
  llm.apiKey = env[llm.apiKeyEnv] || '';

  const chat = {
    ...DEFAULTS.chat,
    ...fileCfg.chat,
    persona: { ...DEFAULTS.chat.persona, ...fileCfg.chat?.persona },
    memory: { ...DEFAULTS.chat.memory, ...fileCfg.chat?.memory },
    // 继承记账那份 baseUrl / key / extraBody；聊天特有的几项以 DEFAULTS.chat.llm 为准，再被配置文件覆盖
    llm: { ...llm, ...DEFAULTS.chat.llm, ...fileCfg.chat?.llm },
  };
  if (env.CHAT_LLM_MODEL) chat.llm.model = env.CHAT_LLM_MODEL;
  if (/^(0|false|off|no)$/i.test(env.CHAT_ENABLED ?? '')) chat.enabled = false;

  return {
    ...DEFAULTS,
    ...fileCfg,
    weixin,
    llm,
    chat,
    ledgerBaseUrl: env.LEDGER_BASE_URL || fileCfg.ledgerBaseUrl || DEFAULTS.ledgerBaseUrl,
  };
}

/** 启动前校验，缺什么就明确报出来，不要跑到一半才炸 */
export function requireWeixinToken(config) {
  if (!config.weixin.token) {
    throw new Error(
      '缺少 WEIXIN_BOT_TOKEN。\n' +
        '  1) 先在 bridge/ 目录复制 .env.example 为 .env\n' +
        '  2) 再跑 npm run login 扫码，把打印出来的 token 填进去',
    );
  }
  return config.weixin.token;
}

export function requireLlmKey(config) {
  if (!config.llm.apiKey) {
    throw new Error(
      `缺少 ${config.llm.apiKeyEnv}（当前供应商 ${config.llm.provider}）。\n` +
        '  去 https://platform.deepseek.com 或 https://open.bigmodel.cn 申请后填进 bridge/.env\n' +
        '  或者把 config/bridge.json 的 llm.provider / baseUrl / model / apiKeyEnv 换成另一家',
    );
  }
  return config.llm.apiKey;
}