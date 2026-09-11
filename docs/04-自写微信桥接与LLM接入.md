# 04 自写微信桥接与 LLM 接入

> 方案：**不依赖任何 agent 平台**。自己写一个轻量微信桥接进程，内部只做两件事——
> 收消息、调一次 LLM 做结构化抽取，然后调 `ledger` 落库。
>
> 微信协议部分参考 `0xranx/golembot`（MIT）的 `src/channels/weixin.ts` 与
> `src/weixin-login.ts` 实现。以下协议细节均从该源码核对得出。

## 1. 为什么自写可行

之前担心的「微信通道要自己啃」现在不成立了，因为 golembot 已经把 iLink Bot API 打通，
而且实现极其简单：

- **纯 HTTP，零 SDK 依赖**，只用 Node 内置的 `fetch` 和 `node:crypto`
- 收：一次 HTTP 长轮询（最多阻塞 35 秒）
- 发：一次 HTTP POST
- 登录：两次 HTTP 请求 + 轮询（扫码）

**整个桥接的核心代码在 300 行以内。** 这比引入一个 agent 平台轻得多。

额外收益：**我们可以自己持久化 `context_token`**，修掉 golembot 那个「重启后主动消息发不出去」的缺陷（见 §7）。

## 2. iLink Bot API 协议规格

**Base URL**：`https://ilinkai.weixin.qq.com`（登录响应可能返回不同的 `baseurl`，以它为准）

### 2.1 请求头

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
X-WECHAT-UIN: <随机整数，0 ~ 1e9>
```

### 2.2 扫码登录

```
① GET /ilink/bot/get_bot_qrcode?bot_type=3
   → { qrcode: "<token>", qrcode_img_content: "<二维码图片URL>" }

② 展示二维码（终端渲染或输出 URL 让用户点开）

③ 每 3 秒轮询，单次请求 35 秒超时，总超时 5 分钟：
   GET /ilink/bot/get_qrcode_status?qrcode=<qrcode token>
   → { status }
     status = "wait"      等待扫码
     status = "scaned"    已扫码，等手机确认
     status = "expired"   二维码过期，重新来
     status = "confirmed" 成功 ↓
   → { status:"confirmed", bot_token, baseurl, ilink_bot_id, ilink_user_id }
```

**拿到 `bot_token` 就结束了**，把它存进 `.env`。

### 2.3 收消息（长轮询）

```
POST /ilink/bot/getupdates
{
  "get_updates_buf": "<同步游标>",      // 首次为空字符串，之后用上次响应返回的值
  "base_info": { "channel_version": "0.1.0" }
}
```

- 单次最多阻塞 **35 秒**，返回后立即发起下一次（这才是长轮询的意义）
- **HTTP 401 = token 失效**，停止轮询并告警，不要盲目重试
- 其他错误：指数退避 `1s → 2s → 4s → … → 30s` 封顶

### 2.4 消息结构

```
update = {
  message_type: 1,        // 1 = 用户消息；2 及以上是 bot 自己发的，必须跳过
  from_user_id: "…",      // 发送者
  client_id: "…",         // 消息 ID（用作幂等键与去重）
  context_token: "…",     // 回复时必须原样带回，按发送者缓存
  item_list: [ … ]        // 一条消息可能是多段
}
```

`item_list[].type` 取值：

| type | 含义 | 取用字段 |
| --- | --- | --- |
| 1 | 文本 | `text_item.text` |
| 2 | 图片 | `image_item`（见 §2.6） |
| 3 | 语音 | `voice_item.text`（**已转写为文字**） |
| 4 | 文件 | `file_item.file_url` |
| 5 | 视频 | — |

**去重**：维护一个 `client_id` 的 Set（上限 500，超出时保留后半段），
这与我们 `ledger` 的 `idem_key` 形成双保险。

### 2.5 发消息

```
POST /ilink/bot/sendmessage
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<对方 from_user_id>",
    "client_id": "<新 uuid>",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<该用户最近的 context_token>",
    "item_list": [ { "type": 1, "text_item": { "text": "回复内容" } } ]
  },
  "base_info": { "channel_version": "0.1.0" }
}
```

- `context_token` **必须**用该用户最近一次来信里带的那个
- 微信单条上限 **2000 字符**，超长要自己切分

### 2.6 图片（可选，M4 再做）

```
① 从 CDN 下载密文（无需鉴权）：
   https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=<media.encrypt_query_param>

