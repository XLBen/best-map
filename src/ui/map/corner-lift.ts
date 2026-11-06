import { effect } from '@preact/signals';
import { sheet } from '../../state';
import { libWide } from '../packs/panel-store';
import { bottomBarRef } from '../shell/bottom-bar';

// 底部条伸到左下角时比例尺、尺子按钮要抬多高（第七十轮从 MapView.tsx 分出来）。每个地图视图一份；requestDraw：作废后重画
export function cornerLifter(requestDraw: () => void): { lift: () => number; dispose: () => void } {
  // 底部条要把左下角的比例尺抬多高：量一次缓存着，底部条或窗口变了大小时作废（不在每帧查 DOM、量位置）。
  // 没有底部条时每半秒才再找一次
  let liftCache: number | null = null;
  let liftBar: Element | null = null;
  let liftAt = 0;
  const barObs = new ResizeObserver(() => {
    liftCache = null;
    requestDraw();
  });
  const onWinResize = () => (liftCache = null);
  window.addEventListener('resize', onWinResize);
  // 生态的表打开、关上时底部条挪了位置（.app.with-sheet）却不变大小：ResizeObserver 不报，这里作废。
  // 资源库面板变宽、收回时也一样（.app.lib-wide，第六十七轮）
  const disposeSheet = effect(() => {
    void sheet.value;
    void libWide.value;
    liftCache = null;
    requestDraw();
  });
  function barLift(): number {
    if (liftCache !== null && (liftBar ? liftBar.isConnected : performance.now() - liftAt < 500)) return liftCache;
    // 底部条自己挂上来（shell/bottom-bar.ts）；已经不在页面上的不算
    const el = bottomBarRef.current;
    const bar = el?.isConnected ? el : null;
    if (bar !== liftBar) {
      if (liftBar) barObs.unobserve(liftBar);
      if (bar) barObs.observe(bar);
      liftBar = bar;
    }
    const r = bar?.getBoundingClientRect();
    liftCache = r && r.left < 300 ? Math.ceil(window.innerHeight - r.top) + 4 : 0;
    liftAt = performance.now();
    return liftCache;
  }
  return {
    lift: barLift,
    dispose: () => {
      barObs.disconnect();
      disposeSheet();
      window.removeEventListener('resize', onWinResize);
    },
  };
}
