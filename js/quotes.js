// 模拟交易的行情：腾讯的免费接口，不要密钥。实时价、历史每天的价格允许网页直接读；搜索不允许，用 <script> 读。

import { parseQuote, parseSearch } from './sim.js';

const QT = 'https://qt.gtimg.cn/q=';
const KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
const SMARTBOX = 'https://smartbox.gtimg.cn/s3/?v=2&t=all&q=';

// 实时价：{ sym: 行情 }。返回的是 GBK 编码
export async function fetchQuotes(syms) {
  if (!syms.length) return {};
  const res = await fetch(QT + syms.join(','));
  if (!res.ok) throw new Error('行情读不到');
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const out = {};
  for (const line of text.split(';')) {
    const q = parseQuote(line.trim());
    if (q) out[q.sym] = { ...q, at: Date.now() };
  }
  return out;
}

// 每天的价格：[[日期, 收盘价], …]，从小到大。adjust = 'qfq' 前复权（看走势用，分红拆股不会断崖），'' 是当时的真实价格（算一共值多少用）
export async function fetchDaily(k, { days = 120, from = '', adjust = 'qfq' } = {}) {
  const res = await fetch(`${KLINE}${k},day,${from},,${days},${adjust}`);
  if (!res.ok) throw new Error('走势读不到');
  const data = (await res.json())?.data?.[k] || {};
  const rows = data[`${adjust}day`] || data.day || [];
  return rows.map((r) => [r[0], Number(r[2])]).filter((r) => r[1] > 0);
}

// 搜索：拼音、中文、代码都行。接口把结果写进全局变量 v_hint，一次只搜一个
let searching = Promise.resolve();
export function searchStocks(q) {
  const run = () => new Promise((resolve) => {
    const el = document.createElement('script');
    const timer = setTimeout(() => done(null), 8000);
    const done = (list) => { clearTimeout(timer); el.remove(); resolve(list); };
    window.v_hint = '';
    el.src = SMARTBOX + encodeURIComponent(q);
    el.onload = () => done(parseSearch(window.v_hint));
    el.onerror = () => done(null);
    (document.head || document.documentElement).append(el);
  });
  searching = searching.then(run, run);
  return searching;
}
