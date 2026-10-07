// 人情要准备多少钱：让 DeepSeek 估一个参考。账本和「生活」（life/js/renqing.js）同一份，改了两边一起改。

export const FAVOR_BIG = 300; // 这个数以上算大额：自动变成存款目标；以下从日常里出

// who：{ name, hint }；f：{ text, dir, cost? }；history：礼尚往来和以前还过的人情，一行一条；budget：日常每月预算
export function estimatePrompt({ who, f, history = [], budget = 0 }) {
  const system = '你帮一个在读的研究生估一下：还这个人情（或者随这份礼）大概要准备多少钱。按中国大学生、研究生的一般做法，结合对方为他花了多少、你们以前来回送过多少、这件事的轻重和关系远近来估。'
    + '给一个整数（人民币，取整到 10 或 50），不要偏高到让他有负担，也不要失礼；对导师、长辈、老师可以稍正式一些。why 用一句话说怎么估的（比如「他请你吃饭约 120，回请一顿差不多」「同学婚礼随礼一般 200–500，你们关系近」）。'
    + '只输出 JSON：{"estimate":0,"why":""}';
  const user = [
    `${who.name}${who.hint ? `（${who.hint}）` : ''}。`,
    `${f.dir === 'owed' ? '他欠我' : '我欠他'}：${f.text}`,
    f.cost ? `他为我花了大约 ¥${f.cost}。` : '',
    history.length ? `以前的来往：\n${history.join('\n')}` : '',
    budget ? `他每月日常预算 ¥${budget}。` : '',
  ].filter(Boolean).join('\n');
  return { system, user };
}
export const cleanEstimate = (out) => ({ estimate: Math.max(0, Math.round(Number(out?.estimate) || 0)), why: String(out?.why || '').trim() });
