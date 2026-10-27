// 简单的 SVG 图表：柱状图、环形图、折线图。用 createElementNS 一个个建元素，文字只用 textContent。
// 颜色用 CSS 变量（写在 style 里，深色模式自动跟着变）。

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

const W = 320;
const short = (n) => (Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(1)}万` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

// 柱状图：bars = [{ label, v, color? }]，line = 一条虚线（比如每天预算）。支持负数（存钱为负）。
export function barChart(bars, { line = null, lineLabel = '', height = 150, color = 'var(--accent)', title = '' } = {}) {
  const top = 16;
  const bottom = 22;
  const vals = bars.map((b) => b.v);
  const max = Math.max(1, ...vals, line || 0);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => top + ((max - v) / span) * (height - top - bottom);
  const slot = W / bars.length;
  const bw = Math.min(28, slot * 0.6);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  svg.append(s('line', { x1: 0, x2: W, y1: y(0), y2: y(0), style: 'stroke:var(--line)', 'stroke-width': 1 }));
  bars.forEach((b, i) => {
    const x = slot * i + (slot - bw) / 2;
    const y0 = y(Math.max(0, b.v));
    const hgt = Math.max(b.v ? 1.5 : 0, Math.abs(y(b.v) - y(0)));
    svg.append(s('rect', { x, y: y0, width: bw, height: hgt, rx: 3, style: `fill:${b.color || color}` }));
    // 负数的数字写在 0 线上方，免得和底下的月份挤在一起
    if (b.v) svg.append(s('text', { x: x + bw / 2, y: b.v >= 0 ? y0 - 4 : y(0) - 4, 'text-anchor': 'middle', class: 'chart-num', text: short(b.v) }));
    svg.append(s('text', { x: slot * i + slot / 2, y: height - 6, 'text-anchor': 'middle', class: 'chart-label', text: b.label }));
  });
  if (line) {
    svg.append(s('line', { x1: 0, x2: W, y1: y(line), y2: y(line), style: 'stroke:var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
    if (lineLabel) svg.append(s('text', { x: W - 2, y: y(line) - 4, 'text-anchor': 'end', class: 'chart-label', text: lineLabel }));
  }
  return svg;
}

// 环形图：segments = [{ name, v, color }]，中间写总数
// 每一段带 data-key（seg.key），中间两行文字有 class，方便点选时换
export function donut(segments, { center = '', sub = '', title = '' } = {}) {
  const size = 150;
  const r = 52;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((a, b) => a + b.v, 0);
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'chart donut', role: 'img', 'aria-label': title });
  svg.append(s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', style: 'stroke:var(--chip)', 'stroke-width': 18 }));
  let off = 0;
  for (const seg of segments) {
    if (!total || seg.v <= 0) continue;
    const len = (seg.v / total) * c;
    svg.append(s('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', style: `stroke:${seg.color}`, 'stroke-width': 18, ...(seg.key ? { 'data-key': seg.key, class: 'seg' } : {}),
      'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }));
    off += len;
  }
  svg.append(s('text', { x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle', class: 'donut-num', text: center }));
  if (sub) svg.append(s('text', { x: size / 2, y: size / 2 + 20, 'text-anchor': 'middle', class: 'chart-label donut-sub', text: sub }));
  return svg;
}

// 折线图：series = [{ values: [数], color, dashed? }]，xLabels 只标头、中、尾
// marks = [{ i, color }]：在第一条线的第 i 个点上画小圆点（模拟交易的买卖点）
// bands：阴影 [{ lo: [], hi: [], color, opacity }]（预测的范围），画在线下面
export function lineChart(series, { xLabels = [], height = 160, title = '', fromZero = true, fmt = short, tight = false, marks = [], bands = [] } = {}) {
  const top = 14;
  const bottom = 22;
  const left = 34;
  const all = [...series.flatMap((x) => x.values), ...bands.flatMap((b) => [...b.lo, ...b.hi])];
  // tight：上下只留一成空白（股价、模拟的钱，小涨小跌也看得出来）
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.01 || 1;
  const max = tight ? hi + pad : Math.max(1, ...all);
  const min = tight ? lo - pad : fromZero ? 0 : lo * 0.98;
  const span = max - min || 1;
  const n = Math.max(1, ...series.map((x) => x.values.length)) - 1 || 1;
  const X = (i) => left + (i / n) * (W - left - 8);
  const Y = (v) => top + ((max - v) / span) * (height - top - bottom);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  for (const v of [max, (max + min) / 2, min]) {
    svg.append(s('line', { x1: left, x2: W - 8, y1: Y(v), y2: Y(v), style: 'stroke:var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: left - 4, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-label', text: fmt(v) }));
  }
  for (const b of bands) {
    const pts = [...b.hi.map((v, i) => [X(i), Y(v)]), ...b.lo.map((v, i) => [X(i), Y(v)]).reverse()];
    svg.append(s('path', { d: `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z`, style: `fill:${b.color}`, 'fill-opacity': b.opacity ?? 0.15, stroke: 'none' }));
  }
  for (const ser of series) {
    if (!ser.values.length) continue;
    const d = ser.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    svg.append(s('path', { d, fill: 'none', style: `stroke:${ser.color}`, 'stroke-width': ser.dashed ? 1.5 : 2.5,
      'stroke-dasharray': ser.dashed ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (!ser.dashed && ser.values.length === 1) svg.append(s('circle', { cx: X(0), cy: Y(ser.values[0]), r: 3, style: `fill:${ser.color}` }));
  }
  for (const m of marks) {
    const v = series[0].values[m.i];
    if (v != null) svg.append(s('circle', { cx: X(m.i), cy: Y(v), r: 4.5, class: 'chart-mark', style: `fill:${m.color};stroke:var(--card)`, 'stroke-width': 2 }));
  }
  xLabels.forEach(([i, label]) => svg.append(s('text', { x: X(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === n ? 'end' : 'middle', class: 'chart-label', text: label })));
  return svg;
}

// 瀑布图：收入一根柱子，每一块支出往下扣一段，最后一根是剩下的（可以是负数）
// steps = [{ label, v, color }]：第一个是收入，中间是支出（正数），最后一根自动算
export function waterfall(steps, { endLabel = '存下', endColor = 'var(--sage)', negColor = 'var(--danger)', height = 170, title = '' } = {}) {
  const top = 18;
  const bottom = 22;
  const bars = [];
  let run = steps[0]?.v || 0;
  bars.push({ ...steps[0], a: 0, b: run });
  for (const x of steps.slice(1)) { bars.push({ ...x, a: run, b: run - x.v }); run -= x.v; }
  bars.push({ label: endLabel, v: run, color: run >= 0 ? endColor : negColor, a: 0, b: run, end: true });
  const max = Math.max(1, ...bars.map((x) => Math.max(x.a, x.b)));
  const min = Math.min(0, ...bars.map((x) => Math.min(x.a, x.b)));
  const span = max - min || 1;
  const y = (v) => top + ((max - v) / span) * (height - top - bottom);
  const slot = W / bars.length;
  const bw = Math.min(26, slot * 0.62);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  svg.append(s('line', { x1: 0, x2: W, y1: y(0), y2: y(0), style: 'stroke:var(--line)', 'stroke-width': 1 }));
  bars.forEach((b, i) => {
    const x = slot * i + (slot - bw) / 2;
    const hi = Math.max(b.a, b.b);
    const lo = Math.min(b.a, b.b);
    svg.append(s('rect', { x, y: y(hi), width: bw, height: Math.max(1.5, y(lo) - y(hi)), rx: 3, style: `fill:${b.color}` }));
    // 和下一根之间的细虚线：钱从这里接着往下扣
    if (i < bars.length - 1) svg.append(s('line', { x1: x + bw, x2: x + slot, y1: y(b.b), y2: y(b.b), style: 'stroke:var(--muted)', 'stroke-width': 0.8, 'stroke-dasharray': '2 2' }));
    const num = i === 0 || b.end ? short(b.v) : `−${short(b.v)}`;
    svg.append(s('text', { x: x + bw / 2, y: y(hi) - 4, 'text-anchor': 'middle', class: 'chart-num', text: num }));
    svg.append(s('text', { x: slot * i + slot / 2, y: height - 6, 'text-anchor': 'middle', class: 'chart-label', text: b.label }));
  });
  return svg;
}

// 每月两根柱子（收入、支出）+ 一条储蓄率的线（右边的刻度）
// months = [{ label, a, b, rate }]，rate 是 0～1 的小数或 null
export function barsLine(months, { colorA = 'var(--sage)', colorB = 'var(--g-food)', lineColor = 'var(--accent)', height = 170, title = '' } = {}) {
  const top = 16;
  const bottom = 22;
  const left = 4;
  const right = 30;
  const max = Math.max(1, ...months.flatMap((m) => [m.a, m.b]));
  const y = (v) => top + ((max - v) / max) * (height - top - bottom);
  const rates = months.map((m) => m.rate).filter((r) => r != null);
  const rHi = Math.max(1, ...rates);
  const rLo = Math.min(0, ...rates);
  const ry = (r) => top + ((rHi - r) / (rHi - rLo || 1)) * (height - top - bottom);
  const slot = (W - left - right) / Math.max(1, months.length);
  const bw = Math.min(14, slot * 0.3);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  svg.append(s('line', { x1: left, x2: W - right, y1: y(0), y2: y(0), style: 'stroke:var(--line)', 'stroke-width': 1 }));
  for (const r of [rLo, rHi]) svg.append(s('text', { x: W - 2, y: ry(r) + 4, 'text-anchor': 'end', class: 'chart-label', text: `${Math.round(r * 100)}%` }));
  const pts = [];
  months.forEach((m, i) => {
    const cx = left + slot * i + slot / 2;
    svg.append(s('rect', { x: cx - bw - 1, y: y(m.a), width: bw, height: Math.max(m.a ? 1.5 : 0, y(0) - y(m.a)), rx: 3, style: `fill:${colorA}` }));
    svg.append(s('rect', { x: cx + 1, y: y(m.b), width: bw, height: Math.max(m.b ? 1.5 : 0, y(0) - y(m.b)), rx: 3, style: `fill:${colorB}` }));
    svg.append(s('text', { x: cx, y: height - 6, 'text-anchor': 'middle', class: 'chart-label', text: m.label }));
    if (m.rate != null) pts.push([cx, ry(m.rate)]);
  });
  if (pts.length > 1) svg.append(s('path', { d: pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '), fill: 'none', style: `stroke:${lineColor}`, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  for (const [px, py] of pts) svg.append(s('circle', { cx: px, cy: py, r: 3, style: `fill:${lineColor};stroke:var(--card)`, 'stroke-width': 1.5 }));
  return svg;
}

// 堆叠柱：每一根是一个月，按块分颜色。cols = [{ label, parts: [{ v, color }] }]
export function stackedBars(cols, { height = 160, title = '' } = {}) {
  const top = 14;
  const bottom = 22;
  const max = Math.max(1, ...cols.map((c) => c.parts.reduce((a, p) => a + Math.max(0, p.v), 0)));
  const y = (v) => ((height - top - bottom) * v) / max;
  const slot = W / Math.max(1, cols.length);
  const bw = Math.min(16, slot * 0.56);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  const base = height - bottom;
  svg.append(s('line', { x1: 0, x2: W, y1: base, y2: base, style: 'stroke:var(--line)', 'stroke-width': 1 }));
  cols.forEach((c, i) => {
    const x = slot * i + (slot - bw) / 2;
    let at = base;
    const parts = c.parts.filter((p) => p.v > 0);
    parts.forEach((p, j) => {
      const hgt = y(p.v);
      at -= hgt;
      // 每段之间留一道细缝；最上面一段圆角
      svg.append(s('rect', { x, y: at, width: bw, height: Math.max(0.5, hgt - (j < parts.length - 1 ? 0.8 : 0)), rx: j === parts.length - 1 ? 2.5 : 0, style: `fill:${p.color}` }));
    });
    svg.append(s('text', { x: slot * i + slot / 2, y: height - 6, 'text-anchor': 'middle', class: 'chart-label', text: c.label }));
  });
  return svg;
}

// 一年的日历（像 GitHub 那样）：上半年、下半年各一排，一列是一周（周一在上），颜色越深那天花得越多。
// 分五档，按这一年花过钱的日子分位数切。days = [{ day: 'YYYY-MM-DD', v, off }]（off：还没到 / 还没开始记账），today 那天描一圈
export function yearCalendar(days, { today = '', title = '' } = {}) {
  const left = 14;
  const labelH = 13;
  const gap = 2;
  const halves = [days.filter((d) => d.day.slice(5, 7) <= '06'), days.filter((d) => d.day.slice(5, 7) > '06')].filter((x) => x.length);
  const leadOf = (part) => (new Date(`${part[0].day}T12:00:00`).getDay() + 6) % 7;
  const weeks = Math.max(...halves.map((part) => Math.ceil((leadOf(part) + part.length) / 7)));
  const step = (W - left - 2) / weeks;
  const size = step - gap;
  const halfH = labelH + step * 7 + 8;
  const legendH = size + 8;
  const height = halfH * halves.length + legendH;
  const vals = days.filter((d) => !d.off && d.v > 0).map((d) => d.v).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? Infinity;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  const FILL = ['var(--chip)', 'color-mix(in srgb, var(--accent) 28%, var(--chip))', 'color-mix(in srgb, var(--accent) 50%, var(--chip))', 'color-mix(in srgb, var(--accent) 75%, var(--chip))', 'var(--accent)'];
  const rx = Math.min(2.5, size / 4);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart year-cal', role: 'img', 'aria-label': title });
  halves.forEach((part, hi) => {
    const top = hi * halfH + labelH;
    const lead = leadOf(part);
    ['一', '三', '五', '日'].forEach((t, i) => svg.append(s('text', { x: 0, y: top + step * [0, 2, 4, 6][i] + size - 1, class: 'chart-label', text: t })));
    part.forEach((d, i) => {
      const k = lead + i;
      const x = left + Math.floor(k / 7) * step;
      const y = top + (k % 7) * step;
      if (d.day.slice(8) === '01') svg.append(s('text', { x, y: top - 4, class: 'chart-label', text: `${Number(d.day.slice(5, 7))}月` }));
      const cell = s('rect', { x, y, width: size, height: size, rx, style: `fill:${FILL[d.off ? 0 : level(d.v)]}${d.off ? ';opacity:.45' : ''}` });
      cell.append(s('title', { text: `${Number(d.day.slice(5, 7))}/${Number(d.day.slice(8))} ¥${d.v}` }));
      svg.append(cell);
      if (d.day === today) svg.append(s('rect', { x: x - 1, y: y - 1, width: size + 2, height: size + 2, rx: rx + 1, fill: 'none', style: 'stroke:var(--text)', 'stroke-width': 1.2 }));
    });
  });
  // 右下角：少 □□□□□ 多
  const ly = halves.length * halfH;
  const lx = W - 2 - 5 * (size + 3) - 12;
  svg.append(s('text', { x: lx - 4, y: ly + size - 1, 'text-anchor': 'end', class: 'chart-label', text: '少' }));
  FILL.forEach((f, i) => svg.append(s('rect', { x: lx + i * (size + 3), y: ly, width: size, height: size, rx, style: `fill:${f}` })));
  svg.append(s('text', { x: lx + 5 * (size + 3) + 1, y: ly + size - 1, class: 'chart-label', text: '多' }));
  return svg;
}

// 每顿花多少（周总结「午饭和晚饭」）：一行一类，细线是以前每顿的 10%～90%，粗的一段是 25%～75%，竖线是中位数；
// 点是这周的每一顿，比以前九成都贵的（记满 10 顿才标）琥珀色。rows = [{ name, hist: 从小到大, week: [] }]
export function mealStrip(rows, { title = '' } = {}) {
  const left = 34;
  const right = 10;
  const rowH = 30;
  const top = 6;
  const axis = 18;
  const q = (xs, p) => { const i = (xs.length - 1) * p; const a = Math.floor(i); const b = Math.ceil(i); return xs[a] + (xs[b] - xs[a]) * (i - a); };
  const hi = Math.max(10, ...rows.flatMap((r) => [...r.hist, ...r.week]));
  const x = (v) => left + (v / hi) * (W - left - right);
  const height = top + rows.length * rowH + axis;
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart meal-strip', role: 'img', 'aria-label': title });
  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    svg.append(s('text', { x: 0, y: cy + 4, class: 'chart-label', text: r.name }));
    svg.append(s('line', { x1: left, x2: W - right, y1: cy, y2: cy, style: 'stroke:var(--line)', 'stroke-width': 1 }));
    const h = r.hist;
    if (h.length >= 3) {
      svg.append(s('line', { x1: x(q(h, 0.1)), x2: x(q(h, 0.9)), y1: cy, y2: cy, style: 'stroke:var(--muted)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      svg.append(s('rect', { x: x(q(h, 0.25)), y: cy - 4, width: Math.max(2, x(q(h, 0.75)) - x(q(h, 0.25))), height: 8, rx: 4, style: 'fill:color-mix(in srgb, var(--accent) 28%, var(--chip))' }));
      svg.append(s('line', { x1: x(q(h, 0.5)), x2: x(q(h, 0.5)), y1: cy - 7, y2: cy + 7, style: 'stroke:var(--text)', 'stroke-width': 1.5 }));
    }
    const p90 = h.length >= 10 ? q(h, 0.9) : Infinity;
    for (const v of r.week) svg.append(s('circle', { cx: x(v), cy, r: 4, style: `fill:${v > p90 ? 'var(--amber)' : 'var(--accent)'};stroke:var(--card);stroke-width:1.5` }));
  });
  const base = top + rows.length * rowH + 12;
  const step = hi > 60 ? 20 : hi > 30 ? 10 : 5;
  for (let v = 0; v <= hi; v += step) svg.append(s('text', { x: x(v), y: base, 'text-anchor': 'middle', class: 'chart-label', text: `¥${v}` }));
  return svg;
}

// 吃饭的三种颜色：午饭、晚饭、别的（早餐、零食、饮料、水果……）
export const FOOD_COLORS = { lunch: 'var(--g-food)', dinner: 'var(--accent)', other: 'color-mix(in srgb, var(--g-food) 40%, var(--chip))' };
const dayNo = (day) => `${Number(day.slice(8))}日`;

// 每天吃饭（月度报表）：一天一根堆叠柱（午饭 / 晚饭 / 别的），实线是最近七天的平均，虚线是每天的预算。
// days = [{ day, lunch, dinner, other, v, off }]，avg7 = 和 days 对齐（off 的是 null）
export function foodDaily(days, { avg7 = [], perDay = 0, height = 170, title = '' } = {}) {
  const top = 14;
  const bottom = 22;
  const left = 30;
  const right = 4;
  const max = Math.max(1, perDay * 1.15, ...days.filter((x) => !x.off).map((x) => x.v));
  const y = (v) => top + ((max - v) / max) * (height - top - bottom);
  const slot = (W - left - right) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(9, slot * 0.68));
  const cx = (i) => left + slot * i + slot / 2;
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart food-daily', role: 'img', 'aria-label': title });
  for (const v of [0, max / 2, max]) {
    svg.append(s('line', { x1: left, x2: W - right, y1: y(v), y2: y(v), style: 'stroke:var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: left - 4, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-label', text: short(v) }));
  }
  days.forEach((x, i) => {
    if (x.off) return;
    let at = y(0);
    const parts = ['lunch', 'dinner', 'other'].filter((k) => x[k] > 0);
    parts.forEach((k, j) => {
      const hgt = y(0) - y(x[k]);
      at -= hgt;
      svg.append(s('rect', { x: cx(i) - bw / 2, y: at, width: bw, height: Math.max(0.5, hgt - (j < parts.length - 1 ? 0.6 : 0)), rx: j === parts.length - 1 ? Math.min(2, bw / 3) : 0, style: `fill:${FOOD_COLORS[k]}` }));
    });
  });
  if (perDay) {
    svg.append(s('line', { x1: left, x2: W - right, y1: y(perDay), y2: y(perDay), style: 'stroke:var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
  }
  const pts = avg7.map((v, i) => (v == null ? null : [cx(i), y(v)])).filter(Boolean);
  if (pts.length > 1) svg.append(s('path', { d: pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '), fill: 'none', style: 'stroke:var(--text)', 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.75 }));
  const n = days.length;
  for (const i of [0, Math.floor((n - 1) / 2), n - 1]) svg.append(s('text', { x: cx(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'chart-label', text: dayNo(days[i].day) }));
  return svg;
}

// 累计花了多少 + 估到最后（月度报表「吃饭」）：实线是记了的，虚线是估的中间那个数，阴影是八成的范围，横虚线是预算。
// cum = 每天累计（还没到的是 null），path = 今天以后每天的 { lo, mid, hi }（接在最后一个数后面）
export function cumForecast(days, cum, { path = [], budget = 0, height = 160, title = '' } = {}) {
  const top = 14;
  const bottom = 22;
  const left = 34;
  const right = 8;
  const known = cum.filter((v) => v != null);
  const max = Math.max(1, budget * 1.08, ...known, ...path.map((x) => x.hi));
  const n = days.length;
  const X = (i) => left + (i / Math.max(1, n - 1)) * (W - left - right);
  const Y = (v) => top + ((max - v) / max) * (height - top - bottom);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  for (const v of [0, max / 2, max]) {
    svg.append(s('line', { x1: left, x2: W - right, y1: Y(v), y2: Y(v), style: 'stroke:var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: left - 4, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-label', text: short(v) }));
  }
  if (budget) {
    svg.append(s('line', { x1: left, x2: W - right, y1: Y(budget), y2: Y(budget), style: 'stroke:var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
    svg.append(s('text', { x: W - right, y: Y(budget) - 4, 'text-anchor': 'end', class: 'chart-label', text: '预算' }));
  }
  const lastI = cum.reduce((a, v, i) => (v != null ? i : a), -1);
  if (path.length && lastI >= 0) {
    const start = [lastI, cum[lastI]];
    const xs = path.map((_, j) => lastI + 1 + j);
    const pts = [...[[start[0], start[1]], ...path.map((p, j) => [xs[j], p.hi])].map(([i, v]) => [X(i), Y(v)]), ...[[start[0], start[1]], ...path.map((p, j) => [xs[j], p.lo])].reverse().map(([i, v]) => [X(i), Y(v)])];
    svg.append(s('path', { d: `M${pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')} Z`, style: 'fill:var(--accent)', 'fill-opacity': 0.14, stroke: 'none' }));
    const mid = [[start[0], start[1]], ...path.map((p, j) => [xs[j], p.mid])];
    svg.append(s('path', { d: mid.map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', style: 'stroke:var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
  }
  const line = cum.map((v, i) => (v == null ? null : [X(i), Y(v)])).filter(Boolean);
  if (line.length) svg.append(s('path', { d: line.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '), fill: 'none', style: 'stroke:var(--accent)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  if (lastI >= 0) svg.append(s('circle', { cx: X(lastI), cy: Y(cum[lastI]), r: 3.5, style: 'fill:var(--accent);stroke:var(--card)', 'stroke-width': 1.5 }));
  for (const i of [0, Math.floor((n - 1) / 2), n - 1]) svg.append(s('text', { x: X(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'chart-label', text: dayNo(days[i]) }));
  return svg;
}

// 每次洗澡花多少：一个点一次，连成线看起伏；横虚线是平均。点和点中间底下的小字是隔了几天（次数多了不写）。
// 估的下几次：空心点 + 竖线（八成的范围），和最后一次用虚线连上，底下写大约哪天。
// points = [{ day, v, gap, faint }]（faint：上个月的，淡一点），next = [{ day, lo, mid, hi }]
export function showerChart(points, { next = [], height = 150, title = '', fmtDay = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` } = {}) {
  const top = 14;
  const left = 30;
  const right = 10;
  const gaps = points.length <= 24;
  const bottom = gaps ? 34 : 22;
  // 纵轴从最便宜到最贵（不从 0 开始）：每次差几毛钱也看得出起伏
  const all = [...points.map((p) => p.v), ...next.flatMap((x) => [x.lo, x.hi])];
  const lo0 = Math.min(...all);
  const hi0 = Math.max(...all);
  const pad = (hi0 - lo0) * 0.12 || hi0 * 0.2 || 0.5;
  const min = Math.max(0, lo0 - pad);
  const max = hi0 + pad;
  const n = points.length + next.length;
  const X = (i) => left + (n > 1 ? (i / (n - 1)) * (W - left - right) : (W - left - right) / 2);
  const Y = (v) => top + ((max - v) / (max - min || 1)) * (height - top - bottom);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart shower-chart', role: 'img', 'aria-label': title });
  const money2 = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(2));
  for (const v of [lo0, hi0]) {
    svg.append(s('line', { x1: left, x2: W - right, y1: Y(v), y2: Y(v), style: 'stroke:var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: left - 4, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-label', text: money2(v) }));
  }
  const mean = points.length ? points.reduce((a, p) => a + p.v, 0) / points.length : 0;
  if (points.length > 1) {
    svg.append(s('line', { x1: left, x2: W - right, y1: Y(mean), y2: Y(mean), style: 'stroke:var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '3 4' }));
    svg.append(s('text', { x: left + 2, y: Y(mean) - 4, class: 'chart-label', text: `平均 ${money2(mean)}` }));
  }
  if (points.length > 1) svg.append(s('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' '), fill: 'none', style: 'stroke:var(--blue)', 'stroke-width': 1.6, 'stroke-linejoin': 'round', opacity: 0.8 }));
  if (next.length && points.length) {
    const li = points.length - 1;
    svg.append(s('path', { d: [[li, points[li].v], ...next.map((x, j) => [li + 1 + j, x.mid])].map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', style: 'stroke:var(--blue)', 'stroke-width': 1.2, 'stroke-dasharray': '4 4', opacity: 0.7 }));
  }
  const r = points.length > 40 ? 2.2 : 3.6;
  points.forEach((p, i) => {
    const dot = s('circle', { cx: X(i), cy: Y(p.v), r, style: `fill:var(--blue);stroke:var(--card)${p.faint ? ';opacity:.4' : ''}`, 'stroke-width': 1.5 });
    dot.append(s('title', { text: `${fmtDay(p.day)} ¥${p.v}` }));
    svg.append(dot);
    if (gaps && i && p.gap != null) svg.append(s('text', { x: (X(i - 1) + X(i)) / 2, y: height - 20, 'text-anchor': 'middle', class: 'chart-label shower-gap', text: String(p.gap) }));
  });
  next.forEach((x, j) => {
    const i = points.length + j;
    svg.append(s('line', { x1: X(i), x2: X(i), y1: Y(x.lo), y2: Y(x.hi), style: 'stroke:var(--blue)', 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: 0.45 }));
    svg.append(s('circle', { cx: X(i), cy: Y(x.mid), r: 3.6, style: 'fill:var(--card);stroke:var(--blue)', 'stroke-width': 1.5 }));
  });
  // 底下：头、尾的日子（估的那几次写「约」）
  if (points.length) svg.append(s('text', { x: X(0), y: height - 6, 'text-anchor': n === 1 ? 'middle' : 'start', class: 'chart-label', text: fmtDay(points[0].day) }));
  const lastDay = next.length ? `约 ${fmtDay(next.at(-1).day)}` : points.length > 1 ? fmtDay(points.at(-1).day) : null;
  if (lastDay) svg.append(s('text', { x: X(n - 1), y: height - 6, 'text-anchor': 'end', class: 'chart-label', text: lastDay }));
  if (next.length && points.length > 1) svg.append(s('text', { x: X(points.length - 1), y: height - 6, 'text-anchor': 'middle', class: 'chart-label', text: fmtDay(points.at(-1).day) }));
  return svg;
}
