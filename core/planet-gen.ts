import { type BaseComponents, type WorldType, type Worldgen, type WorldgenInput, worldgenSchema } from './generate';
import type { SphereMesh } from './mesh';
import { type Noise3, clamp, fbm3, gradientNoise3, mixSeed, mulberry32, smoothstep } from './rng';
import { tangentBasis, toUnit } from './sphere';

// 整个星球的世界生成：与 generate.ts 同一套“地壳高度 + 海平面”的做法，搬到球面上。
//   · 布局坐标 Q = 单位向量 × 2/π（球半径 ρ = 2/π）。这样 10 万格星球的格距和 4 万格的地区地图几乎一样，
//     generate.ts 里按“每格”调好的宽度、频率、阈值都照用；布局与星球大小无关（大小只影响 km）
//   · 噪声是三维的，在球面上取值：没有东西接缝，两极也不会被拉伸
//   · 板块绕各自的欧拉轴转动，速度 v = ω × Q；距离一律用弦长
//   · 所有随机都在建模型时一次取好，每格的值只取决于它在球面上的位置，所以缩略图与成品格局一致

export const LAYOUT_R = 2 / Math.PI;
// 布局坐标下整个球面的面积（4πρ²）
const LAYOUT_AREA = 4 * Math.PI * LAYOUT_R * LAYOUT_R;

type V3 = [number, number, number];

interface PlanetProfile {
  landFraction: number;
  islands: number;
  plates: [number, number];
  blocks: [number, number];
  radius: [number, number];
  // 主块：“一块超大陆”的主体
  main?: [number, number];
  // 其余的块贴在主块边上（连成一整块），而不是彼此远离
  attach?: boolean;
  rise: number;
  relief: number;
  hotspots: [number, number];
  seamounts: number;
  ring?: boolean;
}

// 整个星球的面积约是 2:1 地区地图的 2.5 倍，块、热点、海山的个数相应多一些
const PLANET_PROFILES: Record<WorldType, PlanetProfile> = {
  continents: { landFraction: 0.29, islands: 0.6, plates: [12, 18], blocks: [6, 9], radius: [0.16, 0.32], rise: 1500, relief: 620, hotspots: [5, 9], seamounts: 330 },
  continent: { landFraction: 0.3, islands: 0.35, plates: [10, 14], blocks: [3, 5], radius: [0.12, 0.2], main: [0.55, 0.65], attach: true, rise: 1500, relief: 620, hotspots: [3, 6], seamounts: 180 },
  archipelago: { landFraction: 0.11, islands: 0.8, plates: [10, 16], blocks: [28, 40], radius: [0.045, 0.12], rise: 700, relief: 620, hotspots: [8, 12], seamounts: 380 },
  fragmented: { landFraction: 0.28, islands: 0.55, plates: [16, 22], blocks: [22, 32], radius: [0.08, 0.2], rise: 650, relief: 720, hotspots: [5, 8], seamounts: 280 },
  inland_sea: { landFraction: 0.4, islands: 0.3, plates: [10, 14], blocks: [8, 11], radius: [0.16, 0.23], rise: 1400, relief: 600, hotspots: [3, 5], seamounts: 150, ring: true },
  ocean: { landFraction: 0, islands: 0, plates: [10, 16], blocks: [0, 0], radius: [0.1, 0.2], rise: 1000, relief: 300, hotspots: [8, 12], seamounts: 360 },
};

export function resolvedPlanetParams(p: Worldgen): Worldgen & { landFraction: number; islands: number } {
  const prof = PLANET_PROFILES[p.type];
  return { ...p, landFraction: p.landFraction ?? prof.landFraction, islands: p.islands ?? prof.islands };
}

interface Plate {
  c: V3;
  // 角速度（欧拉轴 × 转速）
  w: V3;
  weight: number;
  density: number;
}

interface Block {
  c: V3;
  // 中心处的外法向、长轴、短轴（单位向量）
  n: V3;
  u: V3;
  v: V3;
  r: number;
  e: number;
}

export interface PlanetCone {
  c: V3;
  r: number;
  h: number;
  rank: number;
  kind: 'hotspot' | 'arc' | 'seamount';
}

interface NoiseSet3 {
  warpA: Noise3;
  warpB: Noise3;
  warpC: Noise3;
  warpD: Noise3;
  warpE: Noise3;
  warpF: Noise3;
  block: Noise3;
  relief: Noise3;
  ocean: Noise3;
  seg: Noise3;
  ridge: Noise3;
  hills: Noise3;
  erod: Noise3;
  cone: Noise3;
}

