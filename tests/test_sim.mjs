// 模拟交易的规则：直接测 sim.js 的计算，不开浏览器。价格都是编的。
//   node tests/test_sim.mjs
import assert from 'node:assert/strict';

const s = await import(new URL('../js/sim.js', import.meta.url));

let n = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; }
};

// 北京时间 → Date
const bj = (t) => new Date(`${t}+08:00`);
const A = { sym: 'sh600001', name: '某某股份', kind: 'GP-A' };
const ETF = { sym: 'sh510001', name: '某某300ETF', kind: 'ETF' };
const QDII = { sym: 'sz159001', name: '某某纳指ETF', kind: 'QDII-ETF' };
const US = { sym: 'usABC', name: '某美股', kind: 'GP' };
const sim = () => ({ games: [{ id: 'g1', start: '2026-10-26', cash: 10000 }], trades: [], watch: [], reviews: [] });
const quote = (price, date) => ({ price, bid: price - 0.01, bidVol: 10, ask: price, askVol: 10, date });
function trade(d, x, side, qty, at, q, rate = 7) {
  const r = s.checkOrder(d, 'g1', x, side, qty, q, rate, bj(at));
  assert.ok(!r.error, r.error);
  d.trades.push({ id: `t${d.trades.length}`, game: 'g1', at: bj(at).toISOString(), date: at.slice(0, 10), sym: x.sym, name: x.name, kind: x.kind, side, qty, ...r });
  return r;
}

test('A 股开盘时间：9:30–11:30、13:00–15:00，周末和节假日不开', () => {
  assert.equal(s.marketState('A', bj('2026-10-26T09:29:00')).open, false); // 周一
  assert.equal(s.marketState('A', bj('2026-10-26T09:30:00')).open, true);
  assert.equal(s.marketState('A', bj('2026-10-26T12:00:00')).text, 'A 股午休 · 13:00 开盘');
  assert.equal(s.marketState('A', bj('2026-10-26T14:59:00')).open, true);
  assert.equal(s.marketState('A', bj('2026-10-26T15:00:00')).text, 'A 股收盘了 · 明天 9:30 开盘');
  assert.equal(s.marketState('A', bj('2026-10-24T10:00:00')).text, 'A 股休市 · 周一 9:30 开盘'); // 周六
  // 工作日开盘时间里行情还停在前几天 = 节假日
  assert.equal(s.marketState('A', bj('2026-10-01T10:30:00'), '2026-09-30').open, false);
});

test('美股开盘时间按纽约算：夏令时北京 21:30，冬令时 22:30', () => {
  assert.equal(s.marketState('US', bj('2026-10-26T21:30:00')).open, true); // 纽约还是夏令时
  assert.equal(s.marketState('US', bj('2026-10-26T21:29:00')).text, '美股休市 · 北京时间 21:30 开盘');
  assert.equal(s.marketState('US', bj('2026-11-10T22:00:00')).text, '美股休市 · 北京时间 22:30 开盘');
  assert.equal(s.marketState('US', bj('2026-11-11T03:00:00')).open, true); // 北京第二天凌晨还开着
});

test('一手：A 股 100 股，科创板最少 200，美股 1 股', () => {
  const d = sim();
  const q = quote(10, '2026-10-26');
  assert.match(s.checkOrder(d, 'g1', A, 'buy', 50, q, 7, bj('2026-10-26T10:00:00')).error, /最少买 100/);
  assert.match(s.checkOrder(d, 'g1', A, 'buy', 150, q, 7, bj('2026-10-26T10:00:00')).error, /整手/);
  assert.equal(s.lot('sh688001').min, 200);
  assert.ok(!s.checkOrder(d, 'g1', { sym: 'sh688001', kind: 'GP-A' }, 'buy', 201, q, 7, bj('2026-10-26T10:00:00')).error);
  assert.equal(s.lot('usABC').min, 1);
});

