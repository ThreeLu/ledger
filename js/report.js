// 月度财务报表（总结页的「月」，2026-10-25 用户要的）：按预算月，像正规报表那样分几部分，每部分一张图 + 一张表。纯计算。
// 一、关键数字 二、收支表 三、资产表（按账户、按用途） 四、预算执行 五、花销明细 六、趋势 七、附注
// 这个月还没过完时，数字算到今天（asOf）。

import {
  GROUPS, periodFor, shiftPeriod, periodStats, partial, livingBudget, totalAssets, receivables, savingsMap,
  balance, cny, category, addDays, spendOf, txGroup, isLump, noneParts, ymd, ADJUST_CAT, daysBetween,
} from './money.js';
import { rangeStats, dailyLiving, topSpends, cumulative, wishMonth, advice } from './summary.js';

const r2 = (n) => Math.round(n * 100) / 100;
const catName = (data, id) => (id === ADJUST_CAT ? '对账差额' : category(data, id)?.name || '其他');

// 只看到某一天为止的账（算月初、月底的家底用）
const upTo = (data, day) => ({ ...data, tx: data.tx.filter((t) => t.date <= day) });

// 净资产 = 所有账户（美元按 rate 折算）+ 别人欠我的 − 我欠别人的
export function netWorthAt(data, day, rate) {
  const rc = receivables(upTo(data, day));
  const assets = totalAssets(data, rate, day);
  return { assets: r2(assets), toMe: r2(rc.toMe), iOwe: r2(rc.iOwe), net: r2(assets + rc.toMe - rc.iOwe) };
}

// 按用途分（和「钱都在哪」一样的几类），加起来 = 净资产
export function purposesAt(data, day, rate) {
  const m = savingsMap(upTo(data, day), day, rate);
  return [
    ['家庭存款', m.family.have],
    ['应急底线', m.emergency.have],
    ['医疗备用金', m.medical.have],
    ['专项存款', m.specials.reduce((a, x) => a + x.have, 0)],
    ['自由存款', m.free.have],
    ['心愿基金', Math.max(0, m.wish.total)],
    ['生活费还剩', m.living],
  ].map(([name, v]) => ({ name, v: r2(v) }));
}

const incomeByCat = (data, txs) => {
  const out = {};
  for (const t of txs) if (t.type === 'income' && !isLump(data, t)) out[t.category] = r2((out[t.category] || 0) + cny(t));
  return out;
};