function noiseSet3(seed: number, variant: number): NoiseSet3 {
  const n = (k: number) => gradientNoise3(mixSeed(seed, variant, k, 0x3d));
  return {
    warpA: n(1),
    warpB: n(2),
    warpC: n(3),
    warpD: n(4),
    block: n(5),
    relief: n(6),
    ocean: n(7),
    seg: n(8),
    ridge: n(9),
    hills: n(10),
    erod: n(11),
    cone: n(12),
    warpE: n(13),
    warpF: n(14),
  };
}

export interface PlanetModel {
  kind: 'planet';
  params: ReturnType<typeof resolvedPlanetParams>;
  profile: PlanetProfile;
  plates: Plate[];
  blocks: Block[];
  meanR: number;
  cones: PlanetCone[];
  noise: NoiseSet3;
  variants: Map<number, NoiseSet3>;
}

const range = (rand: () => number, [a, b]: [number, number]) => a + (b - a) * rand();
const irange = (rand: () => number, [a, b]: [number, number]) => a + Math.floor((b - a + 1) * rand());

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: V3) => Math.sqrt(dot(a, a));
const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

// 球面上均匀的随机点（布局坐标）
function randomPoint(rand: () => number): V3 {
  const z = 2 * rand() - 1;
  const phi = 2 * Math.PI * rand();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi) * LAYOUT_R, r * Math.sin(phi) * LAYOUT_R, z * LAYOUT_R];
}

// 点 c 处、方位角 a（从东向南转）的切向单位向量
function tangentAt(c: V3, a: number): V3 {
  const n = unit(c);
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(n[0], n[1], n[2]);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return [ca * ex + sa * sx, ca * ey + sa * sy, ca * ez + sa * sz];
}

// 从 c 沿切向 dir 走过布局距离 dist（沿大圆）；返回终点与终点处的前进方向
function walk(c: V3, dir: V3, dist: number): { p: V3; t: V3 } {
  const n = unit(c);
  const th = dist / LAYOUT_R;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const p = scale(add(scale(n, ct), scale(dir, st)), LAYOUT_R);
  const t = add(scale(n, -st), scale(dir, ct));
  return { p, t };
}

function makeBlock(c: V3, u: V3, r: number, e: number): Block {
  const n = unit(c);
  // 长轴取切向分量（防止数值误差），短轴与它垂直
  const ut = unit(add(u, scale(n, -dot(u, n))));
  const v = cross(ut, n);
  return { c, n, u: ut, v, r, e };
}

