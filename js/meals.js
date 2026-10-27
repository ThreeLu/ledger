// 午饭和晚饭（周总结里「花在哪了」和「这周最大的几笔」之间，2026-10-26 用户要的）。纯计算，`node tests/test_money.mjs` 测。
//
// 用户的习惯：午饭、晚饭正经吃；早餐买面包果酱奶囤着慢慢吃。用户定的口径：
// - 只认「午餐」「晚餐」两个类别（夜宵他会记成晚餐、中午的外卖记成午餐）；同一天同一类的几笔合成一顿。
// - 校园卡付的 = 学校里吃，别的卡 = 外面吃。
// - 没记的那顿 = 别人请客，不提醒。
// - 早餐（档一）：校园卡付的按顿数；别的卡付的是囤的，摊到每天（最近四周 ÷ 天数），再从以前隔几天买一次估下次大约哪天该买。
//
// 预测：
// 一、每顿多少钱：对数正态，log x ~ N(μ, σ²)，正态—逆伽马共轭先验（午饭、晚饭各一套）。
//    先验均值 = 吃饭预算每天的 MEAL_SHARE，κ₀ = 2，α₀ = 2，β₀ = α₀·s₀²（s₀ = 0.5）。
// 二、这顿自己付没有：伯努利(p)，p ~ Beta(1 + 记了的顿数, 1 + 没记的顿数)（从开始记账到昨天、记了账的日子）。
// 三、下周两顿一共、这个预算月吃饭一共：蒙特卡洛 MEAL_PATHS 条路径，每条抽一组 μ、σ、p；
//    别的吃饭花销（早餐、零食、饮料、水果……）按天用贝叶斯自助法，往后 n 天的和用它的均值方差做正态近似。
// 四、记满 TREND_DAYS 天才看：每顿是不是在变贵（log 价格对日子的回归，两头 5% 收一收，斜率的后验近似正态；至少 TREND_MEALS 顿）、
//    外面换成学校里能省多少（只在有用时说）。

import { category, account, cny, addDays, daysBetween, periodFor, partial } from './money.js';
import { rng, quantile } from './forecast.js';

export const MEAL_KINDS = [{ id: 'lunch', cat: 'c-lunch', name: '午饭' }, { id: 'dinner', cat: 'c-dinner', name: '晚饭' }];
export const MEAL_PATHS = 4000;
export const MEAL_SHARE = 0.3; // 先验：一顿 ≈ 吃饭预算每天的三成
export const TREND_DAYS = 56; // 记满 8 周才看变贵、换食堂
export const STOCK_DAYS = 28; // 早餐囤的：看最近四周
const PRIOR = { kappa: 2, alpha: 2, s: 0.5 };
const r2 = (n) => Math.round(n * 100) / 100;

export const isSchool = (data, t) => t.account === 'a-campus' || Boolean(account(data, t.account)?.name?.includes('校园卡'));
const foodBudgetPerDay = (data, day) => {
  const p = periodFor(data, day);
  return (Number(data.budget?.food) || 0) / p.days;
};

// 每一顿：{ day, kind, v, school }（同一天同一类合成一顿；学校里 = 钱多的那笔是校园卡付的）
export function mealsOf(data, from, to) {
  const m = new Map();
  for (const t of data.tx) {
    if (t.type !== 'expense' || t.date < from || t.date > to) continue;
    const kind = MEAL_KINDS.find((k) => k.cat === t.category);
    if (!kind) continue;
    const key = `${t.date}|${kind.id}`;
    const x = m.get(key) || { day: t.date, kind: kind.id, v: 0, top: 0, school: false };
    const v = cny(t);
    x.v += v;
    if (v >= x.top) { x.top = v; x.school = isSchool(data, t); }
    m.set(key, x);
  }
  return [...m.values()].map(({ top, ...x }) => ({ ...x, v: r2(x.v) })).sort((a, b) => a.day.localeCompare(b.day));
}

const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

