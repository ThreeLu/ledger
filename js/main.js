import { GitHub, DEVICE, recentCommits } from './github.js';
import { Store, newId, diff, apply as applyPatch } from './store.js';
import {
  GROUPS, defaultData, periodFor, shiftPeriod, partial, account, category, isUsd, balance, totalAssets, cny,
  periodStats, budgetTotal, livingBudget, duePostings, upcoming, health, headline, money, md, addDays, payday, newMilestones,
  receivables, claimStatus, personStatus, needsReconcile, CLAIM_REMIND_DAYS, PERSON_REMIND_DAYS, budgetAdvice,
  isBigWish, wishFunds, bigWishPlan, coolingLeft, closedPeriods,
  taxYear, taxSeason, TAX_TO, subReviewDue, yearlyCost, goalStatus, FAVOR_CATEGORIES, GIFT_IN, giftsWith, openFavors, holidayFavors, socialPlan, favorDue,
} from './money.js';
import { holidayLine } from './cal.js';
import { personPicker, recentIds } from './picker.js';
import { FAVOR_BIG, estimatePrompt, cleanEstimate } from './renqing.js';
import { askJson } from './ai.js';
import { pushSupport, subscribe, currentSubscription, deviceName, PUSH_FILE } from './push.js';
import { weekOf, weekSummary, monthSummary, yearSummary } from './summary.js';
import { barChart, donut, lineChart } from './charts.js';
import { h, today, compressImage, blobToBase64 } from './util.js';
import { makeXlsx } from './xlsx.js';
import { icon } from './icons.js';
import { solarTerm, greeting } from './solar.js';
import { wordFor } from './words.js';
import { receiptPrompt, parseReceipt, guessCategory, groupByCategory, matchInventory, defaultInventoryAction, restockQty, applyToInventory, parseSpoken } from './receipt.js';
import { inventoryGitHub, readInventory, updateInventory } from './bridge.js';
import { readTable } from './sheet.js';
import { parseBill, matchBills, guessBillCategory, guessAccount, isPersonal, methodKey } from './bills.js';

const SETTINGS_KEY = 'ledger-settings';
const DEFAULT_REPO = 'ThreeLu/finance-data';
const RATE_KEY = 'ledger-usd-rate';
const LAST_KEY = 'ledger-last'; // 上次用的账户和类别，记账时默认选上
const EDITING_ROUTES = /^\/(add|reconcile|receipt|bills)/;

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
  store.onStatus = showSync;
  store.loadCached();
  showSync(store.status);
}

// 右上角的小标记：有没上传的修改时显示。上传很快的话不显示（免得一闪一闪）
const syncPill = h('button', { class: 'sync-pill', type: 'button', hidden: true, onclick: () => {
  if (store?.status.state === 'error') toast(`上传失败：${store.status.error}（记的账都还在手机上）`, 'error');
  store?.sync();
} });
let syncTimer = null;
let renderedData = '';
function showSync(st) {
  clearTimeout(syncTimer);
  const n = st.pending;
  const text = st.state === 'offline' ? `没网，${n} 项存在手机上，有网自动上传`
    : st.state === 'error' ? `${n} 项没传上去，点一下看看`
      : n ? `正在上传 ${n} 项` : '';
  const show = () => { syncPill.textContent = text; syncPill.hidden = !text; syncPill.className = `sync-pill ${st.state}`; };
  if (st.state === 'offline' || st.state === 'error' || !text) show();
  else syncTimer = setTimeout(show, 1500);
  // 传完以后，如果合并进了别的设备的修改，页面刷新一下（正在填的表单不动）
  if (st.state === 'ok' && store?.data && !EDITING_ROUTES.test(currentPath()) && JSON.stringify(store.data) !== renderedData) render();
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
  if (!loadError && store.data) { postRecurring(); checkMilestones(); }
}

// 新达到的里程碑记下来（日期），首页祝贺 7 天
function checkMilestones() {
  const list = newMilestones(store.data, today(), usdRate());
  if (!list.length) return;
  save(`里程碑：${list.map((x) => x.text).join('、')}`, (data) => {
    for (const x of list) data.milestones.reached[x.key] ??= { at: today(), text: x.text };
  }).then(() => { if (!EDITING_ROUTES.test(currentPath())) render(); }).catch(() => {});
}

function milestoneCard() {
  const m = store.data.milestones || {};
  const fresh = Object.entries(m.reached || {}).filter(([k, x]) => !m.seen?.[k] && daysSince(x.at) <= 7);
  if (!fresh.length) return null;
  const ok = () => save('里程碑：看到了', (data) => {
    data.milestones.seen = { ...(data.milestones.seen || {}), ...Object.fromEntries(fresh.map(([k]) => [k, true])) };
  }).then(render).catch(() => {});
  return h('div', { class: 'card milestone' },
    h('div', { class: 'milestone-icon' }, icon('sparkle')),
    h('div', { class: 'grow' },
      fresh.map(([, x]) => h('b', { class: 'block' }, x.text)),
      h('span', { class: 'muted small' }, '一步一步来，你做得很好。')),
    h('button', { class: 'small secondary', onclick: ok }, '好'));
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
    }, { online: true }); // 要在 GitHub 最新的数据上判断记没记过，两台设备才不会重复记
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
  document.body.append(syncPill);
  window.addEventListener('online', () => store?.sync());
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
    // 还没登录：记住要去的页面（比如快捷指令带来的小票），填好令牌后再跳过去
    if (window.location.hash && window.location.hash !== '#/settings') sessionStorage.setItem('ledger-after-login', window.location.hash);
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
  [/^\/receipt$/, (_, q) => receiptView(q)],
  [/^\/siri$/, () => siriView()],
  [/^\/bills$/, () => billsView()],
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
  [/^\/wishes$/, () => wishesView()],
  [/^\/ask$/, () => askView()],
  [/^\/tax$/, () => taxView()],
  [/^\/subs$/, () => subsView()],
  [/^\/goals$/, () => goalsView()],
  [/^\/budget$/, () => budgetView()],
  [/^\/rules$/, () => rulesView()],
  [/^\/quick$/, () => quickView()],
  [/^\/settings$/, () => settingsView()],
  [/^\/lost$/, () => lostView()],
];
const NAV_GROUPS = {
  '/': [/^\/?$/, /^\/ask/],
  '/list': [/^\/list/],
  '/summary': [/^\/summary/],
  '/more': [/^\/more/, /^\/lost/, /^\/receipt/, /^\/siri/, /^\/bills/, /^\/accounts?/, /^\/budget/, /^\/rules/, /^\/quick/, /^\/settings/, /^\/claims?/, /^\/people/, /^\/person/, /^\/reconcile/, /^\/wishes/, /^\/tax/, /^\/subs/, /^\/goals/],
};

function setupNav() {
  for (const a of nav.querySelectorAll('a[data-icon]')) a.prepend(h('span', { class: 'tab-icon' }, icon(a.dataset.icon)));
  nav.querySelector('.plus').append(h('span', { class: 'circle' }, icon('plus')));
}

// 每页最下面角落的一句话（花钱观）。记账、拍小票、设置这些专心做事的页面不放
const NO_WHISPER = /^\/(add|receipt|siri|settings|quick|lost)$/;
function whisper(path) {
  return h('div', { class: 'whisper' }, h('p', {}, wordFor(today(), path)), h('small', {}, '今天的一句'));
}
// 换页淡入只在真的换了页时
let lastPath = null;
// 点选（类别、账户这些标签）时轻轻弹一下：重画以后找到同一个、已选中的那个
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('.chip, [role="checkbox"]');
  if (!t) return;
  const text = t.textContent.trim();
  setTimeout(() => {
    const el = [...document.querySelectorAll('.chip.on, [role="checkbox"][aria-checked="true"]')].find((x) => x.textContent.trim() === text);
    if (!el) return;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }, 60);
}, true);

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
  view.replaceChildren(...[content || notFound(), store?.data && !NO_WHISPER.test(path) ? whisper(path) : null].filter(Boolean));
  if (path !== lastPath) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); lastPath = path; }
  document.documentElement.dataset.season = solarTerm(today()).season;
  renderedData = store?.data ? JSON.stringify(store.data) : '';
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
// 普通修改：先存手机、页面立刻更新、后台上传（不弹「正在保存」）；上传文件、删文件时要等 GitHub
async function save(message, fn, opts) {
  if (opts?.uploads?.length || opts?.removes?.length || opts?.online) return saving('正在保存…', () => store.save(message, fn, opts));
  try {
    return await store.save(message, fn, opts);
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  }
}

