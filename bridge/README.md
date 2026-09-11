# bridge · 微信记账桥接

iLink 长轮询收消息 + LLM 结构化抽取 + 调用 ledger。

设计见 `../docs/04-自写微信桥接与LLM接入.md`，
LLM 选型见 `../docs/08-LLM选型对比.md`。

## 运行环境

- Node.js **≥ 20**（本机 22.16 ✅）
- 运行时**零 npm 依赖**，只用 Node 内置的 `fetch` / `node:crypto`
- 唯一的可选依赖 `qrcode-terminal` 只用于登录时在终端渲染二维码

## M-1：连通性验证

### 1. 探测接口可达性（不需要登录）

```powershell
cd bridge
node test/probe.js
```

期望输出：

```
HTTP     : 200 OK
耗时     : xxxms
有 qrcode : true
ret      : 0
结论：接口可达，可以跑 npm run login
```

### 2. 配置

```powershell
Copy-Item .env.example .env
```

### 3. 扫码登录，拿 token

```powershell
npm run login
```

终端会显示二维码，用手机微信扫码并确认。成功后打印：

```
Token     : xxxxxxxx-xxxx-...
User ID   : xxxxxxxx
把下面两行填进 bridge/.env：

  WEIXIN_BOT_TOKEN=...
  WEIXIN_ALLOWED_USER_IDS=...
```

**两行都填进 `.env`。** 第二行就是白名单，见下一节。

> Token 等同你微信账号的收发信权限，**不要提交到版本库**（`.env` 已在 `.gitignore` 里）。

### 4. 跑回显测试

```powershell
npm start
```

看到白名单状态后，用手机微信给这个号发一条消息。期望：

- 控制台打印出发送者、消息 ID、内容
- 微信里收到回执
- 回执里也带上你的发送者 ID，方便核对白名单

### 5. 验证通过的标准

- [ ] `node test/probe.js` 返回 200
- [ ] `npm run login` 能扫码并拿到 token
- [ ] 收得到消息，控制台有打印
- [ ] 发得出去消息，微信里能看到回执
- [ ] `WEIXIN_ALLOWED_USER_IDS` 已填，启动日志显示「白名单已启用」
- [ ] 用另一个微信号给 bot 发消息，控制台显示「已忽略非白名单发送者的消息」
- [ ] Ctrl+C 能干净退出

## M2：让它真的记账

回显模式（M-1）验证完通道之后，就可以跑真正的记账闭环了。**不需要加任何参数**：

```powershell
npm start
```

启动时会自检两个依赖，两个都不致命，但都会明确报出来：

```
✅ 记账服务在线（服务端今天：2026-09-10）
⚠️  没读到 DEEPSEEK_API_KEY，本轮只用服务端规则解析。
```

### 消息是怎么被处理的

分层顺序在 `src/handler/router.js`（对应 `docs/04` §4、`docs/09` §4）。
**一个 bot 两副面孔（记账 / 陪聊）**，所以分层的顺序本身就是分流：

```
收到消息
  ├─ 有未决草稿？ ── 确认词 → 落库 ｜ 取消词 → 丢弃 ｜ 都不是 → 撤掉草稿继续往下
  ├─ /记 xxx、/聊 xxx？ ── 强制走记账 / 强制走陪聊（闸门判错了，你说了算）
  ├─ 记账确定性指令？ ── 撤销 / 余额 / 本月 / 今天 / 昨天 / 最近 / 帮助
  │                      → 直接办，完全不经过 LLM（省钱，也不会出错）
  │                      （「你好」在陪聊开着时转陪聊，不甩报表回来）
  ├─ 陪聊指令？ ── /记忆 /记住 /忘记 /清空 /重置 /人设 /重说 → 同样不过模型
  ├─ 看不出任何金额线索？ ──► 陪聊（省一次抽取调用）
  └─ 其余 ──► LLM 抽取 → POST /api/parse 强校验 → 落库 / 追问 / 出草稿
                 └─ 模型说 is_ledger=false ──► 转陪聊
```

桥接自己**不算日期、不算金额、不校验分类**——这三件事全在 `POST /api/parse` 里做。
桥接问服务端「今天是几号」，而不是看自己的系统时钟。

