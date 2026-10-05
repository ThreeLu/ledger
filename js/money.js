// 记账的计算：余额、预算月、预算进度、健康指标。都是纯函数，不碰网络和页面。
//
// 几条约定（和「我们的花钱方式」页面写的一致）：
// - 转账（自己的账户之间倒钱）不算收入也不算花销，只改两边余额。
// - 美元账户（Apple ID）的金额按美元记；花销同时存一个人民币金额 cny（记账当时的汇率），统计都用人民币。
// - 预算月从每月 periodStartDay 号开始（可以和发钱的日子对齐）。
// - 「不占预算」组（手续费等）算花销、影响存钱，但不占吃饭 / 日常 / 自由钱 / 形象 / 订阅的预算。

export const GROUPS = [
  { id: 'food', name: '吃饭', color: 'var(--amber)' },
  { id: 'daily', name: '日常', color: 'var(--sage)' },
  { id: 'free', name: '自由钱', color: 'var(--accent)' },
  { id: 'look', name: '形象', color: 'var(--rose)' },
  { id: 'sub', name: '订阅', color: 'var(--blue)' },
  { id: 'none', name: '不占预算', color: 'var(--muted)' },
];
export const LIVING = ['food', 'daily', 'free', 'look']; // 每天都在花的几组，「花钱节奏」只看这些（订阅是固定日子扣的）

const C = (id, name, group, sub) => ({ id, name, kind: 'expense', group, ...(sub ? { sub } : {}) });
const I = (id, name) => ({ id, name, kind: 'income' });

