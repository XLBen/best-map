import type { Mesh } from './mesh';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { latitudeOf, type World, worldLatitude } from './world';

// ---------- 冰川刻蚀（第三十四轮；第八十六轮改成按现在的气候） ----------
// 末次冰期的冰盖刮过的低地（加拿大地盾、芬兰、瑞典）满是大大小小的湖。冰盖到过哪里：
//   · 冰盖的南界（北半球；南半球对称）在纬度 42°–55° 之间，按很低频的噪声逐段变（北美到 40° 多、欧洲到 52° 左右）；
//     南界往极地 6° 以内从 0 渐渐到满（强度 g）；
//   · 第八十六轮：纬度是“冰的纬度” = 现在的纬度（地区挪过的也算）− (冷暖笔刷的 °C + 太阳的增温) / ICE_C_PER_DEG：
//     冷暖笔刷涂冷 1 °C 相当于往极地挪约 1.1°。以前按新建时的纬度，改气候、挪纬度不改冰川；现在挪纬度、涂冷暖、
//     改太阳都会改冰盖到过哪里（湖群、峡湾跟着变）。不读算出来的气温：气温随远处的海陆、山微微变动，
//     冰川会跟着整片抖动；这个代理只在改了的地方变，结果可以预料。涂过的格、纬度、太阳都没动时与以前逐值相同；
//   · 只刮低地：低于 250–800 m（南界附近只有最低的地方，往极地 20° 渐渐放宽到 800 m）；
//   · 刮出 8–68 m 的小洼（按公里定尺度的噪声的峰：湖的大小是真实的，不随格数变），水文照常按溢出口蓄水，成了湖群。
// 第八十六轮起不在高程求解里挖：求解（与它的记忆）只取决于地形的原因，冰川按上面的强度在流水线里另挖一遍
// （engine-recompute.ts：气候按没挖的地形算，再挖冰川、挖河床，水文按挖过的算）。强度存在推导里（derived.ice），
// 海岸类型（峡湾、小湖群）也读它。米都按默认的“最高的山”6000 m（与基准面、洼地相同）

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
  // 冷暖笔刷每 °C 相当于挪多少度纬度的倒数（°C / 度；地球中高纬约 0.9）
  ICE_C_PER_DEG: 0.9,
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

// 新建时的纬度（度）：一块地区按 settings 的南北边（不看之后挪的纬度），整个星球按格的位置。沙坝海岸照旧按它（core/coast-style.ts）
export function creationLat(world: World, i: number): number {
  const { mesh } = world;
  return mesh.kind === 'sphere' ? 90 - 180 * mesh.y[i] : latitudeOf(world.settings, mesh.y[i]);
}

// 海岸类型的岸段噪声的键：种子、比例尺与新建时的纬度
export function glacialKey(world: World): string {
  const s = world.settings;
  return `${s.seed}|${world.kmPerUnit}|${s.globe ? 'globe' : `${s.latNorth},${s.latSouth}`}`;
}

// 每格的噪声（按网格、种子、比例尺缓存，用到哪格才算哪格）：冰盖南界的纬度 L、小洼的噪声 nh
interface IceNoise {
  key: string;
  L: Float64Array;
  nh: Float64Array;
  done: Uint8Array;
}
const noiseCache = new WeakMap<Mesh, IceNoise>();
function iceNoise(world: World): IceNoise {
  const { mesh } = world;
  const key = `${world.settings.seed}|${world.kmPerUnit}`;
  let z = noiseCache.get(mesh);
  if (!z || z.key !== key) {
    z = { key, L: new Float64Array(mesh.n), nh: new Float64Array(mesh.n), done: new Uint8Array(mesh.n) };
    noiseCache.set(mesh, z);
  }
  return z;
}
function noiseAt(world: World, z: IceNoise, i: number): void {
  if (z.done[i]) return;
  const { mesh } = world;
  const C = GLACIAL;
  const seed = world.settings.seed;
  let nl: number;
  let nh: number;
  if (mesh.kind === 'sphere') {
    const R = world.kmPerUnit / Math.PI;
    const x = mesh.p[3 * i] * R;
    const y = mesh.p[3 * i + 1] * R;
    const zz = mesh.p[3 * i + 2] * R;
    nl = fbm3(noise3(seed, 3401), x, y, zz, 1 / C.LIMIT_KM, 2);
    nh = fbm3(noise3(seed, 3402), x, y, zz, 1 / C.HOLLOW_KM, 3, 0.55);
  } else {
    const km = world.kmPerUnit;
    const x = mesh.x[i] * km;
    const y = mesh.y[i] * km;
    nl = fbm(noise2(seed, 3401), x, y, 1 / C.LIMIT_KM, 2);
    nh = fbm(noise2(seed, 3402), x, y, 1 / C.HOLLOW_KM, 3, 0.55);
  }
  z.L[i] = C.LAT_MIN + (C.LAT_MAX - C.LAT_MIN) * Math.min(1, Math.max(0, 0.5 + 1.2 * nl));
  z.nh[i] = nh;
  z.done[i] = 1;
}
// 噪声函数（按种子留一份）
const n2 = new Map<number, ReturnType<typeof gradientNoise>>();
const n3 = new Map<number, ReturnType<typeof gradientNoise3>>();
function noise2(seed: number, k: number) {
  const s = mixSeed(seed, k);
  let f = n2.get(s);
  if (!f) {
    if (n2.size > 8) n2.clear();
    n2.set(s, (f = gradientNoise(s)));
  }
  return f;
}
function noise3(seed: number, k: number) {
  const s = mixSeed(seed, k);
  let f = n3.get(s);
  if (!f) {
    if (n3.size > 8) n3.clear();
    n3.set(s, (f = gradientNoise3(s)));
  }
  return f;
}

