import { createRef } from 'preact';

// 底部条（ContextBar.tsx）的元素：它挂上时自己填进来（ref），地图据此量要把左下角的比例尺抬多高（MapView.tsx 的 barLift）。
// 第六十九轮：以前地图在整个页面里找 .bottombar
export const bottomBarRef = createRef<HTMLDivElement>();

// 第一百轮：底部条从窗口底边往上占了多高，写进 .app 的 --bar-clear（和顶栏的 --top-clear 一样）。触摸设备上按钮大、
// 底部条高，资源库面板、右下角的“这里”据此让出它（shell/touch.css；鼠标下的样式不读这个量）。
// ContextBar 每次画完调一次：底部条换了元素（换到指针时没有底部条）才重新接
let watched: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
export function trackBarClear() {
  const el = bottomBarRef.current;
  if (el === watched) return;
  dropBarClear();
  const app = el?.parentElement;
  if (!el || !app || typeof ResizeObserver === 'undefined') return;
  watched = el;
  const set = () => app.style.setProperty('--bar-clear', `${Math.round(app.clientHeight - el.offsetTop + 8)}px`);
  observer = new ResizeObserver(set);
  observer.observe(el);
  observer.observe(app);
  set();
}
export function dropBarClear() {
  observer?.disconnect();
  observer = null;
  watched?.parentElement?.style.removeProperty('--bar-clear');
  // 底部条先被拿掉时找不到它的父元素：按类名找
  if (watched && !watched.parentElement && typeof document !== 'undefined') (document.querySelector('.app') as HTMLElement | null)?.style.removeProperty('--bar-clear');
  watched = null;
}
