import { fromUnit, toUnit } from '../../core/geo';
import type { Mesh } from '../../core/mesh';
import { type Proj, type ProjCamera, centerScale, forward, planeBounds } from '../render/projection';
import { world } from '../state';

// 镜头：地图铺满全屏，上面浮着顶栏，下面浮着两行的底部条。
// “看全图”“在地图上看”都把目标放在留出这些边之后的区域中间
export const MAP_INSETS = { top: 64, right: 24, bottom: 110, left: 24 };

// 最多放大到一格约 64 像素：再大就只剩插值的色块，细节不会更多（投影时按投影正中的比例算）
export const maxZoom = (mesh: Mesh, proj?: Proj) => 64 / mesh.spacing / (proj && mesh.kind === 'sphere' ? centerScale(proj) : 1);

// 最多缩小到多少：一块地区照旧（100）；整个星球缩小到整颗星球放下后再小一点（屏幕上最多约三份）；
// 等面积、球形投影缩小到整个形状放下后再小一点
export function minZoom(mesh: Mesh, cw: number, ch: number, proj?: Proj): number {
  if (mesh.kind !== 'sphere') return 100;
  const aw = Math.max(100, cw - MAP_INSETS.left - MAP_INSETS.right);
  const ah = Math.max(100, ch - MAP_INSETS.top - MAP_INSETS.bottom);
  if (proj) {
    const [u0, u1, v0, v1] = planeBounds(proj);
    return 0.75 * Math.min(aw / (u1 - u0), ah / (v1 - v0)) * 0.98;
  }
  return 0.75 * Math.min(aw / 2, ah) * 0.98;
}

// 等面积：整个椭圆东西放得下（这时左右拖动是转动中央经线，见 map/input.ts）
export function shapeFitsWidth(cam: ProjCamera, cw: number): boolean {
  if (!cam.proj) return false;
  const [u0, u1] = planeBounds(cam.proj);
  return (u1 - u0) * cam.zoom <= cw - MAP_INSETS.left - MAP_INSETS.right;
}

// 整个星球：南北不越过两极（整颗星球比画面矮时在留边之后的区域里居中）。
// wrap：把 x 绕回 [0, 2)——只在没有手势进行时做，否则正在画的一笔会跳开。
// 投影（cw 是画布宽）：球形的镜头总在留边之后的区域中间（转动代替平移）；等面积东西也不越过椭圆的边、不绕回
export function clampPlanetCamera(mesh: Mesh, cam: ProjCamera, ch: number, wrap: boolean, cw = 0) {
  if (mesh.kind !== 'sphere') return;
  const p = cam.proj;
  if (p?.kind === 'globe') {
    cam.x = 1 - (MAP_INSETS.left - MAP_INSETS.right) / 2 / cam.zoom;
    cam.y = 0.5 - (MAP_INSETS.top - MAP_INSETS.bottom) / 2 / cam.zoom;
    return;
  }
  const avail = ch - MAP_INSETS.top - MAP_INSETS.bottom;
  if (cam.zoom <= avail) cam.y = 0.5 - (MAP_INSETS.top - MAP_INSETS.bottom) / 2 / cam.zoom;
  else {
    const lo = (ch / 2 - MAP_INSETS.top) / cam.zoom;
    const hi = 1 - (ch / 2 - MAP_INSETS.bottom) / cam.zoom;
    cam.y = Math.min(hi, Math.max(lo, cam.y));
  }
  if (p) {
    if (cw <= 0) return;
    const [u0, u1] = planeBounds(p);
    if (shapeFitsWidth(cam, cw)) cam.x = (u0 + u1) / 2 - (MAP_INSETS.left - MAP_INSETS.right) / 2 / cam.zoom;
    else {
      const lo = u0 + (cw / 2 - MAP_INSETS.left) / cam.zoom;
      const hi = u1 - (cw / 2 - MAP_INSETS.right) / cam.zoom;
      cam.x = Math.min(hi, Math.max(lo, cam.x));
    }
    return;
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
  renderer: { camera: ProjCamera };
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
  const CW = canvas?.clientWidth ?? 800;
  const CH = canvas?.clientHeight ?? 600;
  const cw = CW - MAP_INSETS.left - MAP_INSETS.right;
  const ch = CH - MAP_INSETS.top - MAP_INSETS.bottom;
  const cam = hook.renderer.camera;
  const proj = sphere ? cam.proj : undefined;
  if (proj) {
    // 投影：球形先转到这些格的中心；再按投影平面上的范围放大（等面积的中央经线不变）
    let p = proj;
    if (p.kind === 'globe') {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = 0; k < cells.length; k++) {
        const v = toUnit(w.mesh.x[cells[k]], w.mesh.y[cells[k]]);
        sx += v[0];
        sy += v[1];
        sz += v[2];
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-9) {
        const [cx, cy] = fromUnit([sx / l, sy / l, sz / l]);
        p = { kind: 'globe', lon0: Math.PI * (cx - 1), lat0: Math.PI * (0.5 - cy) };
      }
    }
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < cells.length; k++) {
      const q = forward(p, w.mesh.x[cells[k]], w.mesh.y[cells[k]]);
      if (!q) continue;
      u0 = Math.min(u0, q[0]);
      u1 = Math.max(u1, q[0]);
      v0 = Math.min(v0, q[1]);
      v1 = Math.max(v1, q[1]);
    }
    if (!Number.isFinite(u0)) return;
    const span = Math.max(u1 - u0, (v1 - v0) * (cw / ch), w.mesh.spacing * 12 * centerScale(p));
    cam.proj = p;
    cam.zoom = Math.max(minZoom(w.mesh, CW, CH, p), Math.min(maxZoom(w.mesh, p), (cw / span) * 0.8));
    cam.x = (u0 + u1) / 2 - (MAP_INSETS.left - MAP_INSETS.right) / 2 / cam.zoom;
    cam.y = (v0 + v1) / 2 - (MAP_INSETS.top - MAP_INSETS.bottom) / 2 / cam.zoom;
    clampPlanetCamera(w.mesh, cam, CH, true, CW);
    hook.requestDraw();
    return;
  }
  const span = Math.max(x1 - x0, (y1 - y0) * (cw / ch), w.mesh.spacing * 12);
  cam.zoom = Math.max(minZoom(w.mesh, CW, CH), Math.min(maxZoom(w.mesh), (cw / span) * 0.8));
  // 目标的中心放在留边之后的区域中间
  cam.x = (x0 + x1) / 2 - (MAP_INSETS.left - MAP_INSETS.right) / 2 / cam.zoom;
  cam.y = (y0 + y1) / 2 - (MAP_INSETS.top - MAP_INSETS.bottom) / 2 / cam.zoom;
  clampPlanetCamera(w.mesh, cam, CH, true);
  hook.requestDraw();
}
