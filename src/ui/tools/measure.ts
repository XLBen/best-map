import { densify, unwrapNear } from '../../../core/geo';
import { roundKm as km } from '../../../core/terrain';
import type { World } from '../../../core/world';
import type { Shape } from '../../render/overlay';
import { measure, world } from '../../state';
import { EMPTY, type Pointer, type ToolHandler, mapDist } from './api';

// 量距离（左下角的尺子打开时，地图上的点击交给它）

// 一串点的总长（km）
export function pathKm(w: World, pts: [number, number][]): number {
  let sum = 0;
  // 整个星球：每段量球面上最短的弧
  for (let k = 1; k < pts.length; k++) sum += mapDist(w, pts[k][0], pts[k][1], pts[k - 1][0], pts[k - 1][1]);
  return sum * w.kmPerUnit;
}

// 量距离：点一下加一个点；鼠标到最后一点之间跟着一条虚线，旁边写着加上这一段一共多长。
// 左键拖动照样平移地图
export function measureTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
    },
    click(p) {
      const prev = measure.value?.[measure.value.length - 1];
      const w = world.value;
      // 整个星球：新的点展开到离上一点最近的那一份，量出来的线是连着的；南北不超出两极
      const sphere = w?.mesh.kind === 'sphere';
      const x = prev && sphere ? unwrapNear(p.x, prev[0]) : p.x;
      measure.value = [...(measure.value ?? []), [x, sphere ? Math.min(1, Math.max(0, p.y)) : p.y]];
    },
    preview() {
      const w = world.value;
      const pts = measure.value ?? [];
      if (!w) return EMPTY;
      const shapes: Shape[] = [];
      const dot = 3.5 / zoom();
      // 整个星球：画成球面上最短的弧
      const arcLine = (line: [number, number][]) => (w.mesh.kind === 'sphere' ? densify(line, w.mesh.spacing * 2) : line);
      if (pts.length > 1) shapes.push({ kind: 'line', points: arcLine(pts), color: 'rgba(255, 255, 255, 0.95)', width: 2 });
      if (pointer && pts.length) {
        const last = pts[pts.length - 1];
        const to: [number, number] = [w.mesh.kind === 'sphere' ? unwrapNear(pointer.x, last[0]) : pointer.x, pointer.y];
        shapes.push({ kind: 'line', points: arcLine([last, to]), color: 'rgba(255, 255, 255, 0.8)', width: 1.5, dashed: true });
      }
      for (const [x, y] of pts) shapes.push({ kind: 'circle', x, y, r: dot, color: 'rgba(255, 255, 255, 0.95)', width: 2 });
      if (!pointer) return { layers: [], shapes, hint: null };
      if (!pts.length) return { layers: [], shapes, hint: null };
      const total = pathKm(w, [...pts, [pointer.x, pointer.y]]);
      return { layers: [], shapes, hint: `${km(total).toLocaleString()} km` };
    },
  };
}
