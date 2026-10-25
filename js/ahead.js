// 往后一年「按计划」的确定性推算（2026-10-25）：照收入计划和预算往后推，每个预算月底存款有多少、专项哪个月留够。
// 页面上用的是 forecast.js 的概率模拟（它也用这里的 dueEvents、reservesAfter）；这里的结果是它的基准（收入都到、正好花到预算），
// 「要用大钱的时候」也从这里来。纯计算，`node tests/test_money.mjs` 测。
//
// 口径和「钱都在哪」一样：存款 = savingsMap().total（所有账户 + 别人欠我 − 我欠别人 − 心愿基金 − 这个月生活费还剩的）。
// - 这个预算月：+ 还没到的收入（收入计划里这个月还没记的）− 订阅预算还没扣完的；生活费还剩的本来就不在存款里。
// - 往后每个预算月：有收入的月 + 收入 − 整月预算；暑假的月只 − 预算（暑假生活费本来就是从存款里留的）。
// - 专项（学费、住宿费、年费、人情……）到了日子就当花掉了；还没生成的下一年的，按每年的金额算。
// - 生活费省下的进心愿基金、不进存款，所以按预算花；心愿基金当作不动；兼职、补助这种不一定有的钱不算。
// - 底线 = 家庭存款（封存的）+ 应急底线 + 医疗备用金。存款低于底线 = 要用到应急钱了。

import {
  periodFor, shiftPeriod, partial, periodStats, budgetTotal, savingsMap, specialList, summerGoal,
  yearlySubs, planCategory, medTarget, FREE_KEEP, FAMILY_STEP, addDays,
} from './money.js';
import { nextLunar } from './cal.js';

const r2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
export const AHEAD_MONTHS = 12;

