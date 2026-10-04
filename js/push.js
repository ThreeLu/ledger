// 手机推送（Web Push）：订阅信息存在账本仓库的 config/push.json，账本仓库的定时任务每晚 9 点用私钥发推送。
// 和物品档案用不同的一对密钥。公钥可以公开；私钥只在账本仓库的 Actions secret（VAPID_PRIVATE_KEY）里。

export const VAPID_PUBLIC_KEY = 'BGMLPTZy83j3PGcSHPeku7UZH76wUwhKryIub13moQ7Ny9rUyMh5tBUEuiS2-yNO6w1c1nO7dk5z1W8JxxrZnpY';
export const PUSH_FILE = 'config/push.json';

export function pushSupport() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    return { ok: false, why: ios && !standalone ? '在 iPhone 上要先「分享 → 添加到主屏幕」，从主屏幕打开后再来开启（需要 iOS 16.4 以上）' : '这个浏览器不支持网页推送' };
  }
  return { ok: true };
}

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupport().ok) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// 申请通知权限、订阅；返回订阅的 JSON（endpoint + keys）
export async function subscribe() {
  const sup = pushSupport();
  if (!sup.ok) throw new Error(sup.why);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('没有允许通知。iPhone：设置 → 通知 → 账本 → 允许通知');
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  await reg.showNotification('提醒已开启', { body: '每晚 9 点左右：没记账会提醒你；周日和预算月最后一天会发总结。', icon: 'icon-180.png', tag: 'ledger-welcome' });
  return sub.toJSON();
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return '安卓手机';
  if (/Mac/.test(ua)) return 'Mac';
  return '电脑';
}
