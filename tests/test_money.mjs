// 钱怎么分（2026-10-08 定的方案）：直接测 money.js 的计算，不开浏览器。数字都是编的。
//   node tests/test_money.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../js/money.js', import.meta.url));
const sm = await import(new URL('../js/summary.js', import.meta.url));
const rp = await import(new URL('../js/report.js', import.meta.url));

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

console.log(`\n${n} 项通过`);
