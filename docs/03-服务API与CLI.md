# 03 服务 API 与 CLI

## 1. 服务概览

| 项 | 值 |
| --- | --- |
| 默认监听 | `127.0.0.1:8787` |
| 数据库 | `data/ledger.db`（SQLite, WAL） |
| 静态页面 | 同一服务托管，浏览器直接开 `http://127.0.0.1:8787` |
| 启动 | `ledger serve`（或 `npm run serve`，开发时带热更新） |
| 时区 | 固定 `Asia/Shanghai` |

配置文件 `config/config.json`：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "dbPath": "data/ledger.db",
  "timezone": "Asia/Shanghai",
  "defaultAccountId": 1,
  "confirmThresholdCents": 20000,
  "draftTtlMinutes": 30,
  "rules": {
    "expenseSpikeRatio": 1.8,
    "expenseSpikeMinCents": 10000,
    "budgetPaceGapPp": 0.15,
    "balanceLowDays": 7,
    "noRecordMinDays": 2
  }
}
```

## 2. REST 端点

### 汇总与报表

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/summary/dashboard` | 首屏一把拿齐：余额 + 今日 + 昨日 + 本月 + 折线 + 饼图 + 信号 |
| GET | `/api/summary/day?date=2026-09-10` | 单日收支与分类明细 |
| GET | `/api/summary/month?month=2026-09&level=1` | 单月收支、分类占比、同期对比 |
| GET | `/api/summary/balance` | 各账户余额 |
| GET | `/api/report/brief?kind=morning` | 晨报数据（供桥接措辞），见 §5 |
| POST | `/api/parse` | **干跑解析，只算不写**。不传 `extracted` 是纯规则解析；传了则做 LLM 结果的服务端强校验（分类归一、时间换算、置信度、硬规则） |

### 流水

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/transactions?from=&to=&categoryId=&type=&page=&size=` | 分页明细，默认按时间倒序 |
| POST | `/api/transactions` | 新增一笔 |
| PATCH | `/api/transactions/:id` | 修改（改分类、改备注、改金额） |
| POST | `/api/transactions/:id/void` | 撤销（软删除） |
| POST | `/api/transactions/:id/restore` | 恢复 |

### 草稿（大额二次确认）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/drafts` | 创建待确认草稿，返回短码 |
| POST | `/api/drafts/:id/confirm` | 确认 → 落库 |
| POST | `/api/drafts/:id/cancel` | 取消 |
| GET | `/api/drafts/pending` | 当前未决草稿（桥接判断是否处于确认流程） |

### 基础数据

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST/PATCH | `/api/categories[/:id]` | 分类管理 |
| GET/POST/PATCH | `/api/accounts[/:id]` | 账户管理（含期初余额） |
| GET/PUT | `/api/budgets` | 月度预算 |
| GET | `/api/export?format=csv\|json` | 全量导出 |

> ⚠️ 表里 `PATCH /api/transactions/:id`、`POST /api/transactions/:id/restore`、
> `categories` 的写接口（POST/PATCH）**还没实现**（截至 2026-09-11）。
> 「改一笔的分类」现在走 `ledger edit`；网页上还没做入口。
| GET | `/api/stream` | SSE 事件流 |
| GET | `/api/health` | 健康检查（CLI/Automations 探活） |

## 3. 关键契约示例

### 3.1 新增流水 `POST /api/transactions`

请求：

```json
{
  "type": "expense",
  "amountCents": 3500,
  "category": "食品餐饮",
  "note": "午饭",
  "accountId": 1,
  "occurredAt": "2026-09-10 12:30:00",
  "source": "wechat",
  "sourceMsgId": "weixin_xxx_8821",
  "idemKey": "wx:acc1:chat1:msg8821",
  "rawText": "午饭35"
}
```

- `category` 接受一级名、二级名或 `"食品餐饮/午饭"` 路径，也接受 `categoryId`
- `amountCents` 可换成 `amountText: "35"`，服务端负责转分（CLI 默认走这条）
- `occurredAt` 缺省为服务端当前时间（必须由服务端决定，不信客户端）

成功响应：

