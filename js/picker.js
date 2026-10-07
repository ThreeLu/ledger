// 选人：输入一个字就出补全（「黄」→ 黄雨申），点一下选上；不用在一大排名字里找。
// 账本和「生活」（life/js/picker.js）同一份，改了两边一起改。
//
// personPicker({ people: [{ id, name, hint?, archived? }], value: [id], multi, label, recent: [id], onChange(ids), onNew?(name) → { id, name } })
// 选上的人显示成小标签（点 × 去掉）；没有这个人时可以「＋ 新加「名字」」（给了 onNew 才有）。

import { h } from './util.js';

export function personPicker({ people, value = [], multi = false, label = '找人', placeholder = '输入名字找人', recent = [], onChange, onNew = null }) {
  let chosen = [...value];
  const extra = []; // 这次新加的人
  const all = () => [...people, ...extra];
  const byId = (id) => all().find((p) => p.id === id);
  const box = h('div', { class: 'picker' });
  const tokens = h('div', { class: 'picker-tokens' });
  const list = h('div', { class: 'picker-list', role: 'listbox', 'aria-label': '可以选的人' });
  const input = h('input', { class: 'picker-input', 'aria-label': label, placeholder, autocomplete: 'off', enterkeyhint: 'done' });
  let open = false;

  const set = (ids) => { chosen = ids; drawTokens(); onChange?.(multi ? [...chosen] : chosen[0] || ''); };
  const pick = (p) => {
    if (multi) set(chosen.includes(p.id) ? chosen : [...chosen, p.id]);
    else set([p.id]);
    input.value = '';
    if (multi) { drawList(); input.focus(); } else { open = false; drawList(); input.blur(); }
  };
  const matches = (q) => {
    const live = all().filter((p) => !chosen.includes(p.id));
    if (!q) return recent.map(byId).filter((p) => p && !chosen.includes(p.id) && !p.archived).slice(0, 5);
    const score = (p) => (p.name.startsWith(q) ? 0 : p.name.includes(q) ? 1 : 2);
    return live.filter((p) => p.name.includes(q) || (p.hint || '').includes(q))
      .sort((a, b) => Boolean(a.archived) - Boolean(b.archived) || score(a) - score(b) || a.name.localeCompare(b.name, 'zh'))
      .slice(0, 8);
  };
  const drawList = () => {
    const q = input.value.trim();
    const found = open ? matches(q) : [];
    const canNew = open && onNew && q && !all().some((p) => p.name === q);
    list.replaceChildren(
      !q && found.length ? h('div', { class: 'picker-cap' }, '最近') : null,
      ...found.map((p) => h('button', { type: 'button', role: 'option', class: `picker-opt${p.archived ? ' gone' : ''}`, onmousedown: (e) => e.preventDefault(), onclick: () => pick(p) },
        h('b', {}, p.name), p.hint ? h('span', { class: 'muted small' }, p.hint) : null)),
      canNew ? h('button', { type: 'button', role: 'option', class: 'picker-opt new', onmousedown: (e) => e.preventDefault(), onclick: () => {
        const p = onNew(q);
        if (!p) return;
        if (!people.some((x) => x.id === p.id)) extra.push(p);
        pick(p);
      } }, `＋ 新加「${q}」`) : null,
      open && q && !found.length && !canNew ? h('div', { class: 'picker-cap' }, '没找到') : null);
    list.hidden = !list.childElementCount;
  };
  const drawTokens = () => {
    tokens.replaceChildren(...chosen.map((id) => byId(id)).filter(Boolean).map((p) => h('span', { class: 'picker-token' }, p.name,
      h('button', { type: 'button', class: 'picker-x', 'aria-label': `去掉${p.name}`, onclick: () => set(chosen.filter((x) => x !== p.id)) }, '×'))));
    input.placeholder = !multi && chosen.length ? '换一个人' : placeholder;
  };
  input.addEventListener('focus', () => { open = true; drawList(); });
  input.addEventListener('blur', () => { setTimeout(() => { open = false; drawList(); }, 120); });
  input.addEventListener('input', () => { open = true; drawList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    list.querySelector('.picker-opt')?.click();
  });
  drawTokens();
  drawList();
  box.append(tokens, input, list);
  return box;
}

// 最近用过的人（按日期倒着）：从一串 { id, day } 里取不重复的
export function recentIds(items, n = 5) {
  const out = [];
  for (const x of [...items].sort((a, b) => (b.day || '').localeCompare(a.day || ''))) {
    if (x.id && !out.includes(x.id)) out.push(x.id);
    if (out.length >= n) break;
  }
  return out;
}