② 取密钥（两种位置，优先第一个）：
   image_item.aeskey          —— 32 位十六进制字符串
   media.aes_key              —— base64；解出 16 字节直接用，
                                 或解出 32 字节 ASCII 十六进制再转

③ AES-128-ECB 解密（无 IV）
④ 按魔数判断格式：0x89 0x50 → PNG，否则 JPEG
```

### 2.7 身份隔离：bot 只能看到「发给它的消息」

**先澄清一个最容易误解的点：微信通道不是「读你的微信」，而是「你和一个机器人聊天」。**

- 扫码登录拿到的是一个**独立的 bot 身份**（响应里的 `ilink_bot_id`），它出现在你的微信里，
  形态就是一个普通对话框。
- 桥接收到的每一条消息，都是**别人发给这个 bot 的**。API 里根本没有「拉我的聊天列表」
  「读我的历史消息」「看我的联系人」这类能力 —— **想读也读不到**（见 §10）。
- 反向同理：bot 发消息必须带上目标用户的 `to_user_id` 和 `context_token`，
  而我们只缓存**给 bot 发过消息的人**的 token，所以它也无法向任意用户发消息。

结论：「只记我一个人的账、只发给我一个人」在协议层就已经成立。**但还不安全**：
如果这个 bot 被其他人加进通讯录并发消息，他们的消息同样会进入记账流程。
因此再加一道白名单：

| 配置项 | 位置 | 说明 |
| --- | --- | --- |
| `WEIXIN_ALLOWED_USER_IDS` | `bridge/.env` | 只有这些 `from_user_id` 发来的消息会被处理（优先） |
| `weixin.allowedUserIds` | `config/bridge.json` | 同上，配置文件形式 |

- 取值来自 `npm run login` 打印的 `ilink_user_id`，**那就是你自己的微信用户 ID**
- 留空 = 不限制，**启动时会打印告警**，只建议 M-1 调试阶段这么用
- 非白名单消息**连 `context_token` 都不记录**，从根上杜绝晨报误发给陌生人
- 主动发送（晨报）同样受白名单约束，不在名单里直接抛 `SenderNotAllowedError`

> 一句话：**协议层保证「看不到你的其他会话」，白名单保证「只有你能记账」。**

## 3. 桥接架构

```
微信
 │  长轮询 POST /ilink/bot/getupdates
 ▼
bridge/  （独立 Node 进程，零 npm 依赖）
 ├─ weixin/client.js    iLink 客户端：轮询、发送、context_token 持久化
 │                      + 白名单闸门（非白名单消息一律丢弃，§2.7）
 ├─ weixin/login.js     扫码登录，产出 BOT_TOKEN 与 ilink_user_id
 ├─ llm/client.js      调用 LLM：一句话 → 结构化 JSON（M2）
 ├─ llm/prompt.js      抽取提示词 / 建议措辞提示词（M2·M3）
 ├─ handler/router.js   消息 → 意图 → 动作（记账/查询/撤销/确认）（M2）
 ├─ handler/brief.js    日报：措辞 + 主动推送 + 重试（M3）
 └── index.js           入口（--echo 回显 / --brief 只看日报）
        │
        │ HTTP（复用 CLI 的同一套 domain 逻辑）
        ▼
