import { GitHub } from './github.js';
import { Store, newId } from './store.js';
import {
  GROUPS, defaultData, periodFor, shiftPeriod, partial, account, category, isUsd, balance, totalAssets, cny,
  periodStats, budgetTotal, livingBudget, duePostings, health, headline, money, md, addDays,
  receivables, claimStatus, personStatus, needsReconcile, CLAIM_REMIND_DAYS, PERSON_REMIND_DAYS,
} from './money.js';
import { weekOf, weekSummary, monthSummary } from './summary.js';
import { barChart, donut, lineChart } from './charts.js';
import { h, today, compressImage, blobToBase64 } from './util.js';
import { makeXlsx } from './xlsx.js';
import { icon } from './icons.js';

const SETTINGS_KEY = 'ledger-settings';
const DEFAULT_REPO = 'ThreeLu/finance-data';
const RATE_KEY = 'ledger-usd-rate';
const LAST_KEY = 'ledger-last'; // 上次用的账户和类别，记账时默认选上
const EDITING_ROUTES = /^\/(add|reconcile)/;

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let settings = readSettings();
let gh = null;
let store = null;
let loadError = null;

// ---------- 启动 ----------

function readSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* 没有就是空的 */ }
  // 和物品档案在同一个网站下，令牌可以直接用那边的（令牌要额外授权 finance-data 仓库）
  if (!s.token) {
    try {
      const inv = JSON.parse(localStorage.getItem('inventory-settings'));
      if (inv?.token) s = { ...s, token: inv.token, shared: true };
    } catch { /* 没有物品档案的设置 */ }
  }
  return s;
}
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
const writeJson = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 存不了就算了 */ } };

function connect() {
  gh = new GitHub({ token: settings.token, repo: settings.repo || DEFAULT_REPO });
  store = new Store(gh);
  store.loadCached();
}

const currentPath = () => window.location.hash.replace(/^#/, '').split('?')[0];

async function refresh() {
  const before = store.head;
  const hadData = Boolean(store.data);
  try {
    await store.load();
    loadError = null;
  } catch (e) {
    loadError = e;
  }
  if (!hadData || loadError || store.missing) render();
  else if (store.head !== before && !EDITING_ROUTES.test(currentPath())) render();
  if (!loadError && store.data) postRecurring();
}

// 固定扣费到日子了自动记一笔（比如美元账户每月扣的订阅）
let posting = false;
async function postRecurring() {
  if (posting || !duePostings(store.data, today()).length) return;
  posting = true;
  const rate = usdRate();
  try {
    const n = await store.save('自动记账：固定扣费', (data) => {
      const list = duePostings(data, today());
      if (!list.length) return false; // 别的设备已经记过了
      for (const { r, date } of list) {
        data.tx.push({
          id: newId('t'), type: 'expense', date, account: r.account, amount: r.amount, category: r.category,
          note: `${r.name}（自动）`, auto: r.id, createdAt: new Date().toISOString(),
          ...(isUsd(data, r.account) ? { cny: round2(r.amount * rate) } : {}),
        });
        r.lastPosted = date;
      }
      return list.length;
    });
    if (n && !EDITING_ROUTES.test(currentPath())) { toast(`自动记了 ${n} 笔固定扣费`); render(); }
  } catch { /* 下次打开再试 */ } finally {
    posting = false;
  }
}

// 美元汇率：每天查一次（Frankfurter，欧洲央行数据），查不到就用上次的
function usdRate() {
  const c = readJson(RATE_KEY);
  return c.rate || store?.data?.settings?.usdRate || 6.8;
}
async function updateRate() {
  const c = readJson(RATE_KEY);
  if (c.date === today()) return;
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY');
    const rate = (await res.json()).rates?.CNY;
    if (rate > 1) { writeJson(RATE_KEY, { date: today(), rate }); if (store?.data && currentPath() !== '/add') render(); }
  } catch { /* 离线就用旧汇率 */ }
}

function boot() {
  setupNav();
  window.addEventListener('hashchange', () => {
    for (const el of document.querySelectorAll('.sheet-overlay, .overlay')) el.remove(); // 换页时收起弹出的表单
    render();
    window.scrollTo(0, 0);
  });
  if (settings.token) {
    connect();
    render();
    refresh();
  } else {
    go('#/settings', true);
  }
  updateRate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store) refresh();
  });
}

function go(hash, replace = false) {
  if (replace) { history.replaceState(null, '', hash); render(); } else window.location.hash = hash;
}

// ---------- 路由 ----------

const routes = [
  [/^\/?$/, () => homeView()],
  [/^\/add$/, (_, q) => addView(q)],
  [/^\/list$/, (_, q) => listView(q)],
  [/^\/accounts$/, () => accountsView()],
  [/^\/account\/([^/]+)$/, (id) => accountView(id)],
  [/^\/more$/, () => moreView()],
  [/^\/summary$/, (_, q) => summaryView(q)],
  [/^\/claims$/, () => claimsView()],
  [/^\/claim\/([^/]+)$/, (id) => claimView(id)],
  [/^\/people$/, () => peopleView()],
  [/^\/person\/([^/]+)$/, (id) => personView(id)],
  [/^\/reconcile$/, () => reconcileView()],
  [/^\/budget$/, () => budgetView()],
  [/^\/rules$/, () => rulesView()],
  [/^\/quick$/, () => quickView()],
  [/^\/settings$/, () => settingsView()],
];
const NAV_GROUPS = {
  '/': [/^\/?$/],
  '/list': [/^\/list/],
  '/summary': [/^\/summary/],
  '/more': [/^\/more/, /^\/accounts?/, /^\/budget/, /^\/rules/, /^\/quick/, /^\/settings/, /^\/claims?/, /^\/people/, /^\/person/, /^\/reconcile/],
};

function setupNav() {
  for (const a of nav.querySelectorAll('a[data-icon]')) a.prepend(h('span', { class: 'tab-icon' }, icon(a.dataset.icon)));
  nav.querySelector('.plus').append(h('span', { class: 'circle' }, icon('plus')));
}

function render() {
  const [path, query = ''] = window.location.hash.replace(/^#/, '').split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  let content;
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (re.source.includes('settings')) content = fn();
    else if (!settings.token) content = settingsView();
    else if (loadError && !store.data) content = errorView(loadError);
    else if (store.missing) content = setupView();
    else if (!store.data) content = h('p', { class: 'muted center' }, '正在读取账本…');
    else content = fn(m[1], q);
    break;
  }
  view.replaceChildren(content || notFound());
  for (const a of nav.querySelectorAll('a[href]')) {
    const target = a.getAttribute('href').slice(1);
    a.classList.toggle('active', (NAV_GROUPS[target] || []).some((re) => re.test(path)));
  }
}

// ---------- 通用组件 ----------

