// 钱怎么分（2026-10-08 定的方案）：直接测 money.js 的计算，不开浏览器。数字都是编的。
//   node tests/test_money.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../js/money.js', import.meta.url));

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

test('存款的顺序：家庭 → 应急 → 医疗 → 专项（日子近的先）→ 自由；凑够一万封存', () => {
  const d = book();
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

test('暑假生活费：平时留下个暑假的；暑假里还没转出来的那几个月继续留着', () => {
  const d = book();
  d.settings.summerMonths = [7, 8];
  const before = m.summerGoal(d, '2026-10-08');
  assert.equal(before.target, 2500 * 2);
  assert.equal(before.by, '2027-06-30');
  const july = m.summerGoal(d, '2027-07-03');
  assert.equal(july.target, 2500 * 2); // 7 月还没转
  d.tx.push({ id: 'tr', type: 'transfer', date: '2027-07-02', account: 'a-save', to: 'a-live', amount: 2300 });
  assert.equal(m.summerGoal(d, '2027-07-03').target, 2500);
  assert.equal(m.summerGoal(d, '2027-09-03').name, '2028 年暑假生活费');
});

test('每月数额计算：生活费卡这边应该有 = 心愿基金 + 这个月生活费还剩的', () => {
  const d = book();
  d.tx = [
    { id: 'tr1', type: 'transfer', date: '2026-08-01', account: 'a-save', to: 'a-live', amount: 2300 }, ex('2026-08-05', 2000),
    { id: 'tr2', type: 'transfer', date: '2026-09-01', account: 'a-save', to: 'a-live', amount: 2300 }, ex('2026-09-05', 2000),
    { id: 'tr3', type: 'transfer', date: '2026-10-01', account: 'a-save', to: 'a-live', amount: 2300 }, ex('2026-10-05', 500), ex('2026-10-06', 200, 'c-medical'),
  ];
  const c = m.cardCheck(d, T);
  assert.equal(c.expected, 600 + 1800);
  assert.equal(c.actual, 600 + 1800 - 200);
  assert.equal(c.diff, -200); // 买药从生活费卡付的 → 从存钱卡转 200 过来
});

test('欠别人的钱先从存款里扣掉；封存家庭存款不算别人还欠我的', () => {
  const d = book();
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
  const d = book();
  d.accounts.find((a) => a.id === 'a-save').opening = 12000;
  d.family = { sealed: 10000, log: [] };
  d.people = [{ id: 'p1', name: '甲' }];
  d.tx = [ex('2026-10-02', 2000, 'c-lunch', { account: null, person: 'p1' })];
  const floor = m.health(d, T, 7).items.find((x) => x.key === 'floor');
  assert.equal(floor.level, 'bad');
  assert.match(floor.text, /只留到 ¥0/);
});

test('暑假：只有转到生活费卡这边才算这个月的生活费转出来了', () => {
  const d = book();
  d.settings.summerMonths = [7, 8];
  d.accounts.push({ id: 'a-usd', name: 'USD', currency: 'USD', opening: 0 });
  d.tx.push({ id: 'top', type: 'transfer', date: '2027-07-02', account: 'a-save', to: 'a-usd', amount: 100, toAmount: 14 });
  assert.equal(m.summerGoal(d, '2027-07-03').target, 2500 * 2);
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

console.log(`\n${n} 项通过`);
