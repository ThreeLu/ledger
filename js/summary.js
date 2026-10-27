// 每周 / 每月总结要用的数：按天、按组、累计曲线、最近几个月的趋势，以及一条建议。纯计算。

import {
  GROUPS, LIVING, periodFor, shiftPeriod, periodStats, partial, livingBudget, budgetTotal, totalAssets,
  receivables, cny, category, addDays, parseYmd, ymd, money, md, txGroup, spendOf, isFromSaved, isLump, ADJUST_CAT, PACE_SLACK, plannedSoFar, onPace, wishFunds,
} from './money.js';

const groupOf = (data, t) => txGroup(data, t);
const r2 = (n) => Math.round(n * 100) / 100;

// 一周：周一到周日
export function weekOf(day) {
  const d = parseYmd(day);
  const back = (d.getDay() + 6) % 7;
  const start = addDays(day, -back);
  const end = addDays(start, 6);
  return { start, end, label: `${md(start)} – ${md(end)}` };
}

export function rangeStats(data, from, to) {
  const tx = data.tx.filter((t) => t.date >= from && t.date <= to);
  const byGroup = Object.fromEntries(GROUPS.map((g) => [g.id, 0]));
  const byCat = {}; // 类别 → { v, n }（点圆环时看这一组里花在哪）
  let income = 0;
  let lump = 0; // 一次性的钱（就当没有，不算收入，直接进存款）
  let fromSaved = 0; // 用以前留好的钱花的（专项、大额人情、心愿）
  for (const t of tx) {
    const v = spendOf(data, t);
    if (v) {
      byGroup[groupOf(data, t)] += v;
      if (isFromSaved(data, t)) fromSaved += v;
      const c = (byCat[t.type === 'adjust' ? ADJUST_CAT : t.category || ''] ||= { v: 0, n: 0 });
      c.v += v; c.n += 1;
    }
    else if (t.type === 'income') { if (isLump(data, t)) lump += cny(t); else income += cny(t); }
  }
  const total = Object.values(byGroup).reduce((a, b) => a + b, 0);
  const living = LIVING.reduce((s, g) => s + byGroup[g], 0);
  return { tx, byGroup, byCat, income, lump, total, living, fromSaved };
}

// 首页的储蓄率（2026-10-27 用户要的）：最近 12 个预算月（这个月算到今天），不满一年从开始记账算起。
// 看一整年，不定时的收入哪个月到、暑假没有收入都摊平了。口径和月、年报表一样：(收入 − 花销) ÷ 收入，一次性的钱不算。
export function rollingSavingRate(data, day) {
  let p = periodFor(data, day);
  for (let i = 0; i < 11; i++) p = shiftPeriod(data, p, -1); // shiftPeriod 一次只挪一个月
  const back = p.start;
  const sinceOpen = !!data.openingDate && data.openingDate > back;
  const from = sinceOpen ? data.openingDate : back;
  const st = rangeStats(data, from, day);
  if (st.income <= 0) return null;
  return { rate: (st.income - st.total) / st.income, from, sinceOpen, income: r2(st.income), total: r2(st.total) };
}

// 每天的生活花销（吃饭 + 日常 + 自由钱）
export function dailyLiving(data, from, days) {
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(from, i);
    const v = data.tx.filter((t) => t.date === day && spendOf(data, t) && LIVING.includes(groupOf(data, t))).reduce((s, t) => s + spendOf(data, t), 0);
    return { day, v };
  });
}

export function topSpends(data, from, to, n = 3) {
  return data.tx.filter((t) => t.date >= from && t.date <= to && (t.type === 'expense' || t.type === 'writeoff')).sort((a, b) => cny(b) - cny(a)).slice(0, n);
}

// 一个预算月里每天的生活预算（开始记账那个月按天数折算）
export function dailyBudget(data, p) {
  const part = partial(data, p);
  return part.days ? (livingBudget(data) * part.factor) / part.days : 0;
}

