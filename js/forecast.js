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
// 五、建议（第二批，只在有用时出）：敏感性分析（二分法找「预算每月调低多少」能把按时留够提到 90% / 碰底线压到 5%）、
//    预算的可信区间（贝叶斯自助法）、方差分解（一年后存款的不确定来自收入还是花销）。
// 随机数按日子固定种子：同一天打开几次结果一样，记了新账才变。

import {
  periodFor, shiftPeriod, partial, periodStats, livingBudget, closedPeriods, savingsMap, wishFunds, spendOf, txGroup,
  addDays, daysBetween, planCategory, medTarget, budgetTotal, LIVING, GROUPS, FREE_KEEP, FAMILY_STEP, WISH_KEEP, WISH_CAP, money,
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
// 建议用的几个开关（第二批）：cut = 从下个月起生活预算每月调低多少；spendCut = 实际花销也一起少这么多
// （只调预算、花的不变：本来就花不到预算才有用——省下的不进心愿基金了，进存款；花得比新预算多，多的还是从存款出）；
// fixIncome = 收入不抽、按「金额 × 可能」算；fixSpend = 生活花销不抽、按后验均值算（方差分解用）
export function simulateAhead(data, today, { fc = null, score = null, paths = PATHS, months = 12, rate = data.settings.usdRate, cut = 0, spendCut = false, fixIncome = false, fixSpend = false } = {}) {
  const map = savingsMap(data, today, rate);
  const p0 = periodFor(data, today);
  const part0 = partial(data, p0);
  const st0 = periodStats(data, p0);
  const LB = livingBudget(data);
  const LBk = Math.max(0, LB - cut); // 下个月起的生活预算
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
  const postMean = (PRIOR_DAYS * prior.mean + xs.reduce((a, x) => a + x, 0)) / (PRIOR_DAYS + xs.length);
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
        if (!part0.isPartial && !p.summer) incomes.forEach((x, j) => { const u = R.u(); if (!x.arrived) inc += fixIncome ? x.amount * x.p : u < ps[j] ? x.amount : 0; });
        if (!part0.isPartial && !p.summer) inc += Math.max(0, fallbackIncome - st0.income);
        // 这个月还要花的：从这个月预测的分布里抽（分位数插值），已经花的算上
        const u = R.u();
        L = fixSpend ? Math.max(curSpent, month.median) : Math.max(curSpent, fromQuantiles(month.quant, u, month.qLevels)); B = budget0;
        const overNow = Math.max(0, curSpent - budget0); // 已经超了的，存款里已经少了
        const d = L - B;
        total += inc - subLeft - evAt[i];
        if (d < 0) wish -= d; else {
          const cover = Math.min(d, Math.max(0, wish - WISH_KEEP));
          wish -= cover; total -= d - overNow - cover;
        }
      } else {
        if (!p.summer) { incomes.forEach((x, j) => { const u = R.u(); inc += fixIncome ? x.amount * x.p : u < ps[j] ? x.amount : 0; }); inc += fallbackIncome; }
        const z = R.normal();
        L = fixSpend ? p.days * postMean : Math.max(0, p.days * P.mean + Math.sqrt(p.days * P.var) * z); B = LBk;
        if (spendCut) L = Math.max(0, L - cut);
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
    days: xs.length, paths, budget: budgetTotal(data), living: LB, endVar: variance(totals[M - 1]) };
}
const variance = (arr) => { const n = arr.length; const m = arr.reduce((a, x) => a + x, 0) / n; return arr.reduce((a, x) => a + (x - m) ** 2, 0) / n; };

// ---------- 五、建议（第二批）：只在有用时出 ----------
export const ON_TIME = 0.9; // 专项按时留够的可能低于这个，才找办法
export const BELOW_MAX = 0.05; // 碰到底线的可能高于这个，才找办法
export const ADVICE_PATHS = 1000;
export const CRED_DAYS = 45; // 记满这么多天，才看预算定得合不合适
const pct = (p) => (p < 0.005 ? '不到 1%' : p > 0.995 ? '超过 99%' : `${Math.round(p * 100)}%`);
const roundUp = (n, step) => Math.ceil(n / step) * step;