// 常用的操作不先问「确定吗」：直接做，底部提示几秒，点「撤销」改回去
function undoToast(text, onUndo) {
  for (const el of document.querySelectorAll('.toast.undo')) el.remove();
  const el = h('div', { class: 'toast undo', role: 'status' }, h('span', {}, text),
    h('button', { type: 'button', class: 'toast-undo', onclick: () => { el.remove(); onUndo(); } }, '撤销'));
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

// 能撤销的修改：撤销时只把这次改到的东西改回去，这期间别的修改不受影响
async function saveUndoable(message, fn, doneText) {
  const before = structuredClone(store.data);
  const result = await save(message, fn);
  if (result === false) return result;
  const back = diff(store.data, before);
  undoToast(doneText, () => save(`撤销：${message}`, (data) => { applyPatch(data, back); }).then(() => { toast('已撤销'); render(); }).catch(() => {}));
  return result;
}

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
  summer: (x) => [
    '暑假那两个预算月没有收入，生活费要从存钱卡里拿出来。',
    '这笔钱是平时每月一点点留好的（「存款目标」里的暑假生活费），花它是计划内的，不是在「吃老本」。',
    `${x.action}`,
  ],
  tax: (x) => [
    '兼职发钱时，单位一般会先预扣 20% 左右的个税。但个税按一整年算，学生一年的应税收入通常不高，多扣的可以在第二年 3 月 1 日到 6 月 30 日申请退回。',
    '这是你自己的钱，不办就白白放弃了；整个过程在手机上十几分钟就能办完。',
    `${x.action}`,
  ],
  subs: (x) => [
    '订阅体检：每 3 个月看一眼所有自动扣费的订阅，问问每个还值不值。',
    '订阅是自动扣的，最容易被忘掉；一年加起来往往比想的多。',
    `${x.action}`,
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
  ['这个月还能花', ['生活预算（吃饭 + 日常 + 自由钱 + 形象）减去这个预算月已经花的，精确到分。「每天约」= 还能花的 ÷ 剩下的天数。', '圆环是预算用了多少；下面那条是这个预算月过了多少天，竖线是钱用到哪了：竖线在紫色里面，说明花得比日子慢。', '预算月从每月 15 号开始，到下个月 14 号，和发钱对齐。开始记账那个月预算按天数折算。']],
  ['健康指标', ['每一格一个小圆环：绿 = 很好，黄 = 留意一下，红 = 需要做点什么。', '圆环有多满：安全垫按 3 个月算满，应急钱按底线算满，花钱节奏是生活预算用了多少（小白点是按日子该用到哪），本月存钱是离目标多近。其他的只看颜色。', '每一格都能点开，看它是什么、为什么重要、你现在怎么样。']],
  ['记账', ['点底部中间的 ＋ 记一笔。卡之间倒钱（充校园卡、存钱卡转生活费卡）记「转账」，不算花销。']],
  ['总结', ['底部「总结」看每周、每个预算月的图表。']],
  ['里程碑', ['总资产第一次超过 2 万、3 万、5 万……，或者连续几个月存钱达标，首页会出现一张祝贺卡片。']],
  ['买不买', ['想买东西拿不准，点「想买个东西？问问买不买」。理财小课堂也在那里。']],
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

// 发钱日一条龙：收入到了点一下记上，再点一下把这个月的生活费从存钱卡转出来
function paydayCard() {
  const d = store.data;
  const t = today();
  const pd = payday(d, t);
  if (!pd.waiting.length && !pd.transfer) return null;
  const floor = d.settings.floorAccount;
  const later = (i) => save('发钱日：晚点再问', (data) => {
    const day = data.payday[pd.p.start] ||= {};
    day.later = { ...(day.later || {}), [i]: t };
  }).then(render).catch(() => {});
  const arrived = (x) => moneySheet({
    title: `${x.plan.name}的钱到了`, amount: x.plan.amount, account: x.plan.account || floor, accountLabel: '到了哪个账户',
    hint: '金额和计划不一样就改一下。',
    onSave: (f) => save(`收入：${x.plan.name} ${f.amount}`, (data) => {
      data.tx.push({ id: newId('t'), type: 'income', date: f.date, account: f.account, amount: f.amount, category: x.category, note: f.note, createdAt: new Date().toISOString() });
    }).then(() => toast(`记好了：${x.plan.name} ${money(f.amount)}`)),
  });
  const move = (route) => {
    const amt = h('input', { inputmode: 'decimal', value: String(pd.transfer.amount), 'aria-label': '转多少' });
    openSheet({
      title: `${accName(route.from)} → ${accName(route.to)}`,
      body: h('div', { class: 'form' }, h('label', {}, '转多少', amt),
        h('p', { class: 'muted small' }, `默认是这个月吃饭 + 日常 + 自由钱的预算。分两张卡的话，先转一部分，再点另一张卡转剩下的。`)),
      confirmText: '转好了',
      onConfirm: async () => {
        const n = round2(Number(amt.value.replace(/[，,\s]/g, '')));
        if (!(n > 0)) { toast('填一下转多少', 'error'); return false; }
        try {
          await save(`转生活费：${accName(route.from)} → ${accName(route.to)} ${n}`, (data) => {
            data.tx.push({ id: newId('t'), type: 'transfer', date: t, account: route.from, to: route.to, amount: n, note: '这个月的生活费', createdAt: new Date().toISOString() });
          });
          toast(`记好了：转生活费 ${money(n)}`);
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const skip = () => save('发钱日：这个月不用转生活费', (data) => { (data.payday[pd.p.start] ||= {}).noTransfer = true; }).then(render).catch(() => {});
  return h('div', { class: 'card payday' },
    h('h3', {}, pd.transfer?.summer ? '暑假生活费' : '发钱日'),
    pd.waiting.map((x) => h('div', { class: 'payday-row' },
      h('span', { class: 'grow' }, h('b', {}, `${x.plan.name}的 ${money(x.plan.amount)} 到了吗？`), x.plan.when ? h('span', { class: 'muted small' }, x.plan.when) : null),
      h('button', { class: 'small', onclick: () => arrived(x) }, '到了'),
      h('button', { class: 'small secondary', onclick: () => later(x.i) }, '还没'))),
    pd.transfer ? h('div', { class: 'payday-row column' },
      h('span', { class: 'grow' },
        h('b', {}, pd.transfer.summer ? `暑假没有收入：从${accName(floor)}转这个月的生活费 ${money(pd.transfer.amount)}` : `从${accName(floor)}转这个月的生活费 ${money(pd.transfer.amount)}`),
        h('span', { class: 'muted small' }, pd.transfer.summer ? '这是早就留好的钱，放心用。' : '先存后花：剩下的留在存钱卡里不动。'),
        h('span', { class: 'routes' },
          pd.transfer.routes.map((r) => h('button', { class: 'small', onclick: () => move(r) }, `转到${accName(r.to)}`)),
          h('button', { class: 'small secondary', onclick: skip }, '这个月不用')))) : null);
}

// 令牌到期：账本和物品档案共用一个令牌，到期日填在物品档案的设置里
function tokenNotice() {
  let exp = '';
  try { exp = (JSON.parse(localStorage.getItem('inventory-settings')) || {}).tokenExpires || ''; } catch { /* 没有 */ }
  if (!exp) return null;
  const left = Math.round((new Date(exp.replace(/-/g, '/')) - new Date(today().replace(/-/g, '/'))) / 86400000);
  if (left > 14) return null;
  return h('a', { class: 'banner warn token-banner', href: '/inventory/#/settings' },
    left < 0 ? 'GitHub 令牌已经过期了，账本和物品档案都打不开，点这里去换新的' : `GitHub 令牌还有 ${left} 天过期（账本和物品档案共用），点这里去续期`);
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
    homeHeader(p),
    tokenNotice(),
    h('div', { class: `summary ${hl.level}` }, h('div', { class: 'summary-title' }, hd.title), h('div', { class: 'summary-text' }, hd.text)),
    milestoneCard(),
    paydayCard(),
    favorHolidayCard(),
    socialCard({ compact: true }),
    spendLeftCard(hl, st),
    h('a', { class: 'ask-field', href: '#/ask' }, icon('sparkle'), '想买个东西？问问买不买……'),
    h('div', { class: 'section-title' }, '健康指标', h('span', { class: 'muted' }, ' · 点一下看解释')),
    h('div', { class: 'health-grid' }, hl.items.map((x) => healthTile(x, hl))),
    summaryLinks(p),
    budgetAdvice(d, today(), usdRate()).items.length ? h('div', { class: 'group' }, cell({ href: '#/budget', ic: 'chart', color: 'var(--amber)',
      title: `预算有 ${budgetAdvice(d, today(), usdRate()).items.length} 条调整建议`, sub: '根据你最近几个月实际的花销' })) : null,
    flowCard(st, part),
    budgetCard(st, part),
    recent.length ? [h('div', { class: 'section-title' }, '最近记的'), h('div', { class: 'card tx-list' }, recent.map((t) => txRow(t))),
      h('p', { class: 'center' }, h('a', { href: '#/list' }, '全部流水'))]
      : h('div', { class: 'card' }, h('p', {}, '还没有记账。点底部中间的 ＋ 记第一笔。')),
    h('p', { class: 'center small' }, h('a', { href: '#/rules' }, '我们的花钱方式 →')));
}

// 首页开头：日期 → 问候（宋体）→ 这个预算月第几天、离发工资还有几天
function homeHeader(p) {
  const d = new Date();
  const t = today();
  const toPay = Math.round((new Date(`${p.next}T00:00:00`) - new Date(`${t}T00:00:00`)) / 86400000);
  return h('header', { class: 'page-head today-head' },
    h('div', {},
      h('div', { class: 'sub' }, `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`),
      h('h1', { class: 'greet' }, greeting(d)),
      h('div', { class: 'head-tags' },
        h('span', { class: 'tag' }, `${p.startMonth} 月预算 · 第 ${p.dayIndex} 天`),
        !p.summer && toPay > 0 ? h('span', { class: 'tag' }, `离发工资还有 ${toPay} 天`) : null)),
    h('div', { class: 'head-actions' }, helpButton('首页怎么看', HOME_HELP)));
}
// 精确到分：首页「还能花」「每天约」用它（用户 2026-10-06 要的，不四舍五入到元）
const cents = (n) => `${n < 0 ? '−' : ''}¥${Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 这个月还能花：左边圆环是生活预算用了多少（超了变红），右边是精确的还能花多少；下面一条是预算月过了多少天，和圆环比一比快慢
function spendLeftCard(hl, st) {
  const lb = hl.left + st.living;
  const used = lb > 0 ? Math.min(100, Math.max(0, (st.living / lb) * 100)) : 0;
  const over = hl.left < 0;
  const p = hl.period;
  const part = partial(store.data, p);
  const timePct = Math.min(100, (p.dayIndex / p.days) * 100);
  const [yuan, fen] = cents(Math.abs(hl.left)).replace('¥', '').split('.');
  return h('div', { class: 'card spend-left hero' },
    h('div', { class: 'hero-top' },
      lb > 0 ? h('div', { class: `ring big${over ? ' over' : ''}`, style: `--v:${over ? 100 : used.toFixed(1)}%`, 'aria-label': `生活预算用了 ${Math.round(used)}%` },
        h('div', {}, h('b', {}, `${Math.round(used)}%`), '用了')) : null,
      h('div', { class: 'spend-text' },
        h('div', { class: 'muted small' }, over ? '这个月超了' : '这个月还能花'),
        h('div', { class: `big-num exact${over ? ' warn-text' : ''}` }, h('span', { class: 'cur' }, '¥'), yuan, h('span', { class: 'fen' }, `.${fen}`)),
        h('div', { class: 'muted small' }, hl.left > 0 ? `剩 ${hl.daysLeft} 天 · 每天约 ${cents(hl.perDay)}` : `剩 ${hl.daysLeft} 天`))),
    h('div', { class: 'time-bar', 'aria-label': `预算月过了 ${Math.round(timePct)}%` },
      h('div', { class: 'time-track' }, h('span', { class: 'time-fill', style: `width:${timePct.toFixed(1)}%` }), h('span', { class: 'spend-mark', style: `left:${Math.min(100, used).toFixed(1)}%` })),
      h('div', { class: 'time-legend muted small' },
        h('span', {}, `第 ${p.dayIndex} / ${p.days} 天`),
        h('span', {}, used <= timePct ? '花得比日子慢 ✓' : '花得比日子快'))),
    h('div', { class: 'hero-foot muted small' }, `生活预算 ${cents(lb)}，已花 ${cents(st.living)}${part.isPartial ? `（从 ${md(part.from)}开始记账，这个月预算按 ${part.days} 天折算）` : ''}`));
}

// 健康指标的一格：小圆环（按好 / 留意 / 要处理上色），中间一个短数字，右边名字和一句话
const LEVEL_COLOR = { good: 'var(--sage)', warn: 'var(--amber)', bad: 'var(--danger)' };
function healthTile(x, hl) {
  const g = x.gauge == null ? 1 : x.gauge;
  const short = x.short ?? (x.level === 'good' ? '✓' : '!');
  return h('button', { type: 'button', class: `health-tile ${x.level}${x.key === 'charges' ? ' wide' : ''}`, // 即将扣款字多，占一整行 onclick: () => openExplain(x, hl), 'aria-label': `${x.name}：${LEVEL_TEXT[x.level]}，${x.text}` },
    h('span', { class: `ring mini${x.gauge == null ? ' solid' : ''}`, style: `--v:${(g * 100).toFixed(1)}%;--c:${LEVEL_COLOR[x.level]}` },
      x.mark != null ? h('i', { class: 'ring-mark', style: `--m:${(x.mark * 360).toFixed(1)}deg` }) : null,
      h('span', { class: 'ring-in' }, h('b', { class: String(short).length > 4 ? 'long' : '' }, short), x.unit && x.short != null ? h('small', {}, x.unit) : null)),
    h('span', { class: 'tile-text' },
      h('span', { class: 'tile-name' }, x.name),
      h('span', { class: 'tile-sub muted' }, x.text)));
}

const txOrder = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '');

const personName = (id) => store.data.people.find((p) => p.id === id)?.name || '某人';
// 选人用：最近和谁有来往（钱、礼、人情）
const recentPeople = (d) => recentIds([...d.tx.filter((t) => t.person || t.who).map((t) => ({ id: t.person || t.who, day: t.date })), ...d.favors.map((f) => ({ id: f.person, day: f.date }))]);
const claimName = (id) => store.data.claims.find((c) => c.id === id)?.name || '垫付';

function txTitle(t) {
  switch (t.type) {
    case 'transfer': return `转账 ${accName(t.account)} → ${accName(t.to)}`;
    case 'adjust': return '对账差额';
    case 'advance': return t.claim ? `垫付 · ${claimName(t.claim)}` : `帮${personName(t.person)}付 / 借给他`;
    case 'repay': return t.claim ? `报销到账 · ${claimName(t.claim)}` : `${personName(t.person)}还我`;
    case 'payback': return `还给${personName(t.person)}`;
    case 'writeoff': return `${catName(t.category)} · ${claimName(t.claim)}`;
    default: {
      const name = t.what || catName(t.category); // 「其他」显示自己写的名字
      const w = t.who ? (t.type === 'income' ? ` · ${personName(t.who)}给的` : ` · 给${personName(t.who)}`) : '';
      return t.person && !t.account ? `${name}（${personName(t.person)}代付）${w}` : name + w;
    }
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
  const tag = { advance: '不算花销', repay: '不算收入', payback: '不算花销' }[t.type] || (t.what ? catName(t.category) : null) || (t.tax ? `被扣个税 ${exact(t.tax)}` : null);
  return h('a', { class: 'tx', href: onclick ? '#' : txHref(t), onclick: onclick ? (e) => { e.preventDefault(); onclick(); } : null },
    h('span', { class: 'grow' }, txTitle(t),
      h('span', { class: 'muted small block' }, [t.date.slice(5).replace('-', '/'), where, tag, t.note].filter(Boolean).join(' · '))),
    h('span', { class: `tx-amt ${cls}` }, amount,
      usd && t.cny ? h('span', { class: 'muted small block' }, `≈${exact(t.cny)}`) : null));
}

// ---------- 记一笔 ----------

const AUTO_CATEGORIES = ['c-wish', 'c-trip'];
const FREEFORM = ['c-other']; // 选这些类别时要写一下具体是什么（往往是大额的、不好归类的东西）

// 最近记过的几个支出类别（记账页最上面一排）
function recentCategories(d, usable, n = 6) {
  const ok = new Set(usable.map((c) => c.id));
  const out = [];
  for (const t of [...d.tx].sort(txOrder)) {
    if (t.type !== 'expense' || !ok.has(t.category) || out.includes(t.category)) continue;
    out.push(t.category);
    if (out.length >= n) break;
  }
  return out.map((id) => category(d, id));
}

const ADD_HELP = [
  ['三种账', ['支出：花出去的钱，算进预算。', '收入：生活费、补助、兼职、红包。', '转账：自己的账户之间倒钱（充校园卡、充 Apple ID、存钱卡转生活费卡），不算收入也不算花销，只是换了个口袋。']],
  ['怎么记', ['填金额 → 点类别 → 点账户 → 记好了。账户默认是你上次用的。', '选好类别后，下面会显示上次花了多少、最近几次平均多少；这次明显贵或便宜也会说一声。', '用支付宝、微信绑卡付的钱，记在实际扣钱的那张卡上。', '常记的（比如食堂午饭 15）勾上「存成快捷」，以后在上面一点就记好。']],
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
    sub: category(d, editing.category)?.sub || null, what: editing.what || '', tax: editing.tax != null ? String(editing.tax) : '', favor: editing.favor || '', who: editing.who || '',
  } : {
    type: q.type || 'expense', amount: q.amount || '', account: q.account || last.account || 'a-wechat', to: '', toAmount: '',
    category: '', date: today(), note: q.note || '', split: 'none', person: '', sub: null, what: '', tax: '', favor: '', who: '',
  };
  // 从「这次要还的人情」点进来：类别先选聚餐请客，人情先选上
  if (!editing && q.favor && d.favors.some((f) => f.id === q.favor && f.status !== 'done')) {
    st.favor = q.favor; st.who = d.favors.find((f) => f.id === q.favor).person; st.category = 'c-social'; st.sub = category(d, 'c-social')?.sub || null;
  }
  if (!account(d, st.account)) st.account = firstCny;
  // Siri / 快捷指令带来的一句话：「午饭 18」→ 金额、类别、备注先填好，还是要点「记好了」
  const heard = !editing && q.text ? q.text.trim() : '';
  if (heard) {
    const sp = parseSpoken(heard, d.categories.filter((c) => c.kind === 'expense' && !c.hidden && !AUTO_CATEGORIES.includes(c.id)), { quick: d.quick, tx: d.tx });
    if (sp.amount) st.amount = String(sp.amount);
    if (sp.category) { st.category = sp.category; st.sub = category(d, sp.category)?.sub || null; }
    if (sp.note && sp.note !== catName(sp.category)) st.note = sp.note;
  }
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
    oninput: (e) => { st.amount = e.target.value; drawHint(); syncTo(); drawSplit(); drawMemo(); } });
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
        // 心愿、出差自付由心愿单和垫付自动记，不在这里选；老版本的类别不再出现（正在改的那笔除外）
        const usable = cats.filter((c) => (!c.hidden && !AUTO_CATEGORIES.includes(c.id)) || c.id === st.category);
        const pickCat = (id) => {
          st.category = id;
          st.sub = category(d, id)?.sub || st.sub;
          draw();
          if (FREEFORM.includes(id) && !whatInput.value) whatInput.focus();
        };
        const recent = recentCategories(d, usable);
        if (recent.length) parts.push(h('div', { class: 'label-sm' }, '最近用过'), chips(recent, st.category, pickCat, '最近用过的类别'));
        parts.push(h('div', { class: 'label-sm' }, '类别'));
        for (const g of GROUPS) {
          const list = usable.filter((c) => c.group === g.id);
          if (!list.length) continue;
          const subs = [...new Set(list.map((c) => c.sub).filter(Boolean))];
          let body;
          if (subs.length > 1) {
            // 日常类别多：先点小组（日用消耗、家居用品、耗材……），再点具体的
            const open = subs.includes(st.sub) ? st.sub : null;
            body = h('div', { class: 'grow' },
              h('div', { class: 'chips subs', role: 'group', 'aria-label': `${g.name}小组` }, subs.map((x) => h('button', {
                type: 'button', class: `chip sub-chip${x === open ? ' on' : ''}${category(d, st.category)?.sub === x ? ' has' : ''}`, 'aria-pressed': String(x === open),
                onclick: () => { st.sub = st.sub === x ? null : x; draw(); },
              }, x))),
              open ? chips(list.filter((c) => c.sub === open), st.category, pickCat, `${open}类别`) : null);
          } else body = chips(list, st.category, pickCat, `${g.name}类别`);
          parts.push(h('div', { class: 'cat-group' }, h('span', { class: 'cat-group-name', style: `color:${g.color}` }, g.name), body));
        }
        drawMemo();
        if (FREEFORM.includes(st.category)) {
          parts.push(h('label', { class: 'form-label' }, '具体是什么', whatInput));
        }
        parts.push(...favorSection(), ...whoSection());
      } else {
        parts.push(h('div', { class: 'label-sm' }, '来源'), chips(cats, st.category, (id) => { st.category = id; draw(); }, '收入来源'));
        parts.push(...whoSection());
        if (st.category === 'i-job') {
          parts.push(h('label', { class: 'form-label' }, '被预扣的个税（选填）', taxInput),
            h('p', { class: 'muted small' }, '金额填到手的钱。单位先扣了个税的话填在这里（看工资条或到账短信），每年 3～6 月会提醒你申请退回来。'));
        }
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
      h('input', { placeholder: '备注（选填）', value: st.note, 'aria-label': '备注', oninput: (e) => { st.note = e.target.value; drawMemo(); } })));
    if (st.type === 'expense' && !editing) {
      parts.push(h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', checked: saveQuick, onchange: (e) => { saveQuick = e.target.checked; } }), '存成快捷，下次一点就记'));
    }
    parts.push(h('div', { class: 'actions sticky' },
      st.type === 'expense' ? memo : null, // 上次的价格：放在按钮上面，点之前正好看到
      h('button', { onclick: submit }, editing ? '保存' : '记好了'),
      editing ? h('button', { class: 'danger', onclick: remove }, '删除') : null));
    box.replaceChildren(...parts);
    drawHint();
  };

  // 请客、礼物、红包：可以对上「还的是谁的哪个人情」，记好了那个人情就算还上了
  const favorSection = () => {
    if (!FAVOR_CATEGORIES.includes(st.category) || st.split === 'paidby') { st.favor = ''; return []; }
    const list = d.favors.filter((f) => f.dir === 'owe' && (f.status !== 'done' || f.id === editing?.favor));
    if (!list.length) return [];
    return [h('div', { class: 'label-sm' }, '还的是哪个人情（选填）'),
      h('div', { class: 'chips favor-chips', role: 'group', 'aria-label': '还的人情' }, list.map((f) => h('button', {
        type: 'button', class: `chip${st.favor === f.id ? ' on' : ''}`, 'aria-pressed': String(st.favor === f.id),
        onclick: () => { st.favor = st.favor === f.id ? '' : f.id; if (st.favor) st.who = f.person; draw(); },
      }, `${personName(f.person)} · ${f.text}`)))];
  };
  // 礼尚往来：送礼、红包、请客「给谁的」，收到的红包礼金「谁给的」
  const whoSection = () => {
    const ok = st.type === 'expense' ? FAVOR_CATEGORIES.includes(st.category) && st.split !== 'paidby' : GIFT_IN.includes(st.category);
    if (!ok) { st.who = ''; return []; }
    const label = st.type === 'expense' ? '给谁的' : '谁给的';
    return [h('div', { class: 'label-sm' }, `${label}（选填，记进礼尚往来）`),
      personPicker({ people: [...d.people, ...aa.newPeople], value: st.who ? [st.who] : [], label, recent: recentPeople(d),
        onNew: (name) => { const p = { id: newId('p'), name }; aa.newPeople.push(p); return p; }, onChange: (v) => { st.who = v; } })];
  };
  // 记好以后：选上的人情算还了，换掉的那个重新算没还
  const settleFavor = (data, txId, oldFavor, date) => {
    if (oldFavor && oldFavor !== st.favor) {
      const o = data.favors.find((f) => f.id === oldFavor);
      if (o && o.doneTx === txId) { o.status = 'open'; delete o.doneAt; delete o.doneTx; }
    }
    const f = st.favor && data.favors.find((x) => x.id === st.favor);
    if (f) Object.assign(f, { status: 'done', doneAt: date, doneTx: txId });
  };

  const splitSection = () => {
    const out = [h('div', { class: 'label-sm' }, '和别人有关吗'),
      chips([{ id: 'none', name: '没有' }, { id: 'aa', name: 'AA / 帮人付' }, { id: 'paidby', name: '别人帮我付的' }].filter((x) => !editing || x.id !== 'aa'),
        st.split, (id) => { st.split = id; draw(); }, '和别人有关')];
    if (st.split === 'none') return out;
    const multi = st.split === 'aa';
    const onNew = (name) => { const p = { id: newId('p'), name }; aa.newPeople.push(p); return p; };
    out.push(personPicker({
      people: [...d.people, ...aa.newPeople], value: multi ? [...aa.people] : st.person ? [st.person] : [], multi, label: multi ? '和谁 AA' : '谁帮我付的',
      recent: recentPeople(d), onNew,
      onChange: (v) => { if (multi) { aa.people = new Set(v); drawSplit(); } else st.person = v; },
    }));
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
    if (my > 0 && FREEFORM.includes(st.category) && !st.what.trim()) return toast('写一下具体是什么', 'error');
    const others = round2(n - my);
    const each = Math.floor((others / ids.length) * 100) / 100;
    const usd = isUsd(d, st.account);
    const rate = usdRate();
    const g = newId('g');
    const now = new Date().toISOString();
    const note = st.note.trim();
    try {
      await save(`AA：${st.category ? catName(st.category) : '帮人付'} ${n}`, (data) => {
        for (const p of aa.newPeople) if ((ids.includes(p.id) || p.id === st.who) && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
        if (my > 0) {
          const tid = newId('t');
          data.tx.push({ id: tid, type: 'expense', date: st.date, account: st.account, amount: my, category: st.category, note,
            ...(FREEFORM.includes(st.category) ? { what: st.what.trim() } : {}), ...(st.favor ? { favor: st.favor } : {}), ...(st.who ? { who: st.who } : {}),
            group: g, createdAt: now, ...(usd ? { cny: round2(my * rate) } : {}) });
          settleFavor(data, tid, '', st.date);
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

  const taxInput = h('input', { inputmode: 'decimal', placeholder: '没扣就不填', 'aria-label': '被预扣的个税', value: st.tax,
    oninput: (e) => { st.tax = e.target.value; } });
  // 上次同一类花了多少：选好类别就显示，帮你建立价格感
  const memo = h('p', { class: 'muted small price-memo' });
  const drawMemo = () => {
    memo.textContent = '';
    if (st.type !== 'expense' || !st.category || AUTO_CATEGORIES.includes(st.category)) return;
    let past = d.tx.filter((t) => t.type === 'expense' && t.category === st.category && t.id !== editing?.id
      && (!FREEFORM.includes(st.category) || !st.what.trim() || (t.what || '').includes(st.what.trim())));
    const note = st.note.trim();
    if (note && past.some((t) => t.note === note)) past = past.filter((t) => t.note === note);
    if (!past.length) return;
    past.sort(txOrder);
    const last = past[0];
    const recent = past.slice(0, 5);
    const avg = recent.reduce((a, t) => a + cny(t), 0) / recent.length;
    const name = last.what || (note && last.note === note ? note : catName(st.category));
    const n = num(st.amount);
    const cmp = n > 0 && recent.length >= 3 ? (n > avg * 1.3 ? '，这次比平时贵一些' : n < avg * 0.7 ? '，这次比平时便宜' : '') : '';
    memo.textContent = `上次${name} ${exact(cny(last))}（${md(last.date)}）${recent.length >= 3 ? `，最近 ${recent.length} 次平均 ${exact(round2(avg))}` : ''}${cmp}`;
  };
  const whatInput = h('input', { class: 'what-input', placeholder: '写一下是什么，比如 自行车、体检费', 'aria-label': '具体是什么', value: st.what,
    oninput: (e) => { st.what = e.target.value; drawMemo(); } });

  const recordQuick = async (qk) => {
    const usd = isUsd(d, qk.account);
    try {
      await save(`记账：${qk.name} ${qk.amount}`, (data) => {
        data.tx.push({ id: newId('t'), type: 'expense', date: today(), account: qk.account, amount: qk.amount, category: qk.category,
          note: qk.name, ...(qk.what ? { what: qk.what } : {}), createdAt: new Date().toISOString(), ...(usd ? { cny: round2(qk.amount * usdRate()) } : {}) });
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
    if (st.type === 'expense' && FREEFORM.includes(st.category) && !st.what.trim()) return toast('写一下具体是什么', 'error');
    if (st.type === 'transfer' && !st.to) return toast('选一下转到哪个账户', 'error');
    const usd = isUsd(d, st.account);
    const rec = { type: st.type, date: st.date, account: st.account, amount: st.type === 'adjust' ? num(st.amount) : n, note: st.note.trim() };
    if (st.type === 'expense' || st.type === 'income') {
      rec.category = st.category;
      if (usd) rec.cny = round2(n * usdRate());
      if (st.type === 'expense' && FREEFORM.includes(st.category)) rec.what = st.what.trim();
      const tax = round2(num(st.tax) || 0);
      if (st.type === 'income' && st.category === 'i-job' && tax > 0) rec.tax = tax;
      if (st.type === 'expense' && st.favor) rec.favor = st.favor;
      if (st.who) rec.who = st.who;
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
          for (const p of aa.newPeople) if ((p.id === rec.person || p.id === rec.who) && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
          if (!rec.to) { delete data.tx[i].to; delete data.tx[i].toAmount; }
          if (!rec.what) delete data.tx[i].what;
          if (!rec.tax) delete data.tx[i].tax;
          if (!rec.favor) delete data.tx[i].favor;
          if (!rec.who) delete data.tx[i].who;
          settleFavor(data, editing.id, editing.favor, rec.date);
        } else {
          for (const p of aa.newPeople) if ((p.id === rec.person || p.id === rec.who) && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
          const tid = newId('t');
          data.tx.push({ id: tid, ...rec, createdAt: new Date().toISOString() });
          settleFavor(data, tid, '', rec.date);
          if (st.type === 'transfer' && f > 0) {
            data.tx.push({ id: newId('t'), type: 'expense', date: st.date, account: st.account, amount: f, category: 'c-fee',
              note: `${title} 的手续费`, createdAt: new Date().toISOString(), ...(usd ? { cny: round2(f * usdRate()) } : {}) });
          }
          if (saveQuick && !paidBy) {
            data.quick.push({ id: newId('q'), name: rec.note || rec.what || catName(rec.category), amount: n, category: rec.category, account: rec.account, ...(rec.what ? { what: rec.what } : {}) });
          }
        }
      });
      if (!editing) writeJson(LAST_KEY, { account: st.type === 'transfer' || paidBy ? last.account : st.account });
      const jobShare = !editing && st.type === 'income' && st.category === 'i-job' && d.settings.sideIncomeSave != null ? round2(n * (1 - d.settings.sideIncomeSave)) : 0;
      toast(editing ? '已保存' : `已记：${title} ${exact(n, curOf(st.account))}${paidBy ? `（${personName(st.person) || '他'}代付）` : ''}${jobShare ? `，其中 ${money(jobShare)} 进了心愿基金` : ''}`);
      if (editing) history.back(); else go('#/', true);
    } catch { /* 已提示 */ }
  };

  const remove = async () => {
    const group = editing.group ? d.tx.filter((t) => t.group === editing.group) : [];
    const extra = group.length > 1;
    try {
      await saveUndoable(`删除：${txTitle(editing)} ${editing.amount}`, (data) => {
        const gone = data.tx.filter((t) => t.id === editing.id || (editing.group && t.group === editing.group)).map((t) => t.id);
        for (const f of data.favors) if (gone.includes(f.doneTx)) { f.status = 'open'; delete f.doneAt; delete f.doneTx; } // 还人情的那笔删了，人情回到没还
        data.tx = data.tx.filter((t) => t.id !== editing.id && !(editing.group && t.group === editing.group));
      }, `删掉了：${txTitle(editing)} ${exact(editing.amount, curOf(editing.account))}${extra ? `（连同 AA 的 ${group.length - 1} 笔）` : ''}`);
      history.back();
    } catch { /* 已提示 */ }
  };

  draw();
  setTimeout(() => { if (!editing && !heard) amountInput.focus(); });
  return h('div', {}, header(editing ? '改一笔' : '记一笔', helpButton('怎么记账', ADD_HELP)),
    heard ? h('p', { class: 'muted small heard' }, `听到：「${heard}」${st.amount && st.category ? '，看一眼对不对，点「记好了」' : '，没填上的补一下'}`) : null,
    !editing && !heard ? h('a', { class: 'receipt-link', href: '#/receipt' }, icon('receipt'), ' 有小票？一次导入一整张') : null,
    box);
}

// ---------- 流水 ----------

const LIST_HELP = [
  ['看什么', ['按预算月（15 号到下个月 14 号）列出每一笔，左右箭头翻月份。', '点上面的账户只看那个账户的。']],
  ['搜索和筛选', ['搜索框里打字，会在全部时间里找：备注、名称、类别、账户、人名、金额都能搜，空格隔开可以同时满足几个词（比如「理发 25」）。', '类别可以选一个，也可以选一整组（比如「吃饭（整组）」）。上面会显示找到几笔、一共花了多少。']],
  ['改和删', ['点任何一笔就能改或删。', '「（自动）」的是固定扣费，到日子网站自己记的。']],
];

// 流水：默认按预算月看；搜索时看全部时间。类别可以选一个类别，也可以选一整组（吃饭、日常……）
const listFilter = { text: '', cat: '' }; // 换页回来还记得

function txHaystack(t) {
  return [txTitle(t), t.note, t.what, t.category ? catName(t.category) : '', t.account ? accName(t.account) : '', t.to ? accName(t.to) : '',
    t.person ? personName(t.person) : '', t.claim ? claimName(t.claim) : '', String(t.amount), t.date].filter(Boolean).join(' ').toLowerCase();
}

function listView(q) {
  const d = store.data;
  const p = periodFor(d, q.day || today());
  const accFilter = q.account || '';
  const link = (day, acc) => `#/list?day=${day}${acc ? `&account=${acc}` : ''}`;
  const prev = shiftPeriod(d, p, -1);
  const next = shiftPeriod(d, p, 1);
  const results = h('div', {});
  const summary = h('div', { class: 'muted small' });
  const periodBox = h('div', {});

  const catOk = (t) => {
    if (!listFilter.cat) return true;
    if (listFilter.cat.startsWith('g:')) return t.category && (category(d, t.category)?.group || 'daily') === listFilter.cat.slice(2);
    return t.category === listFilter.cat;
  };
  const draw = () => {
    const words = listFilter.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const searching = words.length > 0;
    const tx = d.tx.filter((t) => (searching || (t.date >= p.start && t.date <= p.end))
      && (!accFilter || t.account === accFilter || t.to === accFilter) && catOk(t)
      && (!searching || words.every((w) => txHaystack(t).includes(w)))).sort(txOrder);
    const spend = tx.filter((t) => t.type === 'expense' || t.type === 'writeoff').reduce((a, t) => a + cny(t), 0);
    const income = tx.filter((t) => t.type === 'income').reduce((a, t) => a + cny(t), 0);
    periodBox.hidden = searching;
    summary.textContent = searching || listFilter.cat
      ? `${searching ? '全部时间里' : '这个预算月'}找到 ${tx.length} 笔${spend ? ` · 支出 ${money(spend)}` : ''}${income ? ` · 收入 ${money(income)}` : ''}`
      : '';
    const byDay = [];
    for (const t of tx) {
      if (!byDay.length || byDay.at(-1).date !== t.date) byDay.push({ date: t.date, list: [] });
      byDay.at(-1).list.push(t);
    }
    results.replaceChildren(...(byDay.length ? byDay.flatMap((g) => [
      h('div', { class: 'section-title' }, `${searching && g.date.slice(0, 4) !== today().slice(0, 4) ? `${g.date.slice(0, 4)} 年` : ''}${md(g.date)} 周${'日一二三四五六'[new Date(g.date.replace(/-/g, '/')).getDay()]}`),
      h('div', { class: 'card tx-list' }, g.list.map((t) => txRow(t)))])
      : [h('div', { class: 'card' }, h('p', { class: 'muted' }, searching || listFilter.cat ? '没有找到。' : '这个预算月还没有记账。'))]));
  };
  const st = periodStats(d, p);
  const search = h('input', { type: 'search', placeholder: '搜：理发、打印、25、小王……', 'aria-label': '搜索流水', value: listFilter.text,
    oninput: (e) => { listFilter.text = e.target.value; draw(); } });
  const catSelect = h('select', { 'aria-label': '按类别筛选', value: listFilter.cat, onchange: (e) => { listFilter.cat = e.target.value; draw(); } },
    h('option', { value: '' }, '全部类别'),
    GROUPS.map((g) => {
      const cats = d.categories.filter((c) => c.kind === 'expense' && c.group === g.id && (!c.hidden || d.tx.some((t) => t.category === c.id)));
      return cats.length ? h('optgroup', { label: g.name }, h('option', { value: `g:${g.id}` }, `${g.name}（整组）`), cats.map((c) => h('option', { value: c.id }, c.name))) : null;
    }),
    h('optgroup', { label: '收入' }, d.categories.filter((c) => c.kind === 'income').map((c) => h('option', { value: c.id }, c.name))));
  periodBox.append(
    h('div', { class: 'period-nav' },
      h('a', { class: 'icon-btn', href: link(prev.start, accFilter), 'aria-label': '上个月' }, '‹'),
      h('div', { class: 'grow center' }, h('b', {}, p.label), h('div', { class: 'muted small' }, `支出 ${money(st.total)} · 收入 ${money(st.income)}`)),
      next.start <= today() ? h('a', { class: 'icon-btn', href: link(next.start, accFilter), 'aria-label': '下个月' }, '›') : h('span', { class: 'icon-btn ghost' })));
  draw();
  return h('div', {},
    header('流水', helpButton('流水怎么看', LIST_HELP)),
    h('div', { class: 'list-tools' }, search, catSelect),
    summary,
    periodBox,
    h('div', { class: 'chip-scroll' },
      h('a', { class: `chip${accFilter ? '' : ' on'}`, href: link(p.start, '') }, '全部'),
      d.accounts.map((a) => h('a', { class: `chip${accFilter === a.id ? ' on' : ''}`, href: link(p.start, a.id) }, a.name))),
    results);
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
      sub: [rc.claims.length ? `垫付 ${rc.claims.length} 件` : null, rc.people.filter((x) => x.net > 0).length ? `${rc.people.filter((x) => x.net > 0).length} 个人` : null].filter(Boolean).join(' · ') }) : null,
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
      cell({ href: '#/people', ic: 'people', color: 'var(--sage)', title: '人情账', meta: receivables(store.data).toMe ? `别人欠 ${money(receivables(store.data).toMe)}` : openFavors(store.data, 'owe').length ? `欠 ${openFavors(store.data, 'owe').length} 个人情` : '' }),
      cell({ href: '#/reconcile', ic: 'check', color: 'var(--amber)', title: '对账', meta: needsReconcile(store.data, today()) ? '这个月还没对' : '' }),
      cell({ href: '#/bills', ic: 'search', color: 'var(--sage)', title: '账单查漏记', sub: '导入微信、支付宝账单，找出没记的' })),
    h('div', { class: 'group' },
      cell({ href: '#/wishes', ic: 'sparkle', color: 'var(--accent)', title: '心愿单', sub: '想买但不急的东西，有闲钱再买',
        meta: `基金 ${money(wishFunds(store.data, today()).small)}` }),
      cell({ href: '#/goals', ic: 'shield', color: 'var(--sage)', title: '存款目标', sub: '以后一定会用到的大钱',
        meta: store.data.goals.length ? `${store.data.goals.length} 个` : '' })),
    h('div', { class: 'group' },
      cell({ href: '#/subs', ic: 'clock', color: 'var(--blue)', title: '订阅', meta: subReviewDue(store.data, today()) ? '该体检了' : `${money(store.data.recurring.reduce((x, r) => x + yearlyCost(store.data, r, usdRate()), 0))}/年` }),
      cell({ href: '#/tax', ic: 'book', color: 'var(--amber)', title: '个税退税', sub: '兼职被预扣的个税，每年 3～6 月退',
        meta: taxSeason(today()) && taxYear(store.data, taxSeason(today())).withheld > 0 && !taxYear(store.data, taxSeason(today())).done ? '可以办了' : '' })),
    h('div', { class: 'group' },
      cell({ href: '#/rules', ic: 'book', color: 'var(--sage)', title: '我们的花钱方式', sub: '定下来的规则，和为什么这样做' }),
      cell({ href: '#/budget', ic: 'chart', color: 'var(--amber)', title: '预算', meta: money(budgetTotal(store.data)) }),
      cell({ href: '#/quick', ic: 'bolt', color: 'var(--blue)', title: '快捷记账', meta: store.data.quick.length ? `${store.data.quick.length} 个` : '' }),
      cell({ href: '#/receipt', ic: 'receipt', color: 'var(--sage)', title: '导入小票', sub: '购物回来，一整张小票一次记完' }),
      cell({ href: '#/siri', ic: 'mic', color: 'var(--accent)', title: 'Siri 和快捷指令', sub: '说一句话记账、AI 的回答一步发过来' })),
    h('div', { class: 'group' },
      cell({ href: '#/settings', ic: 'gear', color: '#8a8680', title: '设置' })),
    h('p', { class: 'center' }, h('button', { class: 'link small', onclick: exportExcel }, '导出全部账目（Excel）')));
}

// ---------- 垫付、人情：通用的「一笔钱」小表单 ----------

const daysSince = (day) => Math.round((new Date(today().replace(/-/g, '/')) - new Date(day.replace(/-/g, '/'))) / 86400000);

// 金额 + 账户 + 日期 + 备注，用于垫一笔、报销到账、还钱
function moneySheet({ title, hint, amount = '', confirmText = '记好了', accountLabel = '哪个账户', account: preset = null, onSave }) {
  const d = store.data;
  const amt = h('input', { inputmode: 'decimal', placeholder: '金额', 'aria-label': '金额', value: amount ? String(round2(amount)) : '' });
  let acc = preset || readJson(LAST_KEY).account;
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
    saveUndoable(`删除：${txTitle(t)} ${t.amount}`, (data) => { data.tx = data.tx.filter((x) => x.id !== t.id); },
      `删掉了：${txTitle(t)} ${exact(t.amount, curOf(t.account))}`).then(render).catch(() => {});
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
  ['记什么', ['钱：和同学吃饭你先付、帮人代买、借钱给别人，是别人欠你的；别人帮你付了，是你欠别人的。', '人情：不是钱的。别人帮了你一个忙，你记得找机会还，就是「我欠他一个人情」。']],
  ['怎么记钱', ['吃饭 AA：在「记一笔」填总金额，选「AA / 帮人付」，点上一起吃的人。你那份算花销，其他人的记成欠你的（不算花销）。', '别人帮你付：在「记一笔」选「别人帮我付的」。算你的花销，但账户没动。', '还钱：点这个人，「他还我钱」或「我还他钱」。钱到了哪张卡、从哪张卡出都行，和当初是哪张卡没关系。']],
  ['怎么记人情', ['点「记一个人情」：选人、谁欠谁、什么事。', '还人情：记聚餐请客、礼物、红包时，下面可以选「还的是哪个人情」，记好了就算还上了。没花钱的，在这个人的页面点「还了」。', '生活网站「身边的人」里也能记，记到的是同一份。']],
  ['提醒', [`钱：别人欠你、你欠别人超过 ${PERSON_REMIND_DAYS} 天，首页会提醒。`, '人情：平时不催。只在元旦、春节、清明、劳动节、端午、中秋、国庆放假前一天起，首页问一句这次还不还；「这次不还」就等下个假期再问。周末不算。']],
  ['要准备的钱', ['欠的人情可以写「他为我花了多少」和「还的时候大概要准备多少」，点「估一个」让 DeepSeek 按以前来回的钱给个参考。', `${FAVOR_BIG} 以下的从日常里出，按月列在上面；${FAVOR_BIG} 以上的（比如婚礼随礼）自动变成存款目标，到日子前留好。`, '「买不买」也会把这些钱算进去。']],
  ['礼尚往来', ['记礼物、红包、聚餐请客时，可以选「给谁的」；收到红包礼金记收入，类别选「收到的红包礼金」，选「谁给的」。', '点开一个人能看到你们之间来回送过什么、随过多少。生活网站「身边的人」里也能看到。']],
  ['名单', ['人的名字、分组在生活网站「身边的人」里管，两边是同一份名单。']],
];

function newPerson(after) {
  const name = h('input', { placeholder: '名字', 'aria-label': '名字' });
  openSheet({
    title: '加一个人', body: h('div', {}, name, h('p', { class: 'muted small' }, '会同时出现在生活网站的「身边的人」里，在那边分组。')), confirmText: '加好',
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

const FAVOR_DIR = { owe: '我欠他', owed: '他欠我' };
// 记一个人情 / 改一个
function favorSheet({ person = '', favor = null } = {}) {
  const d = store.data;
  const st = { person: favor?.person || person, dir: favor?.dir || 'owe' };
  const text = h('input', { placeholder: '什么事，比如 帮我改论文', 'aria-label': '什么事', value: favor?.text || '' });
  const date = h('input', { type: 'date', 'aria-label': '哪天', value: favor?.date || today() });
  const cost = h('input', { inputmode: 'decimal', placeholder: '不知道就空着', 'aria-label': '他为我花了多少', value: favor?.cost ? String(favor.cost) : '' });
  const est = h('input', { inputmode: 'decimal', placeholder: '大概要准备多少', 'aria-label': '预计要准备多少', value: favor?.estimate ? String(favor.estimate) : '' });
  const why = h('p', { class: 'muted small' });
  const box = h('div', { class: 'form' });
  const fresh = [];
  const guess = async (btn) => {
    if (!st.person) { toast('先选是谁', 'error'); return; }
    if (!text.value.trim()) { toast('先写是什么事', 'error'); return; }
    btn.disabled = true; btn.textContent = '正在估……';
    try {
      const p = [...d.people, ...fresh].find((x) => x.id === st.person);
      const r = await estimateFavor(p, { text: text.value.trim(), dir: st.dir, cost: Number(cost.value) || 0 });
      if (r.estimate) est.value = String(r.estimate);
      why.textContent = r.why ? `DeepSeek：${r.why}` : '';
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false; btn.textContent = '估一个';
  };
  const draw = () => {
    box.replaceChildren(
      h('div', { class: 'label-sm' }, '和谁'),
      personPicker({ people: [...d.people, ...fresh], value: st.person ? [st.person] : [], label: '和谁', recent: recentPeople(d),
        onNew: (name) => { const p = { id: newId('p'), name }; fresh.push(p); return p; }, onChange: (v) => { st.person = v; } }),
      h('div', { class: 'label-sm' }, '谁欠谁'),
      h('div', { class: 'chips', role: 'group', 'aria-label': '谁欠谁' }, Object.entries(FAVOR_DIR).map(([k, t]) =>
        h('button', { type: 'button', class: `chip${st.dir === k ? ' on' : ''}`, 'aria-pressed': String(st.dir === k), onclick: () => { st.dir = k; draw(); } }, t))),
      h('label', { class: 'form-label' }, '什么事', text),
      h('label', { class: 'form-label' }, '哪天', date),
      st.dir === 'owe' ? h('div', { class: 'form' }, h('label', { class: 'form-label' }, '他为我花了多少（选填）', cost),
        h('label', { class: 'form-label' }, '还的时候大概要准备多少（选填）', h('div', { class: 'inline-add' }, est, h('button', { type: 'button', class: 'small secondary', onclick: (e) => guess(e.currentTarget) }, '估一个'))), why,
        h('p', { class: 'muted small' }, `${FAVOR_BIG} 以上的会自动算进存款目标，以下的从日常里出。`)) : '');
  };
  draw();
  openSheet({
    title: favor ? '改这个人情' : '记一个人情', body: box, confirmText: favor ? '保存' : '记好了',
    onConfirm: async () => {
      if (!st.person) { toast('选一下是谁', 'error'); return false; }
      if (!text.value.trim()) { toast('写一下是什么事', 'error'); return false; }
      const rec = { person: st.person, dir: st.dir, text: text.value.trim(), date: date.value || today() };
      const c = Number(cost.value.replace(/[，,\s¥]/g, '')); const e = Number(est.value.replace(/[，,\s¥]/g, ''));
      try {
        await save(`人情：${[...d.people, ...fresh].find((p) => p.id === st.person)?.name || ''} ${FAVOR_DIR[st.dir]}`, (data) => {
          for (const p of fresh) if (p.id === rec.person && !data.people.some((x) => x.id === p.id)) data.people.push({ ...p });
          let x = favor && data.favors.find((f) => f.id === favor.id);
          if (x) Object.assign(x, rec);
          else data.favors.push(x = { id: newId('f'), ...rec, createdAt: new Date().toISOString(), status: 'open' });
          if (st.dir === 'owe' && c > 0) x.cost = round2(c); else delete x.cost;
          if (st.dir === 'owe' && e > 0) x.estimate = round2(e); else delete x.estimate;
        });
      } catch { return false; }
      render();
      return true;
    },
  });
}

// 没花钱的还法（帮了他一个忙、他还了你）：点「还了」写一句怎么还的
function favorDoneSheet(f) {
  const how = h('input', { placeholder: f.dir === 'owe' ? '怎么还的（选填）' : '他怎么还的（选填）', 'aria-label': '怎么还的' });
  openSheet({
    title: f.dir === 'owe' ? '这个人情还了' : '他还了这个人情',
    body: h('div', {}, h('p', { class: 'small' }, `${personName(f.person)} · ${f.text}`), how,
      f.dir === 'owe' ? h('p', { class: 'muted small' }, '请客、送礼花了钱的，在「记一笔」里选上这个人情更好，钱和人情能对上。') : null),
    confirmText: '还了',
    onConfirm: () => save(`人情还了：${personName(f.person)}`, (data) => {
      const x = data.favors.find((y) => y.id === f.id);
      Object.assign(x, { status: 'done', doneAt: today(), ...(how.value.trim() ? { doneNote: how.value.trim() } : {}) });
    }).then(() => { render(); return true; }).catch(() => false),
  });
}

function favorRow(f, { withName = false } = {}) {
  const done = f.status === 'done';
  const tx = done && f.doneTx ? store.data.tx.find((t) => t.id === f.doneTx) : null;
  const how = done ? [`${md(f.doneAt)}还了`, tx ? `${txTitle(tx)} ${exact(cny(tx))}` : f.doneNote].filter(Boolean).join(' · ') : null;
  return h('div', { class: `favor-row${done ? ' done' : ''}` },
    h('span', { class: `favor-dir ${f.dir}` }, f.dir === 'owe' ? '欠他' : '欠我'),
    h('button', { type: 'button', class: 'grow favor-text', onclick: () => favorSheet({ favor: f }) },
      withName ? h('b', {}, `${personName(f.person)} · `) : null, f.text,
      h('span', { class: 'muted small block' }, [md(f.date), f.cost ? `${f.dir === 'owe' ? '他' : '你'}花了 ${money(f.cost)}` : null, !done && f.estimate ? `预计要准备 ${money(f.estimate)}${f.estimate >= FAVOR_BIG ? '（存款目标）' : ''} · ${f.due ? `${md(f.due)}要用` : `${md(favorDue(f, today()))}前后`}` : null, how].filter(Boolean).join(' · '))),
    done ? null : h('button', { type: 'button', class: 'link small', onclick: () => favorDoneSheet(f) }, '还了'));
}

function favorsCard(list, title, opts) {
  if (!list.length) return null;
  return [h('div', { class: 'section-title' }, title), h('div', { class: 'card favor-list' }, list.map((f) => favorRow(f, opts)))];
}

function peopleView() {
  const d = store.data;
  const favorPeople = new Set(d.favors.map((f) => f.person));
  const list = d.people.map((p) => ({ p, ...personStatus(d, p.id) }))
    .filter((x) => x.tx.length || favorPeople.has(x.p.id) || giftsWith(d, x.p.id).length)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.p.name.localeCompare(b.p.name, 'zh'));
  const rc = receivables(d);
  const open = openFavors(d).sort((a, b) => a.date.localeCompare(b.date));
  const quiet = d.people.filter((p) => !p.archived).length - list.length;
  return h('div', {},
    header('人情账', h('button', { class: 'icon-btn', 'aria-label': '加一个人', onclick: () => newPerson((id) => go(`#/person/${id}`)) }, icon('plus')), helpButton('人情账怎么用', PEOPLE_HELP)),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, '别人一共欠你'), h('div', { class: 'big-num' }, money(list.reduce((s, x) => s + Math.max(0, x.net), 0))),
      rc.iOwe ? h('div', { class: 'small warn-text' }, `你欠别人 ${money(rc.iOwe)}`) : h('div', { class: 'muted small' }, '你不欠谁钱')),
    socialCard(),
    favorsCard(open.filter((f) => f.dir === 'owe'), '我欠的人情', { withName: true }),
    favorsCard(open.filter((f) => f.dir === 'owed'), '别人欠我的人情', { withName: true }),
    h('p', { class: 'center' }, h('button', { class: 'secondary', onclick: () => favorSheet() }, '记一个人情')),
    list.length ? [h('div', { class: 'section-title' }, '和谁有来往'), h('div', { class: 'group' }, list.map((x) => {
      const fo = openFavors(d).filter((f) => f.person === x.p.id);
      return cell({
        href: `#/person/${x.p.id}`, title: x.p.name,
        sub: [x.net > 0 ? `欠你钱 · ${daysSince(x.since)} 天` : x.net < 0 ? `你欠他钱 · ${daysSince(x.since)} 天` : x.tx.length ? '钱两清了' : null,
          fo.some((f) => f.dir === 'owe') ? `欠他 ${fo.filter((f) => f.dir === 'owe').length} 个人情` : null,
          fo.some((f) => f.dir === 'owed') ? `他欠你 ${fo.filter((f) => f.dir === 'owed').length} 个人情` : null].filter(Boolean).join(' · '),
        meta: x.net ? money(Math.abs(x.net)) : '',
      });
    }))] : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有来往。在「记一笔」里选「AA / 帮人付」就会自动记上，人情点上面的按钮。')),
    quiet > 0 ? h('p', { class: 'muted small center' }, `名单里还有 ${quiet} 个人没有来往记录，在生活网站「身边的人」里看。`) : null);
}

function personView(id) {
  const d = store.data;
  const p = d.people.find((x) => x.id === id);
  if (!p) return notFound();
  const ps = personStatus(d, id);
  const favors = d.favors.filter((f) => f.person === id).sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.date.localeCompare(a.date));
  const record = (type, title, hint, amount) => moneySheet({
    title, hint, amount, accountLabel: type === 'repay' ? '钱到了哪个账户' : '从哪个账户出',
    onSave: (f) => save(`${title}：${f.amount}`, (data) => { data.tx.push(moveTx(type, f, { person: id })); }),
  });
  const remove = () => {
    if (ps.tx.length || favors.length || giftsWith(d, id).length) return toast('和他还有记录，不能删', 'error');
    save(`人情账：删除 ${p.name}`, (data) => { data.people = data.people.filter((x) => x.id !== id); }).then(() => go('#/people', true)).catch(() => {});
  };
  return h('div', {},
    headerSub(p.name, '名字、分组在生活网站「身边的人」里改'),
    p.archived ? h('p', { class: 'muted small' }, '已经不来往了（在生活网站里归档的）。') : null,
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, ps.net > 0 ? '他欠你' : ps.net < 0 ? '你欠他' : '钱两清了'),
      h('div', { class: `big-num${ps.net < 0 ? ' warn-text' : ''}` }, money(Math.abs(ps.net))),
      ps.since ? h('div', { class: 'muted small' }, `最早一笔没结清的是 ${md(ps.since)}，${daysSince(ps.since)} 天前`) : null),
    h('div', { class: 'actions' },
      h('button', { onclick: () => record('repay', `${p.name}还我钱`, '钱到了哪个账户就选哪个，和当初从哪张卡付的没关系。', Math.max(0, ps.net)) }, '他还我钱'),
      h('button', { class: 'secondary', onclick: () => record('payback', `还给${p.name}`, '不算花销：那笔花销在他帮你付的时候已经算过了。', Math.max(0, -ps.net)) }, '我还他钱'),
      h('button', { class: 'secondary', onclick: () => record('advance', `借给${p.name} / 帮他付`, '不算你的花销，记成他欠你的。') }, '借给他')),
    h('div', { class: 'section-title' }, '人情'),
    favors.length ? h('div', { class: 'card favor-list' }, favors.map((f) => favorRow(f))) : null,
    h('p', { class: 'center' }, h('button', { class: 'link small', onclick: () => favorSheet({ person: id }) }, '+ 记一个人情')),
    giftsWith(d, id).length ? [h('div', { class: 'section-title' }, '礼尚往来'), h('div', { class: 'card tx-list' }, giftsWith(d, id).sort(txOrder).map((t) => txRow(t)))] : null,
    ps.tx.length ? [h('div', { class: 'section-title' }, '钱'), h('div', { class: 'card tx-list' }, [...ps.tx].sort(txOrder).map((t) => txRow(t, txActions(t))))]
      : !favors.length ? h('p', { class: 'center' }, h('button', { class: 'link danger-text small', onclick: remove }, '删掉这个人')) : null);
}