// 支出类别：大组（管预算）→ 小组 sub（只是为了好找）→ 类别。改这里，migrate() 会把新类别补进老账本。
export const EXPENSE_CATEGORIES = [
  C('c-breakfast', '早餐', 'food'), C('c-lunch', '午餐', 'food'), C('c-dinner', '晚餐', 'food'), C('c-latenight', '夜宵', 'food'),
  C('c-snack', '零食', 'food'), C('c-drink', '饮料奶茶', 'food'), C('c-fruit', '水果', 'food'),
  C('c-takeout', '外卖', 'food'), C('c-eatout', '出去吃', 'food'),
  C('c-toiletry', '洗护用品', 'daily', '日用消耗'), C('c-tissue', '纸巾清洁', 'daily', '日用消耗'), C('c-care', '个人护理', 'daily', '日用消耗'),
  C('c-storage', '收纳整理', 'daily', '家居用品'), C('c-bedding', '床品', 'daily', '家居用品'), C('c-dorm', '宿舍小物件', 'daily', '家居用品'),
  C('c-stationery', '文具', 'daily', '耗材'), C('c-print', '打印复印', 'daily', '耗材'), C('c-gadget', '电子耗材', 'daily', '耗材'),
  C('c-books', '书籍资料', 'daily', '学习'), C('c-exam', '考试报名', 'daily', '学习'), C('c-course', '课程', 'daily', '学习'),
  C('c-bus', '公交地铁', 'daily', '交通'), C('c-taxi', '打车', 'daily', '交通'), C('c-bike', '共享单车', 'daily', '交通'), C('c-train', '火车飞机', 'daily', '交通'),
  C('c-clothes', '衣服', 'daily', '穿着'), C('c-shoes', '鞋子', 'daily', '穿着'), C('c-accessory', '配饰', 'daily', '穿着'),
  C('c-hair', '理发', 'daily', '生活服务'), C('c-bath', '洗澡水费', 'daily', '生活服务'), C('c-laundry', '洗衣机', 'daily', '生活服务'), C('c-express', '快递', 'daily', '生活服务'),
  C('c-social', '聚餐请客', 'daily', '人情社交'), C('c-gift', '礼物', 'daily', '人情社交'), C('c-hongbao', '红包', 'daily', '人情社交'),
  C('c-doctor', '看病', 'daily', '医疗'), C('c-medical', '买药', 'daily', '医疗'),
  C('c-other', '其他', 'daily', '其他'),
  C('c-skin', '护肤', 'look'), C('c-makeup', '化妆', 'look'), C('c-scent', '香水和打理', 'look'),
  C('c-fun', '娱乐', 'free'), C('c-hobby', '爱好', 'free'), C('c-like', '喜欢的小东西', 'free'),
  C('c-ai', 'AI 订阅', 'sub'), C('c-soft', '软件订阅', 'sub'), C('c-member', '会员', 'sub'),
  C('c-fee', '手续费', 'none'), C('c-trip', '出差自付', 'none'), C('c-wish', '心愿', 'none'),
];
// 老版本的类别：以前记的账还显示原来的名字，但记新账时不再出现
const RETIRED = { 'c-meal': '三餐', 'c-daily': '日用品', 'c-transport': '交通', 'c-study': '学习' };
export const CATEGORY_VERSION = 3; // 3：加了「形象」组（护肤、化妆、香水和打理）

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
    categoryVersion: CATEGORY_VERSION,
    categories: [
      ...EXPENSE_CATEGORIES.map((c) => ({ ...c })),
      I('i-salary', '生活费'), I('i-job', '兼职'), I('i-tax', '个税退税'), I('i-other', '其他收入'),
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
  data.claims ||= []; // 垫付报销：{ id, name, payer, createdAt, status: 'open'|'settled', settledAt, docs: [{ file, name, kind, submitted }] }
  data.people ||= []; // 人情账：{ id, name }
  data.reconciled ||= {}; // 每个预算月对过账没有：{ 预算月开始日: 对账日 }
  // 类别升级：按 EXPENSE_CATEGORIES 改名、分小组、补新的；老类别藏起来（以前的账照样显示）
  if ((data.categoryVersion || 1) < CATEGORY_VERSION) {
    for (const def of EXPENSE_CATEGORIES) {
      const have = data.categories.find((c) => c.id === def.id);
      if (have) Object.assign(have, { name: def.name, group: def.group, sub: def.sub, hidden: false });
      else data.categories.push({ ...def });
    }
    for (const [id, name] of Object.entries(RETIRED)) {
      const have = data.categories.find((c) => c.id === id);
      if (have) Object.assign(have, { name, hidden: true });
    }
    // 按默认顺序排（早餐、午餐、晚餐……），自己加的类别、收入类别放在后面，顺序不变
    const rank = (c) => { const i = EXPENSE_CATEGORIES.findIndex((x) => x.id === c.id); return i < 0 ? EXPENSE_CATEGORIES.length : i; };
    data.categories = data.categories.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
    data.categoryVersion = CATEGORY_VERSION;
  }
  for (const c of data.categories) if (!c.sub) delete c.sub;
  if (!data.categories.some((c) => c.id === 'i-tax')) {
    const at = data.categories.findIndex((c) => c.id === 'i-other');
    data.categories.splice(at < 0 ? data.categories.length : at, 0, I('i-tax', '个税退税'));
  }
  data.taxYears ||= {}; // 个税年度汇算：{ 年份: { done: 日期, refund: 退了多少 } }
  data.subReview ||= {}; // 订阅体检：{ last: 上次体检日期, notes: { 订阅 id: 'keep'|'downgrade'|'stop' } }
  data.goals ||= []; // 存款目标：{ id, name, target, by: 'YYYY-MM-DD', note }
  data.milestones ||= {}; // 里程碑：{ reached: { key: { at, text } }, seen: { key: true } }
  data.milestones.reached ||= {};
  data.letters ||= {}; // 月度小信：{ 预算月开始日: { at, text } }
  data.payday ||= {}; // 发钱日卡片：{ 预算月开始日: { later: { 收入计划序号: 再问的日期 }, noTransfer: true } }
  // 心愿单
  data.wishes ||= []; // { id, name, price, want: 'very'|'nice', kind: ''|'joy'|'need', reason, link, createdAt, status: 'open'|'bought'|'dropped', targetDate, boughtAt, boughtPrice }
  data.settings.wishBigFrom ??= 300; // 多少钱以上算大额心愿
  data.settings.wishMonthlyCap ??= 400; // 每月最多给大额心愿攒多少
  data.settings.coolDays ??= 3; // 新心愿冷静几天
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

// 这笔账让某个账户变了多少（账户本身的币种）。
// 钱的进出和「算不算花销」是两回事：
//   advance 垫付 / 借给别人：钱出去了，但不是花销（是别人欠我的）
//   repay   报销到账 / 别人还我：钱回来了，但不是收入
//   payback 我还别人：钱出去了，不是花销（那笔花销在别人替我付的时候已经算过）
//   expense 没有 account、有 person：别人替我付的，算我的花销，但我的账户没动
//   writeoff 垫付结清时报不回的部分：算花销（出差自付），账户不动（钱早就在垫付时出去了）
export function delta(tx, accountId) {
  let d = 0;
  if (tx.account && tx.account === accountId) {
    if (tx.type === 'income' || tx.type === 'repay') d += tx.amount;
    else if (tx.type === 'expense' || tx.type === 'transfer' || tx.type === 'advance' || tx.type === 'payback') d -= tx.amount;
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
    if (t.type === 'expense' || t.type === 'writeoff') {
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

// ---------- 垫付报销、人情账 ----------

// 先进先出：一串 +/- 的变动，算出还剩多少、最早没结清的那笔是哪天（用来提醒「拖了多久」）
function fifo(events) {
  const lots = [];
  for (const e of events.sort((a, b) => a.date.localeCompare(b.date))) {
    let amt = e.amount;
    while (amt !== 0 && lots.length && Math.sign(lots[0].amount) !== Math.sign(amt)) {
      const use = Math.min(Math.abs(amt), Math.abs(lots[0].amount)) * Math.sign(amt);
      lots[0].amount += use;
      amt -= use;
      if (Math.abs(lots[0].amount) < 0.005) lots.shift();
    }
    if (Math.abs(amt) >= 0.005) lots.push({ date: e.date, amount: amt });
  }
  const net = Math.round(lots.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { net, since: lots[0]?.date || null };
}

// 一件垫付的事：垫了多少、报回多少、还差多少
export function claimStatus(data, claimId) {
  const tx = data.tx.filter((t) => t.claim === claimId);
  const advanced = tx.filter((t) => t.type === 'advance').reduce((s, t) => s + cny(t), 0);
  const repaid = tx.filter((t) => t.type === 'repay').reduce((s, t) => s + cny(t), 0);
  const writeoff = tx.filter((t) => t.type === 'writeoff').reduce((s, t) => s + t.amount, 0);
  const f = fifo(tx.filter((t) => t.type === 'advance' || t.type === 'repay').map((t) => ({ date: t.date, amount: t.type === 'advance' ? cny(t) : -cny(t) })));
  return { tx, advanced, repaid, writeoff, pending: Math.round((advanced - repaid) * 100) / 100, since: f.net > 0 ? f.since : null };
}

// 和一个人之间：net > 0 他欠我，< 0 我欠他
export function personStatus(data, personId) {
  const tx = data.tx.filter((t) => t.person === personId);
  const events = [];
  for (const t of tx) {
    if (t.type === 'advance' || t.type === 'payback') events.push({ date: t.date, amount: cny(t) });
    else if (t.type === 'repay') events.push({ date: t.date, amount: -cny(t) });
    else if (t.type === 'expense' && !t.account) events.push({ date: t.date, amount: -cny(t) }); // 他替我付的
  }
  const f = fifo(events);
  return { tx, net: f.net, since: f.since };
}

export function receivables(data) {
  const claims = data.claims.filter((c) => c.status !== 'settled').map((c) => ({ claim: c, ...claimStatus(data, c.id) }));
  const people = data.people.map((p) => ({ person: p, ...personStatus(data, p.id) })).filter((x) => x.net !== 0);
  const toMe = claims.reduce((s, c) => s + Math.max(0, c.pending), 0) + people.reduce((s, p) => s + Math.max(0, p.net), 0);
  const iOwe = people.reduce((s, p) => s + Math.max(0, -p.net), 0);
  return { claims, people, toMe, iOwe };
}

export const CLAIM_REMIND_DAYS = 30; // 垫付多久没报回来提醒
export const PERSON_REMIND_DAYS = 14; // 别人欠我 / 我欠别人多久提醒

// 这个预算月该不该对账：开始记账后的完整预算月，还没对过
export function needsReconcile(data, today) {
  const p = periodFor(data, today);
  if (data.openingDate && data.openingDate > p.start) return false;
  return !data.reconciled?.[p.start];
}

// ---------- 心愿单 ----------
// 钱不挪地方，只是记着「这里面有多少是给心愿的」。
// 小额心愿：心愿基金 = 每个结束的预算月，生活预算（吃饭 + 日常 + 自由钱）没花完的进来，超了从里面扣（扣到 0 为止）；买小额心愿从这里出。
// 大额心愿：每个结束的预算月，按心愿单的顺序给还没攒够的大额心愿攒，合计不超过 wishMonthlyCap；攒够一个再攒下一个。

const r2 = (n) => Math.round(n * 100) / 100;
export const isBigWish = (data, w) => Number(w.price) > (data.settings.wishBigFrom ?? 300);

// 已经结束的预算月：从开始记账那个月，到上个预算月
export function closedPeriods(data, today) {
  const out = [];
  if (!data.openingDate) return out;
  const cur = periodFor(data, today);
  for (let p = periodFor(data, data.openingDate); p.start < cur.start; p = shiftPeriod(data, p, 1)) out.push(p);
  return out;
}

export function wishFunds(data, today) {
  const periods = closedPeriods(data, today);
  const events = [
    ...periods.map((p) => ({ date: p.end, v: livingBudget(data) * partial(data, p).factor - periodStats(data, p).living, p })),
    ...data.tx.filter((t) => t.category === 'c-wish' && t.wishKind === 'small' && t.date <= today).map((t) => ({ date: t.date, v: -cny(t) })),
    // 兼职收入：存下 sideIncomeSave（七成），剩下的（三成）进心愿基金
    ...(data.settings.sideIncomeSave != null ? data.tx.filter((t) => t.type === 'income' && t.category === 'i-job' && t.date <= today)
      .map((t) => ({ date: t.date, v: r2(cny(t) * (1 - data.settings.sideIncomeSave)), job: true })) : []),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.p ? 1 : -1));
  let small = 0;
  let fromJobs = 0;
  const log = [];
  for (const e of events) {
    if (e.job) fromJobs += e.v;
    if (!e.p) { small += e.v; continue; }
    const before = small;
    small = Math.max(0, small + e.v);
    log.push({ p: e.p, leftover: r2(e.v), change: r2(small - before) });
  }
  const cap = Number(data.settings.wishMonthlyCap) || 0;
  const big = data.wishes.filter((w) => isBigWish(data, w) && w.status !== 'dropped');
  const saved = Object.fromEntries(big.map((w) => [w.id, 0]));
  for (const p of periods) {
    let left = cap;
    for (const w of big) {
      if (left <= 0) break;
      if (w.createdAt > p.end || (w.status === 'bought' && w.boughtAt <= p.end)) continue;
      const add = Math.min(left, Number(w.price) - saved[w.id]);
      if (add > 0) { saved[w.id] += add; left -= add; }
    }
  }
  return { small: r2(small), log, saved, cap, fromJobs: r2(fromJobs) };
}

// 还没买的大额心愿：按现在的顺序、每月上限，大概哪个预算月能攒够
export function bigWishPlan(data, today) {
  const f = wishFunds(data, today);
  const open = data.wishes.filter((w) => w.status === 'open' && isBigWish(data, w));
  const left = open.map((w) => Math.max(0, Number(w.price) - (f.saved[w.id] || 0)));
  const done = open.map((w, i) => (left[i] <= 0 ? periodFor(data, today).start : null));
  let p = periodFor(data, today);
  for (let m = 0; m < 120 && done.some((x) => !x) && f.cap > 0; m++) {
    let cap = f.cap;
    for (let i = 0; i < open.length && cap > 0; i++) {
      if (done[i]) continue;
      const add = Math.min(cap, left[i]);
      left[i] -= add;
      cap -= add;
      if (left[i] <= 0) done[i] = p.end; // 这个预算月结束时攒够
    }
    p = shiftPeriod(data, p, 1);
  }
  return open.map((w, i) => ({ w, saved: r2(f.saved[w.id] || 0), ready: done[i] }));
}

export const coolingLeft = (data, w, today) => Math.max(0, (data.settings.coolDays ?? 3) - daysBetween(w.createdAt, today));

// ---------- 个税退税 ----------
// 兼职（劳务报酬）发钱时常被预扣 20% 左右的个税；学生一年的应税收入一般不高，每年 3 月 1 日到 6 月 30 日
// 在「个人所得税」App 做上一年的年度汇算，多扣的能退回来。收入记账时填 tax（被预扣的个税）。

export const TAX_FROM = '03-01';
export const TAX_TO = '06-30';

export function taxYear(data, year) {
  const jobs = data.tx.filter((t) => t.type === 'income' && t.category === 'i-job' && t.date.startsWith(`${year}-`));
  return {
    year, jobs,
    income: r2(jobs.reduce((s, t) => s + cny(t), 0)),
    withheld: r2(jobs.reduce((s, t) => s + (Number(t.tax) || 0), 0)),
    done: data.taxYears?.[year]?.done || null,
    refund: data.taxYears?.[year]?.refund ?? null,
  };
}

// 今天在不在汇算期；在的话是哪一年的汇算
export function taxSeason(today) {
  const md2 = today.slice(5);
  return md2 >= TAX_FROM && md2 <= TAX_TO ? Number(today.slice(0, 4)) - 1 : null;
}

// ---------- 订阅体检 ----------
export const SUB_REVIEW_DAYS = 90;
export function subReviewDue(data, today) {
  if (!data.recurring.length) return null;
  const last = data.subReview?.last || data.openingDate || today;
  const days = daysBetween(last, today);
  return days >= SUB_REVIEW_DAYS ? { last, days } : null;
}

// 订阅一年要花多少（人民币）
export function yearlyCost(data, r, rate = data.settings.usdRate) {
  return (r.day ? r.amount * 12 : r.amount) * (isUsd(data, r.account) ? rate : 1);
}

// ---------- 存款目标（比如毕业过渡金）----------
// 不另外挪钱：存钱卡里扣掉应急钱底线、大额心愿已攒的，剩下的按目标顺序算进度。
// 暑假生活费：summerMonths 没有收入，自动成为最前面的存款目标（7 月发钱日的前一天存够那几个月的预算）
export function summerGoal(data, today) {
  const months = data.settings.summerMonths || [];
  if (!months.length || !data.settings.expectedIncome) return null;
  const first = Math.min(...months);
  const sd = data.settings.periodStartDay || 1;
  let y = Number(today.slice(0, 4));
  const startOf = (yy) => `${yy}-${String(first).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
  if (today >= startOf(y)) y += 1;
  return { id: 'auto-summer', auto: true, name: `${y} 年暑假生活费`, target: budgetTotal(data) * months.length, by: addDays(startOf(y), -1),
    note: `${months.join('、')} 月没有收入，这两个月的生活费要提前留好` };
}

// 暑假里（没有收入的预算月）开头几天：提醒从存钱卡转生活费出来
export function summerTransfer(data, today) {
  const p = periodFor(data, today);
  if (!p.summer || p.dayIndex > 5) return null;
  return { amount: livingBudget(data), period: p };
}

export function goalStatus(data, today) {
  const floorAcc = data.settings.floorAccount;
  const big = wishFunds(data, today);
  const bigSaved = data.wishes.filter((w) => w.status === 'open').reduce((s, w) => s + (big.saved[w.id] || 0), 0);
  let pool = Math.max(0, (floorAcc ? balance(data, floorAcc) : 0) - (data.settings.emergencyFloor || 0) - bigSaved);
  const sg = summerGoal(data, today);
  return [...(sg ? [sg] : []), ...data.goals].map((g) => {
    const have = Math.min(pool, Number(g.target) || 0);
    pool -= have;
    const months = g.by ? Math.max(1, Math.round(daysBetween(today, g.by) / 30.4)) : null;
    const need = Math.max(0, (Number(g.target) || 0) - have);
    return { g, have: r2(have), need: r2(need), months, perMonth: months ? Math.ceil(need / months) : null };
  });
}

// ---------- 预算调整建议 ----------
// 只看完整的、有收入的预算月（开始记账那个不完整的月、暑假不算），最近 3 个；至少 2 个才给吃饭 / 日常 / 自由钱的建议。
// 订阅按现在登记的固定扣费算，马上就能给。建议只是建议，用户点「采用」才改。

export const ADVICE_MONTHS = 3;
const roundUp = (n, step = 50) => Math.ceil(n / step) * step;
export const FREE_MIN = 200; // 自由钱不建议低于这个数：留一点余地，预算才坚持得下去

export function budgetAdvice(data, today, rate = data.settings.usdRate) {
  const full = closedPeriods(data, today).filter((p) => !partial(data, p).isPartial && !p.summer).slice(-ADVICE_MONTHS);
  const out = [];
  const dismissed = data.budgetAdviceDismissed || {};
  const cur = periodFor(data, today).start;
  const label = (g) => GROUPS.find((x) => x.id === g).name;
  if (full.length >= 2) {
    for (const g of LIVING) {
      const b = Number(data.budget[g]) || 0;
      if (!b) continue;
      const stats = full.map((p) => periodStats(data, p));
      const spent = stats.map((st) => st.spent[g]);
      const avg = spent.reduce((a, x) => a + x, 0) / spent.length;
      const max = Math.max(...spent);
      // 这几个月这一组里花得最多的类别
      const cats = {};
      for (const st of stats) for (const [id, v] of Object.entries(st.byCat)) if (category(data, id)?.group === g) cats[id] = (cats[id] || 0) + v;
      const top = Object.entries(cats).sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([id, v]) => `${category(data, id)?.name || '其他'} 月均 ${money(v / full.length)}`);
      const over = spent.filter((x) => x > b * 1.05).length;
      let to = null;
      let why = '';
      if (spent.every((x) => x <= b * 0.85)) {
        to = Math.max(roundUp(Math.max(avg * 1.1, max)), g === 'free' ? FREE_MIN : 0);
        if (to > b - 50) to = null;
        else why = `最近 ${full.length} 个月平均花 ${money(avg)}，最多的一个月 ${money(max)}，预算 ${money(b)} 一直有富余。调到 ${money(to)} 仍然比花得最多的那个月宽松。`;
      } else if (over >= 2) {
        to = roundUp(avg);
        if (to <= b) to = null;
        else why = `最近 ${full.length} 个月有 ${over} 个月超了，平均花 ${money(avg)}。预算定得太紧总是超，就容易「反正都超了」不管了。也可以不调，下个月留意花得多的几类。`;
      }
      if (!to || dismissed[g] === cur) continue;
      out.push({ group: g, name: label(g), from: b, to, why, top, delta: to - b });
    }
  }
  // 订阅：按登记的固定扣费算每月实际要多少
  const subs = data.recurring.reduce((sum, r) => sum + yearlyCost(data, r, rate), 0) / 12;
  const b = Number(data.budget.sub) || 0;
  if (data.recurring.length && Math.abs(roundUp(subs) - b) >= 50 && dismissed.sub !== cur) {
    const to = roundUp(subs);
    out.push({ group: 'sub', name: '订阅', from: b, to, delta: to - b, top: [],
      why: `现在登记的订阅（${data.recurring.map((r) => r.name).join('、')}）按今天的汇率每月大约 ${money(subs)}。预算跟着实际走，「还能花」和「存钱」才算得准。` });
  }
  return { periods: full, items: out, waiting: full.length < 2 ? 2 - full.length : 0 };
}

// ---------- 发钱日一条龙 ----------
// 收入计划里的每一笔：这个预算月到了没有；到了以后，生活费从存钱卡转出来没有。暑假没有收入，直接提醒转生活费。

// 收入计划对应的收入类别：写了 category 用它，否则按名字找
export const planCategory = (data, plan) => plan.category || data.categories.find((c) => c.kind === 'income' && c.name === plan.name)?.id || null;

export function payday(data, today) {
  const p = periodFor(data, today);
  if (partial(data, p).isPartial) return { p, waiting: [], transfer: null }; // 开始记账那个月：之前到的钱没记，不问
  const inP = data.tx.filter((t) => t.date >= p.start && t.date <= p.end);
  const snooze = data.payday?.[p.start] || {};
  const waiting = p.summer ? [] : data.incomePlan
    .map((plan, i) => ({ plan, i, category: planCategory(data, plan) }))
    .filter((x) => x.category && !inP.some((t) => t.type === 'income' && t.category === x.category) && !(snooze.later?.[x.i] >= today));
  const floor = data.settings.floorAccount;
  const gotIncome = inP.some((t) => t.type === 'income' && data.incomePlan.some((plan) => planCategory(data, plan) === t.category));
  const moved = inP.some((t) => t.type === 'transfer' && t.account === floor && t.to !== floor);
  const transfer = (gotIncome || p.summer) && !moved && !snooze.noTransfer && floor
    ? { amount: livingBudget(data), from: floor, routes: data.presets.filter((x) => x.from === floor), summer: p.summer }
    : null;
  return { p, waiting, transfer };
}

// ---------- 里程碑 ----------
// 总资产第一次超过某个整数（开始记账时就超过的不算），连续几个完整的预算月存钱达标（暑假不算、也不打断）。

export const ASSET_MILESTONES = [20000, 30000, 50000, 80000, 100000, 150000, 200000, 300000, 500000];
export const STREAK_MILESTONES = [1, 3, 6, 12, 24];

export function saveStreak(data, today) {
  const target = (Number(data.settings.expectedIncome) || 0) - budgetTotal(data);
  if (target <= 0) return 0;
  let streak = 0;
  for (const p of closedPeriods(data, today).filter((x) => !partial(data, x).isPartial && !x.summer)) {
    const st = periodStats(data, p);
    streak = st.income - st.total >= target ? streak + 1 : 0;
  }
  return streak;
}

export function newMilestones(data, today, rate = data.settings.usdRate) {
  const got = data.milestones?.reached || {};
  const out = [];
  const now = totalAssets(data, rate);
  const start = data.openingDate ? totalAssets(data, rate, data.openingDate) : 0;
  for (const m of ASSET_MILESTONES) {
    if (now >= m && start < m && !got[`a${m}`]) out.push({ key: `a${m}`, text: `总资产第一次超过 ${money(m)}` });
  }
  const streak = saveStreak(data, today);
  for (const n of STREAK_MILESTONES) {
    if (streak >= n && !got[`s${n}`]) out.push({ key: `s${n}`, text: n === 1 ? '第一个完整的预算月，存钱达标了' : `连续 ${n} 个月存钱达标` });
  }
  return out;
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
  // 6. 待收回 / 我欠别人
  const rc = receivables(data);
  if (rc.claims.length || rc.people.length) {
    const lateClaim = rc.claims.find((c) => c.pending > 0 && c.since && daysBetween(c.since, today) >= CLAIM_REMIND_DAYS);
    const latePerson = rc.people.find((x) => x.net > 0 && x.since && daysBetween(x.since, today) >= PERSON_REMIND_DAYS);
    const lateOwe = rc.people.find((x) => x.net < 0 && x.since && daysBetween(x.since, today) >= PERSON_REMIND_DAYS);
    const late = lateOwe || lateClaim || latePerson;
    const parts = [];
    if (rc.toMe) parts.push(`别人欠你 ${money(rc.toMe)}`);
    if (rc.iOwe) parts.push(`你欠别人 ${money(rc.iOwe)}`);
    out.push({
      key: 'owed', name: '待收回', value: money(rc.toMe),
      level: late ? 'warn' : 'good',
      text: parts.join('，') || '都结清了',
      action: lateOwe ? `记得还${lateOwe.person.name} ${money(-lateOwe.net)}（已经 ${daysBetween(lateOwe.since, today)} 天）。`
        : lateClaim ? `「${lateClaim.claim.name}」垫的 ${money(lateClaim.pending)} 已经 ${daysBetween(lateClaim.since, today)} 天没报回来，问一下进度。`
          : latePerson ? `提醒${latePerson.person.name}还 ${money(latePerson.net)}（已经 ${daysBetween(latePerson.since, today)} 天）。` : null,
    });
  }

  // 7. 每月对账
  if (needsReconcile(data, today)) {
    out.push({
      key: 'reconcile', name: '对账', value: '还没对',
      level: 'warn', text: '新的预算月开始了，花 1 分钟对一下各账户余额',
      action: '新的预算月开始了，到「更多 → 对账」看一眼各账户的实际余额，对不上的填一下。',
    });
  }

  // 暑假：提醒从存钱卡转生活费（首页「发钱日」卡片里能一步转好，这里只在那张卡片关掉后还没转时提醒）
  const stf = summerTransfer(data, today);
  if (stf && data.payday?.[stf.period.start]?.noTransfer && !data.tx.some((t) => t.type === 'transfer' && t.account === data.settings.floorAccount && t.date >= stf.period.start && t.date <= today)) {
    out.push({
      key: 'summer', name: '暑假生活费', value: money(stf.amount),
      level: 'warn', text: '这个预算月没有收入，从存钱卡转生活费出来',
      action: `暑假没有收入：从${account(data, data.settings.floorAccount)?.name || '存钱卡'}转这个月的生活费 ${money(stf.amount)} 到平时花钱的卡上（记一笔转账）。这是早就留好的钱，放心用。`,
    });
  }

  // 8. 个税退税（汇算期里，去年兼职被预扣过个税、还没办）
  const ty = taxSeason(today);
  if (ty) {
    const tx = taxYear(data, ty);
    if (tx.withheld > 0 && !tx.done) {
      out.push({
        key: 'tax', name: '个税退税', value: money(tx.withheld),
        level: 'warn', text: `${ty} 年兼职被预扣的个税，可以申请退了`,
        action: `${ty} 年兼职被预扣了 ${money(tx.withheld)} 个税，${md(`${ty + 1}-${TAX_TO}`)}前在「个人所得税」App 做年度汇算，多扣的能退回来。到「更多 → 个税退税」看步骤。`,
      });
    }
  }

  // 9. 订阅体检（每 3 个月）
  const sr = subReviewDue(data, today);
  if (sr) {
    out.push({
      key: 'subs', name: '订阅体检', value: `${sr.days} 天没看`,
      level: 'warn', text: '每 3 个月看一眼：每个订阅还值不值',
      action: '订阅该体检了：到「更多 → 订阅」看一眼每个还用不用、能不能降档。',
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