// 到日子要花掉的专项：现在有的（日子已经过了还没办完的算今天）+ 往后每年一次的（还没生成的那几年）
export function dueEvents(data, today, until, rate) {
  const out = [];
  for (const x of specialList(data, today)) {
    if (x.kind === 'summer' || !(x.target > 0) || !x.by) continue;
    const date = x.by < today ? today : x.by;
    if (date <= until) out.push({ id: x.id, name: x.name, amount: x.target, date, yearly: x.yearly || null, kind: x.kind });
  }
  const y0 = Number(today.slice(0, 4));
  for (const it of [...(data.yearly || []), ...yearlySubs(data, rate)]) {
    const amount = Number(it.amount) || 0;
    if (!it.id || !amount || !(it.month || it.lunar)) continue;
    for (let y = y0; y <= Number(until.slice(0, 4)); y++) {
      if ((it.skip || []).includes(y)) continue;
      if ((data.goals || []).some((g) => g.yearly === it.id && g.yearlyYear === y)) continue; // 已经有了：没办完的在上面，办完的不再算
      const by = it.lunar ? nextLunar(it.lunar.m, it.lunar.d, `${y}-01-01`, 366) : `${y}-${pad(it.month)}-${pad(it.day || 15)}`;
      if (!by || !by.startsWith(`${y}-`) || by <= today || by > until) continue;
      out.push({ id: `y-${it.id}-${y}`, name: `${y} 年${it.name}`, amount, date: by, yearly: it.id, kind: 'yearly' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// 某天之后还要留着的专项（和 savingsMap 一样按日子先后）：每年一次的只留最近的那一次（网站上同一时间只有一个）
export function reservesAfter(data, events, undated, day) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.date <= day) continue;
    if (e.yearly) { if (seen.has(e.yearly)) continue; seen.add(e.yearly); }
    out.push(e);
  }
  const sg = summerGoal(data, addDays(day, 1));
  if (sg) out.push({ id: sg.id, name: sg.name, amount: sg.target, date: sg.by, kind: 'summer' });
  return [...out, ...undated].map((x, i) => ({ x, i })).sort((a, b) => (a.x.date || '9999').localeCompare(b.x.date || '9999') || a.i - b.i).map((y) => y.x);
}

// months：画几个月；返回的 eta 会一直算到最远那个专项的日子（最多 10 年）
export function aheadPlan(data, today, { months = AHEAD_MONTHS, rate = data.settings.usdRate } = {}) {
  const map = savingsMap(data, today, rate);
  const p0 = periodFor(data, today);
  const st0 = periodStats(data, p0);
  const budget = budgetTotal(data);
  const income = Number(data.settings.expectedIncome) || 0;

  // 这个预算月还会进来的：收入计划里还没到的（开始记账那个不完整的月不估，和发钱日一样）
  let waiting = 0;
  if (!p0.summer && !partial(data, p0).isPartial) {
    const plans = data.incomePlan || [];
    if (plans.length) {
      for (const plan of plans) {
        const cat = planCategory(data, plan);
        if (!st0.tx.some((t) => t.type === 'income' && (cat ? t.category === cat : false))) waiting += Number(plan.amount) || 0;
      }
    } else waiting = Math.max(0, income - st0.income);
  }
  const subLeft = Math.max(0, (Number(data.budget?.sub) || 0) * partial(data, p0).factor - st0.spent.sub);

  // 要算多远：画的月数，和还没留够的专项里最远的日子
  const goals = map.specials.filter((x) => x.kind !== 'summer' && x.need > 0);
  const far = goals.reduce((a, x) => (x.by && x.by > a ? x.by : a), '');
  const periods = [p0];
  while (periods.length < months || (far && periods.at(-1).end < far && periods.length < 120)) periods.push(shiftPeriod(data, periods.at(-1), 1));
  const until = periods.at(-1).end;
  const events = dueEvents(data, today, until, rate);
  const undated = map.specials.filter((x) => x.kind !== 'summer' && !x.by && x.target > 0).map((x) => ({ id: x.id, name: x.name, amount: x.target, date: null, kind: x.kind }));

  let total = map.total;
  let family = Number(data.family?.sealed) || 0;
  const base = (Number(data.settings.emergencyFloor) || 0) + medTarget(data);
  const eta = {};
  for (const g of goals) eta[g.id] = { id: g.id, name: g.name, target: g.target, by: g.by || null, at: null, shortAtBy: null };
  // 每个专项最近一次月底留了多少（到了日子还差多少就看它）
  const lastHave = Object.fromEntries(map.specials.map((x) => [x.id, x.have]));
  const points = [];
  periods.forEach((p, k) => {
    let inc;
    let out;
    if (k === 0) { inc = waiting; out = subLeft; } else if (p.summer) { inc = 0; out = budget; } else { inc = income; out = budget; }
    const ev = events.filter((e) => e.date >= (k ? p.start : today) && e.date <= p.end);
    total = r2(total + inc - out - ev.reduce((a, e) => a + e.amount, 0));
    // 日子到了：还差多少看上一个月底留了多少
    for (const e of Object.values(eta)) if (e.by && e.shortAtBy == null && e.by <= p.end) e.shortAtBy = r2(Math.max(0, e.target - (lastHave[e.id] || 0)));
    // 月底按 家庭 → 应急 → 医疗 → 专项 → 自由 分一次，看每个专项留够了没有
    const res = reservesAfter(data, events, undated, p.end);
    let pool = total - family - base;
    for (const x of res) {
      const have = Math.max(0, Math.min(pool, x.amount));
      pool -= have;
      const e = eta[x.id];
      lastHave[x.id] = have;
      if (e && e.at == null && have >= x.amount - 0.005) e.at = p.end;
    }
    const free = r2(pool);
    // 自由存款超过 2000 + 1 万的部分封存进家庭存款（和 checkFamily 一样），底线跟着变高
    if (free >= FREE_KEEP + FAMILY_STEP) family += Math.floor((free - FREE_KEEP) / FAMILY_STEP) * FAMILY_STEP;
    points.push({ p, total, inc: r2(inc), out: r2(out), events: ev, floor: family + base, free, summer: p.summer });
  });

  const shown = points.slice(0, months);
  const low = shown.reduce((a, x) => (x.total - x.floor < a.total - a.floor ? x : a), shown[0]);
  const below = shown.find((x) => x.total < x.floor) || null;
  // 要避开碰底线，从这个月起每月要少花（或多存）多少
  const fix = below ? Math.ceil((below.floor - below.total) / (shown.indexOf(below) + 1)) : 0;
  // eta 的 at：哪个月底留够（null = 到日子也没留够，看 shortAtBy）
  return {
    now: map.total, floorNow: (Number(data.family?.sealed) || 0) + base, points: shown, low, below, fix,
    end: shown.at(-1), perMonth: r2(income - budget), budget, income,
    eta: Object.values(eta), events: events.filter((e) => e.date <= shown.at(-1).p.end),
  };
}