// 估一个要准备多少：带上和这个人以前来回的钱
async function estimateFavor(p, f) {
  const d = store.data;
  const history = [
    ...giftsWith(d, p.id).map((t) => `${t.date} ${t.type === 'income' ? '他给我' : '我给他'} ${catName(t.category)} ¥${cny(t)}`),
    ...d.favors.filter((x) => x.person === p.id && x.status === 'done').map((x) => {
      const tx = x.doneTx && d.tx.find((t) => t.id === x.doneTx);
      return `${x.doneAt} 还过人情「${x.text}」${tx ? `花了 ¥${cny(tx)}` : x.doneNote ? `（${x.doneNote}）` : ''}${x.cost ? `，当时他花了 ¥${x.cost}` : ''}`;
    }),
  ];
  const { system, user } = estimatePrompt({ who: { name: p.name, hint: p.hint }, f, history, budget: d.budget.daily });
  return cleanEstimate(await askJson(await aiConfig(), system, user, { maxTokens: 1000, timeout: 60000 }));
}

// 要准备的人情钱：小额从日常出（按月列），大额在存款目标里
function socialCard({ compact = false } = {}) {
  const t = today();
  const plan = socialPlan(store.data, t);
  if (!plan.length) return null;
  const soon = compact ? plan.filter((x) => x.due <= addDays(t, 45)) : plan;
  if (!soon.length) return null;
  const small = soon.filter((x) => !x.big);
  const big = soon.filter((x) => x.big);
  const months = {};
  for (const x of small) (months[x.due.slice(0, 7)] ||= []).push(x);
  return h('div', { class: 'card social-plan' },
    h('h3', {}, compact ? '人情：接下来要准备的钱' : '要准备的钱'),
    Object.entries(months).map(([m, list]) => h('div', { class: 'plan-row' },
      h('span', { class: 'grow' }, `${Number(m.slice(5))} 月 · 日常里出`, h('span', { class: 'muted small block' }, list.map((x) => `${x.name} · ${x.f.text}`).join('、'))),
      h('b', {}, money(list.reduce((a, x) => a + x.amount, 0))))),
    big.map((x) => h('a', { class: 'plan-row', href: '#/goals' },
      h('span', { class: 'grow' }, `${md(x.due)} · 大额，存款目标`, h('span', { class: 'muted small block' }, `${x.name} · ${x.f.text}`)),
      h('b', {}, money(x.amount)))),
    compact ? h('a', { class: 'small', href: '#/people' }, '人情账 ›') : null);
}

// 放假前一天到假期结束：我欠的人情这次还不还。「这次还」留在这里直到还上或假期过完；「这次不还」下个假期再问
function favorHolidayCard() {
  const t = today();
  const hf = holidayFavors(store.data, t);
  if (!hf) return null;
  const mark = (f, k) => save(k === 'plan' ? `人情：这个假期还 ${personName(f.person)}` : `人情：这次先不还 ${personName(f.person)}`, (data) => {
    const x = data.favors.find((y) => y.id === f.id);
    x[k] = hf.hol.key;
  }).then(render).catch(() => {});
  return h('div', { class: 'card favor-holiday' },
    h('h3', {}, holidayLine(hf.hol, t)),
    hf.ask.length ? h('p', { class: 'muted small' }, '还欠这些人情，这次还吗？') : null,
    hf.ask.map((f) => h('div', { class: 'favor-ask' },
      h('span', { class: 'grow' }, h('b', {}, personName(f.person)), ` · ${f.text}`, h('span', { class: 'muted small block' }, `${md(f.date)}的事`)),
      h('button', { type: 'button', class: 'small', onclick: () => mark(f, 'plan') }, '这次还'),
      h('button', { type: 'button', class: 'secondary small', onclick: () => mark(f, 'skip') }, '这次不还'))),
    hf.plan.length ? [h('p', { class: 'muted small' }, '这个假期要还的：'), hf.plan.map((f) => h('div', { class: 'favor-ask' },
      h('span', { class: 'grow' }, h('b', {}, personName(f.person)), ` · ${f.text}`),
      h('a', { class: 'button small', href: `#/add?favor=${f.id}` }, '记一笔'),
      h('button', { type: 'button', class: 'link small', onclick: () => favorDoneSheet(f) }, '没花钱')))] : null);
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
    h('a', { class: 'receipt-link', href: '#/bills' }, icon('search'), ' 对不上？导入微信、支付宝账单找出漏记的'),
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
  ['月度小信', ['每个预算月结束后，打开那个月的总结，DeepSeek 会根据这个月的汇总数字写几句话：一件做得好的事、一条下个月可以试试的建议。写一次就存下来。']],
  ['年总结', ['按自然年：一年存了多少、储蓄率、总资产多了多少、每月存下多少、钱花在哪、实现和放弃了几个心愿。每年 1 月初首页会提醒你看去年的。']],
  ['翻看', ['左右箭头看以前的。']],
];
const WEEKDAYS = '一二三四五六日';

