/**
 * 页面逻辑。
 *
 * 数据只有两个来源：启动时整页拉一次 `/api/summary/dashboard`，
 * 之后靠 SSE 通知「有新账了」再整页重拉（docs/03 §3.3 的策略）。
 * 个人记账这点数据量，全量重拉比增量更新简单、也更不容易错。
 */
import { renderLineChart, renderDonut, renderLegend, formatMoney } from './charts.js';

const $ = (selector) => document.querySelector(selector);

const TYPE_TEXT = { expense: '支出', income: '收入', transfer: '转账', modify_balance: '校准' };

const state = {
  dashboard: null,
  categories: [],
  accounts: [],
  transactions: [],
  trendDays: 30,
  filterCategoryId: null,
  filterCategoryName: null,
};

// ── 基础设施 ─────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* 下面统一报错 */ }
  if (!response.ok || !payload?.ok) {
    const error = payload?.error;
    throw new Error(error
      ? `${error.message}${error.hint ? `（${error.hint}）` : ''}`
      : `请求失败：HTTP ${response.status}`);
  }
  return payload;
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('err', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
}

const tooltip = $('#tooltip');
function showTip(text, event) {
  if (!text) { tooltip.hidden = true; return; }
  tooltip.textContent = text;
  tooltip.hidden = false;
  const rect = tooltip.getBoundingClientRect();
  const pad = 14;
  let left = event.clientX + pad;
  let top = event.clientY - rect.height - pad;
  if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - pad;
  if (top < 8) top = event.clientY + pad;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const signed = (cents) => (cents > 0 ? `+${formatMoney(cents)}` : formatMoney(cents));
const toneOf = (cents) => (cents > 0 ? 'pos' : cents < 0 ? 'neg' : '');

function longDate(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  const weekday = '日一二三四五六'[new Date(y, m - 1, d).getDay()];
  return `${y} 年 ${m} 月 ${d} 日 周${weekday}`;
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

/**
 * 三张余额卡的小插画。
 *
 * 手写内联 SVG：形状只用 CSS 类上色，暗色主题跟着变量自动换，不用维护两套图。
 * 颜色分工 —— ico-1/ico-2 是蓝，ico-3 是「挖空」，ico-warm 只给一点点杏色。
 */
const BAL_ICONS = {
  cash: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <rect class="ico-1" x="5" y="13.5" width="30" height="18.5" rx="6.5"/>
    <path class="ico-2" d="M11.5 13.5A6.5 6.5 0 0 0 5 20h30a6.5 6.5 0 0 0-6.5-6.5Z"/>
    <rect class="ico-3" x="23.5" y="21" width="9.5" height="8" rx="4"/>
    <circle class="ico-warm" cx="28.2" cy="25" r="2"/>
  </svg>`,
  savings: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <ellipse class="ico-1" cx="19" cy="22.5" rx="12" ry="9.5"/>
    <path class="ico-1" d="M12.5 15.2 14.6 10.8l3.4 2.8Z"/>
    <circle class="ico-2" cx="7.6" cy="22" r="3.6"/>
    <circle class="ico-3" cx="7.1" cy="21.1" r=".9"/>
    <circle class="ico-3" cx="8.7" cy="22.5" r=".9"/>
    <rect class="ico-warm" x="15.5" y="16" width="6.6" height="2.6" rx="1.3"/>
    <rect class="ico-2" x="13.5" y="29.5" width="3.4" height="4.5" rx="1.7"/>
    <rect class="ico-2" x="21" y="29.5" width="3.4" height="4.5" rx="1.7"/>
  </svg>`,
  total: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <circle class="ico-bg" cx="20" cy="20" r="13"/>
    <path class="ico-1" d="M20 20V7a13 13 0 0 1 13 13Z"/>
    <path class="ico-warm" d="M20 20h13a13 13 0 0 1-3.8 9.2Z"/>
  </svg>`,
};

function renderBalance(balance) {
  const savingShare = balance.totalCents > 0 ? balance.savingsCents / balance.totalCents : null;
  const cards = [
    { cls: 'cash', label: '现金流', cents: balance.cashCents, sub: '每月进出的钱' },
    { cls: 'savings', label: '长期储蓄', cents: balance.savingsCents, sub: `占总资产 ${pct(savingShare)}` },
    { cls: 'total', label: '合计', cents: balance.totalCents, sub: '两个账户之和' },
  ];

  const host = $('#balance-cards');
  host.textContent = '';
  for (const card of cards) {
    const article = document.createElement('article');
    article.className = `card bal ${card.cls}`;

    const top = document.createElement('div');
    top.className = 'top';

    const label = document.createElement('div');
    label.className = 'label';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    label.append(swatch, document.createTextNode(card.label));

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = BAL_ICONS[card.cls];
    top.append(label, icon);

    const amount = document.createElement('div');
    amount.className = 'amount';
    amount.textContent = formatMoney(card.cents);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = card.sub;

    article.append(top, amount, sub);
    host.append(article);
  }
}

/** 预算状态 → 文案与配色。四种状态，对应四种「我该不该紧张」 */
const BUDGET_STATUS = {
  none: { text: '还没设预算', cls: 'none' },
  ok: { text: '节奏正常', cls: 'ok' },
  watch: { text: '比时间进度快', cls: 'watch' },
  over: { text: '已经超支', cls: 'over' },
};

function budgetStat(label, value, tone = '') {
  const item = document.createElement('div');
  item.className = 'item';
  const key = document.createElement('span');
  key.className = 'k';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = `v ${tone}`.trim();
  val.textContent = value;
  item.append(key, val);
  return item;
}

/**
 * 本月预算卡。
 *
 * 进度条画的是「花了多少」，上面那道竖线是「时间过到哪」——
 * 两个进度叠在一起才看得出「快还是慢」。只画一条，30% 是多是少根本没法判断。
 */
function renderBudget(budget) {
  const host = $('#budget');
  host.textContent = '';
  if (!budget) return;

  const meta = BUDGET_STATUS[budget.status] ?? BUDGET_STATUS.none;
  const article = document.createElement('article');
  article.className = `card budget ${meta.cls}`;

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h2');
  title.textContent = `本月预算 · ${budget.month}`;
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (budget.status !== 'none') {
    const used = document.createElement('span');
    used.className = 'muted';
    used.textContent = `${formatMoney(budget.spentCents)} / ${formatMoney(budget.budgetCents)}`;
    actions.append(used);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ghost';
  edit.textContent = budget.status === 'none' ? '设置预算' : '改预算';
  edit.addEventListener('click', () => startEditBudget(budget));
  actions.append(edit);
  head.append(title, actions);
  article.append(head);

  if (budget.status === 'none') {
    const empty = document.createElement('p');
    empty.className = 'budget-empty';
    empty.textContent = `还没设预算，本月已花 ${formatMoney(budget.spentCents)}。设一个，我才好提醒你「花得快不快」。`;
    article.append(empty);
    host.append(article);
    return;
  }

  const track = document.createElement('div');
  track.className = 'budget-track';
  const fill = document.createElement('div');
  fill.className = 'budget-fill';
  fill.style.width = `${Math.min(100, (budget.spentProgress ?? 0) * 100)}%`;
  const marker = document.createElement('div');
  marker.className = 'budget-marker';
  marker.style.left = `${Math.min(100, budget.timeProgress * 100)}%`;
  track.append(fill, marker);

  const stats = document.createElement('div');
  stats.className = 'budget-stats';
  stats.append(
    budgetStat('预算', formatMoney(budget.budgetCents)),
    budgetStat('已花', formatMoney(budget.spentCents), 'neg'),
    budgetStat('剩余', formatMoney(budget.remainingCents), budget.remainingCents < 0 ? 'neg' : 'pos'),
    budgetStat('每天还能花', formatMoney(budget.dailyAllowanceCents), budget.dailyAllowanceCents < 0 ? 'neg' : ''),
  );

  const caption = document.createElement('p');
  caption.className = 'budget-caption';
  caption.textContent = [
    `时间已过 ${pct(budget.timeProgress)}`,
    `支出走了 ${pct(budget.spentProgress)}`,
    meta.text,
    `还剩 ${budget.daysLeft} 天`,
  ].join(' · ');

  article.append(track, stats, caption);
  host.append(article);
}

/** 就地变成一行输入框：改个数字不值得弹窗、更不值得跳页 */
function startEditBudget(budget) {
  const host = $('#budget');
  host.textContent = '';

  const article = document.createElement('article');
  article.className = 'card budget editing';

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h2');
  title.textContent = `本月预算 · ${budget.month}`;
  head.append(title);

  const form = document.createElement('form');
  form.className = 'budget-form';

  const input = document.createElement('input');
  input.className = 'budget-input';
  input.inputMode = 'decimal';
  input.placeholder = '例如 4000';
  input.setAttribute('aria-label', '月度预算金额');
  input.value = budget.budgetCents ? String(budget.budgetCents / 100) : '';

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = '保存';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => renderBudget(state.dashboard?.budget ?? budget));

  form.append(input, save, cancel);

  if (budget.budgetCents) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ghost';
    clear.textContent = '取消预算';
    clear.addEventListener('click', () => saveBudget('0', clear));
    form.append(clear);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveBudget(input.value.trim(), save);
  });

  article.append(head, form);
  host.append(article);
  input.focus();
  input.select();
}

async function saveBudget(amountText, button = null) {
  if (button) button.disabled = true;
  try {
    const { data, message } = await api('/api/budgets', {
      method: 'PUT',
      body: JSON.stringify({ month: state.dashboard?.budget?.month, amountText }),
    });
    if (state.dashboard) state.dashboard.budget = data;
    renderBudget(data);
    toast(message ?? '预算已保存');
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function summaryCard(title, rows, tags = []) {
  const article = document.createElement('article');
  article.className = 'card sum';

  const heading = document.createElement('h3');
  heading.textContent = title;
  article.append(heading);

  for (const [key, value, tone] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = `v ${tone ?? ''}`;
    v.textContent = value;
    row.append(k, v);
    article.append(row);
  }

  if (tags.length) {
    const wrap = document.createElement('div');
    wrap.className = 'tags';
    for (const text of tags) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = text;
      wrap.append(tag);
    }
    article.append(wrap);
  }
  return article;
}

function renderSummaries(dashboard) {
  const { today, yesterday, month } = dashboard;
  const host = $('#summaries');
  host.textContent = '';

  const todayRows = [
    ['支出', formatMoney(today.expenseCents), today.expenseCents ? 'neg' : ''],
    ['收入', formatMoney(today.incomeCents), today.incomeCents ? 'pos' : ''],
    ['净额', signed(today.netCents), toneOf(today.netCents)],
    ['笔数', `${today.count} 笔`],
  ];
  if (today.savingsInCents) todayRows.push(['转入储蓄', formatMoney(today.savingsInCents)]);

  const yesterdayTags = yesterday.byCategory
    .slice(0, 4)
    .map((item) => `${item.name} ${formatMoney(item.cents)}`);
  const yesterdayRows = [
    ['支出', formatMoney(yesterday.expenseCents), yesterday.expenseCents ? 'neg' : ''],
    ['收入', formatMoney(yesterday.incomeCents), yesterday.incomeCents ? 'pos' : ''],
    ['笔数', `${yesterday.count} 笔`],
  ];
  if (!yesterdayTags.length) yesterdayTags.push('昨天没有支出');

  const prev = month.prevMonthSamePeriod;
  const monthRows = [
    ['收入', formatMoney(month.incomeCents), month.incomeCents ? 'pos' : ''],
    ['支出', formatMoney(month.expenseCents), month.expenseCents ? 'neg' : ''],
    ['净额', signed(month.netCents), toneOf(month.netCents)],
    ['转入储蓄', formatMoney(month.savingsInCents)],
    ['储蓄率', pct(month.savingsRate)],
  ];
  if (prev && prev.expenseCents) {
    const delta = month.expenseCents - prev.expenseCents;
    monthRows.push([
      '较上月同期',
      `${delta >= 0 ? '多花' : '少花'} ${formatMoney(Math.abs(delta))}`,
      delta > 0 ? 'neg' : 'pos',
    ]);
  }

  host.append(
    summaryCard(`今天 · ${month.daysElapsed ? '已记 ' + today.count + ' 笔' : ''}`.trim(), todayRows),
    summaryCard('昨天', yesterdayRows, yesterdayTags),
    summaryCard(`本月 · 已过 ${month.daysElapsed}/${month.daysInMonth} 天`, monthRows),
  );
}

function renderCharts(dashboard) {
  renderLineChart($('#line-chart'), dashboard.trend.dailyExpense, {
    onHover: (day, event) => {
      if (!day || !event) return showTip(null);
      showTip(`${day.date}　支出 ${formatMoney(day.cents)}`, event);
    },
  });

  const items = dashboard.month.expenseByCategory;
  renderDonut($('#pie-chart'), items, { onSelect: toggleCategory });
  renderLegend($('#pie-legend'), items, { onSelect: toggleCategory });
  $('#pie-total').textContent = `合计 ${formatMoney(dashboard.month.expenseCents)}`;
}

function renderTransactions() {
  const body = $('#tx-body');
  body.textContent = '';

  if (!state.transactions.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-row';
    const cat = document.createElement('span');
    cat.className = 'empty-cat';
    cat.textContent = '🐱';
    cell.append(cat, document.createTextNode(
      state.filterCategoryId ? '这个分类下还没有流水' : '还没有流水，去微信里跟猫说一句',
    ));
    row.append(cell);
    body.append(row);
    return;
  }

  for (const tx of state.transactions) {
    const row = document.createElement('tr');

    const date = document.createElement('td');
    date.className = 'date';
    date.textContent = tx.occurred_date.slice(5);

    const type = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${tx.type}${tx.status === 'voided' ? ' voided' : ''}`;
    badge.textContent = TYPE_TEXT[tx.type] ?? tx.type;
    type.append(badge);

    const category = document.createElement('td');
    category.textContent = tx.categoryPath
      ?? (tx.type === 'transfer' ? `${tx.account_name ?? ''} → ${tx.to_account_name ?? ''}` : '—');

    const note = document.createElement('td');
    note.className = 'note';
    note.textContent = tx.note ?? '';

    const amount = document.createElement('td');
    amount.className = `num ${tx.type === 'income' ? 'pos' : tx.type === 'expense' ? 'neg' : ''}`;
    amount.textContent = tx.type === 'expense'
      ? `-${formatMoney(Math.abs(tx.amountCents))}`
      : tx.type === 'income'
        ? `+${formatMoney(tx.amountCents)}`
        : tx.type === 'modify_balance'
          ? signed(tx.amountCents)
          : formatMoney(tx.amountCents);

    const action = document.createElement('td');
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'ghost';
    undo.textContent = '撤销';
    undo.addEventListener('click', () => voidTransaction(tx));
    action.append(undo);

    row.append(date, type, category, note, amount, action);
    body.append(row);
  }
}

// ── 数据加载 ─────────────────────────────────────────────────────────────

async function loadDashboard() {
  const { data } = await api(`/api/summary/dashboard?trendDays=${state.trendDays}`);
  state.dashboard = data;

  renderBalance(data.balance);
  renderBudget(data.budget);
  renderSummaries(data);
  renderCharts(data);

  $('#today-label').textContent = longDate(data.asOf);
  $('#updated-at').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function loadTransactions() {
  const params = new URLSearchParams({ size: '40' });
  if (state.filterCategoryId) params.set('categoryId', String(state.filterCategoryId));

  const { data } = await api(`/api/transactions?${params.toString()}`);
  state.transactions = data.transactions;
  renderTransactions();

  $('#tx-title').textContent = state.filterCategoryName ? `流水 · ${state.filterCategoryName}` : '最近流水';
  $('#tx-count').textContent = `${data.count} 笔`;
  $('#tx-clear-filter').hidden = !state.filterCategoryId;
}

async function loadAll() {
  await Promise.all([loadDashboard(), loadTransactions()]);
}

function toggleCategory(item) {
  if (state.filterCategoryId === item.categoryId) {
    state.filterCategoryId = null;
    state.filterCategoryName = null;
  } else {
    state.filterCategoryId = item.categoryId;
    state.filterCategoryName = item.name;
  }
  loadTransactions().catch((error) => toast(error.message, true));
}

async function voidTransaction(tx) {
  const label = `${tx.occurred_date} ${tx.categoryPath ?? TYPE_TEXT[tx.type]} ${formatMoney(Math.abs(tx.amountCents))}`;
  if (!window.confirm(`撤销这一笔？\n\n${label}\n\n记录会保留为「已撤销」，不计入任何统计。`)) return;
  try {
    const { message } = await api(`/api/transactions/${tx.id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason: '网页撤销' }),
    });
    toast(message ?? '已撤销');
    await loadAll();
  } catch (error) {
    toast(error.message, true);
  }
}

// ── 实时更新 ─────────────────────────────────────────────────────────────

function setLive(connected) {
  const node = $('#live');
  node.classList.toggle('on', connected);
  node.classList.toggle('off', !connected);
  $('#live-text').textContent = connected ? '实时' : '已断开';
}

function connectStream() {
  const source = new EventSource('/api/stream');
  let timer = null;
  let connections = 0;

  // 收到事件先攒 300ms：微信那边连记两笔时不该拉两次
  const scheduleReload = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      loadAll().catch((error) => toast(error.message, true));
    }, 300);
  };

  for (const event of ['tx.created', 'tx.updated', 'tx.voided', 'report.sent', 'budget.updated']) {
    source.addEventListener(event, scheduleReload);
  }
  // 重连后必须补拉一次数据。
  // 断线期间发生的记账（桥接写库、服务重启）不会有事件推过来，
  // 只把角标点回绿色的话，页面会一直停在旧数字上——看着像「钱没扣」。
  source.addEventListener('open', () => {
    setLive(true);
    if (++connections > 1) scheduleReload();
  });
  source.addEventListener('hello', () => setLive(true));
  source.addEventListener('error', () => setLive(false));   // EventSource 自己会重连
}

// ── 表单 ─────────────────────────────────────────────────────────────────

function fillCategories() {
  const select = $('#f-category');
  select.textContent = '';
  for (const [direction, label] of [['expense', '支出'], ['income', '收入']]) {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const category of state.categories.filter((c) => c.direction === direction)) {
      const option = document.createElement('option');
      option.value = category.name;
      option.textContent = category.path;
      group.append(option);
    }
    select.append(group);
  }
  select.value = '待分类';
}

function fillAccounts() {
  for (const id of ['#f-from', '#f-to']) {
    const select = $(id);
    select.textContent = '';
    for (const account of state.accounts) {
      const option = document.createElement('option');
      option.value = String(account.id);
      option.textContent = account.name;
      select.append(option);
    }
  }
  const byName = (name) => state.accounts.find((a) => a.name === name)?.id;
  if (byName('现金流')) $('#f-from').value = String(byName('现金流'));
  if (byName('长期储蓄')) $('#f-to').value = String(byName('长期储蓄'));
}

function syncTypeFields() {
  const isTransfer = $('#f-type').value === 'transfer';
  $('#field-transfer').hidden = !isTransfer;
  $('#field-category').hidden = isTransfer;
}

async function submitForm(event) {
  event.preventDefault();
  const button = $('#quick-add button[type="submit"]');
  const type = $('#f-type').value;
  const body = {
    type,
    amountText: $('#f-amount').value.trim(),
    date: $('#f-date').value || undefined,
    note: $('#f-note').value.trim() || null,
  };
  if (type === 'transfer') {
    body.from = $('#f-from').value;
    body.to = $('#f-to').value;
  } else {
    body.category = $('#f-category').value;
  }

  button.disabled = true;
  try {
    const { message } = await api('/api/transactions', { method: 'POST', body: JSON.stringify(body) });
    toast(message ?? '记下了');
    $('#f-amount').value = '';
    $('#f-note').value = '';
    await loadAll();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// ── 启动 ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [categories, accounts, health] = await Promise.all([
      api('/api/categories'),
      api('/api/accounts'),
      api('/api/health'),
    ]);
    state.categories = categories.data.categories;
    state.accounts = accounts.data.accounts;
    $('#f-date').value = health.data.today;   // 用服务端的「今天」，别用浏览器时区
    fillCategories();
    fillAccounts();
  } catch (error) {
    toast(`初始化失败：${error.message}`, true);
  }

  syncTypeFields();
  $('#f-type').addEventListener('change', syncTypeFields);
  $('#quick-add').addEventListener('submit', submitForm);
  $('#refresh').addEventListener('click', () => loadAll().catch((e) => toast(e.message, true)));
  $('#tx-clear-filter').addEventListener('click', () => {
    state.filterCategoryId = null;
    state.filterCategoryName = null;
    loadTransactions().catch((e) => toast(e.message, true));
  });

  $('#trend-range').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]');
    if (!button) return;
    state.trendDays = Number(button.dataset.days);
    for (const peer of $('#trend-range').querySelectorAll('button')) {
      peer.classList.toggle('on', peer === button);
    }
    loadDashboard().catch((error) => toast(error.message, true));
  });

  // 图是按像素宽度画的，窗口变了要重画一遍才不糊
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.dashboard) renderCharts(state.dashboard); }, 150);
  });

  try {
    await loadAll();
  } catch (error) {
    toast(`加载失败：${error.message}`, true);
  }
  connectStream();
}

init();