记账服务 http://127.0.0.1:8787  ──SSE──► 记账网页
```

**三条贯穿始终的边界：**

1. **桥接不碰数据库**，只调记账服务的 HTTP API。这样桥接可以随时重写、替换
   （比如以后加 Telegram），账本一行不用动。
2. **白名单在最前面**。消息进到业务逻辑之前先过发送者校验，非白名单直接丢弃，
   连 `context_token` 都不记（§2.7）。
3. **LLM 只做语言理解**，算术、时间换算、分类校验全在服务端。

## 4. 消息处理流程

```
收到消息
  │
  ├─ 发送者在白名单里？ ── 否 ──► 记录一条告警后丢弃（不回、不记、不转发）
  │
  ├─ 有未决草稿？ ── 是 ──► 消息是确认词？ ── 是 ──► 确认草稿 → 回执
  │                              └── 否 ──► 取消草稿，继续往下
  │
  ├─ 是明确的指令？（撤销 / 余额 / 本月 / 昨天 / 明细）
  │      └─ 是 ──► 直接调对应 ledger 命令 → 回执（不经过 LLM，省钱又准）
  │
  └─ 否则交给 LLM 抽取
         │
         ├─ 硬规则命中？（金额缺失 / 大额 / 转账 / 未来时间）
         │      └─ 是 ──► 反问用户，或创建草稿等确认
         │
         ├─ confidence < 0.6 ──► 创建草稿，展示解析结果等确认
         │
         └─ 否则 ──► 直接落库 → 回执
```

**注意第一层**：白名单是唯一的安全边界。用户可能只有一个，但 bot 一旦被陌生人加上，他的消息就会污染账本 —— 所以校验放在最前面。

**注意第三层**：「撤销」「余额多少」这类指令**根本不需要 LLM**。
用关键词直接匹配命令，既省钱又不会出错。LLM 只处理真正需要语言理解的部分。

## 5. LLM 抽取设计

### 5.1 只调一次，不要 agent 循环

这是与 agent 平台方案的本质区别：

| | agent 平台 | 我们 |
| --- | --- | --- |
| 每笔账调用次数 | 1 次完整 agent 轮次（含系统提示词、工具集、多轮推理） | **1 次结构化抽取** |
| 每笔账 token 量 | 数千~上万 | 几百 |
| 行为 | 不确定，依赖模型自由发挥 | 确定，schema 约束 |
| 成本 | 高 | 低一个数量级 |

### 5.2 用「提示词清单 + 服务端强校验」约束分类

> ⚠️ **DeepSeek 的限制**：它只支持 `response_format: {"type": "json_object"}`，
> **不支持 OpenAI 的 `json_schema` 严格模式**（官方文档 "JSON Output"）。
> 所以不能靠 schema 的 `enum` 在结构上锁死分类，必须换一套做法。

DeepSeek 官方对 JSON Output 的三条要求：

1. 设置 `response_format` 为 `{"type": "json_object"}`
2. **提示词里必须出现 "json" 这个词**，并给出期望的 JSON 格式示例
3. 合理设置 `max_tokens`，防止 JSON 被截断

另外官方明确提示：**「使用 JSON Output 时，API 偶尔会返回空内容」**——所以必须有重试。

改为**两层防线**：

**第一层——提示词里给清单和示例**（系统提示词是稳定前缀，能吃上下文缓存）：

```
你是记账信息抽取器，只输出 json，不做任何解释。

可选分类（只能从中选，不得自创）：
支出：生活必需 食品餐饮 购物消费 健康医疗 出行交通 休闲娱乐 人情送礼 待分类
收入：工资 奖金 兼职 报销 投资收益 红包收入 退款 其他收入

输出格式示例：
{"amount":30,"type":"expense","category":"食品餐饮","note":"午饭",
 "date":null,"confidence":0.9,"question":null}