> **陪聊不会让账变少。** 词法闸门（`src/chat/gate.js`）只在「阿拉伯数字 / 钱的数词 /
> 钱的字样 / 收支动词」全都没有时才判闲聊；拿不准的一律往记账链路送，由模型的
> `is_ledger` 再判一次（提示词里写着「拿不准时填 true」）。代价是不对称的：
> 把账判成闲聊会丢钱，把闲聊判成账只是多问一句。

### LLM 是可选的

没有 key 也能用：桥接跳过 LLM，直接调服务端的 `/api/parse`（纯规则解析）。
回执末尾会注明「本轮没有用上模型，按本地规则解析」——不会假装那是模型的判断。

规则解析对「午饭35」「昨天超市买菜76.5」这类标准说法够用；
口语化、要素省略的说法（「请老王吃饭花了两百多」）就明显不如模型了。

### 配置项

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` / `GLM_API_KEY` | `bridge/.env` | 填哪个由 `config/bridge.json` 的 `llm.provider` 决定 |
| `llm.provider` / `baseUrl` / `model` | `config/bridge.json` | 任意 OpenAI 兼容供应商，换家只改这几行 |
| `llm.extraBody` | `config/bridge.json` | 默认关掉 DeepSeek 的思考模式（贵、慢、没收益） |
| `confirmThresholdCents` | `config/bridge.json` | 大额二次确认阈值，默认 20000（200 元） |
| `draftTtlMinutes` | `config/bridge.json` | 未决草稿的存活时间，默认 30 分钟 |
| `pushBriefOnStart` | `config/bridge.json` | 桥接启动时推一次日报，默认 `true` |
| `briefCheckMinutes` | `config/bridge.json` | 日报看门狗的检查间隔（分钟），默认 15 |
| `LEDGER_BASE_URL` | `bridge/.env` | 记账服务地址，默认 `http://127.0.0.1:8787` |
| `chat.enabled` | `../config/bridge.json` | 陪聊开关，默认 `true`；设 `false` 立刻回到「只用记账」 |
| `chat.llm.*` | `../config/bridge.json` | 聊天用的 `model` / `temperature` / `maxTokens`；`baseUrl`、key、`extraBody` 继承记账那份 |
| `chat.persona` | `../config/bridge.json` | 人设：名字、描述、说话方式，或整段自写提示词 |
| `chat.memory.*` | `../config/bridge.json` | 窗口轮数（24）、整理频率（12 轮）、事实上限（40）、失败冷却（10 分钟） |
| `chat.greetOnStart` / `greetIdleHours` | `../config/bridge.json` | 开机主动打声招呼（默认关）；距上次聊天超过 N 小时才发，免得反复重启就反复骚扰 |
| `CHAT_ENABLED` / `CHAT_LLM_MODEL` | `bridge/.env` | 临时关掉陪聊 / 只给聊天换模型，不动配置文件 |

### 草稿为什么落盘

和 `context_token` 同理：大额记账会先出草稿问你一句「确认吗」，如果这时桥接重启了，
草稿不能凭空消失——否则你回一句「是」就石沉大海了。
草稿存在 `../data/bridge-drafts.json`，默认 30 分钟过期。

## M3：日报与开机推送

`handler/brief.js` 负责把服务端的日报数据变成一条微信消息，并在你开机时推出去。

```powershell
node src/index.js --brief     # 只打印今天的日报（不发、不标记），先看看会收到什么
```

- **触发**：桥接启动时推当天那一份（`pushBriefOnStart`，默认开）。
  不用定时 08:30：电脑不是 24 小时开着，定时任务在关机期间只会白白错过。
- **休眠唤醒也能补上**：进程没重启时靠看门狗（每 15 分钟问一次「今天推过没」），
  凌晨 6 点前不推。这一条是必需的——休眠唤醒的电脑不会触发「启动推送」。
- **一天只推一次**：由服务端 `report_log` 去重。发送**成功之后**才写记录——顺序反了的话，
  一次发送失败就会让这天的日报永远补不回来。
- **推不出去会重试**：启动阶段最多 6 次、每次间隔 1 分钟（开机时网络可能刚起来）。
- **建议优先由 LLM 措辞**，但数字全部来自服务端 `signals`；模型罢工就退回固定文案。
  模型拿到的输入里只有算好的事实，它没有机会编数。