// 敏感性分析：生活预算每月最少调低多少（10 块一档；spend = 花的也一起少这么多），ok(模拟结果) 就满足。同一个种子（共同随机数），结果随 cut 单调。
// 调低一半还不行返回 null；不用调返回 { cut: 0 }
export function cutNeeded(data, today, opts, ok, { spend = false } = {}) {
  const run = (c) => simulateAhead(data, today, { ...opts, paths: ADVICE_PATHS, cut: c, spendCut: spend });
  const s0 = run(0);
  if (ok(s0)) return { cut: 0, sim: s0 };
  let lo = 0;
  let hi = Math.floor(livingBudget(data) / 2 / 10) * 10;
  if (!hi) return null;
  let sHi = run(hi);
  if (!ok(sHi)) return null;
  while (hi - lo > 10) {
    const mid = Math.round((lo + hi) / 20) * 10;
    if (mid <= lo || mid >= hi) break;
    const sm = run(mid);
    if (ok(sm)) { hi = mid; sHi = sm; } else lo = mid;
  }
  return { cut: hi, sim: sHi };
}

// 预算的可信区间：每一组每天花多少，贝叶斯自助法（Dirichlet(1…1) 权重）抽 draws 次日均 × 一个月的平均天数
export function budgetCredible(data, today, { draws = 2000 } = {}) {
  if (!data.openingDate) return [];
  const from = data.openingDate;
  const to = addDays(today, -1);
  const n = daysBetween(from, to) + 1;
  if (n < CRED_DAYS) return [];
  const idx = new Map();
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { idx.set(d, rows.length); rows.push(Object.fromEntries(LIVING.map((g) => [g, 0]))); }
  for (const t of data.tx) {
    const i = idx.get(t.date);
    if (i == null) continue;
    const v = spendOf(data, t);
    const g = v > 0 ? txGroup(data, t) : null;
    if (g && LIVING.includes(g)) rows[i][g] += v;
  }
  const R = rng(`budget|${today}`);
  const perMonth = 365.25 / 12;
  const ws = Array.from({ length: draws }, () => { const w = rows.map(() => -Math.log(R.u())); const sum = w.reduce((a, x) => a + x, 0); return w.map((x) => x / sum); });
  const out = [];
  for (const g of LIVING) {
    const b = Number(data.budget?.[g]) || 0;
    if (!b || rows.filter((r) => r[g] > 0).length < 5) continue; // 这一组几乎没花过，不说
    const ms = ws.map((w) => w.reduce((a, wi, i) => a + wi * rows[i][g], 0) * perMonth).sort((a, b2) => a - b2);
    const mean = ms.reduce((a, x) => a + x, 0) / ms.length;
    const lo = quantile(ms, 0.025);
    const hi = quantile(ms, 0.975);
    const pUnder = ms.filter((x) => x < b).length / ms.length;
    out.push({ group: g, name: GROUPS.find((x) => x.id === g).name, budget: b, mean: r2(mean), lo: r2(lo), hi: r2(hi), pUnder, pOver: 1 - pUnder, days: n });
  }
  return out;
}

// 方差分解：一年后存款的方差里，有多少是收入到不到账带来的、多少是每月花多少带来的（把一样固定成平均，看方差少了多少）
export function uncertaintySources(data, today, opts = {}) {
  const run = (o) => simulateAhead(data, today, { ...opts, paths: ADVICE_PATHS, ...o });
  const base = run({});
  if (base.endVar < 1e4) return null; // 标准差不到 100，没什么好分的
  let inc = Math.max(0, 1 - run({ fixIncome: true }).endVar / base.endVar);
  let sp = Math.max(0, 1 - run({ fixSpend: true }).endVar / base.endVar);
  if (inc + sp > 1) { const t = inc + sp; inc /= t; sp /= t; }
  return { income: inc, spend: sp, sd: Math.sqrt(base.endVar), irregular: base.incomes.filter((x) => !x.regular).map((x) => x.name) };
}