// 正态—逆伽马的后验（x 是 log 价格）；洗澡也用（bath.js，先验不一样）
export function mealPosterior(logs, mu0, prior = PRIOR) {
  const { kappa, alpha, s } = prior;
  const beta = alpha * s * s;
  const n = logs.length;
  if (!n) return { mu: mu0, kappa, alpha, beta, n };
  const xbar = logs.reduce((a, x) => a + x, 0) / n;
  const S = logs.reduce((a, x) => a + (x - xbar) ** 2, 0);
  const kn = kappa + n;
  return { mu: (kappa * mu0 + n * xbar) / kn, kappa: kn, alpha: alpha + n / 2, beta: beta + S / 2 + (kappa * n * (xbar - mu0) ** 2) / (2 * kn), n };
}
// 抽一组 (μ, σ)：σ² ~ 逆伽马(α, β)，μ ~ N(μₙ, σ²/κₙ)
export const drawMuSigma = (R, post) => {
  const s2 = post.beta / R.gamma(post.alpha);
  return { mu: post.mu + Math.sqrt(s2 / post.kappa) * R.normal(), s: Math.sqrt(s2) };
};

// 模型：开始记账到 today 的前一天
export function mealModels(data, today) {
  const from = data.openingDate || addDays(today, -60);
  const to = addDays(today, -1);
  const meals = mealsOf(data, from, to);
  // 只算记了账的日子（一整天什么都没记 = 那天没记账，不当成别人请客）
  const active = new Set(data.tx.filter((t) => t.date >= from && t.date <= to && !t.auto).map((t) => t.date));
  const slots = active.size;
  const m0 = Math.max(1, foodBudgetPerDay(data, today) * MEAL_SHARE);
  const mu0 = Math.log(m0) - (PRIOR.s * PRIOR.s) / 2;
  const kinds = Object.fromEntries(MEAL_KINDS.map((k) => {
    const xs = meals.filter((x) => x.kind === k.id && x.v > 0);
    return [k.id, { post: mealPosterior(xs.map((x) => Math.log(x.v)), mu0), paid: Math.min(xs.length, slots), slots, m0: r2(m0) }];
  }));
  // 别的吃饭花销：每天一个数（吃饭组里除了午餐、晚餐的）
  const byDay = Object.fromEntries([...active].map((d) => [d, 0]));
  for (const t of data.tx) {
    if (t.type !== 'expense' || !(t.date in byDay) || MEAL_KINDS.some((k) => k.cat === t.category)) continue;
    if (category(data, t.category)?.group !== 'food' || t.special || t.wishFund) continue;
    byDay[t.date] += cny(t);
  }
  return { from, to, kinds, other: Object.values(byDay), days: slots };
}

// 往后 n 天：午饭、晚饭 2n 顿 + 别的吃饭花销 n 天。返回每条路径的 { meals, other }；
// track：再记下每条路径每天累计到哪（cum[j] = 往后第 j + 1 天为止一共），月度报表画「估到月底」那条线用
function simulate(models, n, seed, paths, { track = false } = {}) {
  const R = rng(seed);
  const out = [];
  const other = models.other;
  for (let i = 0; i < paths; i++) {
    const per = track ? new Float64Array(n) : null;
    let meals = 0;
    for (const k of MEAL_KINDS) {
      const m = models.kinds[k.id];
      const { mu, s } = drawMuSigma(R, m.post);
      const p = R.beta(1 + m.paid, 1 + Math.max(0, m.slots - m.paid));
      for (let j = 0; j < n; j++) if (R.u() < p) { const v = Math.exp(mu + s * R.normal()); meals += v; if (per) per[j] += v; }
    }
    let rest = 0;
    if (n && other.length) {
      // 贝叶斯自助法：Dirichlet(1…1) 权重下每天的均值、方差，n 天的和 ≈ 正态
      const w = other.map(() => R.gamma(1));
      const W = w.reduce((a, x) => a + x, 0);
      const mean = other.reduce((a, x, j) => a + (w[j] / W) * x, 0);
      const varr = other.reduce((a, x, j) => a + (w[j] / W) * (x - mean) ** 2, 0);
      const z = R.normal();
      rest = Math.max(0, n * mean + Math.sqrt(n * varr) * z);
      // 每天累计：同一个 z 往回缩（第 j 天 = j·均值 + √(j·方差)·z），最后一天和总数一样
      if (per) for (let j = 0; j < n; j++) per[j] += Math.max(0, (j + 1) * mean + Math.sqrt((j + 1) * varr) * z) - (j ? Math.max(0, j * mean + Math.sqrt(j * varr) * z) : 0);
    }
    const x = { meals, other: rest };
    if (per) { x.cum = per; for (let j = 1; j < n; j++) per[j] += per[j - 1]; }
    out.push(x);
  }
  return out;
}
const band = (xs) => { const s = [...xs].sort((a, b) => a - b); return { lo: Math.round(quantile(s, 0.1)), mid: Math.round(quantile(s, 0.5)), hi: Math.round(quantile(s, 0.9)) }; };

