// 画陆地、画海、打碎、抬升的画笔（第八十三轮从 core/terrain.ts 原样搬出）
import { COAST_AMP, coastNoiseField, coastSeed, isLandValue, lagoonTest, seaPocket, POCKET_MAX } from './terrain-coast';
import type { World } from './world';
import { smoothstep, clamp, mixSeed } from './rng';

// ---------- 画笔：画陆地 / 画海 ----------

// 画笔中心 70% 半径内一定变成陆地（海）；70%–100% 是自然的海岸过渡带；画笔外不变。
// 过渡带中间很平、两头很陡：海岸噪声在整条过渡带里决定海岸线的位置，
// 画出来的是有湾有岬的海岸，而不是笔画形状的光滑圆边
export function strokeProfile(t: number, rough: number): number {
  const m = COAST_AMP * Math.max(rough, 0.2) + 60;
  if (t <= 0.7) return m;
  const u = 1 - (2 * Math.min(1, t - 0.7)) / 0.3;
  const v = Math.max(-1, Math.min(1, u));
  return m * Math.sign(v) * Math.pow(Math.abs(v), 2.5);
}

export interface StrokeResult {
  cells: number[];
  delta: number[];
}

// t：每格到画笔中心的归一化距离（0 中心，1 边缘）
export function landStroke(world: World, cells: number[], t: number[], mode: 'land' | 'sea'): StrokeResult {
  const rough = world.small.terrain.coastRoughness;
  const out: StrokeResult = { cells: [], delta: [] };
  cells.forEach((i, k) => {
    const P = strokeProfile(t[k], rough);
    const L = world.causes.landness[i];
    const d = mode === 'land' ? Math.max(0, P - L) : Math.min(0, -P - L);
    if (d !== 0) {
      out.cells.push(i);
      out.delta.push(d);
    }
  });
  return out;
}

// 恢复原样（地形、气候的橡皮擦）：每格保留原改动的比例。t 是到画笔中心的归一化距离。
// 和画笔一样，中间 70% 全收回（0），只有最外一圈渐变到不动（1），
// 所以沿原来的笔画擦一遍就干净了
export function restoreKeep(t: number): number {
  const u = Math.max(0, Math.min(1, (t - 0.7) / 0.3));
  return u * u * (3 - 2 * u);
}

// 恢复后的陆地改动量：剩下的零头归零（擦过的地方不留看不见的残余）。命令与预览共用
export function restoredLandDelta(d: number, t: number): number {
  const v = d * restoreKeep(t);
  return Math.abs(v) < 0.5 ? 0 : v;
}

// 恢复原样后 landness 的增量（只含真的有改动的格），预览与命令共用
export function restoreStroke(world: World, cells: number[], t: number[]): StrokeResult {
  const out: StrokeResult = { cells: [], delta: [] };
  cells.forEach((i, k) => {
    const d = world.causes.landDelta[i];
    if (d === 0) return;
    out.cells.push(i);
    out.delta.push(restoredLandDelta(d, t[k]) - d);
  });
  return out;
}

// 应用 landness 增量后的陆海掩码（只算受影响的格），与 resolveTerrain 用同一规则（含小块海的填补，见 fillSeaPockets），
// 所以预览与结果逐格一致。after：受影响的格在改动后是不是陆地。typeAfter：放岛时记上岛的种类的格改后的种类（潟湖按它认）
export function landAfter(world: World, cells: number[], delta: number[], typeAfter?: ReadonlyMap<number, number>): Map<number, boolean> {
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const rough = world.small.terrain.coastRoughness;
  const d = new Map<number, number>();
  cells.forEach((i, k) => d.set(i, (d.get(i) ?? 0) + delta[k]));
  const raw = (i: number) => isLandValue(causes.landness[i] + (d.get(i) ?? 0), coast[i], rough);
  const isSea = (i: number) => !raw(i);
  const isLagoon = lagoonTest(world, typeAfter);
  // 小块海的填补看邻居，所以改动格的邻居也可能变
  const touched = new Set<number>();
  // 有格从陆地变成海时，原来填掉的小块海可能连上了大海（又是海了）
  let opened = false;
  for (const i of d.keys()) {
    touched.add(i);
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) touched.add(mesh.adj[e]);
    if (!raw(i) && isLandValue(causes.landness[i], coast[i], rough)) opened = true;
  }
  const after = new Map<number, boolean>();
  for (const i of [...touched].sort((a, b) => a - b)) {
    if (after.has(i)) continue;
    if (raw(i)) {
      after.set(i, true);
      continue;
    }
    const p = seaPocket(mesh, isSea, isLagoon, i);
    if (p) {
      for (const c of p) after.set(c, true);
      continue;
    }
    after.set(i, false);
    if (!opened) continue;
    // 这一块海不是小块：离它 POCKET_MAX 步以内、原来填成陆地的海格都在这一块里，变回海
    let ring = [i];
    const seen = new Set<number>(ring);
    for (let step = 0; step < POCKET_MAX && ring.length; step++) {
      const next: number[] = [];
      for (const c of ring) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (seen.has(j) || !isSea(j)) continue;
          seen.add(j);
          next.push(j);
          if (causes.land[j] === 1 && !after.has(j)) after.set(j, false);
        }
      }
      ring = next;
    }
  }
  return after;
}

