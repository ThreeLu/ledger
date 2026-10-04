// 记账的计算：余额、预算月、预算进度、健康指标。都是纯函数，不碰网络和页面。
//
// 几条约定（和「我们的花钱方式」页面写的一致）：
// - 转账（自己的账户之间倒钱）不算收入也不算花销，只改两边余额。
// - 美元账户（Apple ID）的金额按美元记；花销同时存一个人民币金额 cny（记账当时的汇率），统计都用人民币。
// - 预算月从每月 periodStartDay 号开始（可以和发钱的日子对齐）。
// - 「不占预算」组（手续费等）算花销、影响存钱，但不占吃饭 / 日常 / 自由钱 / 订阅的预算。

export const GROUPS = [
  { id: 'food', name: '吃饭', color: 'var(--amber)' },
  { id: 'daily', name: '日常', color: 'var(--sage)' },
  { id: 'free', name: '自由钱', color: 'var(--accent)' },
  { id: 'sub', name: '订阅', color: 'var(--blue)' },
  { id: 'none', name: '不占预算', color: 'var(--muted)' },
];
export const LIVING = ['food', 'daily', 'free']; // 每天都在花的几组，「花钱节奏」只看这些（订阅是固定日子扣的）

const C = (id, name, group) => ({ id, name, kind: 'expense', group });
const I = (id, name) => ({ id, name, kind: 'income' });

// 第一次使用时的默认账本。这里的代码是公开的，所以只放通用的东西；
// 具体的账户名、收入、固定扣费、规则说明都写在私有仓库的 finance.json 里，在网页上改。
export function defaultData(today) {
  return {
    version: 1,
    openingDate: today,
    settings: {
      periodStartDay: 1, expectedIncome: 0, emergencyFloor: 0, floorAccount: 'a-save', usdRate: 6.8, summerMonths: [],
      sideIncomeSave: null, // 兼职收入存下的比例，比如 0.7
      payNote: '', // 记账时的提醒，比如「支付宝付的钱记在哪张卡」
    },
    accounts: [
      { id: 'a-save', name: '存钱卡', currency: 'CNY', opening: 0, note: '收入进这里，平时不动' },
      { id: 'a-live', name: '生活费卡', currency: 'CNY', opening: 0, note: '日常花销从这里出' },
      { id: 'a-wechat', name: '微信', currency: 'CNY', opening: 0, note: '' },
      { id: 'a-campus', name: '校园卡', currency: 'CNY', opening: 0, note: '' },
    ],
    categories: [
      C('c-meal', '三餐', 'food'), C('c-snack', '零食饮料水果', 'food'), C('c-eatout', '出去吃', 'food'),
      C('c-daily', '日用品', 'daily'), C('c-transport', '交通', 'daily'), C('c-hair', '理发', 'daily'),
      C('c-clothes', '衣服鞋子', 'daily'), C('c-study', '学习', 'daily'), C('c-social', '聚餐请客', 'daily'),
      C('c-medical', '医药', 'daily'), C('c-other', '其他', 'daily'),
      C('c-fun', '娱乐', 'free'), C('c-like', '喜欢的东西', 'free'),
      C('c-ai', 'AI 订阅', 'sub'), C('c-soft', '软件订阅', 'sub'),
      C('c-fee', '手续费', 'none'),
      I('i-salary', '生活费'), I('i-job', '兼职'), I('i-other', '其他收入'),
    ],
    budget: { food: 1500, daily: 600, free: 300, sub: 0 },
    notes: {}, // 预算每组的说明（「我们的花钱方式」里显示）
    incomePlan: [], // 每笔固定收入：{ name, amount, when, use }
    // 记转账时的常用路线
    presets: [
      { name: '充值校园卡', from: 'a-live', to: 'a-campus' },
      { name: '存钱卡 → 生活费卡', from: 'a-save', to: 'a-live' },
    ],
    // 固定扣费：{ name, amount, account, category, day（每月几号，到日子自动记）, since } 或 { yearly: 'MM-DD', remindOnly: true }
    recurring: [],
    quick: [],
    tx: [],
  };
}

// 旧数据补字段（以后加功能时在这里补，保证老数据能打开）
export function migrate(data) {
  data.settings ||= {};
  data.settings.periodStartDay ||= 1;
  data.settings.emergencyFloor ??= 0;
  data.settings.expectedIncome ??= 0;
  data.settings.usdRate ||= 6.8;
  data.settings.summerMonths ||= [];
  data.notes ||= {};
  data.incomePlan ||= [];
  data.presets ||= [];
  data.quick ||= [];
  data.recurring ||= [];
  data.tx ||= [];
  return data;
}