export function buildPlanetModel(input: WorldgenInput): PlanetModel {
  const params = resolvedPlanetParams(worldgenSchema.parse(input));
  const profile = PLANET_PROFILES[params.type];
  const seed = params.seed;
  const noise = noiseSet3(seed, 0);

  const randP = mulberry32(mixSeed(seed, 101, 0x3d));
  const plates: Plate[] = [];
  const plateCount = irange(randP, profile.plates);
  for (let k = 0; k < plateCount; k++) {
    const c = randomPoint(randP);
    const nc = unit(c);
    // 欧拉轴不要离板块中心太近（否则板块原地打转）
    let axis = unit(randomPoint(randP));
    for (let t = 0; t < 20 && Math.abs(dot(axis, nc)) > Math.cos((25 * Math.PI) / 180); t++) axis = unit(randomPoint(randP));
    const sp = 0.35 + 0.65 * randP();
    const sinA = Math.sqrt(Math.max(1e-6, 1 - dot(axis, nc) ** 2));
    plates.push({ c, w: scale(axis, sp / (LAYOUT_R * sinA)), weight: randP() * 0.03, density: randP() });
  }

  const randB = mulberry32(mixSeed(seed, 102, 0x3d));
  const blocks: Block[] = [];
  if (profile.ring) {
    // 环形大陆：围着一个随机中心，环抱一片内海
    const c0 = randomPoint(randB);
    const ringR = 0.45 + 0.05 * randB();
    const count = irange(randB, profile.blocks);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + randB() * 0.5;
      const { p, t } = walk(c0, tangentAt(c0, a), ringR);
      blocks.push(makeBlock(p, t, range(randB, profile.radius), 1 + 0.5 * randB()));
    }
  } else {
    const count = irange(randB, profile.blocks);
    const radii: number[] = [];
    if (profile.main) radii.push(range(randB, profile.main));
    for (let k = 0; k < count; k++) radii.push(range(randB, profile.radius));
    let area = 0;
    for (const r of radii) area += Math.PI * r * r;
    const sc = Math.min(1.6, Math.max(0.75, Math.sqrt((profile.landFraction * LAYOUT_AREA * 1.8) / Math.max(area, 1e-9))));
    radii.forEach((r0, k) => {
      const r = r0 * sc;
      let best: V3 = randomPoint(randB);
      let bestScore = -Infinity;
      for (let t = 0; t < 16; t++) {
        const c = randomPoint(randB);
        let score: number;
        if (profile.attach && k > 0 && blocks.length) {
          // 贴在主块的边上：离主块边缘越近越好
          const main = blocks[0];
          score = -Math.abs(len(add(c, scale(main.c, -1))) - (main.r * 0.9 + r * 0.5));
        } else {
          let near = 1;
          for (const b of blocks) near = Math.min(near, len(add(c, scale(b.c, -1))) - 1.25 * (r + b.r));
          score = near;
        }
        score += randB() * 0.03;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      const e = profile.main && k === 0 ? 1 + 0.35 * randB() : 1 + (r < 0.12 ? 0.3 : 0.6) * randB();
      blocks.push(makeBlock(best, tangentAt(best, randB() * Math.PI), r, e));
    });
  }
  const meanR = blocks.length ? blocks.reduce((s, b) => s + b.r, 0) / blocks.length : 0.2;
  // 半岛：大陆块沿大圆向外伸出的狭长瓣
  const randL = mulberry32(mixSeed(seed, 104, 0x3d));
  const parents = blocks.slice();
  for (const b of parents) {
    if (b.r < 0.12) continue;
    const lobes = 1 + Math.floor(randL() * 3);
    for (let k = 0; k < lobes; k++) {
      const a = randL() * Math.PI * 2;
      const dist = b.r * (0.75 + 0.35 * randL());
      const lr = b.r * (0.22 + 0.22 * randL());
      const e = 1.8 + 1.4 * randL();
      const { p, t } = walk(b.c, tangentAt(b.c, a), dist);
      blocks.push(makeBlock(p, t, lr, e));
    }
  }

  const model: PlanetModel = { kind: 'planet', params, profile, plates, blocks, meanR, cones: [], noise, variants: new Map() };
  model.cones = buildCones(model);
  return model;
}

// 大陆场：1 在块中心，0 在块边缘，负值在块外（加上法向分量，球的另一面不会“折回来”）
function blockField(m: PlanetModel, qx: number, qy: number, qz: number): number {
  let c = -1;
  for (const b of m.blocks) {
    const dx = qx - b.c[0];
    const dy = qy - b.c[1];
    const dz = qz - b.c[2];
    const du = dx * b.u[0] + dy * b.u[1] + dz * b.u[2];
    const dv = dx * b.v[0] + dy * b.v[1] + dz * b.v[2];
    const dn = dx * b.n[0] + dy * b.n[1] + dz * b.n[2];
    const s = 1 - Math.sqrt((du * du) / b.e + dv * dv * b.e + dn * dn) / b.r;
    if (s > c) c = s;
  }
  return c;
}

function warp(ns: NoiseSet3, x: number, y: number, z: number): V3 {
  let qx = x + 0.16 * fbm3(ns.warpA, x, y, z, 1.2, 4);
  let qy = y + 0.16 * fbm3(ns.warpB, x + 5.2, y + 1.3, z, 1.2, 4);
  let qz = z + 0.16 * fbm3(ns.warpE, x - 3.7, y, z + 2.9, 1.2, 4);
  const wx = fbm3(ns.warpC, qx, qy, qz, 4.2, 3);
  const wy = fbm3(ns.warpD, qx + 3.1, qy - 2.7, qz, 4.2, 3);
  const wz = fbm3(ns.warpF, qx, qy + 1.9, qz - 4.4, 4.2, 3);
  qx += 0.045 * wx;
  qy += 0.045 * wy;
  qz += 0.045 * wz;
  return [qx, qy, qz];
}

const power = (p: Plate, x: number, y: number, z: number) => (x - p.c[0]) ** 2 + (y - p.c[1]) ** 2 + (z - p.c[2]) ** 2 - p.weight;

