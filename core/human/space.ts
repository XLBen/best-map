import { HeapLite, type Mesh } from '../mesh';
import { noise2, noise3 } from '../rng';
import type { World } from '../world';

// 人文生成共用的几样（第二十二轮）：格的面积与距离（km）、按地图上的位置取的噪声（与格数无关）、有竞争的扩散

// 一格的面积（km²）
export const cellKm2 = (world: World, i: number): number => world.mesh.area[i] * world.kmPerUnit * world.kmPerUnit;

// 两格之间的距离（km）：星球上是大圆弧，地区是直线
export function distKm(world: World, a: number, b: number): number {
  const m = world.mesh;
  if (m.kind === 'sphere') {
    const p = m.p;
    const dot = p[3 * a] * p[3 * b] + p[3 * a + 1] * p[3 * b + 1] + p[3 * a + 2] * p[3 * b + 2];
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * world.kmPerUnit) / Math.PI;
  }
  return Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]) * world.kmPerUnit;
}

// 第 i 格的噪声（约 −1 到 1）：两层，第一层的波长约 wavelengthKm。平面按 (x, y) km，星球按单位球面 × 半径
export function noiseAt(world: World, seed: number, wavelengthKm: number, i: number): number {
  const m = world.mesh;
  const f = 1 / wavelengthKm;
  const s1 = seed >>> 0;
  const s2 = (seed ^ 0x5bd1e995) >>> 0;
  if (m.kind === 'sphere') {
    const r = (world.kmPerUnit / Math.PI) * f;
    const x = m.p[3 * i] * r;
    const y = m.p[3 * i + 1] * r;
    const z = m.p[3 * i + 2] * r;
    return 0.7 * noise3(s1, x, y, z) + 0.3 * noise3(s2, x * 2 + 17.3, y * 2 - 9.1, z * 2 + 4.7);
  }
  const x = m.x[i] * world.kmPerUnit * f;
  const y = m.y[i] * world.kmPerUnit * f;
  return 0.7 * noise2(s1, x, y) + 0.3 * noise2(s2, x * 2 + 17.3, y * 2 - 9.1);
}

// 有竞争的扩散：几方从各自的起点同时往外长，每格归先到的那一方（不穿过别人已经占了的格）。
// 走一条边的代价 = edge[e] / (speed[方] × pref[方][j])；pref 省略为 1。allow 为 0 的格不进。
// 返回每格归哪一方（−1 到不了）与代价
export function compete(
  mesh: Mesh,
  seeds: readonly { cell: number; owner: number }[],
  edge: Float32Array,
  speed: Float64Array,
  pref: readonly (Float32Array | null)[] | null,
  allow: Uint8Array | null,
): { owner: Int32Array; dist: Float64Array } {
  const n = mesh.n;
  const dist = new Float64Array(n).fill(Infinity);
  const owner = new Int32Array(n).fill(-1);
  const heap = new HeapLite(n);
  for (const s of seeds) {
    if (dist[s.cell] === 0) continue;
    dist[s.cell] = 0;
    owner[s.cell] = s.owner;
    heap.push(s.cell, 0);
  }
  const { off, adj } = mesh;
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    const o = owner[i];
    const sp = speed[o];
    const pf = pref ? pref[o] : null;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (allow && !allow[j]) continue;
      const c = edge[e];
      if (!(c < Infinity)) continue;
      const nd = di + c / (sp * (pf ? pf[j] : 1));
      if (nd < dist[j]) {
        dist[j] = nd;
        owner[j] = o;
        heap.push(j, nd);
      }
    }
  }
  return { owner, dist };
}

// 按份额长：几方从各自的起点按代价往外长（代价同 compete），每格归先到的那一方；一方占的宜居的面积（mass）到了 budget 就停下，
// 剩下的地方让给别人。各方各记一份距离（一方停下后，别人还能从它旁边绕过去）。最后谁都没占到、但走得到的格归最近的已经占了的格
// （不看份额）。返回每格归哪一方（−1 走不到）
export function growByBudget(
  mesh: Mesh,
  seeds: readonly { cell: number; owner: number }[],
  k: number,
  edge: Float32Array,
  pref: readonly (Float32Array | null)[],
  allow: Uint8Array | null,
  mass: Float64Array,
  budget: Float64Array,
): Int32Array {
  const n = mesh.n;
  const owner = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n * k).fill(Infinity);
  const claimed = new Float64Array(k);
  const heap = new HeapLite(n);
  for (const s of seeds) {
    if (dist[s.owner * n + s.cell] === 0) continue;
    dist[s.owner * n + s.cell] = 0;
    heap.push(s.cell * k + s.owner, 0);
  }
  const { off, adj } = mesh;
  while (heap.size) {
    const item = heap.pop();
    const d = heap.lastKey;
    const o = item % k;
    const i = (item - o) / k;
    if (owner[i] >= 0 || d > dist[o * n + i] || claimed[o] >= budget[o]) continue;
    owner[i] = o;
    claimed[o] += mass[i];
    const pf = pref[o];
    const base = o * n;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (owner[j] >= 0 || (allow && !allow[j])) continue;
      const c = edge[e];
      if (!(c < Infinity)) continue;
      const nd = Math.fround(d + c / (pf ? pf[j] : 1));
      if (nd < dist[base + j]) {
        dist[base + j] = nd;
        heap.push(j * k + o, nd);
      }
    }
  }
  // 剩下的：从已经占了的格往外按代价长（不看份额）
  const rest: { cell: number; owner: number }[] = [];
  let left = false;
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) rest.push({ cell: i, owner: owner[i] });
    else if (!allow || allow[i]) left = true;
  }
  if (!left || !rest.length) return owner;
  const speed = new Float64Array(k).fill(1);
  const fill = compete(mesh, rest, edge, speed, pref, allow).owner;
  for (let i = 0; i < n; i++) if (owner[i] < 0) owner[i] = fill[i];
  return owner;
}

// 多个起点的广度优先：每格离它最近（按步数）的起点的值。起点按编号先后入队；到不了的为 fill
export function nearestBy(mesh: Mesh, isSource: (i: number) => boolean, value: (i: number) => number, fill = 0): Int32Array {
  const n = mesh.n;
  const out = new Int32Array(n).fill(fill);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!isSource(i)) continue;
    seen[i] = 1;
    out[i] = value(i);
    queue[tail++] = i;
  }
  const { off, adj } = mesh;
  while (head < tail) {
    const i = queue[head++];
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (seen[j]) continue;
      seen[j] = 1;
      out[j] = out[i];
      queue[tail++] = j;
    }
  }
  return out;
}
