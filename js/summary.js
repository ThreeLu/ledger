// 每周 / 每月总结要用的数：按天、按组、累计曲线、最近几个月的趋势，以及一条建议。纯计算。

import {
  GROUPS, LIVING, periodFor, shiftPeriod, periodStats, partial, livingBudget, budgetTotal, totalAssets,
  receivables, cny, category, addDays, parseYmd, ymd, money, md,
} from './money.js';

const isSpend = (t) => t.type === 'expense' || t.type === 'writeoff';
const groupOf = (data, t) => category(data, t.category)?.group || 'daily';

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
  let income = 0;
  for (const t of tx) {
    if (isSpend(t)) byGroup[groupOf(data, t)] += cny(t);
    else if (t.type === 'income') income += cny(t);
  }
  const total = Object.values(byGroup).reduce((a, b) => a + b, 0);
  const living = LIVING.reduce((s, g) => s + byGroup[g], 0);
  return { tx, byGroup, income, total, living };
}

// 每天的生活花销（吃饭 + 日常 + 自由钱）
export function dailyLiving(data, from, days) {
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(from, i);
    const v = data.tx.filter((t) => t.date === day && isSpend(t) && LIVING.includes(groupOf(data, t))).reduce((s, t) => s + cny(t), 0);
    return { day, v };
  });
}

export function topSpends(data, from, to, n = 3) {
  return data.tx.filter((t) => t.date >= from && t.date <= to && isSpend(t)).sort((a, b) => cny(b) - cny(a)).slice(0, n);
}

// 一个预算月里每天的生活预算（开始记账那个月按天数折算）
export function dailyBudget(data, p) {
  const part = partial(data, p);
  return part.days ? (livingBudget(data) * part.factor) / part.days : 0;
}

export function weekSummary(data, day) {
  const w = weekOf(day);
  const st = rangeStats(data, w.start, w.end);
  const prevW = weekOf(addDays(w.start, -1));
  const prev = rangeStats(data, prevW.start, prevW.end);
  const perDay = dailyBudget(data, periodFor(data, w.start));
  // 开始记账之前的那几天不算计划（第一周只算记账以后的天数）
  const tracked = Array.from({ length: 7 }, (_, i) => addDays(w.start, i)).filter((x) => !data.openingDate || x >= data.openingDate).length;
  const plan = perDay * tracked;
  const diff = st.living - plan;
  const headline = !st.total ? '这周还没有花销记录。'
    : `这周生活花了 ${money(st.living)}，${Math.abs(diff) < plan * 0.05 ? '和计划差不多' : diff < 0 ? `比计划少 ${money(-diff)}` : `比计划多 ${money(diff)}`}${diff <= plan * 0.1 ? '，节奏正常' : '，下周稍微收一收'}。`;
  return { ...w, st, prev, perDay, plan, headline, days: dailyLiving(data, w.start, 7), top: topSpends(data, w.start, w.end), prevLabel: prevW.label };
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

export function monthSummary(data, day, rate) {
  const p = periodFor(data, day);
  const st = periodStats(data, p);
  const prevP = shiftPeriod(data, p, -1);
  const prevSt = data.openingDate && prevP.end >= data.openingDate ? periodStats(data, prevP) : null;
  const part = partial(data, p);
  const lb = livingBudget(data) * part.factor;
  const headline = !st.total && !st.income ? '这个预算月还没有记录。'
    : `收入 ${money(st.income)}，花了 ${money(st.total)}${st.income ? `，存下 ${money(st.income - st.total)}` : ''}。生活花销${st.living <= lb ? `在预算内（${money(st.living)} / ${money(lb)}）` : `超了 ${money(st.living - lb)}`}。`;
  return {
    p, st, prevSt, part, headline,
    curve: cumulative(data, p),
    hist: history(data, p, 6, rate),
    owedStart: owedAt(data, addDays(p.start, -1)),
    owedEnd: owedAt(data, p.end),
    advice: advice(data, p, st, prevSt),
  };
}

// 一年的总结（自然年 1 月 1 日到 12 月 31 日；开始记账那年从开始记账那天算）
export function yearSummary(data, year, rate = data.settings.usdRate) {
  const from = data.openingDate && data.openingDate > `${year}-01-01` ? data.openingDate : `${year}-01-01`;
  const to = `${year}-12-31`;
  const st = rangeStats(data, from, to);
  const byCat = {};
  for (const t of st.tx) if (isSpend(t)) byCat[t.category] = (byCat[t.category] || 0) + cny(t);
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = `${year}-${String(i + 1).padStart(2, '0')}`;
    const ms = rangeStats(data, `${m}-01`, `${m}-31`);
    return { m: i + 1, income: ms.income, total: ms.total, saved: ms.income - ms.total, active: `${m}-31` >= from };
  });
  const days = new Set(data.tx.filter((t) => t.date >= from && t.date <= to && !t.auto && t.type !== 'adjust').map((t) => t.date));
  const span = Math.max(1, Math.round((Math.min(new Date(to.replace(/-/g, '/')), new Date()) - new Date(from.replace(/-/g, '/'))) / 86400000) + 1);
  const inYear = (d0) => d0 && d0 >= from && d0 <= to;
  const subs = ['c-ai', 'c-soft', 'c-member'].reduce((a, id) => a + (byCat[id] || 0), 0);
  const dayBefore = addDays(from, -1);
  return {
    year, from, to, st, byCat, months,
    saved: st.income - st.total,
    rate: st.income ? Math.round(((st.income - st.total) / st.income) * 100) : null,
    top: topSpends(data, from, to, 5),
    cats: Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 8),
    days: days.size, span,
    wishesBought: data.wishes.filter((w) => w.status === 'bought' && inYear(w.boughtAt)),
    wishesDropped: data.wishes.filter((w) => w.status === 'dropped' && inYear(w.droppedAt)),
    taxRefund: data.tx.filter((t) => t.category === 'i-tax' && inYear(t.date)).reduce((a, t) => a + cny(t), 0),
    subs,
    assetsStart: totalAssets(data, rate, dayBefore),
    assetsEnd: totalAssets(data, rate, to),
  };
}

export { ymd };