export function monthReport(data, day, rate, now = ymd(new Date())) {
  const p = periodFor(data, day);
  const ongoing = p.start <= now && now < p.end;
  const asOf = ongoing ? now : p.end;
  const part = partial(data, p);
  const st = periodStats(data, { ...p, end: asOf });
  const prevP = shiftPeriod(data, p, -1);
  const hasPrev = !data.openingDate || prevP.end >= data.openingDate;
  const prev = hasPrev ? periodStats(data, prevP) : null;
  const before = addDays(p.start, -1);

  // 一、关键数字
  const startNW = netWorthAt(data, before, rate);
  const endNW = netWorthAt(data, asOf, rate);
  const prevStartNW = hasPrev ? netWorthAt(data, addDays(prevP.start, -1), rate) : null;
  const rateOf = (s) => (s && s.income > 0 ? (s.income - s.total) / s.income : null);
  const key = {
    income: r2(st.income), total: r2(st.total), saved: r2(st.income - st.total), savingRate: rateOf(st),
    net: endNW.net, netChange: r2(endNW.net - startNW.net),
    prev: prev ? { income: r2(prev.income), total: r2(prev.total), saved: r2(prev.income - prev.total), savingRate: rateOf(prev), netChange: r2(startNW.net - prevStartNW.net) } : null,
  };

  // 二、收支表：收入按类别、支出按组；瀑布图从收入一块块扣到存下
  const inNow = incomeByCat(data, st.tx);
  const inPrev = prev ? incomeByCat(data, prev.tx) : {};
  const income = [...new Set([...Object.keys(inNow), ...Object.keys(inPrev)])]
    .map((id) => ({ id, name: catName(data, id), v: inNow[id] || 0, prev: prev ? inPrev[id] || 0 : null }))
    .sort((a, b) => b.v - a.v || b.prev - a.prev);
  const spend = GROUPS.filter((g) => st.spent[g.id] >= 0.005 || (prev && prev.spent[g.id] >= 0.005))
    .map((g) => ({ id: g.id, name: g.name, color: g.color, v: r2(st.spent[g.id]), prev: prev ? r2(prev.spent[g.id]) : null }));

  // 三、资产表
  const accounts = data.accounts.map((a) => {
    const fx = a.currency === 'USD' ? rate : 1;
    return { id: a.id, name: a.name, usd: a.currency === 'USD', start: r2(balance(data, a.id, before) * fx), end: r2(balance(data, a.id, asOf) * fx) };
  }).filter((a) => a.start || a.end);
  const pStart = purposesAt(data, before, rate);
  const pEnd = purposesAt(data, asOf, rate);
  const purposes = pEnd.map((x, i) => ({ name: x.name, start: pStart[i].v, end: x.v })).filter((x) => Math.abs(x.start) >= 0.005 || Math.abs(x.end) >= 0.005); // 自由存款可以是负的：留出来的比卡里的多

  // 四、预算执行（开始记账那个月按天数折算）
  const budget = GROUPS.filter((g) => Number(data.budget?.[g.id]) > 0).map((g) => {
    const b = Math.round(data.budget[g.id] * part.factor);
    return { id: g.id, name: g.name, color: g.color, budget: b, v: r2(st.spent[g.id]), pct: b ? st.spent[g.id] / b : 0 };
  });
  const lb = livingBudget(data) * part.factor;

  // 五、花销明细
  const rs = rangeStats(data, p.start, asOf);
  const prevCat = prev ? Object.fromEntries(Object.entries(prev.byCat)) : {};
  const cats = Object.entries(rs.byCat).map(([id, c]) => ({ id, name: catName(data, id), v: r2(c.v), n: c.n, share: rs.total ? c.v / rs.total : 0, prev: prev ? r2(prevCat[id] || 0) : null }))
    .sort((a, b) => b.v - a.v);
  const days = dailyLiving(data, p.start, p.days).map((x) => ({ ...x, v: r2(x.v), future: x.day > asOf, before: Boolean(data.openingDate && x.day < data.openingDate) }));
  const counted = days.filter((x) => !x.future && !x.before);
  const calendar = {
    days,
    avg: counted.length ? r2(counted.reduce((a, x) => a + x.v, 0) / counted.length) : 0,
    max: counted.reduce((m, x) => (x.v > (m?.v ?? -1) ? x : m), null),
    zero: counted.filter((x) => x.v < 0.005).length,
    counted: counted.length,
  };

  // 六、趋势：最近 6 个预算月
  const trend = [];
  for (let q = p, i = 0; i < 6 && !(data.openingDate && q.end < data.openingDate); q = shiftPeriod(data, q, -1), i++) {
    const s = periodStats(data, q.start === p.start ? { ...q, end: asOf } : q);
    trend.unshift({ p: q, income: r2(s.income), total: r2(s.total), saved: r2(s.income - s.total), rate: rateOf(s), net: netWorthAt(data, q.start === p.start ? asOf : q.end, rate).net });
  }

  // 开头几个月什么都没记（开始记账以前），不放进趋势
  while (trend.length > 1 && !trend[0].income && !trend[0].total) trend.shift();

  // 七、附注：有才写
  const inP = (d0) => d0 && d0 >= p.start && d0 <= asOf;
  const lumps = st.tx.filter((t) => isLump(data, t)).map((t) => ({ name: t.note || catName(data, t.category), v: cny(t), date: t.date }));
  const taxRefund = r2(st.tx.filter((t) => t.type === 'income' && t.category === 'i-tax').reduce((a, t) => a + cny(t), 0));
  const subs = st.tx.filter((t) => spendOf(data, t) && txGroup(data, t) === 'sub').map((t) => ({ name: t.note || catName(data, t.category), v: spendOf(data, t), date: t.date }));
  const notes = {
    lumps,
    fromSaved: noneParts(data, st.tx),
    owedStart: startNW.toMe, owedEnd: endNW.toMe, iOweStart: startNW.iOwe, iOweEnd: endNW.iOwe,
    taxRefund,
    subs,
    wish: wishMonth(data, p, now),
    wishesBought: (data.wishes || []).filter((w) => w.status === 'bought' && inP(w.boughtAt)).map((w) => ({ name: w.name, v: Number(w.boughtPrice ?? w.price) || 0 })),
    milestones: Object.values(data.milestones?.reached || {}).filter((x) => inP(x.at)).map((x) => x.text),
  };

  return {
    p, ongoing, asOf, part, st, prev, key, income, spend, startNW, endNW, accounts, purposes,
    budget, lb, curve: cumulative(data, p), cats, top: topSpends(data, p.start, asOf, 5), rs, calendar, trend, notes,
    advice: advice(data, p, st, prev),
  };
}

// ---------- 年度报表（2026-10-25，按自然年：1 月 1 日到 12 月 31 日，开始记账那年从开始记账那天算） ----------

// 一段日子里计划存多少：每个有收入的月「预计收入 − 预算」，暑假的月「− 预算」，不满一个月按天数折算
export function planBetween(data, from, to) {
  const inc = Number(data.settings.expectedIncome) || 0;
  const out = GROUPS.reduce((s, g) => s + (Number(data.budget?.[g.id]) || 0), 0);
  const summer = data.settings.summerMonths || [];
  let plan = 0;
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (let m = 1; m <= 12; m++) {
      const days = new Date(y, m, 0).getDate();
      const ms = `${y}-${String(m).padStart(2, '0')}-01`;
      const me = `${ms.slice(0, 8)}${String(days).padStart(2, '0')}`;
      const a = ms > from ? ms : from;
      const b = me < to ? me : to;
      if (a > b) continue;
      plan += ((daysBetween(a, b) + 1) / days) * ((summer.includes(m) ? 0 : inc) - out);
    }
  }
  return r2(plan);
}