function summaryView(q) {
  const d = store.data;
  const mode = ['month', 'year'].includes(q.mode) ? q.mode : 'week';
  const day = q.day || today();
  const link = (m, dd) => `#/summary?mode=${m}&day=${dd}`;
  const seg = h('div', { class: 'segmented' }, [['week', '周'], ['month', '月'], ['year', '年']].map(([k, t]) =>
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
        ws.st.total ? spendDonut(ws.st, groups, { sub: '这周花销', title: '花在哪了', extra: (g) => arrow(ws.st.byGroup[g.id], ws.prev.byGroup[g.id]) })
          : h('p', { class: 'muted small' }, '这周还没有花销。')),
      ws.top.length ? h('div', { class: 'card tx-list' }, h('h3', {}, '这周最大的几笔'), ws.top.map((t) => txRow(t))) : null);
  }

  if (mode === 'year') return yearView(d, Number(day.slice(0, 4)), head, seg, navRow);

  const ms = monthSummary(d, day, usdRate());
  const p = ms.p;
  const upto = ms.curve.filter((x) => x.day <= today());
  const n = ms.curve.length - 1;
  const hist = ms.hist;
  return h('div', {}, head, seg,
    navRow(p.label, p.start <= today() && p.end >= today() ? '这个预算月' : null, addDays(p.start, -1), p.next),
    h('div', { class: 'card summary-head' }, h('p', {}, ms.headline),
      h('div', { class: 'advice' }, h('b', {}, '下个月可以试试：'), ms.advice)),
    letterCard(p),
    flowCard(ms.st, ms.part, '钱怎么分的'),
    budgetAdvice(d, today(), usdRate()).items.length ? h('a', { class: 'card link-card', href: '#/budget' }, `预算有调整建议，去看看 →`) : null,
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

// 月度小信：预算月结束后，DeepSeek 根据这个月的汇总数字写几句话。存在 data.letters，写一次就不再花钱。
const letterState = { busy: {}, error: {} };

async function writeLetter(p) {
  const d = store.data;
  const st = periodStats(d, p);
  const part = partial(d, p);
  const prevP = shiftPeriod(d, p, -1);
  const prev = d.openingDate && prevP.end >= d.openingDate ? periodStats(d, prevP) : null;
  const inP = (day) => day && day >= p.start && day <= p.end;
  const lines = [
    `预算月：${p.label}${part.isPartial ? `（从 ${md(part.from)}开始记账，只记了一部分）` : ''}${p.summer ? '（暑假，没有收入）' : ''}。`,
    `收入 ${Math.round(st.income)}，花销 ${Math.round(st.total)}，存下 ${Math.round(st.income - st.total)}${st.income ? `，储蓄率 ${Math.round(((st.income - st.total) / st.income) * 100)}%` : ''}。`,
    `各块花销 / 预算：${GROUPS.filter((g) => d.budget[g.id] || st.spent[g.id]).map((g) => `${g.name} ${Math.round(st.spent[g.id])} / ${Math.round((d.budget[g.id] || 0) * part.factor)}`).join('；')}。`,
    `花得最多的类别：${Object.entries(st.byCat).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => `${catName(id)} ${Math.round(v)}`).join('、') || '无'}。`,
    prev ? `上个预算月：收入 ${Math.round(prev.income)}，花销 ${Math.round(prev.total)}，存下 ${Math.round(prev.income - prev.total)}。` : '这是第一个记账的月份，没有上个月可以比。',
    `这个月实现的心愿：${d.wishes.filter((w) => w.status === 'bought' && inP(w.boughtAt)).map((w) => w.name).join('、') || '无'}；放弃的心愿：${d.wishes.filter((w) => w.status === 'dropped' && inP(w.droppedAt)).map((w) => w.name).join('、') || '无'}。`,
    `这个月的里程碑：${Object.values(d.milestones?.reached || {}).filter((x) => inP(x.at)).map((x) => x.text).join('、') || '无'}。`,
    `网站按规则给的建议：${monthSummary(d, p.end, usdRate()).advice}`,
  ].join('\n');
  const system = [
    '你是一个大学生的理财小伙伴。他对理财不太懂，容易焦虑，在认真地学着记账、稳定存钱。',
    '每个预算月结束，你根据下面的汇总数字给他写一封很短的信：120～220 字，像朋友写的便条，大白话，温和真诚。',
    '先具体地说一件这个月做得好的事（用数字），再给一条下个月可以试试的小建议（只给一条，要具体、容易做到）。没有什么要改的，就鼓励他保持。',
    '不说教，不吓唬人，不推荐任何理财产品，数字只用给你的，不要编。不要用「亲爱的」这类称呼，不要署名。',
    '只输出 JSON：{"letter":""}',
  ].join('\n');
  const out = await askJson(await aiConfig(), system, lines, { maxTokens: 6000, timeout: 120000 });
  const text = String(out.letter || '').trim();
  if (!text) throw new Error('DeepSeek 没写出来，等会儿再试');
  await save(`月度小信：${p.label}`, (data) => { data.letters = { ...(data.letters || {}), [p.start]: { at: today(), text } }; });
}

function letterCard(p) {
  const d = store.data;
  if (p.end >= today() || (d.openingDate && p.end < d.openingDate)) return null; // 还没结束 / 还没开始记账
  if (!periodStats(d, p).tx.length) return null; // 这个月什么都没记，没什么可写的
  const letter = d.letters?.[p.start];
  const run = () => {
    if (letterState.busy[p.start]) return;
    letterState.busy[p.start] = true;
    letterState.error[p.start] = '';
    writeLetter(p).catch((e) => { letterState.error[p.start] = e.message; })
      .finally(() => { letterState.busy[p.start] = false; if (/^\/summary/.test(currentPath())) render(); });
  };
  // 最近结束的那个预算月：打开总结时自动写；更早的点一下再写
  const latest = shiftPeriod(d, p, 1).start === periodFor(d, today()).start;
  if (!letter && latest && !letterState.busy[p.start] && !letterState.error[p.start]) setTimeout(run);
  return h('div', { class: 'card letter' },
    h('h3', {}, icon('sparkle'), ' 这个月的小信'),
    letter ? [h('p', { class: 'letter-text' }, letter.text), h('button', { class: 'link small', onclick: () => { delete d.letters[p.start]; run(); render(); } }, '再写一封')]
      : letterState.busy[p.start] || (latest && !letterState.error[p.start]) ? h('p', { class: 'muted small' }, 'DeepSeek 正在写……')
        : [letterState.error[p.start] ? h('p', { class: 'small warn-text' }, letterState.error[p.start]) : null,
          h('button', { class: 'secondary', onclick: run }, '让 DeepSeek 写一封')]);
}

// 年度总结
function yearView(d, year, head, seg, navRow) {
  const ys = yearSummary(d, year, usdRate());
  const started = !d.openingDate || d.openingDate <= ys.to;
  const nav = navRow(`${year} 年`, ys.from > `${year}-01-01` ? `从 ${md(ys.from)}开始记账` : null, `${year - 1}-12-31`, `${year + 1}-01-01`);
  if (!started || (!ys.st.tx.length)) return h('div', {}, head, seg, nav, h('div', { class: 'card' }, h('p', { class: 'muted' }, '这一年还没有记录。')));
  const groups = GROUPS.filter((g) => ys.st.byGroup[g.id]);
  const maxCat = Math.max(1, ...ys.cats.map(([, v]) => v));
  const dropSaved = ys.wishesDropped.reduce((a, w) => a + Number(w.price), 0);
  return h('div', {}, head, seg, nav,
    h('div', { class: 'card summary-head' },
      h('p', {}, `${year} 年收入 ${money(ys.st.income)}，花了 ${money(ys.st.total)}，存下 ${money(ys.saved)}${ys.rate != null ? `，储蓄率 ${ys.rate}%` : ''}。`),
      h('p', { class: 'muted small' }, `总资产 ${money(ys.assetsStart)} → ${money(ys.assetsEnd)}（${ys.assetsEnd >= ys.assetsStart ? '多了' : '少了'} ${money(Math.abs(ys.assetsEnd - ys.assetsStart))}）· 记了 ${ys.days} 天账`)),
    h('div', { class: 'card' }, h('h3', {}, '每月存下'),
      barChart(ys.months.filter((m) => m.active).map((m) => ({ label: `${m.m}月`, v: Math.round(m.saved), color: m.saved >= 0 ? 'var(--sage)' : 'var(--danger)' })), { title: '每月存下' }),
      h('p', { class: 'muted small' }, '按自然月算；7、8 月没有收入，是负的很正常。')),
    h('div', { class: 'card' }, h('h3', {}, '钱花在哪了'),
      spendDonut(ys.st, groups, { sub: '这一年', title: '钱花在哪了' })),
    ys.cats.length ? h('div', { class: 'card' }, h('h3', {}, '花得最多的类别'),
      ys.cats.map(([id, v]) => h('div', { class: 'budget-row' },
        h('div', { class: 'budget-top' }, h('span', {}, catName(id)), h('span', { class: 'muted' }, money(v))),
        bar(v / maxCat, GROUPS.find((g) => g.id === (category(d, id)?.group || 'daily'))?.color)))) : null,
    ys.top.length ? h('div', { class: 'card tx-list' }, h('h3', {}, '最大的几笔'), ys.top.map((t) => txRow(t))) : null,
    h('div', { class: 'card' }, h('h3', {}, '这一年还有'),
      h('div', { class: 'tax-grid' },
        h('span', {}, '实现的心愿'), h('b', {}, ys.wishesBought.length ? `${ys.wishesBought.length} 个` : '—'),
        h('span', {}, '放弃的心愿'), h('b', {}, ys.wishesDropped.length ? `${ys.wishesDropped.length} 个，省下 ${money(dropSaved)}` : '—'),
        h('span', {}, '订阅一共'), h('b', {}, money(ys.subs)),
        h('span', {}, '个税退回'), h('b', {}, ys.taxRefund ? money(ys.taxRefund) : '—')),
      ys.wishesBought.length ? h('p', { class: 'muted small' }, `实现了：${ys.wishesBought.map((w) => w.name).join('、')}`) : null),
    (() => {
      const ms = Object.values(d.milestones?.reached || {}).filter((x) => x.at >= ys.from && x.at <= ys.to).sort((a, b) => a.at.localeCompare(b.at));
      return ms.length ? h('div', { class: 'card' }, h('h3', {}, '这一年的里程碑'), ms.map((x) => h('div', { class: 'budget-top' }, h('span', {}, x.text), h('span', { class: 'muted' }, md(x.at))))) : null;
    })());
}

// 首页上的总结入口：周一、周二提醒看上周；预算月头三天提醒看上个月
function summaryLinks(p) {
  const wd = new Date().getDay();
  const out = [];
  if (today().slice(5) <= '01-07' && store.data.openingDate < today().slice(0, 4)) {
    out.push(cell({ href: `#/summary?mode=year&day=${Number(today().slice(0, 4)) - 1}-12-31`, ic: 'chart', color: 'var(--sage)', title: '去年的年度总结出来了' }));
  }
  if (wd === 1 || wd === 2) out.push(cell({ href: `#/summary?mode=week&day=${addDays(weekOf(today()).start, -1)}`, ic: 'chart', color: 'var(--blue)', title: '上周总结出来了' }));
  if (p.dayIndex <= 3 && !(store.data.openingDate > addDays(p.start, -1))) {
    out.push(cell({ href: `#/summary?mode=month&day=${addDays(p.start, -1)}`, ic: 'chart', color: 'var(--accent)', title: '上个预算月的总结出来了' }));
  }
  return out.length ? h('div', { class: 'group' }, out) : null;
}

// ---------- 导入小票 ----------
// 购物回来：小票拍照发给手机上的 AI（按提示词整理成 JSON）→ 复制回答贴到这里 → 一样一样确认 → 一次保存。
// 记账按类别合并（同一张小票同一类合成一笔）；物品档案里有的消耗品补数量，新东西进「买回来还没建档」。
// 从快捷指令进来是 #/receipt?text=<AI 的回答>。

const RECEIPT_HELP = [
  ['整个流程', ['1. 小票拍照，发给手机上能看图的 AI（豆包、ChatGPT、Kimi 都行），连同下面「复制提示词」复制的那段话。', '2. 把 AI 的回答整段复制，回到这里贴进去（或者用快捷指令「发到账本」一步打开）。', '3. 一样一样看：类别对不对、物品档案要不要补货。不对就改，不想记就点「这样不记」。', '4. 最后看一眼合计，点「全部保存」。']],
  ['会记成什么', ['同一张小票里同一个类别的合成一笔，比如「零食 ¥23.5（薯片、饼干）」，商品名写在备注里，流水里能搜到。', '整单优惠并进金额最多的那一笔。']],
  ['物品档案', ['档案里有的消耗品（比如抽纸）：自动加上买的数量，从购物清单上划掉。', '新东西：放进物品档案的「买回来还没建档」，有空再去拍照、选柜子；那边建档时不会再问记账。', '吃的喝的默认不进档案，可以改。']],
  ['没有 AI 也行', ['一行写一样：名称 数量 价格，比如「可乐 2 6」「抽纸 19.9」，最后一行可以写「合计 25.9」。']],
];

let receipt = null; // 导入到一半的小票（换页回来还在；保存完清掉）

// 小票的指纹（日期 + 每样的名称和价格）：同一张导入两次时提醒，AI 回答前后多几句话也认得出
function receiptKey(parsed) {
  let x = 0;
  const text = JSON.stringify([parsed.date, parsed.items.map((i) => [i.name, i.price])]);
  for (const ch of text) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return `r${x.toString(36)}`;
}

function startReceipt(text) {
  const d = store.data;
  const parsed = parseReceipt(text);
  const cats = d.categories.filter((c) => c.kind === 'expense' && !c.hidden && !AUTO_CATEGORIES.includes(c.id));
  const last = readJson(LAST_KEY).account;
  const cnyAccounts = d.accounts.filter((a) => a.currency !== 'USD');
  receipt = {
    text, key: receiptKey(parsed), step: 0, stage: 'check',
    shop: parsed.shop, date: parsed.date || today(), total: parsed.total,
    account: cnyAccounts.some((a) => a.id === last) ? last : cnyAccounts[0]?.id,
    lines: parsed.items.map((x) => ({ ...x, category: guessCategory(cats, d.tx, x.name, x.hint), action: null, skip: false })),
    inv: undefined, igh: inventoryGitHub(settings),
  };
  const r = receipt;
  readInventory(r.igh).then((inv) => { r.inv = inv; }).catch(() => { r.inv = null; })
    .finally(() => { if (receipt === r && currentPath() === '/receipt') render(); });
}

// 物品档案读到以后，给每样东西对上档案、定默认怎么处理（只做一次，用户改过的不动）
function matchReceiptLines() {
  const r = receipt;
  if (!r.inv) return;
  const cats = store.data.categories;
  for (const l of r.lines) {
    if (l.action) continue;
    if (l.price < 0) { l.action = 'none'; continue; }
    const m = matchInventory(r.inv, l.name);
    l.itemId = m.item?.id || null;
    l.extraId = m.extra?.id || null;
    l.action = defaultInventoryAction(m, l.category, cats);
    if (m.item) l.newQty = restockQty(m.item, l.qty);
  }
}

function receiptView(q) {
  if (q.text && (!receipt || receipt.text !== q.text)) {
    try { startReceipt(q.text); } catch (e) { receipt = { stage: 'paste', text: q.text, error: e.message }; }
    history.replaceState(null, '', '#/receipt'); // 网址里的小票内容用完就去掉，刷新不会重新开始
  }
  if (!receipt) receipt = { stage: 'paste', text: '' };
  const r = receipt;
  const head = (sub) => headerSub('导入小票', sub, helpButton('导入小票怎么用', RECEIPT_HELP));
  if (r.stage === 'paste') return receiptPaste(head);
  if (r.inv) matchReceiptLines();
  if (r.stage === 'check') return receiptCheck(head);
  if (r.stage === 'summary') return receiptSummary(head);
  return receiptDone(head);
}

function receiptPaste(head) {
  const r = receipt;
  const box = h('textarea', { rows: 10, placeholder: '把 AI 整理好的小票贴在这里\n\n没有 AI 也行，一行一样：\n可乐 2 6\n抽纸 19.9\n合计 25.9', 'aria-label': '小票内容',
    value: r.text, oninput: (e) => { r.text = e.target.value; } });
  const cats = store.data.categories.filter((c) => c.kind === 'expense' && !c.hidden && !AUTO_CATEGORIES.includes(c.id));
  const copyPrompt = async () => {
    const text = receiptPrompt(cats, today());
    try { await navigator.clipboard.writeText(text); toast('提示词复制好了，连同小票照片一起发给 AI'); } catch { openSheet({ title: '提示词', body: h('textarea', { rows: 12, value: text, readonly: true }), confirmText: '好', cancelText: null, onConfirm: () => {} }); }
  };
  const paste = async () => {
    try { r.text = await navigator.clipboard.readText(); box.value = r.text; } catch { toast('读不了剪贴板，长按输入框粘贴', 'error'); }
  };
  const next = () => {
    try { startReceipt(box.value); render(); } catch (e) { toast(e.message, 'error'); }
  };
  return h('div', {},
    head('购物回来，一次记完'),
    h('div', { class: 'card' },
      h('p', { class: 'small' }, '小票拍照发给手机上的 AI，连同这段提示词，它会整理成网站能读的样子：'),
      h('button', { class: 'secondary wide', onclick: copyPrompt }, '复制提示词')),
    r.error ? h('p', { class: 'hint error' }, r.error) : null,
    box,
    h('div', { class: 'actions sticky' },
      h('button', { class: 'secondary', onclick: paste }, '粘贴'),
      h('button', { onclick: next }, '下一步')));
}

// 类别下拉：按预算大组分开
function categorySelect(value, onChange, label) {
  const cats = store.data.categories.filter((c) => c.kind === 'expense' && (!c.hidden || c.id === value) && !AUTO_CATEGORIES.includes(c.id));
  return h('select', { 'aria-label': label, value, onchange: (e) => onChange(e.target.value) },
    GROUPS.map((g) => {
      const list = cats.filter((c) => c.group === g.id);
      return list.length ? h('optgroup', { label: g.name }, list.map((c) => h('option', { value: c.id }, c.name))) : null;
    }));
}

function receiptCheck(head) {
  const r = receipt;
  const n = r.lines.length;
  const l = r.lines[r.step];
  const go2 = (step) => { r.step = step; if (step >= n) r.stage = 'summary'; render(); window.scrollTo(0, 0); };
  const item = l.itemId && r.inv ? r.inv.items.find((i) => i.id === l.itemId) : null;
  const extra = l.extraId && r.inv ? (r.inv.shopping?.extra || []).find((e) => e.id === l.extraId) : null;
  const dup = r.step === 0 && store.data.tx.find((t) => t.receipt === r.key);

  const qtyInput = h('input', { type: 'number', min: 1, inputmode: 'numeric', value: l.qty, 'aria-label': '数量',
    onchange: (e) => { const v = Math.max(1, Math.round(Number(e.target.value)) || 1); if (item) l.newQty += v - l.qty; l.qty = v; render(); } });
  const fields = h('div', { class: 'receipt-fields' },
    h('label', { class: 'form-label' }, '名称', h('input', { value: l.name, 'aria-label': '名称', oninput: (e) => { l.name = e.target.value; } })),
    h('div', { class: 'row-2' },
      h('label', { class: 'form-label' }, '数量', qtyInput),
      h('label', { class: 'form-label' }, '实付（元）', h('input', { inputmode: 'decimal', value: String(l.price), 'aria-label': '实付',
        oninput: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) l.price = Math.round(v * 100) / 100; } }))));

  let invPart;
  if (l.price < 0) invPart = h('p', { class: 'muted small' }, '优惠会并进金额最多的那一笔。');
  else if (r.inv === undefined) invPart = h('p', { class: 'muted small' }, '正在看物品档案……');
  else if (!r.inv) invPart = h('p', { class: 'muted small' }, '读不到物品档案（令牌没授权 inventory-data？），这次只记账。');
  else {
    const opts = item
      ? [['restock', `补货：现在 ×${Number(item.quantity) || 0} → ×${l.newQty}`], ['file', '是新的一件，去建档'], ['none', '不动档案']]
      : [['file', '放进「买回来还没建档」'], ['none', '不进档案']];
    invPart = h('div', {},
      item ? h('p', { class: 'small' }, '档案里有：', h('b', {}, item.name), item.consumable ? '' : '（不是消耗品）') : h('p', { class: 'muted small' }, '档案里没有同名的东西。'),
      h('div', { class: 'chips', role: 'group', 'aria-label': '物品档案' }, opts.map(([k, t]) => h('button', {
        type: 'button', class: `chip${l.action === k ? ' on' : ''}`, 'aria-pressed': String(l.action === k), onclick: () => { l.action = k; render(); },
      }, t))),
      l.action === 'restock' ? h('label', { class: 'form-label' }, '买回来后一共有几个',
        h('input', { type: 'number', min: 1, inputmode: 'numeric', value: l.newQty, 'aria-label': '一共有几个', onchange: (e) => { l.newQty = Math.max(1, Math.round(Number(e.target.value)) || 1); } })) : null,
      extra ? h('p', { class: 'muted small' }, `购物清单上的「${extra.name}」会划掉。`) : null);
  }

  return h('div', {},
    head(`第 ${r.step + 1} / ${n} 样`),
    dup ? h('div', { class: 'banner soon' }, `这张小票 ${dup.date} 好像已经导入过了，看看流水，别记重了。`) : null,
    h('div', { class: 'card receipt-card' },
      fields,
      l.price > 0 ? h('label', { class: 'form-label' }, '记成', categorySelect(l.category, (v) => { l.category = v; }, '类别')) : null,
      h('div', { class: 'label-sm' }, '物品档案'),
      invPart),
    h('div', { class: 'actions sticky' },
      r.step > 0 ? h('button', { class: 'secondary', onclick: () => go2(r.step - 1) }, '上一样') : null,
      h('button', { class: 'secondary', onclick: () => { l.skip = true; go2(r.step + 1); } }, '这样不记'),
      h('button', { onclick: () => { l.skip = false; go2(r.step + 1); } }, r.step + 1 < n ? '对，下一样' : '对，看合计')),
    r.step + 1 < n ? h('p', { class: 'center' }, h('button', { class: 'link small', onclick: () => go2(n) }, '剩下的都按推荐，直接看合计')) : null,
    h('p', { class: 'center' }, h('button', { class: 'link small muted', onclick: () => { receipt = { stage: 'paste', text: r.text }; render(); } }, '重新贴')));
}

const receiptLines = () => receipt.lines.filter((l) => !l.skip && l.name.trim());

function receiptSummary(head) {
  const r = receipt;
  const d = store.data;
  const lines = receiptLines();
  const groups = groupByCategory(lines);
  const sum = Math.round(lines.reduce((a, l) => a + l.price, 0) * 100) / 100;
  const skipped = r.lines.filter((l) => l.skip);
  const restock = lines.filter((l) => l.action === 'restock');
  const toFile = lines.filter((l) => l.action === 'file');
  const crossed = lines.filter((l) => l.extraId && r.inv);
  const accounts = d.accounts.filter((a) => a.currency !== 'USD');
  const totalNote = r.total == null ? `一共 ${exact(sum)}`
    : Math.abs(r.total - sum) < 0.01 ? `一共 ${exact(sum)}，和小票实付对得上 ✓`
      : `加起来 ${exact(sum)}，小票实付 ${exact(r.total)}，差 ${exact(Math.round((r.total - sum) * 100) / 100)}——回去看看哪样价格不对，或者是没记的那几样`;
  return h('div', {},
    head('最后看一眼'),
    h('div', { class: 'card' },
      h('div', { class: 'row-2' },
        h('input', { type: 'date', value: r.date, 'aria-label': '日期', onchange: (e) => { r.date = e.target.value || today(); } }),
        h('input', { value: r.shop, placeholder: '店名（选填）', 'aria-label': '店名', oninput: (e) => { r.shop = e.target.value; } })),
      h('div', { class: 'label-sm' }, '从哪个账户付'),
      h('div', { class: 'chips', role: 'group', 'aria-label': '账户' }, accounts.map((a) => h('button', {
        type: 'button', class: `chip${a.id === r.account ? ' on' : ''}`, 'aria-pressed': String(a.id === r.account), onclick: () => { r.account = a.id; render(); },
      }, a.name))),
      d.settings.payNote ? h('p', { class: 'muted small' }, d.settings.payNote) : null),
    h('div', { class: 'section-title' }, `记账 ${groups.length} 笔`),
    h('div', { class: 'card' },
      groups.map((g) => h('div', { class: 'receipt-row' },
        h('span', { class: 'grow' }, catName(g.category), h('span', { class: 'muted small block' }, g.names.join('、'))),
        h('b', {}, exact(g.amount)))),
      h('p', { class: `small ${r.total != null && Math.abs(r.total - sum) >= 0.01 ? 'warn-text' : 'muted'}` }, totalNote)),
    r.inv ? [h('div', { class: 'section-title' }, '物品档案'),
      h('div', { class: 'card small' },
        restock.length ? h('p', {}, '补货：', restock.map((l) => `${l.name} → ×${l.newQty}`).join('、')) : null,
        toFile.length ? h('p', {}, '放进「买回来还没建档」：', toFile.map((l) => l.name).join('、')) : null,
        crossed.length ? h('p', {}, '购物清单划掉：', crossed.map((l) => l.name).join('、')) : null,
        !restock.length && !toFile.length && !crossed.length ? h('p', { class: 'muted' }, '这张小票不动物品档案。') : null)] : null,
    skipped.length ? h('p', { class: 'muted small' }, `不记：${skipped.map((l) => l.name).join('、')}`) : null,
    h('div', { class: 'actions sticky' },
      h('button', { class: 'secondary', onclick: () => { r.stage = 'check'; r.step = 0; render(); } }, '回去改'),
      h('button', { onclick: saveReceipt }, '全部保存')));
}