const round2 = (n) => Math.round(n * 100) / 100;
// 精确金额：列表里每一笔用这个（最多两位小数）
const exact = (n, cur = '¥') => `${cur}${Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const curOf = (accId) => (isUsd(store.data, accId) ? '$' : '¥');
const accName = (id) => account(store.data, id)?.name || '（账户已删除）';
const catName = (id) => category(store.data, id)?.name || '未分类';

function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2500);
}

async function saving(message, fn) {
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, message));
  document.body.append(el);
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  } finally {
    el.remove();
  }
}
const save = (message, fn, opts) => saving('正在保存…', () => store.save(message, fn, opts));

function errorView(e) {
  return h('div', {},
    header('账本'),
    h('div', { class: 'card' },
      h('p', {}, '读取账本失败：', e.message),
      e.status === 404 ? h('p', { class: 'small muted' }, '多半是令牌还没授权 finance-data 仓库。到「设置」看怎么加。') : null,
      h('div', { class: 'actions' }, h('button', { onclick: refresh }, '重试'), h('a', { href: '#/settings', class: 'button secondary' }, '设置'))));
}
const notFound = () => h('div', { class: 'card' }, h('p', {}, '没有这个页面'), h('a', { href: '#/', class: 'button' }, '回到首页'));

function header(title, ...extra) {
  const actions = extra.filter(Boolean);
  return h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title)),
    actions.length ? h('div', { class: 'head-actions' }, actions) : null);
}
function headerSub(title, sub, ...actions) {
  const el = header(title, ...actions);
  el.firstChild.append(h('div', { class: 'sub' }, sub));
  return el;
}

function cell({ href, onclick, ic, color = 'var(--accent)', title, meta, sub }) {
  return h(href ? 'a' : 'button', { class: 'cell', href, onclick, type: href ? undefined : 'button' },
    ic ? h('span', { class: 'dot', style: `background:${color}` }, icon(ic)) : null,
    h('span', { class: 'grow' }, title, sub ? h('span', { class: 'muted small block' }, sub) : null),
    meta ? h('span', { class: 'meta' }, meta) : null,
    icon('chev', 'i chev'));
}

function openSheet({ title, body, confirmText = '确定', cancelText = '取消', onConfirm }) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('h3', {}, title),
      body,
      h('div', { class: 'actions' },
        h('button', { onclick: async () => { if ((await onConfirm()) !== false) close(); } }, confirmText),
        cancelText ? h('button', { class: 'secondary', onclick: close }, cancelText) : null)));
  document.body.append(overlay);
  return close;
}

// 页面右上角的「?」：怎么用。sections = [[小标题, [一句一句]]]
function helpButton(title, sections) {
  return h('button', { class: 'icon-btn help-btn', 'aria-label': '怎么用', onclick: () => openSheet({
    title,
    body: h('div', { class: 'help' }, sections.map(([t, lines]) => [h('h4', {}, t), h('ul', {}, lines.map((l) => h('li', {}, l)))])),
    confirmText: '知道了', cancelText: null, onConfirm: () => {},
  }) }, '?');
}

function bar(fraction, color = 'var(--accent)', over = false) {
  return h('div', { class: 'bar-track' }, h('span', { class: `bar${over ? ' over' : ''}`, style: `width:${Math.max(0, Math.min(1, fraction)) * 100}%;background:${over ? 'var(--danger)' : color}` }));
}

// ---------- 首页 ----------

const LEVEL_TEXT = { good: '好', warn: '留意', bad: '要处理' };

// 每个健康指标点开后的解释：这是什么、为什么重要、你现在怎么样
const EXPLAIN = {
  cushion: (x, hl, d) => [
    `安全垫 = 你所有账户里的钱，能撑几个月的正常开销。算法：总资产 ÷ 每月预算（${money(budgetTotal(d))}）。`,
    '它决定了意外发生时（生病、电脑坏了、补助晚发）你会不会慌。2 个月以上就算稳，3 个月以上很稳。',
    `你现在一共有 ${money(hl.assets)}，是 ${x.value}。只要每月照计划存钱，这个数会自己慢慢变大，你什么都不用做。`,
  ],
  floor: (x, hl, d) => [
    `应急钱是存钱卡里留着不动的底线（${money(d.settings.emergencyFloor)}，大约两个月的开销），专门应付意外。`,
    '有它在，就算突然要花一大笔钱，也不用动生活费或者找人借钱。所以买东西的时候，不能让存钱卡跌破这条线。',
    `${x.text}。${x.level === 'good' ? '不用管它。' : x.action}`,
  ],
  pace: (x, hl, d) => [
    '把这个月的生活预算（吃饭 + 日常 + 自由钱）按天平均，看你花得比「到今天应该花的」快还是慢。订阅是固定日子扣的，不算在节奏里。',
    '月底才发现超支就晚了。每天看一眼节奏，偏快的时候少花两天就能拉回来；慢一点就是在多存钱。',
    `这个预算月生活预算 ${money(livingBudget(d) * partial(d, hl.period).factor)}，已经花了 ${money(hl.stats.living)}，还剩 ${money(hl.left)}，${x.text}。${x.action || ''}`,
  ],
  saving: (x, hl, d) => [
    `本月存钱 = 这个预算月的收入 − 花销。按计划是 ${money(d.settings.expectedIncome)} − ${money(budgetTotal(d))} = ${money(d.settings.expectedIncome - budgetTotal(d))}。`,
    `「储蓄率」（存下的钱占收入的比例）是最能说明花钱习惯的一个数。常见的建议是存 20%。${yearPlan(d).rate != null ? `你的计划${d.settings.summerMonths.length ? `算上 ${d.settings.summerMonths.join('、')} 月没有收入，` : ''}全年约 ${yearPlan(d).rate}%。` : ''}`,
    `${x.text}。`,
  ],
  owed: (x) => [
    '待收回 = 别人欠你的钱：出差开会垫付还没报回来的，加上同学 AA、借钱还没还的。「你欠别人」是别人帮你付了、你还没还的。',
    '这些钱暂时不在你手里，所以不能当成能花的钱；拖久了容易忘，也伤感情，所以拖太久会提醒你。',
    `${x.text}。${x.action || '都还在正常的时间里，不用急。'}点「更多 → 垫付报销 / 人情账」看明细。`,
  ],
  reconcile: (x) => [
    '对账 = 打开手机银行、微信看一眼实际余额，和网站上的对一下。',
    '漏记、记错几笔很正常。每个预算月对一次，账就不会越积越乱，网站上的数字才可信。',
    `${x.text}。到「更多 → 对账」，对得上的不用填，对不上的填实际余额就行，1 分钟就好。`,
  ],
  charges: (x) => [
    '接下来 35 天要从 Apple ID 自动扣的订阅，和账户里的美元比一比。',
    '余额不够的话订阅会扣费失败、被停掉。礼品卡要提前买，所以提前提醒你。',
    `${x.text}。${x.action || '不用管它。'}`,
  ],
};
const explainYearly = (x) => ['每年续费一次的订阅，到期前 40 天提醒你。', '年费一年只扣一次，很容易忘了自己还订着。到期前想一想还用不用。', `${x.text}，${x.value}。${x.action || ''}`];

function openExplain(x, hl) {
  const [what, why, you] = (EXPLAIN[x.key] || explainYearly)(x, hl, store.data);
  openSheet({
    title: x.name,
    body: h('div', { class: 'explain' },
      h('h4', {}, '这是什么'), h('p', {}, what),
      h('h4', {}, '为什么重要'), h('p', {}, why),
      h('h4', {}, '你现在'), h('p', {}, you)),
    confirmText: '知道了', cancelText: null, onConfirm: () => {},
  });
}

const HOME_HELP = [
  ['最上面那句话', ['先说结论：一切正常、有事留意、还是有事要处理。要处理的时候会直接告诉你做什么。']],
  ['这个月还能花', ['吃饭 + 日常 + 自由钱这三项预算，减去这个预算月已经花的。下面的「每天约」= 还能花的 ÷ 剩下的天数。', '预算月从每月 15 号开始，到下个月 14 号，和发钱对齐。']],
  ['健康指标', ['绿 = 很好，不用管；黄 = 留意一下；红 = 需要做点什么。', '每一行都能点开，看它是什么、为什么重要、你现在怎么样。']],
  ['记账', ['点底部中间的 ＋ 记一笔。卡之间倒钱（充校园卡、存钱卡转生活费卡）记「转账」，不算花销。']],
  ['总结', ['底部「总结」看每周、每个预算月的图表。']],
];

// 「这个月的钱」：收入分成 生活 / 订阅 / 其他花销 / 存下
function flowCard(st, part, title = '这个月的钱') {
  const segs = [
    { name: '生活', v: st.living, color: 'var(--amber)' },
    { name: '订阅', v: st.spent.sub, color: 'var(--blue)' },
    { name: '其他', v: st.spent.none, color: 'var(--muted)' },
  ];
  const base = Math.max(st.income, st.total, 1);
  const kept = Math.max(0, st.income - st.total);
  return h('div', { class: 'card' },
    h('h3', {}, title),
    h('div', { class: 'flow-line' }, `收入 ${money(st.income)} · 花了 ${money(st.total)}${st.income ? ` · 存下 ${money(st.income - st.total)}` : ''}`),
    h('div', { class: 'stack' },
      segs.filter((x) => x.v > 0).map((x) => h('span', { style: `width:${(x.v / base) * 100}%;background:${x.color}`, title: x.name })),
      kept > 0 ? h('span', { style: `width:${(kept / base) * 100}%;background:var(--sage)`, title: '存下' }) : null),
    h('div', { class: 'legend' },
      [...segs.filter((x) => x.v > 0), ...(kept > 0 ? [{ name: '存下', v: kept, color: 'var(--sage)' }] : [])]
        .map((x) => h('span', {}, h('i', { style: `background:${x.color}` }), `${x.name} ${money(x.v)}`))),
    !st.income ? h('p', { class: 'muted small' }, part.isPartial ? '这个预算月开始记账前到的收入没有记，下个预算月起就完整了。' : '这个预算月的收入还没到。') : null);
}

// 每组预算的进度条
function budgetCard(st, part) {
  const d = store.data;
  return h('div', { class: 'card' },
    h('h3', {}, part.isPartial ? `预算（从 ${md(part.from)}起按天数折算）` : '预算'),
    GROUPS.filter((g) => d.budget[g.id]).map((g) => {
      const b = d.budget[g.id] * part.factor;
      const sp = st.spent[g.id];
      return h('div', { class: 'budget-row' },
        h('div', { class: 'budget-top' }, h('span', {}, g.name), h('span', { class: sp > b ? 'warn-text' : 'muted' }, `${money(sp)} / ${money(b)}`)),
        bar(b ? sp / b : 0, g.color, sp > b));
    }),
    st.spent.none ? h('p', { class: 'muted small' }, `另有不占预算的花销 ${money(st.spent.none)}（手续费、出差自付等）`) : null);
}

function homeView() {
  const d = store.data;
  const hl = health(d, today(), usdRate());
  const hd = headline(hl);
  const p = hl.period;
  const st = hl.stats;
  const part = partial(d, p);

  const recent = [...d.tx].sort(txOrder).slice(0, 5);
  return h('div', {},
    headerSub('账本', `${p.label} · 第 ${p.dayIndex} 天`, helpButton('首页怎么看', HOME_HELP)),
    h('div', { class: `summary ${hl.level}` }, h('div', { class: 'summary-title' }, hd.title), h('div', { class: 'summary-text' }, hd.text)),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, '这个月还能花'),
      h('div', { class: `big-num${hl.left < 0 ? ' warn-text' : ''}` }, hl.left < 0 ? `超了 ${money(-hl.left)}` : money(hl.left)),
      h('div', { class: 'muted small' }, hl.left > 0 ? `剩 ${hl.daysLeft} 天，每天约 ${money(hl.perDay)}` : `剩 ${hl.daysLeft} 天`)),
    h('div', { class: 'section-title' }, '健康指标（点开看解释）'),
    h('div', { class: 'group' }, hl.items.map((x) => h('button', { class: 'cell indicator', type: 'button', onclick: () => openExplain(x, hl) },
      h('span', { class: `light ${x.level}`, 'aria-label': LEVEL_TEXT[x.level] }),
      h('span', { class: 'grow' }, x.name, h('span', { class: 'muted small block' }, x.text)),
      h('span', { class: 'meta' }, x.value), icon('chev', 'i chev')))),
    summaryLinks(p),
    flowCard(st, part),
    budgetCard(st, part),
    recent.length ? [h('div', { class: 'section-title' }, '最近记的'), h('div', { class: 'card tx-list' }, recent.map((t) => txRow(t))),
      h('p', { class: 'center' }, h('a', { href: '#/list' }, '全部流水'))]
      : h('div', { class: 'card' }, h('p', {}, '还没有记账。点底部中间的 ＋ 记第一笔。')),
    h('p', { class: 'center small' }, h('a', { href: '#/rules' }, '我们的花钱方式 →')));
}

const txOrder = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '');

const personName = (id) => store.data.people.find((p) => p.id === id)?.name || '某人';
const claimName = (id) => store.data.claims.find((c) => c.id === id)?.name || '垫付';

function txTitle(t) {
  switch (t.type) {
    case 'transfer': return `转账 ${accName(t.account)} → ${accName(t.to)}`;
    case 'adjust': return '对账差额';
    case 'advance': return t.claim ? `垫付 · ${claimName(t.claim)}` : `帮${personName(t.person)}付 / 借给他`;
    case 'repay': return t.claim ? `报销到账 · ${claimName(t.claim)}` : `${personName(t.person)}还我`;
    case 'payback': return `还给${personName(t.person)}`;
    case 'writeoff': return `${catName(t.category)} · ${claimName(t.claim)}`;
    default: return t.person && !t.account ? `${catName(t.category)}（${personName(t.person)}代付）` : catName(t.category);
  }
}

// 这一笔点进去去哪：普通的改一笔；垫付、人情相关的去那件事 / 那个人的页面
function txHref(t) {
  if (t.claim) return `#/claim/${t.claim}`;
  if (t.person && t.type !== 'expense') return `#/person/${t.person}`;
  return `#/add?edit=${t.id}`;
}

// onclick 给了就点了执行它（垫付、人情页里点一笔是删除），不然按 txHref 跳转
function txRow(t, onclick = null) {
  const d = store.data;
  const usd = isUsd(d, t.account);
  const cur = usd ? '$' : '¥';
  let amount;
  let cls = '';
  if (t.type === 'expense' || t.type === 'writeoff') amount = `${t.amount < 0 ? '+' : '−'}${exact(t.amount, cur)}`;
  else if (t.type === 'income') { amount = `+${exact(t.amount, cur)}`; cls = 'in'; }
  else if (t.type === 'adjust') { amount = `${t.amount < 0 ? '−' : '+'}${exact(t.amount, cur)}`; cls = 'muted'; }
  else if (t.type === 'repay') { amount = `+${exact(t.amount, cur)}`; cls = 'muted'; }
  else if (t.type === 'advance' || t.type === 'payback') { amount = `−${exact(t.amount, cur)}`; cls = 'muted'; }
  else { amount = exact(t.amount, cur); cls = 'muted'; }
  const where = t.type === 'transfer' || t.type === 'writeoff' ? null : t.account ? accName(t.account) : null;
  const tag = { advance: '不算花销', repay: '不算收入', payback: '不算花销' }[t.type];
  return h('a', { class: 'tx', href: onclick ? '#' : txHref(t), onclick: onclick ? (e) => { e.preventDefault(); onclick(); } : null },
    h('span', { class: 'grow' }, txTitle(t),
      h('span', { class: 'muted small block' }, [t.date.slice(5).replace('-', '/'), where, tag, t.note].filter(Boolean).join(' · '))),
    h('span', { class: `tx-amt ${cls}` }, amount,
      usd && t.cny ? h('span', { class: 'muted small block' }, `≈${exact(t.cny)}`) : null));
}

// ---------- 记一笔 ----------

const ADD_HELP = [
  ['三种账', ['支出：花出去的钱，算进预算。', '收入：生活费、补助、兼职、红包。', '转账：自己的账户之间倒钱（充校园卡、充 Apple ID、存钱卡转生活费卡），不算收入也不算花销，只是换了个口袋。']],
  ['怎么记', ['填金额 → 点类别 → 点账户 → 记好了。账户默认是你上次用的。', '用支付宝、微信绑卡付的钱，记在实际扣钱的那张卡上。', '常记的（比如食堂午饭 15）勾上「存成快捷」，以后在上面一点就记好。']],
  ['和别人有关', ['和同学吃饭你先付：填总金额，选「AA / 帮人付」，点上一起吃的人。你那份算花销，别人的记成欠你的。', '帮人代买：同样选「AA / 帮人付」，把「我那份」改成 0。', '别人帮你付了：选「别人帮我付的」，算你的花销，记成你欠他的。', '出差开会垫钱不在这里记，去「更多 → 垫付报销」。']],
  ['美元', ['Apple ID 是美元账户，金额填美元，按当天汇率折成人民币算预算。充值 Apple ID 用转账：填花了多少人民币、到账多少美元。']],
  ['记错了', ['在流水里点那一笔，可以改，也可以删。']],
];