test('手续费：A 股最低 5 元、卖出印花税；ETF 只收佣金；美股按股数', () => {
  assert.equal(s.fees(A, 'buy', 100, 10), 5.01); // 5 元佣金 + 过户费 0.01
  assert.equal(s.fees(A, 'sell', 100, 10), 5.51); // 再加印花税 0.5
  assert.equal(s.fees(ETF, 'sell', 1000, 4), 5);
  assert.equal(s.fees(A, 'buy', 10000, 10), 25 + 1); // 万 2.5 = 25，过户费 1
  assert.equal(s.fees(US, 'buy', 2, 100), 1.99);
});

test('买卖：按卖一价买、买一价卖；现金、持有、成本都对', () => {
  const d = sim();
  const r = trade(d, A, 'buy', 200, '2026-10-26T10:00:00', quote(10, '2026-10-26'));
  assert.equal(r.price, 10);
  assert.equal(r.cny, 2005.02);
  assert.equal(s.cash(d, 'g1'), 7994.98);
  const p = s.positions(d, 'g1', bj('2026-10-27T10:00:00'))[0];
  assert.deepEqual([p.qty, p.cost, p.sellable], [200, 2005.02, 200]);
  const w = s.worth(d, 'g1', { [A.sym]: { price: 11 } }, 7, bj('2026-10-27T10:00:00'));
  assert.equal(w.total, 7994.98 + 2200);
  // 卖一半：成本按比例减
  trade(d, A, 'sell', 100, '2026-10-27T10:00:00', quote(11, '2026-10-27'));
  assert.equal(s.positions(d, 'g1', bj('2026-10-27T10:01:00'))[0].cost, 1002.51);
});

test('T+1：A 股今天买的明天才能卖；跨境 ETF、美股当天能卖', () => {
  const d = sim();
  trade(d, A, 'buy', 100, '2026-10-26T10:00:00', quote(10, '2026-10-26'));
  assert.match(s.checkOrder(d, 'g1', A, 'sell', 100, quote(10, '2026-10-26'), 7, bj('2026-10-26T14:00:00')).error, /明天才能卖/);
  trade(d, QDII, 'buy', 100, '2026-10-26T10:00:00', quote(2, '2026-10-26'));
  assert.ok(!s.checkOrder(d, 'g1', QDII, 'sell', 100, quote(2, '2026-10-26'), 7, bj('2026-10-26T14:00:00')).error);
  assert.equal(s.tPlus0({ sym: 'sh518001', name: '黄金ETF某某', kind: 'ETF' }), true);
});

test('涨停买不到、跌停卖不出、休市不能买、钱不够不能买', () => {
  const d = sim();
  const up = { ...quote(10, '2026-10-26'), ask: 0, askVol: 0 };
  assert.match(s.checkOrder(d, 'g1', A, 'buy', 100, up, 7, bj('2026-10-26T10:00:00')).error, /涨停/);
  assert.match(s.checkOrder(d, 'g1', A, 'buy', 100, quote(10, '2026-10-24'), 7, bj('2026-10-24T10:00:00')).error, /休市/);
  assert.match(s.checkOrder(d, 'g1', A, 'buy', 1000, quote(10, '2026-10-26'), 7, bj('2026-10-26T10:00:00')).error, /钱不够/);
  trade(d, A, 'buy', 100, '2026-10-26T10:00:00', quote(10, '2026-10-26'));
  const down = { ...quote(9, '2026-10-27'), bid: 0, bidVol: 0 };
  assert.match(s.checkOrder(d, 'g1', A, 'sell', 100, down, 7, bj('2026-10-27T10:00:00')).error, /跌停/);
});

test('美股按汇率换成人民币，能买的最多股数扣掉手续费', () => {
  const d = sim();
  const r = trade(d, US, 'buy', 2, '2026-10-26T22:00:00', quote(100, '2026-10-26'), 7);
  assert.equal(r.cny, Math.round((200 + 1.99) * 7 * 100) / 100);
  assert.equal(s.maxBuy(sim(), 'g1', A, 10, 7), 900); // 1 万块，10 元一股，整手最多 900（1000 股还要手续费）
  assert.equal(s.maxBuy(sim(), 'g1', A, 0, 7), 0);
});