async function saveReceipt() {
  const r = receipt;
  const lines = receiptLines();
  const groups = groupByCategory(lines);
  if (!groups.length) return toast('没有要记的', 'error');
  if (!r.account) return toast('选一下从哪个账户付', 'error');
  const shop = r.shop.trim();
  const now = new Date().toISOString();
  try {
    await save(`导入小票：${shop || '购物'} ${groups.reduce((a, g) => a + g.amount, 0).toFixed(2)}`, (data) => {
      for (const g of groups) {
        data.tx.push({
          id: newId('t'), type: 'expense', date: r.date, account: r.account, amount: g.amount, category: g.category,
          note: `${shop ? `${shop}：` : ''}${g.names.join('、')}`, ...(FREEFORM.includes(g.category) ? { what: g.names.join('、') } : {}),
          receipt: r.key, createdAt: now,
        });
      }
    });
  } catch { return; }
  writeJson(LAST_KEY, { account: r.account });
  r.saved = groups;
  r.stage = 'done';
  r.invState = r.inv ? 'saving' : 'skip';
  render();
  if (r.inv) saveReceiptInventory();
}

// 物品档案要联网直接提交；失败了账已经记好了，可以再试
async function saveReceiptInventory() {
  const r = receipt;
  const lines = receiptLines().filter((l) => l.action !== 'none' || l.extraId);
  if (!lines.length) { r.invState = 'skip'; render(); return; }
  r.invState = 'saving';
  try {
    await updateInventory(r.igh, (data) => applyToInventory(data, lines, { date: r.date, shop: r.shop.trim(), newId }),
      `小票导入：${lines.map((l) => l.name).join('、')}`);
    r.invState = 'ok';
  } catch (e) {
    r.invState = 'error';
    r.invError = e.message;
  }
  if (receipt === r && currentPath() === '/receipt') render();
}

function receiptDone(head) {
  const r = receipt;
  const total = r.saved.reduce((a, g) => a + g.amount, 0);
  const lines = receiptLines();
  const inv = {
    saving: h('p', { class: 'muted small' }, '正在更新物品档案……'),
    ok: h('p', { class: 'small' }, `物品档案：${[
      lines.filter((l) => l.action === 'restock').length ? `补货 ${lines.filter((l) => l.action === 'restock').length} 样` : '',
      lines.filter((l) => l.action === 'file').length ? `${lines.filter((l) => l.action === 'file').length} 样等着建档` : '',
      lines.filter((l) => l.extraId).length ? `购物清单划掉 ${lines.filter((l) => l.extraId).length} 样` : '',
    ].filter(Boolean).join('，')}。`),
    error: h('div', {}, h('p', { class: 'hint error' }, `物品档案没更新上：${r.invError}（账已经记好了）`),
      h('button', { class: 'secondary', onclick: saveReceiptInventory }, '再试一次')),
    skip: null,
  }[r.invState];
  const again = () => { receipt = { stage: 'paste', text: '' }; render(); };
  return h('div', {},
    head('记好了'),
    h('div', { class: 'card' },
      h('p', {}, `记了 ${r.saved.length} 笔，共 ${exact(Math.round(total * 100) / 100)}：`),
      h('ul', { class: 'small' }, r.saved.map((g) => h('li', {}, `${catName(g.category)} ${exact(g.amount)}（${g.names.join('、')}）`))),
      inv),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { receipt = null; go('#/', true); } }, '回首页'),
      h('button', { class: 'secondary', onclick: again }, '再导入一张')));
}

// ---------- 微信、支付宝账单查漏记 ----------
// 导出账单（CSV 或 Excel）→ 和账本对：金额一样、日期差 2 天内的算记过了 → 没记的一笔笔确认。
// 每笔带 bill（账单单号）和 billParty（商家），再导同一份不会重复，下次同一个商家按这次的类别猜。

const BILLS_HELP = [
  ['怎么导出账单', [
    '微信：我 → 服务 → 钱包 → 账单 → 右上角「…」→ 下载账单 → 用于个人对账 → 选时间（比如上个月）→ 填邮箱。几分钟后邮箱收到一个压缩包，解压密码在微信「微信支付」的消息里。',
    '支付宝：我的 → 账单 → 右上角「…」→ 开具交易流水证明 → 用于个人对账 → 选时间 → 填邮箱。解压密码在支付宝的消息里。',
    '在 iPhone「文件」App 或 Mac 上点开压缩包、输入密码解压，得到一个表格文件（.csv 或 .xlsx），在这里选它。微信和支付宝的可以一起选。',
  ]],
  ['怎么对', [
    '账单上每一笔，在账本里找金额一样、日期差 2 天以内的，找到了就算记过了（AA 的几笔按总数对）。',
    '没找到的一笔笔给你看：类别是猜的，可以改；从哪个账户付的按付款方式猜，改过一次以后就记住了。',
    '转给个人的钱、红包默认「不记」：可能是 AA、还钱，这种去人情账记；真是买东西就点「记上」。',
    '开始记账之前的、退款的、转账充值提现这些不算钱花出去的，不用管。',
  ]],
];

let billState = null;

function billsView() {
  if (!billState) billState = { stage: 'pick' };
  const s = billState;
  const head = (sub) => headerSub('账单查漏记', sub, helpButton('账单查漏记怎么用', BILLS_HELP));
  if (s.stage === 'pick') return billsPick(head);
  if (s.stage === 'check') return billsCheck(head);
  if (s.stage === 'summary') return billsSummary(head);
  return billsDone(head);
}

function billsPick(head) {
  const d = store.data;
  const input = h('input', { type: 'file', accept: '.csv,.xlsx,text/csv', multiple: true, hidden: true, 'aria-label': '选账单文件',
    onchange: async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      try {
        const bills = [];
        const names = [];
        for (const f of files) {
          const parsed = parseBill(await readTable(f));
          bills.push(...parsed.rows);
          names.push(`${parsed.source === 'wechat' ? '微信' : '支付宝'}（${parsed.rows.length} 笔）`);
        }
        const result = matchBills(bills, d.tx, d.openingDate);
        const cats = d.categories.filter((c) => c.kind === 'expense' && !c.hidden && !AUTO_CATEGORIES.includes(c.id));
        const accounts = d.accounts.filter((a) => a.currency !== 'USD');
        const last = readJson(LAST_KEY).account;
        const remembered = d.settings.payMethods || {};
        billState = {
          stage: result.missing.length ? 'check' : 'done', step: 0, names, result, saved: [],
          lines: result.missing.map((b) => ({
            b, category: guessBillCategory(b, cats, d.tx, (name) => guessCategory(cats, d.tx, name)),
            account: guessAccount(b, accounts, remembered, last), note: b.party || b.product, skip: isPersonal(b), personal: isPersonal(b),
          })),
        };
        render();
      } catch (err) { toast(err.message, 'error'); }
    } });
  return h('div', {},
    head('看看有没有漏记的'),
    h('div', { class: 'card' },
      h('p', { class: 'small' }, '把微信、支付宝导出的账单拿来和账本对一对：记过的自动跳过，没记的一笔笔让你确认。'),
      h('ol', { class: 'small' }, BILLS_HELP[0][1].map((x) => h('li', {}, x)))),
    input,
    h('div', { class: 'actions sticky' }, h('button', { onclick: () => input.click() }, '选账单文件（.csv / .xlsx）')));
}

function billLine(l) {
  const b = l.b;
  return h('div', { class: 'bill-meta' },
    h('div', { class: 'bill-amount' }, exact(b.amount)),
    h('div', {}, h('b', {}, b.party || '（没写商家）'), b.product && b.product !== b.party ? h('span', { class: 'muted small block' }, b.product) : null),
    h('div', { class: 'muted small' }, `${b.source === 'wechat' ? '微信' : '支付宝'} · ${b.time.slice(5, 16)} · ${b.method}${b.type ? ` · ${b.type}` : ''}`));
}

function billsCheck(head) {
  const s = billState;
  const d = store.data;
  const n = s.lines.length;
  const l = s.lines[s.step];
  const go2 = (step) => { s.step = step; if (step >= n) s.stage = 'summary'; render(); window.scrollTo(0, 0); };
  const accounts = d.accounts.filter((a) => a.currency !== 'USD');
  const r = s.result;
  return h('div', {},
    head(`没记的第 ${s.step + 1} / ${n} 笔`),
    s.step === 0 ? h('p', { class: 'muted small' }, `${s.names.join('、')}：记过的 ${r.matched.length} 笔已经跳过${r.before.length ? `，开始记账前的 ${r.before.length} 笔不算` : ''}${r.skipped.length ? `，退款、转账充值等 ${r.skipped.length} 笔不算` : ''}。`) : null,
    h('div', { class: 'card' },
      billLine(l),
      l.personal ? h('p', { class: 'banner soon small' }, '这是转给个人的钱（转账 / 红包）。AA、还钱去「人情账」记；真是买东西、发红包就点「记上」。') : null,
      h('label', { class: 'form-label' }, '记成', categorySelect(l.category, (v) => { l.category = v; }, '类别')),
      h('div', { class: 'label-sm' }, '从哪个账户付'),
      h('div', { class: 'chips', role: 'group', 'aria-label': '账户' }, accounts.map((a) => h('button', {
        type: 'button', class: `chip${a.id === l.account ? ' on' : ''}`, 'aria-pressed': String(a.id === l.account),
        onclick: () => {
          // 同一种付款方式的，后面的一起改
          for (const x of s.lines.slice(s.step)) if (methodKey(x.b) === methodKey(l.b)) x.account = a.id;
          render();
        },
      }, a.name))),
      h('label', { class: 'form-label' }, '备注', h('input', { value: l.note, 'aria-label': '备注', oninput: (e) => { l.note = e.target.value; } }))),
    h('div', { class: 'actions sticky' },
      s.step > 0 ? h('button', { class: 'secondary', onclick: () => go2(s.step - 1) }, '上一笔') : null,
      h('button', { class: 'secondary', onclick: () => { l.skip = true; go2(s.step + 1); } }, '不记'),
      h('button', { onclick: () => { l.skip = false; go2(s.step + 1); } }, '记上')),
    s.step + 1 < n ? h('p', { class: 'center' }, h('button', { class: 'link small', onclick: () => go2(n) }, '剩下的都按推荐，直接看合计')) : null);
}

function billsSummary(head) {
  const s = billState;
  const keep = s.lines.filter((l) => !l.skip);
  const total = round2(keep.reduce((a, l) => a + l.b.amount, 0));
  return h('div', {},
    head('最后看一眼'),
    h('div', { class: 'section-title' }, `补记 ${keep.length} 笔，共 ${exact(total)}`),
    keep.length ? h('div', { class: 'card' }, keep.map((l) => h('div', { class: 'receipt-row' },
      h('span', { class: 'grow' }, `${l.note || catName(l.category)}`, h('span', { class: 'muted small block' }, `${l.b.date.slice(5)} · ${catName(l.category)} · ${accName(l.account)}`)),
      h('b', {}, exact(l.b.amount))))) : h('div', { class: 'card' }, h('p', { class: 'muted' }, '都不记。')),
    s.lines.some((l) => l.skip) ? h('p', { class: 'muted small' }, `不记：${s.lines.filter((l) => l.skip).map((l) => `${l.b.party || l.b.product} ${exact(l.b.amount)}`).join('、')}`) : null,
    h('div', { class: 'actions sticky' },
      h('button', { class: 'secondary', onclick: () => { s.stage = 'check'; s.step = 0; render(); } }, '回去改'),
      h('button', { onclick: saveBills }, keep.length ? '全部记上' : '完成')));
}

async function saveBills() {
  const s = billState;
  const keep = s.lines.filter((l) => !l.skip);
  const now = new Date().toISOString();
  if (keep.length) {
    try {
      await save(`账单补记：${keep.length} 笔 ${round2(keep.reduce((a, l) => a + l.b.amount, 0))}`, (data) => {
        const have = new Set(data.tx.map((t) => t.bill).filter(Boolean));
        for (const l of keep) {
          if (have.has(l.b.id)) continue; // 别的设备刚补过
          data.tx.push({
            id: newId('t'), type: 'expense', date: l.b.date, account: l.account, amount: l.b.amount, category: l.category,
            note: l.note.trim(), ...(FREEFORM.includes(l.category) ? { what: l.note.trim() || l.b.product || l.b.party } : {}),
            bill: l.b.id, billParty: l.b.party || undefined, createdAt: now,
          });
        }
        // 记住付款方式对应哪个账户，下次直接选好
        data.settings.payMethods = { ...(data.settings.payMethods || {}), ...Object.fromEntries(keep.map((l) => [methodKey(l.b), l.account])) };
      });
    } catch { return; }
  }
  s.saved = keep;
  s.stage = 'done';
  render();
}

function billsDone(head) {
  const s = billState;
  const total = round2(s.saved.reduce((a, l) => a + l.b.amount, 0));
  return h('div', {},
    head('对完了'),
    h('div', { class: 'card' },
      h('p', {}, s.lines.length ? `补记了 ${s.saved.length} 笔，共 ${exact(total)}。` : '没有漏记的，账本和账单对得上 ✓'),
      h('p', { class: 'muted small' }, `${s.names.join('、')}：记过的 ${s.result.matched.length} 笔。`)),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { billState = null; go('#/', true); } }, '回首页'),
      h('button', { class: 'secondary', onclick: () => { billState = null; render(); } }, '再对一份')));
}

// ---------- Siri 和快捷指令 ----------

function siriView() {
  const base = window.location.origin + window.location.pathname;
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('复制好了'); } catch { toast(text); } };
  const urlRow = (text) => h('div', { class: 'url-row' }, h('code', {}, text), h('button', { class: 'small secondary', onclick: () => copy(text) }, '复制'));
  return h('div', {},
    headerSub('Siri 和快捷指令', '说一句话、分享一下，就打开填好的页面'),
    h('div', { class: 'card' },
      h('h3', {}, '「嘿 Siri，记账」'),
      h('p', { class: 'small' }, '说「嘿 Siri，记账」→ 它问「记什么？」→ 你说「午饭 18」→ 账本打开，金额、类别、备注都填好了，点「记好了」。'),
      h('ol', { class: 'small' },
        h('li', {}, '打开 iPhone 自带的「快捷指令」App，右上角 ＋ 新建，名字改成「记账」（Siri 就是听这个名字）。'),
        h('li', {}, '添加操作「要求输入」：类型选「文本」，提示写「记什么？」。'),
        h('li', {}, '添加操作「URL 编码」：编码的内容选上一步的「提供的输入」。'),
        h('li', {}, '添加操作「打开 URL」：网址填下面这一串，然后在最后插入变量「URL 编码文本」。')),
      urlRow(`${base}#/add?text=`),
      h('p', { class: 'muted small' }, '说的时候带上数字就行：「打车 23.5」「奶茶 18 块 5」「超市买抽纸 19.9」。认不出类别的会空着，点一下就好。')),
    h('div', { class: 'card' },
      h('h3', {}, '「发到账本」：小票一步导进来'),
      h('p', { class: 'small' }, '在 AI 的回答上点分享，选「发到账本」，直接打开「导入小票」并贴好内容。'),
      h('ol', { class: 'small' },
        h('li', {}, '在「快捷指令」App 新建，名字「发到账本」。点下面的 ⓘ（详细信息）→ 打开「在共享表单中显示」，接收类型只留「文本」。'),
        h('li', {}, '顶上会出现「接收 文本 输入，如果没有输入：」→ 选「获取剪贴板」。这样复制了 AI 的回答再直接运行（或者说「嘿 Siri，发到账本」）也行。'),
        h('li', {}, '添加操作「URL 编码」：内容选「快捷指令输入」。'),
        h('li', {}, '添加操作「打开 URL」：网址填下面这一串，最后插入变量「URL 编码文本」。')),
      urlRow(`${base}#/receipt?text=`)),
    h('div', { class: 'card' },
      h('h3', {}, '第一次要注意'),
      h('ul', { class: 'small' },
        h('li', {}, '快捷指令打开的是 Safari，不是主屏幕上的账本图标。iPhone 上这两个各存各的，第一次在 Safari 打开会让你填一次令牌，填好以后就不用了。'),
        h('li', {}, '不会自动保存：页面打开后还是要你点一下确认，说错了、认错了都来得及改。'))));
}

// ---------- DeepSeek 密钥 ----------
// 先找账本仓库的 config/ai.json；没有就用物品档案仓库里的（同一个令牌能读两个仓库）
let aiCache = null;
async function aiConfig() {
  if (aiCache) return aiCache;
  const read = async (g) => {
    try { return JSON.parse(await g.readText('config/ai.json', 'main'))?.deepseek || null; } catch { return null; }
  };
  let inv = {};
  try { inv = JSON.parse(localStorage.getItem('inventory-settings')) || {}; } catch { /* 没有物品档案 */ }
  aiCache = (await read(gh)) || (await read(new GitHub({ token: settings.token, repo: inv.repo || 'ThreeLu/inventory-data' }))) || {};
  return aiCache;
}

// 花在哪了：圆环 + 每组一行。点圆环的一段或者一行：这一段突出、其他变淡，对应那一行亮一下，
// 中间换成这一组的钱和占比，下面列出这一组里花在哪些类别。再点一下（或点空白）回到全部
function spendDonut(st, groups, { sub, title, extra = () => null }) {
  const d = store.data;
  const ring = donut(groups.map((g) => ({ key: g.id, name: g.name, v: st.byGroup[g.id], color: g.color })), { center: money(st.total), sub, title });
  ring.setAttribute('aria-label', `${title}，点一段看这一组`);
  const num = ring.querySelector('.donut-num');
  const subEl = ring.querySelector('.donut-sub');
  const detail = h('div', { class: 'donut-detail', 'aria-live': 'polite' });
  const rows = {};
  let sel = null;
  const pick = (id) => {
    sel = sel === id ? null : id;
    ring.classList.toggle('has-sel', Boolean(sel));
    for (const c of ring.querySelectorAll('.seg')) c.classList.toggle('on', c.dataset.key === sel);
    for (const [k, el] of Object.entries(rows)) {
      el.classList.toggle('on', k === sel);
      el.setAttribute('aria-pressed', String(k === sel));
      el.classList.remove('glow');
    }
    if (!sel) {
      num.textContent = money(st.total);
      if (subEl) subEl.textContent = sub;
      detail.replaceChildren();
      return;
    }
    const g = groups.find((x) => x.id === sel);
    const v = st.byGroup[sel];
    num.textContent = money(v);
    if (subEl) subEl.textContent = `${g.name} · ${st.total ? Math.round((v / st.total) * 100) : 0}%`;
    void rows[sel].offsetWidth; // 重新触发动画
    rows[sel].classList.add('glow');
    const cats = Object.entries(st.byCat || {}).filter(([id]) => (category(d, id)?.group || 'daily') === sel).sort((a, b) => b[1].v - a[1].v);
    const max = cats[0]?.[1].v || 1;
    detail.replaceChildren(h('div', { class: 'donut-detail-box', style: `--c:${g.color}` },
      h('div', { class: 'small muted' }, `${g.name}里花在哪`),
      cats.length ? null : h('p', { class: 'muted small' }, '这段时间这一组没有花销。'),
      cats.map(([id, c]) => h('div', { class: 'budget-row' },
        h('div', { class: 'budget-top' }, h('span', {}, catName(id), h('span', { class: 'muted small' }, `　${c.n} 笔`)), h('span', { class: 'muted' }, money(c.v))),
        bar(c.v / max, g.color)))));
  };
  ring.addEventListener('click', (e) => {
    const key = e.target.closest?.('.seg')?.dataset.key;
    pick(key || sel); // 点中间空白 = 收起
  });
  const legend = h('div', { class: 'donut-legend' }, groups.map((g) => {
    rows[g.id] = h('button', { type: 'button', class: 'legend-row', style: `--c:${g.color}`, 'aria-pressed': 'false', onclick: () => pick(g.id) },
      h('span', {}, h('i', { style: `background:${g.color}` }), g.name), h('b', {}, money(st.byGroup[g.id])), extra(g));
    return rows[g.id];
  }));
  return h('div', {}, h('div', { class: 'donut-row' }, ring, legend), detail);
}

// ---------- 心愿单 ----------

// 想要的程度，从低到高（老心愿只有 very / nice，键名不变）
const WANT = { bit: '有点想', nice: '有了更好', want: '想要', very: '很想要', most: '非常想要' };
const WANT_RANK = Object.fromEntries(Object.keys(WANT).map((k, i) => [k, i]));
const WISH_KIND = { need: '生活必需品', grow: '提升自己', joy: '提升幸福感', feel: '情怀', gift: '送人' }; // 选填，老心愿没有
// 心愿单排序：只改显示，大额的攒钱顺序只在选「攒钱顺序」时用 ↑↓ 调
const WISH_SORTS = { order: '攒钱顺序', cool: '冷静期', price: '价格', want: '想要程度', new: '加入时间', ai: 'DeepSeek 建议' };
const WISH_SORT_KEY = 'ledger-wish-sort';
const NEED_CLASS = { 需要: 'good-text', 想要: 'soon', 说不准: 'muted' };

function wishHelp(d) {
  const big = money(d.settings.wishBigFrom);
  return [
    ['心愿单是什么', ['想买、但不急，有闲钱才买的东西。先放进来，冷静几天再决定。', `${big} 以内是小额心愿，超过 ${big} 是大额心愿。`]],
    ['小额心愿的钱', ['心愿基金：每个预算月结束时，吃饭 + 日常 + 自由钱没花完的，自动进心愿基金；哪个月超了，从基金里扣回来（扣到 0 为止）。',
      d.settings.sideIncomeSave != null ? `兼职收入的 ${Math.round((1 - d.settings.sideIncomeSave) * 100)}% 也自动进心愿基金（记兼职收入时就算进来）。` : '',
      '省下来的钱就能拿去买想要的小东西，存款一分不动。'].filter(Boolean)],
    ['大额心愿的钱', [`从每月存下的钱里给大额心愿攒，所有大额心愿加起来每月最多 ${money(d.settings.wishMonthlyCap)}。`, '按心愿单的顺序一个一个攒，攒够一个再攒下一个。排序选「攒钱顺序」时，用 ↑↓ 调顺序。']],
    ['排序', ['列表上面可以按冷静期、价格、想要程度、加入时间、DeepSeek 建议的顺序排。只是换个看法，不会改攒钱的顺序。', '价格点第二下，会在低→高和高→低之间切换。']],
    ['冷静期', [`新加的心愿先冷静 ${d.settings.coolDays} 天。过了几天还想要，再考虑买。`]],
    ['买了以后', ['点「买了」，钱从心愿基金或攒好的那份里出，记一笔「心愿」花销，不占当月预算。', '钱一直在你的卡里，网站只是记着这里面有多少是给心愿的，不用转账。']],
    ['DeepSeek', ['点「问问 DeepSeek」：先买哪个、什么时候买、真需要还是一时想要。它查不到实时价格，价格以你填的为准。']],
  ];
}