- **打招呼**：当天第一次「你好」给完整日报，之后只报数字，不刷屏。

日报长这样（真实输出）：

```
🐾 记账日报 · 9月10日

昨天没有记账
本月至今 支出 ¥57.00 ｜ 收入 ¥0.00
余额 ¥31,296.00（现金流 ¥1,536.00 ｜ 储蓄 ¥29,760.00）

💡 建议
· 本月还没设预算——设了月度预算，我才好提醒你花得快不快
```

> **发不了图片。** iLink Bot API 的发送接口只接受文本（`item_list: [{type:1, text_item}]`），
> 图片那条 CDN 路径只用于**下载**你发来的图。所以日报是纯文字的，要图就看网页。

## 陪聊：和记账同一个 bot

**为什么不另开一个 bot**：微信通道是「和你账号绑定的那一个 bot 私聊」，而一个微信号
只挂得下一个 bot——再扫一次码不会多出一个联系人，它会把原来那个顶掉（登录时就会提示
「连接新的 Bot 会解除原有的连接」）。让两个进程共用同一个 token 也不行：长轮询靠一个
同步游标推进，两个进程去拉就是互相抢消息，而且不报错。所以只能一个进程、一张嘴，
在 `handler/router.js` 里分流。完整推理见 `../docs/09-微信陪聊BOT.md` §2。

| 你说 | 走哪条路 |
| --- | --- |
| `午饭35`、`存了2000` | 记账（有数字 / 钱的字样 / 收支动词） |
| `今天好累`、`你在干嘛` | 陪聊（一点金额线索都没有） |
| `等了三十分钟` | 先按记账送进去，模型判 `is_ledger=false` 后转陪聊 |
| `/聊 今天好累` | 强制陪聊 |
| `/记 买菜` | 强制记账 |
| `你好` / `在吗` | 陪聊（不会再甩一份报表回来） |
| `撤销` / `余额` / `本月` / `最近` | 记账指令，本地办完 |

聊天时说人话就行，另有这几个开关（全部本地办完，不过模型）：

| 指令 | 不带斜杠也认 | 做什么 |
| --- | --- | --- |
| `/记忆` | 你记得我什么 | 打印事实清单 + 最近聊到 |
| `/记住 xxx` | — | 加一条长期记忆 |
| `/忘记 xxx` | — | 删掉含关键词的记忆 |
| `/清空` | — | 忘掉最近这段对话，长期记忆留着 |
| `/重置` | 清空记忆、忘记一切 | 连长期记忆一起清 |
| `/人设` | 你是谁 | 打印当前人设 |
| `/重说` | 重来一遍 | 上一句答得不好，换个说法重来 |

记忆在 `../data/chat-memory.json`（和草稿、游标分开存）。不连微信先试一句：

```powershell
npm run say  -- "今天好累"     # 真调模型、真写记忆
npm run say  -- "/记忆"         # 看它记住了什么
npm run chat -- --digest        # 手动整理一次长期记忆
npm run chat -- --greet         # 预览开机问候（不发出去）
```

`npm run say` 默认用白名单里的第一个号当身份，所以试出来的记忆跟微信里是同一份。

**关掉陪聊**（回到加它之前的行为）：`../config/bridge.json` → `chat.enabled: false`，
或临时 `CHAT_ENABLED=0`。

## 白名单：只认你一个人

微信通道**不是读你的微信**，而是你和一个 bot 单独聊天。API 没有「拉聊天列表」
「读历史消息」这类能力，所以你的其他会话本来就看不到。

但 bot 一旦被别人加进通讯录，**他的消息也会进记账流程**。所以在最前面加了一道闸门：

| 配置项 | 位置 |
| --- | --- |
| `WEIXIN_ALLOWED_USER_IDS` | `bridge/.env`（优先） |
| `weixin.allowedUserIds` | `../config/bridge.json` |

- 取值 = 登录时打印的 `ilink_user_id`，多个用逗号分隔
- 留空 = 不限制，**启动时会打印告警**，只建议 M-1 调试阶段这么用
- 非白名单消息**连 `context_token` 都不记录**，从根上杜绝晨报误发
- 主动发送（晨报）同样受约束，不在名单里直接抛 `SenderNotAllowedError`