test('走势：每天收盘一共值多少', () => {
  const d = sim();
  trade(d, A, 'buy', 100, '2026-10-26T10:00:00', quote(10, '2026-10-26'));
  const series = s.worthSeries(d, 'g1', { [A.sym]: [['2026-10-26', 10.5], ['2026-10-27', 11]] }, 7, '2026-10-28', { [A.sym]: 12 });
  assert.deepEqual(series.map((x) => x[0]), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.equal(series[0][1], 10000 - 1005.01 + 1050);
  assert.equal(series[2][1], 10000 - 1005.01 + 1200);
});

test('对照：开局前一天收盘全买沪深 300，每天值多少；今天用实时价', () => {
  const closes = [['2026-10-22', 4], ['2026-10-23', 4.2], ['2026-10-26', 4.41]];
  const b = s.benchSeries(closes, '2026-10-24', 10000, ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'], '2026-10-27', 3.99);
  assert.deepEqual(b.map((x) => x[1]), [10000, 10000, 10500, 9500]);
  assert.deepEqual(s.benchSeries([], '2026-10-24', 10000, ['2026-10-24'], '2026-10-24'), []);
});

test('走势图上的买卖点：落在那天，没开盘落在下一个交易日，太早的不标', () => {
  const rows = [['2026-10-22', 1], ['2026-10-23', 1], ['2026-10-26', 1]];
  const t = (date, side) => ({ date, side });
  assert.deepEqual(s.tradeMarks(rows, [t('2026-10-01', 'buy'), t('2026-10-23', 'buy'), t('2026-10-23', 'buy'), t('2026-10-24', 'sell'), t('2026-10-28', 'buy')]),
    [{ i: 1, side: 'buy' }, { i: 2, side: 'sell' }, { i: 2, side: 'buy' }]);
});

test('回头看：卖出一周后、买入一个月后；月度复盘：上个月有买卖才写', () => {
  const d = sim();
  trade(d, A, 'buy', 100, '2026-10-26T10:00:00', quote(10, '2026-10-26'));
  assert.equal(s.lookbackDue(d, '2026-11-20'), null);
  assert.equal(s.lookbackDue(d, '2026-11-25').sym, A.sym);
  assert.equal(s.reviewDue(d, '2026-10-30'), null);
  assert.equal(s.reviewDue(d, '2026-11-01'), '2026-10');
  d.reviews.push({ id: 'r1', month: '2026-10' });
  assert.equal(s.reviewDue(d, '2026-11-01'), null);
  assert.equal(s.prevMonth('2027-01'), '2026-12');
});

test('解析行情和搜索结果', () => {
  const q = s.parseQuote('v_sh600001="1~某某股份~600001~10.50~10.00~10.10~1000~0~0~10.49~20~0~0~0~0~0~0~0~0~10.50~30~0~0~0~0~0~0~0~0~~20261026101500~0.50~5.00~10.60~10.00"');
  assert.deepEqual([q.sym, q.price, q.bid, q.ask, q.askVol, q.date, q.pct], ['sh600001', 10.5, 10.49, 10.5, 30, '2026-10-26', 5]);
  assert.equal(s.parseQuote('v_pv_none_match="1";'), null);
  const r = s.parseSearch('sh~600001~某某股份~mmgf~GP-A^hk~00001~港股~gg~GP^us~abc.oq~某美股~mmg~GP^sz~159001~纳指ETF~nz~QDII-ETF^sh~000001~上证指数~szzs~ZS');
  assert.deepEqual(r.map((x) => x.sym), ['sh600001', 'usABC', 'sz159001']);
  assert.equal(r[1].k, 'usABC.OQ');
});

console.log(`\n${n} 项通过`);
