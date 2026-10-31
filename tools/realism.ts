// 和地球比（第三十一、三十二轮）：tools/realism-report.ts 与慢测试 tools/realism.test.ts 共用的部分。
// 新建一个世界（与向导新建相同：先加基础、自然、中文地名，“几块大陆”），算 core/stats.ts 的统计，再加上要看生成器的两项：
// 裂谷湖的长宽比、分水岭不对称
import { Engine } from '../core/engine';
import { plainStats } from '../core/plains';
import { traceRivers } from '../core/rivers';
import { newWorldContentCommands } from '../core/packs/import';
import { type RealismStats, boxCountDimension, coastPixels, components, drainage, elongation, landShape, median, realismStats, sizePowerLaw, statsInput } from '../core/stats';
import { coastStyle } from '../core/coast-style';
import { fjordSystems } from '../core/fjords';
import { glacialField } from '../core/glacial';
import { type Raster, rasterizeWorld } from '../core/subcell';
import { COAST_AMP, coastNoiseField, coastSeed, ensureBase } from '../core/terrain';
import { isthmusNear, riftFrames, warpedAt } from '../core/generate';
import { LAYOUT_R, isthmusNearPlanet, riftFramesPlanet, warpedAtPlanet } from '../core/planet-gen';
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

type RowExtra = 'riftLakes' | 'riftRatio' | 'divideShare' | 'divideCoast' | 'deltaShare' | 'deltaRivers' | 'fans' | 'wetland' | 'glacialLakeShare' | 'otherLakeShare' | 'glacialLakeK' | 'glacialLakes' | 'fjordDim' | 'barrierDim' | 'barrierShare' | 'fjordShare' | 'fjords' | 'fjordLength' | 'fjordBranched' | 'fjordSpacingCV' | 'hull' | 'peninsula' | 'isthmus' | 'isthmi' | 'rifts' | 'riftMatch';
export type RealismRow = RealismStats & Record<RowExtra, number>;

export const REALISM_ROW_REF: Record<RowExtra, string> = {
  riftLakes: '—',
  riftRatio: '> 4（坦噶尼喀 13）',
  divideShare: '≥ 65%（南美约 85%）',
  divideCoast: '—',
  deltaShare: '30–80%（计划）',
  deltaRivers: '—',
  fans: '—',
  wetland: '≈6%',
  glacialLakeShare: '3–12%（计划；芬兰约 10%）',
  otherLakeShare: '< 2%（计划）',
  glacialLakeK: '0.8–1.2（计划）',
  glacialLakes: '—',
  fjordDim: '≥ 1.25（计划；挪威约 1.5）',
  barrierDim: '≤ 1.1（计划）',
  barrierShare: '5–15%（计划）',
  fjordShare: '—',
  fjords: '—',
  fjordLength: '20–120 km 常见（松恩峡湾 ≈ 200 km，最长的斯科斯比松 ≈ 350 km）',
  fjordBranched: '—',
  fjordSpacingCV: '—',
  hull: '0.2–0.5（计划；非洲约 0.2、欧亚约 0.4）',
  peninsula: '—',
  isthmus: '≥ 40% 的种子（计划）',
  isthmi: '—',
  rifts: '—',
  riftMatch: '< 0.15（计划）',
};

// coast：海岸线的几样（要先栅格化，见 coastRaster）；不给时 NaN
export function realismRow(world: World, coast?: CoastRasterStats): RealismRow {
  const rl = riftLakes(world);
  const dv = divideAsymmetry(world);
  const dl = deltaShare(world);
  const gl = glacialLakes(world);
  const sh = landShape(world);
  return {
    ...realismStats(statsInput(world), coast?.dim ?? NaN),
    riftLakes: rl.count,
    riftRatio: rl.ratio,
    divideShare: dv.share,
    divideCoast: dv.coast,
    deltaShare: dl.share,
    deltaRivers: dl.rivers,
    fans: fansOf.get(world) ?? NaN,
    wetland: wetlandShare(world),
    glacialLakeShare: gl.share,
    otherLakeShare: gl.other,
    glacialLakeK: gl.k,
    glacialLakes: gl.count,
    fjordDim: coast?.fjordDim ?? NaN,
    barrierDim: coast?.barrierDim ?? NaN,
    barrierShare: coast?.barrierShare ?? NaN,
    fjordShare: coast?.fjordShare ?? NaN,
    ...fjordRow(world),
    hull: sh.hull,
    peninsula: sh.peninsula,
    ...outlineStats(world),
  };
}