```json
{
  "ok": true,
  "data": {
    "id": 10231,
    "type": "expense",
    "amountCents": 3500,
    "category": { "id": 12, "name": "午饭", "path": "食品餐饮/午饭" },
    "account": { "id": 1, "name": "微信钱包" },
    "occurredAt": "2026-09-10 12:30:00",
    "note": "午饭",
    "deduplicated": false,
    "snapshot": {
      "balanceTotalCents": 423150,
      "todayExpenseCents": 12850,
      "monthExpenseCents": 328050
    }
  },
  "message": "已记：午饭 支出 ¥35.00（食品餐饮/午饭）｜今日支出 ¥128.50｜总余额 ¥4,231.50"
}
```

两个刻意的设计：

- **`deduplicated: true` 不当作错误。** 幂等命中时正常返回既有记录（HTTP 200）。
  桥接就永远不用处理「重复记账」这个分支。
- **`message` 由服务端渲染。** 桥接可以直接转发这句话——即使模型这一轮发挥失常，
  用户拿到的回执仍是准确的。这是「降级可用」的保险。

### 3.2 错误响应 —— 面向调用方设计

```json
{
  "ok": false,
  "error": {
    "code": "CATEGORY_NOT_FOUND",
    "message": "分类「吃放」不存在",
    "hint": "请改用已有分类，或使用「待分类」",
    "candidates": ["食品餐饮", "食品餐饮/午饭", "食品餐饮/外卖"]
  }
}
```

`candidates` 由模糊匹配给出。**错误响应是给调用方（桥接 / LLM）看的**，所以要包含足以自我纠正的信息，
而不是一句 `400 Bad Request`。错误码表：

| code | HTTP | 含义 | 调用方应采取的动作 |
| --- | --- | --- | --- |
| `BAD_AMOUNT` | 400 | 金额无法解析或 ≤ 0 | 反问用户金额 |
| `CATEGORY_NOT_FOUND` | 400 | 分类不存在 | 从 `candidates` 选，或改「待分类」 |
| `ACCOUNT_NOT_FOUND` | 400 | 账户不存在 | 从 `candidates` 选 |
| `DATE_IN_FUTURE` | 400 | 时间在未来 | 反问确认，或改为今天 |
| `DUPLICATE` | 200 | 幂等命中（非错误） | 正常回执，说明已存在 |
| `DRAFT_EXPIRED` | 410 | 草稿过期 | 重新创建草稿 |
| `DRAFT_CONFLICT` | 409 | 草稿已确认/取消 | 告知用户当前状态 |
| `SERVICE_DOWN` | — | CLI 连不上服务 | 提示用户启动服务（exit code 5） |

### 3.3 SSE 事件流 `GET /api/stream`

```
event: hello
data: {"serverTime":"2026-09-10 13:05:00"}

event: tx.created
data: {"id":10231,"date":"2026-09-10","type":"expense","amountCents":3500,"categoryName":"食品餐饮"}

event: tx.updated
data: {"id":10231}

event: tx.voided
data: {"id":10231}

event: report.sent
data: {"kind":"morning","date":"2026-09-10"}

event: budget.updated
data: {"month":"2026-09","budgetCents":400000}     ← 网页据此刷新「本月预算」卡片

:heartbeat
```

前端处理策略：**收到任一事件 → 节流 300ms → 重拉 `/api/summary/dashboard`**。
个人记账的数据量下，整页重拉比精细的增量更新更简单也更不容易出错。
`EventSource` 自带断线重连，服务端无需额外补偿逻辑。

### 3.4 月度预算 `GET|PUT /api/budgets`

**范围只有一件事：本月总预算。** 分类预算见 `docs/02` §2 的说明（没实现，也不暴露参数）。

```
GET /api/budgets?month=2026-09        # month 省略 = 本月
→ { "ok": true, "data": {
      "month": "2026-09", "status": "ok",
      "budgetCents": 400000, "spentCents": 7490, "remainingCents": 392510,
      "dailyAllowanceCents": 19625,
      "daysElapsed": 10, "daysInMonth": 30, "daysLeft": 20,
      "timeProgress": 0.3333, "spentProgress": 0.0187, "paceGapPp": -0.3146 } }

PUT /api/budgets   { "amountCents": 400000, "month": "2026-09" }   # month 可省略
→ { "ok": true, "data": { ...同上... }, "message": "已设置 2026-09 预算" }
```

