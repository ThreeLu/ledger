// 钱怎么分（2026-10-08 定的方案）：直接测 money.js 的计算，不开浏览器。数字都是编的。
//   node tests/test_money.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../js/money.js', import.meta.url));
const sm = await import(new URL('../js/summary.js', import.meta.url));
const rp = await import(new URL('../js/report.js', import.meta.url));
const rc = await import(new URL('../js/bills.js', import.meta.url));
const ah = await import(new URL('../js/ahead.js', import.meta.url));
const fc = await import(new URL('../js/forecast.js', import.meta.url));
const ml = await import(new URL('../js/meals.js', import.meta.url));

let n = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; }
};

// 预算月 1 号开始，生活预算 2300（吃饭 1500 + 日常 500 + 自由钱 300），8 月 1 日开始记账
function book() {
  const d = m.defaultData();
  m.migrate(d);
  Object.assign(d.settings, { periodStartDay: 1, expectedIncome: 5000, summerMonths: [], floorAccount: 'a-save', emergencyFloor: 3000 });
  d.budget = { food: 1500, daily: 500, free: 300, look: 0, sub: 200 };
  d.openingDate = '2026-08-01';
  d.accounts.find((a) => a.id === 'a-save').opening = 10000;
  d.wishes = [];
  d.tx = [];
  return d;
}
// 只看存款怎么分时：生活预算设成 0，这样心愿基金和这个月的生活费都是 0，所有的钱都在存款这边
function savingsBook() {
  const d = book();
  Object.assign(d.budget, { food: 0, daily: 0, free: 0, look: 0 });
  return d;
}
let id = 0;
const ex = (date, amount, category = 'c-lunch', extra = {}) => ({ id: `t${++id}`, type: 'expense', date, account: 'a-live', amount, category, ...extra });
const inc = (date, amount, category = 'i-salary', account = 'a-save') => ({ id: `t${++id}`, type: 'income', date, account, amount, category });
const wish = (wid, price, extra = {}) => ({ id: wid, name: wid, price, createdAt: '2026-08-01', status: 'open', ...extra });
const T = '2026-10-08';

test('生活费结余进心愿基金；没有正在攒的大额心愿时全部进「能随便用」', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-05', 2100)];
  const f = m.wishFunds(d, T);
  assert.equal(f.small, 500);
  assert.equal(f.total, 500);
  assert.deepEqual(f.parts.saved, 500);
});

test('开始攒：拿 100；之后每次进账 1/3 给它；一次只攒一个，第二个排队', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-05', 2000)]; // 8 月、9 月各省 300
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-09-02' }), wish('键盘', 600, { saveStart: '2026-09-03' })];
  const f = m.wishFunds(d, T);
  assert.equal(f.env['耳机'], 200); // 100 + 300 × 1/3
  assert.equal(f.env['键盘'], 0);
  assert.equal(f.small, 400); // 300 − 100 + 200
  assert.equal(f.saving, '耳机');
  assert.deepEqual(f.waiting, ['键盘']);
  const plan = m.bigWishPlan(d, T);
  assert.equal(plan.find((x) => x.w.id === '键盘').state, 'waiting');
  assert.equal(plan.find((x) => x.w.id === '耳机').state, 'saving');
});

test('能随便用不到 100 时排着的开始不了，到了 100 才拿', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2240), ex('2026-09-05', 2240)]; // 每月省 60
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-09-02' })];
  const f = m.wishFunds(d, T);
  // 9 月 2 日只有 60，等着；9 月底又进 60 → 120，拿 100 开始
  assert.equal(f.env['耳机'], 100);
  assert.equal(f.small, 20);
});

test('攒够了下一个接着攒；买的比攒的便宜，多的退回能随便用', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 1100), ex('2026-09-05', 1400)]; // 8 月省 1200，9 月省 900
  d.wishes = [wish('台灯', 301, { saveStart: '2026-08-02', status: 'bought', boughtAt: '2026-10-01', boughtPrice: 250 }), wish('耳机', 1200, { saveStart: '2026-08-03' })];
  const f = m.wishFunds(d, T);
  // 8 月 2 日基金是 0，台灯等着；8 月底 +1200 → 台灯拿 100；9 月底 +900 → 1/3 里台灯只差 201 → 攒够，耳机接着拿 100
  assert.equal(f.env['耳机'], 100);
  assert.equal(f.small, 1200 - 100 + 900 - 201 - 100 + 51); // 台灯 250 买的，攒了 301，退回 51
  assert.equal(f.parts.spent, -250);
  assert.equal(f.total, 1200 + 900 - 250);
});

test('不想要了：攒的全部退回能随便用，下一个开始', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-05', 2000)];
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-08-02', status: 'dropped', droppedAt: '2026-10-02' }), wish('键盘', 600, { saveStart: '2026-08-03' })];
  const f = m.wishFunds(d, T);
  assert.equal(f.total, 600);
  assert.equal(f.saving, '键盘');
  assert.equal(f.env['键盘'], 100);
  assert.equal(f.small, 500);
});

test('上个预算月放下的心愿删掉；攒过钱的删掉后心愿基金的数不变', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-05', 2000)];
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-08-02', status: 'dropped', droppedAt: '2026-09-02' }), wish('键盘', 600, { saveStart: '2026-08-03' }),
    wish('杯子', 30, { status: 'dropped', droppedAt: T })];
  const before = m.wishFunds(d, T);
  const old = m.expiredDrops(d, T).map((w) => w.id);
  assert.deepEqual(old, ['耳机']); // 这个预算月放下的杯子还留着
  m.forgetDrops(d, old, T);
  assert.deepEqual(d.wishes.map((w) => w.id), ['键盘', '杯子']);
  assert.equal(d.wishTrail.length, 1);
  assert.equal(d.wishTrail[0].name, undefined);
  const after = m.wishFunds(d, T);
  assert.equal(after.small, before.small);
  assert.equal(after.env['键盘'], before.env['键盘']);
  assert.equal(after.total, before.total);
});

test('放回来：回到心愿单；大额的重新从只在单子上开始，心愿基金的数不变', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-05', 2000)];
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-08-02', status: 'dropped', droppedAt: '2026-10-02' }), wish('键盘', 600, { saveStart: '2026-08-03' })];
  const before = m.wishFunds(d, T);
  m.restoreWish(d, '耳机', T);
  const w = d.wishes.find((x) => x.id === '耳机');
  assert.equal(w.status, 'open');
  assert.equal(w.saveStart, undefined);
  assert.equal(w.droppedAt, undefined);
  const after = m.wishFunds(d, T);
  assert.equal(after.small, before.small);
  assert.equal(after.total, before.total);
  assert.equal(after.env['耳机'], undefined);
});

test('超支先扣能随便用，只扣到 100；攒着的不扣；扣不动的由存款补', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 1700), ex('2026-09-05', 2900)]; // 8 月省 600，9 月超 600
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-08-02' })];
  const f = m.wishFunds(d, T);
  // 8 月底：600 → 耳机 1/3 = 200，能随便用 400；8 月 2 日时基金是 0，耳机在 8 月底那笔之后才拿 100
  assert.equal(f.env['耳机'], 100);
  assert.equal(f.small, 100);
  assert.equal(f.spill, 600 - 400);
});

