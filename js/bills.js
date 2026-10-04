// 微信、支付宝账单查漏记：读导出的账单 → 和账本里记过的对一对 → 没对上的一笔笔让用户确认。纯计算，可以用 node 测。

const round2 = (n) => Math.round(n * 100) / 100;
const num = (s) => Number(String(s ?? '').replace(/[¥￥,\s]/g, ''));

// Excel 里的日期可能是数字（1900 年起的天数）
function toTime(v) {
  const s = String(v || '').trim();
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 30000) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400000));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  const m = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2}:\d{2})?/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} ${m[4] || '00:00'}` : '';
}

// 认出是哪家的账单、表头在哪一行，按列名取值（两家的列名不一样，前面还有十几行说明）
export function parseBill(rows) {
  const headAt = rows.findIndex((r) => r.some((c) => c.includes('交易时间')) && r.some((c) => /^金额/.test(c)));
  if (headAt < 0) throw new Error('没认出是微信或支付宝的账单（找不到「交易时间」「金额」这一行）');
  const before = rows.slice(0, headAt).flat().join(' ');
  const head = rows[headAt].map((c) => c.replace(/\s/g, ''));
  const source = /支付宝/.test(before) || head.includes('交易分类') || head.includes('收/付款方式') ? 'alipay' : 'wechat';
  const col = (...names) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const c = {
    time: col('交易时间'), type: col('交易类型', '交易分类'), party: col('交易对方'), product: col('商品说明', '商品'),
    dir: col('收/支'), amount: col('金额'), method: col('支付方式', '收/付款方式'), status: col('当前状态', '交易状态'),
    id: col('交易单号', '交易订单号'), note: col('备注'),
  };
  const get = (r, k) => (c[k] >= 0 ? String(r[c[k]] ?? '').trim() : '');
  const out = [];
  for (const r of rows.slice(headAt + 1)) {
    const time = toTime(get(r, 'time'));
    const amount = round2(num(get(r, 'amount')));
    if (!time || !(amount > 0)) continue;
    const dir = get(r, 'dir');
    out.push({
      source, time, date: time.slice(0, 10), amount,
      dir: dir === '支出' ? 'out' : dir === '收入' ? 'in' : 'other',
      type: get(r, 'type'), party: get(r, 'party').replace(/^\/$/, ''), product: get(r, 'product').replace(/^\/$/, ''),
      method: get(r, 'method').replace(/^\/$/, '') || (source === 'wechat' ? '零钱' : '余额'),
      status: get(r, 'status'), id: get(r, 'id').replace(/^\t+|\t+$/g, '') || `${source}-${time}-${amount}`, note: get(r, 'note'),
    });
  }
  return { source, rows: out };
}

// 这一笔要不要拿来对：只看花出去的；退款、关闭、提现充值这些不算
export function billSkipReason(b) {
  if (b.dir !== 'out') return b.dir === 'in' ? '收入' : '不计收支（转账、充值、提现）';
  if (/关闭|失败|全额退款|退款成功|已退款$/.test(b.status)) return '退款或没付成功';
  return null;
}

// 账本里花出去的每一笔（支出、AA 垫的、转出去的），AA 的几笔按 group 合成一笔对（账单上是付的总数）
function outflows(tx) {
  const out = [];
  const groups = new Map();
  for (const t of tx) {
    if (!t.account) continue; // 别人代付的，账户没动钱
    if (!['expense', 'advance', 'transfer', 'payback'].includes(t.type)) continue;
    if (t.group) {
      const g = groups.get(t.group) || { ids: [], date: t.date, amount: 0, bill: null };
      g.ids.push(t.id); g.amount = round2(g.amount + t.amount); g.bill ||= t.bill || null;
      groups.set(t.group, g);
    } else out.push({ ids: [t.id], date: t.date, amount: t.amount, bill: t.bill || null });
  }
  return [...out, ...groups.values()];
}

const dayDiff = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

// 对账：账单上的每一笔，找账本里金额一样、日期差 2 天以内的（每笔只用一次）；导入过的按单号直接认
export function matchBills(bills, tx, openingDate = '') {
  const pool = outflows(tx);
  const byBill = new Map(pool.filter((x) => x.bill).map((x) => [x.bill, x]));
  const used = new Set();
  const result = { matched: [], missing: [], skipped: [], before: [] };
  for (const b of [...bills].sort((x, y) => x.time.localeCompare(y.time))) {
    const why = billSkipReason(b);
    if (why) { result.skipped.push({ b, why }); continue; }
    if (openingDate && b.date < openingDate) { result.before.push(b); continue; }
    const hit = byBill.get(b.id);
    if (hit) { used.add(hit); result.matched.push({ b, t: hit }); continue; }
    let best = null;
    for (const x of pool) {
      if (used.has(x) || x.bill || Math.abs(x.amount - b.amount) > 0.005) continue;
      const dd = dayDiff(x.date, b.date);
      if (dd <= 2 && (!best || dd < dayDiff(best.date, b.date))) best = x;
    }
    if (best) { used.add(best); result.matched.push({ b, t: best }); } else result.missing.push(b);
  }
  return result;
}

// 商家名 → 类别（账单上的「交易对方」）
const MERCHANTS = [
  [/美团外卖|饿了么|外卖/, 'c-takeout'], [/滴滴|高德打车|曹操|T3出行|出租/, 'c-taxi'], [/哈啰|青桔|美团单车|单车/, 'c-bike'],
  [/12306|铁路|航空|携程|飞猪|去哪儿/, 'c-train'], [/地铁|公交|乘车码/, 'c-bus'],
  [/瑞幸|星巴克|蜜雪|茶百道|喜茶|奈雪|古茗|沪上阿姨|霸王茶姬|库迪|奶茶|咖啡/, 'c-drink'],
  [/顺丰|中通|圆通|韵达|申通|京东物流|菜鸟|邮政|快递/, 'c-express'], [/打印|复印|文印/, 'c-print'],
  [/理发|美发|造型/, 'c-hair'], [/医院|诊所|门诊/, 'c-doctor'], [/药房|药店|大药/, 'c-medical'],
  [/超市|便利店|罗森|全家|7-?11|美宜佳|生鲜/, 'c-dorm'], [/水果/, 'c-fruit'], [/面包|烘焙|甜品/, 'c-snack'],
  [/App Store|Apple|网易云|QQ音乐|腾讯视频|爱奇艺|优酷|哔哩哔哩|bilibili/i, 'c-member'],
];

// 猜类别：以前记过同一个商家的 → 商家名 → 商品名里的字（导入小票的 guessCategory）
export function guessBillCategory(b, cats, tx, guessByName) {
  const ok = (id) => (cats.some((c) => c.id === id) ? id : null);
  const party = b.party.trim();
  if (party) {
    const past = [...tx].reverse().find((t) => t.type === 'expense' && t.category && t.billParty === party);
    if (past && ok(past.category)) return past.category;
  }
  if (/红包/.test(b.type + b.product)) return ok('c-hongbao');
  const text = `${party} ${b.product}`;
  for (const [re, id] of MERCHANTS) if (re.test(text) && ok(id)) return id;
  return guessByName(b.product || party);
}

// 转给个人的钱（微信转账、红包、支付宝转账）：可能是 AA、还钱，默认不记，让用户自己看
export function isPersonal(b) {
  return /转账|红包/.test(b.type) || (b.source === 'alipay' && /转账/.test(b.product));
}

// 付款方式 → 账本账户：记住过的直接用；微信零钱 → 名字带「微信」的账户；其他按上次用的
export function guessAccount(b, accounts, remembered = {}, fallback = null) {
  const key = `${b.source}:${b.method}`;
  if (remembered[key] && accounts.some((a) => a.id === remembered[key])) return remembered[key];
  if (b.source === 'wechat' && /零钱/.test(b.method)) {
    const w = accounts.find((a) => /微信/.test(a.name));
    if (w) return w.id;
  }
  return fallback && accounts.some((a) => a.id === fallback) ? fallback : accounts[0]?.id;
}
export const methodKey = (b) => `${b.source}:${b.method}`;
