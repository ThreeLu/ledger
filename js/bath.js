// 洗澡（2026-10-27 用户要的，月度、年度报表「吃饭」下面）：每次洗澡花多少、隔几天洗一次，估下几次洗澡大约什么时候、花多少。纯计算，`node tests/test_money.mjs` 测。
//
// 用户定的口径：只认「洗澡水费」一个类别；同一天记的几笔合成一次（一次洗澡有时付两回钱，一天洗两次极少）。
// 现在只管「日常模式」：放假、出差、回家以后会有专门的模式，那时再说不在学校的日子。
//
// 估计：
// 一、每次多少钱：对数正态，log x ~ N(μ, σ²)，正态—逆伽马共轭先验（和午饭晚饭同一套，meals.js 的 mealPosterior）。
//    先验以自己记过的为中心：μ₀ = 记过的 log 价格的平均，κ₀ = 1，α₀ = 2，s₀ = 0.4（没记过就不估）。
// 二、隔几天洗一次：以前每两次之间隔的天数，用贝叶斯自助法（Dirichlet(1…1) 权重）重抽。
//    离上次已经过了 e 天：下一次只从隔的天数 ≥ e 的里面抽（今天还没记 = 今天也可能洗）；都比 e 短 = 今天。
// 三、蒙特卡洛 BATH_PATHS 次：每次抽一组 μ、σ 和权重，一次一次往后排日子、抽价格；范围是 10% 到 90%。

import { cny, addDays, daysBetween } from './money.js';
import { rng, quantile } from './forecast.js';
import { mealPosterior, drawMuSigma } from './meals.js';

export const BATH_CAT = 'c-bath';
export const BATH_PATHS = 4000;
export const BATH_NEXT = 3; // 估下几次
export const BATH_MIN = 3; // 记满几次才估
export const BATH_PRIOR = { kappa: 1, alpha: 2, s: 0.4 };
const r2 = (n) => Math.round(n * 100) / 100;
const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const band = (xs, f = Math.round) => { const s = sorted(xs); return { lo: f(quantile(s, 0.1)), mid: f(quantile(s, 0.5)), hi: f(quantile(s, 0.9)) }; };

// 每一次洗澡：{ day, v, gap }（gap：离上一次隔几天，第一次没有）
export function showersOf(data, from, to) {
  const m = new Map();
  for (const t of data.tx) {
    if (t.type !== 'expense' || t.category !== BATH_CAT || t.date > to) continue;
    m.set(t.date, (m.get(t.date) || 0) + cny(t));
  }
  const all = [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v], i, xs) => ({ day, v: r2(v), gap: i ? daysBetween(xs[i - 1][0], day) : null }));
  return all.filter((x) => x.day >= from);
}

const stats = (list) => {
  const gaps = list.map((x) => x.gap).filter((g) => g != null);
  const min = list.reduce((m, x) => (!m || x.v < m.v ? x : m), null);
  const max = list.reduce((m, x) => (!m || x.v > m.v ? x : m), null);
  return { n: list.length, total: r2(list.reduce((a, x) => a + x.v, 0)), avg: avg(list.map((x) => x.v)), gap: avg(gaps), min, max };
};

// 模型：到 today 为止记过的每一次
export function bathModel(data, today) {
  const all = showersOf(data, data.openingDate || '0000-00-00', today);
  if (all.length < BATH_MIN) return null;
  const logs = all.map((x) => Math.log(x.v)).filter(Number.isFinite);
  const post = mealPosterior(logs, avg(logs), BATH_PRIOR);
  return { post, gaps: all.map((x) => x.gap).filter((g) => g != null && g > 0), last: all.at(-1).day, n: all.length };
}