test('看病买药从医疗备用金出，不占生活预算；超了先扣心愿基金；存钱卡的收入先补满', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-03', 1200, 'c-doctor'), ex('2026-09-05', 2300)];
  const st = m.periodStats(d, m.periodFor(d, '2026-09-10'));
  assert.equal(st.living, 2300);
  assert.equal(st.spent.med, 1200);
  let f = m.wishFunds(d, T);
  assert.equal(f.med, 0);
  assert.equal(f.small, 300 - 200); // 超出的 200 从能随便用扣（留 100）
  d.tx.push(inc('2026-09-15', 5000));
  f = m.wishFunds(d, T);
  assert.equal(f.med, 1000);
  assert.equal(m.savingsMap(d, T).medical.have, 1000);
});

test('专项：记在专项里的不占预算；超了先扣心愿基金；办完了结余回自由存款', () => {
  const d = book();
  d.goals = [{ id: 'g1', name: '考研报名', target: 300, by: '2026-11-01' }];
  d.tx = [ex('2026-08-05', 1500), ex('2026-09-05', 350, 'c-print', { special: 'g1' })];
  const st = m.periodStats(d, m.periodFor(d, '2026-09-10'));
  assert.equal(st.living, 0);
  const f = m.wishFunds(d, T);
  assert.equal(f.small, 800 + 2300 - 50); // 8 月省 800，9 月一分没花省 2300，专项超的 50 从基金扣
  const before = m.savingsMap(d, T).free.have;
  d.goals[0].status = 'done';
  assert.equal(m.savingsMap(d, T).free.have, before); // 专项已经花完，没有留着的了
});

test('大额人情：还的时候不占预算，从专项出', () => {
  const d = book();
  d.people = [{ id: 'p1', name: '小甲' }];
  d.favors = [{ id: 'f1', person: 'p1', dir: 'owe', text: '婚礼随礼', date: '2026-09-01', createdAt: '2026-09-01', status: 'done', estimate: 600, doneAt: '2026-09-20' }];
  d.tx = [ex('2026-09-20', 800, 'c-hongbao', { favor: 'f1' })];
  assert.equal(m.txGroup(d, d.tx[0]), 'none');
  assert.equal(m.periodStats(d, m.periodFor(d, '2026-09-20')).living, 0);
  const f = m.wishFunds(d, T);
  assert.equal(f.parts.cover, -Math.min(200, Math.max(0, 2300 - 100))); // 超了 200 先扣心愿基金
});

test('心愿基金按月看：每一类进出加起来就是月初到月底的变化，能随便用的数对得上；省下率 = 省下 ÷ 生活预算', () => {
  const d = book();
  d.wishes = [wish('w-big', 600, { saveStart: '2026-08-20' })];
  d.tx = [ex('2026-08-05', 2000), inc('2026-08-25', 1000, 'i-job', 'a-live'), ex('2026-09-05', 2400),
    ex('2026-09-10', 50, 'c-wish', { wishKind: 'small' }), ex('2026-10-03', 100)];
  d.settings.sideIncomeSave = 0.7;
  const f = m.wishFunds(d, T);
  assert.equal(Math.round(f.flow.reduce((a, x) => a + x.v, 0) * 100) / 100, f.small);
  for (const day of ['2026-08-15', '2026-09-15', T]) {
    const w = sm.wishMonth(d, m.periodFor(d, day), T);
    assert.equal(Math.round((w.start + w.rows.reduce((a, x) => a + x.v, 0)) * 100) / 100, w.end);
  }
  const aug = sm.wishMonth(d, m.periodFor(d, '2026-08-15'), T);
  assert.equal(aug.rate.leftover, 300);
  assert.equal(Math.round(aug.rate.rate * 1000), Math.round((300 / 2300) * 1000));
  assert.ok(aug.rows.some((x) => x.k === 'jobs' && x.v === 300));
  assert.ok(aug.rows.some((x) => x.k === 'toBig' && x.v < 0));
  const sep = sm.wishMonth(d, m.periodFor(d, '2026-09-15'), T);
  assert.ok(sep.rows.some((x) => x.k === 'over' && x.v < 0) && sep.rows.some((x) => x.k === 'wish' && x.v === -50));
  const oct = sm.wishMonth(d, m.periodFor(d, T), T);
  assert.ok(oct.ongoing && oct.rate === null && oct.livingNow === 2200);
  assert.equal(oct.end, f.small);
  assert.equal(oct.hist.length, 3);
});

test('存款的顺序：家庭 → 应急 → 医疗 → 专项（日子近的先）→ 自由；凑够一万封存', () => {
  const d = savingsBook();
  d.accounts.find((a) => a.id === 'a-save').opening = 30000;
  d.family = { sealed: 10000, log: [] };
  d.goals = [{ id: 'far', name: '过渡金', target: 5000, by: '2030-06-01' }, { id: 'near', name: '报名费', target: 500, by: '2026-11-01' }];
  const s = m.savingsMap(d, T);
  assert.equal(s.family.have, 10000);
  assert.equal(s.emergency.have, 3000);
  assert.equal(s.medical.have, 1000);
  assert.deepEqual(s.specials.map((x) => x.id), ['near', 'far']);
  assert.equal(s.free.have, 30000 - 10000 - 3000 - 1000 - 500 - 5000);
  assert.equal(s.sealable, 0); // 10500 − 2000 不够一万
  d.accounts.find((a) => a.id === 'a-save').opening = 32000;
  assert.equal(m.savingsMap(d, T).sealable, 10000);
  // 钱不够时：最远的专项先让
  d.accounts.find((a) => a.id === 'a-save').opening = 16000;
  const t = m.savingsMap(d, T);
  assert.equal(t.specials.find((x) => x.id === 'near').have, 500);
  assert.equal(t.specials.find((x) => x.id === 'far').have, 1500);
  assert.equal(t.free.have, 0);
});

test('暑假生活费：平时留下个暑假的；暑假里按日子，到了哪个月那个月就是生活费，后面的继续留着（和转没转账无关）', () => {
  const d = book();
  d.settings.summerMonths = [7, 8];
  const before = m.summerGoal(d, '2026-10-08');
  assert.equal(before.target, 2500 * 2);
  assert.equal(before.by, '2027-06-30');
  assert.equal(m.summerGoal(d, '2027-07-03').target, 2500); // 7 月的已经是这个月的生活费，留 8 月的
  d.tx.push({ id: 'tr', type: 'transfer', date: '2027-07-02', account: 'a-save', to: 'a-live', amount: 2300 });
  assert.equal(m.summerGoal(d, '2027-07-03').target, 2500); // 转不转账都一样
  assert.equal(m.summerGoal(d, '2027-08-03').name, '2028 年暑假生活费'); // 最后一个暑假月：开始留下一个暑假的
  assert.equal(m.summerGoal(d, '2027-09-03').name, '2028 年暑假生活费');
});
test('和卡无关：钱在哪个账户都一样分；一共 = 所有账户（美元按汇率）+ 别人欠我 − 我欠别人', () => {
  const d = savingsBook();
  d.accounts.find((a) => a.id === 'a-save').opening = 5000;
  d.accounts.find((a) => a.id === 'a-live').opening = 3000;
  d.accounts.push({ id: 'a-usd', name: 'USD', currency: 'USD', opening: 100 });
  const s = m.savingsMap(d, T, 7);
  assert.equal(s.all, 5000 + 3000 + 700);
  assert.equal(s.emergency.have, 3000);
  assert.equal(s.medical.have, 1000);
  assert.equal(s.free.have, 8700 - 4000);
  // 钱挪到另一张卡：一分不变
  d.tx.push({ id: 'mv', type: 'transfer', date: '2026-10-02', account: 'a-save', to: 'a-live', amount: 4000 });
  assert.equal(m.savingsMap(d, T, 7).free.have, 4700);
});