// 峡湾（第三十六轮）：20 km 以上的峡湾的个数、长度的中位数（km）、有支湾的比例、入海口间距的变异系数
function fjordRow(world: World): { fjords: number; fjordLength: number; fjordBranched: number; fjordSpacingCV: number } {
  const f = fjordStats(world, 20);
  return { fjords: f.count, fjordLength: f.medianKm, fjordBranched: f.branchedShare, fjordSpacingCV: f.spacingCV };
}

// 冰川湖（第三十四轮）：冰川低地（冰盖强度 ≥ 0.5、地面——湖格用水面——低于刮的高度上限，按“最高的山”缩放）里湖面占的比例、
// 别处的陆地里湖面占的比例、冰川区的湖（一半以上的格在冰盖强度 ≥ 0.5 的地方）的大小幂律指数与个数
export function glacialLakes(world: World): { share: number; other: number; k: number; count: number } {
  const f = glacialField(world);
  const s = statsInput(world);
  const scale = world.small.planet.mountainScale / 6000;
  let gl = 0;
  let glLake = 0;
  let other = 0;
  let otherLake = 0;
  for (let i = 0; i < s.n; i++) {
    if (!s.land[i]) continue;
    const lake = s.lake[i] === 1;
    if (f.g[i] >= 0.5 && s.elevation[i] < f.limit[i] * scale) {
      gl += s.areaKm[i];
      if (lake) glLake += s.areaKm[i];
    } else {
      other += s.areaKm[i];
      if (lake) otherLake += s.areaKm[i];
    }
  }
  const sizes: number[] = [];
  for (const c of components(s, (i) => s.land[i] === 1 && s.lake[i] === 1)) {
    let k = 0;
    for (const x of c) if (f.g[x] >= 0.5) k++;
    if (k * 2 >= c.length) sizes.push(c.length);
  }
  return { share: gl ? glLake / gl : NaN, other: other ? otherLake / other : 0, k: sizePowerLaw(sizes), count: sizes.length };
}

// 海岸线（第三十一、三十四轮）：栅格化（与导出、屏幕相同的格以下的海岸），陆地像素里四邻有海的是海岸线。
// dim：整条海岸的盒维数（格子 2–64 像素；星球只数南北纬 60° 以内的行）；
// 峡湾、沙坝海岸：像素取到的格（raster.cell）的峡湾、沙坝权重 ≥ 0.5 的那些海岸像素的盒维数（格子 2–32 像素：一段段的海岸不长，
// 64 像素的格子里数不出变化；星球数到南北纬 75°），与它们占海岸像素的比例（沙坝海岸占海岸长度）。没有这种海岸（少于 200 个像素）时 NaN
export interface CoastRasterStats {
  dim: number;
  fjordDim: number;
  barrierDim: number;
  barrierShare: number;
  fjordShare: number;
}
export function coastRaster(world: World, w: number, r: Raster = rasterizeWorld(world, w, w / 2)): CoastRasterStats {
  const h = w / 2;
  const globe = world.mesh.kind === 'sphere';
  const coast = coastPixels(r.land, w, h, globe);
  const rows: [number, number] = globe ? [Math.round(h / 6), Math.round((h * 5) / 6)] : [0, h];
  const dim = boxCountDimension(coast, w, h, [2, 4, 8, 16, 32, 64], rows);
  const st = coastStyle(world);
  if (!st) return { dim, fjordDim: NaN, barrierDim: NaN, barrierShare: NaN, fjordShare: NaN };
  const fj = new Uint8Array(w * h);
  const bar = new Uint8Array(w * h);
  let total = 0;
  let nf = 0;
  let nb = 0;
  // 峡湾多在高纬：整个星球数到南北纬 75°
  const typeRows: [number, number] = globe ? [Math.round(h / 12), Math.round((h * 11) / 12)] : [0, h];
  for (let p = 0; p < w * h; p++) {
    if (!coast[p]) continue;
    const y = Math.floor(p / w);
    if (y < typeRows[0] || y >= typeRows[1]) continue;
    total++;
    const c = r.cell[p];
    if (st.fjord[c] >= 0.5) {
      fj[p] = 1;
      nf++;
    }
    if (st.barrier[c] >= 0.5) {
      bar[p] = 1;
      nb++;
    }
  }
  const sizes = [2, 4, 8, 16, 32];
  return {
    dim,
    fjordDim: nf >= 200 ? boxCountDimension(fj, w, h, sizes, typeRows) : NaN,
    barrierDim: nb >= 200 ? boxCountDimension(bar, w, h, sizes, typeRows) : NaN,
    barrierShare: total ? nb / total : NaN,
    fjordShare: total ? nf / total : NaN,
  };
}