// 建议：sim 是页面上那次模拟（4000 条）。没有要说的就是空的
export function adviceItems(data, today, sim, opts = {}) {
  const items = [];
  // 先看只调预算行不行（本来就花不到预算），不行再看「少花 + 预算一起调低」
  const lever = (ok) => {
    const r = cutNeeded(data, today, opts, ok);
    if (r) return { ...r, how: `从下个月起把生活预算每月调低 ${money(r.cut)} 就够（你本来就花不到预算，省下的就进存款，不进心愿基金了）` };
    const r2b = cutNeeded(data, today, opts, ok, { spend: true });
    return r2b ? { ...r2b, how: `从下个月起每月少花 ${money(r2b.cut)}，生活预算也一起调低这么多（这样省下的进存款，不进心愿基金）` } : null;
  };
  if (sim.pBelow > BELOW_MAX) {
    const r = lever((s) => s.pBelow <= BELOW_MAX);
    items.push({ key: 'floor', tone: 'warn', short: `碰到底线的可能 ${pct(sim.pBelow)}`,
      text: r ? `往后一年碰到底线的可能 ${pct(sim.pBelow)}。${r.how}，能降到 ${pct(r.sim.pBelow)}。`
        : `往后一年碰到底线的可能 ${pct(sim.pBelow)}。每月少花一半也压不到 ${pct(BELOW_MAX)}：要靠多一点收入，或者把要用大钱的事往后挪。` });
  }
  for (const g of sim.goals.filter((x) => x.by && x.pOnTime != null && x.pOnTime < ON_TIME).sort((a, b) => a.pOnTime - b.pOnTime).slice(0, 2)) {
    const r = lever((s) => (s.goals.find((x) => x.id === g.id)?.pOnTime ?? 0) >= ON_TIME);
    items.push({ key: `goal-${g.id}`, tone: 'warn', short: `「${g.name}」按时留够的可能 ${pct(g.pOnTime)}`,
      text: r ? `「${g.name}」按时留够的可能 ${pct(g.pOnTime)}。${r.how}，能到 ${pct(r.sim.goals.find((x) => x.id === g.id).pOnTime)}。`
        : `「${g.name}」按时留够的可能 ${pct(g.pOnTime)}。每月少花一半也到不了 ${pct(ON_TIME)}：可以把日子往后挪，或者少留一点。` });
  }
  for (const b of budgetCredible(data, today)) {
    if (b.pUnder >= 0.95 && b.hi <= b.budget * 0.9) {
      const to = Math.max(roundUp(b.hi, 50), b.group === 'free' ? 200 : 0);
      if (to < b.budget) {
        items.push({ key: `budget-${b.group}`, tone: 'calm', short: `${b.name}预算可以调低`,
          text: `${b.name}实际每月约 ${money(b.mean)}（95% 在 ${money(b.lo)}～${money(b.hi)}），低于预算 ${money(b.budget)} 的可能 ${pct(b.pUnder)}。预算调到 ${money(to)} 也够，多出来的 ${money(b.budget - to)} 每月进存款。`, href: '#/rules' });
      }
    } else if (b.pOver >= 0.9) {
      items.push({ key: `budget-${b.group}`, tone: 'warn', short: `${b.name}多半会超预算`,
        text: `${b.name}实际每月约 ${money(b.mean)}（95% 在 ${money(b.lo)}～${money(b.hi)}），超过预算 ${money(b.budget)} 的可能 ${pct(b.pOver)}。要么这块收一收，要么预算定得太紧了。`, href: '#/rules' });
    }
  }
  return items;
}
