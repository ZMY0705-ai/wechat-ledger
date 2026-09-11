-- ═══════════════════════════════════════════════════════════════════════
-- 记账服务数据库结构
-- 口径依据：docs/02-数据模型与统计口径.md（改动必须同步更新测试）
-- ═══════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;   -- 允许「网页读」与「写」并发
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── 账户 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL DEFAULT 'asset'
                        CHECK (kind IN ('asset','credit','debt')),
  initial_cents INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

-- ── 分类（两级：餐饮 > 外卖）─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES categories(id),
  direction  TEXT    NOT NULL CHECK (direction IN ('expense','income','both')),
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0
);

-- SQLite 中 NULL 在唯一索引里互不相等，用表达式索引兜住一级分类的重名
CREATE UNIQUE INDEX IF NOT EXISTS ux_cat_name
  ON categories(COALESCE(parent_id, 0), name);

-- ── 流水（核心表）──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY,
  occurred_at    TEXT    NOT NULL,
  occurred_date  TEXT    NOT NULL,
  occurred_month TEXT    NOT NULL,

  type           TEXT    NOT NULL
                 CHECK (type IN ('expense','income','transfer','modify_balance')),
  -- expense/income/transfer 必须为正；modify_balance 可正可负（服务层校验）
  amount_signed_cents INTEGER NOT NULL CHECK (amount_signed_cents <> 0),

  category_id    INTEGER REFERENCES categories(id),
  account_id     INTEGER REFERENCES accounts(id),
  to_account_id  INTEGER REFERENCES accounts(id),

  note           TEXT,
  raw_text       TEXT,
  tags           TEXT,

  source         TEXT NOT NULL DEFAULT 'web'
                 CHECK (source IN ('wechat','web','import','api')),
  source_msg_id  TEXT,
  idem_key       TEXT,

  refund_of      INTEGER REFERENCES transactions(id),

  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','voided')),
  voided_at      TEXT,
  void_reason    TEXT,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_idem  ON transactions(idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tx_date  ON transactions(occurred_date,  status);
CREATE INDEX IF NOT EXISTS ix_tx_month ON transactions(occurred_month, status);
CREATE INDEX IF NOT EXISTS ix_tx_cat   ON transactions(category_id, occurred_month, status);

-- 所有聚合必须走这个视图，这是最高频的 bug 来源
CREATE VIEW IF NOT EXISTS active_tx AS
  SELECT * FROM transactions WHERE status = 'active';

-- ── 待确认草稿（大额 / 含糊表达）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drafts (
  id            TEXT PRIMARY KEY,
  payload       TEXT NOT NULL,
  preview       TEXT NOT NULL,
  source_msg_id TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','cancelled','expired')),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- ── 预算（建议功能的输入）──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY,
  period_month TEXT NOT NULL,
  category_id  INTEGER REFERENCES categories(id),
  amount_cents INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_budget ON budgets(period_month, COALESCE(category_id, 0));

-- ── 汇报去重（同一天不重复推晨报）──────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_log (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('morning','greeting')),
  report_date TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'wechat',
  sent_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_report ON report_log(kind, report_date, channel);

-- ── 元数据 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);