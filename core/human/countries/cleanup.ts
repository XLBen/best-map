import { HeapLite } from '../../mesh';
import { cellKm2 } from '../space';
import { FILL_ALL_HAB } from './base';
import type { CountryRun } from './state';

// 长完以后的整理（第二十三轮、第二十六轮）。第七十三轮从 countries.ts 搬来（原样），隔海的那一条多看一眼 Seed.overseas（殖民地，第七十四轮用）：
//   1. 不在起点的陆块上、能住人的分量不到本国 ISLAND_SHARE 的地方（超过 ISLAND_CELLS 格）放掉；
//   2. 要“住满”的时代：没长到的陆地归最近的国家；
//   3. 海不归国家，锁定的国家的格还原；
//   4. 湖归湖岸上最多的那一国；
//   5. 不连着首都、挨着别国的小块并给邻国

// 不在起点的陆块上的一块：超过几格、能住人的分量不到本国几成时不要（第二十六轮）
const ISLAND_CELLS = 8;
const ISLAND_SHARE = 0.05;

export function cleanupOwners(g: CountryRun) {
  const { ctx, world, seeds, owner, dist, edge, thr, home, country, minH } = g;
  const { x, hab, d } = ctx;
  const { mesh, causes } = world;
  const n = g.n;
  const k = seeds.length;
  const comps = g.compOf;
  const { off, adj } = mesh;
  const land = causes.land;
  const lake = d.lake;
  // 不在起点的陆块上、能住人的分量不到本国 ISLAND_SHARE 的地方（超过 ISLAND_CELLS 格）不要：成无主地（近海的小岛由领土补齐补上）
  {
    const massO = new Float64Array(k);
    const pieces = new Map<number, { cells: number[]; mass: number }>();
    for (let i = 0; i < n; i++) {
      const o = owner[i];
      if (o < 0 || !land[i]) continue;
      const m = x.dry[i] ? cellKm2(world, i) * hab[i] : 0;
      massO[o] += m;
      if (comps[i] === home[o]) continue;
      const key = comps[i] * k + o;
      let p = pieces.get(key);
      if (!p) pieces.set(key, (p = { cells: [], mass: 0 }));
      p.cells.push(i);
      p.mass += m;
    }
    for (const [key, p] of pieces) {
      const o = key % k;
      if (p.cells.length > ISLAND_CELLS && p.mass < ISLAND_SHARE * massO[o] && !seeds[o].overseas) for (const i of p.cells) owner[i] = -1;
    }
  }
  // 时代要“住满”（宜居度下限很低，如现代）：上面没长到的陆地归最近的国家（陆地、海都走，不限远近与宜居度）
  if (minH <= FILL_ALL_HAB) {
    const fill = new HeapLite(n);
    for (let i = 0; i < n; i++) if (owner[i] >= 0) fill.push(i, dist[i]);
    while (fill.size) {
      const i = fill.pop();
      const di = fill.lastKey;
      if (di > dist[i]) continue;
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (owner[j] !== -1) continue;
        const nd = di + edge[e];
        dist[j] = nd;
        owner[j] = owner[i];
        fill.push(j, nd);
      }
    }
  }
  // 海不归国家；锁定的国家的格还原
  for (let i = 0; i < n; i++) if (!land[i] || owner[i] === -2) owner[i] = -1;

  // ---- 湖：归湖岸上最多的那一国 ----
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !land[s] || lake[s] !== 1) continue;
    const comp: number[] = [];
    const shore = new Map<number, number>();
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (lake[j] === 1) {
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        } else if (owner[j] >= 0) shore.set(owner[j], (shore.get(owner[j]) ?? 0) + 1);
      }
    }
    let best = -1;
    let bc = 0;
    for (const [key, v] of shore) if (v > bc || (v === bc && key < best)) {
      bc = v;
      best = key;
    }
    for (const i of comp) {
      if (country[i] >= 0) continue;
      owner[i] = best >= 0 ? best : -1;
    }
  }

  // ---- 不连着首都、挨着别国的小块并给邻国 ----
  const sizeOf = new Int32Array(k);
  for (let i = 0; i < n; i++) if (owner[i] >= 0) sizeOf[owner[i]]++;
  const comp = new Int32Array(n).fill(-1);
  let cid = 0;
  for (let s = 0; s < n; s++) {
    const o = owner[s];
    if (o < 0 || comp[s] >= 0) continue;
    const cells: number[] = [];
    let hasSeed = false;
    const border = new Map<number, number>();
    comp[s] = cid;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      if (i === seeds[o].cell) hasSeed = true;
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (owner[j] === o) {
          if (comp[j] < 0) {
            comp[j] = cid;
            stack.push(j);
          }
        } else if (owner[j] >= 0) border.set(owner[j], (border.get(owner[j]) ?? 0) + 1);
      }
    }
    cid++;
    if (hasSeed || cells.length >= Math.max(3, 0.2 * sizeOf[o]) || !border.size) continue;
    let best = -1;
    let bc = 0;
    for (const [q, v] of border) if (v > bc || (v === bc && q < best)) {
      bc = v;
      best = q;
    }
    // 邻国按自己的宜居度下限占不了的格成无主地（要“住满”的时代除外）
    for (const i of cells) owner[i] = !x.dry[i] || hab[i] >= thr[best] || minH <= FILL_ALL_HAB ? best : -1;
    sizeOf[o] -= cells.length;
    sizeOf[best] += cells.length;
  }
}
