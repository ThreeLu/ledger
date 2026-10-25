// 模拟交易：纯计算（开盘时间、一手、T+1、手续费、持仓、现金、走势）。不是钱，不进账本的任何计算。
// 行情从腾讯拉（js 里的 quote / search / kline），规则按真的来：只在开盘时间按买一 / 卖一价成交。

export const START_CASH = 10000;

export const HOLD = [['days', '几天'], ['weeks', '几周'], ['months', '几个月'], ['years', '几年'], ['unknown', '还不知道']];
export const holdName = (k) => HOLD.find((x) => x[0] === k)?.[1] || '';
export const LOOK = [['right', '想对了'], ['wrong', '想错了'], ['unsure', '说不清']];
export const lookName = (k) => LOOK.find((x) => x[0] === k)?.[1] || '';

const r2 = (n) => Math.round(n * 100) / 100;

// 某个时区的「现在」：日期、一天里第几分钟、星期几
export function zoned(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute),
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}
export const bjDate = (now = new Date()) => zoned(now, 'Asia/Shanghai').date;

// 美股开盘（纽约 9:30）是北京时间几点：夏令时 21:30，冬令时 22:30
function usOpenBj(now) {
  const ny = zoned(now, 'America/New_York');
  const bj = zoned(now, 'Asia/Shanghai');
  let diff = bj.min - ny.min + (bj.date === ny.date ? 0 : 1440);
  diff = ((diff % 1440) + 1440) % 1440;
  const m = (570 + diff) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// 开没开盘。quoteDate 是行情最后成交的日子（当地日期）：工作日开盘时间里行情却不是今天的 = 节假日休市
export function marketState(mkt, now = new Date(), quoteDate = null) {
  if (mkt === 'US') {
    const ny = zoned(now, 'America/New_York');
    const open = usOpenBj(now);
    const weekday = ny.wd >= 1 && ny.wd <= 5;
    if (weekday && ny.min >= 570 && ny.min < 960) {
      if (quoteDate && quoteDate !== ny.date && ny.min >= 600) return { open: false, text: '美股今天休市' };
      return { open: true, text: '美股开盘中' };
    }
    return { open: false, text: `美股休市 · 北京时间 ${open} 开盘` };
  }
  const bj = zoned(now, 'Asia/Shanghai');
  const weekday = bj.wd >= 1 && bj.wd <= 5;
  const inHours = (bj.min >= 570 && bj.min < 690) || (bj.min >= 780 && bj.min < 900);
  if (weekday && inHours) {
    if (quoteDate && quoteDate !== bj.date && bj.min >= 580) return { open: false, text: 'A 股今天休市' };
    return { open: true, text: 'A 股开盘中' };
  }
  if (weekday && bj.min < 570) return { open: false, text: 'A 股 9:30 开盘' };
  if (weekday && bj.min >= 690 && bj.min < 780) return { open: false, text: 'A 股午休 · 13:00 开盘' };
  return { open: false, text: bj.wd === 5 || bj.wd === 6 || bj.wd === 0 ? 'A 股休市 · 周一 9:30 开盘' : 'A 股收盘了 · 明天 9:30 开盘' };
}

// 哪个市场：sh / sz / bj 开头是 A 股，us 开头是美股
export const marketOf = (sym) => (sym.startsWith('us') ? 'US' : 'A');
export const isStockA = (s) => marketOf(s.sym) === 'A' && String(s.kind || '').startsWith('GP');
const isKcb = (sym) => /^sh688/.test(sym);
// 当天买当天能卖（T+0）：跨境（QDII）、黄金、债券、货币 ETF，美股。其他 A 股、ETF 是 T+1
export function tPlus0(s) {
  if (marketOf(s.sym) === 'US') return true;
  return /QDII/.test(s.kind || '') || /黄金|债|货币|短融/.test(s.name || '');
}

// 一次最少买多少、每次加多少：A 股 100 股一手（科创板最少 200 股、之后 1 股 1 股加），美股 1 股
export function lot(sym) {
  if (marketOf(sym) === 'US') return { min: 1, step: 1, unit: '股' };
  if (isKcb(sym)) return { min: 200, step: 1, unit: '股' };
  return { min: 100, step: 100, unit: '股' };
}

// 手续费（按常见券商）。A 股：佣金万 2.5、最低 5 元；股票另收过户费十万分之一、卖出印花税千分之 0.5；ETF 只收佣金。
// 美股：佣金每股 0.0049 美元（最低 0.99）+ 平台费每股 0.005（最低 1）；卖出另收证监会费（成交额的 0.00278%，最低 0.01）
export function fees(s, side, qty, price) {
  const amt = qty * price;
  if (marketOf(s.sym) === 'US') {
    let f = Math.max(0.99, 0.0049 * qty) + Math.max(1, 0.005 * qty);
    if (side === 'sell') f += Math.max(0.01, amt * 0.0000278);
    return r2(f);
  }
  let f = Math.max(5, amt * 0.00025);
  if (isStockA(s)) {
    f += amt * 0.00001;
    if (side === 'sell') f += amt * 0.0005;
  }
  return r2(f);
}

const ofGame = (sim, game) => sim.trades.filter((t) => t.game === game);
export const currentGame = (sim) => sim.games.find((g) => !g.end) || null;

// 现金：起始的钱 − 买进花的 + 卖出拿回的（都按人民币）
export function cash(sim, game) {
  const g = sim.games.find((x) => x.id === game);
  return r2(ofGame(sim, game).reduce((s, t) => s + (t.side === 'sell' ? t.cny : -t.cny), g?.cash ?? START_CASH));
}

// 持有：每只股票还有多少、成本（人民币，含手续费，卖出按平均成本减掉）、今天还能卖多少
export function positions(sim, game, now = new Date()) {
  const map = new Map();
  for (const t of [...ofGame(sim, game)].sort((a, b) => a.at.localeCompare(b.at))) {
    const p = map.get(t.sym) || { sym: t.sym, k: t.k, name: t.name, kind: t.kind, mkt: marketOf(t.sym), qty: 0, cost: 0, costNative: 0, todayBought: 0, first: t.at };
    if (t.side === 'buy') {
      if (p.qty === 0) p.first = t.at;
      p.qty += t.qty; p.cost += t.cny; p.costNative += t.qty * t.price + t.fee;
    } else {
      const share = p.qty ? t.qty / p.qty : 1;
      p.cost -= p.cost * share; p.costNative -= p.costNative * share; p.qty -= t.qty;
    }
    if (p.qty === 0) { p.cost = 0; p.costNative = 0; }
    p.name = t.name;
    map.set(t.sym, p);
  }
  const today = bjDate(now);
  return [...map.values()].filter((p) => p.qty > 0).map((p) => {
    const boughtToday = tPlus0(p) ? 0 : ofGame(sim, game).filter((t) => t.sym === p.sym && t.side === 'buy' && t.date === today).reduce((s, t) => s + t.qty, 0);
    return { ...p, cost: r2(p.cost), avg: p.costNative / p.qty, sellable: Math.max(0, p.qty - boughtToday) };
  });
}

// 一笔买卖能不能成交（价格、开盘、涨跌停、数量、钱够不够），能的话算出成交价、手续费、人民币进出
// q：行情 { price, bid, bidVol, ask, askVol, date }；rate：1 美元换多少人民币
export function checkOrder(sim, game, s, side, qty, q, rate, now = new Date()) {
  const mkt = marketOf(s.sym);
  const st = marketState(mkt, now, q?.date);
  if (!st.open) return { error: `${st.text}，现在不能${side === 'buy' ? '买' : '卖'}` };
  if (!Number.isInteger(qty) || qty <= 0) return { error: '填一下多少股' };
  const l = lot(s.sym);
  const pos = positions(sim, game, now).find((p) => p.sym === s.sym);
  if (side === 'buy') {
    if (qty < l.min) return { error: `最少买 ${l.min} 股` };
    if ((qty - l.min) % l.step) return { error: `A 股要按整手买，${l.step} 股一手` };
    if (!(q.ask > 0) || !(q.askVol > 0)) return { error: mkt === 'A' ? '现在没人卖（多半涨停了），买不到' : '现在没有卖价，买不到' };
  } else {
    if (!pos) return { error: '没有这只' };
    if (qty > pos.sellable) return { error: pos.sellable < pos.qty ? `今天买的明天才能卖，现在能卖 ${pos.sellable} 股` : `只有 ${pos.qty} 股` };
    if (qty < pos.qty && mkt === 'A' && qty % 100) return { error: '不是全卖的话，要按 100 股的整数卖' };
    if (!(q.bid > 0) || !(q.bidVol > 0)) return { error: mkt === 'A' ? '现在没人买（多半跌停了），卖不出去' : '现在没有买价，卖不出去' };
  }
  const price = side === 'buy' ? q.ask : q.bid;
  const fee = fees(s, side, qty, price);
  const fx = mkt === 'US' ? rate : 1;
  const cny = r2((side === 'buy' ? qty * price + fee : qty * price - fee) * fx);
  if (side === 'buy' && cny > cash(sim, game)) return { error: `钱不够：要 ¥${cny.toLocaleString('zh-CN')}，现金只有 ¥${cash(sim, game).toLocaleString('zh-CN')}`, price, fee, cny };
  return { price, fee, rate: fx, cny };
}

// 能买的最多股数（按现在的卖一价，扣掉手续费）
export function maxBuy(sim, game, s, ask, rate) {
  if (!(ask > 0)) return 0;
  const l = lot(s.sym);
  const fx = marketOf(s.sym) === 'US' ? rate : 1;
  const c = cash(sim, game);
  let n = Math.floor(c / fx / ask / l.step) * l.step;
  if (l.min > l.step) n = Math.floor(c / fx / ask);
  while (n >= l.min && (n * ask + fees(s, 'buy', n, ask)) * fx > c) n -= l.step;
  return n >= l.min ? n : 0;
}

// 现在一共值多少：现金 + 每只按现价（美股按汇率换成人民币）。没有现价的按成本算
export function worth(sim, game, quotes, rate, now = new Date()) {
  const pos = positions(sim, game, now).map((p) => {
    const q = quotes[p.sym];
    const fx = p.mkt === 'US' ? rate : 1;
    const value = q?.price > 0 ? r2(p.qty * q.price * fx) : p.cost;
    return { ...p, price: q?.price, value, gain: r2(value - p.cost), pct: p.cost ? (value - p.cost) / p.cost : 0 };
  });
  const c = cash(sim, game);
  const hold = r2(pos.reduce((s, p) => s + p.value, 0));
  const g = sim.games.find((x) => x.id === game);
  const total = r2(c + hold);
  return { cash: c, hold, total, start: g?.cash ?? START_CASH, pct: (total - (g?.cash ?? START_CASH)) / (g?.cash ?? START_CASH), pos };
}

// 每天收盘时一共值多少（画走势）。closes：{ sym: [[日期, 收盘价], …] }，日期从小到大；美股都按现在的汇率
export function worthSeries(sim, game, closes, rate, today, live = {}) {
  const g = sim.games.find((x) => x.id === game);
  if (!g) return [];
  const trades = ofGame(sim, game).sort((a, b) => a.at.localeCompare(b.at));
  const out = [];
  for (let d = g.start; d <= today; d = addDay(d)) {
    let c = g.cash;
    const qty = {};
    for (const t of trades) {
      if (t.date > d) break;
      c += t.side === 'sell' ? t.cny : -t.cny;
      qty[t.sym] = (qty[t.sym] || 0) + (t.side === 'buy' ? t.qty : -t.qty);
    }
    let v = c;
    for (const [sym, n] of Object.entries(qty)) {
      if (!n) continue;
      let px = d === today && live[sym] > 0 ? live[sym] : null;
      if (px == null) for (const [day, close] of closes[sym] || []) { if (day > d) break; px = close; }
      if (px == null) px = trades.find((t) => t.sym === sym && t.date <= d)?.price || 0;
      v += n * px * (marketOf(sym) === 'US' ? rate : 1);
    }
    out.push([d, r2(v)]);
  }
  return out;
}
function addDay(d) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

// 回头看：卖出一周后、买入一个月后问一句「当时想得对吗」。一次只问最早的一笔
export function lookbackDue(sim, today) {
  return sim.trades.filter((t) => !t.look && daysBetween(t.date, today) >= (t.side === 'sell' ? 7 : 30))
    .sort((a, b) => a.at.localeCompare(b.at))[0] || null;
}

// 月度复盘：上个月有买卖、还没写过 → 该写了
export function reviewDue(sim, today) {
  const month = prevMonth(today.slice(0, 7));
  if (sim.reviews.some((r) => r.month === month)) return null;
  return sim.trades.some((t) => t.date.slice(0, 7) === month) ? month : null;
}
export function prevMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

// 解析腾讯行情的一行（v_sh600519="1~贵州茅台~600519~…"）。A 股时间是 20261023161458，美股是 2026-10-23 16:00:01（纽约时间）
export function parseQuote(line) {
  const m = line.match(/^v_(\w+)="(.*)"/);
  if (!m || !m[2].includes('~')) return null;
  const f = m[2].split('~');
  const num = (i) => Number(f[i]) || 0;
  const time = f[30] || '';
  const date = /^\d{14}$/.test(time) ? `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}` : time.slice(0, 10);
  return { sym: m[1], name: f[1], code: f[2], price: num(3), prev: num(4), open: num(5), bid: num(9), bidVol: num(10), ask: num(19), askVol: num(20),
    date, time, change: num(31), pct: num(32), high: num(33), low: num(34) };
}

// 解析搜索结果（sh~600519~贵州茅台~gzmt~GP-A^us~aapl.oq~Apple~apple~GP）：只要 A 股（股票、ETF、LOF）和美股
export function parseSearch(text) {
  return String(text || '').split('^').map((x) => x.split('~')).filter((f) => f.length >= 5).map(([ex, code, name, , kind]) => {
    if (ex === 'us') {
      const base = code.split('.')[0].toUpperCase();
      return { sym: `us${base}`, k: `us${code.toUpperCase()}`, code: base, name, kind, mkt: 'US' };
    }
    if (!['sh', 'sz', 'bj'].includes(ex)) return null;
    if (!/^GP-A|ETF|LOF/.test(kind)) return null;
    return { sym: `${ex}${code}`, k: `${ex}${code}`, code, name, kind, mkt: 'A' };
  }).filter(Boolean);
}
