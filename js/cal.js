// 法定节假日、农历、生日：账本和「生活」网站（life/js/cal.js）同一份，改了两边一起改。纯计算。

const pad = (n) => String(n).padStart(2, '0');
const parseDay = (s) => new Date(`${s}T12:00:00`);
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDay = (day, n) => { const d = parseDay(day); d.setDate(d.getDate() + n); return ymd(d); };

// ---------- 农历（浏览器自带的中国历法） ----------

const lunarFmt = (() => { try { return new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' }); } catch { return null; } })();
const lunarCache = new Map();
const LUNAR_FIX = [['2027-02-06', 1]]; // [这个月初一的公历日期, 农历几月]
// 公历这一天是农历几月几号；闰月 leap = true
export function lunarOf(day) {
  if (!lunarFmt) return null;
  if (lunarCache.has(day)) return lunarCache.get(day);
  const [y, mo, d] = day.split('-').map(Number);
  const parts = lunarFmt.formatToParts(new Date(Date.UTC(y, mo - 1, d, 4))); // 北京时间中午
  const m = parts.find((p) => p.type === 'month')?.value || '';
  let out = { m: parseInt(m, 10), d: parseInt(parts.find((p) => p.type === 'day')?.value, 10), leap: /bis|闰/.test(m) };
  // 浏览器的算法在朔月贴着半夜时会差一天，按紫金山天文台的日历改过来
  for (const [start, fm] of LUNAR_FIX) {
    const n = Math.round((parseDay(day) - parseDay(start)) / 86400000);
    if (n === 0 || (n > 0 && n < 31 && out.m === fm && !out.leap)) out = { m: fm, d: n + 1, leap: false };
  }
  lunarCache.set(day, out);
  return out;
}

// 从 from 这天起（含当天），农历 m 月 d 日下一次是公历哪天。那个月没有三十就算二十九；闰月不算
export function nextLunar(m, d, from, maxDays = 400) {
  for (let i = 0; i < maxDays; i++) {
    const day = addDay(from, i);
    const l = lunarOf(day);
    if (!l) return null;
    if (l.leap || l.m !== m) continue;
    if (l.d === d) return day;
    if (d === 30 && l.d === 29) {
      const nx = lunarOf(addDay(day, 1));
      if (nx.m !== m || nx.leap) return day;
    }
  }
  return null;
}

const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
export const lunarName = (m, d) => `${LUNAR_MONTHS[m - 1]}月${LUNAR_DAYS[d - 1]}`;

// ---------- 生日 ----------

// b：{ cal: 'solar' | 'lunar', m, d, y? }。返回从 today 起下一次过生日的公历日期
export function nextBirthday(b, today) {
  if (!b?.m || !b?.d) return null;
  if (b.cal === 'lunar') return nextLunar(b.m, b.d, today);
  const y = Number(today.slice(0, 4));
  for (const yy of [y, y + 1]) {
    let d = b.d;
    if (b.m === 2 && d === 29 && !(yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0))) d = 28;
    const day = `${yy}-${pad(b.m)}-${pad(d)}`;
    if (day >= today) return day;
  }
  return null;
}
export const birthdayText = (b) => (!b?.m ? '' : b.cal === 'lunar' ? `农历${lunarName(b.m, b.d)}` : `${b.m}月${b.d}日`) + (b?.y ? `（${b.y}年）` : '');

// ---------- 法定节假日 ----------

// 国务院公布的放假安排：每年 11 月前后公布下一年的，公布了就补进来；没有的年份按节日日期估算
const OFFICIAL = {
  2026: [['元旦', '2026-01-01', '2026-01-03'], ['春节', '2026-02-15', '2026-02-23'], ['清明', '2026-04-04', '2026-04-06'], ['劳动节', '2026-05-01', '2026-05-05'],
    ['端午', '2026-06-19', '2026-06-21'], ['中秋', '2026-09-25', '2026-09-27'], ['国庆', '2026-10-01', '2026-10-07']],
};
const qingming = (year) => { const y = year % 100; return `${year}-04-${pad(Math.floor(y * 0.2422 + 4.81) - Math.floor(y / 4))}`; };

export function holidays(year) {
  const list = OFFICIAL[year] || (() => {
    const out = [['元旦', `${year}-01-01`, `${year}-01-01`]];
    const spring = nextLunar(1, 1, `${year}-01-15`);
    if (spring) out.push(['春节', addDay(spring, -1), addDay(spring, 6)]); // 除夕到初七
    out.push(['清明', qingming(year), addDay(qingming(year), 2)], ['劳动节', `${year}-05-01`, `${year}-05-05`]);
    const duanwu = nextLunar(5, 5, `${year}-05-01`);
    if (duanwu) out.push(['端午', duanwu, addDay(duanwu, 2)]);
    const mid = nextLunar(8, 15, `${year}-09-01`);
    if (mid && mid >= `${year}-10-01` && mid <= `${year}-10-08`) out.push(['国庆中秋', `${year}-10-01`, `${year}-10-08`]);
    else {
      if (mid) out.push(['中秋', mid, addDay(mid, 2)]);
      out.push(['国庆', `${year}-10-01`, `${year}-10-07`]);
    }
    return out;
  })();
  return list.map(([name, start, end]) => ({ key: `${year}-${name}`, name, start, end }));
}

// 今天在不在某个假期里（放假前一天也算，方便提前约人）。周末不算
export function holidayAround(today) {
  const y = Number(today.slice(0, 4));
  return [...holidays(y), ...holidays(y + 1)].find((x) => addDay(x.start, -1) <= today && today <= x.end) || null;
}
export const holidayLine = (x, today) => (today < x.start ? `明天开始放${x.name}了` : `${x.name}假期`);

// ---------- 过节问候 ----------

export const GREET_DAYS = { newyear: '元旦', spring: '春节', duanwu: '端午', mid: '中秋', teacher: '教师节' };
export function festivalDay(key, year) {
  switch (key) {
    case 'newyear': return `${year}-01-01`;
    case 'spring': return nextLunar(1, 1, `${year}-01-15`);
    case 'duanwu': return nextLunar(5, 5, `${year}-05-01`);
    case 'mid': return nextLunar(8, 15, `${year}-08-25`);
    case 'teacher': return `${year}-09-10`;
    default: return null;
  }
}
// 今天是哪个节的前一天或当天：[{ key, name, day, fkey: '年-key' }]
export function festivalsAround(today) {
  const y = Number(today.slice(0, 4));
  const out = [];
  for (const yy of [y, y + 1]) {
    for (const [key, name] of Object.entries(GREET_DAYS)) {
      const day = festivalDay(key, yy);
      if (day && addDay(day, -1) <= today && today <= day) out.push({ key, name, day, fkey: `${yy}-${key}` });
    }
  }
  return out;
}
