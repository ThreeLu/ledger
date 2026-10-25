// 预测（2026-10-25 第一批，用户要「更科学」：直接给概率、公式写出来）。纯计算，`node tests/test_money.mjs` 测。
//
// 一、每天的生活花销（吃饭 + 日常 + 自由钱 + 形象）：Dirichlet 过程的后验。
//    先验 G₀ = 对数正态，均值 μ₀ = 生活预算 ÷ 预算月天数，变异系数 PRIOR_CV；先验相当于 PRIOR_DAYS 天的数据。
//    看到 n 天 x₁…xₙ 以后：P | x ~ DP(α + n, (αG₀ + Σδₓᵢ)/(α + n))，抽一个 P 用 (W₀, W₁…Wₙ) ~ Dirichlet(α, 1…1)，
//    P = W₀G₀ + ΣWᵢδₓᵢ（贝叶斯自助法加先验）。偶尔一天花得多的长尾会照原样留着。
// 二、Chronos-2（数据仓库的 GitHub Actions 每天跑，config/forecast.json）：往后每天 21 个分位数。
//    两个模型按每天「前一天为止的数据预测这一天」的分位数损失（≈ CRPS）打分，按成绩倒数定权重，
//    分过的天少时往 50% 收（相当于先验 WEIGHT_PRIOR_DAYS 天各一半）。这个月的预测 = 两个模型的混合。
// 三、收入：收入计划里的每一笔，每个有收入的预算月到不到账 ~ 伯努利(p)，p ~ Beta(a₀ + 到了, b₀ + 没到)。
//    有准日子的（写了几号）先验 Beta(19.5, 0.5)，不定时的 Beta(4.5, 0.5)。
// 四、往后：蒙特卡洛，每条路径抽一个 P 和每笔收入的 p，按月走：收入、生活花销（30 天的和，用 P 的均值方差做正态近似）、
//    订阅预算、专项到日子扣掉；生活费省下的进心愿基金（满 1 万的进存款），超了先扣心愿基金（留 100）再扣存款；
//    月底按 家庭 → 应急 → 医疗 → 专项 → 自由 分，满了封存家庭存款（和 ahead.js 一样）。
// 随机数按日子固定种子：同一天打开几次结果一样，记了新账才变。

import {
  periodFor, shiftPeriod, partial, periodStats, livingBudget, closedPeriods, savingsMap, wishFunds, spendOf, txGroup,
  addDays, daysBetween, planCategory, medTarget, budgetTotal, LIVING, FREE_KEEP, FAMILY_STEP, WISH_KEEP, WISH_CAP,
} from './money.js';
import { dueEvents, reservesAfter } from './ahead.js';

export const PRIOR_DAYS = 30; // α：先验相当于多少天的数据
export const PRIOR_CV = 1; // 先验里每天花销的变异系数
export const PATHS = 4000;
export const WEIGHT_PRIOR_DAYS = 14;
export const SCORE_DAYS = 60; // 打分只看最近这么多天
export const LEVELS = [0.01, ...Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100), 0.99];
const r2 = (n) => Math.round(n * 100) / 100;