function wishForm(w = null) {
  const d = store.data;
  const name = h('input', { value: w?.name || '', placeholder: '比如 降噪耳机', 'aria-label': '想要什么' });
  const price = h('input', { inputmode: 'decimal', value: w?.price != null ? String(w.price) : '', placeholder: '大概多少钱', 'aria-label': '价格' });
  let want = w?.want || 'very';
  const wantBox = h('div', { class: 'chips', role: 'group', 'aria-label': '想要的程度' });
  const drawWant = () => wantBox.replaceChildren(...Object.entries(WANT).map(([k, t]) => h('button', {
    type: 'button', class: `chip${want === k ? ' on' : ''}`, 'aria-pressed': String(want === k), onclick: () => { want = k; drawWant(); },
  }, t)));
  drawWant();
  let kind = w?.kind || '';
  const kindBox = h('div', { class: 'chips', role: 'group', 'aria-label': '分类' });
  const drawKind = () => kindBox.replaceChildren(...Object.entries(WISH_KIND).map(([k, t]) => h('button', {
    type: 'button', class: `chip${kind === k ? ' on' : ''}`, 'aria-pressed': String(kind === k), onclick: () => { kind = kind === k ? '' : k; drawKind(); drawTarget(); },
  }, t)));
  drawKind();
  const reason = h('input', { value: w?.reason || '', placeholder: '为什么想要（选填）', 'aria-label': '为什么想要' });
  const link = h('input', { value: w?.link || '', placeholder: '链接或备注（选填）', 'aria-label': '链接或备注' });
  const target = h('input', { type: 'date', value: w?.targetDate || '', 'aria-label': '想在什么时候前买到' });
  const targetLabel = h('label', {}, '', target);
  const drawTarget = () => { targetLabel.firstChild.textContent = kind === 'gift' ? '要在哪天前送出去（送人的东西最好填）' : '想在什么时候前买到（选填）'; };
  drawTarget();
  openSheet({
    title: w ? '改心愿' : '加一个心愿',
    body: h('div', { class: 'form' }, name, price, h('div', { class: 'label-sm' }, '想要的程度'), wantBox, h('div', { class: 'label-sm' }, '分类（选填）'), kindBox, reason, link, targetLabel,
      h('p', { class: 'muted small' }, `${money(d.settings.wishBigFrom)} 以内是小额心愿，用心愿基金买；超过的是大额心愿，每月慢慢攒。`)),
    confirmText: w ? '保存' : '加进心愿单',
    onConfirm: async () => {
      const n = Number(price.value.replace(/[，,\s¥]/g, ''));
      if (!name.value.trim()) { toast('写一下想要什么', 'error'); return false; }
      if (!(n > 0)) { toast('填一个大概的价格', 'error'); return false; }
      const fields = { name: name.value.trim(), price: round2(n), want, kind, reason: reason.value.trim(), link: link.value.trim(), targetDate: target.value || '' };
      try {
        await save(`${w ? '改心愿' : '新心愿'}：${fields.name}`, (data) => {
          if (w) Object.assign(data.wishes.find((x) => x.id === w.id), fields);
          else data.wishes.push({ id: newId('w'), ...fields, createdAt: today(), status: 'open' });
        });
        render();
      } catch { return false; }
      return true;
    },
  });
}

function buyWish(w, fundLeft) {
  const d = store.data;
  const big = isBigWish(d, w);
  const price = h('input', { inputmode: 'decimal', value: String(w.price), 'aria-label': '实际花了多少' });
  let acc = readJson(LAST_KEY).account;
  if (!account(d, acc)) acc = d.accounts[0]?.id;
  const accBox = h('div', { class: 'chips', role: 'group', 'aria-label': '从哪个账户付' });
  const drawAcc = () => accBox.replaceChildren(...d.accounts.map((a) => h('button', {
    type: 'button', class: `chip${a.id === acc ? ' on' : ''}`, 'aria-pressed': String(a.id === acc), onclick: () => { acc = a.id; drawAcc(); },
  }, a.name)));
  drawAcc();
  const hint = h('p', { class: 'small muted' });
  const drawHint = () => {
    const n = Number(price.value.replace(/[，,\s]/g, '')) || 0;
    hint.textContent = big
      ? (n > fundLeft ? `给它攒了 ${money(fundLeft)}，还差 ${money(n - fundLeft)}，差的部分直接用存款。` : `给它攒的 ${money(fundLeft)} 够了。`)
      : (n > fundLeft ? `心愿基金只有 ${money(fundLeft)}，差的 ${money(n - fundLeft)} 算进这个月的自由钱。` : `从心愿基金出，还剩 ${money(fundLeft - n)}。`);
  };
  price.addEventListener('input', drawHint);
  drawHint();
  const cooling = coolingLeft(d, w, today());
  openSheet({
    title: `买了「${w.name}」`,
    body: h('div', { class: 'form' },
      cooling ? h('p', { class: 'small soon' }, `还在冷静期（还剩 ${cooling} 天）。确定现在就买吗？`) : null,
      h('label', {}, '实际花了多少', price), hint, h('div', { class: 'label-sm' }, '从哪个账户付'), accBox),
    confirmText: '记好了',
    onConfirm: async () => {
      const n = round2(Number(price.value.replace(/[，,\s]/g, '')));
      if (!(n > 0)) { toast('填一下花了多少', 'error'); return false; }
      const usd = isUsd(d, acc);
      const rate = usdRate();
      // 小额心愿超出基金的部分算自由钱；大额心愿全部算「心愿」（钱是存款里攒的）
      const fromFund = big ? n : Math.min(n, Math.max(0, fundLeft));
      const rest = round2(n - fromFund);
      try {
        await save(`买了心愿：${w.name} ${n}`, (data) => {
          const now = new Date().toISOString();
          const mk = (amount, cat) => ({ id: newId('t'), type: 'expense', date: today(), account: acc, amount, category: cat, note: w.name,
            wish: w.id, wishKind: big ? 'big' : 'small', createdAt: now, ...(usd ? { cny: round2(amount * rate) } : {}) });
          if (fromFund > 0) data.tx.push(mk(round2(fromFund), 'c-wish'));
          if (rest > 0) data.tx.push(mk(rest, 'c-like'));
          Object.assign(data.wishes.find((x) => x.id === w.id), { status: 'bought', boughtAt: today(), boughtPrice: n });
        });
        toast(`恭喜，「${w.name}」到手了`);
        render();
      } catch { return false; }
      return true;
    },
  });
}

async function askWishAdvice(btn) {
  const d = store.data;
  const ai = await aiConfig();
  const t = today();
  const f = wishFunds(d, t);
  const plan = bigWishPlan(d, t);
  const hl = health(d, t, usdRate());
  const open = d.wishes.filter((w) => w.status === 'open');
  if (!open.length) return toast('心愿单是空的', 'error');
  const recent = closedPeriods(d, t).slice(-3).map((p) => {
    const st = periodStats(d, p);
    return `${p.label}：生活花了 ${Math.round(st.living)} / 预算 ${Math.round(livingBudget(d) * partial(d, p).factor)}`;
  });
  const system = [
    '你是一个大学生的理财助手。他对理财不太懂，有点焦虑，想稳定地存钱。说话温和、简短、具体，不说教。',
    '他有一个心愿单：想买但不急、有闲钱才买的东西。小额心愿用「心愿基金」（每月生活预算省下来的钱）买；大额心愿按顺序每月慢慢攒，所有大额心愿每月合计有上限。',
    '请看心愿单给建议：',
    '1. 先买哪个：给出顺序（order，id 列表）。考虑想要的程度（有点想 < 有了更好 < 想要 < 很想要 < 非常想要）、分类（生活必需品最优先，提升自己其次；提升幸福感和情怀差不多；送人的看日子，快到了要往前排）、价格、钱够不够、是不是刚加进来还在冷静期。',
    '2. 什么时候买（when，一句话）：结合心愿基金、已攒的钱和预计攒够的时间；只在相关时提一下常见的大促（比如双十一、618）或教育优惠，不要每条都提。',
    '3. 真需要还是一时想要（need：需要 / 想要 / 说不准），comment 用一两句话说理由，可以提一个值得想想的问题。',
    '你查不到实时价格，不要编价格。不要建议动应急钱或存款，不要推荐分期、花呗、信用卡。',
    `4. ${INVENTORY_RULE}写在那一条的 comment 里。`,
    '只输出 JSON：{"summary":"一两句话总的建议","order":["id"],"items":[{"id":"","when":"","need":"需要","comment":""}]}',
  ].join('\n');
  const user = [
    `今天 ${t}。`,
    `心愿基金（小额用）：${money(f.small)}。大额心愿每月最多攒 ${money(f.cap)}，按顺序一个一个攒。小额 / 大额的分界：${money(d.settings.wishBigFrom)}。`,
    `这个预算月生活预算还剩 ${money(Math.max(0, hl.left))}，还有 ${hl.daysLeft} 天。安全垫 ${hl.items.find((x) => x.key === 'cushion')?.value || ''}。`,
    recent.length ? `最近几个预算月：${recent.join('；')}` : '刚开始记账，还没有完整的预算月。',
    d.settings.summerMonths?.length ? `${d.settings.summerMonths.join('、')} 月没有收入。` : '',
    (await inventoryContext()).trim(),
    '心愿单（id | 名称 | 价格 | 小额/大额 | 想要程度 | 分类 | 为什么想要 | 加进来几天 | 已攒 | 预计攒够 | 想在什么时候前买到）：',
    ...open.map((w) => {
      const big = isBigWish(d, w);
      const pl = plan.find((x) => x.w.id === w.id);
      return [w.id, w.name, w.price, big ? '大额' : '小额', WANT[w.want] || '', WISH_KIND[w.kind] || '-', w.reason || '-', daysSince(w.createdAt),
        big ? pl?.saved ?? 0 : '-', big ? pl?.ready || '很久以后' : '-', w.targetDate || '-'].map((x) => String(x).replace(/\|/g, '/')).join(' | ');
    }),
  ].filter(Boolean).join('\n');
  btn.disabled = true;
  btn.textContent = 'DeepSeek 正在想……';
  try {
    const out = await askJson(ai, system, user, { maxTokens: 6000, timeout: 120000 });
    const ids = new Set(open.map((w) => w.id));
    const advice = {
      at: t, summary: String(out.summary || ''),
      order: (out.order || []).filter((id) => ids.has(id)),
      items: Object.fromEntries((out.items || []).filter((x) => ids.has(x.id)).map((x) => [x.id, { when: String(x.when || ''), need: String(x.need || ''), comment: String(x.comment || '') }])),
    };
    await save('心愿单：DeepSeek 的建议', (data) => { data.wishAdvice = advice; });
    render();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = '问问 DeepSeek';
  }
}

function wishesView() {
  const d = store.data;
  const t = today();
  const f = wishFunds(d, t);
  const plan = bigWishPlan(d, t);
  const adv = d.wishAdvice;
  const open = d.wishes.filter((w) => w.status === 'open');
  const small = open.filter((w) => !isBigWish(d, w));
  const big = open.filter((w) => isBigWish(d, w));
  const done = d.wishes.filter((w) => w.status !== 'open').reverse();
  const last = f.log.at(-1);
  const upd = (message, fn) => save(message, fn).then(render).catch(() => {});

  const move = (id, dir) => upd('调整心愿顺序', (data) => {
    const list = data.wishes;
    const bigIds = list.filter((w) => w.status === 'open' && isBigWish(data, w)).map((w) => w.id);
    const i = bigIds.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= bigIds.length) return false;
    const a = list.findIndex((w) => w.id === bigIds[i]);
    const b = list.findIndex((w) => w.id === bigIds[j]);
    [list[a], list[b]] = [list[b], list[a]];
  });
  const drop = (w) => saveUndoable(`放弃心愿：${w.name}`, (data) => { Object.assign(data.wishes.find((x) => x.id === w.id), { status: 'dropped', droppedAt: today() }); },
    `「${w.name}」挪到放弃的心愿，省下 ${money(w.price)}`).then(render).catch(() => {});

  let sort = { by: 'order', desc: false, ...readJson(WISH_SORT_KEY) };
  if (!WISH_SORTS[sort.by] || (sort.by === 'ai' && !adv)) sort = { by: 'order', desc: false };
  const byOrder = sort.by === 'order';
  const sorted = (list) => {
    if (byOrder) return list;
    const key = {
      cool: (w) => coolingLeft(d, w, t),
      price: (w) => Number(w.price) * (sort.desc ? -1 : 1),
      want: (w) => -(WANT_RANK[w.want] ?? 0),
      new: (w) => -Date.parse(w.createdAt),
      ai: (w) => { const i = adv.order?.indexOf(w.id) ?? -1; return i < 0 ? 1e9 : i; },
    }[sort.by];
    return list.map((w, i) => ({ w, i, k: key(w) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.w);
  };
  const setSort = (by) => {
    writeJson(WISH_SORT_KEY, { by, desc: by === 'price' && sort.by === 'price' ? !sort.desc : false });
    render();
  };
  const sortBar = h('div', { class: 'chips wish-sort', role: 'group', 'aria-label': '排序' },
    Object.entries(WISH_SORTS).filter(([k]) => k !== 'ai' || adv).map(([k, label]) => h('button', {
      type: 'button', class: `chip${sort.by === k ? ' on' : ''}`, 'aria-pressed': String(sort.by === k), onclick: () => setSort(k),
    }, k === 'price' && sort.by === 'price' ? `价格 ${sort.desc ? '高→低' : '低→高'}` : label)));

  const card = (w, bigIndex = -1) => {
    const isBig = bigIndex >= 0;
    const pl = isBig ? plan.find((x) => x.w.id === w.id) : null;
    const cooling = coolingLeft(d, w, t);
    const a = adv?.items?.[w.id];
    const rank = adv?.order?.indexOf(w.id);
    const ready = isBig ? pl.saved >= w.price : f.small >= w.price;
    return h('div', { class: 'card wish' },
      h('div', { class: 'wish-top' },
        h('div', { class: 'grow' },
          h('div', { class: 'wish-name' }, rank >= 0 ? h('span', { class: 'wish-rank' }, `${rank + 1}`) : null, w.name),
          h('div', { class: 'muted small' }, [WANT[w.want], w.reason, w.link].filter(Boolean).join(' · '))),
        h('div', { class: 'wish-price' }, money(w.price))),
      h('div', { class: 'wish-tags' },
        w.kind ? h('span', { class: 'badge' }, WISH_KIND[w.kind]) : null,
        cooling ? h('span', { class: 'badge' }, `冷静中，还剩 ${cooling} 天`) : null,
        ready ? h('span', { class: 'badge good' }, isBig ? '攒够了' : '心愿基金够了') : null,
        w.targetDate && isBig && pl.ready && pl.ready > w.targetDate ? h('span', { class: 'badge warn' }, `${md(w.targetDate)}前攒不够`) : null),
      isBig ? [bar(pl.saved / w.price, 'var(--accent)'),
        h('div', { class: 'muted small wish-progress' }, `已攒 ${money(pl.saved)} / ${money(w.price)}${pl.ready && !ready ? ` · 按现在的顺序，预计 ${md(pl.ready)}攒够` : !pl.ready ? ' · 排在后面，要等前面的攒完' : ''}`)] : null,
      a ? h('div', { class: 'wish-ai' },
        a.need ? h('span', { class: `need ${NEED_CLASS[a.need] || ''}` }, a.need) : null,
        a.when ? h('div', {}, h('b', {}, '什么时候买：'), a.when) : null,
        a.comment ? h('div', {}, a.comment) : null) : null,
      h('div', { class: 'wish-actions' },
        isBig && byOrder ? [h('button', { class: 'link', 'aria-label': `${w.name} 往前排`, disabled: bigIndex === 0, onclick: () => move(w.id, -1) }, '↑'),
          h('button', { class: 'link', 'aria-label': `${w.name} 往后排`, disabled: bigIndex === big.length - 1, onclick: () => move(w.id, 1) }, '↓')] : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'link', onclick: () => wishForm(w) }, '改'),
        h('button', { class: 'link', onclick: () => drop(w) }, '不想要了'),
        h('button', { class: 'small', onclick: () => buyWish(w, isBig ? pl.saved : f.small) }, '买了')));
  };

  const savedByDrop = done.filter((w) => w.status === 'dropped').reduce((s2, w) => s2 + Number(w.price), 0);
  const aiBtn = h('button', { class: 'secondary wide', onclick: (e) => askWishAdvice(e.currentTarget) }, icon('sparkle'), adv ? '再问一次 DeepSeek' : '问问 DeepSeek');
  return h('div', {},
    header('心愿单', h('button', { class: 'icon-btn', 'aria-label': '加一个心愿', onclick: () => wishForm() }, icon('plus')), helpButton('心愿单怎么用', wishHelp(d))),
    h('div', { class: 'card spend-left' },
      h('div', { class: 'muted small' }, '心愿基金（买小额心愿用）'),
      h('div', { class: 'big-num' }, money(f.small)),
      h('div', { class: 'muted small' }, last ? `${last.p.label}${last.leftover >= 0 ? `省下 ${money(last.leftover)}，进来了` : `超了 ${money(-last.leftover)}，从基金里扣了 ${money(-last.change)}`}`
        : '每个预算月结束时，生活预算没花完的会进来。'),
      f.fromJobs ? h('div', { class: 'muted small' }, `其中兼职收入的三成进来了 ${money(f.fromJobs)}`) : null,
      h('div', { class: 'muted small' }, `大额心愿每月最多攒 ${money(f.cap)}`)),
    open.length ? h('div', { class: 'card' },
      adv ? [h('h3', {}, `DeepSeek 的建议（${md(adv.at)}）`), h('p', { class: 'ai-summary' }, adv.summary)] : h('p', { class: 'muted small' }, 'DeepSeek 可以帮你看：先买哪个、什么时候买、真需要还是一时想要。'),
      aiBtn) : null,
    open.length > 1 ? sortBar : null,
    small.length ? [h('div', { class: 'section-title' }, `小额心愿（${money(d.settings.wishBigFrom)} 以内，用心愿基金）`), sorted(small).map((w) => card(w))] : null,
    big.length ? [h('div', { class: 'section-title' }, `大额心愿（按顺序攒，每月最多 ${money(f.cap)}）`), sorted(big).map((w) => card(w, big.indexOf(w)))] : null,
    !open.length ? h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有心愿。想买但不急的东西，点右上角 ＋ 放进来。')) : null,
    done.length ? h('details', { class: 'card done-wishes' }, h('summary', {}, `实现了 ${done.filter((w) => w.status === 'bought').length} 个 · 放弃了 ${done.filter((w) => w.status === 'dropped').length} 个${savedByDrop ? `（省下 ${money(savedByDrop)}）` : ''}`),
      done.map((w) => h('div', { class: 'manage-row' },
        h('span', { class: 'grow' }, w.name, h('span', { class: 'muted small block' }, w.status === 'bought' ? `${md(w.boughtAt)}买的 · ${money(w.boughtPrice)}` : `${md(w.droppedAt || w.createdAt)}放弃`)),
        w.status === 'dropped' ? h('button', { class: 'link', onclick: () => upd(`重新想要：${w.name}`, (data) => { const x = data.wishes.find((y) => y.id === w.id); x.status = 'open'; delete x.droppedAt; }) }, '又想要了') : null))) : null);
}

// ---------- 买不买（聊天）----------
// 网站先把价格换算、硬规则算好，连同汇总数字一起给 DeepSeek；DeepSeek 负责聊和给建议。
// 聊天记录只在这次打开的页面里；只有「做了什么决定」会存进账本（data.decisions），一个月后回访。

const chatState = { messages: [], busy: false, draft: '' }; // draft：打了一半的问题，页面重画时不丢
const REVIEW_DAYS = 30;
const VERDICT = { buy: '可以买', wait: '等等再说', no: '不建议' };

// 从一句话里找价格：「想买个 1200 的键盘」→ 1200
function priceIn(text) {
  const m = String(text).replace(/[，,]/g, '').match(/(\d+(?:\.\d+)?)\s*(?:块|元|¥|rmb|RMB|w|万)?/);
  if (!m) return null;
  const n = Number(m[1]) * (/万|w/.test(m[0]) ? 10000 : 1);
  return n >= 1 ? n : null;
}

// 价格换算成有感觉的说法 + 两条硬规则
function priceFacts(d, price) {
  const t = today();
  const hl = health(d, t, usdRate());
  const plan = yearPlan(d);
  const perDayFood = (Number(d.budget.food) || 0) / 30.4;
  const free = Number(d.budget.free) || 0;
  const yearSave = plan.yearIn ? plan.yearIn - plan.yearOut : 0;
  // 能动用的钱：所有账户 − 应急钱底线 − 这个月还要花的生活费
  const social = socialPlan(d, t).filter((x) => x.big && x.due <= addDays(t, 90)).reduce((a, x) => a + x.amount, 0); // 三个月内的大额人情：这笔钱已经有用处了
  const usable = hl.assets - (d.settings.emergencyFloor || 0) - Math.max(0, hl.left) - social;
  const big = price > (d.settings.wishBigFrom ?? 300);
  const facts = [];
  if (perDayFood) facts.push(`相当于 ${(price / perDayFood).toFixed(price / perDayFood < 10 ? 1 : 0)} 天的饭钱`);
  if (free) facts.push(`相当于 ${(price / free).toFixed(1)} 个月的自由钱`);
  if (hl.left > 0) facts.push(`是这个月还能花的 ${money(hl.left)} 的 ${Math.round((price / hl.left) * 100)}%`);
  if (yearSave > 0) facts.push(`如果从存款出，一年存钱目标晚 ${Math.max(1, Math.round(price / (yearSave / 365)))} 天左右达成`);
  if (social) facts.push(`三个月内还有 ${money(social)} 的人情（随礼）要用，已经从能动用的钱里扣掉了`);
  if (big && d.settings.wishMonthlyCap) facts.push(`按大额心愿每月最多攒 ${money(d.settings.wishMonthlyCap)}，要攒 ${Math.ceil(price / d.settings.wishMonthlyCap)} 个月`);
  return {
    price, facts, big,
    floorBreak: price > usable, // 硬规则 1：会动到应急钱
    cool: big, // 硬规则 2：大额先冷静几天
    usable,
  };
}

// 给 DeepSeek 的背景：只有汇总数字，不发每一笔流水
function moneyContext(d) {
  const t = today();
  const hl = health(d, t, usdRate());
  const st = hl.stats;
  const part = partial(d, hl.period);
  const rc = receivables(d);
  const f = wishFunds(d, t);
  const groupLine = GROUPS.filter((g) => d.budget[g.id]).map((g) => `${g.name} 已花 ${Math.round(st.spent[g.id])} / 预算 ${Math.round(d.budget[g.id] * part.factor)}`).join('；');
  const hist = closedPeriods(d, t).slice(-3).map((p) => {
    const s = periodStats(d, p);
    const top = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, v]) => `${catName(id)} ${Math.round(v)}`).join('、');
    return `${p.label}：收入 ${Math.round(s.income)}，花 ${Math.round(s.total)}（${top}）`;
  });
  const ups = upcoming(d, t, 35).map((u) => `${md(u.date)} ${u.r.name} ${u.r.amount}${isUsd(d, u.r.account) ? ' 美元' : ' 元'}`);
  const wishes = d.wishes.filter((w) => w.status === 'open').map((w) => `${w.name} ${w.price}${isBigWish(d, w) ? `（大额，已攒 ${Math.round(f.saved[w.id] || 0)}）` : '（小额）'}`);
  const decisions = (d.decisions || []).slice(-8).map((x) => `${x.at} ${x.item} ${x.price || ''} → ${{ buy: '买了', wish: '放进心愿单', skip: '没买' }[x.choice] || ''}${x.review ? `，回访：${{ worth: '值', meh: '一般', regret: '后悔' }[x.review]}` : ''}`);
  return [
    `今天 ${t}，预算月 ${hl.period.label} 第 ${hl.period.dayIndex} 天，还剩 ${hl.daysLeft} 天。`,
    `每月预算：${GROUPS.filter((g) => d.budget[g.id]).map((g) => `${g.name} ${d.budget[g.id]}`).join('、')}。这个预算月：${groupLine}。生活（吃饭+日常+自由钱）还能花 ${Math.round(hl.left)}，平均每天 ${Math.max(0, Math.round(hl.perDay))}。`,
    `收入：每月正常 ${d.settings.expectedIncome || '?'}${d.settings.summerMonths?.length ? `，${d.settings.summerMonths.join('、')} 月没有收入` : ''}；这个预算月已到 ${Math.round(st.income)}${part.isPartial ? '（这个月是开始记账的第一个月，之前到的没记）' : ''}。`,
    `总资产 ${Math.round(hl.assets)}，应急钱底线 ${d.settings.emergencyFloor || 0}，安全垫 ${hl.items.find((x) => x.key === 'cushion')?.value || ''}。`,
    rc.toMe || rc.iOwe ? `待收回 ${Math.round(rc.toMe)}（还不在手里，不能当能花的钱），欠别人 ${Math.round(rc.iOwe)}。` : '',
    ups.length ? `接下来要扣：${ups.join('；')}。` : '',
    socialPlan(d, t).length ? `要准备的人情钱（${FAVOR_BIG} 以上的已经算进存款目标，要从存款里留出来；以下的从日常预算里出）：${socialPlan(d, t).map((x) => `${x.due} ${x.name}「${x.f.text}」约 ${Math.round(x.amount)}${x.big ? '（大额）' : ''}`).join('；')}。买东西时要把这些钱考虑进去。` : '',
    `心愿基金（小额用）${Math.round(f.small)}；大额心愿每月最多攒 ${d.settings.wishMonthlyCap}，${d.settings.wishBigFrom} 以上算大额。心愿单：${wishes.join('、') || '空'}。`,
    hist.length ? `最近几个预算月：${hist.join('；')}。` : '刚开始记账，还没有完整的预算月。',
    decisions.length ? `以前问过的：${decisions.join('；')}。` : '',
    `规则：先存后花；自由钱每月 ${d.budget.free || 0} 花了不用内疚；${d.settings.wishBigFrom} 以上的东西先冷静 ${d.settings.coolDays} 天、放进心愿单慢慢攒；不动应急钱。`,
  ].filter(Boolean).join('\n');
}

