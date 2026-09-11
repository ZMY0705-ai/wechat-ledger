#!/usr/bin/env node
/**
 * ledger —— 记账命令行。
 *
 * 用法：.\ledger.ps1 <命令> [参数]
 *   init [--initial 8000] [--savings 50000]  初始化账户与分类，分别设两个账户的期初余额
 *   add  "午饭35"              自然语言记一笔（走规则解析）
 *   add  --amount 35 --category 食品餐饮 --note 午饭
 *   transfer --amount 2000     现金流 -> 长期储蓄（转账，不计入收支）
 *   parse "昨天超市买菜76.5"    只解析不写入
 *   void [<id>|last]           撤销
 *   edit <id> --category 食品餐饮   改一笔的分类 / 备注（金额和日期改不了，撤销重记）
 *   list                       最近流水
 *   balance                    余额（现金流 / 长期储蓄 / 合计）
 *   report day|month           报表
 *   budget show|set|clear      月度预算
 *   adjust --to 5000 --note "9月漏记对齐"   把余额校准到指定值
 *   category list              分类清单
 *
 * 账户模型：两个资产账户
 *   · 现金流    —— 每月进出的钱，日常消费都挂这里
 *   · 长期储蓄  —— 攒下来的钱，只通过 transfer 从现金流进来
 * 「现金流 -> 长期储蓄」是转账而不是支出：把存钱记成支出会让月度支出虚高、
 * 储蓄进度失真。但储蓄额必须单独可见，否则「这个月存了多少」在账本上会消失。
 *
 * 全局：--json 输出 JSON（给桥接和脚本用）
 */
import { openDatabase, DB_PATH } from '../../server/src/db/index.js';
import {
  seed, defaultAccountId, accountByName, savingsAccountId, CASH_ACCOUNT, SAVINGS_ACCOUNT,
} from '../../server/src/db/seed.js';
import {
  addTransaction, updateTransaction, voidTransaction, voidLast, listTransactions, getById,
  lastActiveTransaction, ValidationError,
} from '../../server/src/domain/transactions.js';
import {
  getBalance, getDaySummary, getMonthSummary, getDailyExpenseSeries,
  categoryBreakdown, getPeriodTotals,
} from '../../server/src/domain/summary.js';
import { parseLedgerText, CONFIDENCE_THRESHOLD, CONFIRM_THRESHOLD_CENTS } from '../../server/src/domain/parse.js';
import { clearBudget, getBudgetStatus, setBudget } from '../../server/src/domain/budget.js';
import { parseAmountToCents, formatYuan, formatYuanGrouped, formatShare } from '../../server/src/domain/money.js';
import {
  todayString, nowString, monthOf, isValidDate, isValidMonth, formatDateZh, formatMonthZh, addDays,
} from '../../server/src/domain/time.js';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}
const flag = (name) => (flags[name] === true ? undefined : flags[name]);
const has = (name) => flags[name] !== undefined;

// help / parse 不需要数据库，不要因为跑一次帮助就凭空建出账本文件
const CMD = args[0] ?? 'help';
const DB_FREE = new Set(['help', 'parse']);
const db = DB_FREE.has(CMD) ? null : openDatabase();
const accountId = () => defaultAccountId(db);
const out = (obj) => (JSON_OUT ? console.log(JSON.stringify(obj, null, 2)) : undefined);

function money(cents) { return JSON_OUT ? cents : formatYuanGrouped(cents); }

const TYPE_LABEL = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  modify_balance: '余额校准',
};

/** 从名字或 id 找账户；给了名字但不存在时必须报错，不能悄悄退回默认账户 */
function resolveAccount(nameOrId, fallbackId = null) {
  if (nameOrId === undefined || nameOrId === null) return fallbackId;
  const raw = String(nameOrId).trim();
  if (/^\d+$/.test(raw)) {
    const row = db.prepare('SELECT id, name FROM accounts WHERE id = ? AND archived = 0').get(Number(raw));
    if (!row) throw new ValidationError(`账户 id ${raw} 不存在`);
    return row.id;
  }
  const row = accountByName(db, raw);
  if (!row) throw new ValidationError(`账户「${raw}」不存在`);
  return row.id;
}