// 下周两顿一共多少（80% 范围）
export function nextWeekMeals(data, today, { paths = MEAL_PATHS, models = mealModels(data, today) } = {}) {
  if (!models.days) return null;
  return band(simulate(models, 7, `meals-week|${today}`, paths).map((x) => x.meals));
}

// 这个预算月吃饭一共多少、超预算的可能（今天以后的按模拟，今天和以前的按记的）
// path：往后每天累计一共多少的 10% / 50% / 90%（path[j] 是往后第 j + 1 天）
export function monthFood(data, today, { paths = MEAL_PATHS, models = mealModels(data, today) } = {}) {
  const p = periodFor(data, today);
  const budget = Math.round((Number(data.budget?.food) || 0) * partial(data, p).factor);
  if (!budget || !models.days) return null;
  const spent = foodSpent(data, p.start, today);
  const n = Math.max(0, daysBetween(today, p.end));
  const raw = simulate(models, n, `meals-month|${today}`, paths, { track: true });
  const sims = raw.map((x) => spent + x.meals + x.other);
  const path = Array.from({ length: n }, (_, j) => ({ day: addDays(today, j + 1), ...band(raw.map((x) => spent + x.cum[j])) }));
  return { ...band(sims), spent: r2(spent), budget, pOver: sims.filter((x) => x > budget).length / sims.length, days: n, path };
}

// 一段日子里吃饭一共花了多少（吃饭这一组，专项、心愿基金的不算）
const isFood = (data, t) => t.type === 'expense' && !t.special && !t.wishFund && category(data, t.category)?.group === 'food';
export function foodSpent(data, from, to) {
  let v = 0;
  for (const t of data.tx) if (t.date >= from && t.date <= to && isFood(data, t)) v += cny(t);
  return r2(v);
}

// 每天吃饭花了多少，分午饭、晚饭、别的（早餐、零食、饮料、水果……）
export function foodDays(data, from, to) {
  const m = new Map();
  for (let day = from; day <= to; day = addDays(day, 1)) m.set(day, { day, lunch: 0, dinner: 0, other: 0, v: 0 });
  for (const t of data.tx) {
    const x = m.get(t.date);
    if (!x || !isFood(data, t)) continue;
    const v = cny(t);
    const kind = MEAL_KINDS.find((k) => k.cat === t.category);
    x[kind ? kind.id : 'other'] += v;
    x.v += v;
  }
  return [...m.values()].map((x) => ({ day: x.day, lunch: r2(x.lunch), dinner: r2(x.dinner), other: r2(x.other), v: r2(x.v) }));
}

// 最近 n 天的平均（只算记了账的日子，off 的跳过；不满 n 天就按有的算）
export function rolling(days, n = 7) {
  const out = [];
  const win = [];
  for (const x of days) {
    if (x.off) { out.push(null); continue; }
    win.push(x.v);
    if (win.length > n) win.shift();
    out.push(r2(win.reduce((a, v) => a + v, 0) / win.length));
  }
  return out;
}

// 吃饭的几个数（月度、年度报表都用）：每顿平均、学校里 / 外面、花得最多的一天
function foodStats(data, from, to, days) {
  const meals = mealsOf(data, from, to);
  const counted = days.filter((x) => !x.off);
  const total = r2(counted.reduce((a, x) => a + x.v, 0));
  const kinds = MEAL_KINDS.map((k) => {
    const xs = meals.filter((x) => x.kind === k.id).map((x) => x.v);
    return { ...k, n: xs.length, avg: avg(xs), sum: r2(xs.reduce((a, v) => a + v, 0)) };
  });
  const place = ['school', 'out'].map((id) => {
    const xs = meals.filter((x) => (id === 'school') === x.school).map((x) => x.v);
    return { id, n: xs.length, avg: avg(xs) };
  });
  const max = counted.reduce((m, x) => (x.v > (m?.v ?? 0) ? x : m), null);
  return { total, perDay: counted.length ? r2(total / counted.length) : null, counted: counted.length, kinds, place, max, other: r2(total - kinds.reduce((a, k) => a + k.sum, 0)) };
}