// 物品档案里已有的东西（买不买、心愿单发给 DeepSeek，用户 2026-10-04 要求：买之前看看已经有没有类似的）
// 每行：名称 | 类别 | 数量 | 颜色季节等 | 穿了几次（衣服鞋）、最近 30 天几次 | 价格。不发照片、序列号、备注。
const invCache = { at: 0, text: '' };
async function inventoryContext() {
  if (Date.now() - invCache.at < 5 * 60000) return invCache.text;
  let inv = null;
  try { inv = await readInventory(inventoryGitHub(settings)); } catch { /* 读不到就不带 */ }
  const since = addDays(today(), -30);
  const lines = (inv?.items || []).filter((i) => !i.archived).slice(0, 400).map((i) => {
    const f = i.fields || {};
    const fields = ['部位', '颜色', '季节', '厚薄', '风格'].filter((k) => f[k]).map((k) => f[k]).join('/');
    const worn = Array.isArray(i.worn) ? `穿了 ${i.worn.length} 次（近 30 天 ${i.worn.filter((x) => x >= since).length} 次）` : '';
    return [i.name, i.tags?.[0] || '', `×${i.quantity ?? 1}`, fields, worn, i.purchasePrice ? `¥${i.purchasePrice}` : ''].map((x) => String(x).replace(/\|/g, '/')).join(' | ');
  });
  invCache.at = Date.now();
  invCache.text = lines.length ? ['', `他宿舍里已经有的东西（物品档案，${lines.length} 件；名称 | 类别 | 数量 | 部位颜色季节等 | 穿的次数 | 价格）：`, ...lines].join('\n') : '';
  return invCache.text;
}
const INVENTORY_RULE = '他想买东西时，先看下面「已经有的东西」里有没有类似的：有的话点出来（比如「你已经有 3 件灰色卫衣，最近一个月只穿了 1 次」），用得多不多也说一句；只是提醒，买不买他自己定。没有类似的就不用提。';

async function askMoney(question) {
  const d = store.data;
  const ai = await aiConfig();
  const price = priceIn(question);
  const pf = price ? priceFacts(d, price) : null;
  const system = [
    '你是一个大学生的理财小助手，帮他想清楚「这个东西买不买」，也回答关于他自己花钱情况的问题。',
    '他对理财不太懂，有点焦虑，想稳定存钱，但也不想过得太紧。说话像朋友：温和、简短、具体，用大白话，不说教，不吓唬人。',
    '数字只用下面给的，不要编。不推荐任何具体的理财产品、基金、股票；不建议花呗、信用卡、分期、借钱消费。',
    '他问要不要买某个东西时：如果还不清楚，先问 1～2 个关键问题（现在用的坏了还是只是想换？多久用一次？有没有便宜的替代？能不能等等？）；清楚了再给结论。',
    '结论用 verdict：buy（可以买）、wait（等等再说，比如先放进心愿单冷静几天、等大促、等心愿基金够）、no（不建议）。还在问问题时 verdict 为 null。',
    '网站算好的「硬规则」必须遵守：会动到应急钱的，verdict 必须是 no；大额的东西就算值得买，也要建议先冷静几天、放进心愿单。',
    '他问别的（比如这个月花得怎么样、钱花哪了、某个理财概念）就直接回答，verdict 为 null。',
    'answer 控制在 150 字以内，可以分几行。item 是他想买的东西（名称和价格，价格不知道就 null），不是买东西的问题就 null。',
    INVENTORY_RULE,
    '只输出 JSON：{"answer":"","verdict":null,"item":{"name":"","price":null}}',
    '',
    '他的情况（汇总数字）：',
    moneyContext(d),
    await inventoryContext(),
  ].join('\n');
  const extra = pf ? [
    '',
    `网站对「${money(pf.price)}」算好的：${pf.facts.join('；')}。`,
    `硬规则：${pf.floorBreak ? `会动到应急钱（能动用的钱只有 ${money(Math.max(0, pf.usable))}）→ 必须不建议。` : '不会动到应急钱。'}${pf.cool ? ` 超过 ${d.settings.wishBigFrom}，属于大额 → 建议先冷静 ${d.settings.coolDays} 天。` : ''}`,
  ].join('\n') : '';
  const history = chatState.messages.filter((m) => !m.pending).slice(-8)
    .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.role === 'me' ? m.text : JSON.stringify({ answer: m.text }) }));
  const out = await askJson(ai, system + extra, question, { history, maxTokens: 6000, timeout: 90000 });
  const item = out.item && out.item.name ? { name: String(out.item.name).slice(0, 40), price: Number(out.item.price) || price || null } : null;
  let verdict = ['buy', 'wait', 'no'].includes(out.verdict) ? out.verdict : null;
  const facts = item?.price ? priceFacts(d, item.price) : pf;
  if (verdict && facts?.floorBreak) verdict = 'no'; // 硬规则不靠 AI
  return { text: String(out.answer || '（没有回答）'), verdict, item, facts };
}

async function decide(m, choice) {
  const item = m.item;
  try {
    await save(`买不买：${item.name} → ${{ buy: '买了', wish: '放进心愿单', skip: '不买了' }[choice]}`, (data) => {
      data.decisions ||= [];
      data.decisions.push({ id: newId('x'), at: today(), item: item.name, price: item.price, verdict: m.verdict, choice });
      if (choice === 'wish' && !data.wishes.some((w) => w.status === 'open' && w.name === item.name)) {
        data.wishes.push({ id: newId('w'), name: item.name, price: item.price || 0, want: 'very', reason: '从「买不买」放进来的', link: '', targetDate: '', createdAt: today(), status: 'open' });
      }
    });
    m.decided = choice;
    if (choice === 'buy') go(`#/add?amount=${item.price || ''}&note=${encodeURIComponent(item.name)}`);
    else { toast(choice === 'wish' ? '放进心愿单了，冷静几天再看' : '好的，省下了'); render(); }
  } catch { /* 已提示 */ }
}

// 买过的东西一个月后问一句：值不值
function reviewCard() {
  const d = store.data;
  const due = (d.decisions || []).filter((x) => x.choice === 'buy' && !x.review && daysSince(x.at) >= REVIEW_DAYS);
  if (!due.length) return null;
  const x = due[0];
  const answer = (review) => save(`回访：${x.item} → ${review}`, (data) => { data.decisions.find((y) => y.id === x.id).review = review; })
    .then(() => { toast('记下了，下次判断会参考'); render(); }).catch(() => {});
  return h('div', { class: 'card review' },
    h('p', {}, `「${x.item}」买了一个多月了，用得怎么样？`),
    h('div', { class: 'actions' },
      h('button', { class: 'small', onclick: () => answer('worth') }, '值'),
      h('button', { class: 'small secondary', onclick: () => answer('meh') }, '一般'),
      h('button', { class: 'small secondary', onclick: () => answer('regret') }, '有点后悔')));
}

// ---------- 理财小课堂 ----------
// 每课几段大白话，用他自己的数字举例。不推荐具体产品。

function lessons(d) {
  const t = today();
  const plan = yearPlan(d);
  const hl = health(d, t, usdRate());
  const last = closedPeriods(d, t).at(-1);
  const lastSt = last ? periodStats(d, last) : null;
  const st = hl.stats;
  const rate = usdRate();
  const subsYear = d.recurring.reduce((s, r) => s + (r.day ? r.amount * 12 : r.amount) * (isUsd(d, r.account) ? rate : 1), 0);
  const dropped = d.wishes.filter((w) => w.status === 'dropped');
  const floorAcc = account(d, d.settings.floorAccount);
  return [
    { id: 'rate', title: '储蓄率', sub: '比「存了多少」更重要的数', body: [
      '储蓄率 = 存下的钱 ÷ 收入。比如收入 8000、存下 4000，储蓄率就是 50%。',
      '为什么看它而不是看存了多少：收入会变，但储蓄率能直接说明你花钱的习惯。常见的建议是 20%，能到 30% 以上就很好。',
      plan.rate != null ? `你的计划：全年储蓄率约 ${plan.rate}%。${lastSt && lastSt.income ? `上个预算月实际是 ${Math.round(((lastSt.income - lastSt.total) / lastSt.income) * 100)}%。` : '记满一个完整的预算月，就能看到实际的数。'}` : '在「预算」里填上每月正常收入，就能算出你的储蓄率。',
    ] },
    { id: 'need', title: '必要和想要', sub: '花钱的两种', body: [
      '必要：不花不行，但可以花得省一点，比如吃饭、日用品、交通。想要：不花也能活，但完全不花日子就太紧，比如奶茶、娱乐、喜欢的东西。',
      '管钱不是不花「想要」，而是心里清楚哪些是想要，给它们一个固定的额度（就是你的自由钱和心愿基金）。',
      `这个预算月到现在：必要（吃饭 + 日常）${money(st.spent.food + st.spent.daily)}，想要（自由钱 + 心愿）${money(st.spent.free + (st.byCat['c-wish'] || 0))}。`,
    ] },
    { id: 'cushion', title: '安全垫和应急钱', sub: '为什么手里要留一笔不动的钱', body: [
      '安全垫 = 手里的钱能撑几个月的正常开销。应急钱是其中专门不动的一块，用来应付意外：生病、电脑坏了、补助晚发。',
      '上班的人一般建议留 3～6 个月；学生有稳定的补助，2～3 个月就够。有了它，意外来的时候你不会慌，也不用借钱。',
      `你现在：安全垫 ${hl.items.find((x) => x.key === 'cushion')?.value || ''}，${floorAcc ? `${floorAcc.name}里留着不动的底线是 ${money(d.settings.emergencyFloor)}` : ''}。已经够了，接下来只要别动它。`,
    ] },
    { id: 'fixed', title: '固定支出', sub: '每月自动扣的钱最容易被忘掉', body: [
      '订阅、会员这种每月自动扣的钱，单看一个月不多，但一年加起来很可观，而且因为是自动扣的，很容易忘了自己还订着。',
      '一个好习惯：每隔几个月把订阅过一遍，问自己「这个月真的用了吗」。不用的就停掉，想用了再开。',
      d.recurring.length ? `你现在的固定扣费一年大约 ${money(subsYear)}：${d.recurring.map((r) => r.name).join('、')}。` : '你现在还没有记录固定扣费。',
    ] },
    { id: 'where', title: '钱放在哪', sub: '活期、定期、货币基金是什么', body: [
      '活期：银行卡里的钱默认就是活期，随时能用，但利息很低。定期：存进去一段时间（比如 3 个月、1 年）不能动，利息高一些，提前取出来利息会少。',
      '货币基金：银行 App、支付宝里那种「随时能取」的理财，比活期利息略高一点，风险很低，但不是零风险、收益也不保证。不管选哪种，利率都以 App 上实际显示的为准。',
      `一个稳妥的思路：应急钱放随时能取的地方；确定一段时间内用不到的存款，可以考虑定期。这里只讲道理，不推荐具体产品。${floorAcc ? `你的${floorAcc.name}现在是 ${money(balance(d, floorAcc.id))}。` : ''}`,
    ] },
    { id: 'impulse', title: '冲动消费', sub: '为什么要先冷静几天', body: [
      '很多「想要」只是一时的：看到别人有、刷到广告、心情不好。过几天这股劲过去了，你会发现其实没那么需要。',
      `所以我们定了规则：${money(d.settings.wishBigFrom)} 以上的东西先放进心愿单，冷静 ${d.settings.coolDays} 天，还想要再考虑买。`,
      dropped.length ? `到现在你放弃了 ${dropped.length} 个心愿，省下 ${money(dropped.reduce((s, w) => s + Number(w.price), 0))}。` : '以后放弃的心愿，会在心愿单底部记着省下了多少钱。',
    ] },
    { id: 'credit', title: '花呗、信用卡和分期', sub: '为什么容易越花越多', body: [
      '它们让你「现在不用掏钱」，花钱的痛感变小，人就容易多花。等账单来的时候，钱已经花出去了。',
      '分期最需要小心：「每期手续费 0.6%」听起来很少，但因为你每个月都在还本金、手里的欠款越来越少，折算成实际的年利率差不多要翻一倍，比存款利息高得多。',
      '你的条件很好，有稳定的补助和存款，完全不需要用它们。想买的东西就按心愿单慢慢攒，攒够了再买。',
    ] },
  ];
}

function openLesson(ls) {
  openSheet({
    title: ls.title,
    body: h('div', { class: 'explain' }, ls.body.map((p) => h('p', {}, p))),
    confirmText: '问问 DeepSeek',
    cancelText: '知道了',
    onConfirm: () => {
      const input = document.querySelector('.chat-input textarea');
      chatState.draft = `关于「${ls.title}」，我想问：`;
      if (input) { input.value = chatState.draft; input.focus(); }
    },
  });
}

const askHelp = () => [
  ['能问什么', ['想买个东西：比如「想买个 1200 的机械键盘」。它会先问你一两个问题，再给建议：可以买、等等再说、或者不建议。', '问花钱的情况：比如「这个月花得怎么样？」「我钱都花哪了？」「下周想出去吃顿好的，预算够吗？」']],
  ['网站帮你算的', ['只要话里有价格，网站会换算成你有感觉的说法：相当于几天的饭钱、几个月的自由钱、存钱目标晚几天。', `两条规则不靠 AI：会动到应急钱的一定「不建议」；${money(store.data.settings.wishBigFrom)} 以上的建议先放进心愿单冷静几天。`]],
  ['决定还是你做', ['给了建议以后，下面有「决定买」「放进心愿单」「不买了」。决定买会带你去记一笔。买了的东西一个月后会问你「值不值」，下次判断会参考。']],
  ['隐私', ['发给 DeepSeek 的只有汇总数字（各类花了多少、余额、预算剩多少、心愿单），不发每一笔的明细。聊天记录不保存，关掉页面就没了。']],
  ['理财小课堂', ['上面那排卡片，每张讲一个概念，用你自己的数字举例。看完有问题，点「问问 DeepSeek」接着聊。']],
];

function askView() {
  const d = store.data;
  const box = h('div', { class: 'chat' });
  const input = h('textarea', { rows: 1, placeholder: '比如：想买个 1200 的机械键盘', 'aria-label': '想问什么', value: chatState.draft,
    oninput: (e) => { chatState.draft = e.target.value; } });
  const draw = () => {
    box.replaceChildren(...chatState.messages.map((m) => {
      if (m.role === 'me') return h('div', { class: 'msg me' }, m.text);
      if (m.pending) return h('div', { class: 'msg ai thinking' }, '正在看你的账……');
      if (m.error) return h('div', { class: 'msg ai error-msg' }, m.text);
      const f = m.facts;
      return h('div', { class: 'msg ai' },
        m.verdict ? h('div', { class: `verdict ${m.verdict}` }, VERDICT[m.verdict]) : null,
        h('div', {}, m.text),
        f && m.verdict ? h('div', { class: 'facts' },
          h('b', {}, `${money(f.price)}：`), f.facts.map((x) => h('div', {}, `· ${x}`)),
          f.floorBreak ? h('div', { class: 'warn-text' }, '· 会动到应急钱') : null,
          f.cool && !f.floorBreak ? h('div', {}, `· 超过 ${money(d.settings.wishBigFrom)}，先冷静 ${d.settings.coolDays} 天比较好`) : null) : null,
        m.item && m.verdict && !m.decided ? h('div', { class: 'decide' },
          h('button', { class: 'small', onclick: () => decide(m, 'buy') }, '决定买'),
          h('button', { class: 'small secondary', onclick: () => decide(m, 'wish') }, '放进心愿单'),
          h('button', { class: 'small secondary', onclick: () => decide(m, 'skip') }, '不买了')) : null,
        m.decided ? h('div', { class: 'muted small' }, `你的决定：${{ buy: '买', wish: '放进心愿单', skip: '不买' }[m.decided]}`) : null);
    }));
  };
  const send = async (text) => {
    const q = (text ?? input.value).trim();
    if (!q || chatState.busy) return;
    input.value = '';
    chatState.draft = '';
    chatState.busy = true;
    chatState.messages.push({ role: 'me', text: q }, { role: 'ai', pending: true });
    draw();
    try {
      const r = await askMoney(q);
      chatState.messages[chatState.messages.length - 1] = { role: 'ai', ...r };
    } catch (e) {
      chatState.messages[chatState.messages.length - 1] = { role: 'ai', error: true, text: e.message };
    } finally {
      chatState.busy = false;
    }
    if (currentPath() === '/ask') { render(); window.scrollTo(0, document.body.scrollHeight); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  draw();
  const ideas = ['想买个 1200 的机械键盘', '这个月花得怎么样？', '我钱都花哪了？', '下周想出去吃顿好的，预算够吗？'];
  return h('div', {},
    headerSub('买不买', '想买东西、或者想知道自己花得怎么样，都可以问', chatState.messages.length ? h('button', { class: 'link small', onclick: () => { chatState.messages = []; render(); } }, '清空') : null, helpButton('买不买怎么用', askHelp())),
    h('div', { class: 'section-title' }, '理财小课堂'),
    h('div', { class: 'lesson-scroll' }, lessons(d).map((ls) => h('button', { class: 'lesson', type: 'button', onclick: () => openLesson(ls) },
      h('b', {}, ls.title), h('span', {}, ls.sub)))),
    reviewCard(),
    chatState.messages.length ? null : h('div', { class: 'chips' }, ideas.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => send(x) }, x))),
    box,
    h('div', { class: 'chat-input' }, input, h('button', { onclick: () => send(), 'aria-label': '发送' }, '发送')));
}

// ---------- 个税退税 ----------