function printTransaction(t) {
  if (JSON_OUT) return;
  const sign = t.type === 'expense' ? '-' : t.type === 'income' ? '+' : ' ';
  const tag = t.categoryPath
    ? `  ${t.categoryPath}`
    : t.type === 'transfer' && t.to_account_name
      ? `  转账 -> ${t.to_account_name}`
      : t.type === 'modify_balance' ? '  余额校准' : '';
  console.log(`  #${String(t.id).padEnd(4)} ${t.occurred_date}  ${sign}${formatYuan(Math.abs(t.amountCents)).padEnd(12)}${tag.padEnd(22)}${t.note ?? ''}`);
}

/** 余额统一按「现金流 / 长期储蓄 / 合计」三段呈现——这三个数各有各的用途 */
function printBalance(bal) {
  console.log(`\n  现金流 ${formatYuanGrouped(bal.cashCents)}   长期储蓄 ${formatYuanGrouped(bal.savingsCents)}   合计 ${formatYuanGrouped(bal.totalCents)}`);
  const others = bal.accounts.filter((a) => a.name !== CASH_ACCOUNT && a.name !== SAVINGS_ACCOUNT);
  for (const a of others) {
    const label = a.kind === 'credit' && a.balanceCents < 0
      ? `待还 ${formatYuan(-a.balanceCents)}`
      : formatYuanGrouped(a.balanceCents);
    console.log(`  ${a.name.padEnd(10)} ${label}`);
  }
}

function previewOf(r) {
  const type = r.transferToSavings ? '转账（现金流 -> 长期储蓄）' : TYPE_LABEL[r.type] ?? r.type;
  const lines = [
    '📝 准备记录：',
    `  日期：${formatDateZh(r.date)}`,
    `  金额：${r.amountCents === null ? '（未识别）' : formatYuan(r.amountCents)}`,
    `  分类：${r.categoryName ?? '（不适用）'}`,
    `  备注：${r.note ?? ''}`,
    `  类型：${type}`,
    `  置信度：${r.confidence}`,
  ];
  return lines.join('\n');
}

const BUDGET_STATUS_TEXT = {
  none: '还没设预算',
  ok: '节奏正常',
  watch: '比时间进度快',
  over: '已经超支',
};