// 幽灵海岸要的补丁：landAfter 的那些格（改动的格与它们的邻格，按编号排好），改动后的 landness 与陆海。
// landness 按 float32 存（与 resolveTerrain 写回 causes.landness 的精度相同），交给 subcell.ts 的 coastPatch 算海岸值
export interface LandPatch {
  cells: Int32Array;
  landness: Float32Array;
  land: Uint8Array;
}

export function landPatch(world: World, cells: number[], delta: number[]): LandPatch {
  const d = new Map<number, number>();
  cells.forEach((i, k) => d.set(i, (d.get(i) ?? 0) + delta[k]));
  const after = [...landAfter(world, cells, delta)].sort((a, b) => a[0] - b[0]);
  const out: LandPatch = { cells: new Int32Array(after.length), landness: new Float32Array(after.length), land: new Uint8Array(after.length) };
  after.forEach(([i, land], k) => {
    out.cells[k] = i;
    out.landness[k] = world.causes.landness[i] + (d.get(i) ?? 0);
    out.land[k] = land ? 1 : 0;
  });
  return out;
}

export function previewLand(world: World, cells: number[], delta: number[]): { gained: number[]; lost: number[] } {
  const gained: number[] = [];
  const lost: number[] = [];
  for (const [i, land] of landAfter(world, cells, delta)) {
    const now = world.causes.land[i] === 1;
    if (land && !now) gained.push(i);
    if (!land && now) lost.push(i);
  }
  return { gained, lost };
}

// ---------- 打碎（第十八轮） ----------
// 打碎笔刷（命令 fragment）。两种：
//   · 裂成碎块（blocks）：圈里的陆地按一张固定的裂缝图裂开——裂缝图是按世界种子、格的位置定的一张“碎玻璃”：
//     一层抖动过的格点（间距 = 碎块的大小）的 Voronoi，每一块是一个碎块，块与块之间的边是裂缝。离裂缝不到半宽的陆地格
//     变成海（真的海峡：landness 像画海一样压到海岸噪声怎么调都还是海，河、生态跟着变），块里的陆地不动；
//     碎块的大小随画笔（半径的 0.7 → 0.35 倍）与力度（越大越碎），至少 3.5 格；裂缝的半宽 0.6–0.95 格（力度越大越宽，
//     至少一格宽：挨着的两格不会隔着裂缝都是陆地），画笔外圈（七成半径以外）渐渐收窄、断开，碎块连回圈外的陆地。
//     裂开后孤零零的单格陆地也变成海（成了碎岛）。原来的陆地（碎块、裂缝）的破碎度同时抬高：碎块里一点点，
//     碎块的边上与裂缝里多一些（两岸支离破碎、水道里有几颗碎岛）；圈里原来的海不碰；
//   · 只打碎海岸（coast）：陆海都不动，只抬离海岸一两格以内的破碎度（力度大时两格）：海岸支离破碎，外面撒一圈碎岛。
//     离岸远的海、内陆不碰。
// 破碎度只抬不降；力度 0.1–1。结果只取决于世界的种子、格的位置与命令里的参数，重放逐值相同
export type FragMode = 'blocks' | 'coast';
export interface FragResult {
  // landness 的增量（裂开的格）
  cells: number[];
  delta: number[];
  // 将来的破碎度（0–255；只列变了的格）
  frag: { cells: number[]; value: number[] };
  // 裂开的格（变成海的陆地格，含孤零零的单格）
  cracked: number[];
}

// 画笔的外圈渐变（与画陆地的 0.7 倍半径一致）：中间 1，边上降到 0
const fragProfile = (t: number) => 1 - smoothstep(0.7, 1, t);