function addView(q) {
  const d = store.data;
  const editing = q.edit ? d.tx.find((t) => t.id === q.edit) : null;
  if (q.edit && !editing) return notFound();
  const last = readJson(LAST_KEY);
  const firstCny = d.accounts.find((a) => a.currency === 'CNY')?.id;
  const st = editing ? {
    type: editing.type === 'adjust' ? 'adjust' : editing.type, amount: String(editing.amount), account: editing.account, to: editing.to,
    toAmount: editing.toAmount != null ? String(editing.toAmount) : '', category: editing.category, date: editing.date, note: editing.note || '',
    split: editing.type === 'expense' && editing.person && !editing.account ? 'paidby' : 'none', person: editing.person || '',
  } : {
    type: q.type || 'expense', amount: '', account: q.account || last.account || 'a-wechat', to: '', toAmount: '',
    category: '', date: today(), note: '', split: 'none', person: '',
  };
  if (!account(d, st.account)) st.account = firstCny;
  // 和别人有关：AA（我先付，别人欠我）/ 别人帮我付的（我欠别人）
  const aa = { people: new Set(), newPeople: [], my: '', myTouched: false };
  const splitHint = h('div', { class: 'muted small split-hint' });
  const myInput = h('input', { inputmode: 'decimal', 'aria-label': '我那份', oninput: (e) => { aa.my = e.target.value; aa.myTouched = true; drawSplit(); } });
  const drawSplit = () => {
    if (st.split !== 'aa') return;
    const k = aa.people.size;
    const n = num(st.amount) || 0;
    if (!aa.myTouched) { aa.my = String(k ? round2(n / (k + 1)) : n); myInput.value = aa.my; }
    const my = num(aa.my) || 0;
    splitHint.textContent = k
      ? `其他 ${k} 人各约 ${exact(round2((n - my) / k))}，记成他们欠你的（不算你的花销）；你那份 ${exact(my)} 算花销。帮人代买就把「我那份」填 0。`
      : '选一下和谁 AA（可以多选）。';
  };
  let saveQuick = false;
  const fee = h('input', { inputmode: 'decimal', placeholder: '手续费（没有就不填）', 'aria-label': '手续费' });

  const box = h('div', {});
  let toTouched = Boolean(editing);
  const amountInput = h('input', { class: 'amount-input', inputmode: 'decimal', placeholder: '0', 'aria-label': '金额', value: st.amount,
    oninput: (e) => { st.amount = e.target.value; drawHint(); syncTo(); drawSplit(); } });
  const toAmountInput = h('input', { inputmode: 'decimal', 'aria-label': '到账金额', value: st.toAmount, oninput: (e) => { st.toAmount = e.target.value; toTouched = true; } });
  // 人民币 → 美元（充值 Apple ID）：到账金额先按汇率估一个，自己改过就不再自动改
  const crossCurrency = () => st.type === 'transfer' && st.to && account(d, st.to).currency !== account(d, st.account).currency;
  const syncTo = () => {
    if (!crossCurrency() || toTouched) return;
    const n = num(st.amount);
    const r = usdRate();
    st.toAmount = n > 0 ? String(round2(isUsd(d, st.to) ? n / r : n * r)) : '';
    toAmountInput.value = st.toAmount;
  };
  const hint = h('div', { class: 'muted small amount-hint' });
  const num = (s) => Number(String(s).replace(/[，,\s]/g, ''));
  const drawHint = () => {
    const usd = isUsd(d, st.account);
    const n = num(st.amount);
    hint.textContent = usd && n > 0 && st.type !== 'transfer' ? `约 ${exact(round2(n * usdRate()))}（汇率 ${usdRate().toFixed(4)}）` : '';
  };

  const chips = (items, selected, onPick, label) => h('div', { class: 'chips', role: 'group', 'aria-label': label },
    items.map((it) => h('button', { type: 'button', class: `chip${it.id === selected ? ' on' : ''}`, 'aria-pressed': String(it.id === selected), onclick: () => onPick(it.id) }, it.name)));

  const draw = () => {
    const cur = curOf(st.account);
    const parts = [];
    parts.push(h('div', { class: 'segmented' }, [['expense', '支出'], ['income', '收入'], ['transfer', '转账']].map(([k, t]) =>
      h('button', { type: 'button', class: `seg${st.type === k ? ' on' : ''}`, onclick: () => { st.type = k; st.category = ''; draw(); } }, t))));

    if (st.type === 'expense' && !editing && d.quick.length) {
      parts.push(h('div', { class: 'label-sm' }, '快捷'), h('div', { class: 'chips quick' }, d.quick.map((qk) =>
        h('button', { type: 'button', class: 'chip quick-chip', onclick: () => recordQuick(qk) }, `${qk.name} ${exact(qk.amount, curOf(qk.account))}`))));
    }
    if (st.type === 'transfer' && !editing) {
      const presets = d.presets.map((x) => [x.name, x.from, x.to]).filter(([, a, b]) => account(d, a) && account(d, b));
      if (presets.length) parts.push(h('div', { class: 'label-sm' }, '常用'), h('div', { class: 'chips' }, presets.map(([name, a, b]) =>
        h('button', { type: 'button', class: `chip${st.account === a && st.to === b ? ' on' : ''}`, onclick: () => { st.account = a; st.to = b; toTouched = false; draw(); amountInput.focus(); } }, name))));
    }

    parts.push(h('div', { class: 'amount-row' }, h('span', { class: 'cur' }, cur), amountInput), hint);
    if (d.settings.payNote && st.type === 'expense') parts.push(h('p', { class: 'muted small pay-note' }, d.settings.payNote));

    if (st.type === 'expense' || st.type === 'income') {
      const cats = d.categories.filter((c) => c.kind === st.type);
      if (st.type === 'expense') {
        parts.push(h('div', { class: 'label-sm' }, '类别'));
        for (const g of GROUPS) {
          const list = cats.filter((c) => c.group === g.id);
          if (list.length) parts.push(h('div', { class: 'cat-group' }, h('span', { class: 'cat-group-name', style: `color:${g.color}` }, g.name),
            chips(list, st.category, (id) => { st.category = id; draw(); }, `${g.name}类别`)));
        }
      } else {
        parts.push(h('div', { class: 'label-sm' }, '来源'), chips(cats, st.category, (id) => { st.category = id; draw(); }, '收入来源'));
      }
      if (!(st.type === 'expense' && st.split === 'paidby')) {
        parts.push(h('div', { class: 'label-sm' }, st.type === 'income' ? '到哪个账户' : '从哪个账户付'),
          chips(d.accounts, st.account, (id) => { st.account = id; draw(); }, '账户'));
      }
      if (st.type === 'expense' && !editing?.group) parts.push(...splitSection());
    } else if (st.type === 'transfer') {
      parts.push(h('div', { class: 'label-sm' }, '从'), chips(d.accounts, st.account, (id) => { st.account = id; draw(); }, '转出账户'),
        h('div', { class: 'label-sm' }, '到'), chips(d.accounts.filter((a) => a.id !== st.account), st.to, (id) => { st.to = id; toTouched = false; draw(); }, '转入账户'));
      if (crossCurrency()) {
        syncTo();
        parts.push(h('label', { class: 'form-label' }, `到账多少（${curOf(st.to) === '$' ? '美元' : '人民币'}）`, toAmountInput));
      }
      if (!editing) parts.push(fee);
    } else {
      parts.push(h('p', { class: 'muted small' }, `对账差额：${accName(st.account)}`));
    }

    parts.push(h('div', { class: 'row-2' },
      h('input', { type: 'date', value: st.date, 'aria-label': '日期', onchange: (e) => { st.date = e.target.value || today(); } }),
      h('input', { placeholder: '备注（选填）', value: st.note, 'aria-label': '备注', oninput: (e) => { st.note = e.target.value; } })));
    if (st.type === 'expense' && !editing) {
      parts.push(h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', checked: saveQuick, onchange: (e) => { saveQuick = e.target.checked; } }), '存成快捷，下次一点就记'));
    }
    parts.push(h('div', { class: 'actions sticky' },
      h('button', { onclick: submit }, editing ? '保存' : '记好了'),
      editing ? h('button', { class: 'danger', onclick: remove }, '删除') : null));
    box.replaceChildren(...parts);
    drawHint();
  };

  const splitSection = () => {
    const out = [h('div', { class: 'label-sm' }, '和别人有关吗'),
      chips([{ id: 'none', name: '没有' }, { id: 'aa', name: 'AA / 帮人付' }, { id: 'paidby', name: '别人帮我付的' }].filter((x) => !editing || x.id !== 'aa'),
        st.split, (id) => { st.split = id; draw(); }, '和别人有关')];
    if (st.split === 'none') return out;
    const everyone = [...d.people, ...aa.newPeople];
    const multi = st.split === 'aa';
    const isOn = (id) => (multi ? aa.people.has(id) : st.person === id);
    const pick = (id) => {
      if (!multi) st.person = id;
      else if (aa.people.has(id)) aa.people.delete(id);
      else aa.people.add(id);
      draw();
    };
    const addPerson = () => {
      const name = prompt('名字（比如 小王）')?.trim();
      if (!name) return;
      let p = everyone.find((x) => x.name === name);
      if (!p) { p = { id: newId('p'), name }; aa.newPeople.push(p); }
      pick(p.id);
    };
    out.push(h('div', { class: 'chips', role: 'group', 'aria-label': multi ? '和谁 AA' : '谁帮我付的' },
      everyone.map((p) => h('button', { type: 'button', class: `chip${isOn(p.id) ? ' on' : ''}`, 'aria-pressed': String(isOn(p.id)), onclick: () => pick(p.id) }, p.name)),
      h('button', { type: 'button', class: 'chip add', onclick: addPerson }, '+ 新的人')));
    if (multi) {
      out.push(h('label', { class: 'form-label' }, '我那份', myInput), splitHint);
      setTimeout(drawSplit);
    } else {
      out.push(h('p', { class: 'muted small' }, '算你的花销，但你的账户没动钱；记成你欠他的，还他的时候在「人情账」里点「我还他钱」。'));
    }
    return out;
  };

  const submitAA = async (n) => {
    const ids = [...aa.people];
    if (!ids.length) return toast('选一下和谁 AA', 'error');
    const my = round2(num(aa.my) || 0);
    if (my < 0 || my > n) return toast('「我那份」要在 0 和总金额之间', 'error');
    if (my > 0 && !st.category) return toast('选一下类别', 'error');
    const others = round2(n - my);
    const each = Math.floor((others / ids.length) * 100) / 100;
    const usd = isUsd(d, st.account);
    const rate = usdRate();
    const g = newId('g');
    const now = new Date().toISOString();
    const note = st.note.trim();
    try {
      await save(`AA：${st.category ? catName(st.category) : '帮人付'} ${n}`, (data) => {
        for (const p of aa.newPeople) if (ids.includes(p.id) && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
        if (my > 0) {
          data.tx.push({ id: newId('t'), type: 'expense', date: st.date, account: st.account, amount: my, category: st.category, note,
            group: g, createdAt: now, ...(usd ? { cny: round2(my * rate) } : {}) });
        }
        ids.forEach((pid, i) => {
          const amt = i === ids.length - 1 ? round2(others - each * (ids.length - 1)) : each;
          data.tx.push({ id: newId('t'), type: 'advance', date: st.date, account: st.account, amount: amt, person: pid,
            note: note || (st.category ? `${catName(st.category)} AA` : '帮忙付'), group: g, createdAt: now, ...(usd ? { cny: round2(amt * rate) } : {}) });
        });
      });
      writeJson(LAST_KEY, { account: st.account });
      toast(`已记：你那份 ${exact(my)}，${ids.length} 人共欠你 ${exact(others)}`);
      go('#/', true);
    } catch { /* 已提示 */ }
  };

  const recordQuick = async (qk) => {
    const usd = isUsd(d, qk.account);
    try {
      await save(`记账：${qk.name} ${qk.amount}`, (data) => {
        data.tx.push({ id: newId('t'), type: 'expense', date: today(), account: qk.account, amount: qk.amount, category: qk.category,
          note: qk.name, createdAt: new Date().toISOString(), ...(usd ? { cny: round2(qk.amount * usdRate()) } : {}) });
      });
      toast(`已记：${qk.name} ${exact(qk.amount, curOf(qk.account))}`);
      go('#/', true);
    } catch { /* 已提示 */ }
  };

  const submit = async () => {
    const n = round2(num(st.amount));
    if (!(n > 0) && st.type !== 'adjust') return toast('先填金额', 'error');
    if (st.type === 'expense' && st.split === 'aa' && !editing) return submitAA(n);
    if (st.type === 'expense' && st.split === 'paidby' && !st.person) return toast('选一下是谁帮你付的', 'error');
    if ((st.type === 'expense' || st.type === 'income') && !st.category) return toast(st.type === 'income' ? '选一下收入来源' : '选一下类别', 'error');
    if (st.type === 'transfer' && !st.to) return toast('选一下转到哪个账户', 'error');
    const usd = isUsd(d, st.account);
    const rec = { type: st.type, date: st.date, account: st.account, amount: st.type === 'adjust' ? num(st.amount) : n, note: st.note.trim() };
    if (st.type === 'expense' || st.type === 'income') {
      rec.category = st.category;
      if (usd) rec.cny = round2(n * usdRate());
    }
    const paidBy = st.type === 'expense' && st.split === 'paidby';
    if (paidBy) { rec.account = null; rec.person = st.person; delete rec.cny; }
    if (st.type === 'transfer') {
      rec.to = st.to;
      if (account(d, st.to).currency !== account(d, st.account).currency) {
        const ta = round2(num(st.toAmount));
        if (!(ta > 0)) return toast('填一下到账多少', 'error');
        rec.toAmount = ta;
      }
    }
    const f = round2(num(fee.value));
    const title = st.type === 'transfer' ? `转账 ${accName(st.account)} → ${accName(st.to)}` : catName(st.category);
    try {
      await save(`${editing ? '修改' : '记账'}：${title} ${n}`, (data) => {
        if (editing) {
          const i = data.tx.findIndex((t) => t.id === editing.id);
          if (i < 0) throw new Error('这一笔已经在别处删掉了');
          // 改了金额或账户，人民币金额按现在的汇率重算；没改就保留当时的
          const old = data.tx[i];
          const keepCny = old.cny != null && old.amount === rec.amount && old.account === rec.account;
          data.tx[i] = { ...old, ...rec, ...(keepCny ? { cny: old.cny } : {}) };
          if (!rec.cny && !keepCny) delete data.tx[i].cny;
          if (!paidBy && old.person && old.type === 'expense' && !old.group) delete data.tx[i].person;
          for (const p of aa.newPeople) if (p.id === rec.person && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
          if (!rec.to) { delete data.tx[i].to; delete data.tx[i].toAmount; }
        } else {
          for (const p of aa.newPeople) if (p.id === rec.person && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
          data.tx.push({ id: newId('t'), ...rec, createdAt: new Date().toISOString() });
          if (st.type === 'transfer' && f > 0) {
            data.tx.push({ id: newId('t'), type: 'expense', date: st.date, account: st.account, amount: f, category: 'c-fee',
              note: `${title} 的手续费`, createdAt: new Date().toISOString(), ...(usd ? { cny: round2(f * usdRate()) } : {}) });
          }
          if (saveQuick && !paidBy) data.quick.push({ id: newId('q'), name: rec.note || catName(rec.category), amount: n, category: rec.category, account: rec.account });
        }
      });
      if (!editing) writeJson(LAST_KEY, { account: st.type === 'transfer' || paidBy ? last.account : st.account });
      toast(editing ? '已保存' : `已记：${title} ${exact(n, curOf(st.account))}${paidBy ? `（${personName(st.person) || '他'}代付）` : ''}`);
      if (editing) history.back(); else go('#/', true);
    } catch { /* 已提示 */ }
  };

  const remove = async () => {
    const group = editing.group ? d.tx.filter((t) => t.group === editing.group) : [];
    const extra = group.length > 1 ? `\n（这是一次 AA，连同记给别人的 ${group.length - 1} 笔一起删）` : '';
    if (!confirm(`删掉这一笔？\n${txTitle(editing)} ${exact(editing.amount, curOf(editing.account))}（${editing.date}）${extra}`)) return;
    try {
      await save(`删除：${txTitle(editing)} ${editing.amount}`, (data) => {
        data.tx = data.tx.filter((t) => t.id !== editing.id && !(editing.group && t.group === editing.group));
      });
      toast('已删除');
      history.back();
    } catch { /* 已提示 */ }
  };

  draw();
  setTimeout(() => { if (!editing) amountInput.focus(); });
  return h('div', {}, header(editing ? '改一笔' : '记一笔', helpButton('怎么记账', ADD_HELP)), box);
}

// ---------- 流水 ----------

const LIST_HELP = [
  ['看什么', ['按预算月（15 号到下个月 14 号）列出每一笔，左右箭头翻月份。', '点上面的账户只看那个账户的。']],
  ['改和删', ['点任何一笔就能改或删。', '「（自动）」的是固定扣费，到日子网站自己记的。']],
];

function listView(q) {
  const d = store.data;
  let p = periodFor(d, q.day || today());
  const accFilter = q.account || '';
  const link = (day, acc) => `#/list?day=${day}${acc ? `&account=${acc}` : ''}`;
  const tx = d.tx.filter((t) => t.date >= p.start && t.date <= p.end && (!accFilter || t.account === accFilter || t.to === accFilter)).sort(txOrder);
  const st = periodStats(d, p);
  const byDay = [];
  for (const t of tx) {
    if (!byDay.length || byDay.at(-1).date !== t.date) byDay.push({ date: t.date, list: [] });
    byDay.at(-1).list.push(t);
  }
  const prev = shiftPeriod(d, p, -1);
  const next = shiftPeriod(d, p, 1);
  return h('div', {},
    header('流水', helpButton('流水怎么看', LIST_HELP)),
    h('div', { class: 'period-nav' },
      h('a', { class: 'icon-btn', href: link(prev.start, accFilter), 'aria-label': '上个月' }, '‹'),
      h('div', { class: 'grow center' }, h('b', {}, p.label), h('div', { class: 'muted small' }, `支出 ${money(st.total)} · 收入 ${money(st.income)}`)),
      next.start <= today() ? h('a', { class: 'icon-btn', href: link(next.start, accFilter), 'aria-label': '下个月' }, '›') : h('span', { class: 'icon-btn ghost' })),
    h('div', { class: 'chip-scroll' },
      h('a', { class: `chip${accFilter ? '' : ' on'}`, href: link(p.start, '') }, '全部'),
      d.accounts.map((a) => h('a', { class: `chip${accFilter === a.id ? ' on' : ''}`, href: link(p.start, a.id) }, a.name))),
    byDay.length ? byDay.map((g) => [
      h('div', { class: 'section-title' }, `${md(g.date)} 周${'日一二三四五六'[new Date(g.date.replace(/-/g, '/')).getDay()]}`),
      h('div', { class: 'card tx-list' }, g.list.map((t) => txRow(t)))])
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '这个预算月还没有记账。')));
}

// ---------- 账户 ----------

const ACC_HELP = [
  ['账户', ['每个账户的余额 = 开始记账时的余额 + 之后每一笔的进出。', '用支付宝、微信绑卡付的钱，算在实际扣钱的那张卡里。']],
  ['对不上怎么办', ['打开手机银行或微信看一眼实际余额，在账户里点「校准」填实际数，差额会记成「对账差额」。', '漏记几笔没关系，校准一下就对上了。']],
  ['总资产', ['所有账户加起来，美元按当天汇率折算。卡之间倒钱不会让它变。']],
];

function accountsView() {
  const d = store.data;
  const rate = usdRate();
  const assets = totalAssets(d, rate);
  return h('div', {},
    header('账户', helpButton('账户怎么用', ACC_HELP)),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, '总资产'),
      h('div', { class: 'big-num' }, money(assets)),
      d.accounts.some((a) => a.currency === 'USD') ? h('div', { class: 'muted small' }, `美元按 1 : ${rate.toFixed(4)} 折算`) : null),
    h('div', { class: 'group' }, d.accounts.map((a) => {
      const b = balance(d, a.id);
      return cell({ href: `#/account/${a.id}`, title: a.name, sub: a.note || null,
        meta: a.currency === 'USD' ? `${exact(b, '$')} ≈ ${money(b * rate)}` : exact(b) });
    })),
    receivablesCard(),
    h('p', { class: 'muted small' }, `从 ${md(d.openingDate)}开始记账。`));
}