function taxView() {
  const d = store.data;
  const t = today();
  const season = taxSeason(t);
  const years = [...new Set(d.tx.filter((x) => x.type === 'income' && x.category === 'i-job').map((x) => Number(x.date.slice(0, 4))))].sort((a, b) => b - a);
  const thisYear = Number(t.slice(0, 4));
  if (!years.includes(thisYear)) years.unshift(thisYear);
  const markDone = (y, tx) => {
    const refund = h('input', { inputmode: 'decimal', placeholder: '退了多少（还没到账可以先不填）', 'aria-label': '退了多少' });
    let acc = readJson(LAST_KEY).account;
    if (!account(d, acc)) acc = d.accounts[0]?.id;
    const accBox = h('div', { class: 'chips', role: 'group', 'aria-label': '退到哪个账户' });
    const drawAcc = () => accBox.replaceChildren(...d.accounts.filter((a) => a.currency === 'CNY').map((a) => h('button', {
      type: 'button', class: `chip${a.id === acc ? ' on' : ''}`, 'aria-pressed': String(a.id === acc), onclick: () => { acc = a.id; drawAcc(); },
    }, a.name)));
    drawAcc();
    openSheet({
      title: `${y} 年的汇算办好了`,
      body: h('div', { class: 'form' }, h('p', { class: 'small muted' }, `${y} 年兼职被预扣 ${money(tx.withheld)}。退的钱到账了就填上，会记一笔「个税退税」收入。`),
        refund, h('div', { class: 'label-sm' }, '退到哪个账户'), accBox),
      confirmText: '办好了',
      onConfirm: async () => {
        const n = round2(Number(refund.value.replace(/[，,\s]/g, '')) || 0);
        try {
          await save(`个税汇算：${y} 年${n ? `，退了 ${n}` : ''}`, (data) => {
            data.taxYears = { ...(data.taxYears || {}), [y]: { done: today(), refund: n || null } };
            if (n > 0) data.tx.push({ id: newId('t'), type: 'income', date: today(), account: acc, amount: n, category: 'i-tax', note: `${y} 年个税汇算退税`, createdAt: new Date().toISOString() });
          });
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const yearCard = (y) => {
    const tx = taxYear(d, y);
    const canFile = y < thisYear;
    return h('div', { class: 'card' },
      h('h3', {}, `${y} 年`),
      h('div', { class: 'tax-grid' },
        h('span', {}, '兼职收入（到手）'), h('b', {}, money(tx.income)),
        h('span', {}, '被预扣的个税'), h('b', {}, money(tx.withheld)),
        tx.done ? [h('span', {}, '汇算'), h('b', { class: 'good-text' }, `${md(tx.done)}办好${tx.refund ? `，退了 ${money(tx.refund)}` : ''}`)] : null),
      !tx.jobs.length ? h('p', { class: 'muted small' }, '这一年还没有记兼职收入。') : null,
      tx.withheld > 0 && !tx.done ? h('p', { class: 'small' }, canFile
        ? (season === y ? `现在就能办：${md(`${y + 1}-${TAX_TO}`)}前在「个人所得税」App 做 ${y} 年的年度汇算。` : `${y + 1} 年 3 月 1 日到 6 月 30 日之间办。`)
        : `明年 3 月 1 日到 6 月 30 日办，到时候首页和手机会提醒你。`) : null,
      canFile && tx.withheld > 0 && !tx.done ? h('button', { class: 'secondary', onclick: () => markDone(y, tx) }, '办好了') : null);
  };
  return h('div', {},
    headerSub('个税退税', '兼职被预扣的个税，每年可以申请退回来', helpButton('个税退税怎么回事', [
      ['为什么能退', ['兼职（劳务报酬）发钱时，单位一般会先按 20% 左右预扣个税（单次超过 800 元就会扣）。', '但个税是按一整年算的：学生一年的应税收入通常不高，扣掉每年 6 万的基本减除和其他扣除后，往往不用交税或者交很少，多扣的就能退回来。能退多少，以个税 App 算出来的为准。']],
      ['平时要做的', ['记兼职收入时，在「被预扣的个税」里填一下扣了多少（看工资条、到账短信，或者问发钱的单位）。没扣就不填。', '网站会按年把兼职收入和被扣的税加起来。']],
      ['每年 3～6 月', ['1. 手机下载「个人所得税」App（国家税务总局的官方 App），用身份证注册登录。', '2. 首页点「综合所得年度汇算」，选上一年，按提示一步步确认收入（App 会自动列出单位替你报的收入）。', '3. 有专项附加扣除的填上（比如继续教育），没有就跳过。', '4. 最后显示「应退税额」，填自己的银行卡申请退税，一般几天到几周到账。', '刚开放的那几天人多，可能要预约，晚几天再办也一样，6 月 30 日前就行。']],
      ['顺便看一眼', ['在 App 的「收入纳税明细」里看看，有没有不认识的单位用你的身份证报了收入。如果有，可以直接在 App 里申诉。']],
    ])),
    years.map(yearCard));
}

// ---------- 订阅 ----------

const SUB_NOTE = { keep: '值，继续用', downgrade: '考虑降档', stop: '可以停掉' };

function subsView() {
  const d = store.data;
  const t = today();
  const rate = usdRate();
  const due = subReviewDue(d, t);
  const notes = d.subReview?.notes || {};
  const total = d.recurring.reduce((s, r) => s + yearlyCost(d, r, rate), 0);
  const upd = (message, fn) => save(message, fn).then(render).catch(() => {});
  const edit = (r = null) => {
    const name = h('input', { value: r?.name || '', placeholder: '比如 视频会员', 'aria-label': '名称' });
    const amount = h('input', { inputmode: 'decimal', value: r ? String(r.amount) : '', placeholder: '每次扣多少', 'aria-label': '每次扣多少' });
    let yearly = Boolean(r?.yearly);
    const kindBox = h('div', { class: 'chips', role: 'group', 'aria-label': '多久扣一次' });
    const day = h('input', { inputmode: 'numeric', value: r?.day ? String(r.day) : '', placeholder: '每月几号扣，比如 6', 'aria-label': '每月几号' });
    const ydate = h('input', { type: 'date', value: r?.yearly ? `${t.slice(0, 4)}-${r.yearly}` : '', 'aria-label': '每年哪天续费' });
    let acc = r?.account || null;
    const accBox = h('div', { class: 'chips', role: 'group', 'aria-label': '从哪个账户扣' });
    const drawAcc = () => accBox.replaceChildren(...d.accounts.map((a) => h('button', {
      type: 'button', class: `chip${a.id === acc ? ' on' : ''}`, 'aria-pressed': String(a.id === acc), onclick: () => { acc = a.id; drawAcc(); },
    }, a.name)));
    const drawKind = () => {
      kindBox.replaceChildren(...[[false, '每月'], [true, '每年']].map(([k, label]) => h('button', {
        type: 'button', class: `chip${yearly === k ? ' on' : ''}`, 'aria-pressed': String(yearly === k), onclick: () => { yearly = k; drawKind(); },
      }, label)));
      day.hidden = yearly;
      ydate.hidden = !yearly;
    };
    drawAcc();
    drawKind();
    openSheet({
      title: r ? `改「${r.name}」` : '加一个订阅',
      body: h('div', { class: 'form' }, name, amount, kindBox, day, ydate, h('div', { class: 'label-sm' }, '从哪个账户扣'), accBox,
        h('p', { class: 'muted small' }, '每月的到日子网站自动记一笔；每年的只提前提醒，不自动记。')),
      confirmText: '保存',
      onConfirm: async () => {
        const n = Number(amount.value.replace(/[，,\s]/g, ''));
        const dd = Number(day.value);
        if (!name.value.trim() || !(n > 0)) { toast('名称和金额要填', 'error'); return false; }
        if (!yearly && !(dd >= 1 && dd <= 31)) { toast('填一下每月几号扣', 'error'); return false; }
        if (yearly && !ydate.value) { toast('填一下每年哪天续费', 'error'); return false; }
        if (!yearly && !acc) { toast('选一下从哪个账户扣', 'error'); return false; }
        const fields = yearly
          ? { name: name.value.trim(), amount: round2(n), account: acc, yearly: ydate.value.slice(5), remindOnly: true, day: undefined }
          : { name: name.value.trim(), amount: round2(n), account: acc, day: dd, yearly: undefined, remindOnly: undefined };
        try {
          await save(`${r ? '改' : '加'}订阅：${fields.name}`, (data) => {
            let x = r && data.recurring.find((y) => y.id === r.id);
            if (!x) { x = { id: newId('r'), category: 'c-member', since: today() }; data.recurring.push(x); }
            Object.assign(x, fields);
            for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k];
          });
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const stop = (r) => saveUndoable(`停掉订阅：${r.name}`, (data) => { data.recurring = data.recurring.filter((x) => x.id !== r.id); },
    `停掉了「${r.name}」，记得去 App Store 取消订阅`).then(render).catch(() => {});
  const mark = (r, v) => upd(`订阅体检：${r.name} ${SUB_NOTE[v]}`, (data) => {
    data.subReview = { ...(data.subReview || {}), notes: { ...(data.subReview?.notes || {}), [r.id]: v } };
  });
  const finish = () => upd('订阅体检完成', (data) => { data.subReview = { ...(data.subReview || {}), last: today() }; });
  return h('div', {},
    headerSub('订阅', `一年大约 ${money(total)}`, h('button', { class: 'icon-btn', 'aria-label': '加一个订阅', onclick: () => edit() }, icon('plus')), helpButton('订阅体检', [
      ['为什么要体检', ['订阅是自动扣的，单看一个月不多，一年加起来很可观，也很容易忘了自己还订着。', '每 3 个月看一眼，每个问自己：这 3 个月真的常用吗？低一档的够不够？几个订阅用途重不重叠？能不能走报销？']],
      ['怎么做', ['每个订阅点一下「值」「降档」或「停掉」，最后点「体检完了」。3 个月后首页会再提醒。', '决定停掉的，记得也去 App Store（设置 → Apple ID → 订阅）或对应的网站取消，网站这边点「停掉」就不再自动记账。']],
    ])),
    due ? h('div', { class: 'banner soon' }, `该体检了：上次是 ${md(due.last)}，已经 ${due.days} 天`) : h('p', { class: 'muted small' }, `上次体检 ${md(d.subReview?.last || d.openingDate)}，每 3 个月一次。`),
    d.recurring.length ? d.recurring.map((r) => h('div', { class: 'card sub' },
      h('div', { class: 'wish-top' },
        h('div', { class: 'grow' }, h('div', { class: 'wish-name' }, r.name),
          h('div', { class: 'muted small' }, r.day ? `每月 ${r.day} 号 · ${exact(r.amount, curOf(r.account))}` : `每年 ${md(`2000-${r.yearly}`)} · ${exact(r.amount, curOf(r.account))}`, r.account ? ` · ${accName(r.account)}` : '')),
        h('div', { class: 'wish-price' }, `${money(yearlyCost(d, r, rate))}/年`)),
      r.note ? h('p', { class: 'muted small' }, r.note) : null,
      h('div', { class: 'chips', role: 'group', 'aria-label': `${r.name} 还值吗` }, Object.entries(SUB_NOTE).map(([k, label]) => h('button', {
        type: 'button', class: `chip${notes[r.id] === k ? ' on' : ''}`, 'aria-pressed': String(notes[r.id] === k), onclick: () => mark(r, k),
      }, label))),
      h('div', { class: 'wish-actions' }, h('span', { class: 'grow' }),
        h('button', { class: 'link', onclick: () => edit(r) }, '改'),
        h('button', { class: 'link danger-text', onclick: () => stop(r) }, '停掉'))))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有订阅。点右上角 ＋ 加。')),
    d.recurring.length ? h('div', { class: 'actions sticky' }, h('button', { onclick: finish }, '体检完了')) : null);
}

// ---------- 存款目标 ----------

function goalsView() {
  const d = store.data;
  const list = goalStatus(d, today());
  const floorName = account(d, d.settings.floorAccount)?.name || '存钱卡';
  const edit = (g = null) => {
    const name = h('input', { value: g?.name || '', placeholder: '比如 毕业过渡金', 'aria-label': '目标' });
    const target = h('input', { inputmode: 'decimal', value: g ? String(g.target) : '', placeholder: '要存多少', 'aria-label': '要存多少' });
    const by = h('input', { type: 'date', value: g?.by || '', 'aria-label': '什么时候前存够' });
    const note = h('input', { value: g?.note || '', placeholder: '用来做什么（选填）', 'aria-label': '用来做什么' });
    openSheet({
      title: g ? '改目标' : '加一个存款目标',
      body: h('div', { class: 'form' }, name, target, h('label', {}, '什么时候前存够', by), note),
      confirmText: '保存',
      onConfirm: async () => {
        const n = Number(target.value.replace(/[，,\s]/g, ''));
        if (!name.value.trim() || !(n > 0) || !by.value) { toast('名称、金额、日期都要填', 'error'); return false; }
        const fields = { name: name.value.trim(), target: round2(n), by: by.value, note: note.value.trim() };
        try {
          await save(`${g ? '改' : '加'}存款目标：${fields.name}`, (data) => {
            if (g) Object.assign(data.goals.find((x) => x.id === g.id), fields);
            else data.goals.push({ id: newId('g'), ...fields });
          });
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const remove = (g) => saveUndoable(`删除存款目标：${g.name}`, (data) => { data.goals = data.goals.filter((x) => x.id !== g.id); },
    `删掉了目标「${g.name}」（钱不动）`).then(render).catch(() => {});
  return h('div', {},
    headerSub('存款目标', '给以后一定会用到的大钱提前留好', h('button', { class: 'icon-btn', 'aria-label': '加一个存款目标', onclick: () => edit() }, icon('plus')), helpButton('存款目标怎么算', [
      ['是什么', ['以后一定会用到的一大笔钱，比如毕业到第一笔工资之间的过渡金。和心愿不一样：心愿是「想要」，这是「到时候必须有」。']],
      ['进度怎么算', [`不用另外存，就看${floorName}：扣掉应急钱底线 ${money(d.settings.emergencyFloor)} 和大额心愿已经攒的，剩下的按顺序算进目标（排前面的先算）。`, '每月按计划存钱，进度会自己往上走。旁边的「每月要留」是还差的钱平均到剩下的月份。']],
      ['暑假生活费', ['没有收入的那几个月（暑假）的生活费，网站自动算成一个目标，排在最前面。到了暑假，首页会提醒你从存钱卡转生活费出来。']],
      ['人情', [`人情账里预计要准备 ${FAVOR_BIG} 以上的（比如婚礼随礼），自动算成一个目标，到那天（没日子的按下一个假期）前留好。还上了就没了。`]],
    ])),
    list.length ? list.map(({ g, have, need, months, perMonth }) => h('div', { class: 'card goal' },
      h('div', { class: 'wish-top' },
        h('div', { class: 'grow' }, h('div', { class: 'wish-name' }, g.name, g.auto ? h('span', { class: 'badge' }, '自动') : null),
          h('div', { class: 'muted small' }, `${md(g.by)}（${g.by.slice(0, 4)} 年）前${g.note ? ` · ${g.note}` : ''}`)),
        h('div', { class: 'wish-price' }, money(g.target))),
      bar(g.target ? have / g.target : 0, 'var(--sage)'),
      h('div', { class: 'muted small wish-progress' }, need > 0 ? `已经有 ${money(have)}，还差 ${money(need)}；还有 ${months} 个月，平均每月留 ${money(perMonth)} 就够` : `已经够了 ✓（${money(have)}）`),
      g.auto ? h('p', { class: 'muted small' }, g.autoText || '按每月预算和没有收入的月份自动算，改预算它会跟着变。排在最前面，因为它最先用到。')
        : h('div', { class: 'wish-actions' }, h('span', { class: 'grow' }),
          h('button', { class: 'link', onclick: () => edit(g) }, '改'),
          h('button', { class: 'link danger-text', onclick: () => remove(g) }, '删掉'))))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有目标。点右上角 ＋ 加，比如「毕业过渡金」。')));
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
  if (b.look) R('形象', `每月 ${money(b.look)}，买护肤品、化妆品、香水这些。按「生活」网站形象路线图一样一样慢慢买，不追大牌。`, '对自己的投资是必要的，但别过火。单独一块预算，买的时候心里有数，也不会挤占日常的钱。');
  if (b.free) R('自由钱', `每月 ${money(b.free)}，想喝杯奶茶、买点小东西，花了就花了，不用想。`, '一点余地都不留的预算很难坚持，一旦超了就容易破罐破摔。留一小块不用记挂的钱，反而能长期存下去。');
  R('心愿单：有闲钱再买', `想买但不急的东西先放进心愿单，冷静 ${d.settings.coolDays} 天。${money(d.settings.wishBigFrom)} 以内的小额心愿用「心愿基金」买：每个预算月生活预算没花完的进基金，超了从基金扣回来。超过 ${money(d.settings.wishBigFrom)} 的大额心愿从每月存下的钱里按顺序攒，每月合计最多 ${money(d.settings.wishMonthlyCap)}。`,
    '省下来的钱有了用处，省钱更有动力；大件慢慢攒，不会一下子打乱存钱计划。');
  if (d.settings.emergencyFloor > 0) {
    R(`应急钱不低于 ${money(d.settings.emergencyFloor)}`, `${floorName}里至少留 ${money(d.settings.emergencyFloor)}，专门应付意外（生病、电脑坏了、收入晚到）。买东西不能动它。`, '有这笔钱在，意外来了也不会慌，不用借钱。');
  }
  if (months.length) {
    R(`${months.join('、')} 月没有收入`, `一年只有 ${plan.paidMonths} 个月有收入，但 12 个月都要花钱。所以有收入的月份每月要多留约 ${money(reserve)}，到时候从存钱卡转生活费出来。「存款目标」里自动有一个「暑假生活费」，能看到留够了没有。`, '不提前留，到时候会觉得存款在「变少」，其实是计划内的。');
  }
  if (d.settings.sideIncomeSave != null) {
    const k = Math.round(d.settings.sideIncomeSave * 100);
    R('兼职的钱', `${k}% 存下，${100 - k}% 自动进心愿基金，可以拿去买心愿单上的东西。`, '既能多存，又不会觉得「赚了钱却花不到」。');
  }
  R('转账不算花钱', '充校园卡、充值美元账户、存钱卡转生活费卡，都只是把钱从一个口袋换到另一个口袋，记「转账」。真正刷卡、扣费的时候才算花销。', '这样每个月花了多少、花在哪才准；每个账户的余额也能和实际对上。');
  if (d.accounts.some((a) => a.currency === 'USD')) {
    R('美元账户', '美元账户按美元记。订阅到了扣费日，网站自己记一笔，按当天汇率折成人民币算进预算。余额不够下次扣费时，首页会提前提醒你充值。');
  }
  R('记错了不要紧', '漏记、记错几笔很正常。打开手机银行看一眼实际余额，在账户页点「校准」，差额会自动补一笔，账就对上了。');

  const card = (n, [title, text, why]) => h('div', { class: 'card rule' }, h('h2', {}, `${n}. ${title}`),
    text.split('\n').map((t) => h('p', {}, t)), why ? h('p', { class: 'why' }, `为什么：${why}`) : null);
  const catList = (g) => d.categories.filter((c) => c.group === g && !c.hidden).map((c) => c.name).join('、');
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

// 预算调整建议卡片（预算页最上面）
function adviceCard() {
  const d = store.data;
  const t = today();
  const adv = budgetAdvice(d, t, usdRate());
  const plan = yearPlan(d);
  const applyOne = (items) => save(`采用预算建议：${items.map((x) => `${x.name} ${x.from}→${x.to}`).join('，')}`, (data) => {
    for (const x of items) {
      data.budgetHistory ||= [];
      data.budgetHistory.push({ at: today(), group: x.group, from: data.budget[x.group], to: x.to });
      data.budget[x.group] = x.to;
    }
  }).then(() => { toast('预算改好了，从现在起按新的算'); render(); }).catch(() => {});
  const dismiss = (x) => save(`暂不采用预算建议：${x.name}`, (data) => {
    data.budgetAdviceDismissed = { ...(data.budgetAdviceDismissed || {}), [x.group]: periodFor(data, today()).start };
  }).then(render).catch(() => {});
  const effect = (x) => {
    const yearly = -x.delta * 12;
    const parts = [x.delta < 0 ? `每月多存 ${money(-x.delta)}，一年 ${money(yearly)}` : `每月少存 ${money(x.delta)}，一年 ${money(-yearly)}`];
    if (x.delta < 0 && x.group !== 'sub') parts.push('每月月底进心愿基金的结余会少一些');
    if (x.delta > 0 && plan.yearIn) parts.push(`一年还能存约 ${money(plan.yearIn - plan.yearOut - x.delta * 12)}`);
    return parts.join('；');
  };
  const askAi = () => { chatState.draft = '我的预算该怎么调？哪些地方花得多了？'; go('#/ask'); };
  return h('div', { class: 'card advice-card' },
    h('h3', {}, '预算调整建议'),
    adv.items.length ? [
      adv.items.map((x) => h('div', { class: 'advice-item' },
        h('div', { class: 'budget-top' }, h('b', {}, x.name), h('span', {}, `${money(x.from)} → `, h('b', { class: x.delta < 0 ? 'good-text' : 'soon' }, money(x.to)))),
        h('p', { class: 'small' }, x.why),
        x.top.length ? h('p', { class: 'muted small' }, `花得多的：${x.top.join('、')}`) : null,
        h('p', { class: 'muted small' }, effect(x)),
        h('div', { class: 'row-btns' },
          h('button', { class: 'small', onclick: () => applyOne([x]) }, '采用'),
          h('button', { class: 'small secondary', onclick: () => dismiss(x) }, '这个月先不改')))),
      adv.items.length > 1 ? h('button', { class: 'secondary wide', onclick: () => applyOne(adv.items) }, `全部采用（每月预算 ${money(budgetTotal(d))} → ${money(budgetTotal(d) + adv.items.reduce((a, x) => a + x.delta, 0))}）`) : null,
    ] : h('p', { class: 'muted small' }, adv.waiting
      ? `吃饭、日常、自由钱的建议要等记满 ${adv.waiting === 2 ? '两' : '一'}个完整的预算月（开始记账那个月和暑假不算），到时候这里会根据你实际的花销给建议。`
      : '最近几个月的花销和预算很贴合，不用调。'),
    h('button', { class: 'link small', onclick: askAi }, '想聊聊怎么调？问问 DeepSeek →'));
}

function budgetView() {
  const d = store.data;
  const inputs = {};
  const field = (label, key, value, hint) => {
    inputs[key] = h('input', { inputmode: 'decimal', value: String(value ?? ''), 'aria-label': label });
    return h('label', {}, label, inputs[key], hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const catList = (g) => d.categories.filter((c) => c.group === g && !c.hidden).map((c) => c.name).join('、');
  const submit = async () => {
    const val = (k) => Number(inputs[k].value.replace(/[，,\s]/g, ''));
    const keys = Object.keys(inputs);
    if (keys.some((k) => !Number.isFinite(val(k)) || val(k) < 0)) return toast('金额要填数字', 'error');
    try {
      await save('改预算', (data) => {
        for (const g of ['food', 'daily', 'free', 'look', 'sub']) data.budget[g] = val(g);
        data.settings.expectedIncome = val('income');
        data.settings.emergencyFloor = val('floor');
      });
      toast('已保存');
      go('#/', true);
    } catch { /* 已提示 */ }
  };
  return h('div', { class: 'form' },
    headerSub('预算', '每个预算月（15 号到下个月 14 号）的计划', helpButton('预算怎么定', [
      ['调整建议', ['网站看最近 3 个完整的预算月（开始记账那个月和暑假不算）：一直有富余的建议调低（多出来的进存款），总是超的建议调高（定得太紧容易放弃）。订阅按登记的实际金额算。', '调低预算 = 多存钱，但每月进心愿基金的结余会少一些。要不要采用你来定，「这个月先不改」下个预算月会再看一次。']],
      ['怎么定的', ['这些数是我们按你的饮食习惯和固定扣费一起估的。第一两个月照常花、照实记，再按真实数据调。']],
      ['改了会怎样', ['首页的「还能花」「花钱节奏」「本月存钱」都会按新数字算。以前的流水不受影响。']],
    ])),
    adviceCard(),
    h('div', { class: 'card' },
      field('吃饭', 'food', d.budget.food, catList('food')),
      field('日常', 'daily', d.budget.daily, catList('daily')),
      field('自由钱', 'free', d.budget.free, catList('free')),
      field('形象', 'look', d.budget.look ?? 0, catList('look')),
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
    rows.push([t.date, TYPE[t.type], t.category ? `${catName(t.category)}${t.what ? `：${t.what}` : ''}` : '', t.amount, isUsd(d, t.account) ? 'USD' : 'CNY',
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

// 手机推送：每晚 9 点没记账提醒；周日、预算月最后一天发总结（账本仓库的定时任务发）
function pushCard() {
  const status = h('p', { class: 'muted small' }, '检查中……');
  const sup = pushSupport();
  const enable = async () => {
    try {
      await saving('正在开启……', async () => {
        const sub = await subscribe();
        await store.saveJson(PUSH_FILE, (cfg) => {
          const subs = (cfg.subscriptions || []).filter((x) => x.endpoint !== sub.endpoint);
          return { ...cfg, subscriptions: [...subs, { ...sub, device: deviceName(), added: today() }] };
        }, `开启推送：${deviceName()}`);
      });
      toast('已开启，应该马上收到一条「提醒已开启」');
      render();
    } catch { /* saving 已提示 */ }
  };
  if (sup.ok) {
    currentSubscription().then((sub) => {
      status.textContent = sub ? `✓ 这台设备已开启（${Notification.permission === 'granted' ? '通知已允许' : '通知没允许'}）` : '这台设备还没开启';
    }).catch(() => { status.textContent = '这台设备还没开启'; });
  } else {
    status.textContent = sup.why;
  }
  return h('div', { class: 'card' },
    h('h3', {}, '手机提醒'),
    h('p', { class: 'small' }, '每晚 9 点左右：当天还没记账就提醒你；周日加一句这周的总结，预算月最后一天加一句这个月的总结，合成一条，不多打扰。由 GitHub 定时发送，9 点到 10 点之间到（一晚上排了几次，只会收到一条）。'),
    h('p', { class: 'small muted' }, 'iPhone 上要先「分享 → 添加到主屏幕」，从主屏幕的「账本」打开再点开启。和物品档案的提醒是分开的。'),
    status,
    sup.ok ? h('button', { class: 'secondary', onclick: enable }, '在这台设备上开启') : null);
}

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
    const after = sessionStorage.getItem('ledger-after-login');
    sessionStorage.removeItem('ledger-after-login');
    go(after || '#/', true);
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
    settings.token && store?.data ? pushCard() : null,
    settings.token ? h('div', { class: 'card' },
      h('p', { class: 'small' }, '数据仓库：', settings.repo || DEFAULT_REPO, '（每次记账都是一次提交，可以在 GitHub 上查看历史）'),
      h('div', { class: 'actions' }, h('a', { class: 'button secondary', href: '#/lost' }, '手机丢了怎么办'), h('button', { class: 'danger', onclick: logout }, '退出这台设备'))) : null);
}

// ---------- 手机丢了怎么办 ----------
// 令牌在手机的浏览器里，捡到手机的人能看、能改物品档案和账本。在 GitHub 上删掉令牌，马上就失效。
function lostView() {
  const box = h('div', {}, h('p', { class: 'muted small' }, '正在读最近的修改……'));
  const repos = [['账本', gh], ['物品档案', inventoryGitHub(settings)]].filter(([, g]) => g);
  Promise.all(repos.map(([name, g]) => recentCommits(g, 40).then((list) => list.map((c) => ({ ...c, site: name }))).catch(() => [])))
    .then((lists) => {
      const all = lists.flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
      if (!all.length) { box.replaceChildren(h('p', { class: 'muted small' }, '读不到修改记录。')); return; }
      const count = {};
      for (const c of all) count[c.device] = (count[c.device] || 0) + 1;
      const when = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
      box.replaceChildren(
        h('p', { class: 'small' }, `最近 ${all.length} 次修改来自：`, Object.entries(count).map(([k, v]) => `${k} ${v} 次`).join('、'), `。这台是 ${DEVICE}。`),
        h('div', { class: 'commit-list' }, all.map((c) => h('div', { class: 'commit-row' },
          h('span', { class: 'muted small commit-when' }, when(c.date)),
          h('span', { class: 'grow small' }, c.message, h('span', { class: 'muted block' }, `${c.site} · ${c.device}`))))));
    });
  return h('div', {},
    headerSub('手机丢了怎么办', '两分钟，让丢的手机再也打不开你的数据'),
    h('div', { class: 'card' },
      h('h3', {}, '马上做'),
      h('ol', { class: 'small' },
        h('li', {}, '用电脑或借别人的手机，登录 github.com，打开 ', h('a', { href: 'https://github.com/settings/personal-access-tokens', target: '_blank', rel: 'noopener' }, '令牌列表'), '（Settings → Developer settings → Personal access tokens → Fine-grained tokens）。'),
        h('li', {}, '点这两个网站用的那个令牌（能访问 inventory-data 和 finance-data 的）→ 最下面 Delete。删掉的那一刻，丢的手机上的物品档案和账本就读不了、改不了了。'),
        h('li', {}, '新建一个令牌（Only select repositories 勾 inventory-data 和 finance-data，Contents 选 Read and write），在新手机的物品档案「设置」里填上；账本会自动用同一个。'),
        h('li', {}, 'DeepSeek 密钥存在数据仓库里，令牌删了别人也拿不到了。不放心的话去 DeepSeek 后台换一个新密钥，在物品档案「设置 → AI」里更新。'))),
    h('div', { class: 'card' },
      h('h3', {}, '然后看看'),
      h('ul', { class: 'small' },
        h('li', {}, '下面的修改记录里，有没有不是你做的（陌生的设备、你没改过的东西）。'),
        h('li', {}, '真被改了也不怕：每次修改在 GitHub 上都有历史，可以恢复到任何一次之前（让 Claude 帮你恢复）。'),
        h('li', {}, '平时：iPhone 设好锁屏密码、打开「查找我的 iPhone」，丢了还能远程抹掉。'))),
    h('div', { class: 'section-title' }, '最近的修改'),
    h('div', { class: 'card' }, box));
}

boot();