字段说明：
- amount：数字；无法确定时用 null
- type：expense | income | transfer | modify_balance；无法确定时用 null
- category：只能是上面清单里的词；无法判断时用「待分类」
- note：简短备注，保留用户原话里的关键信息
- date：YYYY-MM-DD；用户没说具体哪天时用 null，不要自己推算
- confidence：0 到 1
- question：需要向用户追问时填写问题，否则为 null
```

**第二层——服务端强校验**（真正兜底的地方）：

```js
// 分类校验：不在清单里 → 模糊匹配 → 仍失败则落「待分类」
const category = validateCategory(raw.category, dbCategories);
//   ├─ 精确命中        → 直接用
//   ├─ 模糊匹配唯一命中 → 用匹配结果，置信度 × 0.8
//   ├─ 匹配到多个       → 落「待分类」，置信度 × 0.5
//   └─ 完全没命中       → 落「待分类」，置信度 × 0.5
```

同时校验 `type` 是否在四个合法值内、`amount` 是否为正数。
**任何一项校验失败都直接降级为「需要用户确认」，不猜。**

这个做法比 JSON Schema 更稳，因为它不依赖模型遵守 schema——**模型输出什么都有可能，
但服务端只接受合法值**。而且换成任何一家 LLM 供应商都不用改。

### 5.3 关闭思考模式（重要）

DeepSeek 的**思考模式默认开启，且默认 effort 为 high**。对一个「把一句话变成几个字段」
的任务来说，这纯属浪费——多花 token、多等几秒。

请求里必须显式关掉：

```json
{ "thinking": { "type": "disabled" } }
```

用 OpenAI SDK 时要放在 `extra_body` 里：

```python
client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=messages,
    response_format={"type": "json_object"},
    max_tokens=500,
    extra_body={"thinking": {"type": "disabled"}},
)
```

另外提醒：思考模式下 `temperature` / `top_p` / `presence_penalty` / `frequency_penalty`
**会被静默忽略**（不报错但无效）。我们本来也不需要调这些参数——抽取任务要的是确定性，
不是创造性。

### 5.4 置信度评分

模型给出 `confidence`，但我们**不完全信任它**。服务端再按 `docs/07` §2 的维度加权规则
独立算一遍，取**两者较低值**。这样既利用了模型对语义的判断，又保留了确定性校验。

阈值与硬规则见 `docs/07` §2、§2.1。

### 5.5 发送给 LLM 的上下文要克制

只发**当前这一条消息** + 分类清单 + 今天的日期。

不要发聊天历史——既费 token，又会让模型「脑补」出用户没说的内容。

## 6. 每日晨报

**触发方式：桥接启动时推当天那份**（= 你开机）。原本计划的是内置 5 段 cron、
每天 08:30 触发，落地时改了：这台电脑不是 24 小时开着的，定时任务在关机期间
只会白白错过，而且错过之后没有任何补救机会。挂在启动上则保证「开机后一定能看到
今天的账」，再配一个看门狗（每 15 分钟问一次「今天推过没」）兜住「只是休眠了一下、
进程没重启」的情况。

```
桥接启动 / 看门狗到点
      → 调 GET /api/report/brief?kind=morning（不写库）
      → 取 signals[] + fallbackText
      → 把 signals 交给 LLM 措辞成 2~3 条建议（没有 key 就用固定文案）
      → 发送 → 成功了才调 markSent=1
```

**发送失败时不要静默**，也**不要在发送前标记**——先标记再发，一旦发送失败，
这天的日报就永远补不回来了。顺序反过来最坏只是「推了两次」。降级路径见下节。

## 7. `context_token` 持久化（我们优于 golembot 的地方）

golembot 把 `context_token` 放在内存里，进程重启就丢，导致重启后**无法主动发送任何消息**。

我们改为**落盘持久化**：

```
data/weixin-context.json
{ "<user_id>": { "context_token": "…", "updated_at": "2026-09-10 08:12:00" } }
```

每次收到消息就更新，发送前读取。这样**重启后晨报仍然发得出去**。

但如果 `context_token` 本身在服务端过期了，发送会失败。所以仍然保留双保险：

```
路径 A（主动）：桥接启动 / 看门狗 → 发送成功 → 写入 report_log
路径 B（兜底）：用户发「你好」
                → 查 report_log 发现今天没发过 → 回完整日报
