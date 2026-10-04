// 账本数据读写：私有仓库里的 finance.json。每次修改是一次提交；别的设备刚改过（422）就在最新数据上重做一遍。

import { GitHubError } from './github.js';
import { migrate } from './money.js';

export const DATA_FILE = 'finance.json';
const CACHE_KEY = 'ledger-cache';

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class Store {
  constructor(gh) {
    this.gh = gh;
    this.data = null;
    this.head = null;
    this.missing = false; // 仓库里还没有 finance.json（第一次使用）
  }

  loadCached() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && cached.repo === this.gh.repo && cached.data) {
        this.data = migrate(cached.data);
        this.head = cached.head;
        return true;
      }
    } catch { /* 缓存坏了就当没有 */ }
    return false;
  }

  writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ repo: this.gh.repo, head: this.head, data: this.data }));
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
    if (head === this.head && this.data) return;
    const data = await this.readData(head);
    this.missing = !data;
    this.data = data;
    this.head = head;
    if (data) this.writeCache();
  }

  // 第一次使用：写入初始账本
  async create(data, message) {
    const head = await this.gh.headSha();
    this.head = await this.gh.commit(head, [{ path: DATA_FILE, content: JSON.stringify(data, null, 1) + '\n' }], message);
    this.data = migrate(data);
    this.missing = false;
    this.writeCache();
  }

  // mutate(data) 直接修改传入的数据，可返回结果；uploads: [{ path, base64 }]；removes: [path]
  async save(message, mutate, { uploads = [], removes = [] } = {}) {
    const blobs = [];
    for (const u of uploads) blobs.push({ path: u.path, sha: await this.gh.createBlob(u.base64) });
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.gh.headSha();
      const base = head === this.head && this.data ? this.data : await this.readData(head);
      if (!base) throw new Error('数据仓库里还没有账本');
      const next = structuredClone(base);
      const result = mutate(next);
      if (result === false) return false; // 修改函数发现不用改（比如别的设备已经记过了）
      try {
        const changes = [{ path: DATA_FILE, content: JSON.stringify(next, null, 1) + '\n' }, ...blobs, ...removes.map((path) => ({ path, remove: true }))];
        this.head = await this.gh.commit(head, changes, message);
        this.data = next;
        this.writeCache();
        return result;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
      }
    }
  }
}