export function weekSummary(data, day, now = ymd(new Date())) {
  const w = weekOf(day);
  const st = rangeStats(data, w.start, w.end);
  const prevW = weekOf(addDays(w.start, -1));
  const prev = rangeStats(data, prevW.start, prevW.end);
  const perDay = dailyBudget(data, periodFor(data, w.start));
  // 开始记账之前的那几天不算计划（第一周只算记账以后的天数）
  const counted = (x) => !data.openingDate || x >= data.openingDate;
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(w.start, i));
  const plan = perDay * weekDays.filter(counted).length;
  // 这周还没过完时，按「到今天该花多少」看节奏
  const ongoing = w.start <= now && now < w.end;
  const soFar = ongoing ? perDay * weekDays.filter((x) => counted(x) && x <= now).length : plan;
  const diff = st.living - plan;
  const pace = st.living <= soFar * PACE_SLACK ? 'good' : 'warn';
  const headline = !st.total ? '这周还没有花销记录。'
    : ongoing ? `这周生活花了 ${money(st.living)}，${diff < 0 ? `还能花 ${money(-diff)}` : `超了 ${money(diff)}`}`
      : `这周生活花了 ${money(st.living)}，${Math.abs(diff) < plan * 0.05 ? '和计划差不多' : diff < 0 ? `比计划少 ${money(-diff)}` : `比计划多 ${money(diff)}`}`;
  return { ...w, st, prev, perDay, plan, soFar, ongoing, diff, pace, headline, days: dailyLiving(data, w.start, 7), top: topSpends(data, w.start, w.end), prevLabel: prevW.label };
}

// 预算月里生活花销的累计曲线和「按计划该花多少」的直线
export function cumulative(data, p) {
  const part = partial(data, p);
  const perDay = dailyBudget(data, p);
  const days = dailyLiving(data, p.start, p.days);
  let sum = 0;
  return days.map((x) => {
    sum += x.v;
    const plannedDays = x.day < part.from ? 0 : Math.round((parseYmd(x.day) - parseYmd(part.from)) / 86400000) + 1;
    return { day: x.day, actual: sum, planned: perDay * plannedDays };
  });
}

// 心愿基金按预算月看（只看「能随便用」的，和心愿单上的大字同一个数）：
// 月初 → 月底、中间每一类进出；省下率 = 生活费省下的 ÷ 生活预算（这个月过完才有）；最近 6 个月每月多了 / 少了多少、月底多少
export const WISH_FLOW = [
  ['saved', '生活费省下'], ['jobs', '兼职收入的三成'], ['back', '大额心愿退回'],
  ['over', '生活费超支扣回'], ['cover', '帮专项、看病补'], ['wish', '买心愿'], ['toBig', '攒给大额心愿'], ['toFree', '满一万转去存款'],
];
export function wishMonth(data, p, now = ymd(new Date())) {
  const f = wishFunds(data, now);
  const upTo = (day) => r2(f.flow.filter((x) => x.date <= day).reduce((a, x) => a + x.v, 0));
  const rows = (q) => {
    const by = {};
    for (const x of f.flow) if (x.date >= q.start && x.date <= q.end) by[x.k] = r2((by[x.k] || 0) + x.v);
    return WISH_FLOW.filter(([k]) => by[k]).map(([k, name]) => ({ k, name, v: by[k] }));
  };
  const lbOf = (q) => livingBudget(data) * partial(data, q).factor;
  const rateOf = (q) => {
    const l = f.log.find((x) => x.p.start === q.start);
    const lb = lbOf(q);
    return l && lb > 0 ? { leftover: l.leftover, rate: l.leftover / lb } : null;
  };
  const ongoing = p.start <= now && now <= p.end;
  const start = upTo(addDays(p.start, -1));
  const end = upTo(ongoing ? now : p.end);
  const prevP = shiftPeriod(data, p, -1);
  const hist = [];
  for (let q = p, i = 0; i < 6 && !(data.openingDate && q.end < data.openingDate); q = shiftPeriod(data, q, -1), i++) {
    const qEnd = upTo(q.start <= now && now <= q.end ? now : q.end);
    hist.unshift({ p: q, net: r2(qEnd - upTo(addDays(q.start, -1))), end: qEnd });
  }
  return {
    start, end, rows: rows(p), ongoing, rate: rateOf(p), prevRate: rateOf(prevP),
    // 还没过完：现在生活费还剩多少（过完剩下的会进来，超了会扣）
    livingNow: ongoing ? r2(lbOf(p) - periodStats(data, p).living) : null,
    hist,
  };
}

