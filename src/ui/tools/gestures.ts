import type { Command } from '../../../core/commands';
import { roundKm } from '../../../core/terrain';
import type { World } from '../../../core/world';
import type { Shape } from '../../render/overlay';
import { world, worldPreviewError } from '../../state';
import { type Exact, slowTail } from '../exact';
import { type Pointer, mapDist } from './api';

// 几个工具共用的手势：圈一片、点一下或拖出大小、湖里的岛的确切预览，以及数一组格连成几片

// ---------- 圈一片（画陆地、选生态的范围、圈地名） ----------

// 按住画一个圈：每移动半格记一个点
export function lassoAdd(w: World, ring: [number, number][], p: Pointer) {
  const [lx, ly] = ring[ring.length - 1];
  if (Math.hypot(p.x - lx, p.y - ly) >= w.mesh.spacing * 0.5) ring.push([p.x, p.y]);
}

// 正在画的圈：一道实线；够三个点以后再画一道虚线把它合上
export function lassoShapes(ring: [number, number][]): Shape[] {
  const shapes: Shape[] = [{ kind: 'line', points: ring, color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }];
  if (ring.length >= 3) shapes.push({ kind: 'line', points: [ring[ring.length - 1], ring[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5, dashed: true });
  return shapes;
}

// 整个星球上圈绕着极点：画的时候说一声，松手时拦下
export const POLE_HINT = '圈绕着极点，松手无效';
export const POLE_TOAST = '圈不能绕着极点画';

// ---------- 点一下或拖出大小（放岛、放湖） ----------

// 岛、湖的大小取整成好读的直径：气泡、提示、历史里是同一个数
export const snapRadiusKm = (r: number) => roundKm(r * 2) / 2;

// 按下的地方；km：拖出的大小（半径），没拖开时为 null（用底部滑块的大小）
export interface SizeDrag {
  x: number;
  y: number;
  cell: number;
  sx: number;
  sy: number;
  km: number | null;
}

export const startDrag = (p: { x: number; y: number; cell: number; sx: number; sy: number }): SizeDrag => ({ x: p.x, y: p.y, cell: p.cell, sx: p.sx, sy: p.sy, km: null });

// 拖到 p：拖出 6 像素以上才算在拖大小，手抖不算；range 为 null 时不看大小（一格的岛）。
// 先取整再限制在范围里：取整后不会比最小值还小
export function dragTo(w: World, d: SizeDrag, p: Pointer, range: () => [number, number] | null) {
  const r = Math.hypot(p.sx - d.sx, p.sy - d.sy) <= 6 ? null : range();
  if (!r) {
    d.km = null;
    return;
  }
  const [lo, hi] = r;
  d.km = Math.min(hi, Math.max(lo, snapRadiusKm(mapDist(w, p.x, p.y, d.x, d.y) * w.kmPerUnit)));
}

// 拖大小时从按下的地方到鼠标的一道虚线
export const sizeLine = (d: SizeDrag | null, p: Pointer): Shape[] =>
  d?.km ? [{ kind: 'line', points: [[d.x, d.y], [p.x, p.y]], color: 'rgba(255,255,255,0.85)', width: 1.5, dashed: true }] : [];

// 刚松手、鼠标还停在原处（屏幕上 6 像素以内）：这一步还在算时不画下一次的悬停预览，只留排队中的那个；
// 在原处再按一下也不算（多点了一下，不在同一个地方叠一个）
export type Settled = { sx: number; sy: number } | null;
export const movedAway = (s: Settled, p: Pointer) => !s || Math.hypot(p.sx - s.sx, p.sy - s.sy) > 6;

// ---------- 湖里的岛（第十五轮：放岛、岛链） ----------
// 主线程马上画出岛占的湖面格，手停下时在 Worker 里确切地预览（就是松手后的样子：岛高出湖面、湖照旧），松手时直接采用

// 要这条命令的确切预览：Worker 说做不成的原因（why）；算好的将来的世界（还没算好时为 null）；还没算好时那句话的尾巴
export function lakeIsleExact(ex: Exact, w: World, cmd: Command): { why: string | null; world: World | null; tail: string } {
  const key = JSON.stringify(cmd);
  ex.want(key, () => (world.value === w ? cmd : null));
  const why = worldPreviewError(cmd);
  const v = ex.view;
  return { why, world: v?.key === key ? v.world : null, tail: slowTail(ex.slow, '…') };
}

// 松手：不再算新的，算好了的就是这条命令的将来的世界（没算好时为 null）
export function lakeIsleRelease(ex: Exact, cmd: Command): World | null {
  ex.stop();
  const v = ex.view;
  return v?.key === JSON.stringify(cmd) ? v.world : null;
}

// ---------- 数连通块 ----------

// 一组格连成几片：只在这组格里走（相邻的算一片）
export function groupCount(w: World, cells: number[]): number {
  const left = new Set(cells);
  let groups = 0;
  for (const c of cells) {
    if (!left.delete(c)) continue;
    groups++;
    const queue = [c];
    for (let h = 0; h < queue.length; h++) {
      for (let e = w.mesh.off[queue[h]]; e < w.mesh.off[queue[h] + 1]; e++) {
        const j = w.mesh.adj[e];
        if (left.delete(j)) queue.push(j);
      }
    }
  }
  return groups;
}
