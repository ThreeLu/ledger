// 导入小票、Siri 记账用到的纯计算：读别的 AI 整理好的小票、猜类别、对上物品档案里的东西、听懂一句话记账。
// 不碰页面和网络，可以用 node 直接测。

const round2 = (n) => Math.round(n * 100) / 100;
const num = (s) => Number(String(s ?? '').replace(/[¥￥元,，\s]/g, ''));

// 给别的 AI（手机上能看照片的那个）的提示词：类别从账本里取，所以不会写死任何个人信息
export function receiptPrompt(categories, todayStr) {
  const names = categories.map((c) => c.name).join('、');
  return [
    '帮我把这张购物小票整理成 JSON，只输出 JSON，不要别的文字。格式：',
    '{"shop": "店名", "date": "YYYY-MM-DD", "total": 实付总额, "items": [{"name": "商品名", "qty": 数量, "price": 这一行实付的钱, "category": "类别"}]}',
    '要求：',
    '1. name 写简短好认的名字（比如「可口可乐 500ml」写成「可乐」，「维达抽纸 3 包装」写成「抽纸」），不要条码和货号。',
    '2. price 是这一行最后实际付的钱（数量 × 单价，扣掉这一行的优惠）。整单的优惠、满减，单独写一行 {"name": "优惠", "price": -优惠金额}。',
    '3. 所有 price 加起来要等于 total（实付）。看不清的写你最有把握的，名字后面加「?」。',
    `4. category 从这些里选一个：${names}。`,
    `5. 小票上没有日期就写 ${todayStr}。购物袋也算一行。`,
  ].join('\n');
}

// 读小票：优先 JSON（别的 AI 按提示词给的），不是 JSON 就一行一行认「名称 数量 价格」
export function parseReceipt(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('先把小票内容贴进来');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    let obj = null;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { /* 不是 JSON，按行读 */ }
    if (obj && Array.isArray(obj.items)) return normalize(obj);
  }
  return normalize(parseLines(raw));
}

function normalize(obj) {
  const items = obj.items.map((x) => ({
    name: String(x.name || '').trim(),
    qty: Math.max(1, Math.round(num(x.qty) || 1)),
    price: round2(num(x.price ?? x.amount)),
    hint: String(x.category || '').trim(),
  })).filter((x) => x.name && Number.isFinite(x.price) && x.price !== 0);
  if (!items.length) throw new Error('没认出商品。让 AI 按提示词再整理一次，或者一行写一样：名称 数量 价格');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(obj.date || '') ? obj.date : null;
  const total = num(obj.total);
  return { shop: String(obj.shop || '').trim(), date, total: total > 0 ? round2(total) : null, items };
}

