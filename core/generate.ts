import type { Mesh } from './mesh';
import { fbm, mixSeed, mulberry32 } from './rng';
import { WORLD_TYPES, type WorldType } from './world-types';
import { worldgenSchema, type WorldgenInput, PROFILES, resolvedParams, type Plate, type Block, type SutureLine, type SwellSpot, type Cone, noiseSet, type GenModel, range, irange, warp } from './generate-model';
import { buildRifts, buildIsthmi } from './generate-rifts';
import { blockField } from './generate-sample';
export { WORLD_TYPE_INFO, rerollSchema, worldgenSchema, resolvedParams } from './generate-model';
export type { Reroll, Worldgen, WorldgenInput, Rift, Isthmus, Cone, GenModel } from './generate-model';
export { isthmusNear, warpedAt, riftFrames } from './generate-rifts';
export { copyComponents, sampleComponents, sampleComponentRange, emptyBaseComponents, oceanFloor } from './generate-sample';
export type { BaseComponents, Resample } from './generate-sample';

// 随机世界：先造“地壳高度”，再定海平面。
//   大陆块（不规则、带域扭曲与分形起伏）→ 大陆架、陆坡、深海
//   板块边界 → 洋中脊、海沟、裂谷、分段的造山带（含次级山脉与高原）
//   火山锥（热点岛链、岛弧、海山），高度取重尾分布 → 岛屿大小自然呈幂律
// 可预期性：
//   · 所有随机都按地图上的位置取，结果与格数无关（4000 格的缩略图与 4 万格的成品格局一致）
//   · 陆地比例只决定海平面（陆地多少单调嵌套）；“岛多少”只增减排好序的火山锥；“山多高”只缩放造山带

// 定义在 world-types.ts（星球形态的 schema 也要用，见那里的说明）；这里照旧导出
export { WORLD_TYPES, type WorldType };