function nearestPlate(m: PlanetModel, x: number, y: number, z: number): number {
  let a = 0;
  let da = Infinity;
  m.plates.forEach((p, k) => {
    const d = power(p, x, y, z);
    if (d < da) {
      da = d;
      a = k;
    }
  });
  return a;
}

interface PlateInfo {
  a: number;
  b: number;
  bd: number;
  conv: number;
  // 边界法向（点处的切向单位向量，指向另一块）
  n: V3;
}

// 一对板块在点 (x, y, z) 处：到边界的距离、汇聚速度（正为汇聚）、切向法向
function pairInfo(m: PlanetModel, a: number, b: number, da: number, db: number, x: number, y: number, z: number): PlateInfo {
  const pa = m.plates[a];
  const pb = m.plates[b];
  const d: V3 = [pb.c[0] - pa.c[0], pb.c[1] - pa.c[1], pb.c[2] - pa.c[2]];
  const L = len(d) || 1e-6;
  const P: V3 = [x, y, z];
  const ph = unit(P);
  const raw = scale(d, 1 / L);
  const nt0 = add(raw, scale(ph, -dot(raw, ph)));
  const ntl = len(nt0);
  const n: V3 = ntl > 1e-9 ? scale(nt0, 1 / ntl) : [0, 0, 0];
  const rel = cross([pa.w[0] - pb.w[0], pa.w[1] - pb.w[1], pa.w[2] - pb.w[2]], P);
  return { a, b, bd: (db - da) / (2 * L), conv: dot(rel, n), n };
}

function plateAt(m: PlanetModel, x: number, y: number, z: number): PlateInfo {
  let a = 0;
  let b = 1;
  let da = Infinity;
  let db = Infinity;
  m.plates.forEach((p, k) => {
    const d = power(p, x, y, z);
    if (d < da) {
      db = da;
      b = a;
      da = d;
      a = k;
    } else if (d < db) {
      db = d;
      b = k;
    }
  });
  return pairInfo(m, a, b, da, db, x, y, z);
}

function overrides(m: PlanetModel, q: V3, pi: PlateInfo, c: number): { over: boolean; bothCont: boolean } {
  const cOther = blockField(m, q[0] + 2 * pi.bd * pi.n[0], q[1] + 2 * pi.bd * pi.n[1], q[2] + 2 * pi.bd * pi.n[2]);
  const bothCont = c > 0.02 && cOther > 0.02;
  if (Math.abs(c - cOther) > 0.06) return { over: c > cOther, bothCont };
  return { over: m.plates[pi.a].density < m.plates[pi.b].density, bothCont };
}

// 从 c 出发在切平面里偏移 (de, ds)（布局单位）后投回球面
function offsetOnSphere(c: V3, de: number, ds: number): V3 {
  const n = unit(c);
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(n[0], n[1], n[2]);
  const p: V3 = [c[0] + de * ex + ds * sx, c[1] + de * ey + ds * sy, c[2] + de * ez + ds * sz];
  return scale(unit(p), LAYOUT_R);
}