test('心愿基金和这个月生活费还剩的先留出来，剩下的才是存款', () => {
  const d = book(); // 生活预算 2300；8、9 月没花 → 心愿基金 4600；10 月还剩 2300
  const s = m.savingsMap(d, T, 7);
  assert.equal(s.wish.total, 4600);
  assert.equal(s.living, 2300);
  assert.equal(s.bal, 10000 - 4600 - 2300);
});

test('任何收入都先补医疗备用金；一次性的钱不算收入、不进心愿基金，直接进存款', () => {
  const d = savingsBook();
  d.accounts.find((a) => a.id === 'a-save').opening = 6000;
  d.categories.push({ id: 'i-lump', name: '编的补助', kind: 'income', lump: true });
  d.tx = [ex('2026-10-02', 400, 'c-doctor'), inc('2026-10-03', 300, 'i-gift', 'a-live')];
  assert.equal(m.wishFunds(d, T).med, 1000 - 400 + 300); // 红包进生活费那边也补
  d.tx.push(inc('2026-10-04', 5000, 'i-lump', 'a-save'));
  const st = m.periodStats(d, m.periodFor(d, T));
  assert.equal(st.income, 300); // 补助不算这个月的收入
  assert.equal(m.wishFunds(d, T).small, 0);
  const s = m.savingsMap(d, T, 7);
  assert.equal(s.free.have, 6000 - 400 + 300 + 5000 - 3000 - 1000);
});

test('对账和卡无关：一边多一边少只改余额；加起来少了记在 spend 上算漏记的花销；多了直接进存款', () => {
  const d = book();
  const adj = (idx, account, amount, extra = {}) => ({ id: `a${idx}`, type: 'adjust', date: '2026-10-05', account, amount, rec: 'r1', ...extra });
  d.tx = [adj(1, 'a-wechat', -200), adj(2, 'a-live', 200)];
  let st = m.periodStats(d, m.periodFor(d, T));
  assert.equal(st.living, 0);
  d.tx = [adj(1, 'a-save', -500, { spend: 300 }), adj(2, 'a-live', 200)]; // 加起来少 300
  st = m.periodStats(d, m.periodFor(d, T));
  assert.equal(st.spent.daily, 300);
  d.tx = [adj(1, 'a-save', 800)];
  st = m.periodStats(d, m.periodFor(d, T));
  assert.equal(st.total, 0);
  assert.equal(st.income, 0);
});
test('欠别人的钱先从存款里扣掉；封存家庭存款不算别人还欠我的', () => {
  const d = savingsBook();
  d.accounts.find((a) => a.id === 'a-save').opening = 17000;
  d.people = [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }];
  d.tx = [ex('2026-10-02', 2000, 'c-lunch', { account: null, person: 'p1' }), // 甲帮我付的，我欠他
    { id: 'adv', type: 'advance', date: '2026-10-03', account: 'a-save', amount: 3000, person: 'p2' }]; // 借给乙，还没还
  const s = m.savingsMap(d, T);
  assert.equal(s.iOwe, 2000);
  assert.equal(s.toMe, 3000);
  assert.equal(s.free.have, 17000 - 3000 + 3000 - 2000 - 3000 - 1000); // 余额 14000 + 3000 − 2000 − 应急 − 医疗
  assert.equal(s.sealable, 0); // 自由存款 11000 里有 3000 还没回来，真在卡里的只有 8000
  d.accounts.find((a) => a.id === 'a-save').opening = 21000; // 自由存款 15000，真在卡里的 12000 → 留 2000、封存一万
  assert.equal(m.savingsMap(d, T).sealable, 10000);
});

test('首页应急钱：封存的家庭存款先保着、欠别人的先扣掉', () => {
  const d = savingsBook();
  d.accounts.find((a) => a.id === 'a-save').opening = 12000;
  d.family = { sealed: 10000, log: [] };
  d.people = [{ id: 'p1', name: '甲' }];
  d.tx = [ex('2026-10-02', 2000, 'c-lunch', { account: null, person: 'p1' })];
  const floor = m.health(d, T, 7).items.find((x) => x.key === 'floor');
  assert.equal(floor.level, 'bad');
  assert.match(floor.text, /只留到 ¥0/);
});

test('用以前留好的钱花的（专项、心愿）不打断存钱达标；看病照算但首页不催', () => {
  const d = book();
  d.goals = [{ id: 'g1', name: '随礼', target: 2000, by: '2026-09-20' }];
  d.tx = [inc('2026-08-02', 5000), ex('2026-08-05', 2300), inc('2026-09-02', 5000), ex('2026-09-05', 2300), ex('2026-09-10', 2000, 'c-gift', { special: 'g1' }),
    ex('2026-09-12', 300, 'c-wish', { wishKind: 'small' })];
  const st = m.periodStats(d, m.periodFor(d, '2026-09-10'));
  assert.equal(st.saved, 5000 - 2300 - 2000 - 300);
  assert.equal(st.fromSaved, 2300);
  assert.equal(st.planSaved, 5000 - 2300);
  assert.equal(m.saveStreak(d, T), 2); // 目标 5000 − 2500 = 2500，两个月都达标
  d.tx.push(inc('2026-10-02', 5000), ex('2026-10-03', 1500, 'c-doctor'));
  const saving = m.health(d, '2026-10-03', 7).items.find((x) => x.key === 'saving');
  assert.equal(saving.level, 'good');
});

test('对账：生活费卡这边少了的算漏记的日常花销（先扣心愿基金）；存钱卡的差额只改余额', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), { id: 'adj', type: 'adjust', date: '2026-08-31', account: 'a-wechat', amount: -200 },
    { id: 'adj2', type: 'adjust', date: '2026-08-31', account: 'a-save', amount: -500 }];
  const st = m.periodStats(d, m.periodFor(d, '2026-08-10'));
  assert.equal(st.living, 2200);
  assert.equal(st.spent.daily, 200);
  assert.equal(st.byCat[m.ADJUST_CAT], 200);
  assert.equal(m.wishFunds(d, T).parts.saved, 100 + 2300); // 8 月只省 100，9 月一分没花
});