// 一条路径：从 today 往后一次一次排，直到过了 until 或排满 k 次。返回 [{ off: 离今天几天, v }]
function walk(R, model, today, { k = Infinity, until = null } = {}) {
  const { mu, s } = drawMuSigma(R, model.post);
  const g = model.gaps;
  const w = g.map(() => R.gamma(1));
  const pick = (min) => {
    let W = 0;
    for (let i = 0; i < g.length; i++) if (g[i] >= min) W += w[i];
    if (!W) return null;
    let u = R.u() * W;
    for (let i = 0; i < g.length; i++) if (g[i] >= min && (u -= w[i]) <= 0) return g[i];
    return g.findLast((x) => x >= min);
  };
  const out = [];
  const lastToday = model.last >= today;
  const elapsed = daysBetween(model.last, today);
  const first = pick(lastToday ? 1 : elapsed);
  let off = first == null ? 0 : daysBetween(today, addDays(model.last, first));
  while (out.length < k) {
    if (until != null && off > until) break;
    out.push({ off, v: Math.exp(mu + s * R.normal()) });
    off += pick(1) ?? 1;
  }
  return out;
}

// 下几次：每一次大约哪天（日子的 10% / 50% / 90%）、花多少；下几次一共
export function nextShowers(data, today, { k = BATH_NEXT, paths = BATH_PATHS, model = bathModel(data, today) } = {}) {
  if (!model) return null;
  const R = rng(`bath-next|${today}`);
  const runs = Array.from({ length: paths }, () => walk(R, model, today, { k }));
  const list = Array.from({ length: k }, (_, j) => {
    const d = band(runs.map((r) => r[j].off));
    return { from: addDays(today, d.lo), day: addDays(today, d.mid), to: addDays(today, d.hi), ...band(runs.map((r) => r[j].v), r2) };
  });
  return { list, sum: band(runs.map((r) => r.reduce((a, x) => a + x.v, 0)), r2) };
}

// 从明天（今天还没洗就从今天）到 end 还要花多少：一共的 10% / 50% / 90%，几次
export function bathUntil(data, today, end, { paths = BATH_PATHS, model = bathModel(data, today), seed = 'bath-until' } = {}) {
  if (!model || end < today) return null;
  const R = rng(`${seed}|${today}|${end}`);
  const until = daysBetween(today, end);
  const runs = Array.from({ length: paths }, () => walk(R, model, today, { until }));
  return { ...band(runs.map((r) => r.reduce((a, x) => a + x.v, 0)), r2), times: band(runs.map((r) => r.length)) };
}

// 月度报表「洗澡」：这个预算月的每一次；图上至少放 8 次（不够就带上之前的，淡一点）；这个月还没过完时估下几次和到月底
export function bathMonth(data, p, asOf, today, { paths = BATH_PATHS } = {}) {
  const list = showersOf(data, p.start, asOf);
  const before = showersOf(data, data.openingDate || '0000-00-00', addDays(p.start, -1));
  if (!list.length && !before.length) return null;
  const points = [...before.slice(Math.max(0, before.length - Math.max(0, 8 - list.length))).map((x) => ({ ...x, faint: true })), ...list];
  const out = { ...stats(list), list, points };
  if (p.start <= today && today < p.end && asOf === today) {
    const model = bathModel(data, today);
    if (model) {
      out.next = nextShowers(data, today, { paths, model });
      const rest = bathUntil(data, today, p.end, { paths, model, seed: 'bath-month' });
      out.month = { ...rest, lo: r2(out.total + rest.lo), mid: r2(out.total + rest.mid), hi: r2(out.total + rest.hi) };
      out.model = model;
    }
  }
  return out;
}

// 年度报表「洗澡」：这一年的每一次、每个月几次多少钱；今年还没过完时估到年底
export function bathYear(data, from, asOf, today, { paths = 2000 } = {}) {
  const list = showersOf(data, from, asOf);
  if (!list.length) return null;
  const months = Array.from({ length: 12 }, (_, i) => {
    const xs = list.filter((x) => Number(x.day.slice(5, 7)) === i + 1);
    return { m: i + 1, n: xs.length, v: r2(xs.reduce((a, x) => a + x.v, 0)), avg: avg(xs.map((x) => x.v)) };
  });
  const out = { ...stats(list), list, points: list, months };
  const dec31 = `${from.slice(0, 4)}-12-31`;
  if (today === asOf && today < dec31) {
    const rest = bathUntil(data, today, dec31, { paths, seed: 'bath-year' });
    if (rest) out.forecast = { ...rest, lo: r2(out.total + rest.lo), mid: r2(out.total + rest.mid), hi: r2(out.total + rest.hi) };
  }
  return out;
}