// 别人欠我 / 我欠别人，加上账户就是「净资产」
function receivablesCard() {
  const d = store.data;
  const rc = receivables(d);
  if (!rc.toMe && !rc.iOwe) return null;
  const assets = totalAssets(d, usdRate());
  return h('div', { class: 'group' },
    rc.toMe ? cell({ href: rc.claims.some((c) => c.pending > 0) ? '#/claims' : '#/people', ic: 'arrowdown', color: 'var(--sage)', title: '别人欠你', meta: money(rc.toMe),
      sub: [rc.claims.length ? `垫付 ${rc.claims.length} 件` : null, rc.people.filter((x) => x.net > 0).length ? `同学 ${rc.people.filter((x) => x.net > 0).length} 人` : null].filter(Boolean).join(' · ') }) : null,
    rc.iOwe ? cell({ href: '#/people', ic: 'swap', color: 'var(--danger)', title: '你欠别人', meta: money(rc.iOwe) }) : null,
    cell({ href: '#/accounts', title: '净资产', sub: '账户 + 别人欠你的 − 你欠别人的', meta: money(assets + rc.toMe - rc.iOwe) }));
}

function accountView(id) {
  const d = store.data;
  const a = account(d, id);
  if (!a) return notFound();
  const cur = a.currency === 'USD' ? '$' : '¥';
  const b = balance(d, id);
  const tx = d.tx.filter((t) => t.account === id || t.to === id).sort(txOrder).slice(0, 60);

  const calibrate = () => {
    const input = h('input', { inputmode: 'decimal', placeholder: `实际余额（${cur}）`, 'aria-label': '实际余额' });
    openSheet({
      title: `校准「${a.name}」`,
      body: h('div', {}, h('p', { class: 'small' }, `网站上的余额是 ${exact(b, cur)}。打开手机银行或微信，看一下实际余额填在下面。`), input,
        h('p', { class: 'muted small' }, '差额会记成一笔「对账差额」，不算进预算。')),
      confirmText: '校准',
      onConfirm: async () => {
        const real = Number(input.value.replace(/[，,\s]/g, ''));
        if (!Number.isFinite(real) || input.value.trim() === '') { toast('填一下实际余额', 'error'); return false; }
        const diff = round2(real - balance(store.data, id));
        if (diff === 0) { toast('对上了，不用改'); return true; }
        try {
          await save(`校准：${a.name} ${diff > 0 ? '+' : ''}${diff}`, (data) => {
            data.tx.push({ id: newId('t'), type: 'adjust', date: today(), account: id, amount: diff, note: `校准到 ${real}`, createdAt: new Date().toISOString() });
          });
          toast(`已校准，差额 ${diff > 0 ? '+' : '−'}${exact(diff, cur)}`);
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const edit = () => {
    const name = h('input', { value: a.name, 'aria-label': '名称' });
    const note = h('input', { value: a.note || '', placeholder: '备注，比如用途', 'aria-label': '备注' });
    const opening = h('input', { inputmode: 'decimal', value: String(a.opening ?? 0), 'aria-label': '期初余额' });
    openSheet({
      title: '改账户信息',
      body: h('div', { class: 'form' }, h('label', {}, '名称', name), h('label', {}, '备注', note),
        h('label', {}, `开始记账（${md(d.openingDate)}）时的余额（${cur}）`, opening),
        h('p', { class: 'muted small' }, '平时对不上用「校准」就行，期初余额只在一开始填错时改。')),
      confirmText: '保存',
      onConfirm: async () => {
        const o = Number(opening.value.replace(/[，,\s]/g, ''));
        if (!name.value.trim() || !Number.isFinite(o)) { toast('名称和余额要填对', 'error'); return false; }
        try {
          await save(`改账户：${name.value.trim()}`, (data) => {
            const x = account(data, id);
            x.name = name.value.trim(); x.note = note.value.trim(); x.opening = round2(o);
          });
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  return h('div', {},
    header(a.name),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, '余额'),
      h('div', { class: 'big-num' }, exact(b, cur)),
      a.currency === 'USD' ? h('div', { class: 'muted small' }, `≈ ${money(b * usdRate())}`) : null,
      a.note ? h('div', { class: 'muted small' }, a.note) : null),
    h('div', { class: 'actions' },
      h('a', { class: 'button', href: `#/add?account=${id}` }, '记一笔'),
      h('button', { class: 'secondary', onclick: calibrate }, '校准'),
      h('button', { class: 'secondary', onclick: edit }, '改信息')),
    tx.length ? h('div', { class: 'card tx-list' }, tx.map((t) => txRow(t))) : h('p', { class: 'muted' }, '还没有进出记录。'));
}

// ---------- 更多 ----------

function moreView() {
  return h('div', {},
    header('更多'),
    h('div', { class: 'group' },
      cell({ href: '#/accounts', ic: 'wallet', color: 'var(--accent)', title: '账户', meta: money(totalAssets(store.data, usdRate())) }),
      cell({ href: '#/claims', ic: 'suitcase', color: 'var(--blue)', title: '垫付报销', meta: store.data.claims.filter((c) => c.status !== 'settled').length ? `${store.data.claims.filter((c) => c.status !== 'settled').length} 件在报` : '' }),
      cell({ href: '#/people', ic: 'people', color: 'var(--sage)', title: '人情账', meta: receivables(store.data).toMe ? `别人欠 ${money(receivables(store.data).toMe)}` : '' }),
      cell({ href: '#/reconcile', ic: 'check', color: 'var(--amber)', title: '对账', meta: needsReconcile(store.data, today()) ? '这个月还没对' : '' })),
    h('div', { class: 'group' },
      cell({ href: '#/rules', ic: 'book', color: 'var(--sage)', title: '我们的花钱方式', sub: '定下来的规则，和为什么这样做' }),
      cell({ href: '#/budget', ic: 'chart', color: 'var(--amber)', title: '预算', meta: money(budgetTotal(store.data)) }),
      cell({ href: '#/quick', ic: 'bolt', color: 'var(--blue)', title: '快捷记账', meta: store.data.quick.length ? `${store.data.quick.length} 个` : '' })),
    h('div', { class: 'group' },
      cell({ href: '#/settings', ic: 'gear', color: '#8a8680', title: '设置' })),
    h('p', { class: 'center' }, h('button', { class: 'link small', onclick: exportExcel }, '导出全部账目（Excel）')));
}

// ---------- 垫付、人情：通用的「一笔钱」小表单 ----------

const daysSince = (day) => Math.round((new Date(today().replace(/-/g, '/')) - new Date(day.replace(/-/g, '/'))) / 86400000);

// 金额 + 账户 + 日期 + 备注，用于垫一笔、报销到账、还钱
function moneySheet({ title, hint, amount = '', confirmText = '记好了', accountLabel = '哪个账户', onSave }) {
  const d = store.data;
  const amt = h('input', { inputmode: 'decimal', placeholder: '金额', 'aria-label': '金额', value: amount ? String(round2(amount)) : '' });
  let acc = readJson(LAST_KEY).account;
  if (!account(d, acc)) acc = d.accounts[0]?.id;
  const accBox = h('div', { class: 'chips', role: 'group', 'aria-label': accountLabel });
  const drawAcc = () => accBox.replaceChildren(...d.accounts.map((a) => h('button', {
    type: 'button', class: `chip${a.id === acc ? ' on' : ''}`, 'aria-pressed': String(a.id === acc), onclick: () => { acc = a.id; drawAcc(); },
  }, a.name)));
  drawAcc();
  const date = h('input', { type: 'date', value: today(), 'aria-label': '日期' });
  const note = h('input', { placeholder: '备注（选填）', 'aria-label': '备注' });
  openSheet({
    title,
    body: h('div', { class: 'form' }, hint ? h('p', { class: 'small muted' }, hint) : null, amt,
      h('div', { class: 'label-sm' }, accountLabel), accBox, h('div', { class: 'row-2' }, date, note)),
    confirmText,
    onConfirm: async () => {
      const n = round2(Number(amt.value.replace(/[，,\s]/g, '')));
      if (!(n > 0)) { toast('先填金额', 'error'); return false; }
      try {
        await onSave({ amount: n, account: acc, date: date.value || today(), note: note.value.trim() });
        render();
      } catch { return false; }
      return true;
    },
  });
}

// 一笔不算收支的进出（垫付、报销到账、还钱）
const moveTx = (type, f, extra) => ({
  id: newId('t'), type, date: f.date, account: f.account, amount: f.amount, note: f.note, createdAt: new Date().toISOString(),
  ...(isUsd(store.data, f.account) ? { cny: round2(f.amount * usdRate()) } : {}), ...extra,
});

// 列表里点一笔：删掉（垫付、还钱这些记错了就删了重记）
function txActions(t) {
  if (t.type === 'expense' || t.type === 'income') return () => go(`#/add?edit=${t.id}`);
  return () => {
    if (!confirm(`删掉这一笔？\n${txTitle(t)} ${exact(t.amount, curOf(t.account))}（${t.date}）`)) return;
    save(`删除：${txTitle(t)} ${t.amount}`, (data) => { data.tx = data.tx.filter((x) => x.id !== t.id); }).then(render).catch(() => {});
  };
}

// ---------- 垫付报销 ----------

const CLAIM_HELP = [
  ['什么时候用', ['出差、开会先自己垫钱，之后学校或单位报销的。每件事建一个，比如「10 月北京开会」。']],
  ['怎么记', ['垫钱的时候点「垫一笔」：机票、酒店、餐费各记一笔，从哪张卡付的就选哪张。', '垫付不算你的花销，不占预算；首页「待收回」会算上它。', '出差期间自己买的东西（纪念品、自己加的餐）照常在「记一笔」记，算花销。']],
  ['报销', ['钱回来了点「报销到账」，打到哪张卡都行，可以分几次。', '都报完了、或者确定报不了了，点「结清」：报不回的部分这时才算花销（「出差自付」，不占日常预算）。', `垫了超过 ${CLAIM_REMIND_DAYS} 天还没报回来，首页会提醒你问一下。`]],
  ['发票', ['可以上传发票 PDF 或照片，存在你的私有仓库里。交上去了就勾「已提交」。']],
];

function newClaim() {
  const name = h('input', { placeholder: '比如 10月北京开会', 'aria-label': '这件事' });
  const payer = h('input', { value: '学校', 'aria-label': '谁来报销' });
  openSheet({
    title: '新的垫付',
    body: h('div', { class: 'form' }, h('label', {}, '这件事', name), h('label', {}, '谁来报销', payer)),
    confirmText: '建好',
    onConfirm: async () => {
      if (!name.value.trim()) { toast('写个名字', 'error'); return false; }
      const id = newId('c');
      try {
        await save(`新的垫付：${name.value.trim()}`, (data) => {
          data.claims.push({ id, name: name.value.trim(), payer: payer.value.trim(), createdAt: today(), status: 'open', docs: [] });
        });
      } catch { return false; }
      go(`#/claim/${id}`);
      return true;
    },
  });
}

function claimsView() {
  const d = store.data;
  const open = d.claims.filter((c) => c.status !== 'settled');
  const done = d.claims.filter((c) => c.status === 'settled').reverse();
  const row = (c) => {
    const cs = claimStatus(d, c.id);
    const sub = c.status === 'settled' ? `已结清 ${md(c.settledAt)}`
      : cs.pending > 0 ? `还差 ${money(cs.pending)}${cs.since ? ` · 已经 ${daysSince(cs.since)} 天` : ''}` : cs.advanced ? '都报回来了，可以结清' : '还没记垫付';
    return cell({ href: `#/claim/${c.id}`, title: c.name, sub, meta: (c.docs || []).length ? `${c.docs.length} 张票` : '' });
  };
  return h('div', {},
    header('垫付报销', h('button', { class: 'icon-btn', 'aria-label': '新的垫付', onclick: newClaim }, icon('plus')), helpButton('垫付报销怎么用', CLAIM_HELP)),
    open.length ? h('div', { class: 'group' }, open.map(row))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '没有在报销中的事。出差开会要先垫钱的话，点右上角 ＋ 建一个。')),
    done.length ? [h('div', { class: 'section-title' }, '已结清'), h('div', { class: 'group' }, done.map(row))] : null);
}

async function openDoc(doc) {
  try {
    const blob = await saving('正在打开…', () => gh.readBlob(doc.file));
    const typed = new Blob([blob], { type: doc.kind === 'pdf' ? 'application/pdf' : 'image/jpeg' });
    const url = URL.createObjectURL(typed);
    if (doc.kind === 'pdf') {
      const a = h('a', { href: url, target: '_blank', rel: 'noopener', download: doc.name });
      document.body.append(a); a.click(); a.remove();
    } else {
      const ov = h('div', { class: 'overlay', onclick: () => ov.remove() }, h('img', { src: url, alt: doc.name }));
      document.body.append(ov);
    }
  } catch { /* 已提示 */ }
}

function claimView(id) {
  const d = store.data;
  const c = d.claims.find((x) => x.id === id);
  if (!c) return notFound();
  const cs = claimStatus(d, id);
  const settled = c.status === 'settled';
  const upd = (message, fn) => save(message, (data) => fn(data.claims.find((x) => x.id === id), data)).then(render).catch(() => {});

  const advance = () => moneySheet({
    title: `垫一笔 · ${c.name}`, hint: '比如机票、酒店、餐费。垫付不算你的花销。', accountLabel: '从哪个账户付的',
    onSave: (f) => save(`垫付：${c.name} ${f.amount}`, (data) => { data.tx.push(moveTx('advance', f, { claim: id })); }),
  });
  const repay = () => moneySheet({
    title: `报销到账 · ${c.name}`, amount: Math.max(0, cs.pending), accountLabel: '打到哪个账户',
    hint: cs.pending > 0 ? `还差 ${money(cs.pending)} 没报回来。这次到账多少就填多少，可以分几次记。` : null,
    onSave: (f) => save(`报销到账：${c.name} ${f.amount}`, (data) => { data.tx.push(moveTx('repay', f, { claim: id })); }),
  });
  const settle = () => {
    const diff = round2(cs.advanced - cs.repaid);
    openSheet({
      title: `结清「${c.name}」`,
      body: h('div', { class: 'explain' },
        h('p', {}, `一共垫了 ${money(cs.advanced)}，报回来 ${money(cs.repaid)}。`),
        h('p', {}, diff > 0 ? `还差 ${money(diff)} 报不回来。结清后这部分算你的花销（「出差自付」，不占日常预算，但这个月的存钱会少一点）。`
          : diff < 0 ? `多报回来 ${money(-diff)}，结清后会抵掉一部分花销。` : '正好报完了，结清后这件事就收起来了。'),
        h('p', { class: 'muted small' }, '结清以后还能「重新打开」。')),
      confirmText: '结清',
      onConfirm: () => upd(`结清：${c.name}`, (cl, data) => {
        if (diff !== 0) {
          data.tx.push({ id: newId('t'), type: 'writeoff', date: today(), amount: diff, category: 'c-trip', claim: id,
            note: diff > 0 ? '报不回的部分' : '多报回的部分', createdAt: new Date().toISOString() });
        }
        cl.status = 'settled';
        cl.settledAt = today();
      }),
    });
  };
  const reopen = () => upd(`重新打开：${c.name}`, (cl, data) => {
    data.tx = data.tx.filter((t) => !(t.claim === id && t.type === 'writeoff'));
    cl.status = 'open';
    delete cl.settledAt;
  });
  const rename = () => {
    const name = h('input', { value: c.name, 'aria-label': '这件事' });
    const payer = h('input', { value: c.payer || '', 'aria-label': '谁来报销' });
    openSheet({
      title: '改信息', body: h('div', { class: 'form' }, h('label', {}, '这件事', name), h('label', {}, '谁来报销', payer)), confirmText: '保存',
      onConfirm: () => upd(`改垫付：${name.value.trim()}`, (cl) => { cl.name = name.value.trim() || cl.name; cl.payer = payer.value.trim(); }),
    });
  };
  const remove = () => {
    if (cs.tx.length) return toast('这件事下面还有记录，先把垫付和到账删掉', 'error');
    if (!confirm(`删掉「${c.name}」？`)) return;
    save(`删除垫付：${c.name}`, (data) => { data.claims = data.claims.filter((x) => x.id !== id); }, { removes: (c.docs || []).map((x) => x.file) })
      .then(() => go('#/claims', true)).catch(() => {});
  };

  // 发票：PDF 原样存，照片压缩后存，放在私有仓库 claims/<id>/ 下
  const fileInput = h('input', { type: 'file', accept: 'application/pdf,image/*', multiple: true, hidden: true, 'aria-label': '上传发票',
    onchange: async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      try {
        await saving('正在上传…', async () => {
          const uploads = [];
          const docs = [];
          for (const f of files) {
            const pdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
            if (pdf && f.size > 20 * 1024 * 1024) throw new Error(`${f.name} 超过 20MB，太大了`);
            const blob = pdf ? f : await compressImage(f, 2200, 0.85);
            const path = `claims/${id}/${newId('')}.${pdf ? 'pdf' : 'jpg'}`;
            uploads.push({ path, base64: await blobToBase64(blob) });
            docs.push({ file: path, name: f.name, kind: pdf ? 'pdf' : 'image', submitted: false, addedAt: today() });
          }
          await store.save(`上传发票：${c.name}（${docs.length} 个）`, (data) => {
            const cl = data.claims.find((x) => x.id === id);
            cl.docs = [...(cl.docs || []), ...docs];
          }, { uploads });
        });
        toast('已上传');
        render();
      } catch { /* 已提示 */ }
    } });
  const docRow = (doc) => h('div', { class: 'manage-row' },
    h('label', { class: 'check-inline' }, h('input', { type: 'checkbox', checked: doc.submitted, 'aria-label': `${doc.name} 已提交`,
      onchange: (e) => upd(`${e.target.checked ? '已提交' : '取消已提交'}：${doc.name}`, (cl) => { cl.docs.find((x) => x.file === doc.file).submitted = e.target.checked; }) })),
    h('button', { class: 'link grow left', onclick: () => openDoc(doc) }, h('span', { class: 'badge' }, doc.kind === 'pdf' ? 'PDF' : '图片'), ` ${doc.name}`),
    h('button', { class: 'link danger-text', onclick: () => confirm(`删掉「${doc.name}」？`)
      && save(`删除发票：${doc.name}`, (data) => { const cl = data.claims.find((x) => x.id === id); cl.docs = cl.docs.filter((x) => x.file !== doc.file); }, { removes: [doc.file] }).then(render).catch(() => {}) }, '删除'));

  return h('div', {},
    headerSub(c.name, `${c.payer ? `${c.payer}报销 · ` : ''}${md(c.createdAt)}建`, h('button', { class: 'icon-btn', 'aria-label': '改信息', onclick: rename }, icon('gear'))),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, settled ? `${md(c.settledAt)}结清` : '还差'),
      h('div', { class: `big-num${settled ? ' good-text' : ''}` }, settled ? '已结清 ✓' : money(Math.max(0, cs.pending))),
      h('div', { class: 'muted small' }, settled ? `垫了 ${money(cs.advanced)} · 报回 ${money(cs.repaid)}${cs.writeoff > 0 ? ` · 报不回的 ${money(cs.writeoff)} 算了花销` : cs.writeoff < 0 ? ` · 多报回 ${money(-cs.writeoff)}` : ''}`
        : `垫了 ${money(cs.advanced)} · 报回 ${money(cs.repaid)}${cs.since ? ` · 已经 ${daysSince(cs.since)} 天` : ''}`)),
    h('div', { class: 'actions' },
      settled ? h('button', { class: 'secondary', onclick: reopen }, '重新打开') : [
        h('button', { onclick: advance }, '垫一笔'),
        h('button', { class: 'secondary', onclick: repay }, '报销到账'),
        cs.tx.length ? h('button', { class: 'secondary', onclick: settle }, '结清') : null,
      ]),
    h('div', { class: 'card' },
      h('h3', {}, `发票和单据${(c.docs || []).length ? `（已提交 ${c.docs.filter((x) => x.submitted).length} / ${c.docs.length}）` : ''}`),
      (c.docs || []).length ? (c.docs || []).map(docRow) : h('p', { class: 'muted small' }, '还没有。发票 PDF、行程单、付款截图都可以传上来，左边打勾表示已经交上去了。'),
      fileInput, h('button', { class: 'secondary wide', onclick: () => fileInput.click() }, '上传 PDF 或照片')),
    cs.tx.length ? [h('div', { class: 'section-title' }, '记录（点一笔可以删掉）'), h('div', { class: 'card tx-list' }, [...cs.tx].sort(txOrder).map((t) => txRow(t, txActions(t))))] : null,
    !cs.tx.length ? h('p', { class: 'center' }, h('button', { class: 'link danger-text small', onclick: remove }, '删掉这件事')) : null);
}

// ---------- 人情账 ----------

const PEOPLE_HELP = [
  ['记什么', ['和同学吃饭你先付、帮人代买、借钱给别人：别人欠你的。', '别人帮你付了：你欠别人的。']],
  ['怎么记', ['吃饭 AA：在「记一笔」填总金额，选「AA / 帮人付」，点上一起吃的人。你那份算花销，其他人的记成欠你的（不算花销）。', '别人帮你付：在「记一笔」选「别人帮我付的」。算你的花销，但账户没动。', '还钱：点这个人，「他还我钱」或「我还他钱」。钱到了哪张卡、从哪张卡出都行，和当初是哪张卡没关系。']],
  ['提醒', [`别人欠你、你欠别人超过 ${PERSON_REMIND_DAYS} 天，首页会提醒。`]],
];

function newPerson(after) {
  const name = h('input', { placeholder: '名字，比如 小王', 'aria-label': '名字' });
  openSheet({
    title: '加一个人', body: name, confirmText: '加好',
    onConfirm: async () => {
      const n = name.value.trim();
      if (!n) { toast('写个名字', 'error'); return false; }
      if (store.data.people.some((p) => p.name === n)) { toast('已经有这个人了', 'error'); return false; }
      const id = newId('p');
      try { await save(`人情账：加 ${n}`, (data) => { data.people.push({ id, name: n }); }); } catch { return false; }
      if (after) after(id); else render();
      return true;
    },
  });
}

function peopleView() {
  const d = store.data;
  const list = d.people.map((p) => ({ p, ...personStatus(d, p.id) }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.p.name.localeCompare(b.p.name, 'zh'));
  const rc = receivables(d);
  return h('div', {},
    header('人情账', h('button', { class: 'icon-btn', 'aria-label': '加一个人', onclick: () => newPerson((id) => go(`#/person/${id}`)) }, icon('plus')), helpButton('人情账怎么用', PEOPLE_HELP)),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, '别人一共欠你'), h('div', { class: 'big-num' }, money(list.reduce((s, x) => s + Math.max(0, x.net), 0))),
      rc.iOwe ? h('div', { class: 'small warn-text' }, `你欠别人 ${money(rc.iOwe)}`) : h('div', { class: 'muted small' }, '你不欠谁')),
    list.length ? h('div', { class: 'group' }, list.map((x) => cell({
      href: `#/person/${x.p.id}`, title: x.p.name,
      sub: x.net > 0 ? `欠你 · ${daysSince(x.since)} 天` : x.net < 0 ? `你欠他 · ${daysSince(x.since)} 天` : '两清了',
      meta: x.net ? money(Math.abs(x.net)) : '',
    }))) : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有人。在「记一笔」里选「AA / 帮人付」就会自动加上，也可以点右上角 ＋。')));
}

function personView(id) {
  const d = store.data;
  const p = d.people.find((x) => x.id === id);
  if (!p) return notFound();
  const ps = personStatus(d, id);
  const record = (type, title, hint, amount) => moneySheet({
    title, hint, amount, accountLabel: type === 'repay' ? '钱到了哪个账户' : '从哪个账户出',
    onSave: (f) => save(`${title}：${f.amount}`, (data) => { data.tx.push(moveTx(type, f, { person: id })); }),
  });
  const rename = () => {
    const name = h('input', { value: p.name, 'aria-label': '名字' });
    openSheet({
      title: '改名字', body: name, confirmText: '保存',
      onConfirm: () => save(`人情账：${p.name} 改名 ${name.value.trim()}`, (data) => { data.people.find((x) => x.id === id).name = name.value.trim() || p.name; }).then(render).catch(() => false),
    });
  };
  const remove = () => {
    if (ps.tx.length) return toast('和他还有记录，不能删', 'error');
    save(`人情账：删除 ${p.name}`, (data) => { data.people = data.people.filter((x) => x.id !== id); }).then(() => go('#/people', true)).catch(() => {});
  };
  return h('div', {},
    header(p.name, h('button', { class: 'icon-btn', 'aria-label': '改名字', onclick: rename }, icon('gear'))),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, ps.net > 0 ? '他欠你' : ps.net < 0 ? '你欠他' : '两清了'),
      h('div', { class: `big-num${ps.net < 0 ? ' warn-text' : ''}` }, money(Math.abs(ps.net))),
      ps.since ? h('div', { class: 'muted small' }, `最早一笔没结清的是 ${md(ps.since)}，${daysSince(ps.since)} 天前`) : null),
    h('div', { class: 'actions' },
      h('button', { onclick: () => record('repay', `${p.name}还我钱`, '钱到了哪个账户就选哪个，和当初从哪张卡付的没关系。', Math.max(0, ps.net)) }, '他还我钱'),
      h('button', { class: 'secondary', onclick: () => record('payback', `还给${p.name}`, '不算花销：那笔花销在他帮你付的时候已经算过了。', Math.max(0, -ps.net)) }, '我还他钱'),
      h('button', { class: 'secondary', onclick: () => record('advance', `借给${p.name} / 帮他付`, '不算你的花销，记成他欠你的。') }, '借给他')),
    ps.tx.length ? h('div', { class: 'card tx-list' }, [...ps.tx].sort(txOrder).map((t) => txRow(t, txActions(t))))
      : [h('p', { class: 'muted' }, '还没有记录。'), h('p', { class: 'center' }, h('button', { class: 'link danger-text small', onclick: remove }, '删掉这个人'))]);
}

// ---------- 每月对账 ----------

function reconcileView() {
  const d = store.data;
  const p = periodFor(d, today());
  const done = d.reconciled?.[p.start];
  const inputs = {};
  const submit = async () => {
    const diffs = [];
    for (const a of d.accounts) {
      const v = inputs[a.id].value.replace(/[，,\s]/g, '');
      if (v === '') continue;
      const real = Number(v);
      if (!Number.isFinite(real)) return toast(`${a.name}要填数字`, 'error');
      const diff = round2(real - balance(d, a.id));
      if (diff !== 0) diffs.push({ a, real, diff });
    }
    try {
      await save(`对账（${p.label}）${diffs.length ? `：${diffs.map((x) => x.a.name).join('、')}有差额` : '：都对得上'}`, (data) => {
        for (const x of diffs) {
          data.tx.push({ id: newId('t'), type: 'adjust', date: today(), account: x.a.id, amount: x.diff, note: `对账：校准到 ${x.real}`, createdAt: new Date().toISOString() });
        }
        data.reconciled = { ...(data.reconciled || {}), [p.start]: today() };
      });
      toast(diffs.length ? `对完了，${diffs.length} 个账户补了差额` : '对完了，都对得上 ✓');
      go('#/', true);
    } catch { /* 已提示 */ }
  };
  return h('div', { class: 'form' },
    headerSub('对账', done ? `这个预算月 ${md(done)} 已经对过了，可以再对一次` : `${p.label}`, helpButton('为什么要对账', [
      ['为什么', ['漏记、记错几笔很正常。每个预算月开始时对一次，账就不会越积越乱。']],
      ['怎么对', ['打开手机银行、微信、校园卡 App，看一眼实际余额。', '对得上的空着不填；对不上的填实际余额，差额自动记成「对账差额」，不算进预算。', '美元账户填美元。']],
    ])),
    h('div', { class: 'card' },
      d.accounts.map((a) => {
        const cur = a.currency === 'USD' ? '$' : '¥';
        inputs[a.id] = h('input', { inputmode: 'decimal', placeholder: '对得上就不填', 'aria-label': `${a.name}实际余额` });
        return h('label', {}, h('span', { class: 'rec-top' }, h('span', {}, a.name), h('span', { class: 'muted' }, `网站上 ${exact(balance(d, a.id), cur)}`)), inputs[a.id]);
      })),
    h('div', { class: 'actions sticky' }, h('button', { onclick: submit }, '对完了')));
}

// ---------- 总结 ----------

const SUMMARY_HELP = [
  ['周总结', ['一周从周一到周日。柱子是每天的生活花销（吃饭 + 日常 + 自由钱），虚线是每天的预算：柱子在虚线下面就是没超。', '环形图是这周的钱花在哪几块，下面的箭头是和上周比。']],
  ['月总结', ['按预算月算（和发钱对齐）。', '花钱曲线：实线是这个月累计花了多少，虚线是按计划到这天该花多少。实线在虚线下面，就是花得比计划慢。', '存钱趋势和总资产趋势看最近几个月。总资产一直往上走，就说明一切都在正轨上。']],
  ['翻看', ['左右箭头看以前的。']],
];
const WEEKDAYS = '一二三四五六日';

function summaryView(q) {
  const d = store.data;
  const mode = q.mode === 'month' ? 'month' : 'week';
  const day = q.day || today();
  const link = (m, dd) => `#/summary?mode=${m}&day=${dd}`;
  const seg = h('div', { class: 'segmented' }, [['week', '周'], ['month', '月']].map(([k, t]) =>
    h('a', { class: `seg${mode === k ? ' on' : ''}`, href: link(k, today()) }, t)));
  const navRow = (label, sub, prev, next) => h('div', { class: 'period-nav' },
    h('a', { class: 'icon-btn', href: link(mode, prev), 'aria-label': '上一个' }, '‹'),
    h('div', { class: 'grow center' }, h('b', {}, label), sub ? h('div', { class: 'muted small' }, sub) : null),
    next <= today() ? h('a', { class: 'icon-btn', href: link(mode, next), 'aria-label': '下一个' }, '›') : h('span', { class: 'icon-btn ghost' }));
  const head = header('总结', helpButton('总结怎么看', SUMMARY_HELP));

  if (mode === 'week') {
    const ws = weekSummary(d, day);
    const groups = GROUPS.filter((g) => ws.st.byGroup[g.id] || ws.prev.byGroup[g.id]);
    const arrow = (now, before) => {
      const diff = now - before;
      if (Math.abs(diff) < 1) return h('span', { class: 'muted small' }, '和上周一样');
      return h('span', { class: `small ${diff > 0 ? 'warn-text' : 'good-text'}` }, `${diff > 0 ? '↑' : '↓'} ${money(Math.abs(diff))}`);
    };
    return h('div', {}, head, seg,
      navRow(ws.label, ws.end >= today() && ws.start <= today() ? '这周' : null, addDays(ws.start, -1), addDays(ws.end, 1)),
      h('div', { class: 'card summary-head' }, h('p', {}, ws.headline)),
      h('div', { class: 'card' }, h('h3', {}, '每天的生活花销'),
        barChart(ws.days.map((x, i) => ({ label: `周${WEEKDAYS[i]}`, v: x.v, color: x.v > ws.perDay ? 'var(--amber)' : 'var(--accent)' })),
          { line: ws.perDay, lineLabel: `每天预算 ${money(ws.perDay)}`, title: '每天的生活花销' })),
      h('div', { class: 'card' }, h('h3', {}, '花在哪了'),
        ws.st.total ? h('div', { class: 'donut-row' },
          donut(GROUPS.map((g) => ({ name: g.name, v: ws.st.byGroup[g.id], color: g.color })), { center: money(ws.st.total), sub: '这周花销', title: '花在哪了' }),
          h('div', { class: 'donut-legend' }, groups.map((g) => h('div', {},
            h('span', {}, h('i', { style: `background:${g.color}` }), g.name), h('b', {}, money(ws.st.byGroup[g.id])), arrow(ws.st.byGroup[g.id], ws.prev.byGroup[g.id])))))
          : h('p', { class: 'muted small' }, '这周还没有花销。')),
      ws.top.length ? h('div', { class: 'card tx-list' }, h('h3', {}, '这周最大的几笔'), ws.top.map((t) => txRow(t))) : null);
  }

  const ms = monthSummary(d, day, usdRate());
  const p = ms.p;
  const upto = ms.curve.filter((x) => x.day <= today());
  const n = ms.curve.length - 1;
  const hist = ms.hist;
  return h('div', {}, head, seg,
    navRow(p.label, p.start <= today() && p.end >= today() ? '这个预算月' : null, addDays(p.start, -1), p.next),
    h('div', { class: 'card summary-head' }, h('p', {}, ms.headline),
      h('div', { class: 'advice' }, h('b', {}, '下个月可以试试：'), ms.advice)),
    flowCard(ms.st, ms.part, '钱怎么分的'),
    h('div', { class: 'card' }, h('h3', {}, '花钱曲线（生活花销）'),
      lineChart([
        { values: ms.curve.map((x) => x.planned), color: 'var(--muted)', dashed: true },
        { values: upto.map((x) => x.actual), color: 'var(--accent)' },
      ], { xLabels: [[0, md(p.start)], [Math.round(n / 2), md(ms.curve[Math.round(n / 2)].day)], [n, md(p.end)]], title: '花钱曲线' }),
      h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--accent)' }), '实际累计'), h('span', {}, h('i', { style: 'background:var(--muted)' }), '按计划'))),
    budgetCard(ms.st, ms.part),
    hist.length ? h('div', { class: 'card' }, h('h3', {}, '每月存下'),
      barChart(hist.map((x) => ({ label: `${x.p.startMonth}月`, v: Math.round(x.saved), color: x.saved >= 0 ? 'var(--sage)' : 'var(--danger)' })), { title: '每月存下' }),
      hist.length < 2 ? h('p', { class: 'muted small' }, '记满几个月，这里就能看出趋势。') : null) : null,
    hist.length ? h('div', { class: 'card' }, h('h3', {}, '总资产'),
      lineChart([{ values: hist.map((x) => Math.round(x.assets)), color: 'var(--accent)' }],
        { fromZero: false, xLabels: hist.length > 1 ? [[0, `${hist[0].p.startMonth}月`], [hist.length - 1, `${hist.at(-1).p.startMonth}月`]] : [[0, `${hist[0].p.startMonth}月`]], title: '总资产' }),
      h('p', { class: 'muted small' }, `每个预算月月底的总资产（美元按今天的汇率）。现在 ${money(hist.at(-1).assets)}。`)) : null,
    ms.owedStart || ms.owedEnd ? h('div', { class: 'card' }, h('h3', {}, '待收回'),
      h('p', {}, `月初 ${money(ms.owedStart)} → 月底 ${money(ms.owedEnd)}`)) : null);
}

// 首页上的总结入口：周一、周二提醒看上周；预算月头三天提醒看上个月
function summaryLinks(p) {
  const wd = new Date().getDay();
  const out = [];
  if (wd === 1 || wd === 2) out.push(cell({ href: `#/summary?mode=week&day=${addDays(weekOf(today()).start, -1)}`, ic: 'chart', color: 'var(--blue)', title: '上周总结出来了' }));
  if (p.dayIndex <= 3 && !(store.data.openingDate > addDays(p.start, -1))) {
    out.push(cell({ href: `#/summary?mode=month&day=${addDays(p.start, -1)}`, ic: 'chart', color: 'var(--accent)', title: '上个预算月的总结出来了' }));
  }
  return out.length ? h('div', { class: 'group' }, out) : null;
}

// ---------- 我们的花钱方式 ----------

// 一年的账：收入 × 发钱的月数 − 预算 × 12
function yearPlan(d) {
  const inc = Number(d.settings.expectedIncome) || 0;
  const paidMonths = 12 - (d.settings.summerMonths || []).length;
  const yearIn = inc * paidMonths;
  const yearOut = budgetTotal(d) * 12;
  return { inc, paidMonths, yearIn, yearOut, rate: yearIn ? Math.round(((yearIn - yearOut) / yearIn) * 100) : null };
}

// 规则都从账本数据里生成（具体的收入、说明写在私有的 finance.json，代码里不放个人信息）
function rulesView() {
  const d = store.data;
  const b = d.budget;
  const plan = yearPlan(d);
  const months = d.settings.summerMonths || [];
  const reserve = plan.paidMonths < 12 ? Math.round((budgetTotal(d) * (12 - plan.paidMonths)) / plan.paidMonths) : 0;
  const floorName = account(d, d.settings.floorAccount)?.name || '存钱卡';
  const rules = [];
  const R = (title, text, why) => rules.push([title, text, why]);
  R('先存后花', '钱一到账，先把要存的留下，剩下的才是能花的。', '等月底看剩多少再存，通常就剩不下了。先存的话，存钱这件事就不靠意志力。');
  if (d.incomePlan.length) {
    R(`${d.incomePlan.length} 笔收入，各管一件事`,
      [`收入都打到${floorName}（存钱卡）。`, ...d.incomePlan.map((x) => `${x.name} ${money(x.amount)}${x.when ? `（${x.when}）` : ''}：${x.use || ''}`)].join('\n'),
      '每笔钱分工明确，最好记，也最不容易乱花。');
  }
  rules.push(['__budget']);
  if (b.free) R('自由钱', `每月 ${money(b.free)}，想喝杯奶茶、买点小东西，花了就花了，不用想。`, '一点余地都不留的预算很难坚持，一旦超了就容易破罐破摔。留一小块不用记挂的钱，反而能长期存下去。');
  if (d.settings.emergencyFloor > 0) {
    R(`应急钱不低于 ${money(d.settings.emergencyFloor)}`, `${floorName}里至少留 ${money(d.settings.emergencyFloor)}，专门应付意外（生病、电脑坏了、收入晚到）。买东西不能动它。`, '有这笔钱在，意外来了也不会慌，不用借钱。');
  }
  if (months.length) {
    R(`${months.join('、')} 月没有收入`, `一年只有 ${plan.paidMonths} 个月有收入，但 12 个月都要花钱。所以有收入的月份每月要多留约 ${money(reserve)}，到时候从存钱卡转生活费出来。`, '不提前留，到时候会觉得存款在「变少」，其实是计划内的。');
  }
  if (d.settings.sideIncomeSave != null) {
    const k = Math.round(d.settings.sideIncomeSave * 100);
    R('兼职的钱', `${k}% 存下，${100 - k}% 当额外的自由钱。`, '既能多存，又不会觉得「赚了钱却花不到」。');
  }
  R('转账不算花钱', '充校园卡、充值美元账户、存钱卡转生活费卡，都只是把钱从一个口袋换到另一个口袋，记「转账」。真正刷卡、扣费的时候才算花销。', '这样每个月花了多少、花在哪才准；每个账户的余额也能和实际对上。');
  if (d.accounts.some((a) => a.currency === 'USD')) {
    R('美元账户', '美元账户按美元记。订阅到了扣费日，网站自己记一笔，按当天汇率折成人民币算进预算。余额不够下次扣费时，首页会提前提醒你充值。');
  }
  R('记错了不要紧', '漏记、记错几笔很正常。打开手机银行看一眼实际余额，在账户页点「校准」，差额会自动补一笔，账就对上了。');

  const card = (n, [title, text, why]) => h('div', { class: 'card rule' }, h('h2', {}, `${n}. ${title}`),
    text.split('\n').map((t) => h('p', {}, t)), why ? h('p', { class: 'why' }, `为什么：${why}`) : null);
  const catList = (g) => d.categories.filter((c) => c.group === g).map((c) => c.name).join('、');
  const budgetCard = (n) => h('div', { class: 'card rule' }, h('h2', {}, `${n}. 每月预算 ${money(budgetTotal(d))}`),
    h('table', { class: 'rule-table' }, h('tbody', {}, GROUPS.filter((g) => b[g.id]).map((g) =>
      h('tr', {}, h('td', {}, g.name), h('td', {}, money(b[g.id])), h('td', {}, [catList(g.id), d.notes[g.id]].filter(Boolean).join('。')))))),
    h('p', {}, d.settings.periodStartDay > 1 ? `预算月从每月 ${d.settings.periodStartDay} 号算到下个月 ${d.settings.periodStartDay - 1} 号，和发钱对齐：钱到了，新的一个月就开始了。` : '预算月就是自然月。'),
    h('p', { class: 'why' }, '为什么分组：吃饭是最大的一块，单独看最清楚；其他日常只管总数，不用每一类都操心。'));
  return h('div', {},
    headerSub('我们的花钱方式', '这几条是我们一起定下来的。哪天不确定「我这样花对不对」，就回来看看。'),
    rules.map((r, i) => (r[0] === '__budget' ? budgetCard(i + 1) : card(i + 1, r))),
    plan.yearIn ? h('div', { class: 'card rule' }, h('h2', {}, '一年下来'),
      h('p', {}, `收入 ${money(plan.yearIn)}（${plan.inc.toLocaleString('zh-CN')} × ${plan.paidMonths} 个月）− 花销 ${money(plan.yearOut)}（${budgetTotal(d).toLocaleString('zh-CN')} × 12 个月）= 能存约 ${money(plan.yearIn - plan.yearOut)}，储蓄率 ${plan.rate}%。`),
      h('p', { class: 'why' }, '常见的建议是存 20%。')) : null);
}

// ---------- 预算 ----------

function budgetView() {
  const d = store.data;
  const inputs = {};
  const field = (label, key, value, hint) => {
    inputs[key] = h('input', { inputmode: 'decimal', value: String(value ?? ''), 'aria-label': label });
    return h('label', {}, label, inputs[key], hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const catList = (g) => d.categories.filter((c) => c.group === g).map((c) => c.name).join('、');
  const submit = async () => {
    const val = (k) => Number(inputs[k].value.replace(/[，,\s]/g, ''));
    const keys = Object.keys(inputs);
    if (keys.some((k) => !Number.isFinite(val(k)) || val(k) < 0)) return toast('金额要填数字', 'error');
    try {
      await save('改预算', (data) => {
        for (const g of ['food', 'daily', 'free', 'sub']) data.budget[g] = val(g);
        data.settings.expectedIncome = val('income');
        data.settings.emergencyFloor = val('floor');
      });
      toast('已保存');
      go('#/', true);
    } catch { /* 已提示 */ }
  };
  return h('div', { class: 'form' },
    headerSub('预算', '每个预算月（15 号到下个月 14 号）的计划', helpButton('预算怎么定', [
      ['怎么定的', ['这些数是我们按你的饮食习惯和固定扣费一起估的。第一两个月照常花、照实记，再按真实数据调。']],
      ['改了会怎样', ['首页的「还能花」「花钱节奏」「本月存钱」都会按新数字算。以前的流水不受影响。']],
    ])),
    h('div', { class: 'card' },
      field('吃饭', 'food', d.budget.food, catList('food')),
      field('日常', 'daily', d.budget.daily, catList('daily')),
      field('自由钱', 'free', d.budget.free, catList('free')),
      field('订阅', 'sub', d.budget.sub, catList('sub')),
      h('p', { class: 'muted small' }, '手续费不占预算，但算花销。')),
    h('div', { class: 'card' },
      field('每月正常收入', 'income', d.settings.expectedIncome, `用来估「本月存钱」。${d.settings.summerMonths.length ? `${d.settings.summerMonths.join('、')} 月不发，按 0 算。` : ''}`),
      field('应急钱底线', 'floor', d.settings.emergencyFloor, `${account(d, d.settings.floorAccount)?.name || '存钱卡'}不低于这个数。`)),
    h('div', { class: 'actions sticky' }, h('button', { onclick: submit }, '保存')));
}

// ---------- 快捷记账 ----------

function quickView() {
  const d = store.data;
  const remove = async (qk) => {
    try { await save(`删除快捷：${qk.name}`, (data) => { data.quick = data.quick.filter((x) => x.id !== qk.id); }); render(); } catch { /* 已提示 */ }
  };
  return h('div', {},
    headerSub('快捷记账', '记一笔时勾「存成快捷」就会加到这里'),
    d.quick.length ? h('div', { class: 'card' }, d.quick.map((qk) => h('div', { class: 'manage-row' },
      h('span', { class: 'grow' }, qk.name, h('span', { class: 'muted small block' }, `${catName(qk.category)} · ${accName(qk.account)}`)),
      h('span', {}, exact(qk.amount, curOf(qk.account))),
      h('button', { class: 'link danger-text', onclick: () => remove(qk) }, '删除'))))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有快捷。记一笔支出时勾上「存成快捷」，比如「食堂午饭 15 · 校园卡」。')));
}

// ---------- 导出 ----------

function exportExcel() {
  const d = store.data;
  const TYPE = { expense: '支出', income: '收入', transfer: '转账', adjust: '对账差额', advance: '垫付/借出', repay: '报销到账/还我', payback: '我还别人', writeoff: '垫付结清差额' };
  const rows = [['日期', '类型', '类别', '金额', '币种', '折合人民币', '账户', '转入账户', '到账金额', '垫付的事 / 人', '备注']];
  for (const t of [...d.tx].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date, TYPE[t.type], t.category ? catName(t.category) : '', t.amount, isUsd(d, t.account) ? 'USD' : 'CNY',
      ['expense', 'income', 'writeoff'].includes(t.type) ? cny(t) : '', t.account ? accName(t.account) : '', t.to ? accName(t.to) : '', t.toAmount ?? '',
      t.claim ? claimName(t.claim) : t.person ? personName(t.person) : '', t.note || '']);
  }
  const blob = new Blob([makeXlsx(rows, '账目')], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `账目-${today()}.xlsx` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- 第一次使用 ----------

function setupView() {
  const d = defaultData(today());
  const inputs = {};
  const start = async () => {
    for (const a of d.accounts) {
      const v = inputs[a.id].value.replace(/[，,\s]/g, '');
      const n = Number(v || 0);
      if (!Number.isFinite(n)) return toast(`${a.name}的余额要填数字`, 'error');
      a.opening = round2(n);
    }
    try {
      await saving('正在创建账本…', () => store.create(d, '开始记账'));
      toast('账本建好了');
      go('#/', true);
    } catch { /* 已提示 */ }
  };
  return h('div', { class: 'form' },
    headerSub('开始记账', '先填每个账户现在有多少钱，作为起点'),
    h('div', { class: 'card' },
      d.accounts.map((a) => {
        inputs[a.id] = h('input', { inputmode: 'decimal', placeholder: '0', 'aria-label': `${a.name}余额` });
        return h('label', {}, `${a.name}（${a.currency === 'USD' ? '美元' : '人民币'}）`, inputs[a.id], a.note ? h('div', { class: 'hint' }, a.note) : null);
      }),
      h('p', { class: 'muted small' }, '以前的账不用补。以后对不上的时候，在账户页「校准」就行。')),
    h('div', { class: 'actions sticky' }, h('button', { onclick: start }, '开始记账')));
}

// ---------- 设置 ----------

function settingsView() {
  const repo = h('input', { value: settings.repo || DEFAULT_REPO, 'aria-label': '数据仓库' });
  const token = h('input', { type: 'password', value: settings.shared ? '' : settings.token || '', placeholder: settings.shared ? '正在用物品档案的令牌' : 'github_pat_…', 'aria-label': '令牌' });
  const saveSettings = () => {
    const t = token.value.trim();
    const old = readJson(SETTINGS_KEY);
    // 留空：保留以前填的，没有就用物品档案的
    writeJson(SETTINGS_KEY, { repo: repo.value.trim() || DEFAULT_REPO, ...(t ? { token: t } : old.token ? { token: old.token } : {}) });
    settings = readSettings();
    if (!settings.token) return toast('请填写令牌', 'error');
    connect();
    loadError = null;
    go('#/', true);
    refresh();
  };
  const logout = () => {
    if (!confirm('退出这台设备？\n账本数据在 GitHub 上，不会丢；以后重新填令牌就能回来。')) return;
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem('ledger-cache');
    settings = {};
    store = null;
    go('#/settings', true);
  };
  return h('div', {},
    header('设置'),
    h('div', { class: 'card' },
      h('h3', {}, '连接账本仓库'),
      h('p', { class: 'small' }, '账本存在你的 GitHub 私有仓库 finance-data 里。和物品档案用同一个令牌，只要让令牌多授权这个仓库：'),
      h('ol', { class: 'small' },
        h('li', {}, '电脑或手机打开 github.com → 右上角头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens。'),
        h('li', {}, '点物品档案用的那个令牌 → Edit。'),
        h('li', {}, 'Repository access 里把 finance-data 也勾上（Contents 权限已经是 Read and write）→ Update。'),
        h('li', {}, '回到这里点「保存并连接」。令牌本身没变，不用重新复制。')),
      h('div', { class: 'form' },
        h('label', {}, '数据仓库', repo),
        h('label', {}, settings.shared ? '令牌（留空 = 用物品档案的）' : '令牌', token)),
      h('button', { class: 'wide', onclick: saveSettings }, '保存并连接')),
    settings.token ? h('div', { class: 'card' },
      h('p', { class: 'small' }, '数据仓库：', settings.repo || DEFAULT_REPO, '（每次记账都是一次提交，可以在 GitHub 上查看历史）'),
      h('button', { class: 'danger', onclick: logout }, '退出这台设备')) : null);
}

boot();
