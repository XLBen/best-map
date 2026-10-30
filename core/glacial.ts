import type { Mesh } from './mesh';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { latitudeOf, type World } from './world';

// ---------- 冰川刻蚀（第三十四轮） ----------
// 末次冰期的冰盖刮过的低地（加拿大地盾、芬兰、瑞典）满是大大小小的湖。这里按新建时的纬度定冰盖到过哪里：
//   · 冰盖的南界（北半球；南半球对称）在纬度 42°–55° 之间，按很低频的噪声逐段变（北美到 40° 多、欧洲到 52° 左右）；
//     南界往极地 6° 以内从 0 渐渐到满（强度 g）；
//   · 只刮低地：低于 250–800 m（南界附近只有最低的地方，往极地 20° 渐渐放宽到 800 m）；
//   · 刮出 8–68 m 的小洼（按公里定尺度的噪声的峰：湖的大小是真实的，不随格数变），水文照常按溢出口蓄水，成了湖群。
// 只取决于网格、种子、比例尺与新建时的纬度（elevation.ts 记忆的键里本来就有这几样），不读气候、不读改过的纬度：
// 改气候、挪纬度永远不改高程。高程求解（solveLand）在平原与河口之后挖（每格只看自己，与陆块的先后无关）。
// 米都按默认的“最高的山”6000 m（与基准面、洼地相同）

export const GLACIAL = {
  // 冰盖南界的纬度范围（度）与从南界往极地渐满的宽度
  LAT_MIN: 42,
  LAT_MAX: 55,
  LAT_RAMP: 6,
  // 南界的噪声：每这么多 km 一个起伏
  LIMIT_KM: 2600,
  // 刮的高度上限（m）：南界附近 ELEV_MIN，往极地 ELEV_SPAN 度渐渐到 ELEV_MAX；低于上限的 60% 时刮满，到上限渐渐不刮
  ELEV_MIN: 250,
  ELEV_MAX: 800,
  ELEV_SPAN: 20,
  ELEV_FULL: 0.6,
  // 小洼的深度（m）与噪声：波长约 HOLLOW_KM 的三层噪声，超过 HOLLOW_T 的峰挖 DEPTH_MIN 到 DEPTH_MAX
  DEPTH_MIN: 8,
  DEPTH_MAX: 68,
  HOLLOW_KM: 450,
  HOLLOW_T: 0.26,
  HOLLOW_TOP: 0.55,
  // 离海不到 COAST_CELLS0 格不挖、再往里 COAST_CELLS1 格渐渐挖满：海边的洼会被海平面截住（保底的 2 m 也把它填平）
  COAST_CELLS0: 1.2,
  COAST_CELLS1: 0.6,
  // 连成一片至少这么多格才挖
  MIN_CELLS: 3,
};

export interface GlacialField {
  // 冰盖的强度（0–1）
  g: Float32Array;
  // 小洼的深度（m，按 6000 m 的“最高的山”；没有洼的格 0；已乘强度）
  depth: Float32Array;
  // 刮的高度上限（m）
  limit: Float32Array;
  // 有小洼的格（depth > 0）
  mask: Uint8Array;
  // 有没有冰盖到过的格（没有时求解整段跳过）
  any: boolean;
}

const sm01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 新建时的纬度（度）：一块地区按 settings 的南北边（不看之后挪的纬度），整个星球按格的位置
export function creationLat(world: World, i: number): number {
  const { mesh } = world;
  return mesh.kind === 'sphere' ? 90 - 180 * mesh.y[i] : latitudeOf(world.settings, mesh.y[i]);
}

// 按网格缓存（每个网格留两份）：键是种子、比例尺与新建时的纬度
const cache = new WeakMap<Mesh, Map<string, GlacialField>>();
export function glacialKey(world: World): string {
  const s = world.settings;
  return `${s.seed}|${world.kmPerUnit}|${s.globe ? 'globe' : `${s.latNorth},${s.latSouth}`}`;
}

export function glacialField(world: World): GlacialField {
  const { mesh } = world;
  let byKey = cache.get(mesh);
  if (!byKey) cache.set(mesh, (byKey = new Map()));
  const key = glacialKey(world);
  let f = byKey.get(key);
  if (f) return f;
  f = computeGlacial(world);
  if (byKey.size >= 2) byKey.delete(byKey.keys().next().value!);
  byKey.set(key, f);
  return f;
}

