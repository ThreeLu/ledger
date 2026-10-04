// 账本数据读写：私有仓库里的 finance.json。
//
// 先存手机、后台上传：save() 在本地数据上执行修改，算出「改了什么」（patch），放进待上传队列（localStorage），
// 页面立刻更新；后台 sync() 读 GitHub 上最新的账本，把队列里的 patch 按顺序套上去，提交一次。
// 所以没信号也能记，两台设备各记各的也不会互相覆盖（按每一笔合并，同一笔两边都改了以后改的为准）。
//
// patch 的格式：
//   coll: { 列表名: { up: [新增或改过的对象], del: [删掉的 id], order: [id 顺序] | null } }   ← 元素都带 id 的列表（tx、wishes……）
//   obj:  { 键: { 字段: 新值 | DEL } }                                                         ← 普通对象（settings、budget……），按字段合并
//   sets: { 键: 新值 | DEL }                                                                   ← 其他（字符串、没有 id 的列表……），整个替换
//
// 上传发票（要先传文件）、自动记固定扣费（必须在最新数据上判断有没有记过）走 online：直接提交，没网就失败。

import { GitHubError } from './github.js';
import { migrate } from './money.js';

export const DATA_FILE = 'finance.json';
const CACHE_KEY = 'ledger-cache';
const QUEUE_KEY = 'ledger-queue';
const DEL = { __del: true };

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- patch ----------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isColl = (x) => Array.isArray(x) && x.every((o) => o && typeof o === 'object' && !Array.isArray(o) && 'id' in o);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export function diff(base, next) {
  const patch = { coll: {}, obj: {}, sets: {} };
  for (const k of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const a = base[k];
    const b = next[k];
    if (same(a, b)) continue;
    if (b === undefined) { patch.sets[k] = DEL; continue; }
    if (isColl(b) && (a === undefined || isColl(a))) {
      const old = new Map((a || []).map((o) => [o.id, o]));
      const ids = new Set(b.map((o) => o.id));
      const kept = (a || []).map((o) => o.id).filter((id) => ids.has(id));
      const now = b.map((o) => o.id).filter((id) => old.has(id));
      patch.coll[k] = {
        up: b.filter((o) => !old.has(o.id) || !same(old.get(o.id), o)),
        del: (a || []).map((o) => o.id).filter((id) => !ids.has(id)),
        order: same(kept, now) ? null : b.map((o) => o.id),
      };
    } else if (isObj(a) && isObj(b)) {
      const fields = {};
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!same(a[f], b[f])) fields[f] = b[f] === undefined ? DEL : b[f];
      }
      patch.obj[k] = fields;
    } else {
      patch.sets[k] = b;
    }
  }
  return patch;
}

export const emptyPatch = (p) => !Object.keys(p.coll).length && !Object.keys(p.obj).length && !Object.keys(p.sets).length;

export function apply(data, patch) {
  const copy = (v) => structuredClone(v);
  for (const [k, v] of Object.entries(patch.sets || {})) {
    if (v && v.__del) delete data[k]; else data[k] = copy(v);
  }
  for (const [k, fields] of Object.entries(patch.obj || {})) {
    if (!isObj(data[k])) data[k] = {};
    for (const [f, v] of Object.entries(fields)) {
      if (v && v.__del) delete data[k][f]; else data[k][f] = copy(v);
    }
  }
  for (const [k, { up = [], del = [], order = null }] of Object.entries(patch.coll || {})) {
    let arr = Array.isArray(data[k]) ? data[k] : [];
    const gone = new Set(del);
    arr = arr.filter((o) => !gone.has(o.id));
    for (const o of up) {
      const i = arr.findIndex((x) => x.id === o.id);
      if (i >= 0) arr[i] = copy(o); else arr.push(copy(o));
    }
    if (order) {
      const pos = new Map(order.map((id, i) => [id, i]));
      arr = arr.map((o, i) => ({ o, i })).sort((x, y) => (pos.get(x.o.id) ?? 1e9 + x.i) - (pos.get(y.o.id) ?? 1e9 + y.i)).map((x) => x.o);
    }
    data[k] = arr;
  }
  return data;
}

// ---------- Store ----------

export class Store {
  constructor(gh) {
    this.gh = gh;
    this.remote = null; // GitHub 上的账本（最后一次读到 / 提交的）
    this.data = null; // 页面上看到的 = remote + 还没上传的修改
    this.head = null;
    this.missing = false; // 仓库里还没有 finance.json（第一次使用）
    this.queue = this.readQueue();
    this.status = { state: this.queue.length ? 'pending' : 'ok', error: '', pending: this.queue.length };
    this.onStatus = () => {};
    this.syncing = null;
    this.retryTimer = null;
  }

  readQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY));
      return q && q.repo === this.gh.repo ? q.items : [];
    } catch { return []; }
  }

  writeQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify({ repo: this.gh.repo, items: this.queue })); } catch { /* 存不下：至少这次打开里还在 */ }
  }

  setStatus(state, error = '') {
    this.status = { state, error, pending: this.queue.length };
    this.onStatus(this.status);
  }

  rebuild() {
    this.data = this.remote ? this.queue.reduce((d, q) => apply(d, q.patch), migrate(structuredClone(this.remote))) : null;
  }

  loadCached() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && cached.repo === this.gh.repo && cached.data) {
        this.remote = migrate(cached.data);
        this.head = cached.head;
        this.rebuild();
        return true;
      }
    } catch { /* 缓存坏了就当没有 */ }
    return false;
  }

  writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ repo: this.gh.repo, head: this.head, data: this.remote }));
    } catch { /* 存不下就算了 */ }
  }

  async readData(ref) {
    try {
      return migrate(JSON.parse(await this.gh.readText(DATA_FILE, ref)));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async load() {
    const head = await this.gh.headSha();
    if (head !== this.head || !this.remote) {
      const data = await this.readData(head);
      this.missing = !data;
      this.remote = data;
      this.head = head;
      this.rebuild();
      if (data) this.writeCache();
    }
    if (this.queue.length) this.sync();
  }

  // 第一次使用：写入初始账本
  async create(data, message) {
    const head = await this.gh.headSha();
    this.head = await this.gh.commit(head, [{ path: DATA_FILE, content: JSON.stringify(data, null, 1) + '\n' }], message);
    this.remote = migrate(data);
    this.missing = false;
    this.rebuild();
    this.writeCache();
  }

  // 读写账本以外的 JSON 文件（比如推送订阅 config/push.json）。不存在返回 null
  async readJson(path, ref = 'main') {
    try {
      return JSON.parse(await this.gh.readText(path, ref));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async saveJson(path, mutate, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.gh.headSha();
      const next = mutate(structuredClone((await this.readJson(path, head)) || {}));
      try {
        const sha = await this.gh.commit(head, [{ path, content: JSON.stringify(next, null, 1) + '\n' }], message);
        if (head === this.head) this.head = sha; // 账本内容没变，缓存还能用
        return next;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
      }
    }
  }

  // mutate(data) 直接修改传入的数据，可返回结果（返回 false 表示不用改）。
  // 默认先存手机、后台上传；uploads / removes / online 时直接提交到 GitHub（要等、要有网）。
  async save(message, mutate, { uploads = [], removes = [], online = false } = {}) {
    if (uploads.length || removes.length || online) return this.saveOnline(message, mutate, { uploads, removes });
    if (!this.data) throw new Error('账本还没读出来');
    const next = structuredClone(this.data);
    const result = mutate(next);
    if (result === false) return false;
    const patch = diff(this.data, next);
    if (emptyPatch(patch)) return result;
    this.queue.push({ id: newId('q'), message, patch, at: new Date().toISOString() });
    this.writeQueue();
    this.data = next;
    this.setStatus('pending');
    this.sync();
    return result;
  }

  // 把队列里的修改合并进 GitHub 上最新的账本，一次提交
  sync() {
    if (this.syncing) return this.syncing;
    clearTimeout(this.retryTimer);
    this.syncing = (async () => {
      for (let attempt = 0; this.queue.length && attempt < 5; attempt++) {
        const batch = this.queue.slice();
        this.setStatus('syncing');
        try {
          const head = await this.gh.headSha();
          const base = head === this.head && this.remote ? this.remote : await this.readData(head);
          if (!base) throw new Error('数据仓库里还没有账本');
          const next = batch.reduce((d, q) => apply(d, q.patch), structuredClone(base));
          const msg = batch.length === 1 ? batch[0].message : `${batch[0].message}（等 ${batch.length} 项）`;
          const sha = await this.gh.commit(head, [{ path: DATA_FILE, content: JSON.stringify(next, null, 1) + '\n' }], msg);
          const done = new Set(batch.map((q) => q.id));
          this.queue = this.queue.filter((q) => !done.has(q.id));
          this.writeQueue();
          this.remote = next;
          this.head = sha;
          this.writeCache();
          this.rebuild();
          attempt = -1; // 成功了：同步期间又新记的，接着传
        } catch (e) {
          if (e instanceof GitHubError && e.status === 422) continue; // 别的设备刚提交过：重读再来
          const offline = !(e instanceof GitHubError) || e.status === 0;
          this.setStatus(offline ? 'offline' : 'error', e.message);
          // 过一会儿自动再试；有网了也会马上试（main.js 监听 online）
          this.retryTimer = setTimeout(() => this.sync(), offline ? 20000 : 60000);
          return;
        }
      }
      this.setStatus(this.queue.length ? 'pending' : 'ok');
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async saveOnline(message, mutate, { uploads, removes }) {
    if (this.queue.length) {
      await this.sync();
      if (this.queue.length) throw new Error('现在连不上 GitHub，等有网了再试');
    }
    const blobs = [];
    for (const u of uploads) blobs.push({ path: u.path, sha: await this.gh.createBlob(u.base64) });
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.gh.headSha();
      const base = head === this.head && this.remote ? this.remote : await this.readData(head);
      if (!base) throw new Error('数据仓库里还没有账本');
      const next = structuredClone(base);
      const result = mutate(next);
      if (result === false) return false; // 修改函数发现不用改（比如别的设备已经记过了）
      try {
        const changes = [{ path: DATA_FILE, content: JSON.stringify(next, null, 1) + '\n' }, ...blobs, ...removes.map((path) => ({ path, remove: true }))];
        this.head = await this.gh.commit(head, changes, message);
        this.remote = next;
        this.writeCache();
        this.rebuild();
        return result;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
      }
    }
  }
}
