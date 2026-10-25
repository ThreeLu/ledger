// 账本读物品档案：买不买、心愿单建议带上已有的东西；「手机丢了」页看物品档案仓库最近的修改。
// 两个网站在同一个域名下（threelu.github.io），令牌是同一个，所以直接读物品档案的数据仓库（inventory.json）。

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