function buildCones(m: PlanetModel): PlanetCone[] {
  const { profile } = m;
  const rand = mulberry32(mixSeed(m.params.seed, 103, 0x3d));
  const cones: PlanetCone[] = [];
  // 热点岛链：沿板块运动方向排成大圆上的一串，越老越矮
  const hotspots = irange(rand, profile.hotspots);
  for (let h = 0; h < hotspots; h++) {
    let p = randomPoint(rand);
    for (let t = 0; t < 12; t++) {
      if (blockField(m, p[0], p[1], p[2]) < -0.08) break;
      p = randomPoint(rand);
    }
    const pi = plateAt(m, p[0], p[1], p[2]);
    const v = cross(m.plates[pi.a].w, p);
    const dir = len(v) > 1e-9 ? unit(v) : tangentAt(p, 0);
    const side = cross(unit(p), dir);
    const count = 4 + Math.floor(rand() * 7);
    const h0 = 4700 + rand() * 2300;
    const r0 = 0.02 + rand() * 0.012;
    const chainRank = rand();
    for (let i = 0; i < count; i++) {
      const jitter = (rand() - 0.5) * 0.012;
      const at = walk(p, dir, i * 0.03).p;
      const c = scale(unit(add(at, scale(side, jitter))), LAYOUT_R);
      cones.push({
        c,
        r: r0 * (1 - 0.05 * i) * (0.85 + 0.3 * rand()),
        h: h0 * Math.exp(-i / 3.2) * (0.8 + 0.4 * rand()),
        rank: chainRank + i * 0.015,
        kind: 'hotspot',
      });
    }
  }
  // 岛弧：在汇聚边界上覆的一侧、离边界一定距离。候选点是均匀铺满球面的斐波那契点阵（只取决于种子）
  const step = 0.028;
  const N = Math.round(LAYOUT_AREA / (step * step));
  let cg = 1;
  let sg = 0;
  for (let k = 0; k < N; k++) {
    const z = 1 - (2 * k + 1) / N;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const base: V3 = [r * cg * LAYOUT_R, r * sg * LAYOUT_R, z * LAYOUT_R];
    const nc = cg * -0.73736887807831974 - sg * 0.67549029426152385;
    const ns = sg * -0.73736887807831974 + cg * 0.67549029426152385;
    const nl = Math.sqrt(nc * nc + ns * ns);
    cg = nc / nl;
    sg = ns / nl;
    const p = offsetOnSphere(base, (rand() - 0.5) * step * 0.8, (rand() - 0.5) * step * 0.8);
    const r1 = rand();
    const r2 = rand();
    const r3 = rand();
    const q = warp(m.noise, p[0], p[1], p[2]);
    const c = blockField(m, q[0], q[1], q[2]);
    if (c > 0.04) continue;
    const pi = plateAt(m, q[0], q[1], q[2]);
    if (pi.conv < 0.25 || Math.abs(pi.bd - 0.034) > 0.011) continue;
    if (!overrides(m, q, pi, c).over) continue;
    cones.push({ c: p, r: 0.011 + 0.016 * r1, h: Math.min(6800, 3400 * Math.pow(Math.max(r2, 1e-3), -0.32)), rank: r3, kind: 'arc' });
  }
  // 海山：成簇或沿断裂带成串；重尾的高度分布让岛的大小呈幂律
  let made = 0;
  while (made < profile.seamounts) {
    const center = randomPoint(rand);
    const clusterRank = rand();
    const linear = rand() < 0.4;
    const ang = rand() * Math.PI;
    const count = 3 + Math.floor(rand() * 7);
    for (let k = 0; k < count && made < profile.seamounts; k++, made++) {
      const along = linear ? (k - count / 2) * 0.022 : 0;
      const de = Math.cos(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const ds = Math.sin(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const c = offsetOnSphere(center, de, ds);
      const u = Math.max(rand(), 1e-4);
      const r = 0.009 + 0.02 * rand();
      const h = Math.min(7800, 1900 * Math.pow(u, -0.42));
      const rank = clusterRank + rand() * 0.05;
      cones.push({ c, r, h, rank, kind: 'seamount' });
    }
  }
  // 伴生小锥：岛的轮廓因此不再是圆
  const satellites: PlanetCone[] = [];
  for (const c of cones) {
    const k = Math.floor(rand() * 3);
    for (let s = 0; s < k; s++) {
      const a = rand() * Math.PI * 2;
      const dist = c.r * (0.6 + 0.6 * rand());
      satellites.push({ c: offsetOnSphere(c.c, Math.cos(a) * dist, Math.sin(a) * dist), r: c.r * (0.35 + 0.35 * rand()), h: c.h * (0.55 + 0.3 * rand()), rank: c.rank + 1e-6, kind: c.kind });
    }
  }
  return [...cones, ...satellites].sort((p, q) => p.rank - q.rank);
}

const emptyComponents = (n: number): BaseComponents => ({
  b0: new Float32Array(n),
  mountB: new Float32Array(n),
  mountU: new Float32Array(n),
  hillU: new Float32Array(n),
  erod: new Float32Array(n),
});

export function samplePlanetComponents(m: PlanetModel, mesh: SphereMesh): BaseComponents {
  const n = mesh.n;
  const out = emptyComponents(n);
  const rerolls = m.params.rerolls.map((r) => ({ ...r, u: toUnit(r.x, r.y) }));
  const tmp = emptyComponents(1);
  for (let i = 0; i < n; i++) {
    const px = mesh.p[3 * i];
    const py = mesh.p[3 * i + 1];
    const pz = mesh.p[3 * i + 2];
    sampleInto(m, m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, out, i);
    // 重画这一片：球面上的圆（半径是地图单位，即弧长 / π）里换一套噪声，边缘羽化
    for (const r of rerolls) {
      const cx = py * r.u[2] - pz * r.u[1];
      const cy = pz * r.u[0] - px * r.u[2];
      const cz = px * r.u[1] - py * r.u[0];
      const d = Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), px * r.u[0] + py * r.u[1] + pz * r.u[2]) / Math.PI;
      if (d >= r.radius) continue;
      let ns = m.variants.get(r.variant);
      if (!ns) {
        ns = noiseSet3(m.params.seed, r.variant);
        m.variants.set(r.variant, ns);
      }
      sampleInto(m, ns, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, tmp, 0);
      const w = 1 - smoothstep(0.6, 1, d / r.radius);
      out.b0[i] += (tmp.b0[0] - out.b0[i]) * w;
      out.mountB[i] += (tmp.mountB[0] - out.mountB[i]) * w;
      out.mountU[i] += (tmp.mountU[0] - out.mountU[i]) * w;
      out.hillU[i] += (tmp.hillU[0] - out.hillU[i]) * w;
    }
  }
  return out;
}