// 月度报表「吃饭」：每天（午饭 / 晚饭 / 别的）、最近七天平均、累计和预算；这个预算月还没过完时估到月底
export function foodMonth(data, p, asOf, today, { paths = MEAL_PATHS } = {}) {
  const from = partial(data, p).from;
  const days = foodDays(data, p.start, p.end).map((x) => ({ ...x, off: x.day < from || x.day > asOf }));
  const st = foodStats(data, from, asOf, days);
  if (!st.total) return null;
  const budget = Math.round((Number(data.budget?.food) || 0) * partial(data, p).factor);
  let cum = 0;
  const cumulative = days.map((x) => (x.off && x.day > asOf ? null : (cum += x.off ? 0 : x.v, r2(cum))));
  const out = { ...st, days, avg7: rolling(days), cumulative, budget, budgetPerDay: r2((Number(data.budget?.food) || 0) / p.days) };
  if (p.start <= today && today < p.end && asOf === today && data.openingDate && data.openingDate < today) out.forecast = monthFood(data, today, { paths });
  return out;
}

// 年度报表「吃饭」：每个月（午饭 / 晚饭 / 别的）、每天的最近七天平均；今年还没过完时估到年底
export function foodYear(data, from, asOf, today, { paths = 2000 } = {}) {
  const year = from.slice(0, 4);
  const days = foodDays(data, `${year}-01-01`, `${year}-12-31`).map((x) => ({ ...x, off: x.day < from || x.day > asOf }));
  const st = foodStats(data, from, asOf, days);
  if (!st.total) return null;
  const months = Array.from({ length: 12 }, (_, i) => {
    const xs = days.filter((x) => !x.off && Number(x.day.slice(5, 7)) === i + 1);
    const sum = (k) => r2(xs.reduce((a, x) => a + x[k], 0));
    return { m: i + 1, active: xs.length > 0, days: xs.length, lunch: sum('lunch'), dinner: sum('dinner'), other: sum('other'), v: sum('v') };
  });
  const out = { ...st, days, avg7: rolling(days), months };
  const dec31 = `${year}-12-31`;
  if (today === asOf && today < dec31 && data.openingDate && data.openingDate < today) {
    const models = mealModels(data, today);
    const n = daysBetween(today, dec31);
    if (models.days) out.forecast = { ...band(simulate(models, n, `meals-year|${today}`, paths).map((x) => st.total + x.meals + x.other)), days: n };
  }
  return out;
}

// 正态分布函数
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const s = Math.sign(x); const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

// 变贵了没有：log 价格 = a + b·日子，b 的后验 ≈ N(b̂, se²)（平坦先验）。每月变多少 = e^(30.44·b) − 1
export const TREND_MEALS = 30;
export function mealTrend(meals) {
  if (meals.length < TREND_MEALS || daysBetween(meals[0].day, meals.at(-1).day) < TREND_DAYS) return null;
  const t0 = meals[0].day;
  const xs = meals.map((x) => daysBetween(t0, x.day));
  const raw = meals.map((x) => Math.log(x.v));
  const sorted = [...raw].sort((a, b) => a - b);
  const lo = quantile(sorted, 0.05); const hi = quantile(sorted, 0.95);
  const ys = raw.map((y) => Math.min(hi, Math.max(lo, y)));
  const n = xs.length;
  const mx = avg(xs); const my = avg(ys);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (!sxx) return null;
  const b = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  const resid = ys.reduce((a, y, i) => a + (y - my - b * (xs[i] - mx)) ** 2, 0);
  const se = Math.sqrt(resid / (n - 2) / sxx);
  return { perMonth: Math.exp(30.44 * b) - 1, pUp: se ? phi(b / se) : b > 0 ? 1 : 0, n };
}