function computeGlacial(world: World): GlacialField {
  const { mesh } = world;
  const n = mesh.n;
  const seed = world.settings.seed;
  const g = new Float32Array(n);
  const depth = new Float32Array(n);
  const limit = new Float32Array(n);
  const mask = new Uint8Array(n);
  const C = GLACIAL;
  let any = false;
  const sphere = mesh.kind === 'sphere';
  const R = world.kmPerUnit / Math.PI;
  const km = world.kmPerUnit;
  const n2L = gradientNoise(mixSeed(seed, 3401));
  const n2H = gradientNoise(mixSeed(seed, 3402));
  const n3L = gradientNoise3(mixSeed(seed, 3401));
  const n3H = gradientNoise3(mixSeed(seed, 3402));
  for (let i = 0; i < n; i++) {
    const lat = Math.abs(creationLat(world, i));
    if (lat <= C.LAT_MIN) continue;
    let nl: number;
    let nh: number;
    if (sphere) {
      const x = mesh.p[3 * i] * R;
      const y = mesh.p[3 * i + 1] * R;
      const z = mesh.p[3 * i + 2] * R;
      nl = fbm3(n3L, x, y, z, 1 / C.LIMIT_KM, 2);
      nh = fbm3(n3H, x, y, z, 1 / C.HOLLOW_KM, 3, 0.55);
    } else {
      const x = mesh.x[i] * km;
      const y = mesh.y[i] * km;
      nl = fbm(n2L, x, y, 1 / C.LIMIT_KM, 2);
      nh = fbm(n2H, x, y, 1 / C.HOLLOW_KM, 3, 0.55);
    }
    const L = C.LAT_MIN + (C.LAT_MAX - C.LAT_MIN) * Math.min(1, Math.max(0, 0.5 + 1.2 * nl));
    const gi = sm01((lat - L) / C.LAT_RAMP);
    if (gi <= 0) continue;
    any = true;
    g[i] = gi;
    limit[i] = C.ELEV_MIN + (C.ELEV_MAX - C.ELEV_MIN) * sm01((lat - L - 2) / C.ELEV_SPAN);
    if (nh > C.HOLLOW_T) {
      const t = Math.min(1, (nh - C.HOLLOW_T) / (C.HOLLOW_TOP - C.HOLLOW_T));
      depth[i] = gi * (C.DEPTH_MIN + (C.DEPTH_MAX - C.DEPTH_MIN) * t);
      mask[i] = 1;
    }
  }
  return { g, depth, limit, mask, any };
}

// 计数（测试、tools/realism.ts 看）：挖过的格（只算重算的陆块）
export const glacialStats = { carved: 0 };

// 测试用：关掉冰川刻蚀（第三十四轮以前的求解）
export const glacialOn = { on: true };

// 挖：todo 里的陆格，低于高度上限的小洼（depth > 0 的格连成的一片）按四周最低的岸取平底，再往下挖 depth（按高度、离海渐弱）：
// 一片小洼一定低过它的岸，水文照常按溢出口蓄成湖（只往下挖、不取平底时，坡上的一片洼常常顺着坡就流走了）。
// 一片洼只看它自己与四周的岸（岸不挖），与陆块、洼之间的先后无关。h、mToRaw 是求解的原始单位
export function glacialScour(f: GlacialField, mesh: Mesh, todo: Uint8Array, land: Uint8Array, coastKm: Float64Array, kmPerUnit: number, mToRaw: number, h: Float64Array): void {
  if (!f.any || !glacialOn.on) return;
  const n = h.length;
  const dig = new Float64Array(n);
  if (!scourDepths(f.depth, f.limit, todo, land, coastKm, mesh.spacing * kmPerUnit, mToRaw, h, dig)) return;
  glacialStats.carved += scourBlobs(mesh, dig, h);
}

// 每格要挖多深（原始单位，0 不挖）；返回有没有要挖的（模块里的小函数：很快被编译优化）
function scourDepths(depth: Float32Array, limit: Float32Array, todo: Uint8Array, land: Uint8Array, coastKm: Float64Array, cellKm: number, mToRaw: number, h: Float64Array, dig: Float64Array): boolean {
  const C = GLACIAL;
  let any = false;
  for (let i = 0; i < h.length; i++) {
    const d = depth[i];
    if (d <= 0 || todo[i] !== 1 || land[i] !== 1) continue;
    const lim = limit[i];
    const low = 1 - sm01((h[i] / mToRaw - C.ELEV_FULL * lim) / ((1 - C.ELEV_FULL) * lim));
    if (low <= 0) continue;
    const fade = sm01((coastKm[i] - C.COAST_CELLS0 * cellKm) / (C.COAST_CELLS1 * cellKm));
    if (fade <= 0) continue;
    dig[i] = d * low * fade * mToRaw;
    any = true;
  }
  return any;
}

// 要挖的格连成的一片：按四周最低的岸取平底再挖。返回挖了几格
function scourBlobs(mesh: Mesh, dig: Float64Array, h: Float64Array): number {
  const { off, adj } = mesh;
  const n = h.length;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let carved = 0;
  for (let s = 0; s < n; s++) {
    if (dig[s] <= 0 || seen[s]) continue;
    let len = 0;
    queue[len++] = s;
    seen[s] = 1;
    let rim = Infinity;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (dig[j] > 0) {
          if (!seen[j]) {
            seen[j] = 1;
            queue[len++] = j;
          }
        } else if (h[j] < rim) rim = h[j];
      }
    }
    // 一两格的不挖（与挖洼地的 PIT_MIN_CELLS 一样）：水文不把一两格的洼地当湖（没有自己的湖省；海岸上画成水面的像素
    // 找省份时会找到它所在的陆上的省），格以下的小湖由画法的小湖群画
    if (len < GLACIAL.MIN_CELLS) continue;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      const floor = rim - dig[c];
      if (floor < h[c]) h[c] = floor;
    }
    carved += len;
  }
  return carved;
}
