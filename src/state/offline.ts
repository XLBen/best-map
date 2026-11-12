import { signal } from '@preact/signals';
import { OfflineWatch, browserDeps } from '../offline/register';
import { autosaveNow } from './autosave';

// 离线（第一百零一轮）：界面看的两个信号，和“重新载入用上新版本”的那一下。登记、什么时候启用在 ../offline/register.ts

// 壳已经存在这个浏览器里：断网、服务器关了也打得开
export const offlineReady = signal(false);
// 有新版本装好了在等着：这个页面重新载入以后用上
export const updateReady = signal(false);

let watch: OfflineWatch | null = null;

// 页面载入完了才去登记（不和第一次打开抢）；载入迟迟不算完（有的图、字体一直没来）时最多等这么久
export const REGISTER_WAIT_MS = 5000;

// 程序起来以后调一次（main.tsx）。只在打包好的程序里登记
export function startOffline(): void {
  if (watch || typeof window === 'undefined') return;
  const w = new OfflineWatch(
    browserDeps(
      import.meta.env.PROD,
      () => (offlineReady.value = true),
      () => (updateReady.value = true),
    ),
  );
  watch = w;
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    void w.start();
  };
  if (document.readyState === 'complete') go();
  else {
    window.addEventListener('load', go, { once: true });
    setTimeout(go, REGISTER_WAIT_MS);
  }
}

// “重新载入”：先把这张地图存好，再让新版本启用、重新载入。没存成时浏览器照平常那样先问“要离开吗”
export async function reloadForUpdate(reload: () => void = () => location.reload()): Promise<void> {
  try {
    await autosaveNow();
  } catch {
    // 存不了：浏览器会问
  }
  if (watch) watch.apply(reload);
  else reload();
}
