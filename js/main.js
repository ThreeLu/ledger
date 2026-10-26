import { GitHub, DEVICE, recentCommits } from './github.js';
import { Store, newId, diff, apply as applyPatch } from './store.js';
import {
  GROUPS, defaultData, periodFor, shiftPeriod, partial, account, category, isUsd, balance, totalAssets, cny,
  periodStats, budgetTotal, livingBudget, duePostings, upcoming, CHARGE_DAYS, health, headline, money, md, addDays, payday, newMilestones,
  receivables, claimStatus, personStatus, needsReconcile, CLAIM_REMIND_DAYS, PERSON_REMIND_DAYS, budgetAdvice,
  isBigWish, wishFunds, bigWishPlan, expiredDrops, forgetDrops, restoreWish, coolingLeft, closedPeriods, WISH_KEEP, WISH_SEED, WISH_CAP,
  savingsMap, livingLeft, RECONCILE_DAYS, medTarget, FREE_KEEP, FAMILY_STEP, txGroup, spendOf, daysBetween, parseYmd, ADJUST_CAT, isLivingAccount,
  taxYear, taxSeason, TAX_TO, subReviewDue, yearlyCost, yearlySubs, FAVOR_CATEGORIES, GIFT_IN, giftsWith, openFavors, holidayFavors, socialPlan, favorDue, yearlyDue, goalsPaid, noneParts, noneLine, noneSplit, plannedSoFar, onPace,
} from './money.js';
import { holidayLine } from './cal.js';
import { personPicker, recentIds } from './picker.js';
import { FAVOR_BIG, estimatePrompt, cleanEstimate } from './renqing.js';
import { askJson } from './ai.js';
import { pushSupport, subscribe, currentSubscription, deviceName, PUSH_FILE } from './push.js';
import { weekOf, weekSummary, monthSummary } from './summary.js';
import { monthReport, yearReport } from './report.js';
import { aheadPlan } from './ahead.js';
import { scoreModels, monthForecast, simulateAhead, adviceItems, uncertaintySources, buyImpact, perUse, BUY_CARD_FROM, ON_TIME, BELOW_MAX, CRED_DAYS } from './forecast.js';
import { barChart, donut, lineChart, waterfall, barsLine, stackedBars, yearCalendar, mealStrip } from './charts.js';
import { mealWeek, MEAL_PATHS, TREND_DAYS } from './meals.js';
import { h, today, compressImage, blobToBase64 } from './util.js';
import { makeXlsx, makeWorkbook } from './xlsx.js';
import { START_CASH, HOLD, holdName, SURE, BENCH, benchSeries, tradeMarks, LOOK, lookName, zoned, bjDate, marketState, marketOf, tPlus0, lot, fees, currentGame, cash, positions, checkOrder, maxBuy, worth, worthSeries, lookbackDue, reviewDue } from './sim.js';
import { fetchQuotes, fetchDaily, searchStocks } from './quotes.js';
import { icon } from './icons.js';
import { solarTerm, greeting } from './solar.js';
import { wordFor } from './words.js';
import { inventoryGitHub, readInventory } from './bridge.js';
import { readTable } from './sheet.js';
import { parseBill, matchBills, guessBillCategory, guessAccount, isPersonal, methodKey } from './bills.js';

const SETTINGS_KEY = 'ledger-settings';
const DEFAULT_REPO = 'ThreeLu/finance-data';
const RATE_KEY = 'ledger-usd-rate';
const LAST_KEY = 'ledger-last'; // 上次用的账户和类别，记账时默认选上
const EDITING_ROUTES = /^\/(add|reconcile|bills)/;

const view = document.getElementById('view');
let summaryFlipped = false; // 总结页翻到了「钱都在哪」
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
  if (!loadError && store.data) { postRecurring(); checkMilestones(); checkYearly(); checkFamily(); checkDrops(); }
}

// 专项花够了自动办完；每年一次的（学费、住宿费）下一年的马上生成
function checkYearly() {
  const paid = goalsPaid(store.data, today());
  const add = yearlyDue(store.data, today());
  if (!paid.length && !add.length) return;
  save(`专项：${[...paid.map(() => '办完'), ...add.map((g) => g.name)].join('、')}`, (data) => {
    for (const id of paid) Object.assign(data.goals.find((g) => g.id === id), { status: 'done', doneAt: today() });
    for (const g of yearlyDue(data, today())) data.goals.push(g);
  }).then(() => { if (!EDITING_ROUTES.test(currentPath())) render(); }).catch(() => {});
}

// 自由存款超过 2000 的部分凑够一万，就封存进家庭存款（放着不动）
function checkFamily() {
  const amt = savingsMap(store.data, today(), usdRate()).sealable;
  if (!(amt > 0)) return;
  save(`家庭存款：封存 ${amt}`, (data) => {
    data.family ||= { sealed: 0, log: [] };
    data.family.sealed = (Number(data.family.sealed) || 0) + amt;
    (data.family.log ||= []).push({ date: today(), amount: amt });
  }).then(() => { toast(`自由存款攒够了，家庭存款封存了 ${money(amt)}`); if (!EDITING_ROUTES.test(currentPath())) render(); }).catch(() => {});
}

// 放弃的心愿只留到这个预算月结束，之前的删掉（不留记录）
function checkDrops() {
  const ids = expiredDrops(store.data, today()).map((w) => w.id);
  if (!ids.length) return;
  save(`心愿单：清掉上个月放下的 ${ids.length} 个`, (data) => forgetDrops(data, ids, today()))
    .then(() => { if (!EDITING_ROUTES.test(currentPath())) render(); }).catch(() => {});
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
  return h('div', { class: 'todo-part milestone' },
    h('div', { class: 'milestone-icon' }, icon('sparkle')),
    h('div', { class: 'grow' },
      fresh.map(([, x]) => h('b', { class: 'block' }, x.text)),
      h('span', { class: 'muted small' }, '慢慢攒，就会有。')),
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
  navEnter(true);
  window.addEventListener('hashchange', () => {
    for (const el of document.querySelectorAll('.sheet-overlay, .overlay')) el.remove(); // 换页时收起弹出的表单
    scrollAt[navAt] = window.scrollY;
    const was = navAt;
    navEnter();
    render();
    window.scrollTo(0, navAt < was ? scrollAt[navAt] || 0 : 0); // 返回时回到原来滚到的地方
  });
  if (settings.token) {
    connect();
    render();
    refresh();
  } else {
    // 还没登录：记住要去的页面，填好令牌后再跳过去
    if (window.location.hash && window.location.hash !== '#/settings') sessionStorage.setItem('ledger-after-login', window.location.hash);
    go('#/settings', true);
  }
  updateRate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store) refresh();
  });
}

function go(hash, replace = false) {
  if (replace) { history.replaceState({ nav: navAt }, '', hash); navStack[navAt] = { hash }; saveNav(); render(); } else window.location.hash = hash;
}

// 走过的页面：每一条浏览记录编个号（存在 history.state 里），号变小 = 返回。只比网址分不清 A → B → A 是不是返回
// 添加到主屏幕的网页没有浏览器的返回键，子页面左上角放「‹ 上一页」。navStack[号] = { hash, title }，title 是那页的大标题
let navStack = [];
let navAt = 0;
const scrollAt = {};
const saveNav = () => { try { sessionStorage.setItem('ledger-nav', JSON.stringify(navStack)); } catch { /* 存不了就算了 */ } };
function navEnter(boot = false) {
  const hash = window.location.hash || '#/';
  const n = history.state?.nav;
  if (boot) try { navStack = (JSON.parse(sessionStorage.getItem('ledger-nav')) || []).map((x) => (x?.hash ? x : null)); } catch { navStack = []; }
  if (Number.isInteger(n)) navAt = n; // 返回或前进到走过的一页（刷新也是）
  else {
    navAt = boot ? 0 : navAt + 1;
    navStack.length = navAt;
    history.replaceState({ nav: navAt }, '');
  }
  navStack[navAt] = navStack[navAt]?.hash === hash ? navStack[navAt] : { hash };
  saveNav();
}
// 子页面：直接打开（没有上一页）时回到哪里。底栏的几页（首页、模拟、总结、更多、＋）没有返回
const PARENTS = [
  [/^\/sim\/./, '#/sim'],
  [/^\/account\//, '#/accounts'],
  [/^\/claim\//, '#/claims'],
  [/^\/person\//, '#/people'],
  [/^\/lost$/, '#/settings'],
  [/^\/(ask|wishes)$/, '#/'],
  [/^\/(bills|accounts|budget|rules|settings|claims|people|reconcile|tax|subs|goals|money)$/, '#/more'],
];
const TAB_NAMES = { '#/': '首页', '#/add': '记一笔', '#/sim': '模拟', '#/summary': '总结', '#/more': '更多' };
// 底栏的几页写名字；别的页写它的大标题，太长就写「返回」
const backName = (hash, title) => TAB_NAMES[hash.split('?')[0]] || (title && title.length <= 8 ? title : '返回');
function backButton(parent) {
  const prev = navAt > 0 ? navStack[navAt - 1] || { hash: '' } : null;
  return h('button', { type: 'button', class: 'back-btn', onclick: () => (prev ? history.back() : go(parent, true)) },
    icon('back'), prev ? backName(prev.hash, prev.title) : backName(parent));
}

// ---------- 路由 ----------

const routes = [
  [/^\/?$/, () => homeView()],
  [/^\/add$/, (_, q) => addView(q)],
  [/^\/bills$/, () => billsView()],
  [/^\/sim$/, () => simView()],
  [/^\/sim\/s\/([^/]+)$/, (sym) => simStockView(sym)],
  [/^\/sim\/reviews$/, () => simReviewsView()],
  [/^\/sim\/trades$/, () => simTradesView()],
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
  [/^\/money$/, () => moneyView()],
  [/^\/budget$/, () => rulesView()], // 预算并进了花钱方式，老链接照样能开
  [/^\/rules$/, () => rulesView()],
  [/^\/settings$/, () => settingsView()],
  [/^\/lost$/, () => lostView()],
];
const NAV_GROUPS = {
  '/': [/^\/?$/, /^\/ask/, /^\/wishes/],
  '/sim': [/^\/sim/],
  '/summary': [/^\/summary/],
  '/more': [/^\/more/, /^\/lost/, /^\/bills/, /^\/accounts?/, /^\/budget/, /^\/rules/, /^\/settings/, /^\/claims?/, /^\/people/, /^\/person/, /^\/reconcile/, /^\/tax/, /^\/subs/, /^\/goals/, /^\/money/],
};

function setupNav() {
  for (const a of nav.querySelectorAll('a[data-icon]')) a.prepend(h('span', { class: 'tab-icon' }, icon(a.dataset.icon)));
  nav.querySelector('.plus').append(h('span', { class: 'circle' }, icon('plus')));
}

// 每页最下面角落的一句话（花钱观）。记账、设置这些专心做事的页面不放
// 角落那句话只放在首页，别的页安静一点
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
  let routed = false;
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (re.source.includes('settings')) { content = fn(); routed = !!store?.data; }
    else if (!settings.token) content = settingsView();
    else if (loadError && !store.data) content = errorView(loadError);
    else if (store.missing) content = setupView();
    else if (!store.data) content = h('p', { class: 'muted center' }, '正在读取账本…');
    else { content = fn(m[1], q); routed = true; }
    break;
  }
  const parent = routed && (path === '/add' && q.edit ? '#/' : PARENTS.find(([re]) => re.test(path))?.[1]); // 改一笔也算子页面
  view.replaceChildren(...[parent ? backButton(parent) : null, content || notFound(), store?.data && /^\/?$/.test(path) ? whisper(path) : null].filter(Boolean));
  if (path !== lastPath) {
    if (!path.startsWith('/summary')) summaryFlipped = false;
    view.classList.remove('enter', 'flip-in'); void view.offsetWidth; view.classList.add('enter'); lastPath = path;
  }
  document.documentElement.dataset.season = solarTerm(today()).season;
  renderedData = store?.data ? JSON.stringify(store.data) : '';
  // 记下这页的大标题，下一页的返回键用
  const title = view.querySelector('.page-head h1')?.textContent.trim();
  const here = navStack[navAt];
  if (here && title && here.title !== title) { here.title = title; saveNav(); }
  for (const a of nav.querySelectorAll('a[href]')) {
    const target = a.getAttribute('href').slice(1);
    a.classList.toggle('active', (NAV_GROUPS[target] || []).some((re) => re.test(path)));
  }
}

// ---------- 通用组件 ----------

const round2 = (n) => Math.round(n * 100) / 100;
// 精确金额：真实发生的钱（每一笔、余额、花了多少）用这个。整数不写 .00，有零头就写满两位（¥1.50）
const exact = (n, cur = '¥') => {
  const a = Math.abs(round2(n));
  return `${cur}${a.toLocaleString('zh-CN', { minimumFractionDigits: Number.isInteger(a) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
// 卡片上的大数字：和列表一样精确到分（整数不写 .00），¥ 和分缩小
function bigMoney(n, cls = '', cur = '¥') {
  const [yuan, fen] = Math.abs(round2(n)).toFixed(2).split('.');
  return h('div', { class: `big-num exact${cls ? ` ${cls}` : ''}` }, n < 0 ? '−' : null, h('span', { class: 'cur' }, cur),
    Number(yuan).toLocaleString('zh-CN'), fen !== '00' ? h('span', { class: 'fen' }, `.${fen}`) : null);
}
const curOf = (accId) => (isUsd(store.data, accId) ? '$' : '¥');
const accName = (id) => account(store.data, id)?.name || '（账户已删除）';
const catName = (id) => (id === ADJUST_CAT ? '对账差额（漏记的）' : category(store.data, id)?.name || '未分类');

// 一次只出一条提示：新的换掉旧的；底部有「撤销」时放在它上面，不压住
function toast(message, kind = 'ok') {
  // 底部已经有「…  撤销」时，普通的「已保存」就不再叠一条了，只出错误
  if (kind !== 'error' && document.querySelector('.toast.undo')) return;
  for (const x of document.querySelectorAll('.toast:not(.undo)')) x.remove();
  const el = h('div', { class: `toast ${kind}${document.querySelector('.toast.undo') ? ' raised' : ''}` }, message);
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
  for (const el of document.querySelectorAll('.toast')) el.remove();
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
        confirmText ? h('button', { onclick: async () => { if ((await onConfirm()) !== false) close(); } }, confirmText) : null, // 没有 confirmText：只有一个「关上」（cancelText）
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
    `应急钱是存钱卡里留着不动的底线（${money(d.settings.emergencyFloor)}，大约两个月的开销），专门应付意外。按「钱都在哪」的顺序算：已经封存的家庭存款先保着，欠别人的先扣掉，剩下的才轮到它。`,
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
    '这笔钱是平时每月一点点留好的（「专项存款」里的暑假生活费），花它是计划内的，不是在「吃老本」。',
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
    '接下来 14 天要从 Apple ID 自动扣的订阅，和账户里的美元比一比。',
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
  ['一句结论', ['一切正常时，在「这个月还能花」最上面一行。有事留意或要处理时，放在下面的「要做的事」里，直接告诉你做什么，点「为什么」看解释。']],
  ['要做的事', ['要处理的指标、令牌快到期、节假日人情、发钱日、里程碑都合在这一张卡里，一件一行：红色是要处理，琥珀色是留意一下，紫色是待办。点一行看为什么；已经弄好了点右边「做完了」，就不再提醒（点错了马上点「撤销」）。事多时先露 4 件，点「还有 N 件」看全部。', '发钱日：收入平时哪天到，看以前记的（还没记过就看收入计划里写的「几号」），到那天前一天才问「到了吗」；比平时晚了 3 天还没记，会变成琥珀色提一句。不定时的照旧每天问，点「还没」当天不再问。']],
  ['即将扣款', ['接下来 14 天要自动扣的订阅，一笔一行，左边是哪天。美元的最下面写 Apple ID 余额够不够；不够会写哪天前充多少。点「订阅」看这个月订阅一共多少钱。']],
  ['这个月还能花', ['生活预算（吃饭 + 日常 + 自由钱 + 形象）减去这个预算月已经花的，精确到分。「每天约」= 还能花的 ÷ 剩下的天数。', '最下面一行是预测：照你记的样子，月底大约花多少、80% 的可能在什么范围、超预算的可能。点它看「往后」和怎么算的。', '圆环是预算用了多少；下面那条和周总结一样：紫色是钱用了多少，竖线是按日子到今天该花到哪（开始记账那个月从记账那天数起）。紫色没过竖线，或者只多出一点（一成以内），都算节奏正常；预算月头 3 天不算快慢；首页、健康指标、周总结、月总结都是这一条规矩。', '预算月从每月 15 号开始，到下个月 14 号，和发钱对齐。开始记账那个月预算按天数折算。']],
  ['健康指标', ['每一格一个小圆环：绿 = 很好，黄 = 留意一下，红 = 需要做点什么。', '圆环有多满：安全垫按 3 个月算满，应急钱按底线算满，花钱节奏是生活预算用了多少（小白点是按日子该用到哪），本月存钱是离目标多近。其他的只看颜色。', '每一格都能点开，看它是什么、为什么重要、你现在怎么样。']],
  ['记账', ['点底部中间的 ＋ 记一笔。卡之间倒钱（充校园卡、存钱卡转生活费卡）记「转账」，不算花销。']],
  ['总结', ['底部「总结」看每周、每个预算月的图表。']],
  ['里程碑', ['总资产第一次超过 2 万、3 万、5 万……，或者连续几个月存钱达标，首页会出现一张祝贺卡片。']],
  ['买不买', ['想买东西拿不准，点「想买个东西？问问买不买」。理财小课堂也在那里。']],
  ['心愿单', ['右上角 ? 旁边的小礼物。想买但不急的东西放在那里，有闲钱再买。']],
];

// 「这个月的钱」：收入分成 生活 / 订阅 / 其他花销 / 存下
function flowCard(st, part, title = '这个月的钱') {
  const segs = [
    { name: '生活', v: st.living, color: 'var(--accent)' },
    { name: '订阅', v: st.spent.sub, color: 'var(--g-sub)' },
    // 不占预算的按来源分开写，心愿基金用暖色（和「钱都在哪」的心愿基金罐子一样）
    ...noneParts(store.data, st.tx).map((x) => ({ ...x, color: x.name === '心愿基金' ? 'var(--jar-w2)' : 'var(--g-none)' })),
  ];
  const base = Math.max(st.income, st.total, 1);
  const kept = Math.max(0, st.income - st.total);
  return h('div', { class: 'card' },
    h('h3', {}, title),
    h('div', { class: 'flow-line' }, `收入 ${money(st.income)} · 花了 ${money(st.total)}${st.income ? ` · 存下 ${money(st.income - st.total)}` : ''}`),
    h('div', { class: 'stack' },
      segs.filter((x) => x.v > 0).map((x) => h('span', { style: `width:${(x.v / base) * 100}%;background:${x.color}`, title: x.name })),
      kept > 0 ? h('span', { style: `width:${(kept / base) * 100}%;background:var(--g-food)`, title: '存下' }) : null),
    h('div', { class: 'legend' },
      [...segs.filter((x) => x.v > 0), ...(kept > 0 ? [{ name: '存下', v: kept, color: 'var(--g-food)' }] : [])]
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
    st.spent.none >= 1 ? h('p', { class: 'muted small' }, noneLine(noneParts(d, st.tx))) : null);
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
  return h('div', { class: 'todo-part payday' },
    h('h3', {}, pd.transfer?.summer ? '暑假生活费' : '发钱日'),
    pd.waiting.map((x) => h('div', { class: 'payday-row' },
      h('span', { class: 'grow' }, h('b', {}, `${x.plan.name}的 ${money(x.plan.amount)} 到了吗？`),
        // 晚了（2026-10-25）：比平时（或收入计划写的日子）晚了 3 天以上，提一句去看看
        x.late ? h('span', { class: 'small soon' }, `${x.usual.from === 'history' ? '比平时' : '比说好的日子'}晚了 ${x.late} 天。可以看一眼银行卡；真没到，问问发钱的地方。`)
          : x.plan.when ? h('span', { class: 'muted small' }, x.plan.when) : null),
      h('button', { class: 'small', onclick: () => arrived(x) }, '到了'),
      h('button', { class: 'small secondary', onclick: () => later(x.i) }, '还没'))),
    pd.transfer ? h('div', { class: 'payday-row column' },
      h('span', { class: 'grow' },
        h('b', {}, `要不要把这个月的生活费 ${money(pd.transfer.amount)} 挪到平时花钱的卡上？`),
        h('span', { class: 'muted small' }, '只是提醒：挪不挪、挪到哪张卡，都不影响算账。'),
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
  return h('a', { class: 'todo-part token-banner', href: '/inventory/#/settings' },
    left < 0 ? 'GitHub 令牌已经过期了，账本和物品档案都打不开，点这里去换新的' : `GitHub 令牌还有 ${left} 天过期（账本和物品档案共用），点这里去续期`);
}

// 令牌：「做完了」= 已经续过了，到期日没变就不再提（续了以后在物品档案设置里改到期日，记号就变了）
function tokenTodo() {
  const el = tokenNotice();
  if (!el) return null;
  let exp = '';
  try { exp = (JSON.parse(localStorage.getItem('inventory-settings')) || {}).tokenExpires || ''; } catch { /* 没有 */ }
  if (store.data.todoDone?.token === exp) return null;
  const row = todoItem('bad', 'gear', el);
  row.append(doneButton('令牌续期', (data) => { data.todoDone = { ...(data.todoDone || {}), token: exp }; }));
  return row;
}

// 要做的事：要处理的指标、令牌、发钱日、节假日人情、里程碑合成一张卡（不再一张张叠在「还能花」上面）；先露 4 件，其余点开
let todoMore = false;
function medLowCard() {
  const m = savingsMap(store.data, today(), usdRate()).medical;
  if (!m.target || m.have >= 300) return null;
  return h('div', { class: 'todo-part' }, h('div', {}, `医疗备用金还剩 ${money(m.have)}`),
    h('div', { class: 'muted small' }, '下一笔收入会先把它补上，不用另外做什么。'));
}

// 每件事一行：左边一个小圆点图标（红 = 要处理，琥珀 = 留意，紫 = 待办），右边标题和一句该做什么。
// 以前要处理的指标只露第一件（用户 2026-10-14 说有几件时只看到一个），现在每件单独一行
const TODO_ICON = { cushion: 'shield', floor: 'shield', pace: 'chart', saving: 'wallet', charges: 'clock', owed: 'people', reconcile: 'check', summer: 'calendar', tax: 'receipt', subs: 'clock' };
const todoItem = (tone, ic, body) => h('div', { class: `todo-item ${tone}` }, h('span', { class: 'todo-dot' }, icon(ic)), h('div', { class: 'todo-body' }, body));
function healthTodo(x, hl) {
  return h('div', { class: `todo-item ${x.level}` },
    h('button', { type: 'button', class: 'todo-tap', onclick: () => openExplain(x, hl), 'aria-label': `${x.name}：${x.action || x.text}` },
      h('span', { class: 'todo-dot' }, icon(TODO_ICON[x.key] || 'bolt')),
      h('span', { class: 'todo-body' },
        h('span', { class: 'todo-title' }, x.name, h('span', { class: 'todo-tag' }, LEVEL_TEXT[x.level])),
        h('span', { class: 'todo-text' }, x.action || x.text))),
    doneButton(x.name, (data) => markTodoDone(data, x, hl.period)));
}

// 「做完了」（2026-10-24 用户要的：已经弄了就别再提醒）。有现成记录的照记：个税退税办好了、订阅体检看过了、对过账了；
// 别的记 data.todoDone[key] = 记号（预算月 + 轻重），下个预算月、或者从「留意」变成「要处理」才再出现
const todoSig = (x, p) => `${p.start}|${x.level}`;
const todoHidden = (d, x, p) => d.todoDone?.[x.key] === todoSig(x, p);
function markTodoDone(data, x, p) {
  const t = today();
  if (x.key === 'tax') { const y = taxSeason(t); data.taxYears = { ...(data.taxYears || {}), [y]: { ...(data.taxYears?.[y] || {}), done: t } }; } else if (x.key === 'subs') data.subReview = { ...(data.subReview || {}), last: t };
  else if (x.key === 'reconcile') data.lastReconciled = t;
  else data.todoDone = { ...(data.todoDone || {}), [x.key]: todoSig(x, p) };
}
const doneButton = (name, fn) => h('button', { type: 'button', class: 'small secondary todo-done', 'aria-label': `${name}做完了`,
  onclick: () => saveUndoable(`要做的事：${name}做完了`, fn, `${name} · 做完了`).then(render).catch(() => {}) }, '做完了');

function todoCard(hl) {
  const d = store.data;
  const open = hl.items.filter((x) => !todoHidden(d, x, hl.period));
  const bad = open.filter((x) => x.level === 'bad');
  const warn = open.filter((x) => x.level === 'warn' && !inChargeCard(x)); // 年费快到了只在「即将扣款」卡里说，不再当成要做的事
  const wrap = (el, tone, ic) => (el ? todoItem(tone, ic, el) : null);
  const items = [
    ...bad.map((x) => healthTodo(x, hl)),
    tokenTodo(),
    wrap(favorHolidayCard(), 'accent', 'people'), // 假期只有几天，排在发钱日（整个月都在）前面
    wrap(paydayCard(), payday(d, today()).waiting.some((x) => x.late) ? 'warn' : 'accent', 'wallet'), // 钱晚到了是琥珀色
    ...warn.map((x) => healthTodo(x, hl)),
    adviceTodo(),
    wrap(medLowCard(), 'calm', 'shield'),
    wrap(milestoneCard(), 'accent', 'sparkle'),
  ].filter(Boolean);
  if (!items.length) return null;
  const SHOW = 4;
  const hidden = todoMore ? 0 : Math.max(0, items.length - SHOW);
  return h('div', { class: 'card todo' },
    h('div', { class: 'todo-head' }, h('h3', {}, '要做的事'), h('span', { class: `todo-count${bad.length ? ' bad' : ''}` }, `${items.length} 件`)),
    items.slice(0, items.length - hidden),
    hidden ? h('button', { type: 'button', class: 'link small todo-more', onclick: () => { todoMore = true; render(); } }, `还有 ${hidden} 件 ›`) : null);
}

// 年费提醒（yearly-*）和美元够不够付（charges）只在「即将扣款」卡里出现；美元不够付时（warn / bad）还会进要做的事
const inChargeCard = (x) => x.key.startsWith('yearly-') || (x.key === 'charges' && x.level === 'good');
// 即将扣款（2026-10-14 重做，原来是健康指标里占一整行的一格）：接下来 14 天要扣的一笔一行，左边日子，右边金额；
// 美元账户最下面一行：余额够不够付这几笔，不够就说哪天前充多少
function chargePlan(d, t, days = CHARGE_DAYS) {
  const rate = usdRate();
  const list = upcoming(d, t, days).map((u) => ({ ...u, usd: isUsd(d, u.r.account), left: daysBetween(t, u.date) }))
    .filter((u) => u.left <= days); // 年费在 upcoming 里提前 40 天，这里也只看 14 天内
  const accs = [...new Set(list.filter((u) => u.usd && !u.r.remindOnly).map((u) => u.r.account))].map((id) => {
    let bal = balance(d, id);
    let short = null;
    const ups = list.filter((u) => u.r.account === id && !u.r.remindOnly);
    for (const u of ups) { bal -= u.r.amount; if (bal < 0 && !short) short = { ...u, need: round2(-bal) }; }
    return { id, balance: balance(d, id), need: round2(ups.reduce((s2, u) => s2 + u.r.amount, 0)), short };
  });
  return { list, accs, rate };
}
function chargeRow(u, rate) {
  const cur = u.usd ? '$' : '¥';
  const [, m, day] = u.date.split('-');
  return h('div', { class: 'charge-row' },
    h('div', { class: 'charge-date' }, h('b', {}, String(Number(day))), h('span', {}, `${Number(m)}月`)),
    h('div', { class: 'grow' },
      h('div', { class: 'charge-name' }, u.r.name),
      h('div', { class: 'muted small' }, [u.left === 1 ? '明天' : `还有 ${u.left} 天`, u.r.yearly ? '每年' : '每月', accName(u.r.account), u.r.remindOnly ? u.r.note || (u.r.yearly ? '从专项出，记账时选它' : '到时自己记') : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'charge-amt' }, exact(u.r.amount, cur), u.usd ? h('span', { class: 'muted small block' }, `≈${money(u.r.amount * rate)}`) : null));
}
function chargeFoot(a) {
  const name = accName(a.id);
  return h('div', { class: `charge-foot ${a.short ? (daysBetween(today(), a.short.date) <= 3 ? 'bad' : 'warn') : 'good'}` },
    h('span', { class: 'grow' }, `${name}余额 ${exact(a.balance, '$')}`),
    h('b', {}, a.short ? `${md(a.short.date)}前充值 ${exact(Math.ceil(a.short.need), '$')}` : '够付 ✓'));
}
function upcomingCard() {
  const d = store.data;
  const { list, accs, rate } = chargePlan(d, today());
  if (!list.length) return null;
  return h('div', { class: 'card charges' },
    h('div', { class: 'todo-head' }, h('h3', {}, '即将扣款'), h('a', { class: 'small', href: '#/subs' }, '订阅 ›')),
    list.slice(0, 5).map((u) => chargeRow(u, rate)),
    accs.map(chargeFoot));
}

function homeView() {
  const d = store.data;
  const hl = health(d, today(), usdRate());
  const hd = headline(hl);
  const p = hl.period;
  const st = hl.stats;
  const part = partial(d, p);
  // 健康指标两列：单出来的最后一格占一整行，不留半行空
  const tiles = hl.items.filter((x) => x.key !== 'charges' && !x.key.startsWith('yearly-')).map((x) => healthTile(x, hl)); // 即将扣款、年费提醒都在「即将扣款」卡里
  const narrow = tiles.filter((el) => !el.classList.contains('wide'));
  if (narrow.length % 2) narrow[narrow.length - 1].classList.add('wide');
  const advice = budgetAdvice(d, today(), usdRate()).items.length;

  return h('div', {},
    homeHeader(p),
    spendLeftCard(hl, st, hl.level === 'good' ? hd : null),
    todoCard(hl),
    h('a', { class: 'ask-field', href: '#/ask' }, icon('sparkle'), '想买个东西？问问买不买……'),
    h('div', { class: 'section-title' }, '健康指标', h('span', { class: 'muted' }, ' · 点一下看解释')),
    h('div', { class: 'health-grid' }, tiles),
    upcomingCard(),
    summaryLinks(p),
    advice ? h('div', { class: 'group' }, cell({ href: '#/rules', ic: 'chart', color: 'var(--amber)',
      title: `预算有 ${advice} 条调整建议`, sub: '根据你最近几个月实际的花销' })) : null,
    flowCard(st, part),
    budgetCard(st, part),
    socialCard({ compact: true }),
    d.tx.length ? recentCard() : h('div', { class: 'card' }, h('p', {}, '还没有记账。点底部中间的 ＋ 记第一笔。')),
    h('p', { class: 'center small' }, h('a', { href: '#/rules' }, '花钱方式 →')));
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
    h('div', { class: 'head-actions' },
      h('a', { class: 'icon-btn wish-btn', href: '#/wishes', 'aria-label': '心愿单' }, icon('gift')), // 心愿单藏在这里（2026-10-25，从「更多」挪过来）
      helpButton('首页怎么看', HOME_HELP)));
}
// 精确到分：首页「还能花」「每天约」用它（用户 2026-10-06 要的，不四舍五入到元）
const cents = (n) => `${n < 0 ? '−' : ''}${exact(n)}`;

// 这个月还能花：左边圆环是生活预算用了多少（超了变红），右边是精确的还能花多少；下面一条是预算月过了多少天，和圆环比一比快慢
// ok：一切正常时那句结论放在卡片最上面一行（有事要做时结论在「要做的事」里）
function spendLeftCard(hl, st, ok = null) {
  const lb = hl.left + st.living;
  const used = lb > 0 ? Math.min(100, Math.max(0, (st.living / lb) * 100)) : 0;
  const over = hl.left < 0;
  const p = hl.period;
  const part = partial(store.data, p);
  // 竖线、快慢和月总结同一条规矩：从开始记账那天数起，没超过竖线的 1.1 倍都算正常
  const soFar = plannedSoFar(store.data, p, today());
  const timePct = lb > 0 ? Math.min(100, (soFar.planned / lb) * 100) : 0;
  const good = onPace(st.living, soFar);
  return h('div', { class: 'card spend-left hero' },
    ok ? h('div', { class: `summary ${hl.overGroups?.length ? 'soft' : 'good'}` }, h('span', { class: 'summary-title' }, ok.title), h('span', { class: 'summary-text' }, ok.text)) : null,
    h('div', { class: 'hero-top' },
      lb > 0 ? h('div', { class: `ring big${over ? ' over' : ''}`, style: `--v:${over ? 100 : used.toFixed(1)}%`, 'aria-label': `生活预算用了 ${Math.round(used)}%` },
        h('div', {}, h('b', {}, `${Math.round(used)}%`), '用了')) : null,
      h('div', { class: 'spend-text' },
        h('div', { class: 'muted small' }, over ? '这个月超了' : '这个月还能花'),
        bigMoney(Math.abs(hl.left), over ? 'warn-text' : ''),
        h('div', { class: 'muted small' }, hl.left > 0 ? `剩 ${hl.daysLeft} 天 · 每天约 ${cents(hl.perDay)}` : `剩 ${hl.daysLeft} 天`))),
    h('div', { class: 'time-bar', 'aria-label': `生活预算用了 ${Math.round(used)}%，按日子到今天该用 ${Math.round(timePct)}%` },
      h('div', { class: 'time-track' }, h('span', { class: `time-fill wh-fill${over ? ' over' : ''}`, style: `width:${used.toFixed(1)}%` }), h('span', { class: 'spend-mark', style: `left:${timePct.toFixed(1)}%`, title: '按日子到今天该花到这' })),
      h('div', { class: 'time-legend muted small' },
        h('span', {}, `第 ${p.dayIndex} / ${p.days} 天`),
        h('span', {}, good ? '节奏正常 ✓' : '花得有点快'))),
    forecastLine(),
    h('div', { class: 'hero-foot muted small' }, `生活预算 ${cents(lb)}，已花 ${cents(st.living)}${part.isPartial ? `（从 ${md(part.from)}开始记账，这个月预算按 ${part.days} 天折算）` : ''}`));
}

// 健康指标的一格：小圆环（按好 / 留意 / 要处理上色），中间一个短数字，右边名字和一句话
const LEVEL_COLOR = { good: 'var(--sage)', warn: 'var(--amber)', bad: 'var(--danger)' };
function healthTile(x, hl) {
  const g = x.gauge == null ? 1 : x.gauge;
  const short = x.short ?? (x.level === 'good' ? '✓' : '!');
  return h('button', { type: 'button', class: `health-tile ${x.level}`, onclick: () => openExplain(x, hl), 'aria-label': `${x.name}：${LEVEL_TEXT[x.level]}，${x.text}` },
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
  const tag = { advance: '不算花销', repay: '不算收入', payback: '不算花销' }[t.type] || (t.wishFund ? '心愿基金' : null) || (t.what ? catName(t.category) : null) || (t.tax ? `被扣个税 ${exact(t.tax)}` : null);
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
  ['怎么记', ['填金额 → 点类别 → 点账户 → 记好了。账户默认是你上次用的。', '选好类别后，下面会显示上次花了多少、最近几次平均多少；这次明显贵或便宜也会说一声。', '用支付宝、微信绑卡付的钱，记在实际扣钱的那张卡上。']],
  ['和别人有关', ['和同学吃饭你先付：填总金额，选「AA / 帮人付」，点上一起吃的人。你那份算花销，别人的记成欠你的。', '帮人代买：同样选「AA / 帮人付」，把「我那份」改成 0。', '别人帮你付了：选「别人帮我付的」，算你的花销，记成你欠他的。', '出差开会垫钱不在这里记，去「更多 → 垫付报销」。']],
  ['美元', ['Apple ID 是美元账户，金额填美元，按当天汇率折成人民币算预算。充值 Apple ID 用转账：填花了多少人民币、到账多少美元。']],
  ['记错了', ['在首页「最近记的」里点那一笔，可以改，也可以删。早一点的点放大镜搜出来。']],
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
    special: editing.special || '', wishFund: Boolean(editing.wishFund),
  } : {
    type: q.type || 'expense', amount: q.amount || '', account: q.account || last.account || 'a-wechat', to: '', toAmount: '',
    category: '', date: today(), note: q.note || '', split: 'none', person: '', sub: null, what: '', tax: '', favor: '', who: '', special: q.special || '', wishFund: false,
  };
  // 从「这次要还的人情」点进来：类别先选聚餐请客，人情先选上
  if (!editing && q.favor && d.favors.some((f) => f.id === q.favor && f.status !== 'done')) {
    st.favor = q.favor; st.who = d.favors.find((f) => f.id === q.favor).person; st.category = 'c-social'; st.sub = category(d, 'c-social')?.sub || null;
  }
  // 从专项点「办完了」进来：专项先选上、类别和金额先填好，点「记好了」才算数
  if (!editing && q.special && d.goals.some((g) => g.id === q.special && !g.status)) {
    st.special = q.special;
    if (q.category && d.categories.some((c) => c.id === q.category && c.kind === 'expense')) { st.category = q.category; st.sub = category(d, q.category)?.sub || null; }
  }
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
  const fee = h('input', { inputmode: 'decimal', placeholder: '手续费（没有就不填）', 'aria-label': '手续费' });

  const box = h('div', {});
  let toTouched = Boolean(editing);
  const amountInput = h('input', { class: 'amount-input', inputmode: 'decimal', placeholder: '0', 'aria-label': '金额', value: st.amount,
    oninput: (e) => { st.amount = e.target.value; drawHint(); syncTo(); drawSplit(); drawMemo(); if (st.wishFund) drawFundHint(); } });
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
          parts.push(h('div', { class: 'cat-group' }, h('span', { class: 'cat-group-name' }, g.name), body));
        }
        drawMemo();
        if (FREEFORM.includes(st.category)) {
          parts.push(h('label', { class: 'form-label' }, '具体是什么', whatInput));
        }
        parts.push(...favorSection(), ...whoSection(), ...specialSection(), ...wishFundSection());
      } else {
        parts.push(h('div', { class: 'label-sm' }, '来源'), chips(cats, st.category, (id) => { st.category = id; draw(); }, '收入来源'));
        parts.push(...whoSection());
        if (category(d, st.category)?.lump) parts.push(h('p', { class: 'muted small' }, '一次性的钱：不算这个月的收入和存钱，也不分给心愿基金，直接进存款，补到最需要的地方。'));
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
  // 专项存款（自己加的，比如毕业过渡金）：这笔是给那件事花的 → 从专项出，不占当月预算
  const specialSection = () => {
    const list = d.goals.filter((g) => !g.status || g.id === editing?.special);
    if (!list.length || st.favor) { st.special = ''; return []; }
    return [h('div', { class: 'label-sm' }, '算在哪个专项里（选填，不占这个月的预算）'),
      h('div', { class: 'chips special-chips', role: 'group', 'aria-label': '算在哪个专项里' }, list.map((g) => h('button', {
        type: 'button', class: `chip${st.special === g.id ? ' on' : ''}`, 'aria-pressed': String(st.special === g.id),
        onclick: () => { st.special = st.special === g.id ? '' : g.id; if (st.special) { st.wishFund = false; if (!st.category) st.category = 'c-special'; } draw(); },
      }, g.name)))];
  };
  // 用心愿基金的钱（2026-10-14 用户要的）：小东西不用先放进心愿单再买，记账时勾上就从心愿基金能随便用的出，不占这个月预算
  const fundHint = h('div', { class: 'muted small fund-hint' });
  const wishFundLeft = () => round2(wishFunds(d, today()).small + (editing?.wishFund ? cny(editing) : 0));
  const amountCny = () => { const n = num(st.amount) || 0; return isUsd(d, st.account) ? round2(n * usdRate()) : n; };
  const drawFundHint = () => {
    if (!st.wishFund) { fundHint.textContent = `不占这个月的预算 · 心愿基金能用 ${money(wishFundLeft())}`; fundHint.className = 'muted small fund-hint'; return; }
    const left = round2(wishFundLeft() - amountCny());
    fundHint.textContent = left < 0 ? `心愿基金能用的只有 ${money(wishFundLeft())}，不够这一笔` : `记好后心愿基金还能用 ${money(left)}`;
    fundHint.className = `small fund-hint ${left < 0 ? 'warn-text' : 'muted'}`;
  };
  const wishFundSection = () => {
    if (st.split !== 'none' || AUTO_CATEGORIES.includes(st.category)) { st.wishFund = false; return []; }
    const left = wishFundLeft();
    if (left <= 0 && !st.wishFund) return [];
    drawFundHint();
    return [h('label', { class: `fund-switch${st.wishFund ? ' on' : ''}` },
      h('input', { type: 'checkbox', checked: st.wishFund, 'aria-label': '用心愿基金的钱',
        onchange: (e) => { st.wishFund = e.target.checked; if (st.wishFund) st.special = ''; draw(); } }),
      h('span', { class: 'grow' }, h('span', { class: 'fund-switch-title' }, icon('sparkle'), '用心愿基金的钱'), fundHint))];
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

  const submit = async () => {
    const n = round2(num(st.amount));
    if (!(n > 0) && st.type !== 'adjust') return toast('先填金额', 'error');
    if (st.type === 'expense' && st.split === 'aa' && !editing) return submitAA(n);
    if (st.type === 'expense' && st.split === 'paidby' && !st.person) return toast('选一下是谁帮你付的', 'error');
    if ((st.type === 'expense' || st.type === 'income') && !st.category) return toast(st.type === 'income' ? '选一下收入来源' : '选一下类别', 'error');
    if (st.type === 'expense' && FREEFORM.includes(st.category) && !st.what.trim()) return toast('写一下具体是什么', 'error');
    if (st.type === 'expense' && st.category === 'c-special' && !st.special) return toast('选一下是哪个专项', 'error');
    if (st.type === 'transfer' && !st.to) return toast('选一下转到哪个账户', 'error');
    const useFund = st.type === 'expense' && st.wishFund && st.split === 'none';
    if (useFund && amountCny() > wishFundLeft() + 0.001) return toast(`心愿基金能用的只有 ${money(wishFundLeft())}，不够这一笔`, 'error');
    const usd = isUsd(d, st.account);
    const rec = { type: st.type, date: st.date, account: st.account, amount: st.type === 'adjust' ? num(st.amount) : n, note: st.note.trim() };
    if (st.type === 'expense' || st.type === 'income') {
      rec.category = st.category;
      if (usd) rec.cny = round2(n * usdRate());
      if (st.type === 'expense' && FREEFORM.includes(st.category)) rec.what = st.what.trim();
      const tax = round2(num(st.tax) || 0);
      if (st.type === 'income' && st.category === 'i-job' && tax > 0) rec.tax = tax;
      if (st.type === 'expense' && st.favor) rec.favor = st.favor;
      if (st.type === 'expense' && st.special) rec.special = st.special;
      if (useFund) rec.wishFund = true;
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
          if (!rec.special) delete data.tx[i].special;
          if (!rec.wishFund) delete data.tx[i].wishFund;
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
        }
        // 这笔把专项花够了：专项自己办完
        if (rec.special) for (const id of goalsPaid(data, today())) Object.assign(data.goals.find((g) => g.id === id), { status: 'done', doneAt: today() });
      });
      if (rec.special) checkYearly(); // 办完的每年的专项，下一年的马上出来
      if (!editing) writeJson(LAST_KEY, { account: st.type === 'transfer' || paidBy ? last.account : st.account });
      const jobShare = !editing && st.type === 'income' && st.category === 'i-job' && d.settings.sideIncomeSave != null ? round2(n * (1 - d.settings.sideIncomeSave)) : 0;
      toast(editing ? '已保存' : `已记：${title} ${exact(n, curOf(st.account))}${st.type === 'income' && category(d, st.category)?.lump ? '，不算这个月的收入，直接进存款' : ''}${paidBy ? `（${personName(st.person) || '他'}代付）` : ''}${useFund ? '，从心愿基金出' : ''}${jobShare ? `，其中 ${money(jobShare)} 进了心愿基金` : ''}`);
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
  setTimeout(() => { if (!editing) amountInput.focus(); });
  return h('div', {}, header(editing ? '改一笔' : '记一笔', helpButton('怎么记账', ADD_HELP)),
    box);
}

// ---------- 最近记的（原来的流水页，2026-10-24 并进首页） ----------

// 平时列最近 8 笔；点放大镜在全部时间里搜。搜的字换页回来还记得（改完一笔回到首页还是搜索结果）
const recentSearch = { open: false, text: '' };

function txHaystack(t) {
  return [txTitle(t), t.note, t.what, t.category ? catName(t.category) : '', t.account ? accName(t.account) : '', t.to ? accName(t.to) : '',
    t.person ? personName(t.person) : '', t.claim ? claimName(t.claim) : '', String(t.amount), t.date].filter(Boolean).join(' ').toLowerCase();
}

function recentCard() {
  const d = store.data;
  const list = h('div', { class: 'card tx-list recent-list' });
  const summary = h('div', { class: 'muted small recent-sum' });
  const input = h('input', { type: 'search', placeholder: '搜：理发、打印、25、小王……', 'aria-label': '搜索记过的账', value: recentSearch.text,
    oninput: (e) => { recentSearch.text = e.target.value; draw(); } });
  const box = h('div', { class: 'recent-search' }, input);
  const draw = () => {
    const words = recentSearch.open ? recentSearch.text.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
    box.hidden = !recentSearch.open;
    btn.classList.toggle('on', recentSearch.open);
    let tx = [...d.tx].sort(txOrder);
    if (words.length) {
      tx = tx.filter((t) => words.every((w) => txHaystack(t).includes(w)));
      const spend = tx.filter((t) => t.type === 'expense' || t.type === 'writeoff').reduce((a, t) => a + cny(t), 0);
      const income = tx.filter((t) => t.type === 'income').reduce((a, t) => a + cny(t), 0);
      summary.textContent = `找到 ${tx.length} 笔${spend ? ` · 支出 ${money(spend)}` : ''}${income ? ` · 收入 ${money(income)}` : ''}`;
    } else {
      tx = tx.slice(0, 8);
      summary.textContent = '';
    }
    summary.hidden = !words.length;
    list.replaceChildren(...(tx.length ? tx.map((t) => txRow(t)) : [h('p', { class: 'muted' }, '没有找到。')]));
  };
  const btn = h('button', { class: 'recent-btn', 'aria-label': '搜索', onclick: () => {
    recentSearch.open = !recentSearch.open;
    if (!recentSearch.open) { recentSearch.text = ''; input.value = ''; }
    draw();
    if (recentSearch.open) input.focus();
  } }, icon('search'));
  draw();
  return [h('div', { class: 'section-title recent-head' }, h('span', {}, '最近记的'), btn), box, summary, list];
}

// ---------- 模拟交易（2026-10-24） ----------
// 假的 1 万块，按真的规则买卖 A 股、ETF、美股。每一笔写为什么，下单前 AI 问一两句，卖出一周 / 买入一个月后回头看，每月复盘一次。
// 不是钱：不进总资产、预算、任何统计。数据是 finance.json 里的 simGames / simTrades / simWatch / simReviews

const SIM_HELP = [
  ['这是什么', ['用假的 1 万块练习买卖股票。规则按真的来，将来真进场时手感一样。', '每一笔都写下为什么。这些记录攒着，AI 慢慢就知道你是怎么想的。']],
  ['规则', ['A 股：工作日 9:30–11:30、13:00–15:00 能买卖。100 股一手（科创板最少 200 股）。今天买的明天才能卖；跨境、黄金、债券 ETF 当天能卖。',
    '美股：北京时间晚上 21:30 到第二天 4:00 能买卖（冬天晚一小时）。1 股起，当天能卖。钱按当天汇率从这 1 万里换。',
    '买按「卖一」价成交，卖按「买一」价成交。涨停时没人卖、买不到；跌停时没人买、卖不出去。',
    '手续费：A 股每笔最低 5 元，股票卖出另收千分之 0.5 印花税；美股每笔大约 2 美元。']],
  ['颜色', ['红色是涨，绿色是跌，和国内的炒股软件一样。']],
  ['买卖的时候', ['写一句为什么，选打算拿多久，点一下有几成把握（1 没底，5 很有把握）。点「下一步」后 AI 会问一两句，可以答，也可以不答。']],
  ['两条线', ['「一共」下面的图里，蓝线是：如果开局时把钱全买成沪深 300 ETF、一直不动，现在值多少。比一比，看自己挑的有没有比它好。']],
  ['股票页的圆点', ['走势图上的红点是你买的那天，绿点是你卖的那天。']],
  ['回头看', ['卖出一周后、买入一个月后，会问一句当时想对了没有。']],
  ['复盘', ['每个月初 AI 自动写上个月的复盘；想复盘的时候也可以点「现在复盘」。']],
  ['导出', ['「导出给 ChatGPT」把全部记录和一段问题复制好，打开 ChatGPT 粘贴就行。']],
  ['重开一局', ['在最下面。现在这局收起来，记录都留着，导出时一起带上。']],
];

const simOf = (d) => ({ games: d.simGames, trades: d.simTrades, watch: d.simWatch, reviews: d.simReviews });
const simQ = {}; // 行情 { sym: … }，只在内存
const simMeta = {}; // 搜到过的股票 { sym: { sym, k, code, name, kind, mkt } }
const simDaily = {}; // 每天的价格 { 'k|天数|复权': { at, rows } }
const simBusy = new Set();
let simRange = 66; // 走势看多久（交易日）
const SIM_FRESH = 15000;

const upDown = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const simSigned = (n, fmt) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
const pctText = (x) => simSigned(x * 100, (v) => `${v.toFixed(2)}%`);
const curSign = (sym) => (marketOf(sym) === 'US' ? '$' : '¥');
const px = (sym, n) => `${curSign(sym)}${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: n < 10 ? 3 : 2, maximumFractionDigits: n < 10 ? 3 : 2 })}`;
const mktName = (s) => (marketOf(s.sym) === 'US' ? '美股' : /ETF|LOF/.test(s.kind || '') ? 'ETF' : 'A 股');
// 买卖的时间一律按北京时间写（美股也是，看的人在国内）
const timeText = (iso) => {
  const z = zoned(new Date(iso), 'Asia/Shanghai');
  return `${Number(z.date.slice(5, 7))}/${Number(z.date.slice(8))} ${String(Math.floor(z.min / 60)).padStart(2, '0')}:${String(z.min % 60).padStart(2, '0')}`;
};

function simLoad(key, fn) {
  if (simBusy.has(key)) return;
  simBusy.add(key);
  fn().then(() => { if (currentPath().startsWith('/sim')) render(); }, () => {}).finally(() => simBusy.delete(key));
}
// 要用的行情：没有或超过 15 秒就去拉，拉回来重画
function needQuotes(syms, force = false) {
  const stale = [...new Set(syms)].filter((s) => force || !simQ[s] || Date.now() - simQ[s].at > SIM_FRESH);
  if (stale.length) simLoad(`q:${stale.join(',')}`, async () => Object.assign(simQ, await fetchQuotes(stale)));
}
function needDaily(k, opts) {
  const key = `${k}|${opts.days}|${opts.from || ''}|${opts.adjust ?? 'qfq'}`;
  const c = simDaily[key];
  if (!c || Date.now() - c.at > 600000) simLoad(key, async () => { simDaily[key] = { at: Date.now(), rows: await fetchDaily(k, opts) }; });
  return c?.rows || null;
}
// 开盘时每 15 秒刷新一次价格
setInterval(() => {
  if (!currentPath().startsWith('/sim') || document.hidden || !store?.data) return;
  if (marketState('A').open || marketState('US').open) render();
}, SIM_FRESH);

// 一只股票的资料：搜到过的、买过的、看着的；都没有就按代码搜一次
function simInfo(sym) {
  const d = store.data;
  const from = simMeta[sym] || d.simTrades.find((t) => t.sym === sym) || d.simWatch.find((w) => w.sym === sym);
  if (from) return { sym, k: from.k, code: from.code || sym.replace(/^(sh|sz|bj|us)/, ''), name: simQ[sym]?.name || from.name, kind: from.kind, mkt: marketOf(sym) };
  simLoad(`m:${sym}`, async () => {
    const list = (await searchStocks(sym.replace(/^(sh|sz|bj|us)/, ''))) || [];
    for (const x of list) simMeta[x.sym] = x;
    if (!simMeta[sym]) simMeta[sym] = { sym, k: sym, code: sym.slice(2), name: sym, kind: '', mkt: marketOf(sym), missing: true };
  });
  return null;
}

function simView() {
  const d = store.data;
  const sim = simOf(d);
  const g = currentGame(sim);
  const help = helpButton('模拟怎么用', SIM_HELP);
  if (!g) {
    return h('div', {}, header('模拟', help),
      h('div', { class: 'card sim-intro' },
        h('h3', {}, '用假的 1 万块练习'),
        h('p', {}, '按真的规则买卖 A 股、ETF、美股。每一笔写下为什么，AI 慢慢认识你的想法。'),
        h('p', { class: 'muted small' }, '这不是钱，不进账本的任何计算。'),
        h('button', { onclick: () => save('模拟：开始', (data) => { data.simGames.push({ id: newId('g'), start: bjDate(), cash: START_CASH }); }).then(render) }, '开始')),
      oldGames(sim));
  }
  const rate = usdRate();
  const look = lookbackDue(sim, bjDate());
  needQuotes([...positions(sim, g.id).map((p) => p.sym), ...d.simWatch.map((w) => w.sym), look?.sym, BENCH.sym].filter(Boolean));
  const w = worth(sim, g.id, simQ, rate);
  const due = reviewDue(sim, bjDate());
  if (due && !simBusy.has(`review:${due}`) && !simReviewFailed.has(due)) simReview(due);
  const recentReview = [...d.simReviews].sort((a, b) => b.at.localeCompare(a.at))[0];
  const showReview = recentReview && (Date.now() - new Date(recentReview.at)) < 10 * 86400000;
  const trades = d.simTrades.filter((t) => t.game === g.id).sort((a, b) => b.at.localeCompare(a.at));
  return h('div', {},
    header('模拟', help),
    h('div', { class: 'chips sim-markets' }, ['A', 'US'].map((m) => {
      const st = marketState(m);
      return h('span', { class: `tag${st.open ? ' on' : ''}` }, st.text);
    })),
    worthCard(sim, g, w, rate),
    look ? lookbackCard(look) : null,
    due && simBusy.has(`review:${due}`) ? h('div', { class: 'card' }, h('p', { class: 'muted' }, `AI 在写 ${Number(due.slice(5))} 月的复盘…`)) : null,
    showReview ? simReviewCard(recentReview, true) : null,
    h('div', { class: 'section-title' }, '持有'),
    w.pos.length ? h('div', { class: 'group' }, w.pos.map((p) => h('a', { class: 'cell sim-row', href: `#/sim/s/${p.sym}` },
      h('span', { class: 'grow' }, p.name, h('span', { class: 'muted small block' }, `${p.qty} 股 · 成本 ${px(p.sym, p.avg)}`)),
      h('span', { class: 'sim-right' }, exact(p.value), h('span', { class: `small block ${upDown(p.gain)}` }, pctText(p.pct))))))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有买。搜一只看看。')),
    h('button', { class: 'secondary sim-search-btn', onclick: searchSheet }, icon('search'), ' 搜一只'),
    d.simWatch.length ? [h('div', { class: 'section-title' }, '看着的'),
      h('div', { class: 'group' }, d.simWatch.map((x) => {
        const q = simQ[x.sym];
        return h('a', { class: 'cell sim-row', href: `#/sim/s/${x.sym}` },
          h('span', { class: 'grow' }, x.name, h('span', { class: 'muted small block' }, [`${md(x.at)}关注时 ${px(x.sym, x.price)}`, x.reason].filter(Boolean).join(' · '))),
          q ? h('span', { class: 'sim-right' }, px(x.sym, q.price), h('span', { class: `small block ${upDown(q.pct)}` }, `今天 ${pctText(q.pct / 100)}`)) : null);
      }))] : null,
    trades.length ? [h('div', { class: 'section-title' }, '最近的买卖'),
      h('div', { class: 'group' }, trades.slice(0, 6).map(tradeRow)),
      trades.length > 6 ? h('p', { class: 'center' }, h('a', { href: '#/sim/trades' }, `全部 ${trades.length} 笔`)) : null] : null,
    h('div', { class: 'group sim-tools' },
      cell({ onclick: () => simReview(null), ic: 'sparkle', title: '现在复盘', sub: recentReview ? `上次 ${md(recentReview.at.slice(0, 10))}` : 'AI 看看你最近的买卖' }),
      d.simReviews.length ? cell({ href: '#/sim/reviews', ic: 'book', color: 'var(--sage)', title: '以前的复盘', meta: `${d.simReviews.length} 篇` }) : null,
      cell({ onclick: exportSheet, ic: 'receipt', color: 'var(--blue)', title: '导出给 ChatGPT', sub: '全部记录 + 一段问题，复制好去粘贴' })),
    oldGames(sim),
    h('p', { class: 'center small' }, h('button', { class: 'link', onclick: () => restartGame(g, w) }, '重开一局')));
}