| 字段 | 口径 |
| --- | --- |
| `status` | `none` 没设 / `ok` 正常 / `watch` 比时间进度快 ≥ 15pp / `over` 已超支 |
| `daysElapsed` | **含今天**（9/10 → 10 天），与网页上那行「已过 10/30 天」同一口径 |
| `daysLeft` | **不含今天**（9/10 → 20 天）；`dailyAllowanceCents` 就是按它摊的 |
| `budgetCents = 0` 时 | `remainingCents` / `dailyAllowanceCents` / `spentProgress` / `paceGapPp` 一律 `null` |

两条约定值得单独说：

- **`amountCents: 0`（或负数）= 取消预算**，删掉这一行，`message` 变成「已取消 … 预算」。
- **没设预算时相关字段给 `null` 而不是 0**。「0 元预算」和「没设预算」业务上是两件事，
  混成 0 会让页面显示「预算 0 元，已花 74.9」，比不显示更糟。

`PUT` 成功后广播 `budget.updated`（见 §3.3），网页收到就按那边的策略重拉 dashboard。
`/api/summary/dashboard` 里也带一份 `data.budget`（同样的结构，`month` 为当前月），
首屏一次拿齐，少一次往返。

错误码沿用 §3.2 的格式：`BAD_AMOUNT`（金额不是整数分）、`BAD_MONTH`（不是 `YYYY-MM`）。

## 4. CLI 命令契约

CLI 是**唯一写入口**（桥接、网页、手动救急都走它）。所有命令都满足：

- 支持 `--json` 输出机器可读结果（桥接默认加这个参数）
- 不加 `--json` 时输出人类友好的中文
- 成功 exit 0，失败 exit ≠ 0 且 `stderr` 是给调用方看的结构化错误
- 无需 AI 也能手动使用，便于调试和救急

下表以 `ledger help` 的**实际输出**为准（2026-09-11 核对过）。

| 命令 | 说明 |
| --- | --- |
| `ledger init [--initial 8000] [--savings 50000]` | 初始化账户与分类；两个账户分别设期初余额 |
| `ledger add "午饭35"` | 自然语言记一笔（走规则解析） |
| `ledger add "存了2000"` | 存钱自动识别为「现金流 → 长期储蓄」 |
| `ledger add --amount 35 --category 食品餐饮 --note 午饭 [--type …] [--date YYYY-MM-DD] [--from 账户] [--to 账户] [--yes] [--json]` | 显式记一笔；`--yes` 跳过「大额二次确认」 |
| `ledger transfer --amount 2000 [--from 现金流] [--to 长期储蓄] [--note 备注]` | 转账，不计入收支 |
| `ledger parse "午饭35" [--json]` | **干跑**：只解析不写入，用于调桥接和回归测试 |
| `ledger void [<id>\|last] [--reason 原因]` | 撤销（软删除，不是物理删除） |
| `ledger edit <id> [--category 食品餐饮] [--note 备注]` | 改一笔的分类 / 备注。**金额和日期故意不给改**——那两样牵动余额和当月统计，撤销重记更诚实 |
| `ledger list [--month 2026-09] [--from D] [--to D] [--limit N] [--all]` | 查明细；`--all` 连已撤销的一起列 |
| `ledger balance` | 余额（现金流 / 长期储蓄 / 合计） |
| `ledger report day [--date D]` / `ledger report month [--month M]` | 日 / 月报表（月度含分类占比、上月同期对比、储蓄率） |
| `ledger trend [--days 14]` | 最近每日支出 |
| `ledger budget show [--month M]` / `budget set --amount 4000 [--month M]` / `budget clear [--month M]` | 月度预算（`set --amount 0` 等于取消） |
| `ledger adjust --to 5000 --note "原因" [--account 现金流]` | 把某个账户的余额校准到指定值 |
| `ledger category list` | 分类清单 |

服务不是 CLI 的子命令，是独立进程：`npm run serve`（等价于 `node server/src/index.js`）。
草稿的确认 / 取消（`/api/drafts/*`）、导出（`/api/export`）、晨报数据（`/api/report/brief`）、
账户读写这些**目前只有 HTTP 接口，CLI 里没有对应命令**——桥接走的就是这些 HTTP 接口。

`--at` 支持相对表达（`昨天`、`前天`、`今天中午`），由服务端统一解析——
**不让 LLM 计算日期**，又一个防幻觉点。

### 桥接侧的实际调用序列

桥接**走 HTTP，不走 CLI**（`bridge/src/ledger.js` 就是这些接口的薄封装）——
少一层进程，也不用把 CLI 的参数解析当成 API。