// 峡湾（第三十六轮，core/fjords.ts）：一个入海口（陆上淹着的点流进海里的点）往上游淹着的陆上的点连成一个峡湾（fjordSystems）。
// lengths：从入海口往上游最长的一条（km，含头上淹到一半的那段），升序；branchedShare：有支湾的比例；armsMax：一个峡湾最多几条支湾；
// spacingCV：入海口到最近的另一个入海口的距离的变异系数（间距不匀时大）。minKm：比它短的不算
export interface FjordStats {
  count: number;
  lengths: number[];
  medianKm: number;
  maxKm: number;
  branchedShare: number;
  armsMax: number;
  spacingCV: number;
}
export function fjordStats(world: World, minKm = 0): FjordStats {
  const st = coastStyle(world);
  const net = st?.net;
  const empty = { count: 0, lengths: [], medianKm: NaN, maxKm: NaN, branchedShare: NaN, armsMax: 0, spacingCV: NaN };
  if (!net) return empty;
  const sys = fjordSystems(net, world.causes.land).filter((f) => f.lengthKm >= minKm);
  if (!sys.length) return empty;
  const near: number[] = [];
  for (const a of sys) {
    let dm = Infinity;
    for (const b of sys) {
      if (a === b) continue;
      const u = a.mouth;
      const v = b.mouth;
      const d = Math.hypot(net.pos[3 * u] - net.pos[3 * v], net.pos[3 * u + 1] - net.pos[3 * v + 1], net.pos[3 * u + 2] - net.pos[3 * v + 2]) / net.spDist;
      if (d < dm) dm = d;
    }
    if (dm < Infinity) near.push(dm);
  }
  const mean = near.reduce((a, b) => a + b, 0) / Math.max(1, near.length);
  const sd = Math.sqrt(near.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, near.length));
  const lens = sys.map((f) => f.lengthKm).sort((a, b) => a - b);
  return {
    count: lens.length,
    lengths: lens,
    medianKm: median(lens),
    maxKm: lens[lens.length - 1],
    branchedShare: sys.filter((f) => f.arms > 0).length / sys.length,
    armsMax: Math.max(...sys.map((f) => f.arms)),
    spacingCV: near.length ? sd / mean : NaN,
  };
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



// 大陆轮廓（第三十五轮）：生成器的地峡、裂开的大陆块（tools/realism-report.ts 与慢测试用）。
//   isthmus：有没有一处地峡留下来了（1 / 0）；isthmi：留下来的个数——扭曲后离地峡中线不到 0.3 个半宽的格（至少 3 格）九成以上是陆地；
//   rifts：量得出两岸的裂开的个数；riftMatch：两岸还原漂移后的平均距离 ÷ D（每处裂开的平均，见 riftCoastMatch）
export function outlineStats(world: World): { isthmus: number; isthmi: number; rifts: number; riftMatch: number } {
  const model = ensureBase(world).model;
  if (!model) return { isthmus: NaN, isthmi: NaN, rifts: NaN, riftMatch: NaN };
  const { mesh, causes } = world;
  const nI = model.isthmi.length;
  const tot = new Int32Array(nI);
  const land = new Int32Array(nI);
  if (nI) {
    for (let i = 0; i < mesh.n; i++) {
      const near =
        model.kind === 'planet'
          ? isthmusNearPlanet(model, warpedAtPlanet(model, mesh.kind === 'sphere' ? mesh.p[3 * i] : 0, mesh.kind === 'sphere' ? mesh.p[3 * i + 1] : 0, mesh.kind === 'sphere' ? mesh.p[3 * i + 2] : 0))
          : isthmusNear(model, ...warpedAt(model, mesh.x[i], mesh.y[i]));
      for (let k = 0; k < nI; k++) {
        if (near[k] >= 0.3) continue;
        tot[k]++;
        land[k] += causes.land[i];
      }
    }
  }
  let kept = 0;
  for (let k = 0; k < nI; k++) if (tot[k] >= 3 && land[k] >= 0.9 * tot[k]) kept++;
  const match = riftCoastMatch(world);
  return { isthmus: kept > 0 ? 1 : 0, isthmi: kept, rifts: match.length, riftMatch: match.length ? match.reduce((a, b) => a + b, 0) / match.length : NaN };
}

