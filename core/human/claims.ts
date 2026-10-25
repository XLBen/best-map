import { HeapLite } from '../mesh';
import type { GenContext, HumanStage } from './context';
import { countryPopScale } from './countries';
import { ISLET_STEPS } from './country-layers';

// 领土补齐（第二十六轮）：国家一步之后、人口之前（generate.ts 里排在 countries 后面）。
// 只在重新长国家时运行（ctx.countries.mode === 'generate'），只把无主的陆地写进 causes.country；锁定的国家当作一个邻国算，但不往里加。
// 按顺序做三件事：
//   1. 无主的陆地连成的一块（湖不算）：四周的陆地邻格都属于同一国时整块归它（海岸不算缺口；但大块的国界不到海岸的 ENCLOSED_COAST 倍时
//      ——半岛的尖、地峡那一边——不算被围住）；挨着两国以上的不填；
//   2. 不超过 SMALL_GAP 格、挨着国家的无主小块：归共享边界最长的邻国；四周是海的这么小的岛归 ISLET_STEPS 格海路以内最近的国家；
//   3. 贴着国境的一圈：从各国往外在陆地上走，时代的 unclaimed.bandKm 以内的无主格归最近的国家（山、荒漠、冰川也要：国与国之间的山脊归两边）；
//      远处（极地的冰盖、大漠的深处）仍然无主。
// 最后没有主的湖归湖岸上最多的那一国，再重算首都一带的人口倍数（ctx.popScale）。
// 之后手画的无主地不会被补上：这一步只在生成时有（不在命令之后的整理里）

export const SMALL_GAP = 8;
// 只挨着一国的无主块：与这一国共享的边数至少是海岸边数的几倍才整块归它
export const ENCLOSED_COAST = 0.5;

function claimLand(ctx: GenContext) {
  const plan = ctx.countries;
  if (!plan || plan.mode !== 'generate') return;
  const { world, d, era } = ctx;
  const { mesh, causes, small } = world;
  const country = causes.country;
  const metas = small.countries;
  if (!country || !metas || !Object.keys(metas).length) return;
  const n = mesh.n;
  const { off, adj } = mesh;
  const land = causes.land;
  const lake = d.lake;
  const locked = new Set(Object.values(metas).filter((m) => m.locked).map((m) => m.id));
  const free = (i: number) => land[i] === 1 && lake[i] !== 1 && country[i] < 0;
  let changed = false;

  // ---- 1、2：无主的块 ----
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !free(s)) continue;
    const cells: number[] = [];
    // 邻国 → 共享的边数；挨着海的边数
    const border = new Map<number, number>();
    let coast = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!land[j]) {
          coast++;
          continue;
        }
        if (free(j)) {
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        } else if (country[j] >= 0) border.set(country[j], (border.get(country[j]) ?? 0) + 1);
      }
    }
    let to = -1;
    if (!border.size) {
      // 四周是海的小岛：ISLET_STEPS 格海路以内最近的国家（同碎岛）
      if (cells.length <= SMALL_GAP) to = nearestOverSea(world, cells, locked);
    } else if (border.size === 1) {
      // 只挨着一国：国界比海岸短得多的一大块（半岛的尖、隔着一道窄的地峡的地方）不算被围住，留给贴着国境的一圈
      const [id, v] = border.entries().next().value!;
      if (cells.length <= SMALL_GAP || v >= ENCLOSED_COAST * coast) to = id;
    } else if (cells.length <= SMALL_GAP) {
      let bc = 0;
      for (const [id, v] of border) if (!locked.has(id) && (v > bc || (v === bc && id < to))) {
        bc = v;
        to = id;
      }
    }
    if (to < 0 || locked.has(to)) continue;
    for (const i of cells) country[i] = to;
    changed = true;
  }

  // ---- 3：贴着国境的一圈 ----
  const band = era.unclaimed.bandKm ?? 0;
  if (band > 0) {
    const km = world.kmPerUnit;
    const dist = new Float64Array(n).fill(Infinity);
    const own = new Int32Array(n).fill(-1);
    const heap = new HeapLite(1024);
    for (let i = 0; i < n; i++) {
      const c = country[i];
      if (!land[i] || c < 0 || locked.has(c)) continue;
      let edge = false;
      for (let e = off[i]; e < off[i + 1] && !edge; e++) if (free(adj[e])) edge = true;
      if (!edge) continue;
      dist[i] = 0;
      own[i] = c;
      heap.push(i, 0);
    }
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > dist[i]) continue;
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!free(j)) continue;
        const nd = di + mesh.dist[e] * km;
        if (nd > band || nd >= dist[j]) continue;
        dist[j] = nd;
        own[j] = own[i];
        heap.push(j, nd);
      }
    }
    for (let i = 0; i < n; i++) {
      if (own[i] < 0 || country[i] >= 0) continue;
      country[i] = own[i];
      changed = true;
    }
  }

  // ---- 没有主的湖：归湖岸上最多的那一国（锁定的不要） ----
  seen.fill(0);
  for (let s = 0; s < n; s++) {
    if (seen[s] || !land[s] || lake[s] !== 1) continue;
    const comp: number[] = [];
    const shore = new Map<number, number>();
    let owned = false;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      if (country[i] >= 0) owned = true;
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (lake[j] === 1) {
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        } else if (country[j] >= 0 && !locked.has(country[j])) shore.set(country[j], (shore.get(country[j]) ?? 0) + 1);
      }
    }
    if (owned || !shore.size) continue;
    let best = -1;
    let bc = 0;
    for (const [id, v] of shore) if (v > bc || (v === bc && id < best)) {
      bc = v;
      best = id;
    }
    for (const i of comp) country[i] = best;
    changed = true;
  }

  if (changed) ctx.popScale = countryPopScale(ctx);
}

// 从这几格（一个小岛）往外在海里按步数走，最先碰到的有主的陆地（锁定的不算；同一步碰到几国时编号小的）；走不到为 −1
function nearestOverSea(world: GenContext['world'], cells: readonly number[], locked: Set<number>): number {
  const { mesh, causes } = world;
  const country = causes.country!;
  const seen = new Set<number>(cells);
  let frontier = [...cells];
  for (let step = 0; step <= ISLET_STEPS && frontier.length; step++) {
    const next: number[] = [];
    let best = -1;
    for (const i of frontier) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (seen.has(j)) continue;
        seen.add(j);
        if (causes.land[j]) {
          const c = country[j];
          if (c >= 0 && !locked.has(c) && (best < 0 || c < best)) best = c;
        } else next.push(j);
      }
    }
    if (best >= 0) return best;
    frontier = next;
  }
  return -1;
}

export const claimsStage: HumanStage = { id: 'claims', run: claimLand };