// 对照：开局时的钱一直拿着沪深 300，这些天每天值多少；还没读到是 null
function simBench(g, dates) {
  const rows = needDaily(BENCH.k, { days: 800, from: addDays(g.start, -10), adjust: 'qfq' });
  return rows?.length ? benchSeries(rows, g.start, g.cash, dates, bjDate(), simQ[BENCH.sym]?.price) : null;
}

function worthCard(sim, g, w, rate) {
  const gain = w.total - w.start;
  const syms = [...new Set(store.data.simTrades.filter((t) => t.game === g.id).map((t) => t.k))];
  const closes = {};
  let ready = true;
  for (const k of syms) {
    const rows = needDaily(k, { days: 400, from: g.start, adjust: '' });
    if (!rows) ready = false;
    closes[k.replace(/\..*$/, '')] = rows || [];
  }
  const live = Object.fromEntries(Object.entries(simQ).map(([s, q]) => [s, q.price]));
  const series = ready ? worthSeries(sim, g.id, closes, rate, bjDate(), live) : [];
  const bench = simBench(g, series.length ? series.map((x) => x[0]) : [bjDate()]);
  const benchNow = bench?.at(-1)?.[1];
  const diff = benchNow ? w.total - benchNow : 0;
  return h('div', { class: 'card sim-worth' },
    h('div', { class: 'muted small' }, '一共'),
    bigMoney(w.total),
    h('div', { class: `sim-gain ${upDown(gain)}` }, `${simSigned(gain, exact)} · ${pctText(w.pct)}`),
    h('div', { class: 'muted small' }, `现金 ${exact(w.cash)} · 持有 ${exact(w.hold)}`),
    series.length >= 2 ? lineChart([{ values: series.map(() => w.start), color: 'var(--muted)', dashed: true },
      ...(bench ? [{ values: bench.map((x) => x[1]), color: 'var(--blue)' }] : []), { values: series.map((x) => x[1]), color: 'var(--accent)' }],
      { tight: true, height: 120, title: '每天一共值多少', fmt: (v) => String(Math.round(v)), xLabels: [[0, md(series[0][0])], [series.length - 1, '今天']] }) : null,
    series.length >= 2 && bench ? h('div', { class: 'muted small sim-legend' }, h('span', { class: 'sim-key', style: '--c:var(--accent)' }), '我的', h('span', { class: 'sim-key', style: '--c:var(--blue)' }), '一直拿沪深 300') : null,
    benchNow ? h('div', { class: 'small sim-bench' }, `一直拿沪深 300：${exact(benchNow)} · `,
      h('span', { class: upDown(diff) }, Math.abs(diff) < 0.5 ? '和它差不多' : `你比它${diff > 0 ? '多' : '少'} ${exact(Math.abs(diff))}`)) : null,
    h('div', { class: 'muted small' }, `从 ${md(g.start)}开始 · 起始 ${exact(w.start)}`));
}

function tradeRow(t) {
  return h('button', { type: 'button', class: 'cell sim-row', onclick: () => tradeSheet(t) },
    h('span', { class: `sim-side ${t.side}` }, t.side === 'buy' ? '买' : '卖'),
    h('span', { class: 'grow' }, `${t.name} ${t.qty} 股`, h('span', { class: 'muted small block' }, [timeText(t.at), px(t.sym, t.price), t.reason].filter(Boolean).join(' · '))),
    h('span', { class: 'sim-right' }, exact(t.cny)));
}

function tradeSheet(t) {
  const row = (k, v) => (v ? h('div', { class: 'sim-kv' }, h('span', { class: 'muted' }, k), h('span', {}, v)) : null);
  openSheet({
    title: `${t.side === 'buy' ? '买' : '卖'} ${t.name}`,
    body: h('div', {},
      row('时间', timeText(t.at)),
      row('数量', `${t.qty} 股`),
      row('成交价', px(t.sym, t.price)),
      row('手续费', `${curSign(t.sym)}${t.fee}`),
      row(t.side === 'buy' ? '一共花了' : '一共拿回', `${exact(t.cny)}${marketOf(t.sym) === 'US' ? `（1 美元按 ¥${t.rate.toFixed(2)}）` : ''}`),
      row('为什么', t.reason),
      row('打算拿多久', holdName(t.hold)),
      row('有几成把握', t.sure ? `${t.sure} / 5` : ''),
      (t.ask || []).map((x) => h('div', { class: 'sim-qa' }, h('div', { class: 'muted small' }, `AI：${x.q}`), h('div', {}, x.a || '（没答）'))),
      t.look && !t.look.skip ? h('div', { class: 'sim-qa' }, h('div', { class: 'muted small' }, `回头看 · ${md(t.look.at.slice(0, 10))}`), h('div', {}, [lookName(t.look.verdict), t.look.text].filter(Boolean).join('：'))) : null,
      currentPath() === `/sim/s/${t.sym}` ? null : h('p', {}, h('a', { href: `#/sim/s/${t.sym}` }, `看看 ${t.name} →`))),
    confirmText: '好', cancelText: null, onConfirm: () => {},
  });
}

function oldGames(sim) {
  const ended = sim.games.filter((g) => g.end);
  if (!ended.length) return null;
  return [h('div', { class: 'section-title' }, '以前的几局'),
    h('div', { class: 'group' }, ended.map((g) => h('div', { class: 'cell' },
      h('span', { class: 'grow' }, `${md(g.start)} – ${md(g.end)}`, h('span', { class: 'muted small block' }, `${sim.trades.filter((t) => t.game === g.id).length} 笔买卖`)),
      h('span', { class: `sim-right ${upDown(g.endValue - g.cash)}` }, `${exact(g.cash)} → ${exact(g.endValue)}`))))];
}

function restartGame(g, w) {
  if (!confirm('重开一局？现在这局收起来，记录都留着，重新从 1 万开始。')) return;
  save('模拟：重开一局', (data) => {
    const x = data.simGames.find((y) => y.id === g.id);
    Object.assign(x, { end: bjDate(), endValue: w.total });
    data.simGames.push({ id: newId('g'), start: bjDate(), cash: START_CASH });
  }).then(render);
}

// 搜一只：拼音、中文、代码都行
function searchSheet() {
  const list = h('div', { class: 'group sim-results' });
  let timer = null;
  let n = 0;
  const run = async (q) => {
    const my = ++n;
    if (!q.trim()) { list.replaceChildren(); return; }
    const res = await searchStocks(q.trim());
    if (my !== n) return;
    if (!res) { list.replaceChildren(h('p', { class: 'muted cell' }, '搜不了，看看网络')); return; }
    for (const x of res) simMeta[x.sym] = x;
    list.replaceChildren(...(res.length ? res.slice(0, 12).map((x) => h('a', { class: 'cell', href: `#/sim/s/${x.sym}`, onclick: () => close() },
      h('span', { class: 'grow' }, x.name, h('span', { class: 'muted small block' }, `${x.code} · ${mktName(x)}`)))) : [h('p', { class: 'muted cell' }, '没有找到（港股不支持）')]));
  };
  const input = h('input', { type: 'search', placeholder: '茅台、maotai、600519、苹果、AAPL', 'aria-label': '搜股票', oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => run(e.target.value), 300); } });
  const close = openSheet({ title: '搜一只', body: h('div', {}, input, list), confirmText: '关闭', cancelText: null, onConfirm: () => {} });
  input.focus();
}

function simStockView(sym) {
  const d = store.data;
  const sim = simOf(d);
  const g = currentGame(sim);
  if (!g) return h('div', {}, header('模拟'), h('div', { class: 'card' }, h('p', {}, '还没开始模拟。'), h('a', { href: '#/sim', class: 'button' }, '去开始')));
  needQuotes([sym]);
  const s = simInfo(sym);
  const q = simQ[sym];
  if (!s) return h('div', {}, header('…'), h('p', { class: 'muted center' }, '正在读…'));
  if (s.missing && !q) return h('div', {}, header('没有找到'), h('div', { class: 'card' }, h('p', {}, '没有这只股票。'), h('a', { href: '#/sim', class: 'button' }, '回到模拟')));
  const st = marketState(s.mkt, new Date(), q?.date);
  const pos = positions(sim, g.id).find((p) => p.sym === sym);
  const watching = d.simWatch.find((w) => w.sym === sym);
  const rows = needDaily(s.k, { days: simRange });
  const mine = d.simTrades.filter((t) => t.sym === sym).sort((a, b) => b.at.localeCompare(a.at));
  const marks = rows ? tradeMarks(rows, mine).map((m) => ({ i: m.i, color: m.side === 'buy' ? 'var(--up)' : 'var(--down)' })) : [];
  const l = lot(sym);
  const rules = [st.text, tPlus0(s) ? '当天买当天能卖' : '今天买的明天才能卖', l.min === l.step ? `${l.min} ${l.unit}起` : `最少 ${l.min} 股`];
  return h('div', {},
    headerSub(s.name, `${s.code} · ${mktName(s)}`),
    h('div', { class: 'card sim-quote' },
      q ? [h('div', { class: 'sim-price' }, px(sym, q.price)),
        h('div', { class: `sim-gain ${upDown(q.change)}` }, `今天 ${simSigned(q.change, (v) => v.toFixed(v < 10 ? 3 : 2))} · ${pctText(q.pct / 100)}`),
        h('div', { class: 'muted small' }, `卖一 ${px(sym, q.ask)} · 买一 ${px(sym, q.bid)}${s.mkt === 'US' ? ` · 1 美元 ≈ ¥${usdRate().toFixed(2)}` : ''}`)]
        : h('p', { class: 'muted' }, '正在读价格…'),
      h('div', { class: 'segmented sim-range' }, [[22, '1 个月'], [66, '3 个月'], [250, '1 年']].map(([n, t]) =>
        h('button', { class: `seg${simRange === n ? ' on' : ''}`, onclick: () => { simRange = n; render(); } }, t))),
      rows && rows.length >= 2 ? lineChart([{ values: rows.map((r) => r[1]), color: 'var(--accent)' }],
        { tight: true, height: 140, title: '走势', marks, fmt: (v) => v.toFixed(v >= 1000 ? 0 : v >= 100 ? 1 : v >= 10 ? 2 : 3), xLabels: [[0, md(rows[0][0])], [rows.length - 1, md(rows.at(-1)[0])]] }) : h('p', { class: 'muted small' }, rows ? '没有走势' : '正在读走势…'),
      marks.length ? h('div', { class: 'muted small sim-legend' }, h('span', { class: 'sim-key dot', style: '--c:var(--up)' }), '我买的那天', h('span', { class: 'sim-key dot', style: '--c:var(--down)' }), '我卖的那天') : null,
      h('div', { class: 'muted small' }, rules.join(' · '))),
    pos ? h('div', { class: 'card' },
      h('h3', {}, '我持有'),
      h('div', { class: 'sim-kv' }, h('span', { class: 'muted' }, '数量'), h('span', {}, `${pos.qty} 股${pos.sellable < pos.qty ? `（今天能卖 ${pos.sellable}）` : ''}`)),
      h('div', { class: 'sim-kv' }, h('span', { class: 'muted' }, '平均成本'), h('span', {}, px(sym, pos.avg))),
      q ? (() => { const fx = s.mkt === 'US' ? usdRate() : 1; const v = pos.qty * q.price * fx; return h('div', { class: 'sim-kv' }, h('span', { class: 'muted' }, '现在值'), h('span', { class: upDown(v - pos.cost) }, `${exact(v)}（${simSigned(v - pos.cost, exact)}）`)); })() : null)
      : null,
    h('div', { class: 'actions sim-actions' },
      h('button', { class: 'sim-buy', onclick: () => orderSheet(s, 'buy') }, '买'),
      pos ? h('button', { class: 'sim-sell', onclick: () => orderSheet(s, 'sell') }, '卖') : null,
      watching ? h('button', { class: 'secondary', onclick: () => saveUndoable(`模拟：不看 ${s.name}`, (data) => { data.simWatch = data.simWatch.filter((x) => x.sym !== sym); }, '不看了').then(render) }, '不看了')
        : h('button', { class: 'secondary', onclick: () => watchSheet(s) }, '加到看着的')),
    watching?.reason ? h('p', { class: 'muted small' }, `关注的原因：${watching.reason}`) : null,
    mine.length ? [h('div', { class: 'section-title' }, '我的买卖'), h('div', { class: 'group' }, mine.map(tradeRow))] : null);
}

function watchSheet(s) {
  const reason = h('textarea', { rows: 2, placeholder: '比如：天天听人说 / 想看看它怎么动', 'aria-label': '为什么关注' });
  openSheet({
    title: `看着 ${s.name}`,
    body: h('div', {}, h('label', {}, '为什么关注（可以不写）', reason)),
    confirmText: '加上',
    onConfirm: async () => {
      await save(`模拟：看着 ${s.name}`, (data) => {
        data.simWatch.push({ id: newId('w'), sym: s.sym, k: s.k, code: s.code, name: s.name, kind: s.kind, reason: reason.value.trim(), at: bjDate(), price: simQ[s.sym]?.price || 0 });
      });
      render();
    },
  });
}