// 碎块的大小（地图单位）：radiusKm 是画笔半径
export function crackBlockSize(world: World, radiusKm: number, strength: number): number {
  const s = clamp(strength, 0, 1);
  return Math.max(3.5 * world.mesh.spacing, (radiusKm / world.kmPerUnit) * (0.7 - 0.35 * s));
}

// 裂缝图：格 i 离最近的裂缝（抖动格点的 Voronoi 的边）有多远（地图单位），与它在哪一块（最近的格点的哈希）。
// 平面按 (x, y)；整个星球在单位球面的三维位置上取格点（间距 B·π），所以没有接缝、两极也一样
export function crackAt(world: World, i: number, B: number, seed: number): { d: number; block: number } {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const g = sphere ? B * Math.PI : B;
  const px = sphere ? mesh.p[3 * i] : mesh.x[i];
  const py = sphere ? mesh.p[3 * i + 1] : mesh.y[i];
  const pz = sphere ? mesh.p[3 * i + 2] : 0;
  const gx = Math.floor(px / g);
  const gy = Math.floor(py / g);
  const gz = Math.floor(pz / g);
  const R = 2;
  const pts: number[] = [];
  const ids: number[] = [];
  for (let dz = sphere ? -R : 0; dz <= (sphere ? R : 0); dz++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const ix = gx + dx;
        const iy = gy + dy;
        const iz = gz + dz;
        const h1 = mixSeed(seed, ix, iy, iz);
        const h2 = mixSeed(h1, 7);
        const h3 = mixSeed(h1, 11);
        pts.push((ix + 0.1 + (0.8 * (h1 & 0xffff)) / 65536) * g, (iy + 0.1 + (0.8 * (h2 & 0xffff)) / 65536) * g, sphere ? (iz + 0.1 + (0.8 * (h3 & 0xffff)) / 65536) * g : 0);
        ids.push(h1);
      }
    }
  }
  const m = ids.length;
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k < m; k++) {
    const d = (pts[3 * k] - px) ** 2 + (pts[3 * k + 1] - py) ** 2 + (pts[3 * k + 2] - pz) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  // 到 Voronoi 的边的距离：对每个别的格点，到两点的垂直平分线（面）的距离，取最小
  let edge = Infinity;
  const ax = pts[3 * best];
  const ay = pts[3 * best + 1];
  const az = pts[3 * best + 2];
  for (let k = 0; k < m; k++) {
    if (k === best) continue;
    const ex = pts[3 * k] - ax;
    const ey = pts[3 * k + 1] - ay;
    const ez = pts[3 * k + 2] - az;
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const dk = (pts[3 * k] - px) ** 2 + (pts[3 * k + 1] - py) ** 2 + (pts[3 * k + 2] - pz) ** 2;
    edge = Math.min(edge, (dk - bd) / (2 * len));
  }
  // 整个星球：三维的距离换回地图单位
  return { d: sphere ? edge / Math.PI : edge, block: ids[best] };
}

// 裂缝的半宽（地图单位）
export const crackHalfWidth = (world: World, strength: number) => world.mesh.spacing * (0.6 + 0.35 * clamp(strength, 0, 1));
// 裂缝图的种子（世界的海岸种子）
export const crackSeed = (world: World) => mixSeed(coastSeed(world), 1818);

