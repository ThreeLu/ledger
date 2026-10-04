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
      cx: size / 2, cy: size / 2, r, fill: 'none', style: `stroke:${seg.color}`, 'stroke-width': 18,
      'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }));
    off += len;
  }
  svg.append(s('text', { x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle', class: 'donut-num', text: center }));
  if (sub) svg.append(s('text', { x: size / 2, y: size / 2 + 20, 'text-anchor': 'middle', class: 'chart-label', text: sub }));
  return svg;
}

// 折线图：series = [{ values: [数], color, dashed? }]，xLabels 只标头、中、尾
export function lineChart(series, { xLabels = [], height = 160, title = '', fromZero = true } = {}) {
  const top = 14;
  const bottom = 22;
  const left = 34;
  const all = series.flatMap((x) => x.values);
  const max = Math.max(1, ...all);
  const min = fromZero ? 0 : Math.min(...all) * 0.98;
  const span = max - min || 1;
  const n = Math.max(1, ...series.map((x) => x.values.length)) - 1 || 1;
  const X = (i) => left + (i / n) * (W - left - 8);
  const Y = (v) => top + ((max - v) / span) * (height - top - bottom);
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': title });
  for (const v of [max, (max + min) / 2, min]) {
    svg.append(s('line', { x1: left, x2: W - 8, y1: Y(v), y2: Y(v), style: 'stroke:var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: left - 4, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-label', text: short(v) }));
  }
  for (const ser of series) {
    if (!ser.values.length) continue;
    const d = ser.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    svg.append(s('path', { d, fill: 'none', style: `stroke:${ser.color}`, 'stroke-width': ser.dashed ? 1.5 : 2.5,
      'stroke-dasharray': ser.dashed ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (!ser.dashed && ser.values.length === 1) svg.append(s('circle', { cx: X(0), cy: Y(ser.values[0]), r: 3, style: `fill:${ser.color}` }));
  }
  xLabels.forEach(([i, label]) => svg.append(s('text', { x: X(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === n ? 'end' : 'middle', class: 'chart-label', text: label })));
  return svg;
}