```

两条路径共用 `report_log` 去重表，所以不会重复轰炸，也不会漏。
**这个自洽性来自 `docs/02` 的 `report_log` 设计，不需要额外开发。**

## 8. 桥接目录结构

标记：✅ 已实现。M2 / M3 均已完成（2026-09-10）。

```
bridge/
├── package.json            # 运行时零依赖
├── .env                    # WEIXIN_BOT_TOKEN / WEIXIN_ALLOWED_USER_IDS / DEEPSEEK_API_KEY（不进版本库）
├── .env.example
├── src/
│   ├── config.js       ✅  读 .env 与 config/bridge.json
│   ├── util.js         ✅  ID 列表解析、白名单判定
│   ├── ledger.js       ✅  记账服务的 HTTP 客户端（桥接不碰数据库）
│   ├── index.js        ✅  入口（--echo 回显 / --brief 只看日报）
│   ├── weixin/
│   │   ├── login.js    ✅  扫码登录（产出 token 与 ilink_user_id）
│   │   ├── client.js   ✅  长轮询、发送、401 处理、退避、白名单闸门
│   │   └── context.js  ✅  context_token 持久化
│   ├── llm/
│   │   ├── client.js   ✅  OpenAI 兼容客户端（baseUrl 可配，见 §9）
│   │   └── prompt.js   ✅  抽取提示词 + 建议措辞提示词
│   ├── handler/
│   │   ├── router.js   ✅  意图路由（确定性指令 vs 交给 LLM）
│   │   ├── commands.js ✅  撤销/余额/报表等确定性指令
│   │   ├── record.js   ✅  记账流程（含草稿确认）
│   │   ├── drafts.js   ✅  未决草稿落盘（设计外的补充）
│   │   ├── compose.js  ✅  回执 / 追问 / 日报措辞
│   │   └── brief.js    ✅  日报：措辞 + 主动推送 + 重试
│   └── scheduler.js    ✂️  未做——「每日 08:30」改成了开机推送，见 §6
└── test/
    ├── probe.js        ✅  接口可达性探测
    ├── parse.test.js   ✅  消息解析与切分（16 项）
    ├── gate.test.js    ✅  白名单与配置链路（22 项）
    ├── llm.test.js     ✅  LLM 客户端（16 项）
    ├── handler.test.js ✅  主链路集成测试（20 项）
    └── brief.test.js   ✅  日报推送（17 项）
```

跑测试：`cd bridge && npm test`

### 零依赖的意义

不引入任何 npm 运行时依赖（连 `dotenv` 都是自己解析的 `.env`），意味着：

- 没有供应链风险
- 不会因为某个包停止维护而失效
- 整个桥接可以随时重写或替换，成本极低

唯一保留的可选依赖是 `qrcode-terminal`，只用它把登录二维码画到终端；
不装也能跑，会退化成打印二维码内容让用户自己扫。

## 9. LLM 供应商与模型选择

**已定：`deepseek-v4-flash` 为默认。配置层做成供应商无关 —— 换一家只改
`config/bridge.json` 的 4 个字段 + 填一个 API key，不用动代码。**

完整的价格 / 能力 / 避坑对比见 [`08-LLM选型对比.md`](08-LLM选型对比.md)，这里只给结论。

### 9.1 为什么可以随时换

DeepSeek 与智谱 GLM **都提供 OpenAI 兼容接口**，请求体、响应体、`response_format`
用法一致，所以两家的差异全部收敛成 4 个配置字段：

| 字段 | DeepSeek | 智谱 GLM |
| --- | --- | --- |
| `provider` | `deepseek` | `glm` |
| `baseUrl` | `https://api.deepseek.com` | `https://open.bigmodel.cn/api/paas/v4` |
| `model` | `deepseek-v4-flash` | `glm-4.7-flash` |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | `GLM_API_KEY` |