export function fragmentStroke(world: World, cells: number[], t: number[], strength: number, mode: FragMode, radiusKm: number): FragResult {
  const { mesh, causes } = world;
  const s = clamp(strength, 0, 1);
  const out: FragResult = { cells: [], delta: [], frag: { cells: [], value: [] }, cracked: [] };
  const old = causes.fragment;
  const target = new Map<number, number>();
  const raise = (i: number, f: number) => {
    const v = Math.round(255 * clamp(f, 0, 1));
    if (v > (target.get(i) ?? (old ? old[i] : 0))) target.set(i, v);
  };
  if (mode === 'coast') {
    // 离海岸几步（陆海按 causes.land，湖面算陆地）：0 是挨着对岸的格
    const rings = s < 0.55 ? 1 : 2;
    const inBrush = new Map<number, number>();
    cells.forEach((i, k) => inBrush.set(i, t[k]));
    const step = new Map<number, number>();
    let front: number[] = [];
    for (const i of cells) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (causes.land[mesh.adj[e]] !== causes.land[i]) {
          step.set(i, 0);
          front.push(i);
          break;
        }
      }
    }
    for (let r = 1; r <= rings && front.length; r++) {
      const next: number[] = [];
      for (const c of front) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (step.has(j) || !inBrush.has(j)) continue;
          step.set(j, r);
          next.push(j);
        }
      }
      front = next;
    }
    const fs = 0.3 + 0.6 * s;
    for (const [i, r] of step) raise(i, fs * (1 - r / (rings + 1)) * fragProfile(inBrush.get(i)!) * (causes.land[i] ? 0.8 : 1));
  } else {
    const B = crackBlockSize(world, radiusKm, s);
    const W = crackHalfWidth(world, s);
    const seed = crackSeed(world);
    const crack = new Set<number>();
    const tOf = new Map<number, number>();
    cells.forEach((i, k) => {
      tOf.set(i, t[k]);
      // 圈里原来的海不碰
      if (!causes.land[i]) return;
      const prof = t[k] <= 0.7 ? 1 : clamp((1 - t[k]) / 0.3, 0, 1);
      const c = crackAt(world, i, B, seed);
      if (c.d < W * prof) crack.add(i);
      // 破碎度：碎块的边上多一点，块里一点点（裂缝里的在下面）
      raise(i, (c.d < W + mesh.spacing ? 0.15 + 0.25 * s : 0.06 + 0.14 * s) * fragProfile(t[k]));
    });
    // 裂开之后孤零零的单格陆地（四周都是海或裂缝）也变成海：成了碎岛
    for (const i of cells) {
      if (!causes.land[i] || crack.has(i)) continue;
      let alone = true;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && alone; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && !crack.has(j)) alone = false;
      }
      if (alone) crack.add(i);
    }
    const m = COAST_AMP * Math.max(world.small.terrain.coastRoughness, 0.2) + 60;
    for (const i of [...crack].sort((a, b) => a - b)) {
      // 像画海一样：landness 压到 −m（海岸噪声怎么调都还是海）
      const d = Math.min(0, -m - causes.landness[i]);
      out.cracked.push(i);
      if (d !== 0) {
        out.cells.push(i);
        out.delta.push(d);
      }
      raise(i, (0.15 + 0.25 * s) * fragProfile(tOf.get(i)!));
    }
  }
  for (const [i, v] of [...target].sort((a, b) => a[0] - b[0])) {
    out.frag.cells.push(i);
    out.frag.value.push(v);
  }
  return out;
}

// 恢复原样（第十八轮）：破碎度按画笔权重退回（中间全收回，边上渐变），剩下不到 4（约 1.5%）的零头归零
export function restoredFragment(v: number, t: number): number {
  const r = Math.round(v * restoreKeep(t));
  return r < 4 ? 0 : r;
}

// 画笔中心七成半径以内的格（t ≤ 0.7：画陆地 / 海一定变成陆地、海，恢复原样完全恢复的那一圈）。
// 画陆地 / 海、恢复原样时这些格记着的岛的种类、破碎度清掉（见 commands.ts 的 applyTerrain）
export const brushCore = (cells: number[], t: number[]) => cells.filter((_, k) => t[k] <= 0.7);

// 画陆地 / 海（restore 为 false）、恢复原样之后这些格将来的破碎度（预览用；与命令同一个规则）：恢复原样先按画笔权重退回，
// 画笔中心（brushCore）、陆海变了的格（changed）清零。没打碎过、什么都不变时为 undefined
export function fragmentAfter(world: World, cells: number[], t: number[], changed: number[], restore: boolean): { cells: number[]; value: number[] } | undefined {
  const f = world.causes.fragment;
  if (!f) return undefined;
  const core = new Set(brushCore(cells, t));
  const out: number[] = [];
  const value: number[] = [];
  cells.forEach((i, k) => {
    const v = core.has(i) ? 0 : restore ? restoredFragment(f[i], t[k]) : f[i];
    if (v !== f[i]) {
      out.push(i);
      value.push(v);
    }
  });
  for (const i of changed) {
    if (f[i]) {
      out.push(i);
      value.push(0);
    }
  }
  return out.length ? { cells: out, value } : undefined;
}

// 堆山 / 压低：抬升的增量，中心最大，平滑衰减到边缘
export function reliefStroke(cells: number[], t: number[], strength: number): { cells: number[]; delta: number[] } {
  return { cells, delta: t.map((v) => strength * (1 - v * v) * (1 - v * v)) };
}
