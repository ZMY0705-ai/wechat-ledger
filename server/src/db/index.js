/**
 * 数据库连接与迁移。
 *
 * 用 Node 内置的 `node:sqlite`（22.5+），不引入 better-sqlite3 ——
 * 换取「零原生依赖、无需编译工具链」。调用方需要 `--disable-warning=ExperimentalWarning`，
 * 已在 package.json 的脚本里配好。
 */
import { DatabaseSync } from 'node:sqlite';
import { CATEGORY_VERSION, reconcileCategories } from './categories.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const SERVER_DIR = resolve(here, '..', '..');
export const REPO_DIR = resolve(SERVER_DIR, '..');
export const DATA_DIR = join(REPO_DIR, 'data');
export const DB_PATH = process.env.LEDGER_DB || join(DATA_DIR, 'ledger.db');
export const SCHEMA_VERSION = 1;

/**
 * 打开数据库并确保结构最新。
 * @param {string} [path] 传 ':memory:' 可开一个用完即弃的库（测试用）
 */
export function openDatabase(path = DB_PATH) {
  const inMemory = path === ':memory:' || path.startsWith('file::memory:');
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL');

  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;

  if (current === 0) {
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (current !== SCHEMA_VERSION) {
    // M0 阶段只有 v1；将来加迁移步骤就写在这里
    throw new Error(`数据库 schema 版本为 ${current}，代码期望 ${SCHEMA_VERSION}，缺少迁移步骤`);
  }

  migrateCategories(db);
}

/**
 * 分类体系迁移（categories.js）。
 *
 * **用版本号守着，只跑一次**——不是每次都对齐。理由是分类是用户能改的东西
 * （网页管理页 / `ledger category add`）：每次启动都拿代码里的清单去「纠正」，
 * 用户手工加的分类会被反复搬来搬去，那种 bug 极难查。
 */
function migrateCategories(db) {
  if (Number(getMeta(db, 'category_version') ?? 0) >= CATEGORY_VERSION) return;

  const log = tx(db, () => {
    const result = reconcileCategories(db);
    setMeta(db, 'category_version', CATEGORY_VERSION);
    return result;
  });

  // 全新库只会「新增」，没什么好说的；老库才会有改名/改挂/归档，值得留一行日志
  if (log.renamed.length || log.moved.length || log.archived.length) {
    console.log('[分类迁移] 已对齐到新体系：'
      + `改名 ${log.renamed.join('、') || '无'}；`
      + `改挂 ${log.moved.join('、') || '无'}；`
      + `归档 ${log.archived.join('、') || '无'}`);
  }
}

/** 在事务里执行，出错自动回滚 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败就让原错误冒出来 */ }
    throw err;
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}