```http
# 1) 记一笔（含幂等键，重试安全）
POST /api/transactions
{"type":"expense","amountCents":3500,"category":"食品餐饮","note":"午饭",
 "source":"wechat","sourceMsgId":"weixin_xxx_8821","idemKey":"wx:acc1:chat1:msg8821"}

# 2) 用户说「撤销刚才那笔」
POST /api/transactions/10231/void   {"reason":"用户撤销"}

# 3) 用户说「早上好」
GET  /api/report/brief?kind=greeting&markSent=1
```

## 5. 晨报数据结构 `GET /api/report/brief`

```json
{
  "ok": true,
  "data": {
    "kind": "greeting",
    "reportDate": "2026-09-10",
    "alreadySentToday": false,
    "yesterday": {
      "incomeCents": 0, "expenseCents": 8600, "netCents": -8600,
      "byCategory": [
        { "name": "食品餐饮", "cents": 5600, "share": 0.651 },
        { "name": "出行交通", "cents": 3000, "share": 0.349 }
      ]
    },
    "month": {
      "key": "2026-09", "daysElapsed": 10,
      "incomeCents": 1200000, "expenseCents": 328050,
      "expenseByCategory": [
        { "name": "食品餐饮", "cents": 98000, "share": 0.2987, "txCount": 12 }
      ],
      "prevMonthSamePeriod": { "expenseCents": 295000, "deltaPct": 0.112 }
    },
    "balance": { "totalCents": 423150 },
    "signals": [
      { "code": "budget_pace", "severity": "warn",
        "params": { "spentCents": 328050, "budgetCents": 500000, "timeProgress": 0.333 } }
    ],
    "fallbackText": "昨天支出 ¥86.00，主要是食品餐饮 ¥56.00。本月至今支出 ¥3,280.50，收入 ¥12,000.00，总余额 ¥4,231.50。"
  }
}
```

- `alreadySentToday`：同一天重复打招呼时，桥接据此输出简版，避免刷屏
- `--mark-sent`：调用即写入 `report_log`，保证「一天只主动推一次」
- `fallbackText`：模型不可用/超时时的兜底文案，保证核心信息一定送达

## 6. 谁负责解析自然语言

明确分工，避免职责重叠：

| 环节 | 负责方 | 说明 |
| --- | --- | --- |
| 从「午饭35」抽出金额/分类/备注 | **LLM** | 语言理解，唯一的用武之地 |
| 相对时间「昨天中午」→ 绝对时间 | **服务端** | 涉及时区与日历，模型不可靠 |
| 分类名归一与校验 | **服务端** | 只接受既有分类，模糊匹配给候选 |
| 所有金额运算 | **服务端** | 见铁律一 |
| 措辞成中文回执/建议 | **LLM**（可回退模板） | 服务端同时给 `message` / `fallbackText` |

服务端的规则解析器还有第三个用途，是 M2 落地时补上的：

**3. LLM 结果的服务端强校验。** 对应 `POST /api/parse`——桥接把模型输出连同原话一起发过来，
服务端用**同一套规则**做分类归一、相对时间换算、置信度评分与硬规则判定。

这么做的收益是双份的：

- 分类清单、时间口径、置信度权重只有一处实现，不会出现「桥接说 A、服务端算 B」
- 模型整个不可用时，把 `extracted` 留空就退化成纯规则解析——同一接口，两条路

## 7. 并发与一致性

- `better-sqlite3` 同步 API + WAL 模式：读不阻塞写，写不阻塞读
- 所有写操作包在事务里，`PRAGMA busy_timeout=5000`
- SSE 广播在**事务提交之后**发出，避免前端看到未提交的数据
- 单机单人场景，实际上不存在真正的并发争用；但仍按上述做，因为「网页开着 + 桥接写入」天然并发

## 8. 安全

- 默认只监听 `127.0.0.1`。要局域网访问必须显式 `--host 0.0.0.0 --token <secret>`，
  所有 `/api/*` 校验 `Authorization: Bearer`（`/api/stream` 用 query token，
  因为 `EventSource` 不能自定义请求头）
- CLI 从 `~/.ledger/config.json` 读取 `baseUrl` 与 `token`，不在命令行暴露密钥
- 网页不做登录：本机回环 + 单用户，加登录只会增加摩擦。但**不做**跨域开放
  （不设 `Access-Control-Allow-Origin: *`），防止恶意网页读取本地账本
- 数据不出本机；除 LLM 调用外无任何外部网络请求