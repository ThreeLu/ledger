// 账本 → 物品档案：导入小票时，档案里有的东西补数量、新东西放进「买回来还没建档」。
// 两个网站在同一个域名下（threelu.github.io），令牌是同一个，所以直接读写物品档案的数据仓库（inventory.json）。
// 物品档案那边是「先存手机、后台上传」，它上传时会在 GitHub 最新的数据上合并，所以这里直接提交不会被覆盖。
// 物品档案的格式见 inventory/CLAUDE.md；这里只动 items 的数量 / 备注和 shopping，不分编号、不建物品。

import { GitHub, GitHubError } from './github.js';

const INVENTORY_FILE = 'inventory.json';

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

// 物品档案仓库：物品档案设置里填过就用那个，没有就和账本同一个账号下的 inventory-data
export function inventoryGitHub(ledgerSettings) {
  const inv = readLocal('inventory-settings');
  const owner = (ledgerSettings.repo || 'ThreeLu/finance-data').split('/')[0];
  const token = inv.token || ledgerSettings.token;
  return token ? new GitHub({ token, repo: inv.repo || `${owner}/inventory-data` }) : null;
}

// 读物品档案。读不到（没开通、令牌没授权）返回 null
export async function readInventory(gh) {
  if (!gh) return null;
  try {
    return JSON.parse(await gh.readText(INVENTORY_FILE, 'main'));
  } catch (e) {
    if (e instanceof GitHubError || e instanceof SyntaxError) return null;
    throw e;
  }
}

// 在最新的 inventory.json 上执行 mutate，提交；冲突（物品档案刚被别的设备改过）就重读再来
export async function updateInventory(gh, mutate, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await gh.headSha();
    const data = JSON.parse(await gh.readText(INVENTORY_FILE, head));
    mutate(data);
    try {
      await gh.commit(head, [{ path: INVENTORY_FILE, content: JSON.stringify(data, null, 1) + '\n' }], message.slice(0, 200));
      return;
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422) || attempt === 3) throw e;
    }
  }
}
