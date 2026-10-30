// 和地球比（第三十一、三十二轮）：tools/realism-report.ts 与慢测试 tools/realism.test.ts 共用的部分。
// 新建一个世界（与向导新建相同：先加基础、自然、中文地名，“几块大陆”），算 core/stats.ts 的统计，再加上要看生成器的两项：
// 裂谷湖的长宽比、分水岭不对称
import { Engine } from '../core/engine';
import { plainStats } from '../core/plains';
import { traceRivers } from '../core/rivers';
import { newWorldContentCommands } from '../core/packs/import';
import { type RealismStats, components, drainage, elongation, median, realismStats, statsInput } from '../core/stats';
import { ensureBase } from '../core/terrain';
import type { Settings, World } from '../core/world';

// 新建时做了几个冲积扇（第三十三轮，plains.ts 的计数：新建的世界每块陆地都求解一遍）
const fansOf = new WeakMap<World, number>();
export function realismWorld(settings: Partial<Settings>, seed: number): World {
  const eng = new Engine({ ...settings, seed });
  const before = plainStats.fans;
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed, type: 'continents' }, reset: true }] });
  fansOf.set(eng.world, plainStats.fans - before);
  return eng.world;
}

export type RealismRow = RealismStats & { riftLakes: number; riftRatio: number; divideShare: number; divideCoast: number; deltaShare: number; deltaRivers: number; fans: number; wetland: number };

export const REALISM_ROW_REF: Record<'riftLakes' | 'riftRatio' | 'divideShare' | 'divideCoast' | 'deltaShare' | 'deltaRivers' | 'fans' | 'wetland', string> = {
  riftLakes: '—',
  riftRatio: '> 4（坦噶尼喀 13）',
  divideShare: '≥ 65%（南美约 85%）',
  divideCoast: '—',
  deltaShare: '30–80%（计划）',
  deltaRivers: '—',
  fans: '—',
  wetland: '≈6%',
};

export function realismRow(world: World, coastDim = NaN): RealismRow {
  const rl = riftLakes(world);
  const dv = divideAsymmetry(world);
  const dl = deltaShare(world);
  return { ...realismStats(statsInput(world), coastDim), riftLakes: rl.count, riftRatio: rl.ratio, divideShare: dv.share, divideCoast: dv.coast, deltaShare: dl.share, deltaRivers: dl.rivers, fans: fansOf.get(world) ?? NaN, wetland: wetlandShare(world) };
}

// 分汊（第三十三轮）：入海的大河（河口那一格的汇水面积 > 20 万 km²，按水文的流向）里，画出来有分出去的几股的占多少。
// 返回比例与这样的大河的条数
export function deltaShare(world: World, minKm = 2e5): { share: number; rivers: number } {
  const { mesh, causes, derived: d } = world;
  const big = new Set<number>();
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || d.lake[i] === 1 || d.drainArea[i] <= minKm) continue;
    const r = d.receiver[i];
    if (r >= 0 && !causes.land[r]) big.add(i);
  }
  if (!big.size) return { share: NaN, rivers: 0 };
  const lines = traceRivers(world);
  const branched = new Set<number>();
  for (const l of lines) {
    if (l.branch === undefined) continue;
    const M = lines[l.branch];
    const c = M.cells?.[M.cells.length - 1];
    if (c !== undefined && big.has(c)) branched.add(c);
  }
  return { share: branched.size / big.size, rivers: big.size };
}

// 沼泽湿地（生态 wetland）占陆地的比例（第三十三轮：低湿的三角洲平原、河漫滩按已有的规则长成湿地）
export function wetlandShare(world: World): number {
  const { mesh, causes, derived: d, small } = world;
  const k = small.species.findIndex((sp) => sp.id === 'wetland');
  let land = 0;
  let wet = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    land++;
    if (k >= 0 && d.dominant[i] === k) wet++;
  }
  return land ? wet / land : 0;
}

