import type { Mesh } from '../../core/mesh';
import { world } from '../state';

// 镜头：地图铺满全屏，上面浮着顶栏，下面浮着两行的底部条。
// “看全图”“在地图上看”都把目标放在留出这些边之后的区域中间
export const MAP_INSETS = { top: 64, right: 24, bottom: 110, left: 24 };

// 最多放大到一格约 64 像素：再大就只剩插值的色块，细节不会更多
export const maxZoom = (mesh: Mesh) => 64 / mesh.spacing;

// 最多缩小到多少：一块地区照旧（100）；整个星球缩小到整颗星球放下后再小一点（屏幕上最多约三份）
export function minZoom(mesh: Mesh, cw: number, ch: number): number {
  if (mesh.kind !== 'sphere') return 100;
  const aw = Math.max(100, cw - MAP_INSETS.left - MAP_INSETS.right);
  const ah = Math.max(100, ch - MAP_INSETS.top - MAP_INSETS.bottom);
  return 0.75 * Math.min(aw / 2, ah) * 0.98;
}

// 整个星球：南北不越过两极（整颗星球比画面矮时在留边之后的区域里居中）。
// wrap：把 x 绕回 [0, 2)——只在没有手势进行时做，否则正在画的一笔会跳开
export function clampPlanetCamera(mesh: Mesh, cam: { x: number; y: number; zoom: number }, ch: number, wrap: boolean) {
  if (mesh.kind !== 'sphere') return;
  const avail = ch - MAP_INSETS.top - MAP_INSETS.bottom;
  if (cam.zoom <= avail) cam.y = 0.5 - (MAP_INSETS.top - MAP_INSETS.bottom) / 2 / cam.zoom;
  else {
    const lo = (ch / 2 - MAP_INSETS.top) / cam.zoom;
    const hi = 1 - (ch / 2 - MAP_INSETS.bottom) / cam.zoom;
    cam.y = Math.min(hi, Math.max(lo, cam.y));
  }
  if (wrap) cam.x -= 2 * Math.floor(cam.x / 2);
}

// MapView 挂上来的几个操作（键盘、面板按钮用）
export interface MapApi {
  fit(): void;
  zoomBy(f: number): void;
  // 取消正在画的一笔；返回 true 表示真的取消了什么
  cancel(): boolean;
  // 交给当前工具的 Esc、回车（比如画河时截不截走别的河）；工具用了返回 true
  escape(): boolean;
  enter(): boolean;
}
export const mapApi: { current: MapApi | null } = { current: null };

interface MapHook {
  renderer: { camera: { x: number; y: number; zoom: number } };
  requestDraw: () => void;
}

// 面板里“在地图上看”：把镜头移到这些格上（MapView 把渲染器挂在 window.__map2 上）
export function focusOn(cells: ArrayLike<number>) {
  const w = world.value;
  const hook = (window as unknown as { __map2?: MapHook }).__map2;
  if (!w || !hook || !cells.length) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  // 整个星球：经度取圆周平均，再在它附近展开，跨过经度 180° 的一片也是连在一起的
  let ref = 0;
  const sphere = w.mesh.kind === 'sphere';
  if (sphere) {
    let s = 0;
    let c0 = 0;
    for (let k = 0; k < cells.length; k++) {
      s += Math.sin(Math.PI * w.mesh.x[cells[k]]);
      c0 += Math.cos(Math.PI * w.mesh.x[cells[k]]);
    }
    ref = Math.atan2(s, c0) / Math.PI;
  }
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    const x = sphere ? ref + (w.mesh.x[c] - ref - 2 * Math.round((w.mesh.x[c] - ref) / 2)) : w.mesh.x[c];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, w.mesh.y[c]);
    y1 = Math.max(y1, w.mesh.y[c]);
  }
  const canvas = document.querySelector('.map-overlay') as HTMLCanvasElement | null;
  const cw = (canvas?.clientWidth ?? 800) - MAP_INSETS.left - MAP_INSETS.right;
  const ch = (canvas?.clientHeight ?? 600) - MAP_INSETS.top - MAP_INSETS.bottom;
  const span = Math.max(x1 - x0, (y1 - y0) * (cw / ch), w.mesh.spacing * 12);
  const cam = hook.renderer.camera;
  cam.zoom = Math.max(minZoom(w.mesh, canvas?.clientWidth ?? 800, canvas?.clientHeight ?? 600), Math.min(maxZoom(w.mesh), (cw / span) * 0.8));
  // 目标的中心放在留边之后的区域中间
  cam.x = (x0 + x1) / 2 - (MAP_INSETS.left - MAP_INSETS.right) / 2 / cam.zoom;
  cam.y = (y0 + y1) / 2 - (MAP_INSETS.top - MAP_INSETS.bottom) / 2 / cam.zoom;
  clampPlanetCamera(w.mesh, cam, canvas?.clientHeight ?? 600, true);
  hook.requestDraw();
}