// ---------- 日期 ----------

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate(); // m 从 0 开始

// 某天所在的预算月：从 startDay 号到下个月 startDay-1 号
export function periodOf(day, startDay = 15) {
  const d = parseYmd(day);
  let y = d.getFullYear();
  let m = d.getMonth();
  if (d.getDate() < startDay) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = new Date(y, m, Math.min(startDay, lastDay(y, m)));
  const ny = m === 11 ? y + 1 : y;
  const nm = (m + 1) % 12;
  const next = new Date(ny, nm, Math.min(startDay, lastDay(ny, nm)));
  const end = new Date(next); end.setDate(end.getDate() - 1);
  const s = ymd(start);
  const e = ymd(end);
  return {
    start: s, end: e, next: ymd(next),
    days: daysBetween(s, e) + 1,
    dayIndex: Math.min(daysBetween(s, e) + 1, Math.max(1, daysBetween(s, day) + 1)), // 今天是第几天
    label: `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`,
    // 没有收入的预算月：从 7 月、8 月的发钱日开始的那两个
    summer: false,
    startMonth: start.getMonth() + 1,
  };
}
export function periodFor(data, day) {
  const p = periodOf(day, data.settings.periodStartDay);
  p.summer = (data.settings.summerMonths || []).includes(p.startMonth);
  return p;
}
export const shiftPeriod = (data, p, n) => periodFor(data, n < 0 ? addDays(p.start, -1) : p.next);

// ---------- 余额 ----------

export const account = (data, id) => data.accounts.find((a) => a.id === id);
export const category = (data, id) => data.categories.find((c) => c.id === id);
export const isUsd = (data, id) => account(data, id)?.currency === 'USD';

// 这笔账让某个账户变了多少（账户本身的币种）
export function delta(tx, accountId) {
  let d = 0;
  if (tx.account === accountId) {
    if (tx.type === 'income') d += tx.amount;
    else if (tx.type === 'expense') d -= tx.amount;
    else if (tx.type === 'transfer') d -= tx.amount;
    else if (tx.type === 'adjust') d += tx.amount; // 校准：正负都有
  }
  if (tx.type === 'transfer' && tx.to === accountId) d += tx.toAmount ?? tx.amount;
  return d;
}

export function balance(data, accountId, upTo = null) {
  const a = account(data, accountId);
  let b = Number(a?.opening) || 0;
  for (const t of data.tx) if (!upTo || t.date <= upTo) b += delta(t, accountId);
  return Math.round(b * 100) / 100;
}

// 总资产（人民币）：美元按当前汇率折算
export function totalAssets(data, rate = data.settings.usdRate, upTo = null) {
  return data.accounts.reduce((s, a) => s + balance(data, a.id, upTo) * (a.currency === 'USD' ? rate : 1), 0);
}

// 一笔花销 / 收入的人民币金额
export const cny = (t) => t.cny ?? t.amount;

// ---------- 预算月统计 ----------

export function periodStats(data, p) {
  const inP = data.tx.filter((t) => t.date >= p.start && t.date <= p.end);
  const spent = Object.fromEntries(GROUPS.map((g) => [g.id, 0]));
  const byCat = {};
  let income = 0;
  for (const t of inP) {
    if (t.type === 'expense') {
      const g = category(data, t.category)?.group || 'daily';
      spent[g] += cny(t);
      byCat[t.category] = (byCat[t.category] || 0) + cny(t);
    } else if (t.type === 'income') income += cny(t);
  }
  const total = Object.values(spent).reduce((a, b) => a + b, 0);
  const living = LIVING.reduce((s, g) => s + spent[g], 0);
  return { tx: inP, spent, byCat, income, total, living, saved: income - total };
}

export const budgetTotal = (data) => GROUPS.reduce((s, g) => s + (Number(data.budget?.[g.id]) || 0), 0);
export const livingBudget = (data) => LIVING.reduce((s, g) => s + (Number(data.budget?.[g]) || 0), 0);

// ---------- 固定扣费 ----------