// 裂谷湖（第三十二轮）：湖面（lake = 1）连成的块里，一半以上的格在生成器的裂谷洼地上（rift > 30 m）、至少 5 格的
// （三四格的湖在格子上量不出形状：三格最多是 3）。
// 长宽比按面积加权的主轴（elongation）；星球上投到湖心的切平面。返回个数与长宽比的中位数
const RIFT_LAKE_CELLS = 5;
export function riftLakes(world: World): { count: number; ratio: number } {
  const { mesh, derived: d, causes, kmPerUnit } = world;
  const rift = ensureBase(world).components?.rift;
  if (!rift) return { count: 0, ratio: NaN };
  const s = { n: mesh.n, off: mesh.off, adj: mesh.adj };
  const ratios: number[] = [];
  for (const lake of components(s, (i) => causes.land[i] === 1 && d.lake[i] === 1)) {
    if (lake.length < RIFT_LAKE_CELLS || lake.filter((c) => rift[c] > 30).length * 2 < lake.length) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    const as: number[] = [];
    if (mesh.kind === 'sphere') {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const c of lake) {
        cx += mesh.p[3 * c];
        cy += mesh.p[3 * c + 1];
        cz += mesh.p[3 * c + 2];
      }
      const L = Math.hypot(cx, cy, cz);
      const [nx, ny, nz] = [cx / L, cy / L, cz / L];
      // 切平面的两个方向
      const ex = Math.abs(nz) < 0.9 ? [-ny, nx, 0] : [0, -nz, ny];
      const el = Math.hypot(ex[0], ex[1], ex[2]);
      const e1 = [ex[0] / el, ex[1] / el, ex[2] / el];
      const e2 = [ny * e1[2] - nz * e1[1], nz * e1[0] - nx * e1[2], nx * e1[1] - ny * e1[0]];
      const R = kmPerUnit / Math.PI;
      for (const c of lake) {
        const p = [mesh.p[3 * c], mesh.p[3 * c + 1], mesh.p[3 * c + 2]];
        xs.push(R * (p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2]));
        ys.push(R * (p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]));
        as.push(mesh.area[c] * kmPerUnit * kmPerUnit);
      }
    } else {
      for (const c of lake) {
        xs.push(mesh.x[c] * kmPerUnit);
        ys.push(mesh.y[c] * kmPerUnit);
        as.push(mesh.area[c] * kmPerUnit * kmPerUnit);
      }
    }
    ratios.push(elongation(xs, ys, as));
  }
  return { count: ratios.length, ratio: median(ratios.filter((r) => Number.isFinite(r))) };
}

// 分水岭不对称（第三十二轮）：一边是活动边缘（海岸挨着高山：海岸格或它的邻格抬升 ≥ 0.35）的大陆（≥ 200 格，
// 活动的海岸占 10%–60%），多少面积流向另一边（被动的海岸）。只数流进海的格（不算地图边、内流）。
// 返回这些大陆的中位数，以及它们被动海岸占海岸的比例的中位数（河往最近的海岸放射时两个数差不多）
export function divideAsymmetry(world: World): { share: number; coast: number; count: number } {
  const { mesh, causes } = world;
  const s = statsInput(world);
  const d = drainage(s);
  const active = new Uint8Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    let u = causes.uplift[i];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (causes.land[mesh.adj[e]]) u = Math.max(u, causes.uplift[mesh.adj[e]]);
    if (u >= 0.35) active[i] = 1;
  }
  const isCoast = (i: number) => {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) return true;
    return false;
  };
  const shares: number[] = [];
  const coasts: number[] = [];
  for (const mass of components(s, (i) => causes.land[i] === 1)) {
    if (mass.length < 200) continue;
    let coast = 0;
    let act = 0;
    for (const c of mass) {
      if (!isCoast(c)) continue;
      coast++;
      act += active[c];
    }
    if (!coast || act < 0.1 * coast || act > 0.6 * coast) continue;
    let toPassive = 0;
    let toSea = 0;
    for (const c of mass) {
      const o = d.outlet[c];
      if (o < 0 || mesh.boundary[o] || !isCoast(o)) continue;
      toSea += s.areaKm[c];
      if (!active[o]) toPassive += s.areaKm[c];
    }
    if (!toSea) continue;
    shares.push(toPassive / toSea);
    coasts.push(1 - act / coast);
  }
  return { share: median(shares), coast: median(coasts), count: shares.length };
}