## 测试与自检

```powershell
npm test          # 全部离线跑，不打真网络（真服务 + 假 LLM / 假微信）
npm run live      # 真打一次模型：验证 key、提示词、服务端强校验这条链路
```

`npm run live` 不发微信、不写账本（走 `/api/parse` 干跑），会依次打印：
模型原始输出 → 服务端强校验后的结果 → 用真实日报数据生成的建议。
配完 key 先跑这个，别等记账失败了才发现 key 是错的。

- `test/parse.test.js` —— 消息解析（文本/语音转写/图片占位/bot 消息过滤）与超长切分
- `test/gate.test.js` —— 白名单判定、拒发、`.env` → 配置链路
- `test/llm.test.js` —— LLM 客户端：空内容重试、401 不重试、请求体必须关掉思考模式
- `test/handler.test.js` —— 主链路集成测试：真记账服务（内存库 + 随机端口）+ 假 LLM，
  覆盖落库、幂等、硬规则、草稿确认、补金额、降级、服务不可达
- `test/chat-gate.test.js` —— 分流闸门：词法快筛、`/聊` `/记` 强制前缀
- `test/chat-router.test.js` —— 分流集成测试：真 router + 假账本 / 假模型，逐层验「哪句话走哪条路」
- `test/chat-engine.test.js` —— 陪聊引擎：指令本地办完、一次调用换一句回复、整理走后台
- `test/chat-memory.test.js` —— 记忆落盘：滚动窗口、事实清单、原子写、坏文件兜底
- `test/chat-persona.test.js` —— 提示词的稳定前缀（同一份人设 + 记忆 → 同一份 system）
- `test/chat-llm.test.js` —— 聊天客户端：宽松 JSON 解析、空回复重试
- `test/chat-reply.test.js` —— 剥 markdown 壳、只有图片时的兜底

## 目录

```
bridge/
├── .env                  # 本地配置（不入库）
├── .env.example
├── package.json          # 运行时零依赖
├── src/
│   ├── config.js         # 配置加载与 .env 解析
│   ├── util.js           # ID 列表解析、白名单判定
│   ├── ledger.js         # 记账服务的 HTTP 客户端（桥接不碰数据库）
│   ├── index.js          # 入口（--echo 回显模式 / --brief 只看日报）
│   ├── weixin/
│   │   ├── login.js      # 扫码登录
│   │   ├── client.js     # 长轮询 + 发送 + 白名单闸门（核心）
│   │   └── context.js    # context_token 持久化
│   ├── llm/
│   │   ├── client.js     # 一次调用，OpenAI 兼容；重试与关闭思考模式
│   │   └── prompt.js     # 系统提示词（含分类清单）与用户消息
│   ├── handler/
│   │   ├── router.js     # 消息 → 意图 → 动作；**分流就在这一层**（docs/09 §4）
│   │   ├── commands.js   # 确定性指令：撤销/余额/报表/帮助/打招呼
│   │   ├── record.js     # LLM 抽取 → 服务端强校验 → 落库 / 追问；is_ledger=false 转陪聊
│   │   ├── compose.js    # 回执 / 追问 / 日报的措辞（数字全部来自服务端）
│   │   ├── brief.js      # 日报：措辞 + 主动推送 + 重试
│   │   └── drafts.js     # 未决草稿，落盘 data/bridge-drafts.json
│   └── chat/             # 陪聊（和记账同一个 bot，docs/09）
│       ├── index.js      # 对记账侧暴露的四个入口：isCommand / looksLikeLedger / respond / greet
│       ├── gate.js       # 词法闸门 + `/聊` `/记` 强制前缀
│       ├── engine.js     # 一句话进、一句回复出；不碰微信，所以能单测
│       ├── memory.js     # 滚动窗口 + 事实清单 + 摘要，原子写
│       ├── digest.js     # 攒够轮数后台整理一次长期记忆
│       ├── persona.js    # 系统提示词（稳定前缀，为了缓存）与时间戳
│       ├── reply.js      # 剥 markdown 壳、只有图片时的兜底
│       ├── llm.js        # 聊天用的模型客户端（温度、宽松 JSON）
│       ├── commands.js   # /记忆 /记住 /忘记 /清空 /重置 /人设 /重说
│       └── cli.js        # 本地试聊（npm run say / npm run chat）
└── test/
    ├── probe.js          # 接口可达性探测
    ├── live.js           # 真打一次模型（验证 key / 提示词 / 强校验）
    ├── parse.test.js     # 消息解析单测
    ├── gate.test.js      # 白名单与配置单测
    ├── llm.test.js       # LLM 客户端（重试 / 不重试 / 请求体）
    ├── handler.test.js   # 主链路集成测试（真服务 + 假 LLM）
    ├── brief.test.js     # 日报推送（去重 / 失败可重试 / 措辞降级 / 打招呼）
    └── chat-*.test.js    # 陪聊：闸门 / 路由分流 / 引擎 / 记忆 / 人设 / 客户端 / 剥壳
```