// 太阳的增温（°C）：辐射平衡的温度按太阳常数的 1/4 次方变（地球 288 K）
const solarWarm = (solar: number) => 288 * (Math.pow(solar, 0.25) - 1);

// 冰的纬度（度，绝对值）：现在的纬度减去冷暖笔刷与太阳的增温折合的度数
export function iceLat(world: World, i: number, warm = solarWarm(world.small.planet.solar)): number {
  const lat = Math.abs(worldLatitude(world, world.mesh.y[i]));
  return lat - (world.causes.tempOffset[i] + warm) / GLACIAL.ICE_C_PER_DEG;
}

// 冰盖：每格“冰的纬度”超过冰盖南界多少度（0 是冰盖没到过）。新算一份（流水线在气候这一层算，存进 derived.ice）；
// 强度、高度上限都只由它与噪声定（glacialFieldOf）
// legacy：第八十五轮的做法（只按新建时的纬度，见 glacial-legacy.ts）。
// 输入（网格、种子、比例尺、纬度的范围与挪动、太阳、冷暖笔刷）与上一次逐值相同时还是上一次的数组（堆山、改岩性、画陆地都不碰它们）
let lastIce: { mesh: World['mesh']; key: string; tOff: Float32Array; out: Float64Array } | null = null;
export function iceStrength(world: World, legacy = false): Float64Array {
  const s = world.settings;
  const key = `${legacy}|${s.seed}|${world.kmPerUnit}|${s.latNorth},${s.latSouth}|${world.small.planet.latShift}|${world.small.planet.solar}`;
  const tOff = world.causes.tempOffset;
  if (lastIce && lastIce.mesh === world.mesh && lastIce.key === key && sameF32(lastIce.tOff, tOff)) return lastIce.out;
  const out = iceStrengthNew(world, legacy);
  lastIce = { mesh: world.mesh, key, tOff: tOff.slice(), out };
  return out;
}
function sameF32(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function iceStrengthNew(world: World, legacy: boolean): Float64Array {
  const n = world.mesh.n;
  const g = new Float64Array(n);
  const z = iceNoise(world);
  const C = GLACIAL;
  const warm = solarWarm(world.small.planet.solar);
  for (let i = 0; i < n; i++) {
    const lat = legacy ? Math.abs(creationLat(world, i)) : iceLat(world, i, warm);
    if (lat <= C.LAT_MIN) continue;
    noiseAt(world, z, i);
    if (lat > z.L[i]) g[i] = lat - z.L[i];
  }
  return g;
}

// 两份强度逐值相同
export function sameIce(a: Float64Array, b: Float64Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 由冰盖（超过南界的度数）得到强度、小洼的深度、刮的高度上限：按数组（对象）缓存。数组算好以后不再就地改（流水线换上新的数组）
// 推导的数组常被整份复制（撤销缓存、发给主线程之前）：对象不同、内容相同时照用最近一份（比一遍比重算快）
const fieldCache = new WeakMap<Float64Array, { mesh: Mesh; key: string; f: GlacialField }>();
let lastField: { mesh: Mesh; key: string; g: Float64Array; f: GlacialField } | null = null;
export function glacialFieldOf(world: World, g: Float64Array): GlacialField {
  const z = iceNoise(world);
  const hit = fieldCache.get(g);
  if (hit && hit.mesh === world.mesh && hit.key === z.key) return hit.f;
  if (lastField && lastField.mesh === world.mesh && lastField.key === z.key && sameIce(lastField.g, g)) {
    fieldCache.set(g, { mesh: world.mesh, key: z.key, f: lastField.f });
    return lastField.f;
  }
  const n = world.mesh.n;
  const C = GLACIAL;
  const gs = new Float32Array(n);
  const depth = new Float32Array(n);
  const limit = new Float32Array(n);
  const mask = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const over = g[i];
    if (over <= 0) continue;
    const gi = sm01(over / C.LAT_RAMP);
    if (gi <= 0) continue;
    gs[i] = gi;
    any = true;
    noiseAt(world, z, i);
    limit[i] = C.ELEV_MIN + (C.ELEV_MAX - C.ELEV_MIN) * sm01((over - 2) / C.ELEV_SPAN);
    const nh = z.nh[i];
    if (nh > C.HOLLOW_T) {
      const t = Math.min(1, (nh - C.HOLLOW_T) / (C.HOLLOW_TOP - C.HOLLOW_T));
      depth[i] = gi * (C.DEPTH_MIN + (C.DEPTH_MAX - C.DEPTH_MIN) * t);
      mask[i] = 1;
    }
  }
  const f: GlacialField = { g: gs, depth, limit, mask, any };
  fieldCache.set(g, { mesh: world.mesh, key: z.key, f });
  lastField = { mesh: world.mesh, key: z.key, g: g.slice(), f };
  return f;
}

// 这个世界的冰川：推导里有强度（derived.ice）时按它，没有时现算（测试、工具）
export function glacialField(world: World): GlacialField {
  const d = world.derived?.ice;
  return glacialFieldOf(world, d && d.length === world.mesh.n ? d : iceStrength(world));
}

// 计数（测试、tools/realism.ts 看）：挖过的格
export const glacialStats = { carved: 0 };

// 测试用：关掉冰川刻蚀（第三十四轮以前的求解）
export const glacialOn = { on: true };

// 挖过冰川的地形（米）。地形没挖时的样子 terrain（流水线的 e.base.terrain）不动，返回挖过的一份（没有要挖的时返回 terrain 本身）。
// 陆格里低于高度上限的小洼（depth > 0 的格连成的一片）按四周最低的岸取平底，再往下挖 depth（按高度、离海渐弱）：
// 一片小洼一定低过它的岸，水文照常按溢出口蓄成湖。一片洼只看它自己与四周的岸（海算 0 m），与洼之间的先后无关。
// skipOf：不挖的格（放的湖、湖里定了高度的岛），coastOf：离海的距离；都只在要重新挖时才取。按地形（对象）与冰盖的内容记最近两份：冷暖笔刷没碰到冰川时直接照用
const scourMemo = new WeakMap<Float32Array, { g: Float64Array; out: Float32Array }[]>();
export function scourTerrain(world: World, terrain: Float32Array, ice: Float64Array, f: GlacialField, coastOf: () => Float64Array, skipOf: () => Uint8Array | null): Float32Array {
  if (!f.any || !glacialOn.on) return terrain;
  const list = scourMemo.get(terrain) ?? [];
  const hit = list.find((e) => sameIce(e.g, ice));
  if (hit) return hit.out;
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const scale = world.small.planet.mountainScale / 6000;
  const dig = new Float64Array(n);
  let out = terrain;
  if (scourDepths(f.depth, f.limit, causes.land, skipOf(), coastOf(), mesh.spacing * kmPerUnit, scale, terrain, dig)) {
    out = terrain.slice();
    glacialStats.carved += scourBlobs(mesh, causes.land, dig, out);
  }
  scourMemo.set(terrain, [{ g: ice.slice(), out }, ...list].slice(0, 2));
  return out;
}

// 每格要挖多深（米，0 不挖）；返回有没有要挖的（模块里的小函数：很快被编译优化）。h 是米，scale = 最高的山 / 6000
function scourDepths(depth: Float32Array, limit: Float32Array, land: Uint8Array, skip: Uint8Array | null, coastKm: Float64Array, cellKm: number, scale: number, h: Float32Array, dig: Float64Array): boolean {
  const C = GLACIAL;
  let any = false;
  for (let i = 0; i < h.length; i++) {
    const d = depth[i];
    if (d <= 0 || land[i] !== 1 || (skip !== null && skip[i] === 1)) continue;
    const lim = limit[i];
    const low = 1 - sm01((h[i] / scale - C.ELEV_FULL * lim) / ((1 - C.ELEV_FULL) * lim));
    if (low <= 0) continue;
    const fade = sm01((coastKm[i] - C.COAST_CELLS0 * cellKm) / (C.COAST_CELLS1 * cellKm));
    if (fade <= 0) continue;
    dig[i] = d * low * fade * scale;
    any = true;
  }
  return any;
}

// 要挖的格连成的一片：按四周最低的岸（海算 0 m）取平底再挖，不低于 2 m（与高程收尾的保底相同）。返回挖了几格
function scourBlobs(mesh: Mesh, land: Uint8Array, dig: Float64Array, h: Float32Array): number {
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
        } else {
          const hj = land[j] ? h[j] : 0;
          if (hj < rim) rim = hj;
        }
      }
    }
    // 一两格的不挖（与挖洼地的 PIT_MIN_CELLS 一样）：水文不把一两格的洼地当湖（没有自己的湖省；海岸上画成水面的像素
    // 找省份时会找到它所在的陆上的省），格以下的小湖由画法的小湖群画
    if (len < GLACIAL.MIN_CELLS) continue;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      const floor = Math.max(2, rim - dig[c]);
      if (floor < h[c]) h[c] = floor;
    }
    carved += len;
  }
  return carved;
}