export function buildModel(input: WorldgenInput, width: number, height = 1): GenModel {
  const params = resolvedParams(worldgenSchema.parse(input));
  const profile = PROFILES[params.type];
  const seed = params.seed;
  const noise = noiseSet(seed, 0);

  const randP = mulberry32(mixSeed(seed, 101));
  const plates: Plate[] = [];
  const plateCount = irange(randP, profile.plates);
  for (let k = 0; k < plateCount; k++) {
    const a = randP() * Math.PI * 2;
    const sp = 0.35 + 0.65 * randP();
    plates.push({ x: randP() * width, y: randP() * height, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, weight: randP() * 0.03, density: randP(), sib: -1 });
  }

  const randB = mulberry32(mixSeed(seed, 102));
  const blocks: Block[] = [];
  const addBlock = (x: number, y: number, r: number, e: number) => {
    const a = randB() * Math.PI;
    blocks.push({ x, y, r, e, cos: Math.cos(a), sin: Math.sin(a), fam: blocks.length, tri: 0 });
  };
  if (profile.ring) {
    const cx = width / 2;
    const cy = height / 2;
    const ringR = 0.3 + 0.04 * randB();
    const count = irange(randB, profile.blocks);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + randB() * 0.5;
      addBlock(cx + Math.cos(a) * ringR * 1.35, cy + Math.sin(a) * ringR, range(randB, profile.radius), 1 + 0.5 * randB());
    }
  } else {
    // 先定半径：按世界类型的默认陆地比例统一缩放（用类型默认值而不是滑块值，拖“陆地多少”时格局不变）。
    // 随机出来的块太小时陆地凑不够，海平面又不能降进深海
    const count = irange(randB, profile.blocks);
    const radii: number[] = [];
    if (profile.main) radii.push(range(randB, profile.main));
    for (let k = 0; k < count; k++) radii.push(range(randB, profile.radius));
    let area = 0;
    for (const r of radii) area += Math.PI * r * r;
    const scale = Math.min(1.6, Math.max(0.75, Math.sqrt((profile.landFraction * width * height * 1.8) / area)));
    radii.forEach((r0, k) => {
      const r = r0 * scale;
      // 再找位置：16 个候选里挑离已有块边缘最远的，几块大陆之间留出大洋，而不是连成一整块
      let best: [number, number] = [width / 2, height / 2];
      let bestScore = -Infinity;
      for (let t = 0; t < 16; t++) {
        const x = width * (0.08 + 0.84 * randB());
        const y = height * (0.1 + 0.8 * randB());
        let near = 1;
        for (const b of blocks) near = Math.min(near, Math.hypot(x - b.x, y - b.y) - 1.25 * (r + b.r));
        const score = near + randB() * 0.03;
        if (score > bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
      // 小陆块拉长了就成了细棍，限制它的长宽比
      const e = profile.main && k === 0 ? 1 + 0.35 * randB() : 1 + (r < 0.12 ? 0.3 : 0.6) * randB();
      addBlock(best[0], best[1], r, e);
    });
  }
  const meanR = blocks.length ? blocks.reduce((s, b) => s + b.r, 0) / blocks.length : 0.2;
  // 半岛：大陆块向外伸出的狭长瓣（像斯堪的纳维亚、意大利、朝鲜半岛），中尺度的轮廓因此有伸有缩
  const randL = mulberry32(mixSeed(seed, 104));
  // 第三十五轮：四成的半岛是三角形（另一串随机数，半岛的位置、大小不变）
  const randT = mulberry32(mixSeed(seed, 107));
  const parents = blocks.slice();
  for (const b of parents) {
    if (b.r < 0.12) continue;
    const lobes = 1 + Math.floor(randL() * 3);
    for (let k = 0; k < lobes; k++) {
      const a = randL() * Math.PI * 2;
      const dist = b.r * (0.75 + 0.35 * randL());
      const lr = b.r * (0.22 + 0.22 * randL());
      const e = 1.8 + 1.4 * randL();
      // 瓣沿径向拉长：e 作用在块的局部 u 轴上，所以把方向设成径向
      const tri = randT() < 0.4 ? 0.7 + 0.2 * randT() : 0;
      blocks.push({ x: b.x + Math.cos(a) * dist, y: b.y + Math.sin(a) * dist, r: lr, e, cos: Math.cos(a), sin: Math.sin(a), fam: b.fam, tri });
    }
  }
  // 第三十二轮：块内的老缝合线（较大的块里 0–1 条）、带陡崖的穹隆（另一串随机数，前面的格局不变）
  const randS = mulberry32(mixSeed(seed, 105));
  const sutures: SutureLine[] = [];
  parents.forEach((b, k) => {
    if (b.r < 0.15 || randS() < 0.4) return;
    const a = randS() * Math.PI;
    sutures.push({ block: k, cos: Math.cos(a), sin: Math.sin(a), off: (randS() - 0.5) * 0.8 });
  });
  const swells: SwellSpot[] = [];
  const bigOnes = parents.filter((b) => b.r >= 0.1);
  const swellCount = bigOnes.length ? 1 + Math.floor(randS() * Math.min(4, 1 + bigOnes.length / 2)) : 0;
  for (let k = 0; k < swellCount; k++) {
    const b = bigOnes[Math.floor(randS() * bigOnes.length)];
    const a = randS() * Math.PI * 2;
    const d = b.r * 0.6 * Math.sqrt(randS());
    swells.push({ x: b.x + Math.cos(a) * d, y: b.y + Math.sin(a) * d, r: 0.06 + 0.07 * randS(), h: 700 + 700 * randS() });
  }

  const model: GenModel = { params, profile, width, height, plates, blocks, meanR, cones: [], noise, variants: new Map(), sutures, swells, rifts: [], famRift: parents.map(() => -1), isthmi: [] };
  // 第三十五轮：裂开、漂移的大陆块（板块跟着碎块走）、块与块之间的地峡（各自另一串随机数）
  buildRifts(model, parents.length, mulberry32(mixSeed(seed, 106)));
  buildIsthmi(model, parents.length, mulberry32(mixSeed(seed, 108)));
  model.cones = buildCones(model);
  return model;
}

interface PlateInfo {
  a: number;
  b: number;
  // 到板块边界的距离（地图单位）
  bd: number;
  conv: number;
  nx: number;
  ny: number;
}

function plateAt(m: GenModel, x: number, y: number): PlateInfo {
  let a = 0;
  let b = 1;
  let da = Infinity;
  let db = Infinity;
  m.plates.forEach((p, k) => {
    const d = (x - p.x) ** 2 + (y - p.y) ** 2 - p.weight;
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
  const pa = m.plates[a];
  const pb = m.plates[b];
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = dx / L;
  const ny = dy / L;
  return { a, b, bd: (db - da) / (2 * L), conv: (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny, nx, ny };
}

// 本侧在汇聚边界上是否为上覆板块（造山、岛弧在这一侧；另一侧俯冲成海沟）
function overrides(m: GenModel, qx: number, qy: number, pi: PlateInfo, c: number): { over: boolean; bothCont: boolean } {
  const cOther = blockField(m, qx + 2 * pi.bd * pi.nx, qy + 2 * pi.bd * pi.ny);
  const bothCont = c > 0.02 && cOther > 0.02;
  if (Math.abs(c - cOther) > 0.06) return { over: c > cOther, bothCont };
  return { over: m.plates[pi.a].density < m.plates[pi.b].density, bothCont };
}

function buildCones(m: GenModel): Cone[] {
  const { width, height, profile } = m;
  const rand = mulberry32(mixSeed(m.params.seed, 103));
  const cones: Cone[] = [];
  // 热点岛链：沿板块运动方向，越老越矮
  const hotspots = irange(rand, profile.hotspots);
  for (let h = 0; h < hotspots; h++) {
    let px = rand() * width;
    let py = rand() * height;
    for (let t = 0; t < 12; t++) {
      if (blockField(m, px, py) < -0.08) break;
      px = rand() * width;
      py = rand() * height;
    }
    const pi = plateAt(m, px, py);
    const pl = m.plates[pi.a];
    const sp = Math.hypot(pl.vx, pl.vy) || 1;
    const dx = pl.vx / sp;
    const dy = pl.vy / sp;
    const len = 4 + Math.floor(rand() * 7);
    const h0 = 4700 + rand() * 2300;
    const r0 = 0.02 + rand() * 0.012;
    const chainRank = rand();
    for (let i = 0; i < len; i++) {
      const jitter = (rand() - 0.5) * 0.012;
      cones.push({
        x: px + dx * i * 0.03 - dy * jitter,
        y: py + dy * i * 0.03 + dx * jitter,
        r: r0 * (1 - 0.05 * i) * (0.85 + 0.3 * rand()),
        h: h0 * Math.exp(-i / 3.2) * (0.8 + 0.4 * rand()),
        rank: chainRank + i * 0.015,
        kind: 'hotspot',
      });
    }
  }
  // 岛弧：汇聚边界上覆一侧、离边界一定距离的弧形岛串
  const step = 0.028;
  for (let gy = step / 2; gy < height; gy += step) {
    for (let gx = step / 2; gx < width; gx += step) {
      const x = gx + (rand() - 0.5) * step * 0.8;
      const y = gy + (rand() - 0.5) * step * 0.8;
      const r1 = rand();
      const r2 = rand();
      const r3 = rand();
      const [qx, qy] = warp(m.noise, x, y);
      const c = blockField(m, qx, qy);
      if (c > 0.04) continue;
      const pi = plateAt(m, qx, qy);
      if (pi.conv < 0.25 || Math.abs(pi.bd - 0.034) > 0.011) continue;
      if (!overrides(m, qx, qy, pi, c).over) continue;
      cones.push({ x, y, r: 0.011 + 0.016 * r1, h: Math.min(6800, 3400 * Math.pow(Math.max(r2, 1e-3), -0.32)), rank: r3, kind: 'arc' });
    }
  }
  // 海山：成簇或沿断裂带成串（真实海山很少均匀散布），大多没出水面，少数成岛；
  // 重尾的高度分布让岛的大小呈幂律
  let made = 0;
  while (made < profile.seamounts) {
    const cx = rand() * width;
    const cy = rand() * height;
    const clusterRank = rand();
    const linear = rand() < 0.4;
    const ang = rand() * Math.PI;
    const count = 3 + Math.floor(rand() * 7);
    for (let k = 0; k < count && made < profile.seamounts; k++, made++) {
      const along = linear ? (k - count / 2) * 0.022 : 0;
      const x = cx + Math.cos(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const y = cy + Math.sin(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const u = Math.max(rand(), 1e-4);
      const r = 0.009 + 0.02 * rand();
      const h = Math.min(7800, 1900 * Math.pow(u, -0.42));
      const rank = clusterRank + rand() * 0.05;
      cones.push({ x, y, r, h, rank, kind: 'seamount' });
    }
  }
  // 伴生小锥：贴着大锥长出来，岛的轮廓因此不再是圆
  const satellites: Cone[] = [];
  for (const c of cones) {
    const k = Math.floor(rand() * 3);
    for (let s = 0; s < k; s++) {
      const a = rand() * Math.PI * 2;
      const dist = c.r * (0.6 + 0.6 * rand());
      satellites.push({ x: c.x + Math.cos(a) * dist, y: c.y + Math.sin(a) * dist, r: c.r * (0.35 + 0.35 * rand()), h: c.h * (0.55 + 0.3 * rand()), rank: c.rank + 1e-6, kind: c.kind });
    }
  }
  return [...cones, ...satellites].sort((p, q) => p.rank - q.rank);
}

// 换了重画、种子与类型不变：板块、大陆块、火山锥、噪声只取决于种子与类型（和地图大小），照用，只换参数
export function withParams(m: GenModel, input: WorldgenInput): GenModel {
  return { ...m, params: resolvedParams(worldgenSchema.parse(input)) };
}

// 前 N 个火山锥对每格地壳高度与抬升的贡献（火山锥用未扭曲的坐标，保持圆形）
export function coneFields(m: GenModel, mesh: Mesh, count: number): { coneB: Float32Array; coneU: Float32Array } {
  const n = mesh.n;
  const coneB = new Float32Array(n);
  const coneU = new Float32Array(n);
  const cones = m.cones.slice(0, count);
  if (!cones.length) return { coneB, coneU };
  // 均匀网格加速：每格只看附近的锥
  const cs = 0.06;
  const gw = Math.ceil(m.width / cs) + 1;
  const gh = Math.ceil(m.height / cs) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  cones.forEach((c, k) => {
    const r = c.r * 1.4;
    for (let gx = Math.max(0, Math.floor((c.x - r) / cs)); gx <= Math.min(gw - 1, Math.floor((c.x + r) / cs)); gx++) {
      for (let gy = Math.max(0, Math.floor((c.y - r) / cs)); gy <= Math.min(gh - 1, Math.floor((c.y + r) / cs)); gy++) grid[gy * gw + gx].push(k);
    }
  });
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i];
    const y = mesh.y[i];
    const g = Math.min(gh - 1, Math.max(0, Math.floor(y / cs))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(x / cs)));
    for (const k of grid[g]) {
      const c = cones[k];
      const d = Math.hypot(x - c.x, y - c.y);
      // 轮廓不规则：按位置取噪声，岛有湾有岬
      const re = c.r * (1 + 0.45 * fbm(m.noise.cone, x, y, 0.8 / c.r, 3));
      if (d >= re) continue;
      const t = 1 - d / re;
      coneB[i] += c.h * Math.pow(t, 1.5);
      coneU[i] += 1.1 * (c.h / 6500) * Math.pow(t, 1.3);
    }
  }
  return { coneB, coneU };
}