外加 `extraBody`：DeepSeek 需要 `{"thinking":{"type":"disabled"}}` 关掉思考，
GLM 换成 `{}`。`apiKeyEnv` 存的是**环境变量名**而非 key 本身，所以 key 永远不进配置文件。

### 9.2 选型结论

| 用途 | 选谁 | 理由 |
| --- | --- | --- |
| 每笔账抽取（默认） | `deepseek-v4-flash` | 可关思考；缓存命中价最低（¥0.05/M）；Json Output 稳定 |
| 每笔账抽取（省钱档） | `GLM-4.7-Flash`（**免费**） / `GLM-4.5-Air` | 成本趋近于 0 |
| 每日晨报措辞 | 与抽取同一家 | 少管一个 key |
| 图片账单（M4） | **`GLM-OCR`**（¥0.2/M）或 `GLM-4.6V-Flash`（免费） | 比通用视觉模型便宜一个数量级 |

> ⚠️ **避坑：不要用 `GLM-5.3` / `GLM-5.3-Flash` / `GLM-4.7` 做抽取。**
> 官方明确这几个型号（以及 `GLM-4.5V`）**强制思考、不允许关闭**，传
> `thinking.type=disabled` 会直接报错。对「一句话 → 几个字段」这种任务，
> 思考纯粹是延迟开销。
>
> 换句话说：**钱不是问题（一年 ¥0~15），能不能关思考才是问题。**

### 9.3 成本（用官方价目表算）

一次抽取约 700 输入 + 150 输出，其中系统提示词是稳定前缀（约 500 token）可命中缓存。
`deepseek-v4-flash` 空闲时段单价为 ¥1.5 / ¥0.05 / ¥4.5（每百万 token，依次为
未命中输入 / 命中输入 / 输出）：

```
200 × 1.5/1e6 + 500 × 0.05/1e6 + 150 × 4.5/1e6 ≈ ¥0.001 每笔
```

一天 20 笔 ≈ **¥0.02**，一年 ≈ **¥7.3**（若全部撞上高峰时段则翻倍，¥14.6）。
换成免费的 `GLM-4.7-Flash` 就是 **¥0**。

**结论：这个量级不该作为选型依据。** 真正该看的是一致性与延迟，见 §9.2 的避坑。

**对比一下 agent 平台方案**——每笔账要跑一次完整 agent 轮次（数千至上万 token），
成本高两到三个数量级。所以「自写桥接 + LLM API」的省钱效果，主要来自**架构**，
而不是来自选哪一家。

### 9.4 上下文缓存策略

DeepSeek 的磁盘缓存**默认开启**，命中条件是完全匹配一个缓存前缀单元；
GLM 的缓存需在请求里显式开启（缓存存储当前限时免费）。
两家都遵循同一个组织原则：

```
[系统提示词：角色 + 分类清单 + 格式示例 + 字段说明]   ← 固定不变，构成稳定前缀
[用户消息：今天是 2026-09-10 星期四。用户消息：「昨天午饭35」]  ← 每次都变
```

**分类清单要放在系统提示词里，不要拼进用户消息**——否则前缀每次都变，缓存永远不命中。
注意：分类清单一旦变动，缓存会失效重建。这没关系，改分类是低频操作。

### 9.5 已知问题与应对