/** 进度条：把「花了多少」和「时间过到哪」画成同样长度的两条，一眼就能比 */
function bar(share, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round((share ?? 0) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function printBudget(s) {
  console.log(`${formatMonthZh(s.month)}（已过 ${s.daysElapsed}/${s.daysInMonth} 天）`);
  if (s.status === 'none') {
    console.log(`  还没设预算，本月已花 ${formatYuanGrouped(s.spentCents)}`);
    console.log('  设一个才能提醒你「花得快不快」：');
    console.log(`    .\\ledger.ps1 budget set --month ${s.month} --amount 3000`);
    return;
  }
  console.log(`  预算 ${formatYuanGrouped(s.budgetCents)}   已花 ${formatYuanGrouped(s.spentCents)}   剩余 ${formatYuanGrouped(s.remainingCents)}`);
  console.log(`  支出 ${bar(s.spentProgress)} ${formatShare(s.spentProgress).padStart(6)}   ${BUDGET_STATUS_TEXT[s.status]}`);
  console.log(`  时间 ${bar(s.timeProgress)} ${formatShare(s.timeProgress).padStart(6)}`);
  console.log(`  今天起每天还能花 ${formatYuanGrouped(s.dailyAllowanceCents)}（还剩 ${s.daysLeft} 天）`);
}

// ── 命令实现 ─────────────────────────────────────────────────────────────
const COMMANDS = {
  init() {
    const created = seed(db, nowString());

    // 两个账户各有各的起点：现金流是「现在手里能动的钱」，
    // 长期储蓄是「已经攒下的钱」。起点分开记，才谈得上「这个月存了多少」。
    const setInitial = (name, rawValue) => {
      const cents = parseAmountToCents(rawValue);
      if (cents === null) throw new ValidationError(`期初余额解析失败：${rawValue}`);
      const acct = accountByName(db, name);
      if (!acct) throw new ValidationError(`账户「${name}」不存在`);
      db.prepare('UPDATE accounts SET initial_cents = ? WHERE id = ?').run(cents, acct.id);
      return cents;
    };

    const cashInitial = has('initial') ? setInitial(CASH_ACCOUNT, flag('initial')) : null;
    const savingsInitial = has('savings') ? setInitial(SAVINGS_ACCOUNT, flag('savings')) : null;

    const bal = getBalance(db);
    if (JSON_OUT) {
      return out({ created, cashInitialCents: cashInitial, savingsInitialCents: savingsInitial, balance: bal });
    }
    console.log('初始化完成');
    for (const name of created.created) console.log(`  · 已创建账户「${name}」`);
    for (const r of created.renamed) console.log(`  · 遗留账户已改名：${r}`);
    console.log(`  · 分类 ${created.categories} 个（支出一级见 docs/02 §3）`);
    if (cashInitial !== null) console.log(`  · 现金流期初设为 ${formatYuan(cashInitial)}`);
    if (savingsInitial !== null) console.log(`  · 长期储蓄期初设为 ${formatYuan(savingsInitial)}`);
    printBalance(bal);
    if (cashInitial === null && savingsInitial === null) {
      console.log('\n提示：还没设置期初余额，两个账户都会从 0 开始算。');
      console.log('     .\\ledger.ps1 init --initial 8000      现金流现在有多少');
      console.log('     .\\ledger.ps1 init --savings 50000     长期储蓄已经攒了多少');
      console.log('     两个可以一起给：init --initial 8000 --savings 50000');
    }
  },

  parse() {
    const text = positional.join(' ');
    if (!text) throw new ValidationError('用法：ledger parse "昨天超市买菜76.5"');
    const r = parseLedgerText(text);
    if (JSON_OUT) return out(r);
    console.log(previewOf(r));
    console.log(`  处置：${r.decision}${r.reason ? `（${r.reason}）` : ''}`);
    if (r.question) console.log(`  追问：${r.question}`);
    console.log(`  各维度得分：金额 ${r.scores.amount} / 类型 ${r.scores.type} / 分类 ${r.scores.category} / 时间 ${r.scores.date}`);
  },

  add() {
    const explicit = has('amount');
    let payload;

    if (explicit) {
      const cents = parseAmountToCents(flag('amount'));
      if (cents === null) throw new ValidationError(`金额解析失败：${flag('amount')}`);
      const type = flag('type') ?? 'expense';
      payload = {
        type,
        amountCents: type === 'modify_balance' ? cents : Math.abs(cents),
        categoryName: flag('category') ?? null,
        date: flag('date') ?? todayString(),
        note: flag('note') ?? null,
        confidence: 1,
        decision: 'record',
        transferToSavings: false,
        source: 'web',
      };
    } else {
      const text = positional.join(' ');
      if (!text) throw new ValidationError('用法：ledger add "午饭35" 或 ledger add --amount 35 --category 食品餐饮');
      const r = parseLedgerText(text);
      if (r.decision === 'ask_amount') {
        throw new ValidationError(`${r.question}\n  提示：也可以显式指定，例如 ledger add --amount 35 --category 食品餐饮 --note "${text}"`);
      }
      if (r.decision !== 'record' && !has('yes')) {
        console.log(previewOf(r));
        console.log(`\n需要确认（${r.reason ?? r.decision}）。确认请加 --yes：`);
        console.log(`  .\\ledger.ps1 add "${text}" --yes`);
        return;
      }
      payload = {
        type: r.type,
        amountCents: r.amountCents,
        categoryName: r.categoryName,
        date: r.date,
        note: r.note,
        rawText: r.raw,
        confidence: r.confidence,
        decision: r.decision,
        transferToSavings: r.transferToSavings,
        source: 'web',
      };
    }

    if (!isValidDate(payload.date)) throw new ValidationError(`日期不合法：${payload.date}`);

    // 转账要落在两个账户之间。默认「现金流 -> 长期储蓄」，
    // 也可以用 --from / --to 指定别的账户（信用卡还款这类）。
    let fromId = accountId();
    let toId = null;
    if (payload.type === 'transfer') {
      fromId = resolveAccount(flag('from'), accountId());
      toId = has('to')
        ? resolveAccount(flag('to'), null)
        : payload.transferToSavings ? savingsAccountId(db) : null;
      if (toId === null) throw new ValidationError('这笔转账要转到哪个账户？加 --to 指定，例如 --to 长期储蓄');
    }

    const { transaction, deduplicated } = addTransaction(db, {
      type: payload.type,
      amountCents: payload.amountCents,
      occurredDate: payload.date,
      categoryName: payload.categoryName,
      accountId: fromId,
      toAccountId: toId,
      note: payload.note,
      rawText: payload.rawText ?? null,
      source: payload.source,
      idemKey: flag('idem') ?? null,
    });

    const balance = getBalance(db);
    if (JSON_OUT) return out({ transaction, deduplicated, balance });

    console.log(deduplicated ? '（这笔已经记过了，未重复写入）' : '✅ 已记账');
    printTransaction(transaction);
    printBalance(balance);
  },

  transfer() {
    const raw = flag('amount') ?? positional[0];
    if (raw === undefined) {
      throw new ValidationError('用法：ledger transfer --amount 2000 [--from 现金流] [--to 长期储蓄] [--note 备注]');
    }
    const cents = parseAmountToCents(String(raw));
    if (cents === null || cents <= 0) throw new ValidationError(`金额解析失败：${raw}`);

    const fromId = resolveAccount(flag('from'), accountId());
    const toId = resolveAccount(flag('to'), savingsAccountId(db));
    if (toId === null) throw new ValidationError('没有「长期储蓄」账户，先跑一次 init');
    if (fromId === toId) throw new ValidationError('转出和转入不能是同一个账户');

    const { transaction, deduplicated } = addTransaction(db, {
      type: 'transfer',
      amountCents: cents,
      occurredDate: flag('date') ?? todayString(),
      accountId: fromId,
      toAccountId: toId,
      note: flag('note') ?? null,
      source: 'web',
      idemKey: flag('idem') ?? null,
    });

    const balance = getBalance(db);
    if (JSON_OUT) return out({ transaction, deduplicated, balance });

    console.log(deduplicated ? '（这笔已经记过了，未重复写入）' : '💸 已转账');
    printTransaction(transaction);
    console.log('\n  转账不计入收支，但两边余额都变了');
    printBalance(balance);
  },

  void() {
    const target = positional[0] ?? 'last';
    let tx;
    if (target === 'last') {
      tx = voidLast(db, flag('reason') ?? '用户撤销');
    } else {
      const id = Number(target);
      if (!Number.isInteger(id)) throw new ValidationError(`无法识别的目标：${target}`);
      tx = voidTransaction(db, { id, reason: flag('reason') ?? '用户撤销' });
    }
    if (JSON_OUT) return out({ voided: tx, balance: getBalance(db) });
    console.log('🗑️  已撤销');
    printTransaction(tx);
    printBalance(getBalance(db));
  },

  edit() {
    const id = Number(positional[0]);
    if (!Number.isInteger(id)) {
      throw new ValidationError('用法：ledger edit <id> [--category 食品餐饮] [--note 备注]');
    }
    const tx = updateTransaction(db, {
      id,
      categoryName: has('category') ? flag('category') : undefined,
      note: has('note') ? flag('note') : undefined,
    });
    if (JSON_OUT) return out({ transaction: tx });
    console.log('✏️  已更新');
    printTransaction(tx);
  },

  balance() {
    const bal = getBalance(db);
    if (JSON_OUT) return out(bal);
    printBalance(bal);
  },

  list() {
    const month = flag('month');
    const rows = listTransactions(db, {
      month: month ?? undefined,
      from: flag('from'),
      to: flag('to'),
      type: flag('type'),
      limit: Number(flag('limit') ?? 30),
      includeVoided: has('all'),
    });
    if (JSON_OUT) return out({ count: rows.length, transactions: rows });
    if (!rows.length) return console.log('没有流水');
    for (const t of rows) {
      const mark = t.status === 'voided' ? ' [已撤销]' : '';
      printTransaction(t);
      if (mark) console.log(`       ${mark}`);
    }
  },

  report() {
    const kind = positional[0] ?? 'month';
    if (kind === 'day') {
      const date = flag('date') ?? todayString();
      const s = getDaySummary(db, date);
      if (JSON_OUT) return out(s);
      console.log(`${formatDateZh(date)}`);
      console.log(`  收入 ${money(s.incomeCents)}   支出 ${money(s.expenseCents)}   净额 ${money(s.netCents)}   共 ${s.count} 笔`);
      if (s.savingsInCents) console.log(`  转入长期储蓄 ${money(s.savingsInCents)}`);
      if (s.expenseByCategory.length) {
        console.log('  支出分类：');
        for (const c of s.expenseByCategory) {
          console.log(`    ${c.name.padEnd(14)} ${money(c.cents).padEnd(12)} ${formatShare(c.share)}`);
        }
      }
      return;
    }
    if (kind !== 'month') throw new ValidationError('用法：ledger report day|month');

    const month = flag('month') ?? monthOf(todayString());
    if (!isValidMonth(month)) throw new ValidationError(`月份不合法：${month}`);
    const s = getMonthSummary(db, month);
    if (JSON_OUT) return out(s);

    console.log(`${formatMonthZh(month)}（已过 ${s.daysElapsed}/${s.daysInMonth} 天，共 ${s.count} 笔）`);
    console.log(`  收入 ${money(s.incomeCents)}   支出 ${money(s.expenseCents)}   净额 ${money(s.netCents)}`);
    if (s.prevMonthSamePeriod) {
      const p = s.prevMonthSamePeriod;
      const delta = p.deltaPct === null
        ? '上月同期无数据'
        : `${p.deltaPct >= 0 ? '多' : '少'} ${(Math.abs(p.deltaPct) * 100).toFixed(1)}%`;
      console.log(`  上月同期支出 ${money(p.expenseCents)}（${delta}）`);
    }
    // 储蓄额单独一行：它不计入收支，但这恰恰是最该被看见的数
    if (s.savingsInCents || s.savingsOutCents) {
      const rate = s.savingsRate === null ? '—' : `${(s.savingsRate * 100).toFixed(1)}%`;
      const back = s.savingsOutCents ? `   从储蓄取回 ${money(s.savingsOutCents)}` : '';
      console.log(`  转入长期储蓄 ${money(s.savingsInCents)}${back}   储蓄率 ${rate}`);
    }
    if (s.expenseByCategory.length) {
      console.log('\n  支出构成：');
      for (const c of s.expenseByCategory) {
        const bar = '█'.repeat(Math.max(1, Math.round((c.share ?? 0) * 24)));
        console.log(`    ${c.name.padEnd(8)} ${money(c.cents).padEnd(12)} ${formatShare(c.share).padStart(7)}  ${bar}`);
      }
      const sum = s.expenseByCategory.reduce((a, c) => a + c.share, 0);
      console.log(`    ${'合计'.padEnd(8)} ${money(s.expenseCents).padEnd(12)} ${formatShare(sum).padStart(7)}`);
    }
    if (s.incomeByCategory.length) {
      console.log('\n  收入构成：');
      for (const c of s.incomeByCategory) {
        console.log(`    ${c.name.padEnd(8)} ${money(c.cents).padEnd(12)} ${formatShare(c.share).padStart(7)}`);
      }
    }
    printBalance(getBalance(db));
  },

  adjust() {
    if (!has('to')) throw new ValidationError('用法：ledger adjust --to 5000 --note "9月漏记对齐"');
    // 目标余额可以是负的（信用卡欠款也是常态），parseAmountToCents 只认正数，符号自己处理
    const rawTo = String(flag('to') ?? '').trim();
    const negative = /^[-\u2212]/.test(rawTo);
    let target = parseAmountToCents(negative ? rawTo.slice(1) : rawTo);
    if (target === null) throw new ValidationError(`目标余额解析失败：${flag('to')}`);
    if (negative) target = -target;
    const note = flag('note');
    if (!note) throw new ValidationError('余额校准必须写清原因：--note "..."');

    const targetAccountId = resolveAccount(flag('account'), accountId());
    const acct = getBalance(db).accounts.find((a) => a.id === targetAccountId);
    const current = acct ? acct.balanceCents : 0;
    const delta = target - current;
    if (delta === 0) {
      if (JSON_OUT) return out({ changed: false, balanceCents: current });
      return console.log(`${acct?.name ?? '账户'}余额已经是 ${formatYuanGrouped(current)}，无需校准`);
    }
    const { transaction } = addTransaction(db, {
      type: 'modify_balance',
      amountCents: delta,
      occurredDate: flag('date') ?? todayString(),
      accountId: targetAccountId,
      note,
      source: 'web',
    });
    if (JSON_OUT) return out({ transaction, balance: getBalance(db) });
    console.log('⚖️  已校准余额');
    console.log(`  ${acct?.name ?? '账户'} ${formatYuanGrouped(current)} → ${formatYuanGrouped(target)}（调整 ${delta > 0 ? '+' : ''}${formatYuan(delta)}）`);
    console.log(`  原因：${note}`);
  },

  category() {
    const sub = positional[0] ?? 'list';
    if (sub !== 'list') throw new ValidationError('用法：ledger category list');
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.direction, p.name AS parent
           FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
          WHERE c.archived = 0
          ORDER BY c.direction, COALESCE(p.sort_order, c.sort_order), c.sort_order, c.id`,
      )
      .all();
    if (JSON_OUT) return out({ categories: rows });
    let lastDir = null;
    for (const r of rows) {
      if (r.direction !== lastDir) { console.log(`\n【${r.direction === 'income' ? '收入' : '支出'}】`); lastDir = r.direction; }
      console.log(r.parent ? `    ${r.parent} / ${r.name}` : `  ${r.name}`);
    }
  },

  budget() {
    const sub = positional[0] ?? 'show';
    const month = flag('month') ?? monthOf(todayString());
    if (!isValidMonth(month)) throw new ValidationError(`月份不合法：${month}（应为 YYYY-MM）`);

    if (sub === 'set') {
      const raw = flag('amount');
      if (raw === undefined) {
        throw new ValidationError('用法：ledger budget set --month 2026-09 --amount 3000');
      }
      const cents = parseAmountToCents(raw);
      if (cents === null || cents <= 0) throw new ValidationError(`预算金额解析失败：${raw}`);
      setBudget(db, { month, amountCents: cents });
      const status = getBudgetStatus(db, { month });
      if (JSON_OUT) return out(status);
      console.log(`✅ ${formatMonthZh(month)}的预算设为 ${formatYuanGrouped(status.budgetCents)}`);
      printBudget(status);
      return;
    }

    if (sub === 'clear') {
      const removed = clearBudget(db, { month });
      if (JSON_OUT) return out({ month, removed });
      console.log(removed
        ? `已取消 ${formatMonthZh(month)}的预算`
        : `${formatMonthZh(month)}本来就没设预算`);
      return;
    }

    if (sub !== 'show') throw new ValidationError('用法：ledger budget show | set --amount N | clear [--month M]');
    const status = getBudgetStatus(db, { month });
    if (JSON_OUT) return out(status);
    printBudget(status);
  },

  trend() {
    const days = Number(flag('days') ?? 14);
    const today = todayString();
    const rows = getDailyExpenseSeries(db, addDays(today, -(days - 1)), today);
    if (JSON_OUT) return out({ days, series: rows });
    const max = Math.max(1, ...rows.map((r) => r.cents));
    console.log(`最近 ${days} 天每日支出（峰值 ${formatYuanGrouped(max)}）`);
    for (const r of rows) {
      const w = Math.round((r.cents / max) * 30);
      console.log(`  ${r.date.slice(5)}  ${'▇'.repeat(w).padEnd(30)} ${r.cents ? formatYuan(r.cents) : ''}`);
    }
  },

  help() {
    console.log(`
ledger —— 本地记账命令行

  init [--initial 8000] [--savings 50000]
                                  初始化账户与分类；两个账户可分别设期初余额
  add "午饭35"                     自然语言记一笔
  add "存了2000"                   存钱自动识别为「现金流 -> 长期储蓄」
  add --amount 35 --category 食品餐饮 --note 午饭 [--type expense|income|transfer|modify_balance] [--date YYYY-MM-DD] [--to 账户]
  transfer --amount 2000 [--from 现金流] [--to 长期储蓄] [--note 备注]
                                  转账（不计入收支）
  parse "昨天超市买菜76.5"         只解析不写入
  void [<id>|last] [--reason 原因] 撤销（默认撤销最近一笔）
  edit <id> [--category 食品餐饮] [--note 备注]
                                  改一笔的分类 / 备注（金额和日期改不了，撤销重记）
  list [--month 2026-09] [--from D] [--to D] [--limit N] [--all]
  balance                         余额（现金流 / 长期储蓄 / 合计）
  report day [--date D]           当日报表
  report month [--month M]        月度报表（含分类占比、上月同期对比、储蓄率）
  trend [--days 14]               最近每日支出
  budget show [--month M]         本月预算进度（花了多少 vs 时间过了多少）
  budget set --amount 3000 [--month M]
                                  设置月度预算
  budget clear [--month M]        取消预算
  adjust --to 5000 --note "原因" [--account 现金流]
                                  把某个账户的余额校准到指定值
  category list                   分类清单

  全局：--json 输出 JSON
数据库：${DB_PATH}
`);
  },
};

try {
  const fn = COMMANDS[CMD];
  if (!fn) { console.error(`未知命令：${CMD}`); COMMANDS.help(); process.exitCode = 1; }
  else {
    positional.shift(); // 去掉命令名
    fn();
  }
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  db?.close();
}