// 两岸还原漂移后对不对得上：海岸线（陆格与海格之间的边上按陆度——含海岸噪声——插值的过零点）上的点，
// 按漂移前的位置分到裂开的哪一半；只要裂开出来的海岸：漂移前在这一族块里面（场 ≥ 0.25，原来多半是陆地的地方）、离切口不到 0.012
// （约一两格：海岸在切口上的那些；块原来的海岸碰到切口时两半各往自己那边去，不是裂开的海岸），
// 只比两半沿裂谷线都有海岸的那一段（一半漂出地图、一边是海湾时另一边没有可比的）。两半各至少 10 个点时，
// 每点到另一半最近的点的平均距离（两个方向再平均）÷ D
export function riftCoastMatch(world: World): number[] {
  const model = ensureBase(world).model;
  if (!model || !model.rifts.length) return [];
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const amp = COAST_AMP * world.small.terrain.coastRoughness;
  const le = (i: number) => causes.landness[i] + amp * coast[i];
  // 每处裂开的两半：漂移前的位置与沿裂谷线的位置
  const sides = model.rifts.map(() => [[] as { p: number[]; a: number }[], [] as { p: number[]; a: number }[]]);
  const along = (k: number, p: number[]) => {
    if (model.kind === 'planet') {
      const r = model.rifts[k];
      return (p[0] - r.c[0]) * r.t[0] + (p[1] - r.c[1]) * r.t[1] + (p[2] - r.c[2]) * r.t[2];
    }
    const r = model.rifts[k];
    return (p[0] - r.ox) * r.tx + (p[1] - r.oy) * r.ty;
  };
  for (let i = 0; i < mesh.n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (j < i || causes.land[i] === causes.land[j]) continue;
      const a = le(i);
      const b = le(j);
      const t = a === b ? 0.5 : Math.max(0, Math.min(1, a / (a - b)));
      let frames: [number, number, number[], number, number, number][];
      if (mesh.kind === 'sphere' && model.kind === 'planet') {
        const p = [0, 1, 2].map((c) => mesh.p[3 * i + c] + t * (mesh.p[3 * j + c] - mesh.p[3 * i + c]));
        const L = Math.hypot(p[0], p[1], p[2]);
        // 扭曲有沿半径的分量（转动不改它），漂移前的位置按方向比（投回球面）
        frames = riftFramesPlanet(model, p[0] / L, p[1] / L, p[2] / L).map(([k, sg, P, x, f, u]) => {
          const r = Math.hypot(P[0], P[1], P[2]) / LAYOUT_R;
          return [k, sg, [P[0] / r, P[1] / r, P[2] / r], x, f, u];
        });
      } else if (model.kind !== 'planet') {
        frames = riftFrames(model, mesh.x[i] + t * (mesh.x[j] - mesh.x[i]), mesh.y[i] + t * (mesh.y[j] - mesh.y[i])).map(([k, sg, px, py, x, f, u]) => [k, sg, [px, py], x, f, u]);
      } else continue;
      for (const [k, sg, P, x, f] of frames) {
        if (f < 0.25 || Math.abs(x) > 0.012) continue;
        sides[k][sg > 0 ? 0 : 1].push({ p: P, a: along(k, P) });
      }
    }
  }
  const nn = (from: { p: number[] }[], to: { p: number[] }[]) => {
    let sum = 0;
    for (const { p } of from) {
      let best = Infinity;
      for (const { p: q } of to) {
        let d = 0;
        for (let c = 0; c < p.length; c++) d += (p[c] - q[c]) ** 2;
        if (d < best) best = d;
      }
      sum += Math.sqrt(best);
    }
    return sum / from.length;
  };
  const out: number[] = [];
  model.rifts.forEach((r, k) => {
    const [A0, B0] = sides[k];
    if (!A0.length || !B0.length) return;
    const lo = Math.max(Math.min(...A0.map((q) => q.a)), Math.min(...B0.map((q) => q.a)));
    const hi = Math.min(Math.max(...A0.map((q) => q.a)), Math.max(...B0.map((q) => q.a)));
    const A = A0.filter((q) => q.a >= lo && q.a <= hi);
    const B = B0.filter((q) => q.a >= lo && q.a <= hi);
    if (A.length < 10 || B.length < 10) return;
    out.push((nn(A, B) + nn(B, A)) / 2 / r.D);
  });
  return out;
}
