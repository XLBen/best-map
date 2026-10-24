import type { Mesh } from '../mesh';
import type { TerrainClass } from './terrain-class';

// 山峰（第二十一轮）：陆地上比相邻的格都高（一样高时编号小的算）、海拔不低于 PEAK_MIN、地形类别写了“算山峰”（山地、山峰）的格。
// 地图上可以全部画出来；档案里写“xx峰 · 高度”（山脉的主峰用地物的名字，别的按这一格起名）

export const PEAK_MIN = 1000;

export function findPeaks(mesh: Mesh, elevation: ArrayLike<number>, dry: Uint8Array, cls: Uint8Array, list: readonly TerrainClass[]): Uint8Array {
  const n = mesh.n;
  const out = new Uint8Array(n);
  const ok = new Uint8Array(list.length + 1);
  list.forEach((c, k) => (ok[k + 1] = c.peaks ? 1 : 0));
  if (!ok.some((v) => v)) return out;
  for (let i = 0; i < n; i++) {
    if (!dry[i] || !ok[cls[i]]) continue;
    const h = elevation[i];
    if (h < PEAK_MIN) continue;
    let top = true;
    for (let e = mesh.off[i]; e < mesh.off[i + 1] && top; e++) {
      const j = mesh.adj[e];
      const g = elevation[j];
      if (g > h || (g === h && j < i)) top = false;
    }
    if (top) out[i] = 1;
  }
  return out;
}

// 全部山峰的格，按海拔从高到低（同一份数组只算一次）
const lists = new WeakMap<Uint8Array, Int32Array>();
export function peakList(peak: Uint8Array, elevation: ArrayLike<number>): Int32Array {
  let l = lists.get(peak);
  if (!l) {
    const cells: number[] = [];
    for (let i = 0; i < peak.length; i++) if (peak[i]) cells.push(i);
    cells.sort((a, b) => elevation[b] - elevation[a] || a - b);
    lists.set(peak, (l = Int32Array.from(cells)));
  }
  return l;
}