// 一周的卡片要的数
export function mealWeek(data, ws, today) {
  const end = ws.end < today ? ws.end : today;
  const opening = data.openingDate || ws.start;
  const all = mealsOf(data, opening, ws.end);
  const week = all.filter((x) => x.day >= ws.start);
  const before = all.filter((x) => x.day < ws.start && x.day >= addDays(ws.start, -56)); // 平时 = 这周之前 8 周
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws.start, i));
  const grid = MEAL_KINDS.map((k) => ({ ...k, cells: days.map((day) => {
    const x = week.find((m) => m.day === day && m.kind === k.id);
    return { day, v: x ? x.v : null, school: x ? x.school : false, future: day > today || day < opening || (!x && day === today) }; // 今天还没记的那顿不算别人请
  }) }));
  const kinds = MEAL_KINDS.map((k) => {
    const w = week.filter((x) => x.kind === k.id).map((x) => x.v);
    const b = before.filter((x) => x.kind === k.id).map((x) => x.v);
    const hist = all.filter((x) => x.kind === k.id).map((x) => x.v).sort((a, c) => a - c);
    return { ...k, n: w.length, avg: avg(w), usual: b.length >= 3 ? avg(b) : null, week: w, hist };
  });
  const total = week.reduce((a, x) => a + x.v, 0);
  let food = 0;
  for (const t of data.tx) if (t.type === 'expense' && t.date >= ws.start && t.date <= ws.end && !t.special && !t.wishFund && category(data, t.category)?.group === 'food') food += cny(t);
  const place = ['school', 'out'].map((id) => {
    const xs = week.filter((x) => (id === 'school') === x.school).map((x) => x.v);
    return { id, n: xs.length, avg: avg(xs) };
  });
  const out = { grid, kinds, total: r2(total), food: r2(food), share: food ? total / food : null, place, breakfast: breakfast(data, ws, end, today) };
  // 预测只放在这一周
  if (ws.start <= today && today <= ws.end && data.openingDate && data.openingDate < today) {
    const models = mealModels(data, today);
    out.next = nextWeekMeals(data, today, { models });
    out.month = monthFood(data, today, { models });
    out.models = models;
    // 记满 8 周：变贵了没有、外面换成学校里能省多少（只在有用时说）
    if (daysBetween(opening, today) >= TREND_DAYS) {
      out.trends = MEAL_KINDS.map((k) => ({ ...k, ...mealTrend(all.filter((x) => x.kind === k.id && x.v > 0)) }))
        .filter((x) => x.n && (x.pUp >= 0.9 || x.pUp <= 0.1) && Math.abs(x.perMonth) >= 0.02);
      out.swap = swapSaving(all.filter((x) => x.day >= addDays(today, -56)));
    }
  }
  return out;
}

// 每周一顿外面的换成学校里，一个月约省多少：最近 8 周外面、学校里都至少 5 顿、外面每周至少一顿，差 ≥ 3 块、一个月省 ≥ 20 才说
export function swapSaving(meals) {
  let best = null;
  for (const k of MEAL_KINDS) {
    const xs = meals.filter((x) => x.kind === k.id);
    const s = xs.filter((x) => x.school).map((x) => x.v);
    const o = xs.filter((x) => !x.school).map((x) => x.v);
    if (s.length < 5 || o.length < 8) continue;
    const diff = avg(o) - avg(s);
    const month = Math.round((diff * 30.44) / 7);
    if (diff >= 3 && month >= 20 && (!best || month > best.month)) best = { ...k, diff: r2(diff), month };
  }
  return best;
}

// 早餐（档一）：学校里吃了几顿；囤的摊到每天；下次大约哪天该买（以前隔几天买一次的 25%～75%）
export function breakfast(data, ws, end, today) {
  const opening = data.openingDate || ws.start;
  const bf = data.tx.filter((t) => t.type === 'expense' && t.category === 'c-breakfast' && t.date >= opening && t.date <= end);
  const school = new Set(bf.filter((t) => t.date >= ws.start && isSchool(data, t)).map((t) => t.date)).size;
  const stock = bf.filter((t) => !isSchool(data, t));
  const from = addDays(end, -(STOCK_DAYS - 1)) > opening ? addDays(end, -(STOCK_DAYS - 1)) : opening;
  const span = daysBetween(from, end) + 1;
  const sum = stock.filter((t) => t.date >= from).reduce((a, t) => a + cny(t), 0);
  const perDay = span >= 7 && sum > 0 ? sum / span : null;
  let next = null;
  const buys = [...new Set(stock.map((t) => t.date))].sort();
  if (ws.start <= today && today <= ws.end && buys.length >= 4) {
    const gaps = buys.slice(1).map((d, i) => daysBetween(buys[i], d)).sort((a, b) => a - b);
    const last = buys.at(-1);
    next = { from: addDays(last, Math.round(quantile(gaps, 0.25))), to: addDays(last, Math.max(1, Math.round(quantile(gaps, 0.75)))), last };
  }
  return { school, perDay: perDay == null ? null : r2(perDay), span, next };
}