function sampleInto(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, out: BaseComponents, i: number) {
  const prof = m.profile;
  const [qx, qy, qz] = warp(ns, x, y, z);
  let c = m.blocks.length ? blockField(m, qx, qy, qz) : -1;
  if (m.blocks.length) {
    const f = 1 / Math.max(0.1, m.meanR);
    c += 0.42 * fbm3(ns.block, qx, qy, qz, 1.5 * f, 4, 0.55) + 0.18 * fbm3(ns.hills, qx + 9.1, qy - 4.3, qz, 6 * f, 4, 0.62);
  }

  // 地壳：大陆架 → 陆坡 → 深海（与 generate.ts 相同）
  const slopeW = 0.08;
  let B: number;
  if (c >= 0) B = -140 + 650 * Math.min(c, 0.16) + prof.rise * Math.max(0, c - 0.16);
  else if (c >= -slopeW) B = -140 - 3800 * smoothstep(0, 1, -c / slopeW);
  else B = -3940;
  const rw = smoothstep(-slopeW, 0.06, c);
  B += prof.relief * rw * fbm3(ns.relief, qx, qy, qz, 2.6, 9, 0.62);
  B += 230 * (1 - rw) * fbm3(ns.ocean, qx, qy, qz, 5, 4);

  // 板块边界：在更弯曲的坐标里求
  const px = qx + 0.07 * fbm3(ns.seg, qx + 11.3, qy, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy + 4.4, qz, 5.5, 2);
  const py = qy + 0.07 * fbm3(ns.seg, qx, qy - 7.9, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx - 2.2, qy, qz, 5.5, 2);
  const pz = qz + 0.07 * fbm3(ns.seg, qx, qy, qz + 6.1, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy, qz - 3.3, 5.5, 2);
  const oceanW = 1 - smoothstep(-0.12, 0, c);
  const contW = smoothstep(-0.02, 0.1, c);
  const widthMod = 0.65 + 0.7 * (0.5 + 0.5 * fbm3(ns.hills, px * 0.7, py * 0.7, pz * 0.7, 2.5, 2));
  const seg = smoothstep(-0.35, 0.3, fbm3(ns.seg, qx, qy, qz, 3.5, 3));
  const ridged = 1 - Math.abs(fbm3(ns.ridge, qx, qy, qz, 10, 4));
  const wc = 0.055 * widthMod;
  const wm = 0.032 * widthMod;
  const belt = (bd: number, w: number) => Math.exp(-((bd / w) ** 2)) + 0.5 * Math.exp(-(((bd - 2.4 * w) / (0.6 * w)) ** 2));
  const a = nearestPlate(m, px, py, pz);
  const da = power(m.plates[a], px, py, pz);
  let ridge = 0;
  let rift = 0;
  let trench = 0;
  let mm = 0;
  for (let b = 0; b < m.plates.length; b++) {
    if (b === a) continue;
    const db = power(m.plates[b], px, py, pz);
    const pa = m.plates[a];
    const pb = m.plates[b];
    const L = Math.sqrt((pb.c[0] - pa.c[0]) ** 2 + (pb.c[1] - pa.c[1]) ** 2 + (pb.c[2] - pa.c[2]) ** 2) || 1e-6;
    const bd = (db - da) / (2 * L);
    if (bd > 0.3) continue;
    const pi = pairInfo(m, a, b, da, db, px, py, pz);
    const conv = pi.conv;
    if (conv < 0) {
      const div = Math.min(1, -conv);
      ridge = Math.max(ridge, div * Math.exp(-((bd / 0.04) ** 2)));
      rift = Math.max(rift, div * Math.exp(-((bd / 0.025) ** 2)));
      continue;
    }
    const cOther = blockField(m, qx + 2 * bd * pi.n[0], qy + 2 * bd * pi.n[1], qz + 2 * bd * pi.n[2]);
    const wb = smoothstep(-0.02, 0.1, cOther);
    const cv = Math.min(1.3, conv);
    const subducts = (1 - contW) * Math.max(wb, pa.density > pb.density ? 1 : 0);
    trench = Math.max(trench, Math.min(1, cv) * Math.exp(-(((bd - 0.012) / 0.012) ** 2)) * subducts);
    const collision = contW * wb;
    const margin = contW * (1 - wb);
    const shape = collision * (belt(bd, wc) + 0.45 * Math.exp(-((bd / (3 * wc)) ** 2))) + margin * belt(bd, wm);
    mm = Math.max(mm, cv * shape);
  }
  B += 1700 * ridge * oceanW - 900 * rift * contW - 2600 * trench * oceanW;
  const mountU = mm * (0.3 + 0.7 * seg) * (0.55 + 0.6 * ridged);
  const mountB = 1600 * mountU * smoothstep(-0.05, 0.05, c);
  out.b0[i] = B;
  out.mountB[i] = mountB;
  out.mountU[i] = mountU;
  out.hillU[i] = 0.12 * Math.max(0, fbm3(ns.hills, qx, qy, qz, 6, 4)) * contW;
  out.erod[i] = clamp(1 + 0.45 * fbm3(ns.erod, x + 7.7, y - 3.1, z + 1.9, 6, 3), 0.4, 1.8);
}