// ---------- 随机数（mulberry32，按字符串定种子） ----------
export function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967297; };
  let spare = null;
  const normal = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    const r = Math.sqrt(-2 * Math.log(u())); const th = 2 * Math.PI * u();
    spare = r * Math.sin(th); return r * Math.cos(th);
  };
  // Gamma(k, 1)：Marsaglia–Tsang；k < 1 时用 Gamma(k + 1)·U^(1/k)
  const gamma = (k) => {
    if (k < 1) return gamma(k + 1) * u() ** (1 / k);
    const d = k - 1 / 3; const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x; let v;
      do { x = normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v; const w = u();
      if (w < 1 - 0.0331 * x ** 4 || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const beta = (a2, b2) => { const x = gamma(a2); return x / (x + gamma(b2)); };
  return { u, normal, gamma, beta };
}

// ---------- 小工具 ----------
export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const erf = (x) => { // Abramowitz–Stegun 7.1.26，误差 < 1.5e-7
  const s = Math.sign(x); const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
};
// 先验 G₀：对数正态，均值 mean、变异系数 cv
export function g0(mean, cv = PRIOR_CV) {
  const s2 = Math.log(1 + cv * cv); const m = Math.log(Math.max(mean, 0.01)) - s2 / 2; const s = Math.sqrt(s2);
  return { mean, sd: mean * cv, cdf: (x) => (x <= 0 ? 0 : 0.5 * (1 + erf((Math.log(x) - m) / (s * Math.SQRT2)))), draw: (R) => Math.exp(m + s * R.normal()) };
}
// 分位数损失（pinball），在 LEVELS 上平均 × 2 ≈ CRPS
export function quantileLoss(qs, y, levels = LEVELS) {
  return (2 * levels.reduce((a, q, i) => a + (y < qs[i] ? (1 - q) * (qs[i] - y) : q * (y - qs[i])), 0)) / levels.length;
}
// 从分位数（levels 上）抽一个：中间线性插值，两头往 0 和往外延一点
export function fromQuantiles(qs, u, levels = LEVELS) {
  if (u <= levels[0]) return Math.max(0, qs[0] * (u / levels[0]));
  const n = levels.length - 1;
  if (u >= levels[n]) return qs[n] + (qs[n] - qs[n - 1]) * ((u - levels[n]) / (levels[n] - levels[n - 1]));
  let i = 1; while (levels[i] < u) i++;
  const t = (u - levels[i - 1]) / (levels[i] - levels[i - 1]);
  return qs[i - 1] + (qs[i] - qs[i - 1]) * t;
}

// ---------- 一、每天的生活花销 ----------
export function dailyLiving(data, from, to) {
  const out = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) out.set(d, 0);
  for (const t of data.tx) {
    if (!out.has(t.date)) continue;
    const v = spendOf(data, t);
    if (v > 0 && LIVING.includes(txGroup(data, t))) out.set(t.date, out.get(t.date) + v);
  }
  return [...out].map(([date, v]) => ({ date, v: r2(v) }));
}
// 先验均值：这个预算月的生活预算 ÷ 天数
export const priorMean = (data, today) => livingBudget(data) / periodFor(data, today).days;

// 后验预测（一天）的分布函数和分位数：(αG₀ + Σδₓᵢ)/(α + n)
export function dpPredictive(xs, prior, alpha = PRIOR_DAYS) {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const cdf = (x) => { let k = 0; while (k < n && sorted[k] <= x) k++; return (alpha * prior.cdf(x) + k) / (alpha + n); };
  const hi0 = Math.max(prior.mean * 40, sorted.at(-1) || 0) + 1;
  const q = (p) => { let lo = 0; let hi = hi0; for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; } return hi; };
  return { cdf, q, quantiles: (levels = LEVELS) => levels.map(q) };
}
// 抽一个 P：返回 draw()（从 P 抽一天）和 P 的均值、方差
export function drawP(R, xs, prior, alpha = PRIOR_DAYS) {
  const w0 = R.gamma(alpha);
  const ws = xs.map(() => -Math.log(R.u()));
  const tot = w0 + ws.reduce((a, x) => a + x, 0);
  const W0 = w0 / tot;
  const cum = []; let c = W0;
  for (const w of ws) { c += w / tot; cum.push(c); }
  let m = W0 * prior.mean; let m2 = W0 * (prior.sd ** 2 + prior.mean ** 2);
  xs.forEach((x, i) => { const w = ws[i] / tot; m += w * x; m2 += w * x * x; });
  const draw = () => {
    const u = R.u();
    if (u < W0 || !xs.length) return prior.draw(R);
    let lo = 0; let hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
    return xs[lo];
  };
  return { draw, mean: m, var: Math.max(0, m2 - m * m) };
}