// 一行一样：「可乐 ×2 6.0」「抽纸 2 19.9」「香蕉 7.5元」；「合计 / 实付 58.5」是总额
function parseLines(raw) {
  const out = { items: [], total: null, shop: '', date: null };
  for (let line of raw.split(/\n/)) {
    line = line.replace(/^[\s\-*•·\d]+[.、)）]\s*/, '').replace(/^[\s\-*•·]+/, '').trim();
    if (!line) continue;
    const date = line.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (date && !/[¥￥]|元/.test(line.replace(date[0], ''))) { out.date = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`; continue; }
    const m = line.match(/^(.+?)\s*(?:[x×*]\s*(\d+)|\s(\d+)\s*(?:件|个|包|瓶|盒|袋|支|斤)?)?\s*[:：]?\s*[¥￥]?\s*(-?\d+(?:\.\d+)?)\s*元?$/i);
    if (!m) { if (!out.items.length && !out.shop) out.shop = line; continue; }
    const name = m[1].replace(/[:：\s]+$/, '').trim();
    if (/^(合计|总计|实付|应付|总额|共计|小计)/.test(name)) { out.total = num(m[4]); continue; }
    out.items.push({ name, qty: m[2] || m[3] || 1, price: m[4] });
  }
  return out;
}

// 名字里的字 → 类别（物品档案「顺手记账」用的是同一张表，改的话两边一起改）
const BY_WORD = [
  [/水$|矿泉水|可乐|雪碧|汽水|茶饮|奶茶|咖啡|饮料|果汁|酸奶|牛奶|豆奶|红牛|脉动|东方树叶/, 'c-drink'],
  [/苹果|香蕉|橙|橘|梨|葡萄|西瓜|草莓|蓝莓|芒果|猕猴桃|水果|柚/, 'c-fruit'],
  [/薯片|饼干|面包|巧克力|糖|坚果|瓜子|辣条|泡面|方便面|火腿肠|零食|蛋糕|卤|肉干|海苔|果冻/, 'c-snack'],
  [/纸巾|抽纸|卷纸|湿巾|洗衣|清洁|垃圾袋|洗洁精|消毒|除菌|抹布|拖把|刷子|购物袋|塑料袋/, 'c-tissue'],
  [/洗面奶|洁面|面霜|乳液|精华|面膜|防晒|润唇|唇膏|身体乳|护手霜|爽肤水|护肤/, 'c-skin'],
  [/遮瑕|眉笔|素颜霜|粉底|隔离霜|修眉|眉刀|口红/, 'c-makeup'],
  [/香水|香氛/, 'c-scent'],
  [/牙膏|牙刷|牙线|洗面|洗发|护发|沐浴|香皂|肥皂|面霜|乳液|护肤|防晒|剃须|毛巾/, 'c-toiletry'],
  [/药|创可贴|口罩|体温计|碘伏|棉签/, 'c-medical'],
  [/笔|本子|笔记本|便利贴|文件夹|胶带|胶水|橡皮|尺|订书/, 'c-stationery'],
  [/电池|数据线|充电|耳机|插座|插线板|U盘|转接/, 'c-gadget'],
  [/收纳|挂钩|衣架|置物/, 'c-storage'],
  [/袜|内裤|背心|T恤|衬衫|裤|外套|卫衣/, 'c-clothes'],
];
// 一句话记账时常说的叫法
const SPOKEN = [
  [/早饭|早餐|早点/, 'c-breakfast'], [/午饭|午餐|中饭/, 'c-lunch'], [/晚饭|晚餐/, 'c-dinner'], [/夜宵|宵夜/, 'c-latenight'],
  [/外卖|美团|饿了么/, 'c-takeout'], [/奶茶|咖啡|饮料/, 'c-drink'], [/打车|滴滴|出租/, 'c-taxi'], [/地铁|公交/, 'c-bus'],
  [/单车|哈啰|美团单车/, 'c-bike'], [/火车|高铁|机票|飞机/, 'c-train'], [/理发|剪头/, 'c-hair'], [/洗澡/, 'c-bath'],
  [/洗衣机|洗衣服/, 'c-laundry'], [/快递|寄件/, 'c-express'], [/打印|复印/, 'c-print'], [/看病|挂号/, 'c-doctor'],
];

const usable = (cats, id) => (cats.some((c) => c.id === id) ? id : null);

// 猜类别：AI 给的类别名 → 账本里以前同名的东西 → 名字里的字 → 宿舍小物件
export function guessCategory(cats, tx, name, hint = '') {
  const byHint = hint && cats.find((c) => c.name === hint || c.name === hint.replace(/\s/g, ''));
  if (byHint) return byHint.id;
  const clean = name.replace(/[?？]$/, '');
  const past = [...tx].reverse().find((t) => t.type === 'expense' && t.category && (t.note || '').split(/[、，,：:\s]/).includes(clean));
  if (past && usable(cats, past.category)) return past.category;
  for (const [re, id] of BY_WORD) if (re.test(clean) && usable(cats, id)) return id;
  return usable(cats, 'c-dorm') || cats[0]?.id;
}

// 同一个类别的合成一笔（按类别合并，用户 2026-10-04 选的）：优惠（负数）并进金额最大的那一组
export function groupByCategory(lines) {
  const groups = new Map();
  const discounts = [];
  for (const l of lines) {
    if (l.price < 0) { discounts.push(l); continue; }
    const g = groups.get(l.category) || { category: l.category, amount: 0, names: [] };
    g.amount = round2(g.amount + l.price);
    g.names.push(l.qty > 1 ? `${l.name}×${l.qty}` : l.name);
    groups.set(l.category, g);
  }
  const list = [...groups.values()].sort((a, b) => b.amount - a.amount);
  for (const d of discounts) {
    if (!list.length) break;
    list[0].amount = round2(list[0].amount + d.price);
    list[0].names.push(`${d.name} ${d.price}`);
  }
  return list.filter((g) => g.amount > 0);
}

// ---------- 物品档案 ----------

const same = (a, b) => a.replace(/\s/g, '').toLowerCase() === b.replace(/\s/g, '').toLowerCase();
const contains = (a, b) => b.length >= 2 && a.replace(/\s/g, '').toLowerCase().includes(b.replace(/\s/g, '').toLowerCase());

// 小票上的一样东西对上物品档案：同名的最好，其次一方包含另一方（消耗品优先），再看购物清单上手动加的
export function matchInventory(inv, name) {
  if (!inv) return {};
  const clean = name.replace(/[?？]$/, '').trim();
  const items = (inv.items || []).filter((i) => !i.archived && !i.borrow);
  const exact = items.filter((i) => same(i.name, clean));
  const loose = items.filter((i) => contains(i.name, clean) || contains(clean, i.name));
  const pick = (list) => list.find((i) => i.consumable) || list[0];
  const item = pick(exact) || (loose.length ? pick(loose) : null);
  const extra = (inv.shopping?.extra || []).find((e) => same(e.name, clean) || contains(e.name, clean) || contains(clean, e.name));
  return { item: item || null, extra: extra || null };
}

// 默认怎么处理物品档案：对上了消耗品 → 补货；对上了耐用的 → 不动（多半是又买了一个，可以改成建档）；
// 没对上：吃的喝的、优惠 → 不进档案，其他 → 放进「买回来还没建档」
export function defaultInventoryAction(match, category, cats) {
  if (match.item?.consumable) return 'restock';
  if (match.item) return 'none';
  const group = cats.find((c) => c.id === category)?.group;
  return group === 'food' || !category ? 'none' : 'file';
}

// 现在一共有几个：用完了的从 0 算，其他的加上这次买的
export function restockQty(item, qty) {
  const have = item.consumable && Number(item.quantity) === 0 ? 0 : Number(item.quantity) || 0;
  return have + qty;
}

// 把确认好的小票写进 inventory.json（在 bridge.updateInventory 里、最新的数据上执行）
// lines: [{ name, qty, price, action: 'restock'|'file'|'none', itemId?, extraId?, newQty? }]
export function applyToInventory(data, lines, { date, shop, newId }) {
  data.shopping ||= {};
  const sh = data.shopping;
  sh.extra ||= []; sh.skip ||= {}; sh.history ||= []; sh.toFile ||= [];
  const now = new Date().toISOString();
  const where = shop ? `在${shop}` : '';
  for (const l of lines) {
    if (l.price < 0) continue;
    const rec = { date, name: l.name, price: l.price, from: 'receipt' };
    if (l.action === 'restock') {
      const it = data.items.find((i) => i.id === l.itemId);
      if (!it) continue;
      it.quantity = l.newQty;
      delete it.runningLow;
      it.purchaseDate = date;
      it.updatedAt = now;
      it.notes = [it.notes, `${date} ${where}买了 ${l.qty} 个，现在 ×${l.newQty}，¥${l.price}（小票导入）`].filter(Boolean).join('\n');
      rec.itemId = it.id;
      delete sh.skip[`i:${it.id}`];
    } else if (l.action === 'file') {
      sh.toFile.push({ id: newId('m'), name: l.name.replace(/[?？]$/, ''), price: l.price, qty: l.qty, date, from: 'receipt', paid: true });
    }
    // 购物清单上手动加的，买到了就划掉
    if (l.extraId) {
      sh.extra = sh.extra.filter((x) => x.id !== l.extraId);
      delete sh.skip[`m:${l.extraId}`];
    }
    if (l.action !== 'none' || l.extraId) sh.history.push(rec);
  }
  return data;
}

// ---------- 一句话记账（Siri） ----------

// 「午饭 18」「打车 23.5 块」「在超市买了抽纸 19.9」→ { amount, category, note }
export function parseSpoken(text, cats, { quick = [], tx = [] } = {}) {
  const raw = String(text || '').trim();
  // 「18」「23.5 元」「18块5」
  const AMOUNT = /(\d+(?:\.\d+)?)\s*(?:(块|元|rmb)\s*(\d)?\s*毛?)?/gi;
  const nums = [...raw.matchAll(AMOUNT)];
  let amount = null;
  if (nums.length) {
    const m = nums[nums.length - 1];
    amount = Number(m[1]) + (m[2] && m[3] && !m[1].includes('.') ? Number(m[3]) / 10 : 0);
  }
  const note = raw.replace(AMOUNT, '').replace(/^(记账|记一笔|花了|我)\s*/, '').replace(/(花了|用了)$/, '').replace(/\s+/g, ' ').trim();
  let category = null;
  const qk = quick.find((q) => q.name && raw.includes(q.name));
  if (qk) category = usable(cats, qk.category);
  if (!category) category = (cats.find((c) => c.kind !== 'income' && raw.includes(c.name)) || {}).id || null;
  if (!category) for (const [re, id] of SPOKEN) if (re.test(raw) && usable(cats, id)) { category = id; break; }
  if (!category && note) {
    const past = [...tx].reverse().find((t) => t.type === 'expense' && t.category && t.note && (t.note === note || note.includes(t.note)));
    if (past && usable(cats, past.category)) category = past.category;
  }
  if (!category) for (const [re, id] of BY_WORD) if (re.test(raw) && usable(cats, id)) { category = id; break; }
  return { amount: amount > 0 ? round2(amount) : null, category, note };
}
