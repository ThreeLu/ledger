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