// 最近 n 个预算月：收入、花销、存下、月底总资产
export function history(data, p, n = 6, rate = data.settings.usdRate) {
  const out = [];
  let q = p;
  for (let i = 0; i < n; i++) {
    if (data.openingDate && q.end < data.openingDate) break;
    const st = periodStats(data, q);
    out.unshift({ p: q, income: st.income, total: st.total, saved: st.income - st.total, assets: totalAssets(data, rate, q.end) });
    q = shiftPeriod(data, q, -1);
  }
  return out;
}

// 预算月开头、结尾的待收回（垫付 + 别人欠的）
export function owedAt(data, day) {
  const cut = { ...data, tx: data.tx.filter((t) => t.date <= day) };
  return receivables(cut).toMe;
}

// 下个月可以试试的一条建议（只给一条）
export function advice(data, p, st, prevSt) {
  const part = partial(data, p);
  const over = GROUPS.filter((g) => data.budget[g.id] && st.spent[g.id] > data.budget[g.id] * part.factor * 1.1)
    .map((g) => ({ g, over: st.spent[g.id] - data.budget[g.id] * part.factor })).sort((a, b) => b.over - a.over)[0];
  if (over) {
    if (over.g.id === 'food') return `吃饭超了 ${money(over.over)}。下个月出去吃、点外卖少一两次，就能补回来。`;
    if (over.g.id === 'free') return `自由钱超了 ${money(over.over)}。下个月想买东西时先放一放，过几天还想要再买。`;
    return `${over.g.name}超了 ${money(over.over)}。看看「最大的几笔」里有没有一次性的开销，是的话不用担心。`;
  }
  if (prevSt) {
    const grew = Object.entries(st.byCat)
      .filter(([id]) => category(data, id)?.group !== 'none') // 手续费、出差自付不是自己能控制的，不拿来提建议
      .map(([id, v]) => ({ id, v, d: v - (prevSt.byCat[id] || 0) }))
      .filter((x) => x.d > 100 && x.d > (prevSt.byCat[x.id] || 0) * 0.3)
      .sort((a, b) => b.d - a.d)[0];
    if (grew) return `「${category(data, grew.id)?.name || '其他'}」比上个月多了 ${money(grew.d)}，留意一下是不是一次性的。`;
  }
  const target = (Number(data.settings.expectedIncome) || 0) - budgetTotal(data);
  if (!part.isPartial && !p.summer && target > 0 && st.saved >= target) return '这个月存钱达标了，保持现在的节奏就好。';
  return '保持每天记账的习惯，下个月的数据会更准，建议也会更具体。';
}

export function monthSummary(data, day, rate, now = ymd(new Date())) {
  const p = periodFor(data, day);
  const st = periodStats(data, p);
  const prevP = shiftPeriod(data, p, -1);
  const prevSt = data.openingDate && prevP.end >= data.openingDate ? periodStats(data, prevP) : null;
  const part = partial(data, p);
  const lb = livingBudget(data) * part.factor;
  const headline = !st.total && !st.income ? '这个预算月还没有记录。'
    : `收入 ${money(st.income)}，花了 ${money(st.total)}${st.income ? `，存下 ${money(st.income - st.total)}` : ''}。生活花销${st.living <= lb ? `在预算内（${money(st.living)} / ${money(lb)}）` : `超了 ${money(st.living - lb)}`}。`;
  const curve = cumulative(data, p);
  // 这个预算月还没过完时，按「到今天该花多少」看生活花销的节奏
  const ongoing = p.start <= now && now < p.end;
  const soFar = ongoing ? (curve.find((x) => x.day === now)?.planned ?? lb) : lb;
  const pace = (ongoing ? onPace(st.living, plannedSoFar(data, p, now)) : st.living <= soFar * PACE_SLACK) ? 'good' : 'warn';
  return {
    p, st, prevSt, part, headline, lb, ongoing, soFar, pace,
    curve,
    hist: history(data, p, 6, rate),
    owedStart: owedAt(data, addDays(p.start, -1)),
    owedEnd: owedAt(data, p.end),
    advice: advice(data, p, st, prevSt),
  };
}

export { ymd };