// 前 N 个火山锥对每格地壳高度与抬升的贡献（不扭曲坐标，保持圆形）
export function planetConeFields(m: PlanetModel, mesh: SphereMesh, count: number): { coneB: Float32Array; coneU: Float32Array } {
  const n = mesh.n;
  const coneB = new Float32Array(n);
  const coneU = new Float32Array(n);
  const cones = m.cones.slice(0, count);
  if (!cones.length) return { coneB, coneU };
  // 三维均匀网格加速
  const cs = 0.06;
  const lo = -LAYOUT_R - cs;
  const g = Math.ceil((2 * LAYOUT_R + 2 * cs) / cs) + 1;
  const grid = new Map<number, number[]>();
  const key = (ix: number, iy: number, iz: number) => (ix * g + iy) * g + iz;
  cones.forEach((c, k) => {
    const r = c.r * 1.4;
    for (let ix = Math.floor((c.c[0] - r - lo) / cs); ix <= Math.floor((c.c[0] + r - lo) / cs); ix++) {
      for (let iy = Math.floor((c.c[1] - r - lo) / cs); iy <= Math.floor((c.c[1] + r - lo) / cs); iy++) {
        for (let iz = Math.floor((c.c[2] - r - lo) / cs); iz <= Math.floor((c.c[2] + r - lo) / cs); iz++) {
          const kk = key(ix, iy, iz);
          const list = grid.get(kk);
          if (list) list.push(k);
          else grid.set(kk, [k]);
        }
      }
    }
  });
  for (let i = 0; i < n; i++) {
    const x = mesh.p[3 * i] * LAYOUT_R;
    const y = mesh.p[3 * i + 1] * LAYOUT_R;
    const z = mesh.p[3 * i + 2] * LAYOUT_R;
    const list = grid.get(key(Math.floor((x - lo) / cs), Math.floor((y - lo) / cs), Math.floor((z - lo) / cs)));
    if (!list) continue;
    for (const k of list) {
      const c = cones[k];
      const d = Math.sqrt((x - c.c[0]) ** 2 + (y - c.c[1]) ** 2 + (z - c.c[2]) ** 2);
      const re = c.r * (1 + 0.45 * fbm3(m.noise.cone, x, y, z, 0.8 / c.r, 3));
      if (d >= re) continue;
      const t = 1 - d / re;
      coneB[i] += c.h * Math.pow(t, 1.5);
      coneU[i] += 1.1 * (c.h / 6500) * Math.pow(t, 1.3);
    }
  }
  return { coneB, coneU };
}