## 关键实现说明

### 为什么 context_token 要落盘

golembot 把它放在内存里，进程重启就丢，导致**重启后无法主动发送任何消息**。
我们持久化到 `../data/weixin-context.json`，重启后晨报仍发得出去（`src/weixin/context.js`）。

### 白名单闸门的位置

放在 `#handleUpdate` 里、**记 `context_token` 之前**。这个顺序很重要：
只要没进白名单，就不会在 `weixin-context.json` 里留下任何记录，
日后主动发送时也不可能把晨报发给陌生人。

### 轮询超时与退避

服务端单次最多阻塞 35 秒，客户端设 40 秒超时留余量。
超时不算错误，立即发起下一次；真正的错误走指数退避 `1s→2s→4s→…→30s`。

**HTTP 401 = token 失效**，会停止轮询并明确告警，不静默失败。

### 消息去重

按 `client_id` 去重（上限 500 条，超出保留后半段）。
这与 ledger 的 `idem_key` 形成双保险。

## 排障

| 现象 | 排查 |
| --- | --- |
| `probe.js` 网络失败 | 检查代理/DNS；确认能访问 `ilinkai.weixin.qq.com` |
| 登录二维码不显示 | 未装 `qrcode-terminal`，会退化打印内容，可手动生成二维码扫描 |
| 启动报「缺少 WEIXIN_BOT_TOKEN」 | 没跑 `npm run login` 或没填 `.env` |
| 启动报「未设置 WEIXIN_ALLOWED_USER_IDS」 | 只是告警不是错误；填上 `ilink_user_id` 即可消除 |
| 收不到消息 | token 是否过期；控制台是否有 401 |
| 能收不能发 | 该用户是否给 bot 发过消息（主动发送需要 context_token） |
| 自己发的消息被忽略 | 白名单填错了，必须与日志里的发送者 ID 完全一致 |
| 登录返回的 baseUrl 与默认不同 | 在 `../config/bridge.json` 里改 `weixin.baseUrl` |
| 回执带「本轮没有用上模型」 | 正常：没配 LLM key，或这一轮 LLM 超时/报错，已降级到规则解析 |
| 启动提示「记账服务没在跑」 | 桥接只调 HTTP，不碰数据库；先 `npm run serve` |
| 分类总是「待分类」 | 提示词里的分类清单来自 `/api/categories`，不匹配时服务端会兜底。若整批都这样，检查模型是否在自创分类 |
| 大额记账总要确认 | 这是设计：`confirmThresholdCents` 默认 200 元，改 `../config/bridge.json` 可调 |
| 回一句「是」没反应 | 草稿默认 30 分钟过期；超时后重说一遍原话 |
| 转账记不进去 | 转账要指定转出/转入账户，微信里问不明白，去网页上记（除「存了 N」这类固定路线） |
| 闲聊被当成账，反问「多少钱」 | 换成 `/聊 xxx`；或把 `src/chat/gate.js` 的收支动词表收窄一点 |
| 陪聊整个不生效 | 看启动横幅的「陪聊 :」那行；`../config/bridge.json` → `chat.enabled` 是否为 true |
| 它回「我还没接上大脑」 | 没读到模型 key：确认 `bridge/.env` 里有 `DEEPSEEK_API_KEY` |
| 它记不住以前说过的 | `/记忆` 看事实清单；窗口默认 24 条，更早的靠后台整理留下 |
| 自言自语「刚走神了」 | 模型一直返回空内容：换 `chat.llm.model`，或看是否被限流 |