// 从 from（含）到 to（含）之间，一个每月扣费该扣的日子
export function chargeDates(r, from, to) {
  const out = [];
  if (!r.day || from > to) return out;
  let d = parseYmd(from);
  d.setDate(1);
  while (ymd(d) <= to) {
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = ymd(new Date(y, m, Math.min(r.day, lastDay(y, m))));
    if (day >= from && day <= to) out.push(day);
    d = new Date(y, m + 1, 1);
  }
  return out;
}

// 该自动记、还没记的扣费（since 之后、lastPosted 之后、今天及以前）
export function duePostings(data, today) {
  const out = [];
  for (const r of data.recurring) {
    if (r.remindOnly || !r.day || !r.account) continue;
    const from = r.lastPosted ? addDays(r.lastPosted, 1) : r.since || today;
    for (const date of chargeDates(r, from, today)) out.push({ r, date });
  }
  return out;
}

// 接下来 days 天要扣的钱
export function upcoming(data, today, days = 35) {
  const to = addDays(today, days);
  const out = [];
  for (const r of data.recurring) {
    if (r.day) {
      for (const date of chargeDates(r, addDays(today, 1), to)) out.push({ r, date });
    } else if (r.yearly) {
      for (const y of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
        const date = `${y}-${r.yearly}`;
        if (date > today && date <= addDays(today, 40)) out.push({ r, date }); // 年费提前 40 天说
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- 健康指标 ----------
// level: good 绿 / warn 黄 / bad 红。每个都带一句大白话 text，红黄的带 action（该做什么）。

const money = (n, cur = '¥') => `${n < 0 ? '−' : ''}${cur}${Math.abs(n).toLocaleString('zh-CN', { maximumFractionDigits: Math.abs(n) < 100 || cur !== '¥' ? 2 : 0 })}`;
export { money };
export const md = (s) => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`;

// 开始记账那天在预算月中间时，这个预算月只算记账之后的部分：预算按天数打折，收入不算（开始之前到的没记）
export function partial(data, p) {
  const from = data.openingDate && data.openingDate > p.start ? data.openingDate : p.start;
  const days = daysBetween(from, p.end) + 1;
  return { from, isPartial: from !== p.start, factor: Math.max(0, days) / p.days, days };
}

export function health(data, today, rate = data.settings.usdRate) {
  const p = periodFor(data, today);
  const st = periodStats(data, p);
  const assets = totalAssets(data, rate);
  const monthly = budgetTotal(data);
  const out = [];

  // 1. 安全垫
  const months = monthly ? assets / monthly : 0;
  out.push({
    key: 'cushion', name: '安全垫', value: `${months.toFixed(1)} 个月`,
    level: months >= 2 ? 'good' : months >= 1 ? 'warn' : 'bad',
    text: months >= 3 ? '很稳' : months >= 2 ? '够用' : months >= 1 ? '偏薄' : '太薄了',
    action: months < 2 ? '这段时间少花点「想要」的东西，先把安全垫攒到 2 个月以上。' : null,
  });

  // 2. 应急钱底线
  const floorAcc = account(data, data.settings.floorAccount);
  if (floorAcc && data.settings.emergencyFloor > 0) {
    const b = balance(data, floorAcc.id);
    const ok = b >= data.settings.emergencyFloor;
    out.push({
      key: 'floor', name: '应急钱', value: money(b),
      level: ok ? 'good' : 'bad',
      text: ok ? `${floorAcc.name}高于底线 ${money(data.settings.emergencyFloor)}` : `${floorAcc.name}低于底线 ${money(data.settings.emergencyFloor)}`,
      action: ok ? null : `${floorAcc.name}只剩 ${money(b)}，先别从里面转钱出来花，等下一笔收入补上。`,
    });
  }

  // 3. 花钱节奏（吃饭 + 日常 + 自由钱）
  const part = partial(data, p);
  const lb = livingBudget(data) * part.factor;
  const elapsed = Math.max(1, daysBetween(part.from, today) + 1);
  const planned = lb * (elapsed / part.days);
  const left = lb - st.living;
  const daysLeft = p.days - p.dayIndex + 1;
  const ratio = planned ? st.living / planned : 0;
  let level = 'good';
  let text;
  if (!lb) text = '还没设生活预算';
  else if (st.living > lb) { level = 'bad'; text = `生活预算已经超了 ${money(st.living - lb)}`; }
  else if (ratio > 1.15 && elapsed > 3) { level = 'warn'; text = `比计划快 ${Math.round((ratio - 1) * 100)}%`; }
  else if (st.living === 0) text = '还没花生活费';
  else if (ratio < 0.9) text = `比计划慢 ${Math.round((1 - ratio) * 100)}%`;
  else text = '和计划差不多';
  out.push({
    key: 'pace', name: '花钱节奏', value: level === 'good' ? '正常' : level === 'warn' ? '偏快' : '超了',
    level, text, ratio,
    action: level === 'bad' ? `剩下 ${daysLeft} 天尽量只花吃饭的钱；超出的部分这个月会从存钱里扣。`
      : level === 'warn' ? `接下来每天控制在 ${money(Math.max(0, left / daysLeft))} 以内就能回到计划。` : null,
  });

  // 4. 本月存钱
  const expected = p.summer ? 0 : Number(data.settings.expectedIncome) || 0;
  const target = expected - monthly;
  const projected = Math.max(st.income, expected) - Math.max(st.total, monthly);
  const incomeIn = st.income >= expected;
  out.push({
    key: 'saving', name: '本月存钱', value: money(st.saved),
    level: p.summer || part.isPartial || !expected ? 'good' : projected >= target * 0.9 ? 'good' : 'warn',
    text: !expected && !p.summer ? `这个预算月收入 ${money(st.income)}，花了 ${money(st.total)}（在「预算」里填每月正常收入，就能估月底能存多少）`
      : part.isPartial ? `从 ${md(part.from)}开始记账，这个预算月只记了一部分；${md(p.next)}起完整统计`
      : p.summer ? '暑假没有收入，这个月靠存款过，正常'
      : !incomeIn ? `收入还没到齐（已到 ${money(st.income)}），按计划月底能存约 ${money(projected)}`
        : `按现在的节奏，月底能存约 ${money(projected)}，目标 ${money(target)}`,
    action: expected && !p.summer && !part.isPartial && projected < target * 0.9 ? '这个月花得比计划多，下个月注意一下就好，不用补。' : null,
  });

  // 5. 即将扣款（美元账户够不够付接下来的订阅）
  const usdAccs = data.accounts.filter((a) => a.currency === 'USD');
  for (const a of usdAccs) {
    const ups = upcoming(data, today, 35).filter((u) => u.r.account === a.id && !u.r.remindOnly);
    let bal = balance(data, a.id);
    let short = null;
    for (const u of ups) {
      bal -= u.r.amount;
      if (bal < 0 && !short) short = { ...u, need: -bal };
    }
    if (!ups.length) continue;
    const soon = short && daysBetween(today, short.date) <= 3;
    out.push({
      key: 'charges', name: '即将扣款', value: money(balance(data, a.id), '$'),
      level: !short ? 'good' : soon ? 'bad' : 'warn',
      text: !short ? `${a.name}够付接下来的 ${[...new Set(ups.map((u) => u.r.name))].join('、')}`
        : `${md(short.date)}扣 ${short.r.name} ${money(short.r.amount, '$')} 时不够`,
      action: short ? `在 ${md(short.date)}前给 ${a.name} 充值至少 ${money(Math.ceil(short.need), '$')}。` : null,
    });
  }
  // 年费提醒（只提醒，不自动记）
  for (const u of upcoming(data, today, 40).filter((x) => x.r.remindOnly)) {
    out.push({
      key: `yearly-${u.r.id}`, name: u.r.name, value: money(u.r.amount),
      level: 'warn', text: `${md(u.date)}续费`, action: u.r.note || '到期前决定还续不续。',
    });
  }

  const worst = out.some((x) => x.level === 'bad') ? 'bad' : out.some((x) => x.level === 'warn') ? 'warn' : 'good';
  return { period: p, stats: st, assets, items: out, level: worst, left, perDay: left / daysLeft, daysLeft };
}

// 首页最上面那一句话
export function headline(hl) {
  const bad = hl.items.filter((x) => x.level === 'bad');
  const warn = hl.items.filter((x) => x.level === 'warn');
  if (bad.length) return { title: bad.length > 1 ? `有 ${bad.length} 件事需要处理` : '有件事需要处理', text: bad[0].action };
  if (warn.length) return { title: `有 ${warn.length} 件事留意一下`, text: warn[0].action || warn[0].text };
  const pace = hl.items.find((x) => x.key === 'pace');
  const how = pace.ratio < 0.9 ? '比计划慢一些' : '和计划差不多';
  return { title: '一切正常 ✓', text: `这个月钱花得${how}，存钱进度正常，不需要做什么。` };
}