// ---------- 二、两个模型打分、定权重 ----------
// log：forecast-log.json 的 living（{ 日子: 21 个分位数 }）。只算开始记账以后、今天以前、已经有实际的天
export function scoreModels(data, today, log) {
  const opening = data.openingDate;
  if (!opening) return { days: 0, chronos: null, bayes: null, w: 0 };
  const series = dailyLiving(data, opening, addDays(today, -1));
  const actual = new Map(series.map((x) => [x.date, x.v]));
  const prior = g0(priorMean(data, today));
  const days = Object.keys(log || {}).filter((d) => d >= opening && d < today && actual.has(d)).sort().slice(-SCORE_DAYS);
  if (!days.length) return { days: 0, chronos: null, bayes: null, w: log ? 0.5 : 0 };
  const sc = { chronos: { loss: 0, hit: 0 }, bayes: { loss: 0, hit: 0 } };
  const i10 = LEVELS.indexOf(0.1); const i90 = LEVELS.indexOf(0.9);
  for (const d of days) {
    const y = actual.get(d);
    const past = series.filter((x) => x.date < d).map((x) => x.v);
    const qb = dpPredictive(past, prior).quantiles();
    const qc = log[d];
    for (const [k, qs] of [['chronos', qc], ['bayes', qb]]) {
      sc[k].loss += quantileLoss(qs, y);
      if (y >= qs[i10] && y <= qs[i90]) sc[k].hit++;
    }
  }
  const n = days.length;
  const out = (k) => ({ loss: r2(sc[k].loss / n), cover: sc[k].hit / n });
  const c = out('chronos'); const b = out('bayes');
  // 权重：损失的倒数；分过的天少时往一半收
  const emp = c.loss + b.loss > 0 ? b.loss / (c.loss + b.loss) : 0.5;
  const w = (WEIGHT_PRIOR_DAYS * 0.5 + n * emp) / (WEIGHT_PRIOR_DAYS + n);
  return { days: n, chronos: c, bayes: b, w };
}

// ---------- 这个月会花多少 ----------
// fc：forecast.json（可以没有）；score：scoreModels 的结果
export function monthForecast(data, today, { fc = null, score = null, paths = PATHS } = {}) {
  const p = periodFor(data, today);
  const part = partial(data, p);
  const budget = livingBudget(data) * part.factor;
  const st = periodStats(data, p);
  const series = data.openingDate ? dailyLiving(data, data.openingDate, addDays(today, -1)) : [];
  const xs = series.map((x) => x.v);
  const todaySoFar = dailyLiving(data, today, today)[0].v;
  const before = r2(st.living - todaySoFar); // 今天以前已经花的
  const prior = g0(priorMean(data, today));
  const left = daysBetween(today, p.end) + 1; // 包括今天
  // Chronos 有没有覆盖到这几天
  const off = fc?.status === 'ok' ? daysBetween(fc.from, today) : -1;
  const useC = off >= 0 && fc.series?.living && fc.series.living.length >= off + left;
  const w = useC ? (score?.w ?? 0.5) : 0;
  const R = rng(`month|${today}`);
  const totals = new Float64Array(paths);
  for (let k = 0; k < paths; k++) {
    let sum = before;
    if (R.u() < w) {
      for (let i = 0; i < left; i++) { const v = fromQuantiles(fc.series.living[off + i], R.u(), fc.levels || LEVELS); sum += i ? v : Math.max(todaySoFar, v); }
    } else {
      const P = drawP(R, xs, prior);
      for (let i = 0; i < left; i++) { const v = P.draw(); sum += i ? v : Math.max(todaySoFar, v); }
    }
    totals[k] = sum;
  }
  const sorted = Array.from(totals).sort((a, b) => a - b);
  const over = sorted.filter((x) => x > budget + 0.005).length / paths;
  return { p, budget: r2(budget), spent: st.living, median: r2(quantile(sorted, 0.5)), lo: r2(quantile(sorted, 0.1)), hi: r2(quantile(sorted, 0.9)),
    pOver: over, days: xs.length, wChronos: w,
    xsMean: xs.length ? r2(xs.reduce((a, x) => a + x, 0) / xs.length) : null,
    postMean: r2((PRIOR_DAYS * prior.mean + xs.reduce((a, x) => a + x, 0)) / (PRIOR_DAYS + xs.length)), chronos: useC, quant: LEVELS.map((q) => quantile(sorted, q)), qLevels: LEVELS };
}

