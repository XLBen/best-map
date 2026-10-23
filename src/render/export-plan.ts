import type { Camera } from './renderer';

// 导出整张地图（.png）的算式：虚拟镜头、分块、每一块的视图。不碰 WebGL，测试里直接算。
//
// 整张图按“在一个 refWidth 个 CSS 像素宽的窗口里看全图”的样子画，再按 dpr = 图宽 / refWidth 放大：
// 地名的字号、河宽、线宽、晕渲的夸张程度、哪些地名标出来，都与在那样的窗口里看全图时一样，只是更清楚。
// 字号（小 / 中 / 大）换的是 refWidth：窗口越窄，字相对整张图越大、标出来的地名越少

export type LabelSize = 'small' | 'medium' | 'large';
export const LABEL_REF_WIDTH: Record<LabelSize, number> = { small: 2400, medium: 1600, large: 1100 };

// 整张图（像素）与虚拟镜头。cw × ch 是虚拟窗口的 CSS 像素，dpr 是每个 CSS 像素几个图上的像素
export interface ExportFrame {
  width: number;
  height: number;
  dpr: number;
  cw: number;
  ch: number;
  cam: Camera;
}

// 地图的范围（地图单位，左上角在原点）：一块地区是 aspect × 1，整个星球是 2 × 1（经度 360°，一份，不重复）
export function exportFrame(map: { width: number; height: number }, width: number, labels: LabelSize): ExportFrame {
  const W = Math.max(2, Math.round(width));
  const H = Math.max(2, Math.round((W * map.height) / map.width));
  // 图比参考窗口还窄时不缩小字（按 1:1 画）
  const ref = Math.min(LABEL_REF_WIDTH[labels], W);
  const dpr = W / ref;
  const zoom = ref / map.width;
  const cw = W / dpr;
  const ch = H / dpr;
  // 左上角正好是地图的左上角（高按整像素取了整，底边最多差半个像素）
  return { width: W, height: H, dpr, cw, ch, cam: { x: map.width / 2, y: ch / 2 / zoom, zoom } };
}

// 一块：图上的位置与大小（像素，从左上角起）。每一块的场景都是同样大的 T × T（加四周的边），
// 伸出图外的部分画了也不要：每一块的像素在 2 × 2 的组里与一次画完整张时对得齐（海岸线的抗锯齿用屏幕导数）
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function planTiles(W: number, H: number, T: number): Tile[] {
  const out: Tile[] = [];
  for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) out.push({ x, y, w: Math.min(T, W - x), h: Math.min(T, H - y) });
  return out;
}

// 每一块四周多画的边（像素，偶数）：合成时按扭曲后的位置取格（最多偏 0.525 格）、看相邻像素（1.5 像素），
// 地形层的屏幕导数看相邻的一个像素。cellPx：一格合图上几个像素
export function tileMargin(cellPx: number): number {
  const m = Math.ceil(0.55 * cellPx) + 4;
  return m + (m % 2);
}

// 块的大小（偶数）：场景（T + 2m）不超过显卡的纹理、渲染缓冲、视口的上限，也不超过 pref
export function tileSize(limit: number, margin: number, pref = 1024): number {
  const t = Math.min(pref, limit - 2 * margin);
  return Math.max(2, t - (t % 2));
}

type V4 = [number, number, number, number];

// 一块的视图：scene 是场景（S × S，S = T + 2m）的“地图单位 → 裁剪空间”，out 是合成画面（T × T）的，
// xf 是合成画面上的位置（0–1）→ 场景上的位置；cx 是这一块的中心（地图单位），halfW 是场景的半宽（地图单位）
export function tileView(f: ExportFrame, x0: number, y0: number, T: number, m: number): { scene: V4; out: V4; xf: V4; cx: number; halfW: number; S: number } {
  const Z = f.cam.zoom * f.dpr;
  const S = T + 2 * m;
  const cx = f.cam.x + (x0 + T / 2 - f.width / 2) / Z;
  const cy = f.cam.y + (y0 + T / 2 - f.height / 2) / Z;
  const view = (n: number): V4 => {
    const sx = (2 * Z) / n;
    const sy = (-2 * Z) / n;
    return [sx, sy, -cx * sx, -cy * sy];
  };
  return { scene: view(S), out: view(T), xf: [T / S, T / S, m / S, m / S], cx, halfW: S / 2 / Z, S };
}