test('记账时勾了「用心愿基金的钱」：类别照常，不占生活预算，从能随便用里扣；大额心愿攒着的不动', () => {
  const d = book();
  d.tx = [ex('2026-08-05', 2000), ex('2026-09-05', 2000)]; // 省下 600
  d.wishes = [wish('耳机', 1200, { saveStart: '2026-09-02' })];
  const before = m.wishFunds(d, T);
  d.tx.push(ex('2026-10-03', 80, 'c-clothes', { wishFund: true }));
  const f = m.wishFunds(d, T);
  assert.equal(f.small, before.small - 80);
  assert.equal(f.env['耳机'], before.env['耳机']);
  const st = m.periodStats(d, m.periodFor(d, '2026-10-03'));
  assert.equal(st.living, 0);
  assert.equal(st.fromSaved, 80);
  assert.equal(st.spent.none, 80);
});

test('能随便用的满 1 万就不再进：多的算存款；给大额心愿攒的不受影响；来源加起来还是等于合计', () => {
  const d = book();
  d.tx = [inc('2026-08-03', 20000, 'i-job', 'a-live')]; // 兼职 20000，三成 = 6000 进心愿基金，加上两个月结余超过 1 万
  d.settings.sideIncomeSave = 0.7;
  d.tx.push(ex('2026-08-05', 0.01)); // 8、9 月几乎没花：各省 2300
  const f = m.wishFunds(d, T);
  assert.equal(f.small, m.WISH_CAP);
  const sum = Object.values(f.parts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - f.total) < 0.02, `${sum} vs ${f.total}`);
  assert.ok(f.parts.toFree < 0);
  // 有正在攒的大额心愿：照样分 1/3 给它
  d.wishes = [wish('相机', 5000, { saveStart: '2026-08-01' })];
  d.tx.unshift(inc('2026-07-20', 300, 'i-job', 'a-live'));
  const g = m.wishFunds(d, T);
  assert.ok(g.env['相机'] > 100);
  assert.ok(g.small <= m.WISH_CAP);
});

test('每年一次的专项：这一年的不用交就跳过；办完了 / 花够了，马上生成下一年的', () => {
  const d = savingsBook();
  d.yearly = [{ id: 'fee', name: '学费', amount: 8000, month: 9, day: 20, skip: [2026] }, { id: 'room', name: '住宿费', amount: 1200, month: 10, day: 20, category: 'c-other' }];
  const due = m.yearlyDue(d, '2026-10-16');
  assert.deepEqual(due.map((g) => g.id), ['y-fee-2027', 'y-room-2026']); // 2026 年学费不用交
  assert.equal(due[1].by, '2026-10-20');
  assert.equal(due[1].category, 'c-other');
  d.goals.push(...due);
  assert.equal(m.yearlyDue(d, '2026-10-16').length, 0); // 不重复生成
  assert.equal(m.savingsMap(d, '2026-10-16').specials.length, 2);
  // 住宿费花够了 → 算办完 → 下一年的出来
  d.tx = [{ id: 'p1', type: 'expense', date: '2026-10-18', amount: 1200, account: 'a-save', category: 'c-other', special: 'y-room-2026' }];
  assert.deepEqual(m.goalsPaid(d, '2026-10-18'), ['y-room-2026']);
  Object.assign(d.goals.find((g) => g.id === 'y-room-2026'), { status: 'done' });
  assert.deepEqual(m.yearlyDue(d, '2026-10-18').map((g) => g.id), ['y-room-2027']);
  // 按农历：小年（腊月廿三）每年在 1～2 月；今年的已经过了就不补，生成明年的
  d.yearly = [{ id: 'home', name: '回家车票', amount: 440, lunar: { m: 12, d: 23 } }];
  d.goals = [];
  const home = m.yearlyDue(d, '2026-10-18');
  assert.deepEqual(home.map((g) => [g.id, g.by]), [['y-home-2027', '2027-01-30']]);
});

test('年费（每年扣的订阅）当成每年一次的专项：美元按汇率；付了选专项，不占订阅预算；月费不算专项', () => {
  const d = savingsBook();
  d.accounts.push({ id: 'a-usd', name: '美元', currency: 'USD', opening: 0 });
  d.recurring = [
    { id: 'r-vip', name: '编的会员', amount: 300, account: 'a-live', category: 'c-member', yearly: '10-24', remindOnly: true },
    { id: 'r-app', name: '编的软件', amount: 10, account: 'a-usd', category: 'c-soft', yearly: '05-25', remindOnly: true },
    { id: 'r-mon', name: '编的月费', amount: 5, account: 'a-live', category: 'c-member', day: 3 },
  ];
  d.settings.usdRate = 7;
  const due = m.yearlyDue(d, '2026-10-24');
  assert.deepEqual(due.map((g) => [g.id, g.by, g.target]), [['y-r-vip-2026', '2026-10-24', 300], ['y-r-app-2027', '2027-05-25', 70]]);
  d.goals.push(...due);
  d.tx = [{ id: 'p1', type: 'expense', date: '2026-10-24', amount: 300, account: 'a-live', category: 'c-member', special: 'y-r-vip-2026' }];
  assert.equal(m.periodStats(d, m.periodFor(d, '2026-10-24')).spent.sub, 0);
  assert.deepEqual(m.goalsPaid(d, '2026-10-24'), ['y-r-vip-2026']);
  Object.assign(d.goals[0], { status: 'done' });
  assert.deepEqual(m.yearlyDue(d, '2026-10-24').map((g) => g.id), ['y-r-vip-2027']);
});

test('不占预算的花销按来源分开写（心愿基金不说成手续费）', () => {
  const d = book();
  d.tx = [ex('2026-10-02', 30), ex('2026-10-03', 120, 'c-other', { wishFund: true }), ex('2026-10-04', 80, 'c-wish'), ex('2026-10-05', 5, 'c-fee')];
  const st = m.periodStats(d, m.periodFor(d, '2026-10-05'));
  assert.equal(st.living, 30);
  assert.deepEqual(m.noneParts(d, st.tx), [{ name: '心愿基金', v: 200 }, { name: '手续费', v: 5 }]);
  assert.equal(m.noneLine(m.noneParts(d, st.tx)), '另有 ¥205 不占预算：心愿基金 ¥200、手续费 ¥5');
  assert.equal(m.noneLine(m.noneParts(d, st.tx.slice(0, 2))), '另有 ¥120 是心愿基金的钱，不占预算');
  assert.equal(m.noneLine([]), '');
});

test('不占预算拆成用存好的和预算外，按去处分组', () => {
  const d = book();
  d.goals = [{ id: 'g1', name: '编的电脑', target: 3000, by: '2026-11-01' }];
  d.tx = [ex('2026-10-02', 30), ex('2026-10-03', 120, 'c-other', { wishFund: true }), ex('2026-10-04', 80, 'c-wish'),
    ex('2026-10-05', 5, 'c-fee'), ex('2026-10-06', 2900, 'c-other', { special: 'g1' }), ex('2026-10-07', 3, 'c-fee')];
  const st = m.periodStats(d, m.periodFor(d, '2026-10-07'));
  const sp = m.noneSplit(d, st.tx);
  assert.equal(sp.saved.v, 3100);
  assert.deepEqual(sp.saved.groups.map((g) => [g.name, g.v, g.tx.length]), [['专项 · 编的电脑', 2900, 1], ['心愿基金', 200, 2]]);
  assert.deepEqual(sp.outside.groups.map((g) => [g.name, g.v, g.tx.length]), [['手续费', 8, 2]]);
  // 用存好的 = 存钱达标时加回去的那部分
  assert.equal(sp.saved.v, st.fromSaved);
  assert.equal(sp.saved.v + sp.outside.v, st.spent.none);
});

