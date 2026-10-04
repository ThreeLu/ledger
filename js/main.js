import { GitHub } from './github.js';
import { Store, newId } from './store.js';
import {
  GROUPS, defaultData, periodFor, shiftPeriod, partial, account, category, isUsd, balance, totalAssets, cny,
  periodStats, budgetTotal, livingBudget, duePostings, health, headline, money, md,
} from './money.js';
import { h, today } from './util.js';
import { makeXlsx } from './xlsx.js';
import { icon } from './icons.js';

const SETTINGS_KEY = 'ledger-settings';
const DEFAULT_REPO = 'ThreeLu/finance-data';
const RATE_KEY = 'ledger-usd-rate';
const LAST_KEY = 'ledger-last'; // 上次用的账户和类别，记账时默认选上
const EDITING_ROUTES = /^\/(add)/;

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
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
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
  [/^\/budget$/, () => budgetView()],
  [/^\/rules$/, () => rulesView()],
  [/^\/quick$/, () => quickView()],
  [/^\/settings$/, () => settingsView()],
];
const NAV_GROUPS = {
  '/': [/^\/?$/],
  '/list': [/^\/list/],
  '/accounts': [/^\/accounts?/],
  '/more': [/^\/more/, /^\/budget/, /^\/rules/, /^\/quick/, /^\/settings/],
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
const save = (message, fn) => saving('正在保存…', () => store.save(message, fn));

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
];

function homeView() {
  const d = store.data;
  const hl = health(d, today(), usdRate());
  const hd = headline(hl);
  const p = hl.period;
  const st = hl.stats;
  const part = partial(d, p);

  // 这个月的钱去哪了：收入分成 生活 / 订阅 / 其他花销 / 存下
  const segs = [
    { name: '生活', v: st.living, color: 'var(--amber)' },
    { name: '订阅', v: st.spent.sub, color: 'var(--blue)' },
    { name: '其他', v: st.spent.none, color: 'var(--muted)' },
  ];
  const base = Math.max(st.income, st.total, 1);
  const kept = Math.max(0, st.income - st.total);
  const flow = h('div', { class: 'card' },
    h('h3', {}, '这个月的钱'),
    h('div', { class: 'flow-line' }, `收入 ${money(st.income)} · 花了 ${money(st.total)}${st.income ? ` · 存下 ${money(st.income - st.total)}` : ''}`),
    h('div', { class: 'stack' },
      segs.filter((s) => s.v > 0).map((s) => h('span', { style: `width:${(s.v / base) * 100}%;background:${s.color}`, title: s.name })),
      kept > 0 ? h('span', { style: `width:${(kept / base) * 100}%;background:var(--sage)`, title: '存下' }) : null),
    h('div', { class: 'legend' },
      [...segs.filter((s) => s.v > 0), ...(kept > 0 ? [{ name: '存下', v: kept, color: 'var(--sage)' }] : [])]
        .map((s) => h('span', {}, h('i', { style: `background:${s.color}` }), `${s.name} ${money(s.v)}`))),
    !st.income ? h('p', { class: 'muted small' }, part.isPartial ? '这个预算月开始记账前到的收入没有记，下个预算月起就完整了。' : '这个预算月的收入还没到。') : null);

  const budgetCard = h('div', { class: 'card' },
    h('h3', {}, part.isPartial ? `预算（从 ${md(part.from)}起按天数折算）` : '预算'),
    GROUPS.filter((g) => d.budget[g.id]).map((g) => {
      const b = d.budget[g.id] * part.factor;
      const s = st.spent[g.id];
      return h('div', { class: 'budget-row' },
        h('div', { class: 'budget-top' }, h('span', {}, g.name), h('span', { class: s > b ? 'warn-text' : 'muted' }, `${money(s)} / ${money(b)}`)),
        bar(b ? s / b : 0, g.color, s > b));
    }),
    st.spent.none ? h('p', { class: 'muted small' }, `另有不占预算的花销 ${money(st.spent.none)}（手续费等）`) : null);

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
    flow,
    budgetCard,
    recent.length ? [h('div', { class: 'section-title' }, '最近记的'), h('div', { class: 'card tx-list' }, recent.map(txRow)),
      h('p', { class: 'center' }, h('a', { href: '#/list' }, '全部流水'))]
      : h('div', { class: 'card' }, h('p', {}, '还没有记账。点底部中间的 ＋ 记第一笔。')),
    h('p', { class: 'center small' }, h('a', { href: '#/rules' }, '我们的花钱方式 →')));
}

const txOrder = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '');

function txTitle(t) {
  if (t.type === 'transfer') return `转账 ${accName(t.account)} → ${accName(t.to)}`;
  if (t.type === 'adjust') return '对账差额';
  return catName(t.category);
}

function txRow(t) {
  const d = store.data;
  const usd = isUsd(d, t.account);
  let amount;
  let cls = '';
  if (t.type === 'expense') { amount = `−${exact(t.amount, usd ? '$' : '¥')}`; }
  else if (t.type === 'income') { amount = `+${exact(t.amount, usd ? '$' : '¥')}`; cls = 'in'; }
  else if (t.type === 'adjust') { amount = `${t.amount < 0 ? '−' : '+'}${exact(t.amount, usd ? '$' : '¥')}`; cls = 'muted'; }
  else { amount = exact(t.amount, usd ? '$' : '¥'); cls = 'muted'; }
  return h('a', { class: 'tx', href: `#/add?edit=${t.id}` },
    h('span', { class: 'grow' }, txTitle(t),
      h('span', { class: 'muted small block' }, [t.date.slice(5).replace('-', '/'), t.type === 'transfer' ? null : accName(t.account), t.note].filter(Boolean).join(' · '))),
    h('span', { class: `tx-amt ${cls}` }, amount,
      usd && t.cny ? h('span', { class: 'muted small block' }, `≈${exact(t.cny)}`) : null));
}

