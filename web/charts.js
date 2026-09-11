/**
 * 两张图，手写 SVG。
 *
 * 不引图表库：这个页面只有一条折线和一个环，为它们拉几百 KB 的依赖不划算。
 * 手写还有个好处——配色直接吃 CSS 变量，改主题不用碰这里。
 *
 * 图表只管画，提示框由调用方通过 onHover / onSelect 回调接管。
 */
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  return node;
}

/** 兜底色板，与 styles.css 的亮色对齐；正常情况下用不到 */
const FALLBACK_PALETTE = [
  '#2563d9', '#9cc4f2', '#f3b58f', '#16191d', '#6fa3e8', '#f7d889',
  '#c8ddf9', '#2f6fe4', '#e8a87c', '#7e8aa0', '#b3cfef', '#ebc9a8',
];

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * 色板放在 CSS 变量里，图就跟着主题走：
 * 切到暗色只是换了一套夜色蓝，这里一行都不用改。
 */
function palette() {
  return FALLBACK_PALETTE.map((fallback, i) => cssVar(`--chart-${i + 1}`, fallback));
}

export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const yuan = Math.abs(cents) / 100;
  return `${sign}¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 轴标签用短格式，否则一排「¥1,234.00」会把图挤没 */
function shortMoney(cents) {
  const yuan = cents / 100;
  if (Math.abs(yuan) >= 10000) return `${(yuan / 10000).toFixed(1)}万`;
  if (Math.abs(yuan) >= 1000) return `${Math.round(yuan / 100) / 10}k`;
  return String(Math.round(yuan));
}

/** 把最大值抬到一个「整」的刻度上，Y 轴才是人看的那种数 */
function niceScale(maxCents) {
  if (!(maxCents > 0)) return { max: 10000, ticks: [0, 2500, 5000, 7500, 10000] };
  const rough = maxCents / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  return { max: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => Math.round(i * step)) };
}

/**
 * 每日支出折线图。
 * @param {HTMLElement} host 容器
 * @param {Array<{date:string,cents:number}>} series 连续日期（没流水的日子是 0）
 */
export function renderLineChart(host, series, { height = 264, onHover } = {}) {
  host.textContent = '';
  const W = Math.max(320, Math.round(host.clientWidth || 640));
  const H = height;
  const pad = { top: 16, right: 12, bottom: 26, left: 56 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });

  const { max, ticks } = niceScale(Math.max(0, ...series.map((d) => d.cents)));
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const stepX = series.length > 1 ? plotW / (series.length - 1) : 0;
  const xAt = (i) => (series.length > 1 ? pad.left + i * stepX : pad.left + plotW / 2);
  const yAt = (v) => pad.top + plotH - (max > 0 ? (v / max) * plotH : 0);

  // 渐变面积：没有它，折线图读起来像心电图
  const defs = el('defs');
  const trend = cssVar('--trend', '#2563d9');
  const grad = el('linearGradient', { id: 'area-grad', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    el('stop', { offset: '0%', 'stop-color': trend, 'stop-opacity': '.24' }),
    el('stop', { offset: '100%', 'stop-color': trend, 'stop-opacity': '0' }),
  );
  defs.append(grad);
  svg.append(defs);

  for (const tick of ticks) {
    const gy = yAt(tick);
    svg.append(el('line', { class: 'grid-line', x1: pad.left, x2: W - pad.right, y1: gy, y2: gy }));
    const text = el('text', { class: 'axis-text', x: pad.left - 9, y: gy + 4, 'text-anchor': 'end' });
    text.textContent = shortMoney(tick);
    svg.append(text);
  }

  if (series.length && series.some((day) => day.cents > 0)) {
    const points = series.map((d, i) => [xAt(i), yAt(d.cents)]);
    const line = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const base = pad.top + plotH;
    const area = `${line} L${points.at(-1)[0].toFixed(1)},${base} L${points[0][0].toFixed(1)},${base} Z`;
    svg.append(el('path', { d: area, fill: 'url(#area-grad)' }));
    svg.append(el('path', { class: 'line', d: line }));
  } else if (series.length) {
    // 全 0 时硬画一条贴着坐标轴的线，看着像出错了；不如直接说清楚
    const hint = el('text', {
      class: 'axis-text',
      x: pad.left + plotW / 2,
      y: pad.top + plotH / 2,
      'text-anchor': 'middle',
    });
    hint.textContent = '这段时间还没有支出 🐾';
    svg.append(hint);
  }

  // X 轴：最多 6 个标签，取等距位置，免得挤成一团
  if (series.length) {
    const count = Math.min(6, series.length);
    for (let i = 0; i < count; i++) {
      const index = Math.round((i / (count - 1 || 1)) * (series.length - 1));
      const text = el('text', {
        class: 'axis-text',
        x: xAt(index),
        y: H - 8,
        'text-anchor': i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle',
      });
      text.textContent = series[index].date.slice(5);
      svg.append(text);
    }
  }

  // 悬停层：一天一个透明热区，比在折线上做命中判定可靠得多
  const cursor = el('g', { style: 'display:none' });
  const hoverLine = el('line', { class: 'hover-line', y1: pad.top, y2: pad.top + plotH });
  const hoverDot = el('circle', { class: 'hover-dot', r: 4 });
  cursor.append(hoverLine, hoverDot);
  svg.append(cursor);

  series.forEach((day, i) => {
    const half = stepX / 2 || plotW / 2;
    const hit = el('rect', {
      class: 'hit',
      x: xAt(i) - half, y: pad.top, width: half * 2 || plotW, height: plotH,
    });
    hit.addEventListener('mouseenter', (event) => {
      cursor.style.display = '';
      hoverLine.setAttribute('x1', xAt(i));
      hoverLine.setAttribute('x2', xAt(i));
      hoverDot.setAttribute('cx', xAt(i));
      hoverDot.setAttribute('cy', yAt(day.cents));
      onHover?.(day, event);
    });
    hit.addEventListener('mousemove', (event) => onHover?.(day, event));
    svg.append(hit);
  });

  svg.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
    onHover?.(null, null);
  });

  host.append(svg);
}

/**
 * 支出构成环形图。
 * @param {HTMLElement} host 图形容器
 * @param {Array<{name:string,cents:number,share:number}>} items
 */
export function renderDonut(host, items, { size = 190, thickness = 26, onSelect } = {}) {
  host.textContent = '';
  const colors = palette();
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}` });
  const center = size / 2;
  const radius = (size - thickness) / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  const total = items.reduce((sum, item) => sum + item.cents, 0);

  svg.append(el('circle', {
    cx: center, cy: center, r: radius, fill: 'none',
    stroke: cssVar('--track', '#e4f0fe'), 'stroke-width': thickness,
  }));

  if (total > 0) {
    const ring = el('g', { transform: `rotate(-90 ${center} ${center})` });
    const gap = items.length > 1 ? 2 : 0;
    let offset = 0;
    items.forEach((item, i) => {
      const span = (item.cents / total) * circumference;
      const seg = el('circle', {
        class: 'seg',
        cx: center, cy: center, r: radius, fill: 'none',
        stroke: colors[i % colors.length],
        'stroke-width': thickness,
        'stroke-dasharray': `${Math.max(0, span - gap)} ${circumference - Math.max(0, span - gap)}`,
        'stroke-dashoffset': -offset,
      });
      seg.addEventListener('click', () => onSelect?.(item));
      const title = el('title');
      title.textContent = `${item.name} ${formatMoney(item.cents)}`;
      seg.append(title);
      ring.append(seg);
      offset += span;
    });
    svg.append(ring);
  }

  const amount = el('text', {
    class: 'center-amount', x: center, y: center + 2, 'text-anchor': 'middle',
  });
  amount.textContent = total > 0 ? shortMoney(total) : '🐾';
  const label = el('text', {
    class: 'center-label', x: center, y: center + 19, 'text-anchor': 'middle',
  });
  label.textContent = total > 0 ? '本月支出' : '本月还没花钱';
  svg.append(amount, label);

  host.append(svg);
}

/** 图例。点一下等于点饼图的那一块，两条入口行为一致 */
export function renderLegend(list, items, { onSelect } = {}) {
  list.textContent = '';
  const colors = palette();
  const total = items.reduce((sum, item) => sum + item.cents, 0);

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '本月还没有支出记录 🐾';
    list.append(li);
    return;
  }

  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.tabIndex = 0;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colors[i % colors.length];

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;

    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = formatMoney(item.cents);

    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = total ? `${((item.cents / total) * 100).toFixed(1)}%` : '—';

    li.append(swatch, name, amt, pct);
    li.addEventListener('click', () => onSelect?.(item));
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(item); }
    });
    list.append(li);
  });
}

export { shortMoney };