// 买 / 卖：① 数量 + 为什么 + 打算拿多久 → ② AI 问一两句 → ③ 按那一刻的价格成交
function orderSheet(s, side) {
  const d = store.data;
  const g = currentGame(simOf(d));
  const verb = side === 'buy' ? '买' : '卖';
  const q0 = simQ[s.sym];
  const pos = positions(simOf(d), g.id).find((p) => p.sym === s.sym);
  const l = lot(s.sym);
  const most = side === 'buy' ? maxBuy(simOf(d), g.id, s, q0?.ask, usdRate()) : pos?.qty || 0;
  const qty = h('input', { inputmode: 'numeric', placeholder: l.min === l.step ? `${l.min} 的倍数` : `最少 ${l.min}`, value: side === 'sell' ? String(most || '') : '', oninput: () => est() });
  const estLine = h('div', { class: 'muted small' });
  const err = h('div', { class: 'hint error' });
  const est = () => {
    const n = Number(qty.value);
    const p = side === 'buy' ? q0?.ask : q0?.bid;
    if (!n || !p) { estLine.textContent = side === 'buy' ? `现金 ${exact(cash(simOf(d), g.id))}` : ''; return; }
    const fee = fees(s, side, n, p);
    const fx = s.mkt === 'US' ? usdRate() : 1;
    const total = (side === 'buy' ? n * p + fee : n * p - fee) * fx;
    estLine.textContent = `约 ${exact(total)}（手续费 ${curSign(s.sym)}${fee}）${side === 'buy' ? ` · 现金 ${exact(cash(simOf(d), g.id))}` : ''}`;
  };
  let hold = '';
  const holdChips = h('div', { class: 'chips' }, HOLD.map(([k, t]) => h('button', { type: 'button', class: 'chip', onclick: (e) => {
    hold = k; for (const c of holdChips.children) c.classList.toggle('on', c === e.currentTarget);
  } }, t)));
  let sure = 0;
  const sureChips = h('div', { class: 'chips' }, SURE.map((n) => h('button', { type: 'button', class: 'chip sim-sure', 'aria-label': `把握 ${n}`, onclick: (e) => {
    sure = n; for (const c of sureChips.children) c.classList.toggle('on', c === e.currentTarget);
  } }, String(n))));
  const reason = h('textarea', { rows: 3, 'aria-label': `为什么${verb}`, placeholder: side === 'buy' ? '一句话就行：一直在涨、听说不错、想试试……' : '一句话就行：涨够了、跌怕了、想换一只……' });
  const quick = h('div', { class: 'chips' },
    side === 'buy' ? [h('button', { type: 'button', class: 'chip', onclick: () => { qty.value = String(l.min); est(); } }, `${l.min} 股`),
      most ? h('button', { type: 'button', class: 'chip', onclick: () => { qty.value = String(most); est(); } }, `最多 ${most} 股`) : null]
      : [h('button', { type: 'button', class: 'chip', onclick: () => { qty.value = String(most); est(); } }, `全部 ${most} 股`)]);
  const step1 = h('div', {},
    h('p', { class: 'small' }, q0 ? `${side === 'buy' ? '卖一' : '买一'} ${px(s.sym, side === 'buy' ? q0.ask : q0.bid)}，成交价以点确认那一刻为准` : '还没读到价格'),
    h('label', {}, `${verb}多少股`, qty), quick, estLine,
    side === 'sell' && pos && pos.sellable < pos.qty ? h('p', { class: 'small soon' }, `今天买的 ${pos.qty - pos.sellable} 股明天才能卖`) : null,
    h('label', {}, `为什么${verb}`, reason),
    side === 'buy' ? [h('div', { class: 'small strong' }, '打算拿多久'), holdChips] : null,
    h('div', { class: 'small strong' }, '有几成把握', h('span', { class: 'muted' }, ' · 1 没底，5 很有把握')), sureChips,
    err);
  est();
  const body = h('div', {}, step1);
  let step = 1;
  let asks = [];
  const order = () => ({ qty: Number(qty.value), reason: reason.value.trim(), hold: side === 'buy' ? hold : undefined, sure });
  const close = openSheet({
    title: `${verb} ${s.name}`, body, confirmText: '下一步',
    onConfirm: async () => {
      err.textContent = '';
      const o = order();
      if (step === 1) {
        const q = simQ[s.sym];
        const chk = q ? checkOrder(simOf(store.data), g.id, s, side, o.qty, q, usdRate()) : { error: '还没读到价格' };
        if (chk.error) { err.textContent = chk.error; return false; }
        if (!o.reason) { err.textContent = `写一句为什么${verb}`; return false; }
        if (side === 'buy' && !hold) { err.textContent = '选一下打算拿多久'; return false; }
        if (!sure) { err.textContent = '点一下有几成把握'; return false; }
        step = 2;
        const btn = document.querySelector('.sheet .actions button');
        btn.textContent = `确认${verb}`;
        btn.disabled = true;
        const wait = h('p', { class: 'muted' }, 'AI 在看你写的…');
        body.replaceChildren(wait);
        try {
          const qs = await simAsk(s, side, o, q);
          asks = qs.map((x) => ({ q: x, box: h('textarea', { rows: 2, 'aria-label': x, placeholder: '想答就答，不答也行' }) }));
          body.replaceChildren(h('p', { class: 'small' }, '先想一想：'), ...asks.map((x) => h('label', {}, x.q, x.box)), err);
        } catch {
          body.replaceChildren(h('p', { class: 'muted small' }, '这次 AI 没问（没连上）。'), err);
        }
        btn.disabled = false;
        return false;
      }
      // 第 3 步：按这一刻的价格成交
      let q;
      try { q = (await fetchQuotes([s.sym]))[s.sym]; } catch { /* 没网 */ }
      if (!q) { err.textContent = '读不到最新价格，看看网络'; return false; }
      simQ[s.sym] = q;
      const chk = checkOrder(simOf(store.data), g.id, s, side, o.qty, q, usdRate());
      if (chk.error) { err.textContent = chk.error; return false; }
      const now = new Date();
      await save(`模拟：${verb} ${s.name} ${o.qty} 股`, (data) => {
        data.simTrades.push({ id: newId('m'), game: g.id, at: now.toISOString(), date: bjDate(now), sym: s.sym, k: s.k, code: s.code, name: s.name, kind: s.kind || '',
          side, qty: o.qty, price: chk.price, fee: chk.fee, rate: chk.rate, cny: chk.cny, reason: o.reason, ...(o.hold ? { hold: o.hold } : {}), sure: o.sure,
          ask: asks.map((x) => ({ q: x.q, a: x.box.value.trim() })) });
      });
      toast(`${verb}了 ${o.qty} 股 ${s.name}，成交价 ${px(s.sym, chk.price)}`);
      render();
      return true;
    },
  });
  return close;
}

// 下单前 AI 问一两句：只问，不评价、不建议
async function simAsk(s, side, o, q) {
  const d = store.data;
  const sim = simOf(d);
  const g = currentGame(sim);
  const w = worth(sim, g.id, simQ, usdRate());
  const before = d.simTrades.filter((t) => t.sym === s.sym).map((t) => `${t.date} ${t.side === 'buy' ? '买' : '卖'} ${t.qty} 股 @${t.price}，理由：${t.reason}`);
  const others = d.simTrades.filter((t) => t.sym !== s.sym).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map((t) => `${t.date} ${t.side === 'buy' ? '买' : '卖'} ${t.name}，理由：${t.reason}`);
  const system = `你在陪一个刚开始学股票的大学生做模拟交易（假钱，起始 1 万元人民币，规则按真的）。他完全不懂股票，想一点一点积累认识，也想留下记录让 AI 了解他的逻辑。
他准备${side === 'buy' ? '买' : '卖'}一只股票，写了理由。请你提 1～2 个短问题，帮他把自己的想法想清楚：比如打算拿多久、跌了或涨了怎么办、这次和他以前的买卖是不是一个思路。
不评价对错，不建议买不买，不讲课。用大白话，每个问题 40 字以内，语气温和。
只回 JSON：{"questions": ["…"]}`;
  const user = [`股票：${s.name}（${s.code}，${mktName(s)}）`, `现价 ${q.price}，今天 ${q.pct}%`, `${side === 'buy' ? '买' : '卖'} ${o.qty} 股`,
    `他的理由：${o.reason}`, o.hold ? `打算拿：${holdName(o.hold)}` : null, `把握：${o.sure}/5（1 没底，5 很有把握）`,
    `现在：一共 ${w.total} 元，现金 ${w.cash} 元，持有 ${w.pos.map((p) => `${p.name} ${p.qty} 股`).join('、') || '无'}`,
    before.length ? `这只以前的买卖：\n${before.join('\n')}` : '以前没买卖过这只',
    others.length ? `最近别的买卖：\n${others.join('\n')}` : null].filter(Boolean).join('\n');
  const out = await askJson(await aiConfig(), system, user, { maxTokens: 2000, timeout: 30000 });
  return (out.questions || []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 2);
}

// 回头看：一次问一笔
function lookbackCard(t) {
  const q = simQ[t.sym];
  let verdict = '';
  const text = h('textarea', { rows: 2, 'aria-label': '回头看想说的', placeholder: '可以写一句：现在怎么想', hidden: true });
  const saveBtn = h('button', { disabled: true, onclick: () => save(`模拟：回头看 ${t.name}`, (data) => {
    data.simTrades.find((x) => x.id === t.id).look = { at: new Date().toISOString(), verdict, text: text.value.trim(), price: q?.price || null };
  }).then(() => { toast('记下了'); render(); }) }, '记下');
  const chips = h('div', { class: 'chips' }, LOOK.map(([k, label]) => h('button', { type: 'button', class: 'chip', onclick: (e) => {
    verdict = k; text.hidden = false; saveBtn.disabled = false;
    for (const c of chips.children) c.classList.toggle('on', c === e.currentTarget);
  } }, label)));
  const days = Math.round((new Date(bjDate()) - new Date(t.date)) / 86400000);
  const change = q ? (q.price - t.price) / t.price : null;
  return h('div', { class: 'card sim-look' },
    h('h3', {}, '回头看'),
    h('p', {}, `${days >= 28 ? '一个多月' : `${days} 天`}前${t.side === 'buy' ? '买' : '卖'}了 ${t.name}，当时你说：「${t.reason}」`),
    q ? h('p', { class: 'small' }, `那时 ${px(t.sym, t.price)}，现在 ${px(t.sym, q.price)}（`, h('span', { class: upDown(change) }, pctText(change)), '）') : null,
    h('p', { class: 'small strong' }, '现在看，当时想对了吗？'),
    chips, text,
    h('div', { class: 'actions' }, saveBtn,
      h('button', { class: 'link', onclick: () => save(`模拟：回头看 ${t.name}（跳过）`, (data) => { data.simTrades.find((x) => x.id === t.id).look = { at: new Date().toISOString(), skip: true }; }).then(render) }, '跳过')));
}

// 全部记录写成文字：复盘、导出都用它。from：只要这一天以后的买卖（复盘用）
function simRecordText({ from = '', to = '', reviews = false } = {}) {
  const d = store.data;
  const sim = simOf(d);
  const rate = usdRate();
  const lines = [];
  const g = currentGame(sim);
  if (g) {
    const w = worth(sim, g.id, simQ, rate);
    lines.push(`## 现在这一局（${g.start} 开始，起始 ${g.cash} 元）`, `一共 ${w.total} 元（${pctText(w.pct)}），现金 ${w.cash} 元`);
    const b = simBench(g, [bjDate()])?.[0]?.[1];
    if (b) lines.push(`对照：如果开局时 ${g.cash} 元全买沪深 300 ETF 一直不动，现在约 ${b} 元（${pctText(b / g.cash - 1)}）`);
    for (const p of w.pos) lines.push(`- 持有 ${p.name}（${p.sym.replace(/^(sh|sz|bj|us)/, '')}，${mktName(p)}）${p.qty} 股，成本 ${p.cost} 元，现在 ${p.value} 元（${pctText(p.pct)}）`);
  }
  for (const old of sim.games.filter((x) => x.end)) lines.push(`以前一局：${old.start} 到 ${old.end}，${old.cash} 元 → ${old.endValue} 元`);
  const trades = d.simTrades.filter((t) => (!from || t.date >= from) && (!to || t.date <= to)).sort((a, b) => a.at.localeCompare(b.at));
  lines.push('', `## 买卖记录（${trades.length} 笔）`);
  for (const t of trades) {
    lines.push(`- ${timeText(t.at)}（${t.date.slice(0, 4)}）${t.side === 'buy' ? '买' : '卖'} ${t.name}（${t.code || t.sym}，${mktName(t)}）${t.qty} 股 @ ${curSign(t.sym)}${t.price}，手续费 ${t.fee}，合 ${t.cny} 元`);
    lines.push(`  理由：${t.reason}${t.hold ? `；打算拿 ${holdName(t.hold)}` : ''}${t.sure ? `；把握 ${t.sure}/5` : ''}`);
    for (const x of t.ask || []) lines.push(`  AI 问：${x.q} 我答：${x.a || '（没答）'}`);
    if (t.look && !t.look.skip) lines.push(`  回头看（${t.look.at.slice(0, 10)}）：${lookName(t.look.verdict)}${t.look.text ? `，${t.look.text}` : ''}${t.look.price ? `；那时价格 ${t.look.price}` : ''}`);
  }
  if (d.simWatch.length) {
    lines.push('', '## 在观察的（没买）');
    for (const x of d.simWatch) lines.push(`- ${x.name}（${x.code || x.sym}，${mktName(x)}）${x.at} 开始关注，那时 ${x.price}，现在 ${simQ[x.sym]?.price ?? '?'}${x.reason ? `；原因：${x.reason}` : ''}`);
  }
  if (reviews && d.simReviews.length) {
    lines.push('', '## 以前的复盘');
    for (const r of [...d.simReviews].sort((a, b) => a.at.localeCompare(b.at))) lines.push(`### ${reviewTitle(r)}`, r.text);
  }
  return lines.join('\n');
}

const simReviewFailed = new Set();
const reviewTitle = (r) => (r.month ? `${Number(r.month.slice(0, 4))} 年 ${Number(r.month.slice(5))} 月的复盘` : `${r.at.slice(0, 10)} 的复盘`);
// 复盘：month 有值 = 那个月；null = 从上次复盘到现在（没有就是全部）
async function simReview(month) {
  const key = `review:${month || 'now'}`;
  if (simBusy.has(key)) return;
  const d = store.data;
  let from = '';
  let to = '';
  if (month) { from = `${month}-01`; to = `${month}-31`; } else {
    const last = [...d.simReviews].sort((a, b) => b.at.localeCompare(a.at))[0];
    from = last ? last.at.slice(0, 10) : '';
  }
  if (!month && !d.simTrades.some((t) => !from || t.date >= from)) { toast(from ? '上次复盘以后还没有买卖' : '还没有买卖，先买一只'); return; }
  simBusy.add(key);
  const wait = month ? null : h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, 'AI 在复盘…'));
  wait && document.body.append(wait);
  try {
    const system = `你在帮一个刚开始学股票的大学生复盘他的模拟交易（假钱，规则按真的）。他完全不懂股票，想一点一点积累认识。
根据下面的记录，用大白话写一段复盘：这段时间做了什么（几笔、买了哪些类型）；他的理由大多是哪一类；说的打算（拿多久）和实际做的一不一致；有没有反复出现的习惯（比如涨了才买、跌一点就卖、很分散或很集中、频繁买卖）；把握大的那几笔是不是真的更好；结果怎样（赚亏只当事实说，也和一直拿沪深 300 比一比）。最后留一两个值得他自己想的问题。
不讲课，不推荐具体股票，不说该买该卖。语气温柔、安静、不评判，不用「你值得」「加油」这类话。250～450 字，可以分几段。
只回 JSON：{"text": "…"}`;
    const user = `${month ? `复盘 ${month}` : `复盘${from ? ` ${from} 以后` : '全部'}`}\n\n${simRecordText({ from, to })}`;
    const out = await askJson(await aiConfig(), system, user, { maxTokens: 6000, timeout: 120000 });
    if (!out.text) throw new Error('AI 没写出来');
    const r = { id: newId('r'), at: new Date().toISOString(), month: month || null, from, text: String(out.text) };
    await save(`模拟：${reviewTitle(r)}`, (data) => { data.simReviews.push(r); });
    if (!month) go('#/sim/reviews');
  } catch (e) {
    if (month) simReviewFailed.add(month);
    else toast(e.message, 'error');
  } finally {
    simBusy.delete(key);
    wait?.remove();
    if (month && currentPath().startsWith('/sim')) render();
  }
}

function simReviewCard(r, short = false) {
  return h('div', { class: 'card sim-review' },
    h('h3', {}, reviewTitle(r)),
    String(r.text).split(/\n+/).filter(Boolean).map((p) => h('p', {}, p)),
    short ? h('p', { class: 'small' }, h('a', { href: '#/sim/reviews' }, '以前的复盘 →')) : null);
}

function simReviewsView() {
  const list = [...store.data.simReviews].sort((a, b) => b.at.localeCompare(a.at));
  return h('div', {}, header('复盘'),
    list.length ? list.map((r) => simReviewCard(r)) : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有复盘。')));
}

function simTradesView() {
  const list = [...store.data.simTrades].sort((a, b) => b.at.localeCompare(a.at));
  return h('div', {}, header('全部买卖'),
    list.length ? h('div', { class: 'group' }, list.map(tradeRow)) : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有买卖。')));
}

const SIM_ASK = `我在用假钱做股票模拟交易（起始 1 万元人民币，规则按真的：A 股 T+1、100 股一手、有手续费；美股按汇率换算）。我完全不懂股票，想通过模拟一点一点积累认识，将来资产稳定了再用真钱投资。
下面是我全部的记录：每一笔买卖、当时写的理由、打算拿多久、有几成把握（1～5）、AI 当时问我的问题和我的回答、事后回头看的结论，还有我在观察的股票和以前的复盘。

请你：
1. 看看我买卖背后的逻辑是什么，有没有一贯的风格；
2. 指出我反复出现的习惯，好的和不好的都说；看看我有把握的时候是不是真的更准，我挑的有没有比一直拿沪深 300 好；
3. 用大白话解释记录里我可能没弄懂的地方；
4. 问我几个问题，帮我想清楚下一步。
不要直接推荐买哪只股票。`;

function exportSheet() {
  chatgptSheet({ ask: SIM_ASK, text: () => simRecordText({ reviews: true }), file: `模拟交易-${today()}.md`, what: '全部记录' });
}

// 导出给 ChatGPT：一段可以改的问题 + 记录，复制好打开 ChatGPT，或者下载成文件（模拟交易、月度报表共用）
function chatgptSheet({ ask: askText, text, file, what }) {
  const ask = h('textarea', { rows: 8, value: askText, 'aria-label': '想问 ChatGPT 的' });
  const full = () => `${ask.value.trim()}\n\n---\n\n${text()}`;
  openSheet({
    title: '导出给 ChatGPT',
    body: h('div', {},
      h('label', {}, '想问的（可以改）', ask),
      h('p', { class: 'muted small' }, `点「复制，去 ChatGPT」会把这段话和${what}一起复制，打开 ChatGPT 后长按粘贴。`),
      h('p', {}, h('button', { class: 'link', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([full()], { type: 'text/markdown' })), download: file });
        a.click();
      } }, '下载成文件'))),
    confirmText: '复制，去 ChatGPT',
    onConfirm: async () => {
      try { await navigator.clipboard.writeText(full()); } catch { toast('复制不了，用「下载成文件」', 'error'); return false; }
      window.open('https://chatgpt.com/', '_blank', 'noopener');
      toast('复制好了，到 ChatGPT 粘贴');
      return true;
    },
  });
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
    h('div', { class: 'card money-total' },
      h('div', { class: 'muted small' }, '总资产'),
      bigMoney(assets),
      d.accounts.some((a) => a.currency === 'USD') ? h('div', { class: 'muted small' }, `1 美元按 ¥${rate.toFixed(2)} 算`) : null),
    h('a', { class: 'receipt-link', href: '#/money' }, icon('wallet'), ' 钱都在哪：每一类钱有多少'),
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
    cell({ href: '#/accounts', title: '净资产', sub: '账户 + 别人欠你的 − 你欠别人的', meta: cents(assets + rc.toMe - rc.iOwe) }));
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
      bigMoney(b, '', cur),
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
      cell({ href: '#/reconcile', ic: 'check', color: 'var(--amber)', title: '对账', meta: needsReconcile(store.data, today()) ? '该对了' : store.data.lastReconciled ? `上次 ${md(store.data.lastReconciled)}` : '' }),
      cell({ href: '#/bills', ic: 'search', color: 'var(--sage)', title: '账单查漏记', sub: '导入微信、支付宝账单，找出没记的' })),
    h('div', { class: 'group' },
      cell({ href: '#/goals', ic: 'shield', color: 'var(--sage)', title: '专项存款', sub: '到日子一定要用的钱',
        meta: store.data.goals.filter((g) => !g.status).length ? `${store.data.goals.filter((g) => !g.status).length} 个` : '' }),
      cell({ href: '#/subs', ic: 'clock', color: 'var(--blue)', title: '订阅', meta: subReviewDue(store.data, today()) ? '该体检了' : `${money(store.data.recurring.reduce((x, r) => x + yearlyCost(store.data, r, usdRate()), 0))}/年` }),
      cell({ href: '#/tax', ic: 'book', color: 'var(--amber)', title: '个税退税', sub: '兼职被预扣的个税，每年 3～6 月退',
        meta: taxSeason(today()) && taxYear(store.data, taxSeason(today())).withheld > 0 && !taxYear(store.data, taxSeason(today())).done ? '可以办了' : '' })),
    h('div', { class: 'group' },
      cell({ href: '#/rules', ic: 'book', color: 'var(--sage)', title: '花钱方式', sub: '每月预算和定下来的规矩', meta: money(budgetTotal(store.data)) })),
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
      settled ? h('div', { class: 'big-num good-text' }, '已结清 ✓') : bigMoney(Math.max(0, cs.pending)),
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
  ['要准备的钱', ['欠的人情可以写「他为我花了多少」和「还的时候大概要准备多少」，点「估一个」让 AI 按以前来回的钱给个参考。', `${FAVOR_BIG} 以下的从日常里出，按月列在上面；${FAVOR_BIG} 以上的（比如婚礼随礼）自动变成专项存款，到日子前留好，还的时候不占当月预算。`, '「买不买」也会把这些钱算进去。']],
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
      why.textContent = r.why ? `AI：${r.why}` : '';
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
        h('p', { class: 'muted small' }, `${FAVOR_BIG} 以上的会自动算进专项存款，以下的从日常里出。`)) : '');
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
      h('span', { class: 'muted small block' }, [md(f.date), f.cost ? `${f.dir === 'owe' ? '他' : '你'}花了 ${money(f.cost)}` : null, !done && f.estimate ? `预计要准备 ${money(f.estimate)}${f.estimate >= FAVOR_BIG ? '（专项存款）' : ''} · ${f.due ? `${md(f.due)}要用` : `${md(favorDue(f, today()))}前后`}` : null, how].filter(Boolean).join(' · '))),
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
      h('div', { class: 'muted small' }, '别人一共欠你'), bigMoney(list.reduce((s, x) => s + Math.max(0, x.net), 0)),
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
      bigMoney(Math.abs(ps.net), ps.net < 0 ? 'warn-text' : ''),
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