// ---------- 记一笔 ----------

const ADD_HELP = [
  ['三种账', ['支出：花出去的钱，算进预算。', '收入：生活费、补助、兼职、红包。', '转账：自己的账户之间倒钱（充校园卡、充 Apple ID、存钱卡转生活费卡），不算收入也不算花销，只是换了个口袋。']],
  ['怎么记', ['填金额 → 点类别 → 点账户 → 记好了。账户默认是你上次用的。', '用支付宝、微信绑卡付的钱，记在实际扣钱的那张卡上。', '常记的（比如食堂午饭 15）勾上「存成快捷」，以后在上面一点就记好。']],
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
  } : {
    type: q.type || 'expense', amount: '', account: q.account || last.account || 'a-wechat', to: '', toAmount: '',
    category: '', date: today(), note: '',
  };
  if (!account(d, st.account)) st.account = firstCny;
  let saveQuick = false;
  const fee = h('input', { inputmode: 'decimal', placeholder: '手续费（没有就不填）', 'aria-label': '手续费' });

  const box = h('div', {});
  let toTouched = Boolean(editing);
  const amountInput = h('input', { class: 'amount-input', inputmode: 'decimal', placeholder: '0', 'aria-label': '金额', value: st.amount,
    oninput: (e) => { st.amount = e.target.value; drawHint(); syncTo(); } });
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
      parts.push(h('div', { class: 'label-sm' }, st.type === 'income' ? '到哪个账户' : '从哪个账户付'),
        chips(d.accounts, st.account, (id) => { st.account = id; draw(); }, '账户'));
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
    if ((st.type === 'expense' || st.type === 'income') && !st.category) return toast(st.type === 'income' ? '选一下收入来源' : '选一下类别', 'error');
    if (st.type === 'transfer' && !st.to) return toast('选一下转到哪个账户', 'error');
    const usd = isUsd(d, st.account);
    const rec = { type: st.type, date: st.date, account: st.account, amount: st.type === 'adjust' ? num(st.amount) : n, note: st.note.trim() };
    if (st.type === 'expense' || st.type === 'income') {
      rec.category = st.category;
      if (usd) rec.cny = round2(n * usdRate());
    }
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
          if (!rec.to) { delete data.tx[i].to; delete data.tx[i].toAmount; }
        } else {
          data.tx.push({ id: newId('t'), ...rec, createdAt: new Date().toISOString() });
          if (st.type === 'transfer' && f > 0) {
            data.tx.push({ id: newId('t'), type: 'expense', date: st.date, account: st.account, amount: f, category: 'c-fee',
              note: `${title} 的手续费`, createdAt: new Date().toISOString(), ...(usd ? { cny: round2(f * usdRate()) } : {}) });
          }
          if (saveQuick) data.quick.push({ id: newId('q'), name: rec.note || catName(rec.category), amount: n, category: rec.category, account: rec.account });
        }
      });
      if (!editing) writeJson(LAST_KEY, { account: st.type === 'transfer' ? last.account : st.account });
      toast(editing ? '已保存' : `已记：${title} ${exact(n, curOf(st.account))}`);
      if (editing) history.back(); else go('#/', true);
    } catch { /* 已提示 */ }
  };

  const remove = async () => {
    if (!confirm(`删掉这一笔？\n${txTitle(editing)} ${exact(editing.amount, curOf(editing.account))}（${editing.date}）`)) return;
    try {
      await save(`删除：${txTitle(editing)} ${editing.amount}`, (data) => { data.tx = data.tx.filter((t) => t.id !== editing.id); });
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
      h('div', { class: 'card tx-list' }, g.list.map(txRow))])
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
    h('p', { class: 'muted small' }, `从 ${md(d.openingDate)}开始记账。`));
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
    tx.length ? h('div', { class: 'card tx-list' }, tx.map(txRow)) : h('p', { class: 'muted' }, '还没有进出记录。'));
}

// ---------- 更多 ----------

function moreView() {
  return h('div', {},
    header('更多'),
    h('div', { class: 'group' },
      cell({ href: '#/rules', ic: 'book', color: 'var(--sage)', title: '我们的花钱方式', sub: '定下来的规则，和为什么这样做' }),
      cell({ href: '#/budget', ic: 'chart', color: 'var(--amber)', title: '预算', meta: money(budgetTotal(store.data)) }),
      cell({ href: '#/quick', ic: 'bolt', color: 'var(--blue)', title: '快捷记账', meta: store.data.quick.length ? `${store.data.quick.length} 个` : '' })),
    h('div', { class: 'group' },
      cell({ href: '#/settings', ic: 'gear', color: '#8a8680', title: '设置' })),
    h('p', { class: 'center' }, h('button', { class: 'link small', onclick: exportExcel }, '导出全部账目（Excel）')));
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
  const TYPE = { expense: '支出', income: '收入', transfer: '转账', adjust: '对账差额' };
  const rows = [['日期', '类型', '类别', '金额', '币种', '折合人民币', '账户', '转入账户', '到账金额', '备注']];
  for (const t of [...d.tx].sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date, TYPE[t.type], t.category ? catName(t.category) : '', t.amount, isUsd(d, t.account) ? 'USD' : 'CNY',
      t.type === 'expense' || t.type === 'income' ? cny(t) : '', accName(t.account), t.to ? accName(t.to) : '', t.toAmount ?? '', t.note || '']);
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
