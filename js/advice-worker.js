// 建议要跑几十次模拟（敏感性分析的二分法、方差分解），放在后台线程算，页面不卡（2026-10-25）。
// 收：{ key, data, today, opts, unc }；回：{ key, items, unc }
import { prepareAhead, simulateAhead, adviceItems, uncertaintySources } from './forecast.js';

self.onmessage = (e) => {
  const { key, data, today, opts, unc } = e.data;
  try {
    const o = { ...opts, prep: prepareAhead(data, today, opts) }; // 准备一次，几十次模拟共用
    const sim = simulateAhead(data, today, o);
    self.postMessage({ key, items: adviceItems(data, today, sim, o), unc: unc ? uncertaintySources(data, today, o) : null });
  } catch (err) {
    self.postMessage({ key, error: String(err) });
  }
};