test('月度报表：收支、预算、净资产对得上；按用途的合计 = 净资产；还没过完时算到今天', () => {
  const d = book();
  d.tx = [inc('2026-09-03', 5000), ex('2026-09-10', 1200), ex('2026-09-20', 300, 'c-snack'),
    inc('2026-10-02', 5000), ex('2026-10-04', 800), ex('2026-10-06', 50, 'c-snack'), ex('2026-10-20', 999)];
  const r = rp.monthReport(d, '2026-10-05', 7, '2026-10-08');
  assert.equal(r.ongoing, true);
  assert.equal(r.asOf, '2026-10-08');
  assert.deepEqual([r.key.income, r.key.total, r.key.saved], [5000, 850, 4150]); // 10-20 那笔还没到，不算
  assert.equal(r.key.prev.saved, 3500);
  assert.equal(r.key.netChange, 4150);
  assert.equal(r.key.netChange - r.key.prev.netChange, 650);
  assert.equal(r.spend.reduce((a, g) => a + g.v, 0), r.key.total);
  assert.equal(r.budget.find((x) => x.id === 'food').v, 850);
  for (const k of ['start', 'end']) assert.ok(Math.abs(r.purposes.reduce((a, x) => a + x[k], 0) - r[`${k}NW`].net) < 0.01, k);
  assert.equal(r.calendar.counted, 8);
  assert.equal(r.calendar.max.day, '2026-10-04');
  assert.deepEqual(r.trend.map((x) => x.p.startMonth), [9, 10]); // 8 月什么都没记，不放进趋势
  assert.equal(r.cats[0].name, '午餐');
});

test('电动车充电费：新类别在交通里；老账本升级后有它；小票里认得「充电」，不把充电宝认成它', () => {
  const d = book();
  const c = d.categories.find((x) => x.id === 'c-ebike');
  assert.deepEqual([c.name, c.group, c.sub], ['电动车充电费', 'daily', '交通']);
  const old = book();
  old.categories = old.categories.filter((x) => x.id !== 'c-ebike');
  old.categoryVersion = 5;
  m.migrate(old);
  assert.ok(old.categories.some((x) => x.id === 'c-ebike'));
  assert.equal(rc.guessCategory(d.categories, [], '电动车充电'), 'c-ebike');
  assert.equal(rc.guessCategory(d.categories, [], '电车充电'), 'c-ebike');
  assert.notEqual(rc.guessCategory(d.categories, [], '充电宝'), 'c-ebike');
  assert.equal(rc.guessCategory(d.categories, [], '充电器'), 'c-gadget');
});

// ---------- 往后一年、专项什么时候留够、钱到了没有（2026-10-25） ----------
// savingsBook：生活预算 0、订阅 200，存款 = 存钱卡 1 万；收入 5000 → 每月 +4800；底线 = 应急 3000 + 医疗 1000

test('往后一年：这个月 + 还没到的收入 − 还没扣的订阅；之后每月 + 收入 − 预算；自由存款满 1.2 万封存，底线跟着变高', () => {
  const d = savingsBook();
  const a = ah.aheadPlan(d, T);
  assert.equal(a.now, 10000);
  assert.equal(a.points.length, 12);
  assert.equal(a.points[0].total, 14800);
  assert.equal(a.points[1].total, 19600);
  assert.equal(a.points[0].floor, 4000);
  assert.equal(a.points[1].floor, 14000); // 自由存款 15600 → 封存 1 万
  assert.equal(a.perMonth, 4800);
  assert.equal(a.below, null);
});

test('往后一年：暑假两个月没有收入，每年一次的专项到日子当作花掉', () => {
  const d = savingsBook();
  d.settings.summerMonths = [7, 8];
  d.yearly = [{ id: 'fee', name: '学费', amount: 8000, month: 9, day: 1 }];
  const a = ah.aheadPlan(d, T);
  assert.equal(a.points[8].total, 53200); // 2027 年 6 月底
  assert.equal(a.points[9].inc, 0);
  assert.equal(a.points[10].total, 52800);
  assert.equal(a.points[11].total, 49600); // 9 月：+4800 − 学费 8000
  assert.deepEqual(a.events.map((e) => [e.name, e.date, e.amount]), [['2027 年学费', '2027-09-01', 8000]]);
});

test('往后一年：会低于底线时说哪个月、每月少花多少能避开', () => {
  const d = savingsBook();
  d.accounts.find((a) => a.id === 'a-save').opening = 5000;
  Object.assign(d.settings, { expectedIncome: 100 });
  d.yearly = [{ id: 'x', name: '大开销', amount: 2000, month: 1, day: 10 }];
  const a = ah.aheadPlan(d, T);
  assert.equal(a.points[2].total, 4700);
  assert.equal(a.below.p.start, '2027-01-01');
  assert.equal(a.below.total, 2600);
  assert.equal(a.fix, 350); // 差 1400，分 4 个月
});

test('专项什么时候留够：按 家庭 → 应急 → 医疗 → 专项 往后分；到日子还没留够写差多少', () => {
  const d = savingsBook();
  d.goals = [{ id: 'g1', name: '过渡金', target: 20000, by: '2028-06-30', createdAt: '2026-08-01' }];
  let a = ah.aheadPlan(d, T);
  assert.equal(a.eta.find((e) => e.id === 'g1').at, '2026-12-31');
  d.goals = [{ id: 'g2', name: '太多', target: 100000, by: '2027-03-31', createdAt: '2026-08-01' }];
  a = ah.aheadPlan(d, T);
  const e = a.eta.find((x) => x.id === 'g2');
  assert.equal(e.at, null);
  assert.equal(e.shortAtBy, 70000); // 2 月底留了 3 万
  // 日子很远的专项也算得到（不止 12 个月）
  d.goals = [{ id: 'g3', name: '很远', target: 90000, by: '2030-01-01', createdAt: '2026-08-01' }];
  a = ah.aheadPlan(d, T);
  assert.equal(a.points.length, 12);
  assert.equal(a.eta.find((x) => x.id === 'g3').at, '2028-03-31'); // 先留 6000，每月 +4800：第 18 个月底
});

test('钱到了没有：以前都是第 10、11 天到 → 前一天才问，晚 3 天以上说晚了；没有记录看「15 号」', () => {
  const d = book();
  d.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary' }];
  d.tx = [inc('2026-08-10', 5000), inc('2026-09-11', 5000)];
  assert.equal(m.incomeUsual(d, d.incomePlan[0], m.periodFor(d, T)).date, '2026-10-11');
  assert.equal(m.payday(d, '2026-10-08').waiting.length, 0);
  const w = m.payday(d, '2026-10-10').waiting;
  assert.equal(w.length, 1);
  assert.equal(w[0].late, undefined);
  assert.equal(m.payday(d, '2026-10-15').waiting[0].late, 4);
  const d2 = book();
  d2.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary', when: '每月 15 号左右' }];
  assert.deepEqual(m.incomeUsual(d2, d2.incomePlan[0], m.periodFor(d2, T)), { date: '2026-10-15', from: 'plan' });
  d2.incomePlan[0].when = '不定时';
  assert.equal(m.incomeUsual(d2, d2.incomePlan[0], m.periodFor(d2, T)), null);
  assert.equal(m.payday(d2, '2026-10-01').waiting.length, 1); // 不定时的照旧每天问
});