| 问题 | 官方说明 | 应对 |
| --- | --- | --- |
| **偶尔返回空内容** | DeepSeek 官方承认「使用 JSON Output 时 API 偶尔会返回空内容」 | 最多重试 2 次；仍失败则回一句「刚才没听清，再说一次？」 |
| JSON 被截断 | 需合理设置 `max_tokens` | 设 500，远超实际需要的约 150 |
| 思考模式默认开启 | DeepSeek effort 默认 high | 显式 `thinking: {type:"disabled"}`，见 §5.3 |
| **GLM-5.3 系列关不掉思考** | 官方说明传 `disabled` 会报错 | 抽取改用 `GLM-4.7-Flash` / `GLM-4.5-Air` |
| 两家都不支持 `json_schema` | 只支持 `{"type":"json_object"}` | 提示词清单 + 服务端强校验两层防线，见 §5.2 |

## 10. 已知限制（沿用 iLink API 的约束）

| 限制 | 影响 | 应对 |
| --- | --- | --- |
| 仅私聊，无群聊 | — | 符合需求 |
| **无法读取你的其他会话** | 本就拿不到，不必担心隐私 | 反过来说，bot 被谁加进通讯录是唯一的暴露面，靠白名单兜住（§2.7） |
| 无历史消息拉取 | 桥接无法回顾对话 | 每条消息独立处理；`raw_text` 入库 |
| 单条 2000 字符 | 长回复被截断 | 回执压到 8 行内，超长主动切分 |
| token 会过期（401） | 突然收不到消息 | 明确告警，重跑 `npm run login` |
| `context_token` 可能过期 | 主动发送失败 | 持久化 + 打招呼兜底（§7） |
| 无 typing 状态 | 用户不知在处理 | 回执要快；慢操作先回一句「稍等」 |
| iLink 非微信开放平台官方接口 | 协议可能变更 | 桥接独立隔离，出问题只改 `bridge/`，账本不动 |

## 11. 防幻觉清单

- [ ] 分类与类型用「提示词清单 + 服务端强校验」双重约束（两家都不支持 `json_schema` 严格模式），不给模型编造空间
- [ ] 相对时间由服务端换算，模型只输出可为 null 的 `date`
- [ ] 模型的 `confidence` 与服务端评分取较低值
- [ ] 只发送当前消息，不发聊天历史
- [ ] 所有金额、余额、占比来自服务端 SQL，模型不做算术
- [ ] 回执优先复用服务端返回的 `message` 字段
- [ ] 建议只来自 `signals`，空数组时输出固定话术
- [ ] 撤销、余额这类确定性指令不经过 LLM
- [ ] 幂等键 = 微信 `client_id`，重试不重复记账
- [ ] 大额、金额缺失、转账三类走硬规则确认，不受置信度影响
- [ ] 只处理白名单发送者的消息，非白名单连 `context_token` 都不记（§2.7）

## 12. 排障速查

| 现象 | 排查 |
| --- | --- |
| 收不到消息 | 长轮询是否在跑；是否返回 401（token 过期） |
| 能收不能发 | 该用户的 `context_token` 是否已缓存且未过期 |
| 晨报没来 | 进程是否重启过；`report_log` 是否有今日记录；降级路径是否触发 |
| 分类总是「待分类」 | 检查提示词里的分类清单是否与数据库分类一致（服务端校验会兜底，但清单不同步会频繁触发） |
| 记账重复 | `client_id` 去重是否生效；`idem_key` 是否传了 |
| LLM 报错频繁 | 检查 `baseUrl` 与模型名；超时设长一点；加重试 |
| 回复被截断 | 超过 2000 字符，压缩输出或分条发送 |
| 别人给 bot 发消息也记了账 | 未设 `WEIXIN_ALLOWED_USER_IDS`，启动日志里应有告警；填上自己的 `ilink_user_id` |
| 白名单生效后自己也发不进去了 | 白名单值填错了，必须与 `npm run login` 打印的 `ilink_user_id` 完全一致 |
| 异常慢 / 输出变长 | LLM 思考模式没关掉；检查 `llm.extraBody`，并确认用的不是 `GLM-5.3` 系列（关不掉思考） |