// 要准备的人情钱：小额从日常出（按月列），大额在专项存款里
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
      h('span', { class: 'grow' }, `${md(x.due)} · 大额，专项存款`, h('span', { class: 'muted small block' }, `${x.name} · ${x.f.text}`)),
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
  return h('div', { class: 'todo-part favor-holiday' },
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

// 对账（2026-10-14 重做，用户定的）：随时对，只是让网站上的钱数和实际对齐，和卡无关。
// 所有账户的差额加起来看：在账户之间挪了没记的（一边多一边少）只改余额；加起来少了算漏记的日常花销；多了不算收入，直接进存款
function reconcileView() {
  const d = store.data;
  const p = periodFor(d, today());
  const rate = usdRate();
  const inputs = {};
  // 预算月头 7 天对的账，差额多半是上个月漏记的：记到上个预算月最后一天（开始记账前的不算）
  const prevEnd = addDays(p.start, -1);
  const adjDate = p.dayIndex <= 7 && d.openingDate && prevEnd >= d.openingDate ? prevEnd : today();
  const toCny = (a, v) => (a.currency === 'USD' ? v * rate : v);
  const siteTotal = round2(totalAssets(d, rate));
  const read = () => {
    const diffs = [];
    for (const a of d.accounts) {
      const v = inputs[a.id].value.replace(/[，,\s¥$]/g, '');
      if (v === '') continue;
      const real = Number(v);
      if (!Number.isFinite(real)) return { error: `${a.name}要填数字` };
      const diff = round2(real - balance(d, a.id));
      if (diff !== 0) diffs.push({ a, real, diff, cny: round2(toCny(a, diff)) });
    }
    return { diffs, net: round2(diffs.reduce((x, y) => x + y.cny, 0)) };
  };
  const live = h('div', { class: 'rec-live' });
  const drawLive = () => {
    const r = read();
    if (r.error) { live.replaceChildren(h('p', { class: 'small warn-text' }, r.error)); return; }
    const real = round2(siteTotal + r.net);
    live.replaceChildren(
      h('div', { class: 'rec-sum' }, h('span', {}, '实际一共'), h('b', {}, cents(real))),
      !r.diffs.length ? h('p', { class: 'muted small' }, '都对得上的话，直接点「对完了」。')
        : Math.abs(r.net) < 0.01 ? h('p', { class: 'muted small' }, '加起来正好对上：钱在账户之间挪了没记，只把各账户的余额改对。')
          : r.net < 0 ? h('p', { class: 'small soon' }, `一共少了 ${cents(-r.net)}，算成漏记的日常花销（先从心愿基金扣）。`)
            : h('p', { class: 'small good-text' }, `一共多了 ${cents(r.net)}，不算收入，直接进存款，补到最需要的地方。`));
  };
  const submit = async () => {
    const r = read();
    if (r.error) return toast(r.error, 'error');
    const rec = newId('r');
    // 少了的那部分记在差额最大（最负）的那一笔上
    const worst = r.net < 0 ? [...r.diffs].sort((x, y) => x.cny - y.cny)[0] : null;
    try {
      await save(`对账${r.diffs.length ? `：${r.diffs.map((x) => x.a.name).join('、')}有差额` : '：都对得上'}`, (data) => {
        for (const x of r.diffs) {
          data.tx.push({ id: newId('t'), type: 'adjust', date: adjDate, account: x.a.id, amount: x.diff, rec, note: `对账：校准到 ${x.real}`,
            ...(x.a.currency === 'USD' ? { cny: x.cny } : {}), ...(x === worst ? { spend: round2(-r.net) } : {}), createdAt: new Date().toISOString() });
        }
        data.lastReconciled = today();
      });
      toast(!r.diffs.length ? '对完了，都对得上 ✓' : r.net < 0 ? `对完了，少的 ${money(-r.net)} 算成漏记的花销` : r.net > 0 ? `对完了，多的 ${money(r.net)} 进了存款` : '对完了，余额都改对了');
      go('#/', true);
    } catch { /* 已提示 */ }
  };
  return h('div', { class: 'form' },
    headerSub('对账', d.lastReconciled ? `上次是 ${md(d.lastReconciled)}` : '还没对过', helpButton('对账怎么用', [
      ['是什么', ['让网站上的钱数和实际对齐。随时都能对，超过 ' + RECONCILE_DAYS + ' 天没对，首页会提一句。']],
      ['怎么对', ['打开手机银行、微信、校园卡 App，看一眼实际余额。', '对得上的空着不填；对不上的填实际余额。美元账户填美元。', '上面会实时算出实际一共多少、和网站差多少。']],
      ['差额怎么算', ['和钱在哪张卡上没关系，看所有账户加起来：', '一边多一边少、加起来对上了，是钱在账户之间挪了没记，只改余额。', '加起来少了，算成漏记的日常花销（照常先扣心愿基金）。', '加起来多了，不算收入，直接进存款，补到最需要的地方。', '预算月头 7 天对的账，差额记到上个预算月的最后一天。']],
    ])),
    h('div', { class: 'card rec-top-card' },
      h('div', { class: 'rec-sum' }, h('span', {}, '网站上一共'), h('b', {}, cents(siteTotal))),
      live),
    h('div', { class: 'card' },
      d.accounts.map((a) => {
        const cur = a.currency === 'USD' ? '$' : '¥';
        inputs[a.id] = h('input', { inputmode: 'decimal', placeholder: '对得上就不填', 'aria-label': `${a.name}实际余额`, oninput: drawLive });
        return h('label', {}, h('span', { class: 'rec-top' }, h('span', {}, a.name), h('span', { class: 'muted' }, `网站上 ${exact(balance(d, a.id), cur)}`)), inputs[a.id]);
      })),
    h('a', { class: 'receipt-link', href: '#/bills' }, icon('search'), ' 对不上？导入微信、支付宝账单找出漏记的'),
    h('div', { class: 'actions sticky' }, h('button', { onclick: submit }, '对完了')),
    (drawLive(), null));
}

// ---------- 总结 ----------

// 周总结最上面：这周花了多少（大字）、和计划比的进度条、上周多少
function weekHead(ws) {
  if (!ws.st.total) return h('div', { class: 'card summary-head' }, h('p', {}, ws.headline));
  const { st, plan, diff } = ws;
  const used = plan > 0 ? st.living / plan : 0;
  const over = diff > 0;
  const tag = ws.pace === 'good' ? '节奏正常' : ws.ongoing ? '花得有点快' : '下周收一收';
  const left = ws.ongoing ? (over ? `超了 ${money(diff)}` : `还能花 ${money(-diff)}`)
    : Math.abs(diff) < plan * 0.05 ? '和计划差不多' : over ? `比计划多 ${money(diff)}` : `比计划少 ${money(-diff)}`;
  const prevDiff = st.living - ws.prev.living;
  return h('div', { class: 'card summary-head week-head', 'aria-label': ws.headline },
    h('div', { class: 'wh-top' },
      h('div', {},
        h('div', { class: 'muted small' }, '这周生活花了'),
        bigMoney(st.living)),
      h('span', { class: `wh-tag ${ws.pace}` }, tag)),
    st.byGroup.none >= 1 ? h('div', { class: 'muted small from-saved' }, noneLine(noneParts(store.data, st.tx))) : null,
    plan > 0 ? h('div', { class: 'time-bar' },
      h('div', { class: 'time-track', 'aria-label': `用了这周计划的 ${Math.round(used * 100)}%` },
        h('span', { class: `time-fill wh-fill${over ? ' over' : ''}`, style: `width:${Math.min(100, used * 100).toFixed(1)}%` }),
        ws.ongoing ? h('span', { class: 'spend-mark', style: `left:${Math.min(100, (ws.soFar / plan) * 100).toFixed(1)}%`, title: '按日子到今天该花到这' }) : null),
      h('div', { class: 'time-legend small' },
        h('span', { class: over ? 'wh-over' : '' }, left),
        h('span', { class: 'muted' }, `计划 ${money(plan)}`))) : null,
    ws.prev.living ? h('div', { class: 'hero-foot muted small' },
      `上周 ${money(ws.prev.living)}`, Math.abs(prevDiff) >= 1 ? ` · 这周${prevDiff > 0 ? '多' : '少'}花 ${money(Math.abs(prevDiff))}` : ' · 和上周一样') : null);
}

const SUMMARY_HELP = [
  ['周总结', ['一周从周一到周日。最上面是这周生活花了多少（心愿基金、专项这些不占预算的另写一行，不算在里面）：进度条是用了这周计划的多少，这周还没过完时，竖线是按日子到今天该花到哪，条没过竖线、或者只多出一成以内，就是节奏正常。', '柱子是每天的生活花销（吃饭 + 日常 + 自由钱），虚线是每天的预算：柱子在虚线下面就是没超。', '环形图是这周的钱花在哪几块，下面的箭头是和上周比。', '午饭和晚饭：格子一行午饭、一行晚饭，数字是那顿花了多少，颜色越深越贵，带点的是外面吃的（校园卡以外的卡付的），空着的是别人请的。下面的线是你以前每顿的范围（粗的一段是中间一半，竖线是中间那个数），点是这周的每一顿，琥珀色的是比以前九成都贵的。', '最下面几行：下周两顿大约花多少、这个预算月吃饭会不会超（按你记的估的，「怎么算的」里有方法）；记满 8 周后，变贵了或者换成学校里能省不少时才会多一行。早餐是囤着吃的，按最近四周摊到每天。']],
  ['月度报表', ['「月」是一份财务报表，按预算月算（和发钱对齐）。这个月还没过完时，算到今天。',
    '最上面四个数：收入、支出、存下、净资产（所有账户 + 别人欠你的 − 你欠别人的）。',
    '储蓄率：存下的钱占收入的几成，「每 100 块收入存下多少」。条上的竖线：「按预算花」是每一块都正好花到预算时能到的，20% 是常见的建议。到了「按预算花」那条是绿色。是负数时，条从右边的 0 往左长：只是用了存好的钱（专项、心愿基金）就安安静静的；去掉这些还是负的，就是真的花超了，这块会暗下来。',
    '收支：第一根柱子是收入，每一块花销往下扣一段，最后一根是剩下的。不占预算的分两块：「用存好的」是专项、心愿基金、大额人情这些早就留好的钱；「预算外」是手续费、出差自付这些不在哪一块预算里的。图下面点一行，看钱去了哪。',
    '家底：月初和现在的钱按用途分成几段（和「钱都在哪」一样），下面是最近几个月的净资产。',
    '预算：浅色是预算，深色是实际花的，竖线是预算到头的地方。花钱曲线：实线是累计花了多少，虚线是按计划到这天该花多少，实线在虚线下面就是花得比计划慢。',
    '花在哪：圆环点一段看这一块花在哪几类。日历上颜色越深，那天生活花得越多；点一天，下面写那天一共花了多少（不占预算的也算）。',
    '趋势：最近几个月的收入、支出柱子，和储蓄率的线（右边的刻度）。',
    '最下面「存成 PDF」：PDF 里有完整的表格和明细。会打开打印界面，iPhone 上在打印预览里点右上角的分享按钮，选 Save to Files。「导出 Excel」：每一部分一张表，还有这个月的每一笔。「导出给 ChatGPT」：把完整的报表复制好，拿去问。']],
  ['年度报表', ['「年」也是一份财务报表，按自然年（1 月 1 日到 12 月 31 日），每个月也按自然月算，所以和月度报表（预算月）的数字不完全一样。',
    '储蓄率：这一年存下的占收入的几成，条上的「计划」算上了没有收入的月份。负数的样子和月度一样。',
    '每月收支：12 个月的收入、支出柱子，和储蓄率的线。存钱计划：实线是这一年累计存下的，虚线是按计划累计该存的，实线在上面就是存得比计划好。',
    '家底：年初和现在的钱按用途分，和每个月月底的净资产。预算：一行一块、一列一个月，颜色越深用得越多，红色是超了。',
    '花在哪：全年的圆环，下面「用存好的」「预算外」点开看去处，和每个月按块分的柱子。日历：一格一天，颜色越深那天花得越多，描了一圈的是今天。',
    '这一年过完后，1 月打开去年的年度报表，AI 会写一段年度点评。最下面可以存成 PDF、导出 Excel（每个月一张明细）、导出给 ChatGPT。']],
  ['往后', ['「往后」是往前看：往后 12 个预算月，每个月底存款大概有多少、有多大可能碰到底线。存款和「钱都在哪」的一样，不算心愿基金和这个月还没花的生活费。',
    '照你以前每天花多少、收入到没到账，估出几千种可能的未来，数一数有多少种碰到底线、专项按时留够。想看细节，在页面最下面「怎么算的」。',
    '图：实线是中位数（一半的可能比它高），深的阴影是 50% 的可能落在里面，浅的是 80%。虚线是底线：家庭存款 + 应急底线 + 医疗备用金。',
    '学费、住宿费、年费、人情这些专项到了日子就当花掉；暑假两个月没有收入。兼职、补助这种不一定有的钱不算。',
    '首页「这个月还能花」下面一行也是这样估的：月底大约花多少、超预算的可能。同一天打开几次结果一样，记了新账才会变。',
    '建议只在有用时出现：专项按时留够的可能不到 90%、碰到底线的可能超过 5% 时，算出每月少多少刚好够；记满 45 天以后，哪一块预算明显定宽了或定紧了也会说。首页「要做的事」里会提一句，点「做完了」这个预算月就不再提（换了别的建议会再出现）。']],
  ['翻看', ['左右箭头看以前的。']],
  ['钱都在哪', ['右上角点「钱都在哪」，整页翻过来，看每一类钱有多少、存到哪了；再点「总结」翻回来。']],
];
const WEEKDAYS = '一二三四五六日';

// 总结页可以整页翻过来看「钱都在哪」：默认是总结，离开总结页再回来又是总结（summaryFlipped 在最上面）
function flipButton() {
  return h('button', { type: 'button', class: 'flip-btn', 'aria-label': summaryFlipped ? '翻回总结' : '翻到钱都在哪',
    onclick: () => {
      summaryFlipped = !summaryFlipped;
      render();
      scrollTo(0, 0);
      view.classList.remove('flip-in'); void view.offsetWidth; view.classList.add('flip-in'); // 整页翻过来
      view.addEventListener('animationend', () => view.classList.remove('flip-in'), { once: true });
    } },
  icon('swap'), summaryFlipped ? '总结' : '钱都在哪');
}

// 总结页刊头的字：日期范围（同一个月的后半截不写月）+ 一句在哪（这周还剩几天 / 上周 / 3 周前）
const mastRange = (a, b) => `${md(a)} – ${a.slice(0, 7) === b.slice(0, 7) ? `${Number(b.slice(8))}日` : md(b)}`;
const mastLeft = (end, what) => { const n = daysBetween(today(), end); return n ? `${what} · 还剩 ${n} 天` : `${what} · 最后一天`; };
// 第几周：ISO 周（周一开始，有 1 月 4 日的那周是第 1 周）
function weekNo(day) {
  const thu = addDays(day, 3 - (parseYmd(day).getDay() + 6) % 7);
  return Math.floor(daysBetween(`${thu.slice(0, 4)}-01-01`, thu) / 7) + 1;
}
function weekMast(ws) {
  const ago = daysBetween(ws.start, weekOf(today()).start) / 7;
  return { pre: '第', big: String(weekNo(ws.start)), unit: '周', range: mastRange(ws.start, ws.end),
    sub: ago ? (ago === 1 ? '上周' : `${ago} 周前`) : mastLeft(ws.end, '这周') };
}
function monthMast(d, p) {
  const now = periodFor(d, today());
  const ago = (Number(now.start.slice(0, 4)) * 12 + now.startMonth) - (Number(p.start.slice(0, 4)) * 12 + p.startMonth);
  const where = ago ? (ago === 1 ? '上个预算月' : `${ago} 个月前`) : mastLeft(p.end, '这个预算月');
  return { big: String(p.startMonth), unit: '月', range: mastRange(p.start, p.end), sub: p.summer ? `${where} · 暑假` : where };
}
function yearMast(year) {
  const ago = Number(today().slice(0, 4)) - year;
  return { big: String(year), range: '1月1日 – 12月31日', sub: ago ? (ago === 1 ? '去年' : `${ago} 年前`) : mastLeft(`${year}-12-31`, '今年') };
}

// 午饭和晚饭（2026-10-26 用户要的，周总结「花在哪了」和「这周最大的几笔」之间）：计算在 meals.js。
// 七天两行的格子（颜色越深越贵、带点的是外面吃的、空着的是别人请的）、三个数、每顿花多少的分布、学校里 / 外面，
// 最下面几行：下周两顿大约多少、这个预算月吃饭会不会超、（记满 8 周）变贵了没有 / 换成学校里能省多少、早餐
const mmd = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
function mealCard(d, ws) {
  const now = today();
  const mw = mealWeek(d, ws, now);
  if (!mw.kinds.some((k) => k.hist.length)) return null;
  const all = mw.kinds.flatMap((k) => k.hist).sort((a, b) => a - b);
  const q = (p) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v) => (v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  const grid = h('div', { class: 'meal-grid', role: 'img', 'aria-label': `这周的午饭和晚饭：${mw.grid.map((k) => `${k.name}${k.cells.filter((c) => c.v != null).length} 顿`).join('，')}` },
    h('span', {}), [...WEEKDAYS].map((w) => h('span', { class: 'meal-wd' }, w)),
    mw.grid.map((k) => [h('span', { class: 'meal-kind small' }, k.name.slice(0, 1)),
      k.cells.map((c) => h('span', { class: `meal-cell${c.future ? ' off' : c.v == null ? ' none' : ` lv${level(c.v)}${c.school ? '' : ' out'}`}` },
        c.v != null ? String(Math.round(c.v)) : ''))]));
  const kpi = (label, v, sub) => h('div', { class: 'meal-kpi' }, h('div', { class: 'muted small' }, label), h('b', {}, v), sub ? h('div', { class: 'muted small' }, sub) : null);
  const kpis = h('div', { class: 'meal-kpis' },
    mw.kinds.map((k) => kpi(`${k.name}每顿`, k.avg != null ? money(k.avg) : '—', k.usual != null ? `平时 ${money(k.usual)}` : null)),
    kpi('两顿一共', money(mw.total), mw.share != null ? `占吃饭 ${Math.round(mw.share * 100)}%` : null));
  const [sc, out] = mw.place;
  const n = sc.n + out.n;
  const place = n ? h('div', { class: 'meal-place' },
    h('div', { class: 'meal-place-bar' }, sc.n ? h('span', { class: 'school', style: `width:${(sc.n / n) * 100}%` }) : null, out.n ? h('span', { class: 'out', style: `width:${(out.n / n) * 100}%` }) : null),
    h('div', { class: 'meal-place-row small' },
      h('span', {}, h('i', { class: 'school' }), `学校里 ${sc.n} 顿${sc.n ? ` · 每顿 ${money(sc.avg)}` : ''}`),
      h('span', {}, h('i', { class: 'out' }), `外面 ${out.n} 顿${out.n ? ` · 每顿 ${money(out.avg)}` : ''}`))) : null;
  const b = mw.breakfast;
  const nx = b.next;
  const buy = !nx ? null : now > nx.to ? '该买了' : now >= nx.from ? '这几天又该买了' : `大约 ${mmd(nx.from)}${nx.to === nx.from ? '' : nx.to.slice(5, 7) === nx.from.slice(5, 7) ? `–${Number(nx.to.slice(8))}日` : `–${mmd(nx.to)}`}该买了`;
  const bfLine = [b.perDay != null ? `早餐大约每天 ${money(b.perDay)}` : null, b.school ? `学校里吃了 ${b.school} 顿` : null, buy].filter(Boolean);
  const lines = [
    mw.next ? [`下周两顿大约 ${money(mw.next.mid)}`, `八成在 ${money(mw.next.lo)} – ${money(mw.next.hi)}`] : null,
    mw.month ? [`这个预算月吃饭大约 ${money(mw.month.mid)}`, `超预算的可能 ${mw.month.pOver < 0.01 ? '不到 1%' : `${Math.round(mw.month.pOver * 100)}%`}`, mw.month.pOver >= 0.3] : null,
    ...(mw.trends || []).map((t) => [`${t.name}每顿大约每个月${t.perMonth > 0 ? '贵' : '便宜'}了 ${Math.round(Math.abs(t.perMonth) * 100)}%`]),
    mw.swap ? [`每周一顿${mw.swap.name}换成学校里`, `一个月约省 ${money(mw.swap.month)}`] : null,
    bfLine.length ? [bfLine.join(' · ')] : null,
  ].filter(Boolean);
  return h('div', { class: 'card meal-card' }, h('h3', {}, '午饭和晚饭'),
    grid,
    h('p', { class: 'muted small meal-legend' }, '颜色越深越贵 · 带点的是外面吃的'),
    kpis,
    mealStrip(mw.kinds.map((k) => ({ name: k.name, hist: k.hist, week: k.week })), { title: '每顿花多少：以前的范围和这周的每一顿' }),
    place,
    lines.length ? h('div', { class: 'meal-lines' }, lines.map(([a, sub, warn]) => h('div', { class: `meal-line small${warn ? ' warn' : ''}` }, h('span', {}, a), sub ? h('span', { class: 'muted' }, sub) : null))) : null,
    mw.models ? mealHow(mw) : null);
}

function mealHow(mw) {
  const f = (text) => h('p', { class: 'how-math' }, text);
  const p = (text) => h('p', { class: 'small' }, text);
  const k = mw.models.kinds;
  const fmt = (x) => Math.round(x * 100) / 100;
  return h('details', { class: 'meal-how' }, h('summary', { class: 'small' }, '怎么算的'),
    h('h4', {}, '一、每顿多少钱'),
    p('一顿饭的价格取对数后当成正态分布，午饭、晚饭各一套。没记账时，先假设一顿是吃饭预算每天的三成，相当于先有两顿这样的数据。'),
    f('log x ~ N(μ, σ²)，先验 μ₀ = log m₀ − s₀²/2，κ₀ = 2，α₀ = 2，β₀ = α₀·s₀²，s₀ = 0.5'),
    f('后验：κₙ = κ₀ + n，μₙ = (κ₀μ₀ + n·x̄) / κₙ，αₙ = α₀ + n/2，βₙ = β₀ + S/2 + κ₀n(x̄ − μ₀)² / (2κₙ)'),
    mw.models && p(`你的：m₀ = ¥${k.lunch.m0}；午饭记了 ${k.lunch.post.n} 顿，e^μₙ = ¥${fmt(Math.exp(k.lunch.post.mu))}；晚饭记了 ${k.dinner.post.n} 顿，e^μₙ = ¥${fmt(Math.exp(k.dinner.post.mu))}。`),
    h('h4', {}, '二、这顿是不是自己付的'),
    p('没记的那顿当作别人请的。从开始记账到昨天，每一顿自己付的可能：'),
    f(`p ~ Beta(1 + 记了的, 1 + 没记的)：午饭 Beta(${1 + k.lunch.paid}, ${1 + k.lunch.slots - k.lunch.paid})，晚饭 Beta(${1 + k.dinner.paid}, ${1 + k.dinner.slots - k.dinner.paid})`),
    h('h4', {}, '三、下周、这个预算月'),
    p(`蒙特卡洛 ${MEAL_PATHS} 次：每次抽一组 σ²、μ、p，再一顿一顿抽价格；早餐、零食、饮料这些按天用贝叶斯自助法，往后几天的和用正态近似。范围是 10% 到 90%。`),
    f('σ² ~ InvGamma(αₙ, βₙ)，μ ~ N(μₙ, σ²/κₙ)，x = e^(μ + σz)'),
    h('h4', {}, '四、变贵了没有（记满 8 周）'),
    p(`记满 ${TREND_DAYS} 天后，用每顿价格的对数对日子做回归，看斜率往上的可能。只有可能 ≥ 90%、每个月变化 ≥ 2% 时才说。换成学校里能省多少：最近 8 周外面和学校里每顿的差 × 每个月的周数，省得不多时不说。`),
    f('log x = a + b·t，b ~ N(b̂, se²)，P(变贵) = Φ(b̂ / se)，每个月 = e^(30.44·b) − 1'),
    h('h4', {}, '五、早餐'),
    p('校园卡付的按顿数；别的卡付的是囤着吃的，最近四周买早餐的钱 ÷ 天数 = 每天多少。下次大约哪天该买：上次买的日子 + 以前隔几天买一次的 25% 到 75%。'));
}

function summaryView(q) {
  if (summaryFlipped) return moneyView(true);
  const d = store.data;
  const mode = ['month', 'year', 'ahead'].includes(q.mode) ? q.mode : 'week';
  const day = q.day || today();
  const link = (m, dd) => `#/summary?mode=${m}&day=${dd}`;
  const seg = h('div', { class: 'segmented' }, [['week', '周'], ['month', '月'], ['year', '年'], ['ahead', '往后']].map(([k, t]) =>
    h('a', { class: `seg${mode === k ? ' on' : ''}`, href: link(k, today()) }, t)));
  // 刊头（2026-10-25 用户选的）：左边宋体大字（第 43 周 / 10 月 / 2026），右边日期范围和一句还剩几天 / 几周前
  const navRow = (m, prev, next) => h('div', { class: 'period-nav' },
    h('a', { class: 'icon-btn', href: link(mode, prev), 'aria-label': '上一个' }, '‹'),
    h('div', { class: 'mast' },
      h('div', { class: 'mast-big' }, m.pre ? h('small', {}, m.pre) : null, h('b', {}, m.big), m.unit ? h('small', {}, m.unit) : null),
      h('div', { class: 'mast-side' }, h('div', { class: 'mast-range' }, m.range), h('div', { class: 'mast-sub' }, m.sub))),
    next <= today() ? h('a', { class: 'icon-btn', href: link(mode, next), 'aria-label': '下一个' }, '›') : h('span', { class: 'icon-btn ghost' }));
  const head = header('总结', flipButton(), helpButton('总结怎么看', SUMMARY_HELP));

  if (mode === 'week') {
    const ws = weekSummary(d, day);
    const groups = GROUPS.filter((g) => ws.st.byGroup[g.id] || ws.prev.byGroup[g.id]);
    const arrow = (now, before) => {
      const diff = now - before;
      if (Math.abs(diff) < 1) return h('span', { class: 'muted small' }, '和上周一样');
      return h('span', { class: 'muted small' }, `比上周${diff > 0 ? '多' : '少'} ${money(Math.abs(diff))}`);
    };
    return h('div', {}, head, seg,
      navRow(weekMast(ws), addDays(ws.start, -1), addDays(ws.end, 1)),
      weekHead(ws),
      h('div', { class: 'card' }, h('h3', {}, '每天的生活花销'),
        barChart(ws.days.map((x, i) => ({ label: `周${WEEKDAYS[i]}`, v: x.v, color: x.v > ws.perDay ? 'var(--amber)' : 'var(--accent)' })),
          { line: ws.perDay, lineLabel: `预算 ${money(ws.perDay)}`, title: '每天的生活花销' })),
      h('div', { class: 'card' }, h('h3', {}, '花在哪了'),
        ws.st.total ? spendDonut(ws.st, groups, { sub: '这周花销', title: '花在哪了', extra: (g) => arrow(ws.st.byGroup[g.id], ws.prev.byGroup[g.id]) })
          : h('p', { class: 'muted small' }, '这周还没有花销。')),
      mealCard(d, ws),
      ws.top.length ? h('div', { class: 'card tx-list' }, h('h3', {}, '这周最大的几笔'), ws.top.map((t) => txRow(t))) : null);
  }

  if (mode === 'year') return yearReportView(d, Number(day.slice(0, 4)), head, seg, navRow);
  if (mode === 'ahead') return aheadView(d, head, seg);

  return monthReportView(d, day, head, seg, navRow);
}

// ---------- 往后一年（2026-10-25，总结页的「往后」） ----------
// 计算在 forecast.js（贝叶斯 + Chronos-2 + 蒙特卡洛）和 ahead.js（按计划、到日子的专项）。用户选的：直接给概率、公式写出来、建议放第二批。
// 页面：一句结论 + 四个数、每个月底存款的范围（阴影）和底线、要用大钱的时候、专项按时留够的可能、怎么算的

// Chronos-2 的结果：数据仓库 config/forecast.json（GitHub Actions 每天写）、forecast-log.json（每天的预测，拿来打分）。3 小时读一次
let fcFiles = { fc: null, log: null, fetched: 0, loading: false };
function ensureForecastFiles() {
  if (!store?.data || fcFiles.loading || Date.now() - fcFiles.fetched < 3 * 3600e3) return;
  fcFiles.loading = true;
  Promise.all([store.readJson('config/forecast.json'), store.readJson('config/forecast-log.json')])
    .then(([fc, log]) => {
      fcFiles = { fc, log, fetched: Date.now(), loading: false };
      // 读到了再画一次：只在用得到的页面（别把正在填的表单冲掉）
      if (fc && /^#\/(summary|goals)?(\?|$)/.test(window.location.hash || '#/')) render();
    })
    .catch(() => { fcFiles = { ...fcFiles, fetched: Date.now(), loading: false }; });
}
// 算一次要几十毫秒：同一天、同一份账、同一份 Chronos 结果只算一次
let fcMemo = { key: '', v: null };
function forecasts() {
  ensureForecastFiles();
  const d = store.data;
  const t = today();
  const key = `${t}|${fcFiles.fc?.at || ''}|${JSON.stringify(d)}`;
  if (fcMemo.key !== key) {
    const score = scoreModels(d, t, fcFiles.log?.living);
    fcMemo = { key, v: { score, fc: fcFiles.fc, month: monthForecast(d, t, { fc: fcFiles.fc, score }), ahead: null } };
  }
  return fcMemo.v;
}
const aheadForecast = () => { const v = forecasts(); return (v.ahead ||= simulateAhead(store.data, today(), { fc: v.fc, score: v.score, rate: usdRate() })); };
// 建议（第二批）：要跑几十次模拟，放在后台线程（js/advice-worker.js）算，页面不卡；算好了再画一次
// v.advice：undefined = 还没算，算好是 { items, unc }。正在打字、开着弹出框时不重画（下次画页面时就会出现）
let adviceWorker = null;
function adviceLater() {
  const v = forecasts();
  if (v.advice) return v.advice;
  if (!v.adviceAsked) {
    v.adviceAsked = true;
    const key = fcMemo.key;
    const done = (res) => {
      if (res.key !== fcMemo.key) return; // 账又变了，作废（新的那次会再算）
      fcMemo.v.advice = { items: res.items || [], unc: res.unc || null };
      const busy = document.querySelector('.sheet-overlay') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      const here = /^#\/?$/.test(window.location.hash || '#/') ? fcMemo.v.advice.items.length : /mode=ahead/.test(window.location.hash);
      if (here && !busy) render();
    };
    const msg = { key, data: store.data, today: today(), opts: { fc: v.fc, score: v.score, rate: usdRate() }, unc: true };
    try {
      adviceWorker ||= new Worker(new URL('./advice-worker.js', import.meta.url), { type: 'module' });
      adviceWorker.onmessage = (e) => done(e.data);
      adviceWorker.postMessage(msg);
    } catch {
      setTimeout(() => done({ key, items: adviceItems(msg.data, msg.today, aheadForecast(), msg.opts), unc: uncertaintySources(msg.data, msg.today, msg.opts) }), 300);
    }
  }
  return null;
}
// 首页「要做的事」里一行：有建议、这个预算月没点过「知道了」（换了建议会再出现）
function adviceTodo() {
  const items = adviceLater()?.items || [];
  if (!items.length) return null;
  const p = periodFor(store.data, today());
  const sig = `${p.start}|${items.map((x) => x.key).join(',')}`;
  if (store.data.todoDone?.forecast === sig) return null;
  const row = todoItem(items.some((x) => x.tone === 'warn') ? 'warn' : 'calm', 'chart',
    h('a', { class: 'todo-tap', href: '#/summary?mode=ahead' }, h('span', { class: 'todo-body' },
      h('span', { class: 'todo-title' }, '预测有建议'), h('span', { class: 'todo-text' }, items.length > 1 ? `${items[0].short}，还有 ${items.length - 1} 条` : items[0].short))));
  row.append(doneButton('预测的建议', (data) => { data.todoDone = { ...(data.todoDone || {}), forecast: sig }; }));
  return row;
}
// 概率写法：不到 1%、超过 99%，其余取整
const pct = (p) => (p < 0.005 ? '不到 1%' : p > 0.995 ? '超过 99%' : `${Math.round(p * 100)}%`);

// 首页「这个月还能花」下面一行：月底大约花多少、超预算的可能
function forecastLine() {
  const m = forecasts().month;
  return h('a', { class: 'forecast-line small', href: '#/summary?mode=ahead' },
    h('span', { class: 'grow' }, `月底大约花 ${money(m.median)}（80% 在 ${money(m.lo)}～${money(m.hi)}）`),
    h('b', { class: m.pOver >= 0.3 ? 'soon' : '' }, `超预算的可能 ${pct(m.pOver)}`));
}

// 「2027 年 8 月 14 日」：今年的不写年
const aheadWhen = (day) => `${day.slice(0, 4) === today().slice(0, 4) ? '' : `${day.slice(0, 4)} 年`}${md(day)}`;
const aheadMonth = (day) => `${day.slice(0, 4) === today().slice(0, 4) ? '' : `${day.slice(0, 4)} 年 `}${Number(day.slice(5, 7))} 月`;
// 专项（专项页、往后一年共用）：按时留够的可能 + 大约哪个月；{ text, short }
function goalLine(g) {
  if (!g) return null;
  const when = g.p50 ? `大约 ${aheadMonth(g.p50)}留够${g.p10 && g.p90 && g.p10 !== g.p90 ? `（80%：${aheadMonth(g.p10)}～${aheadMonth(g.p90)}）` : ''}` : '10 年内大概留不够';
  if (g.pOnTime == null) return { text: when, short: !g.p50 };
  return { text: `按时留够的可能 ${pct(g.pOnTime)} · ${when}`, short: g.pOnTime < 0.9 };
}

function aheadView(d, head, seg) {
  const t = today();
  const v = forecasts();
  const s = aheadForecast();
  const plan = aheadPlan(d, t, { rate: usdRate() }); // 要用大钱的时候（到日子的专项）
  const fan = s.fan;
  const first = fan[0].p;
  const lastEnd = fan.at(-1).p.end;
  const mast = h('div', { class: 'period-nav' }, h('span', { class: 'icon-btn ghost' }),
    h('div', { class: 'mast' },
      h('div', { class: 'mast-big' }, h('small', {}, '往后'), h('b', {}, String(fan.length)), h('small', {}, '个月')),
      h('div', { class: 'mast-side' }, h('div', { class: 'mast-range' }, `${first.start.slice(0, 7).replace('-', '.')} – ${lastEnd.slice(0, 7).replace('-', '.')}`),
        h('div', { class: 'mast-sub' }, '照你记的账估的'))),
    h('span', { class: 'icon-btn ghost' }));

  const kpi = (label, val, cls = '') => h('div', { class: `rep-kpi ${cls}` }, h('div', { class: 'muted small' }, label), h('b', {}, val));
  const end = fan.at(-1);
  const worst = fan.reduce((a, x) => (x.pBelow > a.pBelow ? x : a), fan[0]);
  const risky = s.pBelow >= 0.05;
  const say = risky
    ? [h('b', {}, `往后一年碰到底线的可能 ${pct(s.pBelow)}`), `，最可能在 ${aheadMonth(worst.p.end)}前后。`]
    : [h('b', {}, `往后一年碰到底线的可能 ${pct(s.pBelow)}。`), `一年后存款大约 ${jarMoney(end.q[2])}，80% 在 ${jarMoney(end.q[0])}～${jarMoney(end.q[4])}。`];
  const top = h('div', { class: 'card rep-head' },
    h('p', { class: `ahead-say${risky ? ' warn' : ''}` }, say),
    h('div', { class: 'rep-kpis' },
      kpi('现在存款', money(s.now)),
      kpi(`${aheadMonth(lastEnd)} · 中位数`, money(end.q[2])),
      kpi('80% 的范围', `${jarMoney(end.q[0])}～${end.q[4] < 0 ? jarMoney(end.q[4]) : jarMoney(end.q[4]).replace('¥', '')}`, 'small-num'),
      kpi('碰到底线的可能', pct(s.pBelow), risky ? 'warn' : '')),
    s.days < 30 ? h('p', { class: 'muted small' }, `才记了 ${s.days} 天，主要还是按预算和收入计划估的；记得越久，范围越准。`) : null);

  const label = (p) => `${Number(p.end.slice(5, 7))}月`;
  const mid = Math.floor((fan.length - 1) / 2);
  const chart = repSection('每个月底的存款',
    lineChart([{ values: fan.map((x) => x.q[2]), color: 'var(--accent)' }, { values: fan.map((x) => x.floor), color: 'var(--amber)', dashed: true }],
      { tight: true, height: 160, title: '往后每个月底存款的范围和底线', xLabels: [[0, label(fan[0].p)], [mid, label(fan[mid].p)], [fan.length - 1, label(fan.at(-1).p)]],
        bands: [{ lo: fan.map((x) => x.q[0]), hi: fan.map((x) => x.q[4]), color: 'var(--accent)', opacity: 0.12 }, { lo: fan.map((x) => x.q[1]), hi: fan.map((x) => x.q[3]), color: 'var(--accent)', opacity: 0.2 }] }),
    repLegend([['中位数', 'var(--accent)'], ['50% / 80% 的可能落在阴影里', 'color-mix(in srgb, var(--accent) 30%, transparent)'], ['底线', 'var(--amber)']]),
    h('p', { class: 'muted small' }, '阴影的上边差不多就是按计划：生活费省下的进心愿基金，不进存款，所以存款最多到那里；往下是收入没到、花超了的情况。'));

  // 要用大钱的时候：到日子的专项，和暑假（几个月没有收入）
  const summer = fan.filter((x) => x.summer);
  const rows = [
    ...plan.events.map((e) => ({ date: e.date, name: e.name, sub: '从专项出', amt: e.amount })),
    ...(summer.length ? [{ date: summer[0].p.start, name: '暑假没有收入', sub: `${summer.length} 个月，每月花预算`, amt: s.budget * summer.length }] : []),
  ].map((r) => ({ ...r, sub: r.date.slice(0, 4) === t.slice(0, 4) ? r.sub : `${r.date.slice(0, 4)} 年 · ${r.sub}` }))
    .sort((x, y) => x.date.localeCompare(y.date));
  const bigDays = repSection('要用大钱的时候',
    rows.length ? rows.map((r) => {
      const [, m, dd] = r.date.split('-');
      return h('div', { class: 'charge-row' },
        h('div', { class: 'charge-date' }, h('b', {}, String(Number(dd))), h('span', {}, `${Number(m)}月`)),
        h('div', { class: 'grow' }, h('div', { class: 'charge-name' }, r.name), h('div', { class: 'muted small' }, r.sub)),
        h('div', { class: 'charge-amt' }, `−${money(r.amt)}`));
    }) : h('p', { class: 'muted small' }, '这一年没有到日子的专项。'));

  const goalCard = s.goals.length ? repSection('专项按时留够的可能',
    s.goals.map((g) => {
      const line = goalLine(g);
      return h('a', { class: 'ahead-goal', href: '#/goals' },
        h('span', { class: 'grow' }, h('span', { class: 'charge-name' }, g.name), h('span', { class: `small block ${line.short ? 'soon' : 'muted'}` }, line.text)),
        h('span', { class: 'muted small' }, money(g.target)));
    })) : null;

  // 建议（只在有用时）+ 一年后的不确定从哪来
  const ready = adviceLater();
  const advice = ready?.items || [];
  const unc = ready && end.q[4] - end.q[0] >= 1000 ? ready.unc : null;
  const uncLine = unc && Math.max(unc.income, unc.spend) >= 0.5
    ? `一年后存款为什么有这么宽的范围：大约 ${pct(unc.income)} 来自收入到不到账${unc.irregular.length ? `（主要是不定时的${unc.irregular.map((x) => `「${x}」`).join('、')}）` : ''}，${pct(unc.spend)} 来自每月花多少。` : null;
  const adviceCard = advice.length || uncLine ? repSection(advice.length ? '建议' : '分析',
    advice.map((x) => h(x.href ? 'a' : 'div', { class: `advice-row tone-${x.tone}`, href: x.href }, h('span', { class: 'advice-dot' }), h('span', { class: 'grow' }, x.text))),
    uncLine ? h('p', { class: 'muted small advice-note' }, uncLine) : null) : null;
  const waiting = ready ? null : h('p', { class: 'muted small advice-wait' }, '正在算有没有建议……');
  return h('div', { class: 'report ahead' }, head, seg, mast, top, adviceCard || waiting, chart, bigDays, goalCard, howCard(v, s));
}

// 怎么算的（用户选的：写出方法名和公式，带上他自己的参数；只说明，不教）
function howCard(v, s) {
  const sc = v.score;
  const m = v.month;
  const fc = v.fc;
  const block = (title, ...lines) => h('div', { class: 'how-block' }, h('h4', {}, title), lines.filter(Boolean).map((l) => (typeof l === 'string' ? h('p', { class: 'small' }, l) : l)));
  const f = (text) => h('p', { class: 'how-math' }, text);
  const scoreText = !fc ? 'Chronos-2 还没有结果，现在只用贝叶斯模型。'
    : !sc.days ? '还没有可以打分的天：从明天起，每天拿实际花了多少和前一天的预测比。现在两个模型各占一半。'
      : `最近 ${sc.days} 天：Chronos-2 平均损失 ${sc.chronos.loss}，80% 区间命中 ${pct(sc.chronos.cover)}；贝叶斯平均损失 ${sc.bayes.loss}，命中 ${pct(sc.bayes.cover)}。损失越小越准，命中越接近 80% 越老实。`;
  return h('details', { class: 'card how' }, h('summary', {}, '怎么算的'),
    block('一、每天的生活花销 · 贝叶斯（Dirichlet 过程）',
      '先验：没记账时，假设每天花销服从对数正态分布，均值是生活预算 ÷ 天数，相当于先有 α 天这样的数据。',
      f(`G₀ = LogNormal，均值 μ₀ = ¥${s.prior.mean}，变异系数 ${s.prior.cv}；α = ${s.prior.alpha}`),
      `看到 ${m.days} 天的实际花销 x₁…xₙ 以后，后验是：`,
      f('P | x ~ DP(α + n, (α·G₀ + Σ δₓᵢ) / (α + n))'),
      f('抽 P：(W₀, W₁…Wₙ) ~ Dirichlet(α, 1, …, 1)，P = W₀·G₀ + Σ Wᵢ·δₓᵢ'),
      m.days ? f(`每天平均的后验：E[μ | x] = (α·μ₀ + Σxᵢ) / (α + n) = ¥${m.postMean}（你实际平均 ¥${m.xsMean}）`) : null,
      '偶尔一天花得多（买大件）这种长尾会照原样保留。记的天越多，先验的分量越小。'),
    block('二、每天的生活花销 · Chronos-2',
      'Amazon 2025 年发布的时间序列基础模型（1.2 亿参数），不用训练就能直接给出分位数预测。每天凌晨在 GitHub 上跑一次，参考周几、是不是周末、预算月第几天。',
      fc?.status === 'ok' ? `最近一次：${md(fc.at.slice(0, 10))}，用了 ${fc.context} 天的记录，往后预测 ${fc.days} 天。` : fc?.status === 'waiting' ? `记账满 7 天才开始预测（现在 ${fc.context} 天）。` : '还没有结果。'),
    block('三、两个模型打分、合在一起',
      '每天用前一天为止的数据预测这一天，拿实际花了多少比，用分位数损失打分（约等于 CRPS）：',
      f('L = (2/K) · Σₖ ρ_τₖ(y − q̂_τₖ)，ρ_τ(u) = u·(τ − 𝟙{u < 0})，τ = 0.01, 0.05, …, 0.99'),
      f(`权重 w = (14 × 0.5 + n × L_贝叶斯 / (L_贝叶斯 + L_Chronos)) / (14 + n)，现在 w_Chronos = ${pct(m.wChronos)}`),
      scoreText),
    block('四、这个月会花多少',
      `每条路径以 w 的可能用 Chronos-2、否则用贝叶斯，把剩下 ${daysBetween(today(), m.p.end) + 1} 天一天天抽出来，加上已经花的 ${money(m.spent)}。今天已经花的算下限。`,
      f(`月底 ${money(m.median)}（80%：${money(m.lo)}～${money(m.hi)}），P(超过 ${money(m.budget)}) = ${pct(m.pOver)}`)),
    block('五、收入 · Beta-伯努利',
      '每笔收入在每个有收入的月到不到账 ~ 伯努利(p)，p 的先验：写了几号的 Beta(19.5, 0.5)，不定时的 Beta(4.5, 0.5)，每过一个月按到没到更新。',
      ...s.incomes.map((x) => f(`${x.name} ¥${x.amount.toLocaleString('zh-CN')}：p ~ Beta(${x.a}, ${x.b})，平均 ${pct(x.p)}（${x.months} 个月里到了 ${x.hits} 次）`)),
      s.incomes.length ? null : '没有收入计划，按每月正常收入算。兼职、补助这种不一定有的钱不算。'),
    block('六、往后 · 蒙特卡洛',
      `模拟 ${s.paths} 条可能的未来。每条先抽一个 P 和每笔收入的 p，再一个月一个月走：收入、生活花销（一个月的和，用 P 的均值和方差做正态近似）、订阅预算、到日子的专项。`,
      '规矩和网站一样：生活费省下的进心愿基金（满 1 万的进存款），超了先扣心愿基金（留 100）再扣存款；月底按 家庭 → 应急 → 医疗 → 专项 → 自由 分，自由存款满了封存。',
      f('P(碰到底线) = 有哪个月底 存款 < 家庭 + 应急 + 医疗 的路径 ÷ 全部路径'),
      '随机数按日子定种子：同一天打开几次结果一样，记了新账才会变。'),
    block('七、建议怎么来的（只在有用时出）',
      `敏感性分析：专项按时留够的可能低于 ${pct(ON_TIME)}、或者碰到底线的可能高于 ${pct(BELOW_MAX)} 时，用二分法找「从下个月起每月少多少」刚好够（10 块一档，同一组随机数，结果随它单调）。先试只把预算调低（你本来就花不到预算时，省下的就进存款），不够再试「少花 + 预算一起调低」。`,
      f('c* = min { c : P(按时留够 | 每月 −c) ≥ 90% }'),
      `预算的可信区间（记满 ${CRED_DAYS} 天才看）：每一组每天花多少，用贝叶斯自助法（Dirichlet(1, …, 1) 权重）抽 2000 次日均 × 30.44，得到每月的 95% 区间；低于预算的可能 ≥ 95% 而且区间上边不到预算的九成，建议调低；超过预算的可能 ≥ 90%，提醒一句。`,
      '方差分解：一年后存款的方差里，把收入固定成「金额 × 可能」再模拟一次、把花销固定成后验均值再模拟一次，看方差各少了多少：',
      f('收入的份额 = 1 − Var(固定收入) / Var(全部)，花销的份额 = 1 − Var(固定花销) / Var(全部)')));
}

// ---------- 月度财务报表（2026-10-25，替换原来的月总结） ----------
// 计算在 report.js。网页上只放四个关键数字和图（用户 2026-10-25 定的：小字、表格都不要）；
// 表格、明细放在 .rep-detail 里，网页上藏着，存成 PDF（打印）时才印出来。最下面是「存成 PDF」「导出给 ChatGPT」

const repSigned = (v) => (Math.abs(v) < 0.005 ? '—' : `${v > 0 ? '+' : '−'}${exact(Math.abs(v))}`);
const repPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

// 储蓄率（2026-10-25 用户要的：月、年报表里直观明显）：大字 + 一句「每 100 块收入存下多少」+ 一条 0～100% 的条，
// 条上标出计划（按预算花能到的）和常见建议 20%。存得少用琥珀色。
// 负数（2026-10-26 用户定的）：条从右边的 0 往左长。只是用存好的钱（专项、心愿基金、大额人情）花成负的，安安静静写一句；
// 把这些加回去还是负的 = 真的花超了（realSaved < 0），整块变暗、裂开、往下滴、打开时抖一下（用户选的「恐怖」那一档），字还是安静的
const dreadShook = new Set(); // 抖过的月 / 年：页面重画时不再抖（只在内存）
function savingMeter(rate, { plan = null, planLabel = '计划', delta = null, deltaLabel = '', note = '', realSaved = 0, fromSaved = 0, span = '这个月', key = '' } = {}) {
  if (rate == null) return h('div', { class: 'saving-meter none' }, h('span', { class: 'muted small' }, '储蓄率'), h('p', { class: 'muted small' }, '这段时间没有收入，储蓄率不算。'));
  const pct = Math.round(rate * 100);
  const dread = realSaved <= -1;
  const neg = rate < 0;
  const tone = dread ? 'dread' : neg ? 'none' : plan != null ? (pct >= Math.round(plan * 100) ? 'good' : pct >= 20 ? 'ok' : 'warn') : pct >= 20 ? 'good' : 'ok';
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const planPct = plan != null ? Math.round(plan * 100) : null;
  const mark = (at, label, cls) => h('span', { class: `sm-mark ${cls}${at > 70 ? ' end' : at < 15 ? ' start' : ''}`, style: `left:${clamp(at)}%` }, h('i', {}), label ? h('small', {}, label) : null);
  const say = dread ? `${span}，存款在往下走。` : neg ? `用存好的钱花了 ${money(fromSaved)}，不算花超` : `每 100 块收入，存下 ${pct} 块`;
  const w = clamp(-pct);
  const track = neg
    ? h('div', { class: 'sm-track neg', role: 'img', 'aria-label': `储蓄率 ${pct}%` },
      h('span', { class: 'sm-fill', style: `width:${w}%` }),
      dread ? [0.18, 0.5, 0.82].map((at, i) => h('span', { class: 'sm-drip', style: `left:${100 - w * at}%;animation-delay:${i * 0.9}s` })) : null,
      mark(100, '0', 'zero end'))
    : h('div', { class: 'sm-track', role: 'img', 'aria-label': `储蓄率 ${pct}%${planPct != null ? `，${planLabel} ${planPct}%` : ''}` },
      h('span', { class: 'sm-fill', style: `width:${clamp(pct)}%` }),
      planPct == null || Math.abs(planPct - 20) >= 12 ? mark(20, '20%', 'ref') : null,
      planPct != null ? mark(planPct, `${planLabel} ${planPct}%`, 'plan') : null);
  const crack = dread ? h('span', { class: 'sm-crack', 'aria-hidden': 'true' }) : null;
  if (crack) crack.innerHTML = '<svg viewBox="0 0 120 90" preserveAspectRatio="none"><path d="M120 6 L96 18 L101 30 L78 41 L84 52 L62 60 L66 71 L47 90" /><path d="M96 18 L86 9" /><path d="M78 41 L68 34" /><path d="M62 60 L52 56" /></svg>';
  const shake = dread && !dreadShook.has(key);
  if (shake) dreadShook.add(key);
  return h('div', { class: `saving-meter ${tone}${shake ? ' shake' : ''}` },
    crack,
    h('div', { class: 'sm-top' },
      h('span', { class: 'muted small' }, '储蓄率'),
      delta != null ? h('span', { class: 'muted small' }, `${deltaLabel} ${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)} 个点`) : null),
    h('div', { class: 'sm-row' }, h('b', { class: 'sm-num' }, `${pct < 0 ? '−' : ''}${Math.abs(pct)}%`), h('span', { class: 'small' }, say)),
    track,
    note && !dread ? h('p', { class: 'muted small sm-note' }, note) : null);
}
const PURPOSE_COLORS = { 家庭存款: 'var(--jar-k1)', 应急底线: 'var(--jar-k2)', 医疗备用金: 'var(--jar-k3)', 专项存款: 'var(--jar-k4)', 自由存款: 'var(--jar-w1)', 心愿基金: 'var(--jar-w2)', 生活费还剩: 'var(--jar-g)' };

// 表格（只在 PDF 里）：cols = ['', '本月', …]；rows = [[…], …] 或 { cells, cls }（cls：group 小标题行、total 合计行）。第一列靠左，别的靠右
function repTable(cols, rows, label) {
  return h('div', { class: 'rep-table-wrap' }, h('table', { class: 'rep-table', 'aria-label': label },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
    h('tbody', {}, rows.filter(Boolean).map((r) => {
      const { cells, cls } = Array.isArray(r) ? { cells: r } : r;
      return h('tr', { class: cls || null }, cls === 'group' ? h('td', { colspan: cols.length }, cells[0]) : cells.map((c) => h('td', {}, c ?? '')));
    }))));
}
const repDetail = (...children) => h('div', { class: 'rep-detail' }, ...children);
const repSection = (title, ...children) => h('section', { class: 'card rep-sec' }, h('h3', {}, title), ...children);
const repLegend = (items) => h('div', { class: 'legend' }, items.map(([name, color]) => h('span', {}, h('i', { style: `background:${color}` }), name)));
// 不占预算的两块（2026-10-26 用户要的）：图下面一块一行，点一下在原地展开，只写去处和金额，点一笔没有反应。PDF 里都展开
const NONE_SAVED_COLOR = 'var(--jar-k4)';
function noneRows(split) {
  const row = (label, color, b) => {
    if (b.v < 0.005) return null;
    const list = h('div', { class: 'none-list' }, b.groups.map((g) => [
      h('div', { class: 'none-g' }, h('span', {}, g.name), h('span', {}, exact(g.v))),
      g.tx.length > 1 ? g.tx.map((t) => h('div', { class: 'none-t muted small' }, h('span', {}, `${md(t.date)} ${txTitle(t)}`), h('span', {}, exact(spendOf(store.data, t))))) : null,
    ]));
    const wrap = h('div', { class: 'none-block' });
    const btn = h('button', { type: 'button', class: 'none-row', 'aria-expanded': 'false', onclick: () => {
      const open = !wrap.classList.contains('open');
      wrap.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    } }, h('i', { style: `background:${color}` }), h('span', {}, label), h('b', {}, exact(b.v)), h('span', { class: 'none-chev', 'aria-hidden': 'true' }, '›'));
    wrap.append(btn, list);
    return wrap;
  };
  const rows = [row('用存好的', NONE_SAVED_COLOR, split.saved), row('预算外', 'var(--g-none-strong)', split.outside)].filter(Boolean);
  return rows.length ? h('div', { class: 'none-rows' }, rows) : null;
}

// 这个预算月按预算花能存下几成：(正常收入 − 预算) ÷ 正常收入；暑假那几个月没有收入，不算
function monthPlanRate(d, p) {
  const inc = Number(d.settings.expectedIncome) || 0;
  if (!inc || (d.settings.summerMonths || []).includes(p.startMonth)) return null;
  return (inc - budgetTotal(d)) / inc;
}
// 去年的储蓄率（比去年差几个点）；去年没记账就不比
function prevYearRate(d, year, rate) {
  if (rate == null || d.openingDate > `${year - 1}-12-31`) return null;
  const last = yearReport(d, year - 1, usdRate(), today()).key.savingRate;
  return last == null ? null : Math.round(rate * 100) - Math.round(last * 100);
}

function monthReportView(d, day, head, seg, navRow) {
  const r = monthReport(d, day, usdRate(), today());
  const { p, key } = r;
  const prev = key.prev;
  const year = Number(p.start.slice(0, 4));
  const endCol = r.ongoing ? '现在' : '月底';
  const empty = !r.st.tx.length;
  const withPrev = Boolean(prev);
  const cmp = (now, before) => (withPrev ? [exact(before), repSigned(now - before)] : []);
  const cmpCols = withPrev ? ['上月', '变化'] : [];
  const nav = navRow(monthMast(d, p), addDays(p.start, -1), p.next);
  const fileBase = `财务报表-${year}-${String(p.startMonth).padStart(2, '0')}`;
  const exportBtns = exportButtons({
    excel: () => downloadBlob(makeWorkbook(monthSheets(r)), `${fileBase}.xlsx`),
    chatgpt: () => chatgptSheet({ ask: REPORT_ASK, text: () => reportText(r), file: `${fileBase}.md`, what: '这份报表' }),
  });

  // 表头 + 关键数字：网页上只有标题和四个数
  const kpi = (label, v, cls = '') => h('div', { class: `rep-kpi ${cls}` }, h('div', { class: 'muted small' }, label), h('b', {}, v));
  const top = h('div', { class: 'card rep-head' },
    repDetail(h('div', { class: 'rep-title' }, `${year} 年 ${p.startMonth} 月财务报表`)), // 网页上刊头已经写了，标题只在 PDF 里
    repDetail(h('div', { class: 'muted small' }, [p.label, r.ongoing ? `到 ${md(r.asOf)} 为止` : null, r.part.isPartial ? `从 ${md(r.part.from)}开始记账` : null].filter(Boolean).join(' · '))),
    empty ? h('p', { class: 'muted' }, '这个预算月还没有记录。') : [
      h('div', { class: 'rep-kpis' },
        kpi('收入', exact(key.income)),
        kpi('支出', exact(key.total)),
        kpi(key.saved >= 0 ? '存下' : '多花了', exact(Math.abs(key.saved)), key.saved < 0 ? 'warn' : ''),
        kpi('净资产', exact(key.net))),
      savingMeter(key.savingRate, {
        plan: monthPlanRate(d, p), planLabel: '按预算花', realSaved: r.st.planSaved, fromSaved: r.st.fromSaved, key: p.start,
        delta: withPrev && key.savingRate != null && prev.savingRate != null ? Math.round(key.savingRate * 100) - Math.round(prev.savingRate * 100) : null, deltaLabel: '比上月',
        note: r.ongoing && key.savingRate != null ? '这个月还没过完，后面还要花钱，会往下走一些。' : '',
      }),
      repDetail(
        h('div', { class: 'advice' }, h('b', {}, '下个月可以试试：'), r.advice),
        repTable(['', '本月', ...cmpCols], [
          ['收入', exact(key.income), ...cmp(key.income, prev?.income)],
          ['支出', exact(key.total), ...cmp(key.total, prev?.total)],
          ['存下', repSigned(key.saved), ...(withPrev ? [repSigned(prev.saved), repSigned(key.saved - prev.saved)] : [])],
          ['储蓄率', repPct(key.savingRate), ...(withPrev ? [repPct(prev.savingRate), key.savingRate != null && prev.savingRate != null ? `${simSigned(Math.round((key.savingRate - prev.savingRate) * 100), String)} 个点` : '—'] : [])],
          ['净资产变化', repSigned(key.netChange), ...(withPrev ? [repSigned(prev.netChange), repSigned(key.netChange - prev.netChange)] : [])],
        ], '关键数字'))]);
  if (empty) return h('div', { class: 'report' }, head, seg, nav, top, exportBtns);

  // 收支：瀑布图；不占预算拆成「用存好的」「预算外」两根，图下面点开看去处
  const split = noneSplit(d, r.st.tx);
  const s2 = repSection('收支',
    key.income || key.total ? waterfall([{ label: '收入', v: key.income, color: 'var(--sage)' },
      ...r.spend.filter((g) => g.v > 0 && g.id !== 'none').map((g) => ({ label: g.name, v: g.v, color: g.color })),
      ...(split.saved.v >= 0.005 ? [{ label: '存好的', v: split.saved.v, color: NONE_SAVED_COLOR }] : []),
      ...(split.outside.v >= 0.005 ? [{ label: '预算外', v: split.outside.v, color: 'var(--g-none-strong)' }] : [])],
      { endLabel: key.saved >= 0 ? '存下' : '多花', title: '收支瀑布图' }) : null,
    noneRows(split),
    repDetail(repTable(['', '本月', ...cmpCols], [
      { cells: ['收入'], cls: 'group' },
      ...r.income.map((x) => [x.name, exact(x.v), ...cmp(x.v, x.prev)]),
      { cells: ['收入合计', exact(key.income), ...cmp(key.income, prev?.income)], cls: 'total' },
      { cells: ['支出'], cls: 'group' },
      ...r.spend.map((g) => [g.name, exact(g.v), ...cmp(g.v, g.prev)]),
      { cells: ['支出合计', exact(key.total), ...cmp(key.total, prev?.total)], cls: 'total' },
      { cells: [key.saved >= 0 ? '存下' : '多花了', exact(Math.abs(key.saved)), ...(withPrev ? [repSigned(prev.saved), repSigned(key.saved - prev.saved)] : [])], cls: 'total strong' },
    ], '收支表')));

  // 家底：月初 / 月底按用途的堆叠条 + 净资产折线
  const sumOf = (k) => r.purposes.reduce((a, x) => a + x[k], 0);
  const scale = Math.max(1, ...['start', 'end'].map((k) => r.purposes.reduce((a, x) => a + Math.max(0, x[k]), 0)));
  const stackRow = (label, k) => h('div', { class: 'rep-stack-row' }, h('span', { class: 'muted small' }, label),
    h('div', { class: 'rep-stack' }, r.purposes.filter((x) => x[k] > 0).map((x) => h('span', { style: `width:${(x[k] / scale) * 100}%;background:${PURPOSE_COLORS[x.name]}`, title: x.name }))),
    h('span', { class: 'small' }, jarMoney(sumOf(k))));
  const nwHist = r.trend.filter((x) => x.net != null);
  const minus = (v) => (v < 0 ? `−${exact(-v)}` : exact(v));
  const s3 = repSection('家底',
    h('div', { class: 'rep-stacks', role: 'img', 'aria-label': '月初和月底的钱按用途分' }, stackRow('月初', 'start'), stackRow(endCol, 'end')),
    repLegend(r.purposes.map((x) => [x.name, PURPOSE_COLORS[x.name]])),
    nwHist.length >= 2 ? lineChart([{ values: nwHist.map((x) => x.net), color: 'var(--accent)' }],
      { tight: true, height: 120, title: '净资产', xLabels: [[0, `${nwHist[0].p.startMonth}月`], [nwHist.length - 1, `${nwHist.at(-1).p.startMonth}月`]] }) : null,
    repDetail(
      repTable(['账户', '月初', endCol, '变化'], [
        ...r.accounts.map((a) => [`${a.name}${a.usd ? '（美元）' : ''}`, exact(a.start), exact(a.end), repSigned(a.end - a.start)]),
        r.startNW.toMe || r.endNW.toMe ? ['别人欠我的', exact(r.startNW.toMe), exact(r.endNW.toMe), repSigned(r.endNW.toMe - r.startNW.toMe)] : null,
        r.startNW.iOwe || r.endNW.iOwe ? ['我欠别人的', minus(-r.startNW.iOwe), minus(-r.endNW.iOwe), repSigned(r.startNW.iOwe - r.endNW.iOwe)] : null,
        { cells: ['净资产', exact(r.startNW.net), exact(r.endNW.net), repSigned(r.endNW.net - r.startNW.net)], cls: 'total strong' },
      ], '按账户'),
      repTable(['用途', '月初', endCol, '变化'], [
        ...r.purposes.map((x) => [x.name, minus(x.start), minus(x.end), repSigned(x.end - x.start)]),
        { cells: ['合计', exact(sumOf('start')), exact(sumOf('end')), repSigned(sumOf('end') - sumOf('start'))], cls: 'total' },
      ], '按用途'),
      h('p', { class: 'muted small' }, '美元按今天的汇率折成人民币。')));

  // 预算：子弹条 + 花钱曲线
  const bScale = Math.max(1, ...r.budget.map((x) => Math.max(x.budget, x.v)));
  const bSum = r.budget.reduce((a, x) => a + x.budget, 0);
  const vSum = r.budget.reduce((a, x) => a + x.v, 0);
  const diffText = (b, v) => (v > b ? `超 ${money(v - b)}` : `${r.ongoing ? '还剩' : '省'} ${money(b - v)}`);
  const upto = r.curve.filter((x) => x.day <= r.asOf);
  const n = r.curve.length - 1;
  const s4 = repSection('预算',
    r.budget.length ? h('div', { class: 'rep-bullets', role: 'img', 'aria-label': '每一块预算用了多少' }, r.budget.map((x) => h('div', { class: 'rep-bullet' },
      h('span', { class: 'small' }, x.name),
      h('div', { class: 'rep-bullet-track' },
        h('span', { class: 'rep-bullet-budget', style: `width:${(x.budget / bScale) * 100}%` }),
        h('span', { class: `rep-bullet-fill${x.v > x.budget ? ' over' : ''}`, style: `width:${(x.v / bScale) * 100}%;--c:${x.color}` }),
        h('span', { class: 'rep-bullet-mark', style: `left:${(x.budget / bScale) * 100}%` })),
      h('span', { class: `small ${x.v > x.budget ? 'warn-text' : 'muted'}` }, repPct(x.pct))))) : null,
    r.lb > 0 ? [lineChart([
      { values: r.curve.map((x) => x.planned), color: 'var(--muted)', dashed: true },
      { values: upto.map((x) => x.actual), color: 'var(--accent)' },
    ], { height: 140, xLabels: [[0, md(p.start)], [Math.round(n / 2), md(r.curve[Math.round(n / 2)].day)], [n, md(p.end)]], title: '花钱曲线' }),
    repLegend([['生活花销累计', 'var(--accent)'], ['按计划', 'var(--muted)']])] : null,
    repDetail(
      repTable(['', '预算', '实际', '差额', '用了'], [
        ...r.budget.map((x) => [x.name, money(x.budget), exact(x.v), diffText(x.budget, x.v), repPct(x.pct)]),
        { cells: ['合计', money(bSum), exact(vSum), diffText(bSum, vSum), repPct(bSum ? vSum / bSum : 0)], cls: 'total' },
      ], '预算执行')));

  // 花在哪：环形 + 每天的日历
  const groups = GROUPS.filter((g) => r.rs.byGroup[g.id]);
  const cal = r.calendar;
  const calMax = Math.max(1, ...cal.days.map((x) => x.v));
  const lead = (new Date(`${p.start}T12:00:00`).getDay() + 6) % 7; // 周一在最左
  // 日历：颜色是生活花销；点一天，下面一行写那天一共花了多少（2026-10-26 用户要的，不占预算的也算），再点一下收起
  const calPick = h('p', { class: 'rep-cal-pick small', 'aria-live': 'polite' });
  let picked = null;
  const pick = (x, el) => {
    if (picked) picked.classList.remove('on');
    picked = picked === el ? null : el;
    if (picked) picked.classList.add('on');
    calPick.textContent = picked ? `${Number(x.day.slice(5, 7))}月${Number(x.day.slice(8))}日 · ${exact(x.all)}` : '';
  };
  const calGrid = h('div', { class: 'rep-cal', role: 'group', 'aria-label': '每天的生活花销日历，点一天看那天一共花了多少' },
    [...WEEKDAYS].map((w) => h('span', { class: 'rep-cal-wd', 'aria-hidden': 'true' }, w)),
    Array.from({ length: lead }, () => h('span', {})),
    cal.days.map((x) => {
      const off = x.future || x.before;
      const el = h(off ? 'span' : 'button', {
        type: off ? null : 'button',
        class: `rep-cal-day${off ? ' off' : x.v / calMax > 0.55 ? ' dark' : ''}`,
        style: off ? '' : `--a:${Math.round(8 + (x.v / calMax) * 72)}%`,
        'aria-label': off ? null : `${md(x.day)}`,
        onclick: off ? null : () => pick(x, el),
      }, String(Number(x.day.slice(8))));
      return el;
    }));
  const s5 = repSection('花在哪',
    r.rs.total ? spendDonut(r.rs, groups, { sub: '这个月花销', title: '花在哪了' }) : null,
    calGrid,
    calPick,
    repDetail(
      repTable(['类别', '金额', '占比', ...(withPrev ? ['比上月'] : [])],
        r.cats.slice(0, 10).map((x) => [x.name, exact(x.v), repPct(x.share), ...(withPrev ? [repSigned(x.v - x.prev)] : [])]), '花得最多的类别'),
      repTable(['每天的生活花销', ''], [
        ['平均每天', exact(cal.avg)],
        cal.max && cal.max.v > 0 ? ['花得最多的一天', `${md(cal.max.day)} · ${exact(cal.max.v)}`] : null,
        ['没花钱的日子', `${cal.zero} 天（共 ${cal.counted} 天）`],
      ], '每天'),
      r.top.length ? repTable(['最大的几笔', ''], r.top.map((t) => [`${md(t.date)} ${txTitle(t)}${t.note ? `（${t.note}）` : ''}`, exact(cny(t))]), '最大的几笔') : null));

  // 趋势：收入、支出柱子 + 储蓄率的线
  const s6 = repSection('趋势',
    barsLine(r.trend.map((x) => ({ label: `${x.p.startMonth}月`, a: x.income, b: x.total, rate: x.rate })), { title: '收入、支出和储蓄率' }),
    repLegend([['收入', 'var(--sage)'], ['支出', 'var(--g-food)'], ['储蓄率', 'var(--accent)']]),
    repDetail(repTable(['', '收入', '支出', '存下', '储蓄率'], r.trend.map((x) => [`${x.p.startMonth}月`, money(x.income), money(x.total), money(x.saved), repPct(x.rate)]), '最近几个月')));

  // AI 点评（这个月过完才有）
  const letter = letterCard(p);

  // 附注：只在 PDF 里，有才写
  const nt = r.notes;
  const w = nt.wish;
  const noteRows = [
    nt.lumps.length ? ['一次性的钱', exact(nt.lumps.reduce((a, x) => a + x.v, 0)), nt.lumps.map((x) => `${md(x.date)} ${x.name}`).join('、') + '；不算收入，直接进存款'] : null,
    nt.fromSaved.length ? ['用以前留好的钱花的', exact(nt.fromSaved.reduce((a, x) => a + x.v, 0)), nt.fromSaved.map((x) => `${x.name} ${exact(x.v)}`).join('、') + '；不占预算'] : null,
    nt.owedStart || nt.owedEnd ? ['待收回', `${exact(nt.owedStart)} → ${exact(nt.owedEnd)}`, '垫付还没报销的、别人欠的'] : null,
    nt.iOweStart || nt.iOweEnd ? ['我欠别人的', `${exact(nt.iOweStart)} → ${exact(nt.iOweEnd)}`, ''] : null,
    nt.taxRefund ? ['退税', exact(nt.taxRefund), ''] : null,
    nt.subs.length ? ['订阅扣费', exact(nt.subs.reduce((a, x) => a + x.v, 0)), nt.subs.map((x) => `${x.name} ${exact(x.v)}`).join('、')] : null,
    w.start || w.end || w.rows.length ? ['心愿基金', `${exact(w.start)} → ${exact(w.end)}`, [w.rows.map((x) => `${x.name} ${repSigned(x.v)}`).join('、'), w.rate ? (w.rate.leftover >= 0 ? `生活费省下了预算的 ${repPct(w.rate.rate)}` : `生活费超了预算的 ${repPct(-w.rate.rate)}`) : ''].filter(Boolean).join('；')] : null,
    nt.wishesBought.length ? ['实现的心愿', exact(nt.wishesBought.reduce((a, x) => a + x.v, 0)), nt.wishesBought.map((x) => x.name).join('、')] : null,
    nt.milestones.length ? ['里程碑', '', nt.milestones.join('、')] : null,
  ].filter(Boolean);
  const notes = noteRows.length ? h('section', { class: 'card rep-sec rep-detail' }, h('h3', {}, '附注'), repTable(['项目', '金额'],
    noteRows.map(([name, v, why]) => [h('span', {}, name, why ? h('span', { class: 'muted small block' }, why) : null), v]), '附注')) : null;

  return h('div', { class: 'report' }, head, seg, nav, top, s2, s3, s4, s5, s6, letter, notes, exportBtns);
}

const REPORT_ASK = `我是一个大学生，在认真学着记账、稳定存钱。下面是我一个月的财务报表：收支、家底（按账户和按用途）、预算执行、花销明细、最近几个月的趋势，还有附注。
请你：
1. 用大白话说说这个月整体怎么样；
2. 指出一两件做得好的、一两件可以改进的，要具体到数字；
3. 和前几个月比，有没有值得注意的变化；
4. 给下个月一两条容易做到的建议。
不要推荐任何理财产品。`;

// 报表写成 Markdown：导出给 ChatGPT、下载都用它
function reportText(r) {
  const d = store.data;
  const { p, key } = r;
  const prev = key.prev;
  const L = [];
  const row = (...c) => L.push(`| ${c.join(' | ')} |`);
  const table = (cols, rows) => { row(...cols); row(...cols.map(() => '---')); for (const x of rows.filter(Boolean)) row(...x); L.push(''); };
  const y = p.start.slice(0, 4);
  L.push(`# ${y} 年 ${p.startMonth} 月财务报表`, '', `预算月 ${p.label}${r.ongoing ? `，到 ${md(r.asOf)} 为止（还没过完）` : ''}${r.part.isPartial ? `，从 ${md(r.part.from)}开始记账` : ''}。金额是人民币，美元按今天的汇率折算。`, '');
  L.push('## 一、关键数字', '');
  table(['', '本月', '上月'], [
    ['收入', exact(key.income), prev ? exact(prev.income) : '—'],
    ['支出', exact(key.total), prev ? exact(prev.total) : '—'],
    ['存下', repSigned(key.saved), prev ? repSigned(prev.saved) : '—'],
    ['储蓄率', repPct(key.savingRate), prev ? repPct(prev.savingRate) : '—'],
    ['净资产', exact(key.net), ''],
    ['净资产变化', repSigned(key.netChange), prev ? repSigned(prev.netChange) : '—'],
  ]);
  L.push('## 二、收支表', '');
  table(['', '本月', '上月'], [
    ...r.income.map((x) => [`收入：${x.name}`, exact(x.v), x.prev != null ? exact(x.prev) : '—']),
    ['**收入合计**', exact(key.income), prev ? exact(prev.income) : '—'],
    ...r.spend.map((g) => [`支出：${g.name}`, exact(g.v), g.prev != null ? exact(g.prev) : '—']),
    ['**支出合计**', exact(key.total), prev ? exact(prev.total) : '—'],
  ]);
  L.push('## 三、资产表', '', '按账户：', '');
  table(['账户', '月初', r.ongoing ? '现在' : '月底'], [
    ...r.accounts.map((a) => [a.name + (a.usd ? '（美元）' : ''), exact(a.start), exact(a.end)]),
    ['别人欠我的', exact(r.startNW.toMe), exact(r.endNW.toMe)],
    ['我欠别人的', exact(r.startNW.iOwe), exact(r.endNW.iOwe)],
    ['**净资产**', exact(r.startNW.net), exact(r.endNW.net)],
  ]);
  L.push('按用途：', '');
  table(['用途', '月初', r.ongoing ? '现在' : '月底'], r.purposes.map((x) => [x.name, exact(x.start), exact(x.end)]));
  L.push('## 四、预算执行', '');
  table(['', '预算', '实际', '用了'], r.budget.map((x) => [x.name, money(x.budget), exact(x.v), repPct(x.pct)]));
  if (r.st.spent.none >= 1) {
    const sp = noneSplit(d, r.st.tx);
    const part = (label, b) => (b.v >= 0.005 ? `${label} ${exact(b.v)}：${b.groups.map((g) => `${g.name} ${exact(g.v)}`).join('、')}` : null);
    L.push(`不占预算：${[part('用存好的钱', sp.saved), part('预算外', sp.outside)].filter(Boolean).join('；')}`, '');
  }
  L.push('## 五、花销明细', '');
  table(['类别', '金额', '占比', '笔数'], r.cats.map((x) => [x.name, exact(x.v), repPct(x.share), String(x.n)]));
  L.push(`生活花销平均每天 ${exact(r.calendar.avg)}；没花钱的日子 ${r.calendar.zero} 天（共 ${r.calendar.counted} 天）${r.calendar.max?.v ? `；花得最多的一天 ${md(r.calendar.max.day)} ${exact(r.calendar.max.v)}` : ''}。`, '');
  if (r.top.length) { L.push('最大的几笔：'); for (const t of r.top) L.push(`- ${md(t.date)} ${txTitle(t)} ${exact(cny(t))}${t.note ? `（${t.note}）` : ''}`); L.push(''); }
  L.push('## 六、最近几个月', '');
  table(['', '收入', '支出', '存下', '储蓄率', '净资产'], r.trend.map((x) => [`${x.p.startMonth}月`, money(x.income), money(x.total), money(x.saved), repPct(x.rate), money(x.net)]));
  const nt = r.notes;
  const notes = [
    nt.lumps.length ? `一次性的钱（不算收入，直接进存款）：${nt.lumps.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
    nt.fromSaved.length ? `用以前留好的钱花的（不占预算）：${nt.fromSaved.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
    nt.owedStart || nt.owedEnd ? `待收回：${exact(nt.owedStart)} → ${exact(nt.owedEnd)}` : null,
    nt.iOweStart || nt.iOweEnd ? `我欠别人的：${exact(nt.iOweStart)} → ${exact(nt.iOweEnd)}` : null,
    nt.taxRefund ? `退税：${exact(nt.taxRefund)}` : null,
    nt.subs.length ? `订阅扣费：${nt.subs.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
    `心愿基金（能随便用的）：${exact(nt.wish.start)} → ${exact(nt.wish.end)}${nt.wish.rows.length ? `；${nt.wish.rows.map((x) => `${x.name} ${repSigned(x.v)}`).join('、')}` : ''}`,
    nt.wishesBought.length ? `实现的心愿：${nt.wishesBought.map((x) => x.name).join('、')}` : null,
    nt.milestones.length ? `里程碑：${nt.milestones.join('、')}` : null,
  ].filter(Boolean);
  L.push('## 七、附注', '', ...notes.map((x) => `- ${x}`), '');
  const letter = d.letters?.[p.start];
  if (letter) L.push('## 八、AI 点评', '', letter.text, '');
  L.push(`网站给的建议：${r.advice}`);
  return L.join('\n');
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
    `这个月实现的心愿：${d.wishes.filter((w) => w.status === 'bought' && inP(w.boughtAt)).map((w) => w.name).join('、') || '无'}。`,
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
  if (!text) throw new Error('AI 没写出来，等会儿再试');
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
  return h('section', { class: 'card letter rep-sec' },
    h('h3', {}, 'AI 点评'),
    letter ? [h('p', { class: 'letter-text' }, letter.text), h('button', { class: 'link small', onclick: () => { delete d.letters[p.start]; run(); render(); } }, '再写一封')]
      : letterState.busy[p.start] || (latest && !letterState.error[p.start]) ? h('p', { class: 'muted small' }, 'AI 正在写……')
        : [letterState.error[p.start] ? h('p', { class: 'small warn-text' }, letterState.error[p.start]) : null,
          h('button', { class: 'secondary', onclick: run }, '让 AI 写一封')]);
}

// ---------- 年度财务报表（2026-10-25，按自然年；和月度报表一样：网页上只有四个数和图，表格、明细在 PDF、Excel、ChatGPT 里） ----------

// 月初 / 月底（年初 / 年底）按用途分的两根堆叠条
function purposeStacks(purposes, labels) {
  const scale = Math.max(1, ...['start', 'end'].map((k) => purposes.reduce((a, x) => a + Math.max(0, x[k]), 0)));
  const row = (label, k) => h('div', { class: 'rep-stack-row' }, h('span', { class: 'muted small' }, label),
    h('div', { class: 'rep-stack' }, purposes.filter((x) => x[k] > 0).map((x) => h('span', { style: `width:${(x[k] / scale) * 100}%;background:${PURPOSE_COLORS[x.name]}`, title: x.name }))),
    h('span', { class: 'small' }, jarMoney(purposes.reduce((a, x) => a + x[k], 0))));
  return [h('div', { class: 'rep-stacks', role: 'img', 'aria-label': `${labels[0]}和${labels[1]}的钱按用途分` }, row(labels[0], 'start'), row(labels[1], 'end')),
    repLegend(purposes.map((x) => [x.name, PURPOSE_COLORS[x.name]]))];
}
const minusMoney = (v) => (v < 0 ? `−${exact(-v)}` : exact(v));
function exportButtons({ pdf = () => window.print(), excel, chatgpt }) {
  return h('div', { class: 'rep-export' },
    h('button', { class: 'secondary', onclick: pdf }, '存成 PDF'),
    h('button', { class: 'secondary', onclick: excel }, '导出 Excel'),
    h('button', { class: 'secondary wide', onclick: chatgpt }, '导出给 ChatGPT'));
}

function yearReportView(d, year, head, seg, navRow) {
  const y = yearReport(d, year, usdRate(), today());
  const { key } = y;
  const nav = navRow(yearMast(year), `${year - 1}-12-31`, `${year + 1}-01-01`);
  const endCol = y.ongoing ? '现在' : '年底';
  const startCol = y.from > `${year}-01-01` ? '开始记账' : '年初';
  const empty = !y.started || !y.st.tx.length;
  const kpi = (label, v, cls = '') => h('div', { class: `rep-kpi ${cls}` }, h('div', { class: 'muted small' }, label), h('b', {}, v));
  const active = y.months.filter((m) => m.active);
  const exports = exportButtons({
    excel: () => downloadBlob(makeWorkbook(yearSheets(y)), `财务报表-${year}.xlsx`),
    chatgpt: () => chatgptSheet({ ask: YEAR_ASK, text: () => yearText(y), file: `财务报表-${year}.md`, what: '这份年度报表' }),
  });
  const top = h('div', { class: 'card rep-head' },
    repDetail(h('div', { class: 'rep-title' }, `${year} 年财务报表`)), // 网页上刊头已经写了，标题只在 PDF 里
    repDetail(h('div', { class: 'muted small' }, [`${md(y.from)} – ${md(y.to)}`, y.ongoing ? `到 ${md(y.asOf)} 为止` : null, `记了 ${y.notes.days} 天账`].filter(Boolean).join(' · '))),
    empty ? h('p', { class: 'muted' }, '这一年还没有记录。') : [
      h('div', { class: 'rep-kpis' },
        kpi('收入', exact(key.income)),
        kpi('支出', exact(key.total)),
        kpi(key.saved >= 0 ? '存下' : '多花了', exact(Math.abs(key.saved)), key.saved < 0 ? 'warn' : ''),
        kpi(y.ongoing ? '净资产' : '年底净资产', exact(key.net))),
      savingMeter(key.savingRate, {
        plan: yearPlan(d).rate != null ? yearPlan(d).rate / 100 : null, planLabel: '计划', span: '这一年',
        realSaved: y.st.income - y.st.total + y.st.fromSaved, fromSaved: y.st.fromSaved, key: String(year),
        delta: prevYearRate(d, year, key.savingRate), deltaLabel: '比去年',
        note: y.ongoing && d.settings.summerMonths.length ? `一年里有 ${d.settings.summerMonths.length} 个月没有收入，那几个月会把它拉下来一些，计划已经算上了。` : '',
      }),
      repDetail(repTable(['', '这一年'], [
        ['收入', exact(key.income)], ['支出', exact(key.total)], ['存下', repSigned(key.saved)], ['储蓄率', repPct(key.savingRate)],
        [`净资产（${startCol} → ${endCol}）`, `${exact(y.startNW.net)} → ${exact(y.endNW.net)}`], ['净资产变化', repSigned(key.netChange)],
        y.planAll ? ['计划存', money(y.planAll)] : null,
      ], '这一年'))]);
  if (empty) return h('div', { class: 'report' }, head, seg, nav, top);

  // 每月收支：12 个月的收入、支出柱子 + 储蓄率的线
  const monthLabel = (m) => String(m.m);
  const s1 = repSection('每月收支',
    barsLine(y.months.map((m) => ({ label: monthLabel(m), a: m.income || 0, b: m.total || 0, rate: m.active ? m.rate : null })), { title: '每月收入、支出和储蓄率' }),
    repLegend([['收入', 'var(--sage)'], ['支出', 'var(--g-food)'], ['储蓄率', 'var(--accent)']]),
    repDetail(repTable(['月', '收入', '支出', '存下', '储蓄率', '月底净资产'], [
      ...active.map((m) => [`${m.m}月`, exact(m.income), exact(m.total), repSigned(m.saved), repPct(m.rate), exact(m.net)]),
      { cells: ['全年', exact(key.income), exact(key.total), repSigned(key.saved), repPct(key.savingRate), exact(key.net)], cls: 'total strong' },
    ], '每月收支')));

  // 存钱计划：累计存下 vs 按计划累计
  const s2 = y.planAll ? repSection('存钱计划',
    lineChart([
      { values: [0, ...active.map((m) => m.cumPlan)], color: 'var(--muted)', dashed: true },
      { values: [0, ...active.map((m) => m.cum)], color: 'var(--sage)' },
    ], { tight: true, height: 150, fmt: (v) => jarMoney(v).replace('¥', ''), title: '存钱计划',
      xLabels: [[0, startCol], [active.length, `${active.at(-1).m}月底`]] }),
    repLegend([['累计存下', 'var(--sage)'], ['按计划', 'var(--muted)']]),
    repDetail(repTable(['月', '累计存下', '按计划', '差'], active.map((m) => [`${m.m}月`, exact(m.cum), money(m.cumPlan), repSigned(m.cum - m.cumPlan)]), '存钱计划'),
      h('p', { class: 'muted small' }, '累计存下里，用以前留好的钱花的（专项、心愿）不算没存够。'))) : null;

  // 家底：年初 / 年底按用途 + 每月月底的净资产
  const s3 = repSection('家底',
    ...purposeStacks(y.purposes, [startCol === '年初' ? '年初' : '开始', endCol]),
    active.length >= 2 ? lineChart([{ values: active.map((m) => m.net), color: 'var(--accent)' }],
      { tight: true, height: 120, title: '每月月底的净资产', fmt: (v) => jarMoney(v).replace('¥', ''), xLabels: [[0, `${active[0].m}月`], [active.length - 1, `${active.at(-1).m}月`]] }) : null,
    repDetail(
      repTable(['账户', startCol, endCol, '变化'], [
        ...y.accounts.map((a) => [`${a.name}${a.usd ? '（美元）' : ''}`, exact(a.start), exact(a.end), repSigned(a.end - a.start)]),
        y.startNW.toMe || y.endNW.toMe ? ['别人欠我的', exact(y.startNW.toMe), exact(y.endNW.toMe), repSigned(y.endNW.toMe - y.startNW.toMe)] : null,
        y.startNW.iOwe || y.endNW.iOwe ? ['我欠别人的', minusMoney(-y.startNW.iOwe), minusMoney(-y.endNW.iOwe), repSigned(y.startNW.iOwe - y.endNW.iOwe)] : null,
        { cells: ['净资产', exact(y.startNW.net), exact(y.endNW.net), repSigned(key.netChange)], cls: 'total strong' },
      ], '按账户'),
      repTable(['用途', startCol, endCol, '变化'], y.purposes.map((x) => [x.name, minusMoney(x.start), minusMoney(x.end), repSigned(x.end - x.start)]), '按用途'),
      h('p', { class: 'muted small' }, '美元按今天的汇率折成人民币。')));

  // 预算：一行一块、一列一个月，颜色是这个月用了预算的几成，超了变红
  const bGroups = GROUPS.filter((g) => Number(d.budget?.[g.id]) > 0);
  const heatColor = (u) => (u > 1 ? `color-mix(in srgb, var(--danger) ${Math.round(Math.min(100, 55 + (u - 1) * 90))}%, var(--chip))`
    : `color-mix(in srgb, var(--accent) ${Math.round(6 + u * 64)}%, var(--chip))`);
  const s4 = bGroups.length ? repSection('预算',
    h('div', { class: 'rep-heat', role: 'img', 'aria-label': '每一块每个月用了预算的多少' },
      h('span', {}), y.months.map((m) => h('span', { class: 'rep-heat-m' }, String(m.m))),
      bGroups.map((g) => [h('span', { class: 'rep-heat-name small' }, g.name),
        y.months.map((m) => (m.active
          ? h('span', { class: `rep-heat-cell${m.used[g.id] > 1 ? ' over' : ''}`, style: `background:${heatColor(m.used[g.id] || 0)}`, title: `${m.m}月 ${g.name} ${repPct(m.used[g.id])}` })
          : h('span', { class: 'rep-heat-cell off' })))])),
    repLegend([['用得少', heatColor(0.15)], ['快用完', heatColor(0.95)], ['超了', heatColor(1.2)]]),
    repDetail(repTable(['月', ...bGroups.map((g) => g.name)], active.map((m) => [`${m.m}月`, ...bGroups.map((g) => repPct(m.used[g.id]))]), '每月用了预算的几成'),
      h('p', { class: 'muted small' }, '预算按每个月记账的天数折算。'))) : null;

  // 花在哪：全年的环形 + 每个月按块分的堆叠柱
  const groups = GROUPS.filter((g) => y.st.byGroup[g.id]);
  const s5 = repSection('花在哪',
    spendDonut(y.st, groups, { sub: '这一年', title: '钱花在哪了' }),
    noneRows(noneSplit(d, y.st.tx)),
    stackedBars(y.months.map((m) => ({ label: monthLabel(m), parts: m.active ? GROUPS.map((g) => ({ v: m.byGroup[g.id], color: g.color })) : [] })), { title: '每个月花在哪' }),
    repDetail(
      repTable(['月', ...groups.map((g) => g.name), '合计'], [
        ...active.map((m) => [`${m.m}月`, ...groups.map((g) => exact(m.byGroup[g.id])), exact(m.total)]),
        { cells: ['全年', ...groups.map((g) => exact(y.st.byGroup[g.id])), exact(key.total)], cls: 'total' },
      ], '每月各块花了多少'),
      repTable(['类别', '金额', '笔数', '占比'], y.cats.slice(0, 20).map((x) => [x.name, exact(x.v), String(x.n), repPct(x.share)]), '花得最多的类别'),
      y.top.length ? repTable(['最大的几笔', ''], y.top.map((t) => [`${md(t.date)} ${txTitle(t)}${t.note ? `（${t.note}）` : ''}`, exact(cny(t))]), '最大的几笔') : null));

  // 日历：一年 365 格
  const s6 = repSection('日历',
    yearCalendar(y.calendar, { today: today(), title: '这一年每天的生活花销' }));

  // 附注（只在 PDF 里）
  const nt = y.notes;
  const noteRows = [
    nt.wishesBought.length ? ['实现的心愿', exact(nt.wishesBought.reduce((a, x) => a + x.v, 0)), nt.wishesBought.map((x) => x.name).join('、')] : null,
    nt.subs.length ? ['订阅一共', exact(nt.subs.reduce((a, x) => a + x.v, 0)), nt.subs.map((x) => `${x.name} ${exact(x.v)}`).join('、')] : null,
    nt.taxRefund ? ['退税', exact(nt.taxRefund), ''] : null,
    nt.lumps.length ? ['一次性的钱', exact(nt.lumps.reduce((a, x) => a + x.v, 0)), '不算收入，直接进存款'] : null,
    nt.fromSaved.length ? ['用以前留好的钱花的', exact(nt.fromSaved.reduce((a, x) => a + x.v, 0)), nt.fromSaved.map((x) => `${x.name} ${exact(x.v)}`).join('、')] : null,
    nt.milestones.length ? ['里程碑', '', nt.milestones.map((x) => `${md(x.at)} ${x.text}`).join('、')] : null,
    ['记账', `${nt.days} 天`, `共 ${nt.span} 天`],
  ].filter(Boolean);
  const notes = h('section', { class: 'card rep-sec rep-detail' }, h('h3', {}, '附注'), repTable(['项目', '金额'],
    noteRows.map(([name, v, why]) => [h('span', {}, name, why ? h('span', { class: 'muted small block' }, why) : null), v]), '附注'));

  return h('div', { class: 'report' }, head, seg, nav, top, s1, s2, s3, s4, s5, s6, yearLetterCard(y), notes, exports);
}

// AI 年度点评：这一年过完，打开去年的年度报表时自动写一次；更早的点一下再写。存在 data.letters['2026']
const yearLetterState = { busy: {}, error: {} };
async function writeYearLetter(y) {
  const d = store.data;
  const k = y.key;
  const lines = [
    `${y.year} 年（${y.from} 到 ${y.to}${y.from > `${y.year}-01-01` ? '，这一年中间开始记账' : ''}）。`,
    `收入 ${Math.round(k.income)}，花销 ${Math.round(k.total)}，存下 ${Math.round(k.saved)}${k.savingRate != null ? `，储蓄率 ${Math.round(k.savingRate * 100)}%` : ''}。`,
    `净资产 ${Math.round(y.startNW.net)} → ${Math.round(y.endNW.net)}。${y.planAll ? `计划存 ${Math.round(y.planAll)}。` : ''}`,
    `每个月存下：${y.months.filter((m) => m.active).map((m) => `${m.m}月 ${Math.round(m.saved)}`).join('，')}。`,
    `各块花销：${GROUPS.filter((g) => y.st.byGroup[g.id]).map((g) => `${g.name} ${Math.round(y.st.byGroup[g.id])}`).join('，')}。`,
    `超预算的月份：${GROUPS.filter((g) => d.budget?.[g.id]).map((g) => { const over = y.months.filter((m) => m.active && m.used[g.id] > 1).map((m) => `${m.m}月`); return over.length ? `${g.name}（${over.join('、')}）` : null; }).filter(Boolean).join('；') || '没有'}。`,
    `花得最多的类别：${y.cats.slice(0, 6).map((x) => `${x.name} ${Math.round(x.v)}`).join('、')}。`,
    `实现的心愿：${y.notes.wishesBought.map((x) => x.name).join('、') || '无'}。里程碑：${y.notes.milestones.map((x) => x.text).join('、') || '无'}。记了 ${y.notes.days} 天账。`,
  ].join('\n');
  const system = [
    '你是一个大学生的理财小伙伴。他对理财不太懂，在认真地学着记账、稳定存钱。',
    '一年结束了，你根据下面这一年的汇总数字给他写一段年度点评：200～350 字，大白话，温和真诚，可以分两三段。',
    '先具体地说这一年做得好的一两件事（用数字），再说一两个值得留意的规律（比如哪几个月花得多、哪一块常超），最后给新的一年一两条容易做到的建议。',
    '不说教，不吓唬人，不推荐任何理财产品，数字只用给你的，不要编。不要用「亲爱的」这类称呼，不要署名，不用「你值得」「加油」这类话。',
    '只输出 JSON：{"letter":""}',
  ].join('\n');
  const out = await askJson(await aiConfig(), system, lines, { maxTokens: 6000, timeout: 120000 });
  const text = String(out.letter || '').trim();
  if (!text) throw new Error('AI 没写出来，等会儿再试');
  await save(`年度点评：${y.year} 年`, (data) => { data.letters = { ...(data.letters || {}), [String(y.year)]: { at: today(), text } }; });
}
function yearLetterCard(y) {
  const d = store.data;
  const k = String(y.year);
  if (y.ongoing) return h('section', { class: 'card rep-sec' }, h('h3', {}, 'AI 点评'), h('p', { class: 'muted small' }, '这一年过完以后，AI 会看着这份报表写几句。'));
  const letter = d.letters?.[k];
  const run = () => {
    if (yearLetterState.busy[k]) return;
    yearLetterState.busy[k] = true;
    yearLetterState.error[k] = '';
    writeYearLetter(y).catch((e) => { yearLetterState.error[k] = e.message; })
      .finally(() => { yearLetterState.busy[k] = false; if (/^\/summary/.test(currentPath())) render(); });
  };
  const latest = y.year === Number(today().slice(0, 4)) - 1;
  if (!letter && latest && !yearLetterState.busy[k] && !yearLetterState.error[k]) setTimeout(run);
  return h('section', { class: 'card letter rep-sec' },
    h('h3', {}, 'AI 点评'),
    letter ? [String(letter.text).split(/\n+/).filter(Boolean).map((t) => h('p', { class: 'letter-text' }, t)),
      h('button', { class: 'link small', onclick: () => { delete d.letters[k]; run(); render(); } }, '再写一次')]
      : yearLetterState.busy[k] || (latest && !yearLetterState.error[k]) ? h('p', { class: 'muted small' }, 'AI 正在写……')
        : [yearLetterState.error[k] ? h('p', { class: 'small warn-text' }, yearLetterState.error[k]) : null,
          h('button', { class: 'secondary', onclick: run }, '让 AI 写一段')]);
}

const YEAR_ASK = `我是一个大学生，在认真学着记账、稳定存钱。下面是我一整年的财务报表：每个月的收支、存钱计划完成得怎么样、家底的变化、每一块预算每个月用了多少、钱花在哪，还有附注。
请你：
1. 用大白话总结这一年；
2. 找出一年里的规律：哪几个月花得多、为什么，哪一块常常超预算；
3. 说说做得好的和可以改进的，要具体到数字；
4. 给新的一年定两三个具体、容易做到的目标。
不要推荐任何理财产品。`;

// Markdown 的小表格
function mdTable(L, cols, rows) {
  L.push(`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
  for (const r of rows.filter(Boolean)) L.push(`| ${r.join(' | ')} |`);
  L.push('');
}

function yearText(y) {
  const d = store.data;
  const k = y.key;
  const active = y.months.filter((m) => m.active);
  const L = [`# ${y.year} 年财务报表`, '', `${y.from} 到 ${y.to}${y.ongoing ? `，到 ${y.asOf} 为止（还没过完）` : ''}。按自然年、自然月算。金额是人民币，美元按今天的汇率折算。记了 ${y.notes.days} 天账。`, ''];
  L.push('## 这一年', '');
  mdTable(L, ['', ''], [['收入', exact(k.income)], ['支出', exact(k.total)], ['存下', repSigned(k.saved)], ['储蓄率', repPct(k.savingRate)],
    ['净资产', `${exact(y.startNW.net)} → ${exact(y.endNW.net)}`], y.planAll ? ['计划存', money(y.planAll)] : null]);
  L.push('## 每月收支', '');
  mdTable(L, ['月', '收入', '支出', '存下', '储蓄率', '月底净资产', '累计存下', '按计划累计'],
    active.map((m) => [`${m.m}月`, exact(m.income), exact(m.total), repSigned(m.saved), repPct(m.rate), exact(m.net), exact(m.cum), money(m.cumPlan)]));
  const groups = GROUPS.filter((g) => y.st.byGroup[g.id]);
  L.push('## 每月各块花销', '');
  mdTable(L, ['月', ...groups.map((g) => g.name)], active.map((m) => [`${m.m}月`, ...groups.map((g) => exact(m.byGroup[g.id]))]));
  const bGroups = GROUPS.filter((g) => Number(d.budget?.[g.id]) > 0);
  L.push('## 每月用了预算的几成', '');
  mdTable(L, ['月', ...bGroups.map((g) => g.name)], active.map((m) => [`${m.m}月`, ...bGroups.map((g) => repPct(m.used[g.id]))]));
  L.push('## 家底', '');
  mdTable(L, ['账户', '年初', '年底'], [...y.accounts.map((a) => [a.name + (a.usd ? '（美元）' : ''), exact(a.start), exact(a.end)]),
    ['别人欠我的', exact(y.startNW.toMe), exact(y.endNW.toMe)], ['我欠别人的', exact(y.startNW.iOwe), exact(y.endNW.iOwe)], ['**净资产**', exact(y.startNW.net), exact(y.endNW.net)]]);
  mdTable(L, ['用途', '年初', '年底'], y.purposes.map((x) => [x.name, minusMoney(x.start), minusMoney(x.end)]));
  L.push('## 花得最多的类别', '');
  mdTable(L, ['类别', '金额', '笔数', '占比'], y.cats.slice(0, 20).map((x) => [x.name, exact(x.v), String(x.n), repPct(x.share)]));
  if (y.top.length) { L.push('最大的几笔：'); for (const t of y.top) L.push(`- ${t.date} ${txTitle(t)} ${exact(cny(t))}${t.note ? `（${t.note}）` : ''}`); L.push(''); }
  const nt = y.notes;
  L.push('## 附注', '',
    ...[nt.wishesBought.length ? `实现的心愿：${nt.wishesBought.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
      nt.subs.length ? `订阅一共 ${exact(nt.subs.reduce((a, x) => a + x.v, 0))}：${nt.subs.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
      nt.taxRefund ? `退税：${exact(nt.taxRefund)}` : null,
      nt.lumps.length ? `一次性的钱（不算收入，直接进存款）：${nt.lumps.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
      nt.fromSaved.length ? `用以前留好的钱花的：${nt.fromSaved.map((x) => `${x.name} ${exact(x.v)}`).join('、')}` : null,
      nt.milestones.length ? `里程碑：${nt.milestones.map((x) => `${x.at} ${x.text}`).join('、')}` : null].filter(Boolean).map((x) => `- ${x}`), '');
  const letter = d.letters?.[String(y.year)];
  if (letter) L.push('## AI 点评', '', letter.text);
  return L.join('\n');
}

// Excel：年度报表一个总表 + 几张分表 + 每个月一张明细
function yearSheets(y) {
  const d = store.data;
  const k = y.key;
  const active = y.months.filter((m) => m.active);
  const groups = GROUPS.filter((g) => y.st.byGroup[g.id]);
  const bGroups = GROUPS.filter((g) => Number(d.budget?.[g.id]) > 0);
  const pct = (x) => (x == null ? '' : Math.round(x * 1000) / 10);
  const nt = y.notes;
  const sheets = [
    { name: '总览', rows: [
      ['项目', '金额'], ['收入', k.income], ['支出', k.total], ['存下', k.saved], ['储蓄率（%）', pct(k.savingRate)],
      ['净资产（开始）', y.startNW.net], ['净资产（结束）', y.endNW.net], ['计划存', y.planAll || ''], ['记账天数', nt.days], [],
      ['月', '收入', '支出', '存下', '储蓄率（%）', '月底净资产', '累计存下', '按计划累计'],
      ...active.map((m) => [`${m.m}月`, m.income, m.total, m.saved, pct(m.rate), m.net, m.cum, m.cumPlan]),
      ['全年', k.income, k.total, k.saved, pct(k.savingRate), k.net, '', ''],
    ] },
    { name: '每月各块花销', rows: [['月', ...groups.map((g) => g.name), '合计'], ...active.map((m) => [`${m.m}月`, ...groups.map((g) => m.byGroup[g.id]), m.total]),
      ['全年', ...groups.map((g) => Math.round(y.st.byGroup[g.id] * 100) / 100), k.total]] },
    { name: '预算用了几成', rows: [['月', ...bGroups.map((g) => `${g.name}（%）`)], ...active.map((m) => [`${m.m}月`, ...bGroups.map((g) => pct(m.used[g.id]))])] },
    { name: '类别', rows: [['类别', '金额', '笔数', '占比（%）'], ...y.cats.map((x) => [x.name, x.v, x.n, pct(x.share)])] },
    { name: '家底', rows: [['账户', '开始', '结束', '变化'], ...y.accounts.map((a) => [a.name + (a.usd ? '（美元）' : ''), a.start, a.end, Math.round((a.end - a.start) * 100) / 100]),
      ['别人欠我的', y.startNW.toMe, y.endNW.toMe, ''], ['我欠别人的', -y.startNW.iOwe, -y.endNW.iOwe, ''], ['净资产', y.startNW.net, y.endNW.net, k.netChange], [],
      ['用途', '开始', '结束', '变化'], ...y.purposes.map((x) => [x.name, x.start, x.end, Math.round((x.end - x.start) * 100) / 100])] },
    { name: '每天生活花销', rows: [['日期', '生活花销'], ...y.calendar.filter((x) => !x.off).map((x) => [x.day, x.v])] },
    { name: '附注', rows: [['项目', '金额', '说明'],
      ...nt.wishesBought.map((x) => ['实现的心愿', x.v, `${x.date} ${x.name}`]),
      ...nt.subs.map((x) => ['订阅', x.v, x.name]),
      ...(nt.taxRefund ? [['退税', nt.taxRefund, '']] : []),
      ...nt.lumps.map((x) => ['一次性的钱', x.v, `${x.date} ${x.name}`]),
      ...nt.milestones.map((x) => ['里程碑', '', `${x.at} ${x.text}`])] },
  ];
  for (const m of active) {
    const tx = d.tx.filter((t) => t.date >= m.from && t.date <= m.to).sort((a, b) => a.date.localeCompare(b.date));
    sheets.push({ name: `${m.m}月`, rows: [TX_HEAD, ...tx.map(txExcelRow)] });
  }
  return sheets;
}

// Excel：月度报表
function monthSheets(r) {
  const d = store.data;
  const k = r.key;
  const pct = (x) => (x == null ? '' : Math.round(x * 1000) / 10);
  return [
    { name: '总览', rows: [
      ['项目', '本月', '上月'], ['收入', k.income, k.prev?.income ?? ''], ['支出', k.total, k.prev?.total ?? ''], ['存下', k.saved, k.prev?.saved ?? ''],
      ['储蓄率（%）', pct(k.savingRate), pct(k.prev?.savingRate)], ['净资产', k.net, ''], ['净资产变化', k.netChange, k.prev?.netChange ?? ''], [],
      ['收入来源', '本月', '上月'], ...r.income.map((x) => [x.name, x.v, x.prev ?? '']), [],
      ['支出', '本月', '上月'], ...r.spend.map((g) => [g.name, g.v, g.prev ?? '']),
    ] },
    { name: '家底', rows: [['账户', '月初', '月底', '变化'], ...r.accounts.map((a) => [a.name + (a.usd ? '（美元）' : ''), a.start, a.end, Math.round((a.end - a.start) * 100) / 100]),
      ['别人欠我的', r.startNW.toMe, r.endNW.toMe, ''], ['我欠别人的', -r.startNW.iOwe, -r.endNW.iOwe, ''], ['净资产', r.startNW.net, r.endNW.net, k.netChange], [],
      ['用途', '月初', '月底', '变化'], ...r.purposes.map((x) => [x.name, x.start, x.end, Math.round((x.end - x.start) * 100) / 100])] },
    { name: '预算', rows: [['', '预算', '实际', '用了（%）'], ...r.budget.map((x) => [x.name, x.budget, x.v, pct(x.pct)])] },
    { name: '类别', rows: [['类别', '金额', '笔数', '占比（%）', '上月'], ...r.cats.map((x) => [x.name, x.v, x.n, pct(x.share), x.prev ?? ''])] },
    { name: '每天生活花销', rows: [['日期', '生活花销'], ...r.calendar.days.filter((x) => !x.future && !x.before).map((x) => [x.day, x.v])] },
    { name: '明细', rows: [TX_HEAD, ...d.tx.filter((t) => t.date >= r.p.start && t.date <= r.asOf).sort((a, b) => a.date.localeCompare(b.date)).map(txExcelRow)] },
  ];
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

// 类别下拉：按预算大组分开
function categorySelect(value, onChange, label) {
  const cats = store.data.categories.filter((c) => c.kind === 'expense' && (!c.hidden || c.id === value) && !AUTO_CATEGORIES.includes(c.id));
  return h('select', { 'aria-label': label, value, onchange: (e) => onChange(e.target.value) },
    GROUPS.map((g) => {
      const list = cats.filter((c) => c.group === g.id);
      return list.length ? h('optgroup', { label: g.name }, list.map((c) => h('option', { value: c.id }, c.name))) : null;
    }));
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
            b, category: guessBillCategory(b, cats, d.tx),
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
// 心愿单排序：只改显示（大额心愿按点「开始攒」的先后一个一个攒，和排序无关）
const NEED_CLASS = { 需要: 'good-text', 想要: 'soon', 说不准: 'muted' };

function wishHelp(d) {
  const big = money(d.settings.wishBigFrom);
  return [
    ['心愿单是什么', ['想买、但不急，有闲钱才买的东西。先放进来，冷静几天再决定。', `${big} 以内是小额心愿，超过 ${big} 是大额心愿。`]],
    ['心愿基金', ['每个预算月结束时，吃饭 + 日常 + 自由钱 + 形象没花完的，自动进心愿基金。',
      d.settings.sideIncomeSave != null ? `兼职收入的 ${Math.round((1 - d.settings.sideIncomeSave) * 100)}% 也进心愿基金（记兼职收入时就算进来）。` : '',
      '每次进账，1/3 给正在攒的大额心愿，2/3 进「能随便用」。没有正在攒的，全部进「能随便用」。',
      `「能随便用」最多攒到 ${money(WISH_CAP)}，满了以后再进来的不进心愿基金，算成存款（进自由存款）。对账页的数额计算会告诉你从生活费卡转多少回存钱卡。`,
      `哪个月超支了（或者专项、看病花超了），先从「能随便用」里扣，扣到只剩 ${money(WISH_KEEP)} 为止，再不够的由存款补。给大额心愿攒着的钱不扣。`,
      '心愿只花省下来的钱，存款一分不动。钱实际在生活费卡里。'].filter(Boolean)],
    ['小额心愿', [`${big} 以内。用「能随便用」的钱买，不够的部分算进这个月的自由钱。`]],
    ['记账时直接用', ['小东西不想先放进心愿单，记账时打开「用心愿基金的钱」就行：类别照常选，这笔从心愿基金出，不占这个月的预算。心愿基金不够这一笔时记不了。']],
    ['清单', ['一行一个心愿：名字、价格，下面一句现在怎么样。能买的排在最上面，然后是正在攒的，最后是冷静中、排队的。', '点一个心愿，看详情（想要程度、分类、为什么想要、AI 的看法），买了、开始攒、改、不想要了都在那里。']],
    ['上面的大字', ['是现在能用的钱。给大额心愿攒着的不算在里面。点「来源」看这些钱是怎么来的。']],
    ['大额心愿', ['放进来时只在单子上，不攒钱。确定真的要买了，点「开始攒」，从「能随便用」里拿 ¥100 放进去，之后每次进账分 1/3 给它。',
      `「能随便用」不到 ${money(WISH_SEED)} 时不能开始。一次只攒一个：正在攒一个时再点别的，它排队，轮到它时再拿那 ¥100。`,
      '攒够了才能买，没攒够不买，存款不动。实际比攒的便宜，多的退回「能随便用」。', '不想要了，攒的钱全部退回「能随便用」。']],
    ['放下的心愿', ['点「不想要了」的心愿放在最下面那一行里（点开看），这个预算月里点「放回来」就回到心愿单。', '到了下个预算月就清掉，不留记录。', '大额心愿放回来，要重新点「开始攒」。']],
    ['实现了的', ['买了的心愿都记着，最下面「实现了 N 个」那一行点开能看到买了什么、哪天、多少钱。']],
    ['预下单', ['点清单下面的「挑几个算一算」，在心愿上打勾，看看一起买要多少钱、心愿基金还剩多少。选好的会存下来，手机电脑都能看到。',
      '价格可以改成实际要付的（比如有优惠），只用来算账，不改心愿本身。',
      '小额的从「能随便用」出，超出的算进这个月的自由钱；大额的只有攒够了才能买。',
      '买好了点「都买了」，没买成的取消勾选，会留在预下单里。']],
    ['冷静期', [`新加的心愿先冷静 ${d.settings.coolDays} 天。过了几天还想要，再考虑买。`]],
    ['买了以后', ['点「买了」，钱从心愿基金或攒好的那份里出，记一笔「心愿」花销，不占当月预算。', '钱一直在你的卡里，网站只是记着这里面有多少是给心愿的，不用转账。']],
    ['AI 建议', ['点清单下面的「AI 看看」，再点「问问 AI」：先买哪个、什么时候买、真需要还是一时想要。每个心愿的看法在点开的详情里。它查不到实时价格，价格以你填的为准。']],
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

let wishPicking = false; // 心愿单是不是在打勾挑预下单（只在内存）
const cartPrice = (x) => Number(x.c.price ?? x.w.price);

// 预下单算账：小额从心愿基金出，超出的算这个月的自由钱；大额用各自攒的
function cartMath(d, cart, f, plan, t) {
  const small = cart.filter((x) => !isBigWish(d, x.w));
  const smallTotal = round2(small.reduce((s, x) => s + cartPrice(x), 0));
  const over = round2(Math.max(0, smallTotal - f.small));
  const cp = periodFor(d, t);
  const freeLeft = (Number(d.budget?.free) || 0) * partial(d, cp).factor - periodStats(d, cp).spent.free;
  const big = cart.filter((x) => isBigWish(d, x.w)).map((x) => {
    const saved = plan.find((y) => y.w.id === x.w.id)?.saved || 0;
    return { x, saved, short: round2(Math.max(0, cartPrice(x) - saved)) };
  });
  return {
    small, smallTotal, over, big, fundAfter: round2(Math.max(0, f.small - smallTotal)), freeAfter: round2(freeLeft - over),
    total: round2(cart.reduce((s, x) => s + cartPrice(x), 0)), cooling: cart.filter((x) => coolingLeft(d, x.w, t)).length,
  };
}

// 从哪个账户付：默认上次用的
function accountChips(d) {
  let acc = readJson(LAST_KEY).account;
  if (!account(d, acc)) acc = d.accounts[0]?.id;
  const box = h('div', { class: 'chips', role: 'group', 'aria-label': '从哪个账户付' });
  const draw = () => box.replaceChildren(...d.accounts.map((a) => h('button', {
    type: 'button', class: `chip${a.id === acc ? ' on' : ''}`, 'aria-pressed': String(a.id === acc), onclick: () => { acc = a.id; draw(); },
  }, a.name)));
  draw();
  return { box, get: () => acc };
}

// 预下单「都买了」：整单一个账户；没买成的取消勾选，留在预下单里
function buyCart(cart) {
  const d = store.data;
  const t = today();
  const plan0 = bigWishPlan(d, t);
  const short = (x) => isBigWish(d, x.w) && (plan0.find((y) => y.w.id === x.w.id)?.saved || 0) < cartPrice(x);
  const picked = new Set(cart.filter((x) => !short(x)).map((x) => x.w.id));
  const acc = accountChips(d);
  const hint = h('div', { class: 'small' });
  const drawHint = () => {
    const f = wishFunds(d, t);
    const c = cartMath(d, cart.filter((x) => picked.has(x.w.id)), f, bigWishPlan(d, t), t);
    hint.replaceChildren(...[
      h('p', {}, h('b', {}, `共 ${money(c.total)}`)),
      c.small.length ? h('p', { class: 'muted' }, c.over > 0 ? `心愿基金 ${money(f.small)} 用完，超出的 ${money(c.over)} 算进这个月的自由钱。` : `从心愿基金出，还剩 ${money(c.fundAfter)}。`) : null,
      c.over > 0 && c.freeAfter < 0 ? h('p', { class: 'soon' }, `这个月自由钱会超 ${money(-c.freeAfter)}。`) : null,

      c.cooling ? h('p', { class: 'muted' }, `其中 ${c.cooling} 个还在冷静期。`) : null].filter(Boolean));
  };
  drawHint();
  const rows = cart.map((x) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked: !short(x), disabled: short(x), onchange: (e) => { if (e.currentTarget.checked) picked.add(x.w.id); else picked.delete(x.w.id); drawHint(); } }),
    h('span', { class: 'grow' }, x.w.name, short(x) ? h('span', { class: 'muted small block' }, '还没攒够，先不能买') : null), h('b', {}, money(cartPrice(x)))));
  openSheet({
    title: '都买了',
    body: h('div', { class: 'form' },
      h('p', { class: 'small muted' }, '没买成的取消勾选，会留在预下单里。'), rows, hint,
      h('div', { class: 'label-sm' }, '从哪个账户付'), acc.box),
    confirmText: '记好了',
    onConfirm: async () => {
      const bought = cart.filter((x) => picked.has(x.w.id));
      if (!bought.length) { toast('勾上买了的', 'error'); return false; }
      const a = acc.get();
      const usd = isUsd(d, a);
      const rate = usdRate();
      const total = round2(bought.reduce((s, x) => s + cartPrice(x), 0));
      try {
        await save(`预下单都买了：${bought.map((x) => x.w.name).join('、')} ${total}`, (data) => {
          const now = new Date().toISOString();
          let fund = Math.max(0, wishFunds(data, today()).small);
          const mk = (x, amount, cat, big) => ({ id: newId('t'), type: 'expense', date: today(), account: a, amount, category: cat, note: x.w.name,
            wish: x.w.id, wishKind: big ? 'big' : 'small', createdAt: now, ...(usd ? { cny: round2(amount * rate) } : {}) });
          for (const x of bought) {
            const n = cartPrice(x);
            const big = isBigWish(data, x.w);
            // 和单个「买了」一样：小额超出基金的部分算自由钱，大额全部算「心愿」
            const fromFund = big ? n : round2(Math.min(n, fund));
            if (!big) fund = round2(fund - fromFund);
            if (fromFund > 0) data.tx.push(mk(x, fromFund, 'c-wish', big));
            if (n - fromFund > 0) data.tx.push(mk(x, round2(n - fromFund), 'c-like', big));
            Object.assign(data.wishes.find((w) => w.id === x.w.id), { status: 'bought', boughtAt: today(), boughtPrice: n });
          }
          data.wishCart = data.wishCart.filter((c) => !picked.has(c.id));
        });
        if (!cart.some((x) => !picked.has(x.w.id))) wishPicking = false;
        toast(`恭喜，${bought.length} 个心愿到手了`);
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
      ? (n > fundLeft ? `给它攒了 ${money(fundLeft)}，还差 ${money(n - fundLeft)}，攒够了才能买。` : `用攒好的钱买${fundLeft > n ? `，多的 ${money(fundLeft - n)} 退回心愿基金` : ''}。`)
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
      if (big && n > fundLeft) { toast('攒的钱还不够，先不买', 'error'); return false; }
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
          data.wishCart = data.wishCart.filter((c) => c.id !== w.id);
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
    '他有一个心愿单：想买但不急、有闲钱才买的东西。心愿只花「心愿基金」（每月生活预算省下来的钱），不动存款。小额心愿直接用心愿基金买；大额心愿要他确定要买了才「开始攒」，每次心愿基金进账分 1/3 给它，一次只攒一个，攒够了才能买。',
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
    `心愿基金：能随便用 ${money(f.small)}，给大额心愿攒着 ${money(f.envTotal)}。小额 / 大额的分界：${money(d.settings.wishBigFrom)}。`,
    `这个预算月生活预算还剩 ${money(Math.max(0, hl.left))}，还有 ${hl.daysLeft} 天。安全垫 ${hl.items.find((x) => x.key === 'cushion')?.value || ''}。`,
    recent.length ? `最近几个预算月：${recent.join('；')}` : '刚开始记账，还没有完整的预算月。',
    d.settings.summerMonths?.length ? `${d.settings.summerMonths.join('、')} 月没有收入。` : '',
    (await inventoryContext()).trim(),
    '心愿单（id | 名称 | 价格 | 小额/大额 | 想要程度 | 分类 | 为什么想要 | 加进来几天 | 已攒 | 攒钱状态 | 想在什么时候前买到）：',
    ...open.map((w) => {
      const big = isBigWish(d, w);
      const pl = plan.find((x) => x.w.id === w.id);
      return [w.id, w.name, w.price, big ? '大额' : '小额', WANT[w.want] || '', WISH_KIND[w.kind] || '-', w.reason || '-', daysSince(w.createdAt),
        big ? pl?.saved ?? 0 : '-', big ? { idle: '还没开始攒', waiting: '排队中', saving: pl.eta ? `正在攒，大约 ${pl.eta} 个月攒够` : '正在攒', ready: '攒够了' }[pl.state] : '-', w.targetDate || '-'].map((x) => String(x).replace(/\|/g, '/')).join(' | ');
    }),
  ].filter(Boolean).join('\n');
  btn.disabled = true;
  btn.textContent = 'AI 正在想……';
  try {
    const out = await askJson(ai, system, user, { maxTokens: 6000, timeout: 120000 });
    const ids = new Set(open.map((w) => w.id));
    const advice = {
      at: t, summary: String(out.summary || ''),
      order: (out.order || []).filter((id) => ids.has(id)),
      items: Object.fromEntries((out.items || []).filter((x) => ids.has(x.id)).map((x) => [x.id, { when: String(x.when || ''), need: String(x.need || ''), comment: String(x.comment || '') }])),
    };
    await save('心愿单：AI 建议', (data) => { data.wishAdvice = advice; });
    render();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = '问问 AI';
    return false;
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
  const bought = d.wishes.filter((w) => w.status === 'bought').reverse();
  const dropped = d.wishes.filter((w) => w.status === 'dropped').reverse();
  const upd = (message, fn) => save(message, fn).then(render).catch(() => {});

  // 预下单：选了哪些、改过的价格（存在 data.wishCart）
  const cart = (d.wishCart || []).map((c) => ({ c, w: open.find((w) => w.id === c.id) })).filter((x) => x.w);
  const cartIds = new Set(cart.map((x) => x.w.id));
  const calc = cartMath(d, cart, f, plan, t);
  const toggleCart = (id) => upd('预下单：选心愿', (data) => {
    data.wishCart ||= [];
    if (data.wishCart.some((c) => c.id === id)) data.wishCart = data.wishCart.filter((c) => c.id !== id);
    else data.wishCart.push({ id });
  });
  const setCartPrice = (x, input) => {
    const n = round2(Number(input.value.replace(/[，,\s¥]/g, '')));
    if (!(n > 0)) { input.value = String(cartPrice(x)); toast('填一下价格', 'error'); return; }
    upd('预下单：改价格', (data) => {
      const c = data.wishCart.find((y) => y.id === x.w.id);
      if (!c) return false;
      if (n === Number(x.w.price)) delete c.price; else c.price = n;
    });
  };
  const cartCard = () => {
    if (!cart.length) return h('div', { class: 'card cart' }, h('h3', {}, '预下单'), h('p', { class: 'muted small' }, '在下面的心愿上打勾，选好的会放在这里，帮你算一起买要多少钱。'));
    const row = (x) => h('div', { class: 'cart-row' },
      h('span', { class: 'grow' }, x.w.name, h('span', { class: 'muted small block' }, [isBigWish(d, x.w) ? '大额' : '小额', coolingLeft(d, x.w, t) ? '冷静中' : '', x.c.price != null ? `原价 ${money(x.w.price)}` : ''].filter(Boolean).join(' · '))),
      h('label', { class: 'cart-price' }, '¥', h('input', { inputmode: 'decimal', value: String(cartPrice(x)), 'aria-label': `${x.w.name}的价格`, onchange: (e) => setCartPrice(x, e.currentTarget) })),
      h('button', { class: 'link', 'aria-label': `${x.w.name}不选了`, onclick: () => toggleCart(x.w.id) }, '×'));
    return h('div', { class: 'card cart' },
      h('h3', {}, '预下单'),
      cart.map(row),
      h('div', { class: 'cart-sum' },
        calc.small.length ? [
          h('div', { class: 'cart-line' }, h('span', {}, `小额 ${calc.small.length} 个`), h('b', {}, money(calc.smallTotal))),
          h('div', { class: 'cart-line' }, h('span', {}, '心愿基金'), h('b', {}, `${money(f.small)} → ${money(calc.fundAfter)}`)),
          calc.over > 0 ? h('p', { class: `small ${calc.freeAfter < 0 ? 'soon' : 'muted'}` },
            `超出 ${money(calc.over)}，算进这个月的自由钱（${calc.freeAfter < 0 ? `自由钱会超 ${money(-calc.freeAfter)}` : `自由钱还剩 ${money(calc.freeAfter)}`}）`) : null] : null,
        calc.big.map((b) => h('div', { class: 'cart-line' }, h('span', {}, b.x.w.name),
          h('b', { class: b.short > 0 ? '' : 'good-text' }, b.short > 0 ? `攒了 ${money(b.saved)}，还差 ${money(b.short)}` : `攒了 ${money(b.saved)}，够了`))),
        calc.big.some((b) => b.short > 0) ? h('p', { class: 'muted small' }, '没攒够的大额心愿先不能买，存款不动。') : null,
        calc.cooling ? h('p', { class: 'muted small' }, `其中 ${calc.cooling} 个还在冷静期`) : null),
      h('div', { class: 'wish-actions' },
        h('button', { class: 'link', onclick: () => upd('预下单：清空', (data) => { data.wishCart = []; }) }, '清空'),
        h('span', { class: 'grow' }),
        h('button', { class: 'small', onclick: () => buyCart(cart) }, '都买了')));
  };

  const startSaving = (w) => upd(`开始攒：${w.name}`, (data) => { data.wishes.find((x) => x.id === w.id).saveStart = today(); });
  const unqueue = (w) => upd(`不排了：${w.name}`, (data) => { delete data.wishes.find((x) => x.id === w.id).saveStart; });
  const drop = (w) => {
    const back = f.env[w.id] || 0;
    saveUndoable(`放弃心愿：${w.name}`, (data) => { Object.assign(data.wishes.find((x) => x.id === w.id), { status: 'dropped', droppedAt: today() }); data.wishCart = data.wishCart.filter((c) => c.id !== w.id); },
      back ? `「${w.name}」不要了，攒的 ${money(back)} 退回心愿基金` : `「${w.name}」放下了，这个月里还能放回来`).then(render).catch(() => {});
  };

  // 每个心愿现在的状态：一句话 + 排在哪（能买的 → 正在攒的 → 冷静中 / 排队的 / 差钱的）
  const status = (w) => {
    const isBig = isBigWish(d, w);
    const pl = isBig ? plan.find((x) => x.w.id === w.id) : null;
    const cooling = coolingLeft(d, w, t);
    const ready = isBig ? pl.state === 'ready' : f.small >= w.price;
    let text;
    let tone = '';
    if (isBig) {
      if (pl.state === 'ready') { text = '攒够了，可以买了'; tone = 'good'; }
      else if (pl.state === 'saving') { text = `正在攒 · ${money(pl.saved)} / ${money(w.price)}`; tone = 'accent'; }
      else if (pl.state === 'waiting') text = !f.saving && f.small < WISH_SEED ? `等心愿基金到 ${money(WISH_SEED)}` : `排队第 ${pl.pos} 个`;
      else text = '还没开始攒';
      if (cooling) text += ` · 冷静中，还剩 ${cooling} 天`;
    } else if (cooling) text = `冷静中，还剩 ${cooling} 天`;
    else if (ready) { text = '可以买了'; tone = 'good'; }
    else text = `心愿基金还差 ${money(w.price - f.small)}`;
    const rank = ready && !cooling ? 0 : isBig && pl.state === 'saving' ? 1 : 2;
    return { isBig, pl, cooling, ready, text, tone, rank };
  };
  const sorted = open.map((w, i) => ({ w, i, r: status(w).rank })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.w);

  // 点一个心愿：从下面弹出详情，按钮只放现在该按的
  const wishSheet = (w) => {
    const s = status(w);
    const { isBig, pl } = s;
    const a = adv?.items?.[w.id];
    const rank = adv?.order?.indexOf(w.id) ?? -1;
    const canStart = f.saving || f.small >= WISH_SEED;
    const lateFor = isBig && w.targetDate && pl.eta && addDays(t, Math.round(pl.eta * 30.4)) > w.targetDate;
    let close = () => {};
    const act = (fn) => () => { close(); fn(); };
    const info = [['想要程度', WANT[w.want]], ['分类', WISH_KIND[w.kind]], ['为什么想要', w.reason], ['想在这天前买到', w.targetDate ? md(w.targetDate) : ''],
      ['放进来', w.createdAt ? md(w.createdAt) : ''], ['链接', w.link ? (/^https?:\/\//.test(w.link) ? h('a', { href: w.link, target: '_blank', rel: 'noopener' }, '打开') : w.link) : '']].filter(([, v]) => v);
    const body = h('div', { class: 'wish-detail' },
      h('div', { class: 'wd-price' }, money(w.price), h('span', { class: 'muted small' }, isBig ? ' · 大额心愿' : ' · 小额心愿')),
      h('p', { class: `wish-status ${s.tone}` }, [cartIds.has(w.id) ? '准备买' : '', s.text].filter(Boolean).join(' · ')),
      isBig && (pl.state === 'saving' || pl.state === 'ready') ? [bar(pl.saved / w.price, 'var(--accent)'),
        pl.eta ? h('p', { class: 'muted small wd-eta' }, `按最近每月进账，大约 ${pl.eta} 个月攒够`) : null] : null,
      isBig && pl.state === 'idle' ? h('p', { class: 'muted small' }, '确定真的要买了，再点「开始攒」。') : null,
      lateFor ? h('p', { class: 'small soon' }, `${md(w.targetDate)}前可能攒不够`) : null,
      info.length ? h('div', { class: 'wd-info' }, info.map(([k, v]) => [h('span', { class: 'muted' }, k), h('span', {}, v)])) : null,
      a ? h('div', { class: 'wish-ai' },
        rank >= 0 ? h('div', { class: 'muted small' }, `AI 建议先后：第 ${rank + 1} 个`) : null,
        a.need ? h('span', { class: `need ${NEED_CLASS[a.need] || ''}` }, a.need) : null,
        a.when ? h('div', {}, h('b', {}, '什么时候买：'), a.when) : null,
        a.comment ? h('div', {}, a.comment) : null) : null,
      h('div', { class: 'wd-actions' },
        !isBig || s.ready ? h('button', { onclick: act(() => buyWish(w, isBig ? pl.saved : f.small)) }, '买了') : null,
        isBig && pl.state === 'idle' ? h('button', { disabled: !canStart, onclick: act(() => startSaving(w)) },
          !canStart ? `心愿基金到 ${money(WISH_SEED)} 就能开始` : f.saving ? '排队攒' : '开始攒') : null,
        h('div', { class: 'wd-links' },
          isBig && pl.state === 'waiting' ? h('button', { class: 'link', onclick: act(() => unqueue(w)) }, '不排了') : null,
          h('button', { class: 'link', onclick: act(() => wishForm(w)) }, '改'),
          h('button', { class: 'link', onclick: act(() => drop(w)) }, '不想要了'))));
    close = openSheet({ title: w.name, body, confirmText: null, cancelText: '关上', onConfirm: () => {} });
  };

  const row = (w) => {
    const s = status(w);
    const inCart = cartIds.has(w.id);
    const showBar = s.isBig && (s.pl.state === 'saving' || s.pl.state === 'ready');
    return h('div', {
      class: `wish${wishPicking && inCart ? ' picked' : ''}`, role: wishPicking ? null : 'button', tabindex: wishPicking ? null : '0',
      onclick: (e) => { if (wishPicking) { if (e.target.type !== 'checkbox') toggleCart(w.id); } else wishSheet(w); },
      onkeydown: (e) => { if (!wishPicking && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); wishSheet(w); } },
    },
      h('div', { class: 'wish-line' },
        wishPicking ? h('input', { type: 'checkbox', class: 'wish-check', checked: inCart, 'aria-label': `选上${w.name}`, onchange: () => toggleCart(w.id) }) : null,
        h('span', { class: 'wish-name' }, w.name),
        h('span', { class: 'wish-price' }, money(w.price))),
      h('div', { class: `wish-status ${s.tone}` }, inCart && !wishPicking ? h('span', { class: 'accent-text' }, '准备买 · ') : null, s.text),
      showBar ? bar(s.pl.saved / w.price, 'var(--accent)') : null);
  };

  // 心愿基金的来源：点「来源」才看
  const fundRows = [['生活费省下', f.parts.saved], ['兼职收入', f.parts.jobs], ['超支扣回', f.parts.over], ['帮专项和看病补', f.parts.cover], ['花掉的', f.parts.spent], [`满 ${money(WISH_CAP)} 后转进存款`, f.parts.toFree],
    ['攒给大额心愿', -f.envTotal]].filter(([, v]) => v);
  const sign = (v) => `${v > 0 ? '+' : ''}${money(v)}`;
  const fundSheet = () => openSheet({
    title: '心愿基金从哪来',
    body: h('div', {},
      fundRows.length ? h('div', { class: 'fund-rows' }, fundRows.map(([k, v]) => [h('span', {}, k), h('b', {}, sign(v))]))
        : h('p', { class: 'muted small' }, `${md(periodFor(d, t).end)}以后，这个月没花完的会进来`),
      bigSaving.length ? h('p', { class: 'muted small fund-split' }, `另外 ${bigSaving.map((x) => `${money(x.saved)} 攒给「${x.w.name}」`).join('、')}，不算在能用的里面`) : null),
    confirmText: null, cancelText: '关上', onConfirm: () => {},
  });
  const bigSaving = plan.filter((x) => x.saved > 0);
  const togglePick = () => { wishPicking = !wishPicking; render(); };
  const history = [bought.length ? `实现了 ${bought.length} 个` : '', dropped.length ? `放下 ${dropped.length} 个` : ''].filter(Boolean).join(' · ');
  return h('div', {},
    header('心愿单', h('button', { class: 'icon-btn', 'aria-label': '加一个心愿', onclick: () => wishForm() }, icon('plus')), helpButton('心愿单怎么用', wishHelp(d))),
    h('div', { class: 'card wish-fund' },
      h('div', { class: 'grow' }, h('div', { class: 'muted small' }, '心愿基金 · 现在能用'), bigMoney(f.small)),
      h('button', { class: 'link small', onclick: fundSheet }, '来源 ›')),
    cart.length || wishPicking ? cartCard() : null,
    open.length ? h('div', { class: 'card wish-list' }, sorted.map(row))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有心愿。想买但不急的东西，点右上角 ＋ 放进来。')),
    open.length ? h('div', { class: 'wish-links' },
      h('button', { class: 'link', onclick: togglePick }, wishPicking ? '挑好了' : cart.length ? `预下单 · ${cart.length} 个` : '挑几个算一算 ›'),
      h('button', { class: 'link', onclick: () => wishAiSheet() }, adv ? `AI 建议 · ${md(adv.at)} ›` : 'AI 看看 ›')) : null,
    history ? h('details', { class: 'card wish-history' }, h('summary', {}, history),
      dropped.length ? h('div', { class: 'wish-dropped' },
        h('div', { class: 'label-sm' }, '这个月放下的'),
        h('p', { class: 'muted small' }, `${md(periodFor(d, t).end)}以后就清掉了，在那之前还能放回来。`),
        dropped.map((w) => h('div', { class: 'manage-row' },
          h('span', { class: 'grow' }, w.name, h('span', { class: 'muted small block' }, `${md(w.droppedAt || w.createdAt)}放下 · ${money(w.price)}`)),
          h('button', { class: 'link', onclick: () => upd(`放回来：${w.name}`, (data) => restoreWish(data, w.id, t)) }, '放回来')))) : null,
      bought.length ? h('div', { class: 'wish-done' },
        h('div', { class: 'label-sm' }, '实现了'),
        bought.map((w) => h('div', { class: 'manage-row' },
          h('span', { class: 'grow' }, w.name, h('span', { class: 'muted small block' }, `${md(w.boughtAt)}买的 · ${money(w.boughtPrice)}`))))) : null) : null,
    wishPicking ? h('div', { class: 'actions sticky cart-bar' },
      h('div', { class: 'grow' }, h('b', {}, cart.length ? `选了 ${cart.length} 个 · 共 ${money(calc.total)}` : '还没选'),
        cart.length ? h('div', { class: `small ${calc.over > 0 ? 'soon' : 'muted'}` }, calc.small.length ? (calc.over > 0 ? `心愿基金不够，超出 ${money(calc.over)}` : `买完心愿基金剩 ${money(calc.fundAfter)}`) : '都是大额心愿，用各自攒的钱') : null),
      h('button', { class: 'small', onclick: togglePick }, '挑好了')) : null);
}

// 心愿单的 AI 建议：总的一句 + 先后顺序；问完了重新打开这一页看新的
function wishAiSheet() {
  const d = store.data;
  const adv = d.wishAdvice;
  const open = d.wishes.filter((w) => w.status === 'open');
  const order = adv ? (adv.order || []).map((id) => open.find((w) => w.id === id)).filter(Boolean) : [];
  let close = () => {};
  const btn = h('button', { class: 'secondary wide', onclick: async () => { if (await askWishAdvice(btn)) { close(); wishAiSheet(); } } },
    icon('sparkle'), adv ? '再问一次 AI' : '问问 AI');
  close = openSheet({
    title: 'AI 建议',
    body: h('div', { class: 'wish-ai-sheet' },
      adv ? [h('p', { class: 'muted small' }, `${md(adv.at)} 问的`), h('p', { class: 'ai-summary' }, adv.summary),
        order.length ? [h('div', { class: 'label-sm' }, '先后顺序'), h('ol', { class: 'wish-order' }, order.map((w) => h('li', {}, w.name)))] : null,
        h('p', { class: 'muted small' }, '每个心愿点开能看到 AI 对它的看法。')]
        : h('p', { class: 'muted small' }, 'AI 可以帮你看：先买哪个、什么时候买、真需要还是一时想要。'),
      btn),
    confirmText: null, cancelText: '关上', onConfirm: () => {},
  });
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
  // 能自由用的钱：自由存款 + 心愿基金里能随便用的 + 这个月生活费还剩的。应急、医疗、专项、家庭存款都有用处了，不算
  const m = savingsMap(d, t, usdRate());
  const usable = m.free.have + m.wish.small + Math.max(0, hl.left);
  const big = price > (d.settings.wishBigFrom ?? 300);
  const facts = [];
  if (perDayFood) facts.push(`相当于 ${(price / perDayFood).toFixed(price / perDayFood < 10 ? 1 : 0)} 天的饭钱`);
  if (free) facts.push(`相当于 ${(price / free).toFixed(1)} 个月的自由钱`);
  if (hl.left > 0) facts.push(`是这个月还能花的 ${money(hl.left)} 的 ${Math.round((price / hl.left) * 100)}%`);
  if (yearSave > 0) facts.push(`如果从存款出，一年存钱目标晚 ${Math.max(1, Math.round(price / (yearSave / 365)))} 天左右达成`);
  facts.push(`现在能自由用的钱是 ${money(Math.max(0, usable))}（自由存款 + 心愿基金能随便用的 + 这个月生活费还剩的；专项、医疗、应急、家庭存款都不算）`);
  if (big) facts.push('大额的要放进心愿单，「开始攒」以后从心愿基金每次进账里分 1/3 慢慢攒，存款不动');
  return {
    price, facts, big,
    floorBreak: price > usable, // 硬规则 1：超过能自由用的钱（会动到有用处的存款）
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
  const m = savingsMap(d, t, usdRate());
  const f = m.wish;
  const plan = bigWishPlan(d, t);
  const groupLine = GROUPS.filter((g) => d.budget[g.id]).map((g) => `${g.name} 已花 ${Math.round(st.spent[g.id])} / 预算 ${Math.round(d.budget[g.id] * part.factor)}`).join('；');
  const hist = closedPeriods(d, t).slice(-3).map((p) => {
    const s = periodStats(d, p);
    const top = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, v]) => `${catName(id)} ${Math.round(v)}`).join('、');
    return `${p.label}：收入 ${Math.round(s.income)}，花 ${Math.round(s.total)}（${top}）`;
  });
  const ups = upcoming(d, t, 35).map((u) => `${md(u.date)} ${u.r.name} ${u.r.amount}${isUsd(d, u.r.account) ? ' 美元' : ' 元'}`);
  const wishes = d.wishes.filter((w) => w.status === 'open').map((w) => `${w.name} ${w.price}${isBigWish(d, w) ? `（大额，${{ idle: '还没开始攒', waiting: '排队中', saving: '正在攒', ready: '攒够了' }[plan.find((x) => x.w.id === w.id)?.state]}，已攒 ${Math.round(f.env[w.id] || 0)}）` : '（小额）'}`);
  const decisions = (d.decisions || []).slice(-8).map((x) => `${x.at} ${x.item} ${x.price || ''} → ${{ buy: '买了', wish: '放进心愿单', skip: '没买' }[x.choice] || ''}${x.review ? `，回访：${{ worth: '值', meh: '一般', regret: '后悔' }[x.review]}` : ''}`);
  return [
    `今天 ${t}，预算月 ${hl.period.label} 第 ${hl.period.dayIndex} 天，还剩 ${hl.daysLeft} 天。`,
    `每月预算：${GROUPS.filter((g) => d.budget[g.id]).map((g) => `${g.name} ${d.budget[g.id]}`).join('、')}。这个预算月：${groupLine}。生活（吃饭+日常+自由钱）还能花 ${Math.round(hl.left)}，平均每天 ${Math.max(0, Math.round(hl.perDay))}。`,
    `收入：每月正常 ${d.settings.expectedIncome || '?'}${d.settings.summerMonths?.length ? `，${d.settings.summerMonths.join('、')} 月没有收入` : ''}；这个预算月已到 ${Math.round(st.income)}${part.isPartial ? '（这个月是开始记账的第一个月，之前到的没记）' : ''}。`,
    `总资产 ${Math.round(hl.assets)}，应急钱底线 ${d.settings.emergencyFloor || 0}，安全垫 ${hl.items.find((x) => x.key === 'cushion')?.value || ''}。`,
    rc.toMe || rc.iOwe ? `待收回 ${Math.round(rc.toMe)}（还不在手里，不能当能花的钱），欠别人 ${Math.round(rc.iOwe)}。` : '',
    ups.length ? `接下来要扣：${ups.join('；')}。` : '',
    `存钱卡这边（按顺序留好的）：家庭存款 ${Math.round(m.family.have)}（封存不动）、应急底线 ${Math.round(m.emergency.have)}、医疗备用金 ${Math.round(m.medical.have)}、专项 ${m.specials.map((x) => `${x.name} ${Math.round(x.have)}/${Math.round(x.target)}（${x.by || '没日子'}）`).join('、') || '无'}、自由存款 ${Math.round(m.free.have)}。只有自由存款是能自由用的。`,
    socialPlan(d, t).length ? `要准备的人情钱（${FAVOR_BIG} 以上的已经算进专项存款，要从存款里留出来；以下的从日常预算里出）：${socialPlan(d, t).map((x) => `${x.due} ${x.name}「${x.f.text}」约 ${Math.round(x.amount)}${x.big ? '（大额）' : ''}`).join('；')}。买东西时要把这些钱考虑进去。` : '',
    `心愿基金：能随便用 ${Math.round(f.small)}，给大额心愿攒着 ${Math.round(f.envTotal)}；${d.settings.wishBigFrom} 以上算大额，要「开始攒」后从心愿基金每次进账分 1/3 攒，一次只攒一个，攒够才买。心愿单：${wishes.join('、') || '空'}。`,
    hist.length ? `最近几个预算月：${hist.join('；')}。` : '刚开始记账，还没有完整的预算月。',
    decisions.length ? `以前问过的：${decisions.join('；')}。` : '',
    `规则：先存后花；自由钱每月 ${d.budget.free || 0} 花了不用内疚；${d.settings.wishBigFrom} 以上的东西先冷静 ${d.settings.coolDays} 天、放进心愿单从心愿基金慢慢攒；存款不碰，除非特别急用。`,
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

// ---------- 买了以后（2026-10-26，用户选的两样：买了以后一年里会怎样、每用一次多少钱；价格超过 BUY_CARD_FROM 才算） ----------
// 计算在 forecast.js：假设今天买（先用心愿基金能随便用的，不够的从存款出），和不买各模拟一次（同一批随机数），比一年里的变化
function buyLater(price) {
  if (!(price > BUY_CARD_FROM)) return null;
  try {
    const v = forecasts();
    return buyImpact(store.data, today(), price, { fc: v.fc, score: v.score, rate: usdRate(), base: aheadForecast() });
  } catch { return null; } // 算不出来就不出这一块
}
const pctPair = ([a, b]) => (pct(a) === pct(b) ? `${pct(b)}，没变` : `${pct(a)} → ${pct(b)}`);
// 发给 AI 的：只有这几个数
function impactText(x) {
  if (!x) return '';
  const lines = [`一年里碰到应急底线的可能 ${pctPair(x.pBelow)}`, `一年后存款（中位数）少 ${money(x.yearOn[0] - x.yearOn[1])}`,
    ...x.goals.map((g) => `「${g.name}」按时留够的可能 ${pct(g.before)} → ${pct(g.after)}`),
    x.later && !x.later.same ? `「${x.later.name}」大约留够的月份 ${x.later.before ? aheadMonth(x.later.before) : '留不够'} → ${x.later.after ? aheadMonth(x.later.after) : '留不够'}` : ''];
  return `\n网站模拟了「如果今天买 ${money(x.price)}」和不买的一年（先用心愿基金能随便用的 ${money(x.fromWish)}，其余 ${money(x.fromSaved)} 从存款出）：${lines.filter(Boolean).join('；')}。可以参考，数字照这里说，不要编。`;
}
const useMoney = (v) => (v < 10 ? `¥${v.toFixed(1)}` : money(v));
const rangeText = ([a, b]) => (a === b ? `${a}` : `${a}～${b}`);
function buyCard(c) {
  const x = c.impact;
  const u = c.use;
  if (!x && !u) return null;
  const row = (label, value, warn = false) => h('div', { class: 'buy-row' }, h('span', {}, label), h('b', { class: warn ? 'warn-text' : '' }, value));
  const later = x?.later && !x.later.same ? x.later : null;
  return h('div', { class: 'buy-card' },
    x ? [
      h('div', { class: 'buy-title' }, `如果今天买（${money(x.price)}）`),
      h('p', { class: 'muted small' }, x.fromSaved <= 0 ? '全部用心愿基金能随便用的钱' : x.fromWish > 0 ? `先用心愿基金 ${money(x.fromWish)}，其余 ${money(x.fromSaved)} 从存款出` : '从存款出'),
      row('一年里碰到底线的可能', pctPair(x.pBelow), x.pBelow[1] > BELOW_MAX && pct(x.pBelow[0]) !== pct(x.pBelow[1])),
      row('一年后的存款', `少 ${money(Math.max(0, x.yearOn[0] - x.yearOn[1]))}`),
      x.goals.slice(0, 3).map((g) => row(`「${g.name}」按时留够`, `${pct(g.before)} → ${pct(g.after)}`, g.after < ON_TIME)),
      later ? row(`「${later.name}」大约留够`, `${later.before ? aheadMonth(later.before) : '—'} → ${later.after ? aheadMonth(later.after) : '10 年内留不够'}`) : null,
      !x.goals.length && !later ? row('专项', '按时留够的可能都没变') : null,
    ] : null,
    u ? [
      row('每用一次', `约 ${useMoney(u.median)}${useMoney(u.lo) === useMoney(u.hi) ? '' : `（80%：${useMoney(u.lo)}～${useMoney(u.hi)}）`}`),
      h('p', { class: 'muted small' }, `按一年用 ${rangeText(u.perYear)} 次、用 ${rangeText(u.years)} 年估的${u.resale ? `，用完能卖回 ${Math.round(u.resale * 10)} 成` : ''}。`),
    ] : null,
    h('details', { class: 'buy-how' }, h('summary', {}, '怎么算的'),
      x ? h('p', { class: 'small' }, `和「往后」同一套模拟，同一批随机数跑两遍：一遍照现在的账，一遍假设今天花掉 ${money(x.price)}（先用心愿基金能随便用的，不够的从存款出），各 ${x.paths} 条路径。两遍只差这笔钱，所以变化就是它带来的。底线 = 应急底线 + 医疗备用金 + 封存的家庭存款；存款缺口总落在日子最远的专项上，所以看它晚几个月留够。`) : null,
      u ? [h('p', { class: 'small' }, '一年用几次、能用几年是按你说的用法估的两个范围（衣服鞋子参考物品档案里类似的穿了几次），当作对数正态分布的 10% 和 90% 分位，抽 4000 次：'),
        h('p', { class: 'how-math' }, '每用一次 = 价格 × (1 − 能卖回的成数) ÷ (一年用几次 × 用几年)')] : null));
}

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
    '网站算好的「硬规则」必须遵守：超过能自由用的钱（会动到专项、医疗、应急或家庭存款）的，verdict 必须是 no；大额的东西就算值得买，也要建议先冷静几天、放进心愿单。',
    '他问别的（比如这个月花得怎么样、钱花哪了、某个理财概念）就直接回答，verdict 为 null。',
    'answer 控制在 150 字以内，可以分几行。item 是他想买的东西（名称和价格，价格不知道就 null），不是买东西的问题就 null。',
    `给结论（verdict 不为 null）而且价格超过 ${BUY_CARD_FROM} 时填 use，网站用它算「每用一次多少钱」：perYear 一年大概用几次 [少, 多]，years 大概能用几年 [少, 多]，resale 用完能卖回原价的几成（0～0.9，卖不掉就 0）。按他说的用法估；衣服鞋子参考下面已有的类似东西穿了几次；拿不准就把范围放宽。其余时候 use 为 null。`,
    INVENTORY_RULE,
    '只输出 JSON：{"answer":"","verdict":null,"item":{"name":"","price":null},"use":null}',
    '',
    '他的情况（汇总数字）：',
    moneyContext(d),
    await inventoryContext(),
  ].join('\n');
  const extra = pf ? [
    '',
    `网站对「${money(pf.price)}」算好的：${pf.facts.join('；')}。`,
    `硬规则：${pf.floorBreak ? `超过能自由用的钱（只有 ${money(Math.max(0, pf.usable))}），会动到专项、医疗、应急或家庭存款 → 必须不建议。` : '在能自由用的钱以内。'}${pf.cool ? ` 超过 ${d.settings.wishBigFrom}，属于大额 → 建议先冷静 ${d.settings.coolDays} 天。` : ''}`,
  ].join('\n') : '';
  const history = chatState.messages.filter((m) => !m.pending).slice(-8)
    .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.role === 'me' ? m.text : JSON.stringify({ answer: m.text }) }));
  // 接着上一句聊（「坏了，每天都用」）时话里没有价格，就用刚才在聊的那样东西的价格
  const impact = buyLater(price || chatState.messages.filter((x) => x.item?.price).at(-1)?.item.price);
  const out = await askJson(ai, system + extra + impactText(impact), question, { history, maxTokens: 6000, timeout: 90000 });
  const item = out.item && out.item.name ? { name: String(out.item.name).slice(0, 40), price: Number(out.item.price) || price || null } : null;
  let verdict = ['buy', 'wait', 'no'].includes(out.verdict) ? out.verdict : null;
  const facts = item?.price ? priceFacts(d, item.price) : pf;
  if (verdict && facts?.floorBreak) verdict = 'no'; // 硬规则不靠 AI
  // 数字卡：价格超过 BUY_CARD_FROM、给了结论才有（用户 2026-10-26 定的）
  const p = facts?.price;
  const card = verdict && p > BUY_CARD_FROM ? { impact: impact?.price === p ? impact : buyLater(p), use: perUse(p, out.use, item?.name || '') } : null;
  return { text: String(out.answer || '（没有回答）'), verdict, item, facts, card };
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
      '放进心愿单的东西，过几天不想要了就点「不想要了」，不用勉强自己。',
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
    confirmText: '问问 AI',
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
  ['网站帮你算的', ['只要话里有价格，网站会换算成你有感觉的说法：相当于几天的饭钱、几个月的自由钱、存钱目标晚几天。',
    `超过 ${money(BUY_CARD_FROM)} 的，回答上面多一张卡：如果今天买，一年里碰到底线的可能、存款少多少、专项还能不能按时留够；还有每用一次大约多少钱。点「怎么算的」看算法。`, `两条规则不靠 AI：超过能自由用的钱（自由存款 + 心愿基金能随便用的 + 这个月生活费还剩的）一定「不建议」；${money(store.data.settings.wishBigFrom)} 以上的建议先放进心愿单冷静几天。`]],
  ['决定还是你做', ['给了建议以后，下面有「决定买」「放进心愿单」「不买了」。决定买会带你去记一笔。买了的东西一个月后会问你「值不值」，下次判断会参考。']],
  ['隐私', ['发给 AI 的只有汇总数字（各类花了多少、余额、预算剩多少、心愿单），不发每一笔的明细。聊天记录不保存，关掉页面就没了。']],
  ['理财小课堂', ['上面那排卡片，每张讲一个概念，用你自己的数字举例。看完有问题，点「问问 AI」接着聊。']],
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
        m.card ? buyCard(m.card) : null,
        h('div', {}, m.text),
        f && m.verdict ? h('div', { class: 'facts' },
          h('b', {}, `${money(f.price)}：`), f.facts.map((x) => h('div', {}, `· ${x}`)),
          f.floorBreak ? h('div', { class: 'warn-text' }, '· 超过能自由用的钱，会动到有用处的存款') : null,
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

// 订阅的钱这个预算月怎么样（2026-10-14 用户说没理清）：预算多少、已经扣了哪些、还要扣哪些、加起来够不够；
// 美元的写清楚钱怎么走：充值是转账不算花，扣款那天才按汇率算进订阅预算
function subMonthCard(d, t) {
  const p = periodFor(d, t);
  const st = periodStats(d, p);
  const budget = Number(d.budget?.sub) || 0;
  const rate = usdRate();
  const paid = st.tx.filter((x) => spendOf(d, x) > 0 && txGroup(d, x) === 'sub').sort((a, b) => a.date.localeCompare(b.date));
  const coming = upcoming(d, t, daysBetween(t, p.end)).filter((u) => u.date <= p.end && u.r.day); // 年费按专项留钱，不算进这个月
  const comingCny = coming.reduce((s2, u) => s2 + u.r.amount * (isUsd(d, u.r.account) ? rate : 1), 0);
  const all = round2(st.spent.sub + comingCny);
  const left = round2(budget - all);
  const { accs } = chargePlan(d, t);
  const line = (name, date, amt, sub) => h('div', { class: 'sub-line' }, h('span', { class: 'grow' }, name, h('span', { class: 'muted small' }, ` · ${md(date)}`)),
    h('span', {}, amt, sub ? h('span', { class: 'muted small' }, ` ${sub}`) : null));
  return [h('div', { class: 'card sub-month' },
    h('h3', {}, `这个预算月的订阅（${md(p.start)}–${md(p.end)}）`),
    h('div', { class: 'sub-big' }, h('b', {}, money(st.spent.sub)), h('span', { class: 'muted' }, ` 已扣 · 预算 ${money(budget)}`)),
    bar(budget ? st.spent.sub / budget : 0, st.spent.sub > budget ? 'var(--danger)' : 'var(--g-sub)'),
    paid.length ? [h('div', { class: 'label-sm' }, '已经扣了'), paid.map((x) => line(txTitle(x), x.date, exact(x.amount, curOf(x.account)), x.cny ? `≈${money(x.cny)}` : ''))] : null,
    coming.length ? [h('div', { class: 'label-sm' }, '这个月还要扣'), coming.map((u) => line(u.r.name, u.date, exact(u.r.amount, isUsd(d, u.r.account) ? '$' : '¥'),
      isUsd(d, u.r.account) ? `≈${money(u.r.amount * rate)}` : u.r.remindOnly ? '到时自己记' : ''))] : null,
    h('p', { class: `small sub-sum ${left < 0 ? 'warn-text' : 'muted'}` },
      budget ? (left >= 0 ? `都扣完大约 ${money(all)}，订阅预算还剩 ${money(left)}。` : `都扣完大约 ${money(all)}，比订阅预算多 ${money(-left)}，这个月存下的钱会少一些。`)
        : `都扣完大约 ${money(all)}。在「花钱方式」里给订阅定个数，就能看够不够。`),
    yearlySubs(d, rate).length ? h('p', { class: 'muted small' }, `年费（${yearlySubs(d, rate).map((x) => x.name).join('、')}）在专项里提前留好，扣的那个月不占订阅预算。`) : null),
  accs.length ? h('div', { class: 'card sub-flow' },
    h('h3', {}, '美元订阅的钱怎么走'),
    h('ol', { class: 'flow-steps' },
      h('li', {}, h('b', {}, '充值'), '：买礼品卡充进', accName(accs[0].id), '，记一笔「转账」。人民币换成美元，钱还是你的，不算花。'),
      h('li', {}, h('b', {}, '扣款'), '：到扣款那天，网站自动记一笔订阅花销，按当天汇率折成人民币，算进上面的订阅预算。'),
      h('li', {}, h('b', {}, '看余额'), '：只要美元余额够付下一笔就行，不够时首页会提醒提前充。')),
    accs.map(chargeFoot)) : null];
}

// 年费改了金额、日子：还没办完的那个专项跟着改；改成每月的，专项就不用了
function syncYearlyGoal(data, r) {
  const g = (data.goals || []).find((x) => x.yearly === r.id && !x.status);
  if (!g) return;
  const it = yearlySubs(data).find((x) => x.id === r.id);
  if (!it) { Object.assign(g, { status: 'cancelled', doneAt: today() }); return; }
  Object.assign(g, { target: it.amount, by: `${g.yearlyYear}-${r.yearly}`, name: `${g.yearlyYear} 年${r.name}` });
}

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
        h('p', { class: 'muted small' }, '每月的到日子网站自动记一笔，算进订阅预算。每年的（年费）会变成一个专项，提前从存款里留好，不占扣款那个月的预算；扣了以后记一笔、选上这个专项。')),
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
            syncYearlyGoal(data, x);
          });
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const stop = (r) => saveUndoable(`停掉订阅：${r.name}`, (data) => {
    data.recurring = data.recurring.filter((x) => x.id !== r.id);
    for (const g of data.goals || []) if (g.yearly === r.id && !g.status) Object.assign(g, { status: 'cancelled', doneAt: today() });
  },
    `停掉了「${r.name}」，记得去 App Store 取消订阅`).then(render).catch(() => {});
  const mark = (r, v) => upd(`订阅体检：${r.name} ${SUB_NOTE[v]}`, (data) => {
    data.subReview = { ...(data.subReview || {}), notes: { ...(data.subReview?.notes || {}), [r.id]: v } };
  });
  const finish = () => upd('订阅体检完成', (data) => { data.subReview = { ...(data.subReview || {}), last: today() }; });
  return h('div', {},
    headerSub('订阅', `一年大约 ${money(total)}`, h('button', { class: 'icon-btn', 'aria-label': '加一个订阅', onclick: () => edit() }, icon('plus')), helpButton('订阅体检', [
      ['为什么要体检', ['订阅是自动扣的，单看一个月不多，一年加起来很可观，也很容易忘了自己还订着。', '每 3 个月看一眼，每个问自己：这 3 个月真的常用吗？低一档的够不够？几个订阅用途重不重叠？能不能走报销？']],
      ['怎么做', ['每个订阅点一下「值」「降档」或「停掉」，最后点「体检完了」。3 个月后首页会再提醒。', '决定停掉的，记得也去 App Store（设置 → Apple ID → 订阅）或对应的网站取消，网站这边点「停掉」就不再自动记账。']],
      ['年费怎么算', ['每月扣的算进订阅预算。一年扣一次的（年费）不算进扣款那个月，会变成一个专项：平时从存款里慢慢留好，到期扣了记一笔、选上这个专项，从专项出。这样年费那个月不会显得超支。', '办完了明年的专项自己生成；改了金额、日子专项跟着改；停掉了专项也不要了。']],
    ])),
    d.recurring.length ? subMonthCard(d, t) : null,
    d.recurring.length ? h('div', { class: 'section-title' }, '每一个订阅') : null,
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

// ---------- 专项存款、钱都在哪 ----------

const SPECIAL_HELP = (d) => [
  ['是什么', ['到日子一定要用的钱：暑假生活费、300 以上的人情（随礼）、毕业过渡金……和心愿不一样：心愿是「想要」，这是「到时候必须有」。']],
  ['怎么存', ['不用另外存，也不看钱在哪张卡上：所有账户加起来，先留出心愿基金和这个月的生活费，再留家庭存款、应急底线、医疗备用金，剩下的按日子先后给专项，日子最近的先存够。',
    '存够了就封存，只给这件事用。新来一个急的，自动排到最前面，最后面的先停一停。', '「每月留」是还差的钱平均到剩下有收入的月份。',
    '「按时留够的可能」：收入可能没到、花销有多有少、暑假没有收入、前面的专项先花掉都算上，估一估要用之前留够的可能有多大，还有大约哪个月留够。低于 90% 用黄色。和总结页「往后」是一样的。']],
  ['怎么花', ['记账时在「算在哪个专项里」选上它，这笔钱从专项出，不占当月预算。一件事可以记好几笔。', '还大额人情时，记那笔钱、选上「还的是哪个人情」就行。']],
  ['办完了', ['点「办完了」会带你去记那笔花销：专项、金额、账户先填好，点「记好了」才算数。花够了专项自己办完，有结余回到自由存款；超了先从心愿基金扣（留 ¥100），不够的由存款补。', '不用了（比如婚礼不办了）点「不用了」，留着的钱回到自由存款。']],
  ['暑假生活费', ['自动算：暑假那几个月的预算，暑假开始前一天存够。暑假里还没转出来的那几个月继续留着。', '花起来按生活费算：结余照样进心愿基金。']],
];

function goalsView() {
  const d = store.data;
  const t = today();
  const m = savingsMap(d, t, usdRate());
  // 按时留够的可能、大约哪个月（2026-10-25）：和总结页「往后」同一个模拟
  const etas = Object.fromEntries(aheadForecast().goals.map((g) => [g.id, goalLine(g)]));
  const edit = (g = null) => {
    const name = h('input', { value: g?.name || '', placeholder: '比如 毕业过渡金', 'aria-label': '是什么事' });
    const target = h('input', { inputmode: 'decimal', value: g ? String(g.target) : '', placeholder: '一共要多少', 'aria-label': '一共要多少' });
    const by = h('input', { type: 'date', value: g?.by || '', 'aria-label': '哪天要用' });
    const note = h('input', { value: g?.note || '', placeholder: '用来做什么（选填）', 'aria-label': '用来做什么' });
    openSheet({
      title: g ? '改专项' : '加一个专项',
      body: h('div', { class: 'form' }, name, target, h('label', {}, '哪天要用', by), note),
      confirmText: '保存',
      onConfirm: async () => {
        const n = Number(target.value.replace(/[，,\s]/g, ''));
        if (!name.value.trim() || !(n > 0) || !by.value) { toast('名称、金额、日期都要填', 'error'); return false; }
        const fields = { name: name.value.trim(), target: round2(n), by: by.value, note: note.value.trim() };
        try {
          await save(`${g ? '改' : '加'}专项：${fields.name}`, (data) => {
            if (g) Object.assign(data.goals.find((x) => x.id === g.id), fields);
            else data.goals.push({ id: newId('g'), ...fields, createdAt: today() });
          });
          render();
        } catch { return false; }
        return true;
      },
    });
  };
  const finish = (x, status) => {
    // 办完了 = 去记那笔花销（专项先选上、金额填还剩的）；花够了专项自己办完。没有要花的了才直接办完
    if (status === 'done' && x.target > 0) {
      const q = new URLSearchParams({ special: x.id, amount: String(round2(x.target)), note: x.name.replace(/^\d{4} 年/, ''), account: d.settings.floorAccount || '' });
      if (x.category) q.set('category', x.category);
      window.location.hash = `#/add?${q}`;
      return;
    }
    const left = round2(x.budget - x.spent);
    const msg = status === 'cancelled' ? `「${x.name}」不用了，留着的钱回到自由存款`
      : left >= 0 ? `「${x.name}」办完了${left > 0 ? `，结余 ${money(left)} 回到自由存款` : ''}` : `「${x.name}」办完了，超了 ${money(-left)}，先从心愿基金扣`;
    saveUndoable(`专项${status === 'done' ? '办完了' : '不用了'}：${x.name}`, (data) => { Object.assign(data.goals.find((g) => g.id === x.id), { status, doneAt: today() }); }, msg)
      .then(render).catch(() => {});
  };
  const closed = d.goals.filter((g) => g.status);
  return h('div', {},
    headerSub('专项存款', '到日子一定要用的钱，按日子先后留好', h('button', { class: 'icon-btn', 'aria-label': '加一个专项', onclick: () => edit() }, icon('plus')), helpButton('专项存款怎么用', SPECIAL_HELP(d))),
    h('a', { class: 'receipt-link', href: '#/money' }, icon('wallet'), ' 钱都在哪：所有的钱放一起看'),
    m.specials.length ? m.specials.map((x) => h('div', { class: 'card goal' },
      h('div', { class: 'wish-top' },
        h('div', { class: 'grow' }, h('div', { class: 'wish-name' }, x.name, x.auto ? h('span', { class: 'badge' }, '自动') : null, x.sealed ? h('span', { class: 'badge accent' }, '封存') : null),
          h('div', { class: 'muted small' }, [x.by ? `${md(x.by)}（${x.by.slice(0, 4)} 年）要用` : '', x.note].filter(Boolean).join(' · '))),
        h('div', { class: 'wish-price' }, money(x.budget))),
      bar(x.target ? x.have / x.target : 1, (etas[x.id] ? etas[x.id].short : x.short > 0) ? 'var(--amber)' : x.sealed ? 'var(--g-daily)' : 'var(--accent)'),
      h('div', { class: 'muted small wish-progress' }, x.sealed ? `封存了 ${money(x.have)}，只给这件事用`
        : `留了 ${money(x.have)}，还差 ${money(x.need)}${x.months ? `；还有 ${x.months} 个有收入的月份，平均每月留 ${money(x.perMonth)}` : ''}`),
      x.spent ? h('div', { class: 'muted small' }, `已经花了 ${money(x.spent)} / ${money(x.budget)}`) : null,
      etas[x.id] ? h('p', { class: `small ${etas[x.id].short ? 'soon' : 'muted'}` }, etas[x.id].text)
        : x.short > 0 ? h('p', { class: 'small soon' }, `按现在每月能存的，到时候会差 ${money(x.short)}`) : null,
      x.kind === 'goal' ? h('div', { class: 'wish-actions' }, h('span', { class: 'grow' }),
        h('button', { class: 'link', onclick: () => edit(d.goals.find((g) => g.id === x.id)) }, '改'),
        h('button', { class: 'link', onclick: () => finish(x, 'cancelled') }, '不用了'),
        h('button', { class: 'small secondary', onclick: () => finish(x, 'done') }, '办完了'))
        : h('p', { class: 'muted small' }, x.autoText || x.kind === 'summer' ? (x.autoText || '按每月预算和没有收入的月份自动算，改预算它会跟着变。暑假里转生活费就从这里出。') : '')))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有专项。点右上角 ＋ 加，比如「毕业过渡金」。')),
    closed.length ? h('details', { class: 'card done-wishes' }, h('summary', {}, `办完的、不用的 ${closed.length} 个`),
      closed.map((g) => h('div', { class: 'manage-row' }, h('span', { class: 'grow' }, g.name,
        h('span', { class: 'muted small block' }, `${md(g.doneAt)}${g.status === 'done' ? '办完了' : '不用了'} · 花了 ${money(d.tx.filter((x) => x.special === g.id).reduce((a, x) => a + cny(x), 0))} / ${money(g.target)}`))))) : null);
}

// 一个圆圈：v 是 0～1；sealed 深紫、late 琥珀
// 钱都在哪的存钱罐（2026-10-14 第二次重做，用户选的：存钱罐、按能不能动分三组、罐子下只写名字和金额、点了在下面展开）
// 罐子是写死的 SVG，只拼数字和固定的颜色变量，不含用户数据，可以用 innerHTML
let jarSeq = 0;
function jarSvg(fill, { sealed = false, warn = false, color = 'var(--accent)' } = {}) {
  const id = `jar${++jarSeq}`;
  const f = Math.max(0, Math.min(1, fill || 0));
  const top = 66 - f * 40; // 水面：从罐底 y=66 往上，满了停在 y=26，水面和投币口一直看得见
  const c = warn ? 'var(--amber)' : color;
  const water = f > 0 ? `<path d="M0 ${top} Q16 ${top - 2.5} 32 ${top} T64 ${top} V80 H0 Z" fill="${c}" opacity="0.8"/>`
    + `<path d="M0 ${top} Q16 ${top - 2.5} 32 ${top} T64 ${top}" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.6"/>` : '';
  const slot = sealed
    ? '<rect x="17" y="4" width="30" height="10" rx="3.5" fill="var(--jar-lid)"/><rect x="21" y="2" width="22" height="4" rx="2" fill="var(--jar-lid)"/>'
    : '<rect x="24" y="16.5" width="16" height="3.4" rx="1.7" fill="var(--jar-slot)"/>';
  const el = h('span', { class: 'jar-svg', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 64 72"><defs><clipPath id="${id}"><rect x="6" y="11" width="52" height="58" rx="19"/></clipPath></defs>`
    + `<rect x="6" y="11" width="52" height="58" rx="19" fill="var(--jar-glass)"/>`
    + `<g clip-path="url(#${id})">${water}</g>`
    + `<rect x="6" y="11" width="52" height="58" rx="19" fill="none" stroke="${warn ? 'var(--amber)' : 'var(--jar-line)'}" stroke-width="1.6"/>`
    + `<path d="M14 30 Q14 22 20 19" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"/>${slot}</svg>`;
  return el;
}
// 罐子下面的金额：1 万以上写「¥2.6万」
const jarMoney = (n) => (Math.abs(n) >= 10000 ? `${n < 0 ? '−' : ''}¥${(Math.round(Math.abs(n) / 1000) / 10).toLocaleString('zh-CN')}万` : money(n));
let moneyOpen = null; // 展开的是哪个罐子（只在内存）

function moneyDetail(title, lines, rows = [], extra = null) {
  openSheet({ title, body: h('div', { class: 'form' }, lines.map((l) => h('p', { class: 'small' }, l)),
    rows.length ? h('div', { class: 'detail-rows' }, rows.map(([a, b2]) => h('div', { class: 'cart-line' }, h('span', {}, a), h('b', {}, b2)))) : null, extra),
  confirmText: '知道了', cancelText: null, onConfirm: () => {} });
}

function cardCheckCard() {
  const d = store.data;
  const c = cardCheck(d, today());
  const floorName = account(d, d.settings.floorAccount)?.name || '存钱卡';
  const names = c.accounts.map((a) => a.name).join('、');
  const ok = Math.abs(c.diff) < 1;
  return h('div', { class: 'card card-check' },
    h('h3', {}, '数额计算'),
    h('div', { class: 'cart-line' }, h('span', {}, '心愿基金'), h('b', {}, money(c.wish))),
    h('div', { class: 'cart-line' }, h('span', {}, '这个月生活费还剩'), h('b', {}, money(Math.max(0, c.left)))),
    c.fromWish ? h('div', { class: 'cart-line' }, h('span', {}, '这个月超了，先由心愿基金扣'), h('b', {}, `−${money(c.fromWish)}`)) : null,
    h('div', { class: 'cart-line' }, h('span', {}, `${names}应该一共有`), h('b', {}, money(c.expected))),
    h('div', { class: 'cart-line' }, h('span', {}, '网站上现在是'), h('b', {}, money(c.actual))),
    h('p', { class: `small ${ok ? 'muted' : ''}` }, ok ? '对得上，不用转。'
      : c.diff < 0 ? `少了 ${money(-c.diff)}：从${floorName}转 ${money(-c.diff)} 到生活费卡（超支、看病、专项从生活费卡付了，由存款补）。`
        : `多了 ${money(c.diff)}：可以从生活费卡转 ${money(c.diff)} 到${floorName}（比如兼职的七成、专项超支已经由心愿基金补了）。`),
    h('p', { class: 'muted small' }, '先在上面把每张卡的余额对准，再看这里。'));
}

const MONEY_HELP = [
  ['一句话', ['钱一直在卡里，网站只在账面上给它们分好用途。每一类钱是一个存钱罐，水位是存满了多少。点一个罐子，下面会写它是干什么的、还差多少。']],
  ['三组', ['存着不动：家庭存款、应急底线、医疗备用金、每个专项、正在攒的大额心愿。', '能自由用：自由存款、心愿基金（现在能随便用的）。', '这个月：生活费还剩多少。']],
  ['水位', ['应急、医疗、专项：存了多少 ÷ 要留多少。大额心愿：攒了多少 ÷ 价格。生活费：还剩 ÷ 这个月预算。',
    `家庭存款封存了就是满的。自由存款：不到 ${money(FREE_KEEP)} 时按兜底线算，之后按「凑够下一个一万封存」算。心愿基金按 ${money(WISH_CAP)} 算满，满了再进来的算存款。`,
    '盖着盖子的是封存了的；水是琥珀色的，是还没存满或到时候会差钱。']],
  ['钱进来先补谁', ['应急底线 → 医疗备用金 → 专项存款（日子最近的先）→ 自由存款（到 ¥2,000）→ 家庭存款（每凑够一万封存）。已经封存的家庭存款一直保着。']],
  ['钱不够先扣谁', ['心愿基金能随便用的（留 ¥100）→ 自由存款 → 专项（日子最远的先让）→ 医疗 → 应急 → 家庭存款。大额心愿攒着的不扣。']],
  ['和卡没关系', ['所有账户的钱加在一起分，不看钱在哪张卡上。「一共」= 所有账户（美元按汇率）+ 别人欠你的 − 你欠别人的。']],
  ['在总结里', ['总结页右上角点「钱都在哪」，整页翻过来就是这一页；再点「总结」翻回去。']],
];

// inSummary：在总结页翻过来看的（标题旁边是翻回去的按钮）
function moneyView(inSummary = false) {
  const d = store.data;
  const t = today();
  const m = savingsMap(d, t, usdRate());
  const c = { left: livingLeft(d, t) };
  const p = periodFor(d, t);
  const lb = livingBudget(d) * partial(d, p).factor;
  const plan = bigWishPlan(d, t).filter((x) => x.saved > 0);
  const left = Math.max(0, c.left);
  const full = (have, target) => target > 0 && have >= target - 0.5;
  const shortName = (x) => (x.kind === 'favor' ? `人情·${x.name.replace(/^人情：/, '').split(' · ')[0]}` : x.kind === 'summer' ? '暑假' : x.name);
  const freeNext = FREE_KEEP + FAMILY_STEP - m.free.have;
  const kept = [
    { key: 'family', name: '家庭存款', amount: m.family.have, color: 'var(--jar-k1)', fill: m.family.count ? 1 : 0, sealed: m.family.count > 0,
      lines: [m.family.count ? `${m.family.count} 个一万，封存不动` : '还没有', `自由存款超过 ${money(FREE_KEEP)} 的，每凑够一万封存进来`] },
    { key: 'emergency', name: '应急底线', amount: m.emergency.have, color: 'var(--jar-k2)', fill: m.emergency.target ? m.emergency.have / m.emergency.target : 0,
      warn: !full(m.emergency.have, m.emergency.target),
      lines: [full(m.emergency.have, m.emergency.target) ? '满了，意外才动' : `还差 ${money(m.emergency.target - m.emergency.have)}，下一笔收入先补`] },
    { key: 'medical', name: '医疗备用金', amount: m.medical.have, color: 'var(--jar-k3)', fill: m.medical.target ? m.medical.have / m.medical.target : 0,
      warn: !full(m.medical.have, m.medical.target),
      lines: [full(m.medical.have, m.medical.target) ? '满了' : `还差 ${money(m.medical.target - m.medical.have)}，下一笔收入先补`, '看病、买药从这里出'] },
    ...m.specials.map((x) => ({ key: `s-${x.id}`, name: shortName(x), amount: x.have, color: 'var(--jar-k4)', fill: x.target ? x.have / x.target : 1,
      sealed: x.sealed, warn: x.short > 0, href: '#/goals',
      lines: [x.kind === 'favor' ? `${shortName(x)}${x.by ? ` · ${md(x.by)}要用` : ''}` : x.by ? `${md(x.by)}要用` : x.name,
        x.sealed ? '存够了，封存' : x.short > 0 ? `到时候会差 ${money(x.short)}` : `还差 ${money(x.target - x.have)}${x.perMonth ? `，每月留 ${money(x.perMonth)}` : ''}`] })),
    ...plan.map((x) => ({ key: `w-${x.w.id}`, name: x.w.name, amount: x.saved, color: 'var(--jar-k5)', fill: x.saved / Number(x.w.price), href: '#/wishes',
      lines: [`大额心愿，攒了 ${money(x.saved)} / ${money(x.w.price)}`, x.eta ? `大约 ${x.eta} 个月攒够` : x.state === 'ready' ? '攒够了，可以买' : ''] })),
  ];
  const usable = [
    { key: 'free', name: '自由存款', amount: m.free.have, color: 'var(--jar-w1)',
      fill: m.free.have < FREE_KEEP ? m.free.have / FREE_KEEP : (m.free.have - FREE_KEEP) / FAMILY_STEP, warn: m.free.have < FREE_KEEP,
      lines: m.free.have < FREE_KEEP ? [`还差 ${money(FREE_KEEP - m.free.have)} 到 ${money(FREE_KEEP)} 兜底`] : [`留 ${money(FREE_KEEP)} 兜底`, `再存 ${money(freeNext)} 封存一万`] },
    { key: 'wish', name: '心愿基金', amount: m.wish.small, color: 'var(--jar-w2)', fill: m.wish.small / WISH_CAP, href: '#/wishes',
      lines: [m.wish.small >= WISH_CAP ? `满 ${jarMoney(WISH_CAP)} 了，再进来的算存款` : `现在能随便用的，最多攒到 ${jarMoney(WISH_CAP)}`] },
  ];
  const month = [
    { key: 'living', name: '生活费还剩', amount: left, color: 'var(--jar-g)', fill: lb ? left / lb : 0, warn: c.left < 0, href: '#/',
      lines: [`这个月预算 ${money(lb)}`, '没花完的月底进心愿基金'] },
  ];
  const sum = (xs) => xs.reduce((a, x) => a + Math.max(0, x.amount), 0);
  const total = sum(kept) + sum(usable) + sum(month);
  // 一张卡里可以并排几组（能自由用 | 这个月），点开的说明放在整张卡下面
  const jarBtn = (x) => h('button', {
    type: 'button', class: `jar${x.key === moneyOpen ? ' on' : ''}`, 'aria-expanded': String(x.key === moneyOpen), 'aria-label': `${x.name} ${money(x.amount)}`,
    onclick: () => { moneyOpen = moneyOpen === x.key ? null : x.key; render(); },
  }, jarSvg(x.fill, x), h('span', { class: 'jar-name' }, x.name), h('span', { class: 'jar-amt' }, jarMoney(x.amount)));
  const jarCard = (sections) => {
    const open = sections.flatMap((g) => g.jars).find((x) => x.key === moneyOpen);
    const side = sections.length > 1;
    return h('section', { class: `jar-group${side ? ' side' : ''}` },
      side ? null : h('div', { class: 'jar-head' }, h('span', {}, sections[0].title), h('b', {}, jarMoney(sum(sections[0].jars)))),
      h('div', { class: 'card jar-card' },
        h('div', { class: 'jar-row', style: side ? `grid-template-columns:${sections.map((g) => `${g.jars.length}fr`).join(' 1px ')}` : '' },
          sections.map((g, i) => [i ? h('span', { class: 'jar-divider' }) : null,
            h('div', { class: 'jar-part' },
              side ? h('div', { class: 'jar-head in' }, h('span', {}, g.title), h('b', {}, jarMoney(sum(g.jars)))) : null,
              h('div', { class: 'jar-grid' }, g.jars.map(jarBtn)))])),
        open ? h('div', { class: 'jar-detail' },
          h('div', { class: 'jar-detail-top' }, h('b', {}, open.name), h('span', {}, money(open.amount))),
          open.lines.filter(Boolean).slice(0, 2).map((l) => h('p', {}, l)),
          open.href ? h('a', { class: 'small', href: open.href }, '去看看 ›') : null) : null));
  };
  return h('div', {},
    inSummary ? headerSub('钱都在哪', '每一类钱有多少、存到哪了', flipButton(), helpButton('钱都在哪', MONEY_HELP))
      : headerSub('钱都在哪', '每一类钱有多少、存到哪了', helpButton('钱都在哪', MONEY_HELP)),
    h('div', { class: 'card money-total' },
      h('div', { class: 'muted small' }, '一共'),
      bigMoney(total)),
    jarCard([{ title: '存着不动', jars: kept }]),
    jarCard([{ title: '能自由用', jars: usable }, { title: '这个月', jars: month }]));
}

// ---------- 花钱方式（含预算） ----------

// 一年的账：收入 × 发钱的月数 − 预算 × 12
function yearPlan(d) {
  const inc = Number(d.settings.expectedIncome) || 0;
  const paidMonths = 12 - (d.settings.summerMonths || []).length;
  const yearIn = inc * paidMonths;
  const yearOut = budgetTotal(d) * 12;
  return { inc, paidMonths, yearIn, yearOut, rate: yearIn ? Math.round(((yearIn - yearOut) / yearIn) * 100) : null };
}

const RULES_HELP = [
  ['这一页', ['最上面是每月预算，点「改」直接改。下面几条是定下来的规矩，点开看怎么做、为什么。', '每月正常收入、应急钱底线在对应那条规矩里改。']],
  ['调整建议', ['网站看最近 3 个完整的预算月（开始记账那个月和暑假不算）：一直有富余的建议调低（多出来的进存款），总是超的建议调高（定得太紧容易放弃）。订阅按每月扣的实际金额算（年费在专项里，不算）。有建议时出现在预算上面。', '调低预算 = 多存钱，但每月进心愿基金的结余会少一些。要不要采用你来定，「这个月先不改」下个预算月会再看一次。']],
  ['改了会怎样', ['首页的「还能花」「花钱节奏」「本月存钱」都会按新数字算。以前的流水不受影响。']],
];

let budgetEditing = false; // 预算那张卡正在改（只在内存）

// 花钱方式（2026-10-25 和预算合成一页）：最上面每月预算（点「改」就地改），下面规矩折起来，最后一年下来。
// 规矩都从账本数据里生成（具体的收入、说明写在私有的 finance.json，代码里不放个人信息）
function rulesView() {
  const d = store.data;
  const b = d.budget;
  const plan = yearPlan(d);
  const months = d.settings.summerMonths || [];
  const reserve = plan.paidMonths < 12 ? Math.round((budgetTotal(d) * (12 - plan.paidMonths)) / plan.paidMonths) : 0;
  const floorName = account(d, d.settings.floorAccount)?.name || '存钱卡';
  const rules = [];
  const R = (title, text, why, extra = null) => rules.push([title, text, why, extra]);
  const incomeRow = setRow('每月正常收入', 'expectedIncome', `用来估「本月存钱」和一年能存多少。${months.length ? `${months.join('、')} 月不发，按 0 算。` : ''}`);
  R('先存后花', '钱一到账，先把要存的留下，剩下的才是能花的。', '等月底看剩多少再存，通常就剩不下了。先存的话，存钱这件事就不靠意志力。');
  if (d.incomePlan.length) {
    R(`${d.incomePlan.length} 笔收入，各管一件事`,
      [`收入都打到${floorName}（存钱卡）。`, ...d.incomePlan.map((x) => `${x.name} ${money(x.amount)}${x.when ? `（${x.when}）` : ''}：${x.use || ''}`)].join('\n'),
      '每笔钱分工明确，最好记，也最不容易乱花。', incomeRow);
  } else {
    R('收入', `收入都打到${floorName}（存钱卡）。`, null, incomeRow);
  }
  if (b.look) R('形象', `每月 ${money(b.look)}，买护肤品、化妆品、香水这些。按「生活」网站形象路线图一样一样慢慢买，不追大牌。`, '对自己的投资是必要的，但别过火。单独一块预算，买的时候心里有数，也不会挤占日常的钱。');
  if (b.free) R('自由钱', `每月 ${money(b.free)}，想喝杯奶茶、买点小东西，花了就花了，不用想。`, '一点余地都不留的预算很难坚持，一旦超了就容易破罐破摔。留一小块不用记挂的钱，反而能长期存下去。');
  R('心愿单：只花省下来的钱', `想买但不急的东西先放进心愿单，冷静 ${d.settings.coolDays} 天。每个预算月生活费没花完的进「心愿基金」，超支先从这里扣（留 ${money(WISH_KEEP)}）。${money(d.settings.wishBigFrom)} 以内的小额心愿直接用它买；超过的大额心愿确定要买了再「开始攒」，从心愿基金每次进账里分 1/3，一次攒一个，攒够才买。`,
    '省下来的钱有了用处，省钱更有动力；心愿不碰存款，存钱计划不会被打乱。');
  R('存款按用途分好', `${floorName}里的钱按顺序留：家庭存款（封存）→ 应急底线 → 医疗备用金 ${money(medTarget(d))} → 专项存款（日子最近的先）→ 自由存款（留 ${money(FREE_KEEP)} 兜底，超过的每凑够 ${money(FAMILY_STEP)} 封存进家庭存款）。钱不够时反过来扣。`,
    '每一块钱都有用处，到日子要用的钱提前留好；只有自由存款是真正能自由用的。');
  R(d.settings.emergencyFloor > 0 ? `应急钱不低于 ${money(d.settings.emergencyFloor)}` : '应急钱',
    `${floorName}里至少留一笔，专门应付意外（生病、电脑坏了、收入晚到）。买东西不能动它。`, '有这笔钱在，意外来了也不会慌，不用借钱。',
    setRow('应急钱底线', 'emergencyFloor', `${floorName}不低于这个数。`));
  if (months.length) {
    R(`${months.join('、')} 月没有收入`, `一年只有 ${plan.paidMonths} 个月有收入，但 12 个月都要花钱。所以有收入的月份每月要多留约 ${money(reserve)}，到时候从存钱卡转生活费出来。「专项存款」里自动有一个「暑假生活费」，能看到留够了没有。`, '不提前留，到时候会觉得存款在「变少」，其实是计划内的。');
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

  const rule = ([title, text, why, extra]) => h('details', { class: 'rule-item' }, h('summary', {}, title),
    text.split('\n').map((t) => h('p', {}, t)), why ? h('p', { class: 'why' }, `为什么：${why}`) : null, extra);
  const advice = budgetAdvice(d, today(), usdRate()).items.length;
  return h('div', {},
    headerSub('花钱方式', '这几条是我们一起定下来的。哪天不确定「我这样花对不对」，就回来看看。', helpButton('这一页怎么用', RULES_HELP)),
    advice ? adviceCard() : null,
    budgetEditing ? budgetForm() : budgetTable(),
    h('div', { class: 'section-title' }, '规矩', h('span', { class: 'muted' }, ' · 点开看为什么')),
    rules.map(rule),
    plan.yearIn ? h('div', { class: 'card rule' }, h('h2', {}, '一年下来'),
      h('p', {}, `收入 ${money(plan.yearIn)}（${plan.inc.toLocaleString('zh-CN')} × ${plan.paidMonths} 个月）− 花销 ${money(plan.yearOut)}（${budgetTotal(d).toLocaleString('zh-CN')} × 12 个月）= 能存约 ${money(plan.yearIn - plan.yearOut)}，储蓄率 ${plan.rate}%。`),
      h('p', { class: 'why' }, '常见的建议是存 20%。')) : null);
}

const BUDGET_KEYS = ['food', 'daily', 'free', 'look', 'sub'];
const budgetCats = (g) => store.data.categories.filter((c) => c.group === g && !c.hidden).map((c) => c.name).join('、');

// 每月预算：平时是一张表，右上角「改」
function budgetTable() {
  const d = store.data;
  const b = d.budget;
  return h('div', { class: 'card rule budget-plan' },
    h('div', { class: 'card-head' }, h('h2', {}, `每月预算 ${money(budgetTotal(d))}`),
      h('button', { class: 'link small', onclick: () => { budgetEditing = true; render(); } }, '改')),
    h('table', { class: 'rule-table' }, h('tbody', {}, GROUPS.filter((g) => BUDGET_KEYS.includes(g.id) && b[g.id]).map((g) =>
      h('tr', {}, h('td', {}, g.name), h('td', {}, money(b[g.id])), h('td', {}, [budgetCats(g.id), d.notes[g.id]].filter(Boolean).join('。')))))),
    h('p', {}, d.settings.periodStartDay > 1 ? `预算月从每月 ${d.settings.periodStartDay} 号算到下个月 ${d.settings.periodStartDay - 1} 号，和发钱对齐：钱到了，新的一个月就开始了。` : '预算月就是自然月。'),
    h('p', { class: 'why' }, '为什么分组：吃饭是最大的一块，单独看最清楚；其他日常只管总数，不用每一类都操心。'));
}

// 点「改」以后：五组变成输入框
function budgetForm() {
  const d = store.data;
  const inputs = {};
  const field = (label, key) => {
    inputs[key] = h('input', { inputmode: 'decimal', value: String(d.budget[key] ?? 0), 'aria-label': label });
    return h('label', {}, label, inputs[key], h('div', { class: 'hint' }, budgetCats(key)));
  };
  const submit = async () => {
    const val = (k) => Number(inputs[k].value.replace(/[，,\s]/g, ''));
    if (Object.keys(inputs).some((k) => !Number.isFinite(val(k)) || val(k) < 0)) return toast('金额要填数字', 'error');
    try {
      await save('改预算', (data) => { for (const k of Object.keys(inputs)) data.budget[k] = val(k); });
      budgetEditing = false;
      toast('预算改好了，从现在起按新的算');
      render();
    } catch { /* 已提示 */ }
  };
  return h('div', { class: 'card form budget-plan' },
    h('h2', {}, '每月预算'),
    GROUPS.filter((g) => BUDGET_KEYS.includes(g.id)).map((g) => field(g.name, g.id)),
    h('p', { class: 'muted small' }, '手续费不占预算，但算花销。'),
    h('div', { class: 'actions' },
      h('button', { onclick: submit }, '保存'),
      h('button', { class: 'secondary', onclick: () => { budgetEditing = false; render(); } }, '取消')));
}

// 规矩里能改的一个数（每月正常收入、应急钱底线）：点「改」弹出来填
function setRow(label, key, hint) {
  const d = store.data;
  const edit = () => {
    const input = h('input', { inputmode: 'decimal', value: String(d.settings[key] ?? 0), 'aria-label': label });
    openSheet({
      title: label, body: h('div', { class: 'form' }, input, h('p', { class: 'muted small' }, hint)), confirmText: '保存',
      onConfirm: async () => {
        const n = Number(input.value.replace(/[，,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0) { toast('金额要填数字', 'error'); return false; }
        try { await save(`改${label}`, (data) => { data.settings[key] = n; }); } catch { return false; }
        toast('已保存');
        render();
        return true;
      },
    });
    setTimeout(() => input.focus());
  };
  return h('div', { class: 'set-row' }, h('span', { class: 'grow' }, label), h('b', {}, money(d.settings[key] || 0)),
    h('button', { class: 'link small', 'aria-label': `改${label}`, onclick: edit }, '改'));
}

// 预算调整建议卡片（花钱方式最上面，有建议时才放）
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
    h('button', { class: 'link small', onclick: askAi }, '想聊聊怎么调？问问 AI →'));
}

// ---------- 导出 ----------

const TX_TYPE = { expense: '支出', income: '收入', transfer: '转账', adjust: '对账差额', advance: '垫付/借出', repay: '报销到账/还我', payback: '我还别人', writeoff: '垫付结清差额' };
const TX_HEAD = ['日期', '类型', '类别', '金额', '币种', '折合人民币', '账户', '转入账户', '到账金额', '垫付的事 / 人', '备注'];
// 一笔账在 Excel 里的一行（导出账目、报表的明细共用）
function txExcelRow(t) {
  const d = store.data;
  return [t.date, TX_TYPE[t.type], t.category ? `${catName(t.category)}${t.what ? `：${t.what}` : ''}` : '', t.amount, isUsd(d, t.account) ? 'USD' : 'CNY',
    ['expense', 'income', 'writeoff'].includes(t.type) ? cny(t) : '', t.account ? accName(t.account) : '', t.to ? accName(t.to) : '', t.toAmount ?? '',
    t.claim ? claimName(t.claim) : t.person ? personName(t.person) : '', t.note || ''];
}
function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function exportExcel() {
  const rows = [TX_HEAD, ...[...store.data.tx].sort((a, b) => a.date.localeCompare(b.date)).map(txExcelRow)];
  downloadBlob(makeXlsx(rows, '账目'), `账目-${today()}.xlsx`);
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
        h('li', {}, 'AI 密钥存在数据仓库里，令牌删了别人也拿不到了。不放心的话去 DeepSeek 后台换一个新密钥，在物品档案「设置 → AI」里更新。'))),
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