// ---------- 预测：贝叶斯（Dirichlet 过程）+ Chronos-2 混合、收入 Beta-伯努利、蒙特卡洛（2026-10-25） ----------
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} 不在 ${b} ± ${tol}`);
// 8 月 1 日起每天生活花 v 元（book() 生活预算 2300，预算月 1 号开始）
function dailyBook(v) {
  const d = book();
  d.tx = [];
  for (let x = '2026-08-01'; x < T; x = m.addDays(x, 1)) d.tx.push(ex(x, v));
  return d;
}

test('随机数：同一个种子结果一样；Gamma、Beta 的均值对', () => {
  const a = fc.rng('x'); const b = fc.rng('x');
  assert.equal(a.u(), b.u());
  const R = fc.rng('moments');
  let g = 0; let be = 0;
  for (let i = 0; i < 20000; i++) { g += R.gamma(3); be += R.beta(2, 6); }
  near(g / 20000, 3, 0.06, 'Gamma(3)');
  near(be / 20000, 0.25, 0.01, 'Beta(2,6)');
  let small = 0;
  for (let i = 0; i < 20000; i++) small += R.gamma(0.5);
  near(small / 20000, 0.5, 0.03, 'Gamma(0.5)');
});

test('Dirichlet 过程后验：没数据时就是先验；数据多了贴近实际；抽出来的 P 平均下来是 (αμ₀ + Σx)/(α + n)', () => {
  const prior = fc.g0(60);
  near(fc.dpPredictive([], prior).q(0.5), 60 / Math.SQRT2, 0.5, '对数正态 cv=1 的中位数 = 均值/√2');
  const xs = Array.from({ length: 300 }, (_, i) => 20 + (i % 10) * 10); // 20…110，平均 65
  near(fc.dpPredictive(xs, prior).q(0.5), 60, 6);
  const R = fc.rng('dp');
  let mean = 0;
  for (let i = 0; i < 4000; i++) mean += fc.drawP(R, xs, prior).mean;
  near(mean / 4000, (30 * 60 + 65 * 300) / 330, 0.6);
});

test('分位数：插值抽样、分位数损失（实际正好在中位数、分位数都一样时损失 0）', () => {
  const qs = fc.LEVELS.map((q) => q * 100);
  assert.equal(fc.fromQuantiles(qs, 0.5), 50);
  near(fc.fromQuantiles(qs, 0.33), 33, 1e-9);
  assert.ok(fc.fromQuantiles(qs, 0.995) > 99);
  assert.equal(fc.quantileLoss(fc.LEVELS.map(() => 5), 5), 0);
  assert.ok(fc.quantileLoss(qs, 50) < fc.quantileLoss(qs, 95));
});

test('这个月会花多少：一直照预算花 → 超预算的可能在一半上下；一直花 3 倍 → 几乎一定超；三成 → 几乎不超；同一天结果一样', () => {
  const mu = 2300 / 31;
  const even = fc.monthForecast(dailyBook(Math.round(mu)), T);
  assert.ok(even.pOver > 0.2 && even.pOver < 0.8, `照预算 ${even.pOver}`);
  near(even.median, 2300, 150);
  assert.ok(even.lo < even.median && even.median < even.hi);
  assert.ok(fc.monthForecast(dailyBook(Math.round(mu * 3)), T).pOver > 0.95);
  assert.ok(fc.monthForecast(dailyBook(Math.round(mu * 0.3)), T).pOver < 0.05);
  assert.deepEqual(fc.monthForecast(dailyBook(50), T), fc.monthForecast(dailyBook(50), T));
  assert.equal(even.chronos, false);
});

test('Chronos-2 混进来：按打分定权重；预测得准的权重高；混合后的这个月往它那边靠', () => {
  const d = dailyBook(40);
  const levels = fc.LEVELS;
  // Chronos 每天都说 40 左右（正好对），贝叶斯先验以为每天 74
  const tight = levels.map((q) => 38 + 4 * q);
  const log = {}; for (let x = '2026-09-20'; x < T; x = m.addDays(x, 1)) log[x] = tight;
  const sc = fc.scoreModels(d, T, log);
  assert.equal(sc.days, 18);
  assert.ok(sc.chronos.loss < sc.bayes.loss);
  assert.ok(sc.w > 0.5 && sc.w < 1, `权重 ${sc.w}`);
  assert.equal(sc.chronos.cover, 1);
  // 让 Chronos 预测剩下每天 200：混合以后中位数比只用贝叶斯高
  const big = { status: 'ok', from: T, levels, series: { living: Array.from({ length: 40 }, () => levels.map((q) => 190 + 20 * q)) } };
  const only = fc.monthForecast(d, T);
  const mixed = fc.monthForecast(d, T, { fc: big, score: { w: 1 } });
  assert.ok(mixed.chronos && mixed.wChronos === 1);
  assert.ok(mixed.median > only.median + 3000);
  assert.equal(fc.scoreModels(d, T, null).w, 0);
});

test('收入：写了几号的先验 Beta(19.5, 0.5)；不定时的 Beta(4.5, 0.5) 按到没到更新', () => {
  const d = book();
  d.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary', when: '每月 10 号' }, { name: '补贴', amount: 1000, category: 'i-job' }];
  d.tx = [inc('2026-08-10', 5000), inc('2026-09-10', 5000), inc('2026-09-20', 1000, 'i-job')];
  const [a, b] = fc.incomeModels(d, T);
  assert.deepEqual([a.regular, a.a, a.b, a.hits, a.months], [true, 21.5, 0.5, 2, 2]);
  assert.deepEqual([b.regular, b.a, b.b], [false, 5.5, 1.5]);
  near(b.p, 5.5 / 7, 1e-9);
});

test('往后蒙特卡洛：收入几乎一定到时中位数和按计划一样；钱不够时碰底线的可能接近 1；专项按时留够的可能', () => {
  const d = savingsBook();
  d.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary', when: '每月 1 号' }];
  d.goals = [{ id: 'g1', name: '过渡金', target: 20000, by: '2028-06-30', createdAt: '2026-08-01' }];
  const s = fc.simulateAhead(d, T, { paths: 2000 });
  assert.equal(s.fan.length, 12);
  near(s.fan[1].q[2], 19600, 1); // 生活预算是 0，先验每天只有几分钱
  assert.ok(s.fan[11].q[0] <= s.fan[11].q[2] && s.fan[11].q[2] <= s.fan[11].q[4]);
  assert.ok(s.pBelow < 0.05, `碰底线 ${s.pBelow}`);
  const g = s.goals.find((x) => x.id === 'g1');
  assert.ok(g.pOnTime > 0.99);
  assert.equal(g.p50, '2026-12-31');
  const poor = savingsBook();
  poor.accounts.find((a) => a.id === 'a-save').opening = 5000;
  poor.settings.expectedIncome = 100;
  poor.yearly = [{ id: 'x', name: '大开销', amount: 2000, month: 1, day: 10 }];
  assert.ok(fc.simulateAhead(poor, T, { paths: 1000 }).pBelow > 0.99);
});

test('建议·敏感性分析：专项来不及时，二分法找出每月最少要少花多少（再少 10 块就不够）；只调预算没用时说要少花；一切正常时没有建议', () => {
  // 每天正好花 74（差不多就是预算），工资每月 1 号都到了
  const d = dailyBook(74);
  for (const x of ['2026-08-01', '2026-09-01', '2026-10-01']) d.tx.push(inc(x, 5000));
  d.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary', when: '每月 1 号' }];
  d.goals = [{ id: 'g1', name: '买电脑', target: 28000, by: '2027-06-30', createdAt: '2026-08-01' }];
  const s = fc.simulateAhead(d, T, { paths: 1000 });
  const ok = (x) => x.goals.find((y) => y.id === 'g1').pOnTime >= 0.9;
  assert.ok(!ok(s));
  assert.equal(fc.cutNeeded(d, T, {}, ok), null); // 花的和预算差不多：只调预算没用
  const r = fc.cutNeeded(d, T, {}, ok, { spend: true });
  assert.ok(r && r.cut > 0 && r.cut <= 1150, JSON.stringify(r?.cut));
  assert.ok(ok(r.sim));
  assert.ok(!ok(fc.simulateAhead(d, T, { paths: fc.ADVICE_PATHS, cut: r.cut - 10, spendCut: true })));
  const item = fc.adviceItems(d, T, s).find((x) => x.key === 'goal-g1');
  assert.ok(item.text.includes(`每月少花 ¥${r.cut.toLocaleString('zh-CN')}`), item.text);
  d.goals[0].target = 100000; // 少花一半也不够
  assert.ok(fc.adviceItems(d, T, fc.simulateAhead(d, T, { paths: 1000 })).find((x) => x.key === 'goal-g1').text.includes('少花一半也到不了'));
  // 本来就花得少（每天 30）：只调预算就够
  const thrifty = dailyBook(30);
  for (const x of ['2026-08-01', '2026-09-01', '2026-10-01']) thrifty.tx.push(inc(x, 5000));
  thrifty.incomePlan = d.incomePlan;
  thrifty.goals = [{ id: 'g1', name: '买电脑', target: 28000, by: '2027-06-30', createdAt: '2026-08-01' }];
  const ts = fc.simulateAhead(thrifty, T, { paths: 1000 });
  if (!ok(ts)) assert.ok(fc.adviceItems(thrifty, T, ts).find((x) => x.key === 'goal-g1').text.includes('把生活预算每月调低'));
  const fine = savingsBook();
  fine.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary', when: '每月 1 号' }];
  assert.deepEqual(fc.adviceItems(fine, T, fc.simulateAhead(fine, T, { paths: 1000 })), []);
});

test('建议·预算的可信区间：吃饭每天都花 40（一个月约 1218）→ 低于 1500 几乎一定，建议调到 1250；记得少（< 45 天）或这一组几乎没花不说', () => {
  const d = dailyBook(40);
  const cred = fc.budgetCredible(d, T);
  const food = cred.find((x) => x.group === 'food');
  near(food.mean, 40 * 365.25 / 12, 0.5);
  assert.equal(food.pUnder, 1);
  assert.equal(cred.find((x) => x.group === 'daily'), undefined);
  const item = fc.adviceItems(d, T, { pBelow: 0, goals: [] }).find((x) => x.key === 'budget-food');
  assert.ok(item.text.includes('预算调到 ¥1,250'), item.text);
  const short = dailyBook(40); short.openingDate = '2026-09-01';
  assert.deepEqual(fc.budgetCredible(short, T), []);
  const over = dailyBook(80); // 一个月约 2435，预算 1500
  assert.equal(fc.adviceItems(over, T, { pBelow: 0, goals: [] }).find((x) => x.key === 'budget-food').tone, 'warn');
});

test('建议·方差分解：有不定时收入时，一年后存款的不确定大部分来自收入；两块加起来不超过 1', () => {
  const d = savingsBook();
  d.incomePlan = [{ name: '补贴', amount: 4000, category: 'i-job' }];
  const u = fc.uncertaintySources(d, T);
  assert.ok(u.income > 0.8 && u.income + u.spend <= 1 + 1e-9, JSON.stringify(u));
  assert.deepEqual(u.irregular, ['补贴']);
});

test('买不买·假设今天买：先用心愿基金能随便用的，不够的从存款出；原来的账不变；买得越贵，存款少得越多、专项可能越低', () => {
  const d = savingsBook();
  d.incomePlan = [{ name: '工资', amount: 5000, category: 'i-salary', when: '每月 1 号' }];
  d.goals = [{ id: 'g1', name: '过渡金', target: 20000, by: '2027-03-31', createdAt: '2026-08-01' }];
  d.tx = [ex('2026-10-01', 50, 'c-like', { wishFund: false })];
  const n = d.tx.length;
  const small = m.wishFunds(d, T).small;
  const w = fc.withPurchase(d, T, small + 300);
  assert.equal(d.tx.length, n);
  assert.equal(w.fromWish, small);
  assert.equal(w.fromSaved, 300);
  assert.equal(m.wishFunds(w.data, T).small, 0);
  const opts = { paths: 1000 };
  const base = fc.simulateAhead(d, T, opts);
  const cheap = fc.buyImpact(d, T, 300, { ...opts, base });
  near(cheap.yearOn[0] - cheap.yearOn[1], 300 - cheap.fromWish, 1); // 同一批随机数：一年后少的就是从存款出的那部分
  const dear = fc.buyImpact(d, T, 15000, { ...opts, base });
  assert.ok(dear.yearOn[1] < cheap.yearOn[1]);
  const g = dear.goals.find((x) => x.id === 'g1');
  assert.ok(g && g.after < g.before, JSON.stringify(dear.goals));
  assert.ok(!dear.later.after || dear.later.after > dear.later.before, JSON.stringify(dear.later)); // 晚了，或者留不够了
  assert.deepEqual(fc.buyImpact(d, T, 300, { ...opts, base }), cheap); // 同一天结果一样
});

test('买不买·每用一次：范围很窄时就是 价格×(1−卖回)÷(次数×年数)；范围越宽 80% 越宽；没给范围不算', () => {
  const u = fc.perUse(1000, { perYear: [100, 100], years: [2, 2], resale: 0.2 });
  near(u.median, 4, 1e-9);
  near(u.lo, 4, 1e-9);
  const wide = fc.perUse(1000, { perYear: [50, 200], years: [1, 4], resale: 0 });
  near(wide.median, 1000 / (100 * 2), 0.3);
  assert.ok(wide.lo < wide.median && wide.median < wide.hi);
  assert.equal(fc.perUse(1000, null), null);
  assert.equal(fc.perUse(1000, { perYear: [0, 3], years: [1, 2] }), null);
  assert.equal(fc.perUse(1000, { perYear: [10, 20], years: [1, 2], resale: 5 }).resale, 0.9);
});

test('午饭和晚饭：同一天同一类合成一顿；校园卡 = 学校里；一周的格子、平均、和平时比、占吃饭几成', () => {
  const d = book();
  d.openingDate = '2026-09-01';
  d.accounts.push({ id: 'a-campus', name: '编的卡', currency: 'CNY', opening: 0 });
  const camp = (date, amount, cat = 'c-lunch') => ex(date, amount, cat, { account: 'a-campus' });
  d.tx = [camp('2026-10-05', 12), ex('2026-10-05', 3, 'c-lunch'), ex('2026-10-05', 30, 'c-dinner'), camp('2026-10-06', 10),
    ex('2026-10-07', 6, 'c-drink'), camp('2026-09-28', 14), camp('2026-09-29', 16), camp('2026-09-30', 18)];
  const meals = ml.mealsOf(d, '2026-10-05', '2026-10-11');
  assert.deepEqual(meals.map((x) => [x.day, x.kind, x.v, x.school]), [['2026-10-05', 'lunch', 15, true], ['2026-10-05', 'dinner', 30, false], ['2026-10-06', 'lunch', 10, true]]);
  const ws = sm.weekSummary(d, '2026-10-07', '2026-10-11');
  const mw = ml.mealWeek(d, ws, '2026-10-12');
  assert.deepEqual(mw.grid[0].cells.map((c) => c.v), [15, 10, null, null, null, null, null]);
  assert.equal(mw.grid[1].cells[0].school, false);
  assert.equal(mw.kinds[0].avg, 12.5);
  assert.equal(mw.kinds[0].usual, 16);
  assert.equal(mw.total, 55);
  assert.equal(mw.food, 61);
  assert.deepEqual(mw.place.map((x) => [x.id, x.n]), [['school', 2], ['out', 1]]);
  assert.equal(mw.next, undefined); // 过去的周没有预测
});

test('午饭和晚饭·每顿价格的正态—逆伽马后验：没数据就是先验，数据多了靠近实际', () => {
  const mu0 = Math.log(18);
  assert.deepEqual(ml.mealPosterior([], mu0), { mu: mu0, kappa: 2, alpha: 2, beta: 0.5, n: 0 });
  const xs = Array.from({ length: 200 }, (_, i) => Math.log(10 + (i % 5)));
  const post = ml.mealPosterior(xs, mu0);
  const xbar = xs.reduce((a, x) => a + x, 0) / xs.length;
  assert.ok(Math.abs(post.mu - xbar) < 0.01);
  assert.equal(post.kappa, 202);
  assert.equal(post.alpha, 102);
});

test('午饭和晚饭·下周两顿、这个预算月吃饭：同一天结果一样；每顿都记、价格固定时接近 14 × 价格；吃得越贵超预算越可能', () => {
  const d = book();
  d.openingDate = '2026-08-01';
  d.budget.food = 1500;
  d.tx = [];
  for (let day = '2026-08-01'; day <= '2026-10-09'; day = m.addDays(day, 1)) d.tx.push(ex(day, 20, 'c-lunch'), ex(day, 20, 'c-dinner'));
  const a = ml.nextWeekMeals(d, '2026-10-10', { paths: 1000 });
  assert.deepEqual(a, ml.nextWeekMeals(d, '2026-10-10', { paths: 1000 }));
  assert.ok(Math.abs(a.mid - 280) < 15, JSON.stringify(a));
  assert.ok(a.lo <= a.mid && a.mid <= a.hi);
  // 10 月：已花 9 天 × 40 = 360，往后 21 天 × 40 ≈ 840，一共 ≈ 1200
  const ok = ml.monthFood(d, '2026-10-10', { paths: 1000 });
  assert.equal(ok.budget, 1500);
  assert.equal(ok.spent, 360);
  assert.ok(Math.abs(ok.mid - 1200) < 40 && ok.pOver < 0.05, JSON.stringify(ok));
  d.budget.food = 1100;
  assert.ok(ml.monthFood(d, '2026-10-10', { paths: 1000 }).pOver > 0.9);
});

test('午饭和晚饭·变贵了没有、换成学校里能省多少（不够明显就不说）', () => {
  const up = Array.from({ length: 40 }, (_, i) => ({ day: m.addDays('2026-08-01', i * 2), v: 10 * Math.exp(0.003 * i * 2) * (1 + ((i % 3) - 1) * 0.02) }));
  // 平的，最后一顿特别贵：不算变贵
  const spike = up.map((x, i) => ({ ...x, v: i === 39 ? 75 : 13 + ((i % 3) - 1) }));
  assert.ok(ml.mealTrend(spike).perMonth < 0.02, JSON.stringify(ml.mealTrend(spike)));
  const t = ml.mealTrend(up);
  assert.ok(t.pUp > 0.99 && t.perMonth > 0.05, JSON.stringify(t));
  const flat = up.map((x, i) => ({ ...x, v: 10 + ((i % 3) - 1) }));
  assert.ok(ml.mealTrend(flat).pUp < 0.9);
  assert.equal(ml.mealTrend(up.slice(0, 10)), null);
  assert.equal(ml.mealTrend(up.slice(0, 28)), null); // 不到 30 顿
  assert.equal(ml.mealTrend(up.map((x, i) => ({ ...x, day: m.addDays('2026-08-01', i) }))), null); // 40 顿但跨不满 8 周
  const meals = [...Array.from({ length: 6 }, (_, i) => ({ kind: 'dinner', v: 12, school: true, day: `2026-10-0${i + 1}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'dinner', v: 25, school: false, day: `2026-10-1${i}` }))];
  assert.deepEqual(ml.swapSaving(meals), { ...ml.MEAL_KINDS[1], diff: 13, month: 57 });
  assert.equal(ml.swapSaving(meals.map((x) => ({ ...x, v: x.school ? 12 : 13 }))), null);
});

test('早餐：校园卡按顿数；别的卡是囤的，最近四周摊到每天；下次大约哪天该买', () => {
  const d = book();
  d.openingDate = '2026-09-01';
  d.accounts.push({ id: 'a-campus', name: '编的卡', currency: 'CNY', opening: 0 });
  d.tx = [ex('2026-10-01', 28, 'c-breakfast'), ex('2026-10-05', 7, 'c-breakfast'), ex('2026-10-09', 7, 'c-breakfast'), ex('2026-10-13', 14, 'c-breakfast'),
    ex('2026-10-13', 2, 'c-breakfast', { account: 'a-campus' }), ex('2026-10-14', 2, 'c-breakfast', { account: 'a-campus' })];
  const ws = sm.weekSummary(d, '2026-10-14', '2026-10-14');
  const b = ml.breakfast(d, ws, '2026-10-14', '2026-10-14');
  assert.equal(b.school, 2);
  assert.equal(b.perDay, Math.round((56 / 28) * 100) / 100);
  assert.deepEqual(b.next, { from: '2026-10-17', to: '2026-10-17', last: '2026-10-13' });
});

console.log(`\n${n} 项通过`);