export function yearReport(data, year, rate, now = ymd(new Date())) {
  const jan1 = `${year}-01-01`;
  const dec31 = `${year}-12-31`;
  const from = data.openingDate && data.openingDate > jan1 ? data.openingDate : jan1;
  const ongoing = now >= jan1 && now < dec31;
  const asOf = ongoing ? now : dec31;
  const started = from <= asOf;
  const st = rangeStats(data, from, asOf);
  const before = addDays(from, -1);
  const startNW = netWorthAt(data, before, rate);
  const endNW = netWorthAt(data, asOf, rate);
  const rateOf = (s) => (s.income > 0 ? (s.income - s.total) / s.income : null);
  const key = { income: r2(st.income), total: r2(st.total), saved: r2(st.income - st.total), savingRate: rateOf(st), net: endNW.net, netChange: r2(endNW.net - startNW.net) };

  // 每个自然月：收支、各块花销、各块用了预算的几成（预算按这个月记账的天数折算）、月底净资产、累计存下和计划
  let cum = 0;
  let cumPlan = 0;
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const days = new Date(year, m, 0).getDate();
    const ms = `${year}-${String(m).padStart(2, '0')}-01`;
    const me = `${ms.slice(0, 8)}${String(days).padStart(2, '0')}`;
    const a = ms > from ? ms : from;
    const b = me < asOf ? me : asOf;
    if (a > b) return { m, active: false };
    const s = rangeStats(data, a, b);
    const share = (daysBetween(a, b) + 1) / days;
    const used = Object.fromEntries(GROUPS.filter((g) => Number(data.budget?.[g.id]) > 0)
      .map((g) => [g.id, s.byGroup[g.id] / (data.budget[g.id] * share)]));
    cum += s.income - s.total + s.fromSaved; // 用以前留好的钱花的不算没存够（和首页、月度一样）
    cumPlan += planBetween(data, a, b);
    return {
      m, active: true, from: a, to: b, income: r2(s.income), total: r2(s.total), saved: r2(s.income - s.total), rate: rateOf(s),
      byGroup: Object.fromEntries(Object.entries(s.byGroup).map(([k, v]) => [k, r2(v)])), used, net: netWorthAt(data, b, rate).net,
      cum: r2(cum), cumPlan: r2(cumPlan),
    };
  });

  const accounts = data.accounts.map((a) => {
    const fx = a.currency === 'USD' ? rate : 1;
    return { id: a.id, name: a.name, usd: a.currency === 'USD', start: r2(balance(data, a.id, before) * fx), end: r2(balance(data, a.id, asOf) * fx) };
  }).filter((a) => a.start || a.end);
  const pStart = purposesAt(data, before, rate);
  const pEnd = purposesAt(data, asOf, rate);
  const purposes = pEnd.map((x, i) => ({ name: x.name, start: pStart[i].v, end: x.v })).filter((x) => Math.abs(x.start) >= 0.005 || Math.abs(x.end) >= 0.005);

  const cats = Object.entries(st.byCat).map(([id, c]) => ({ id, name: catName(data, id), v: r2(c.v), n: c.n, share: st.total ? c.v / st.total : 0 })).sort((a, b) => b.v - a.v);
  const yearDays = daysBetween(jan1, dec31) + 1;
  const calendar = dailyLiving(data, jan1, yearDays).map((x) => ({ ...x, v: r2(x.v), off: x.day < from || x.day > asOf }));
  const inY = (d0) => d0 && d0 >= from && d0 <= asOf;
  const subs = {};
  for (const t of st.tx) if (spendOf(data, t) && txGroup(data, t) === 'sub') { const k = t.note || catName(data, t.category); subs[k] = r2((subs[k] || 0) + spendOf(data, t)); }
  const notes = {
    lumps: st.tx.filter((t) => isLump(data, t)).map((t) => ({ name: t.note || catName(data, t.category), v: cny(t), date: t.date })),
    fromSaved: noneParts(data, st.tx),
    taxRefund: r2(st.tx.filter((t) => t.type === 'income' && t.category === 'i-tax').reduce((a, t) => a + cny(t), 0)),
    subs: Object.entries(subs).map(([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v),
    wishesBought: (data.wishes || []).filter((w) => w.status === 'bought' && inY(w.boughtAt)).map((w) => ({ name: w.name, v: Number(w.boughtPrice ?? w.price) || 0, date: w.boughtAt })),
    milestones: Object.values(data.milestones?.reached || {}).filter((x) => inY(x.at)).sort((a, b) => a.at.localeCompare(b.at)),
    days: new Set(data.tx.filter((t) => inY(t.date) && !t.auto && t.type !== 'adjust').map((t) => t.date)).size,
    span: daysBetween(from, asOf) + 1,
    owedEnd: endNW.toMe, iOweEnd: endNW.iOwe,
  };
  return {
    year, from, to: dec31, asOf, ongoing, started, st, key, startNW, endNW, months, accounts, purposes, cats,
    top: topSpends(data, from, asOf, 10), calendar, notes,
    planAll: data.settings.expectedIncome ? planBetween(data, from, dec31) : 0,
  };
}