// ---------- 三、收入 ----------
export const PRIOR_REGULAR = [19.5, 0.5];
export const PRIOR_IRREGULAR = [4.5, 0.5];
export function incomeModels(data, today) {
  const p0 = periodFor(data, today);
  const full = closedPeriods(data, today).filter((p) => !p.summer && !partial(data, p).isPartial);
  return (data.incomePlan || []).map((plan) => {
    const cat = planCategory(data, plan);
    const regular = /\d{1,2}\s*[号日]/.test(String(plan.when || ''));
    const [a0, b0] = regular ? PRIOR_REGULAR : PRIOR_IRREGULAR;
    const got = (p) => data.tx.some((t) => t.type === 'income' && t.category === cat && t.date >= p.start && t.date <= p.end);
    const hits = full.filter(got).length;
    const a = a0 + hits; const b = b0 + full.length - hits;
    return { name: plan.name, amount: Number(plan.amount) || 0, regular, a, b, p: a / (a + b), hits, months: full.length,
      arrived: cat ? got(p0) : false, partialNow: partial(data, p0).isPartial || p0.summer };
  });
}

// ---------- 四、往后：蒙特卡洛 ----------
export function simulateAhead(data, today, { fc = null, score = null, paths = PATHS, months = 12, rate = data.settings.usdRate } = {}) {
  const map = savingsMap(data, today, rate);
  const p0 = periodFor(data, today);
  const part0 = partial(data, p0);
  const st0 = periodStats(data, p0);
  const LB = livingBudget(data);
  const subB = Number(data.budget?.sub) || 0;
  const subLeft = Math.max(0, subB * part0.factor - st0.spent.sub);
  const budget0 = LB * part0.factor;
  const incomes = incomeModels(data, today);
  const fallbackIncome = incomes.length ? 0 : Number(data.settings.expectedIncome) || 0;
  const goals = map.specials.filter((x) => x.kind !== 'summer' && x.need > 0);
  const far = goals.reduce((a, x) => (x.by && x.by > a ? x.by : a), '');
  const periods = [p0];
  while (periods.length < months || (far && periods.at(-1).end < far && periods.length < 120)) periods.push(shiftPeriod(data, periods.at(-1), 1));
  const until = periods.at(-1).end;
  const events = dueEvents(data, today, until, rate);
  const undated = map.specials.filter((x) => x.kind !== 'summer' && !x.by && x.target > 0).map((x) => ({ id: x.id, name: x.name, amount: x.target, date: null, kind: x.kind }));
  const evAt = periods.map((p, k) => events.filter((e) => e.date >= (k ? p.start : today) && e.date <= p.end).reduce((a, e) => a + e.amount, 0));
  const resAt = periods.map((p) => reservesAfter(data, events, undated, p.end));
  const base = (Number(data.settings.emergencyFloor) || 0) + medTarget(data);
  const goalIdx = Object.fromEntries(goals.map((g, i) => [g.id, i]));
  // 每个专项要在哪个月底前留够：日子所在那个月的前一个月底
  const dueK = goals.map((g) => (g.by ? periods.findIndex((p) => g.by <= p.end) : -1));
  const month = monthForecast(data, today, { fc, score, paths });
  const xs = data.openingDate ? dailyLiving(data, data.openingDate, addDays(today, -1)).map((x) => x.v) : [];
  const prior = g0(priorMean(data, today));
  const wish0 = wishFunds(data, today).small;
  const R = rng(`ahead|${today}`);
  const M = Math.min(months, periods.length);
  const totals = Array.from({ length: M }, () => new Float64Array(paths));
  const floors = Array.from({ length: M }, () => new Float64Array(paths));
  const belowMonth = new Array(M).fill(0);
  let belowAny = 0;
  const atK = goals.map(() => new Int16Array(paths).fill(-1));
  const onTime = goals.map(() => 0);
  // 这个月的生活花销：从 monthForecast 的分布（同样的混合）里抽
  const curSpent = periodStats(data, p0).living;
  for (let k = 0; k < paths; k++) {
    const P = drawP(R, xs, prior);
    const ps = incomes.map((x) => R.beta(x.a, x.b));
    let total = map.total;
    let wish = wish0;
    let family = Number(data.family?.sealed) || 0;
    let below = false;
    const reached = goals.map(() => -1);
    periods.forEach((p, i) => {
      let inc = 0; let L; let B;
      if (i === 0) {
        if (!part0.isPartial && !p.summer) incomes.forEach((x, j) => { if (!x.arrived && R.u() < ps[j]) inc += x.amount; });
        if (!part0.isPartial && !p.summer) inc += Math.max(0, fallbackIncome - st0.income);
        // 这个月还要花的：从这个月预测的分布里抽（分位数插值），已经花的算上
        L = Math.max(curSpent, fromQuantiles(month.quant, R.u(), month.qLevels)); B = budget0;
        const overNow = Math.max(0, curSpent - budget0); // 已经超了的，存款里已经少了
        const d = L - B;
        total += inc - subLeft - evAt[i];
        if (d < 0) wish -= d; else {
          const cover = Math.min(d, Math.max(0, wish - WISH_KEEP));
          wish -= cover; total -= d - overNow - cover;
        }
      } else {
        if (!p.summer) { incomes.forEach((x, j) => { if (R.u() < ps[j]) inc += x.amount; }); inc += fallbackIncome; }
        L = Math.max(0, p.days * P.mean + Math.sqrt(p.days * P.var) * R.normal()); B = LB;
        const d = L - B;
        total += inc - subB - B - evAt[i];
        if (d < 0) wish -= d; else {
          const cover = Math.min(d, Math.max(0, wish - WISH_KEEP));
          wish -= cover; total -= d - cover;
        }
      }
      if (wish > WISH_CAP) { total += wish - WISH_CAP; wish = WISH_CAP; }
      // 月底分一次
      let pool = total - family - base;
      for (const x of resAt[i]) {
        const have = Math.max(0, Math.min(pool, x.amount));
        pool -= have;
        const g = goalIdx[x.id];
        if (g != null && reached[g] < 0 && have >= x.amount - 0.005) reached[g] = i;
      }
      if (pool >= FREE_KEEP + FAMILY_STEP) family += Math.floor((pool - FREE_KEEP) / FAMILY_STEP) * FAMILY_STEP;
      if (i < M) {
        totals[i][k] = total; floors[i][k] = family + base;
        if (total < family + base) { belowMonth[i]++; below = true; }
      }
    });
    if (below) belowAny++;
    reached.forEach((r, g) => { atK[g][k] = r; if (r >= 0 && (dueK[g] < 0 || r < dueK[g])) onTime[g]++; });
  }
  const Q = [0.1, 0.25, 0.5, 0.75, 0.9];
  const fan = totals.map((arr, i) => {
    const s = Array.from(arr).sort((a, b) => a - b);
    const f = Array.from(floors[i]).sort((a, b) => a - b);
    return { p: periods[i], q: Q.map((q) => r2(quantile(s, q))), floor: r2(quantile(f, 0.5)), pBelow: belowMonth[i] / paths, summer: periods[i].summer };
  });
  const goalOut = goals.map((g, gi) => {
    const ks = Array.from(atK[gi]).map((x) => (x < 0 ? Infinity : x)).sort((a, b) => a - b);
    const at = (q) => { const x = ks[Math.min(ks.length - 1, Math.floor(q * (ks.length - 1)))]; return Number.isFinite(x) ? periods[x].end : null; };
    return { id: g.id, name: g.name, target: g.target, by: g.by || null, pOnTime: g.by ? onTime[gi] / paths : null,
      pReach: ks.filter(Number.isFinite).length / paths, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
  });
  return { now: map.total, fan, pBelow: belowAny / paths, goals: goalOut, month, incomes, prior: { mean: r2(prior.mean), cv: PRIOR_CV, alpha: PRIOR_DAYS },
    days: xs.length, paths, budget: budgetTotal(data), living: LB };
}
