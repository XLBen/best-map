import { graphDistance, type Mesh, updateDistance } from '../mesh';
import { type Derived, longitudeOf, planetRadiusKm, type World, worldLatitude } from '../world';

// 脚本的输入：一个世界的标准输入、几份数组直接作输入、按距离的几样（第一百零一轮从 core/script.ts 原样搬来）

// ---------- 输入 ----------

export type InputValue = ArrayLike<number> | number | boolean | readonly number[];

// 脚本的输入：按变量的英文名取。只有源码里用到的变量才会来取，所以贵的（离海岸、离河）可以在 get 里现算
export interface ScriptInputs {
  // 数组的长度（格数）
  n: number;
  // 整个星球：fbmAt 用三维噪声
  globe: boolean;
  get(key: string): InputValue | undefined;
  // 自定义场
  field?(name: string): ArrayLike<number> | undefined;
  // 河岸场 river:<id>（0–1）；由引擎在有河流类型后提供
  river?(typeId: string): ArrayLike<number> | undefined;
  // 生态（第十二轮）：河流、湖泊类型的 match 里由引擎提供（数组、函数都按这条河的源头、这个湖的第一格取）
  biomes?: BiomeInputs;
}

// 一条河（一个湖）上的生态。share：这种生态占的比例（0–1，没有这种生态时全是 0）；dominant：最多的那种的 id（没有为 ''）；
// atSource、atMouth：源头、河口那一格的（只有河有）
export interface BiomeInputs {
  share(id: string): ArrayLike<number>;
  dominant(cell: number): string;
  atSource?(cell: number): string;
  atMouth?(cell: number): string;
}

// 直接用几份数组作输入（测试、地形脚本、每条河一次的 match 用）。自定义场写成 'field:名字'
export function arrayInputs(
  n: number,
  values: Record<string, InputValue>,
  opts: { globe?: boolean; river?: (typeId: string) => ArrayLike<number> | undefined; biomes?: BiomeInputs } = {},
): ScriptInputs {
  return {
    n,
    globe: opts.globe ?? false,
    get: (key) => values[key],
    field: (name) => values[`field:${name}`] as ArrayLike<number> | undefined,
    river: opts.river,
    biomes: opts.biomes,
  };
}

// 按内容缓存的距离场（离海岸、离河）：causes.land 是原地改的，所以不能按数组本身做键，要逐字节比较
// （与 features.ts 的 memoized 同一个做法；按网格、按名字各留最近用过的两份）。
// 种子（海格、河格）变了时从最近的一份改起（updateDistance：只重算受影响的一片，与从头算逐值相同）。
// 返回的数组是缓存本身，只读
interface DistMemo {
  seeds: Uint8Array;
  km: number;
  // 地图单位的距离（改起用）与乘过 km 的
  raw: Float64Array;
  value: Float64Array;
}
const distMemo = new WeakMap<Mesh, Map<string, DistMemo[]>>();
// 测试用：on = false 时种子变了也从头算
export const incrementalDistance = { on: true };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let k = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const m = a.length >> 2;
    const x = new Int32Array(a.buffer, a.byteOffset, m);
    const y = new Int32Array(b.buffer, b.byteOffset, m);
    for (let i = 0; i < m; i++) if (x[i] !== y[i]) return false;
    k = m * 4;
  }
  for (; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

// seeds：种子格为 1 的掩码（每次新建的，存进缓存）
function memoDist(mesh: Mesh, name: string, seeds: Uint8Array, km: number): Float64Array {
  let byName = distMemo.get(mesh);
  if (!byName) distMemo.set(mesh, (byName = new Map()));
  const list = byName.get(name) ?? [];
  const hit = list.find((m) => Object.is(m.km, km) && sameBytes(m.seeds, seeds));
  if (hit) {
    byName.set(name, [hit, ...list.filter((m) => m !== hit)]);
    return hit.value;
  }
  let raw: Float64Array | null = null;
  if (incrementalDistance.on && list.length) raw = updateDistance(mesh, list[0].seeds, list[0].raw, seeds);
  if (!raw) {
    const from: number[] = [];
    for (let i = 0; i < seeds.length; i++) if (seeds[i]) from.push(i);
    raw = graphDistance(mesh, from);
  }
  const value = raw.map((v) => v * km);
  byName.set(name, [{ seeds, km, raw, value }, ...list].slice(0, 2));
  return value;
}

// 星球上的单位向量拆成三份（一块地区为 0）
const posMemo = new WeakMap<Mesh, { px: Float64Array; py: Float64Array; pz: Float64Array }>();
function positionsOf(mesh: Mesh) {
  let p = posMemo.get(mesh);
  if (!p) {
    const n = mesh.n;
    if (mesh.kind === 'sphere') {
      p = { px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n) };
      for (let i = 0; i < n; i++) {
        p.px[i] = mesh.p[3 * i];
        p.py[i] = mesh.p[3 * i + 1];
        p.pz[i] = mesh.p[3 * i + 2];
      }
    } else {
      const zero = new Float64Array(n);
      p = { px: zero, py: zero, pz: zero };
    }
    posMemo.set(mesh, p);
  }
  return p;
}

// 一个世界的标准输入。extra 补上颜色脚本的 share、color 等；river 由引擎在有河流类型后提供
export function worldInputs(
  world: World,
  d: Derived = world.derived,
  opts: { extra?: Record<string, InputValue>; river?: (typeId: string) => ArrayLike<number> | undefined } = {},
): ScriptInputs {
  const { mesh, causes, settings, small } = world;
  const n = mesh.n;
  const km = world.kmPerUnit;
  const made = new Map<string, InputValue>();
  const lazy = (key: string, f: () => InputValue) => {
    let v = made.get(key);
    if (v === undefined) made.set(key, (v = f()));
    return v;
  };
  const isRiver = () =>
    lazy('isRiver', () => {
      const out = new Uint8Array(n);
      const t = small.planet.riverThreshold;
      for (let i = 0; i < n; i++) out[i] = causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= t ? 1 : 0;
      return out;
    }) as Uint8Array;
  const get = (key: string): InputValue | undefined => {
    const e = opts.extra?.[key];
    if (e !== undefined) return e;
    switch (key) {
      case 'tMean':
      case 'tWarm':
      case 'tCold':
      case 'precip':
      case 'moisture':
      case 'seasonality':
      case 'continentality':
      case 'elevation':
      case 'slope':
      case 'lake':
      case 'discharge':
      case 'wetness':
      case 'drainArea':
        return d[key];
      case 'windX':
        return lazy(key, () => Float32Array.from(d.windSX, (v, i) => (v + d.windWX[i]) / 2));
      case 'windY':
        return lazy(key, () => Float32Array.from(d.windSY, (v, i) => (v + d.windWY[i]) / 2));
      case 'uplift':
        return causes.uplift;
      case 'rock':
        return causes.erod;
      case 'tempEdit':
        return causes.tempOffset;
      case 'moistEdit':
        return causes.moistOffset;
      case 'coastDist':
        return memoDist(mesh, 'coast', Uint8Array.from(causes.land, (v) => (v === 0 ? 1 : 0)), km);
      case 'isRiver':
        return isRiver();
      case 'riverDist': {
        // 键是“哪些格是河”本身：只改了气候、流量变了一点而河没变时，不用重算
        const r = isRiver();
        return memoDist(mesh, 'river', r.slice(), km);
      }
      case 'x':
        return mesh.x;
      case 'y':
        return mesh.y;
      case 'lat':
        return lazy(key, () => Float64Array.from(mesh.y, (y) => worldLatitude(world, y)));
      case 'lon': {
        // 一块地区按赤道尺度把 x 换成相对地图中心的经度（与地名表导出相同）
        const span = (mesh.width * km) / 111.2;
        return lazy(key, () => Float64Array.from(mesh.x, (x) => (settings.globe ? longitudeOf(x) : (x / mesh.width - 0.5) * span)));
      }
      case 'areaKm2':
        return lazy(key, () => Float64Array.from(mesh.area, (a) => a * km * km));
      case 'px':
      case 'py':
      case 'pz':
        return positionsOf(mesh)[key];
      case 'seed':
        return small.terrain.gen?.seed ?? settings.seed;
      case 'globe':
        return settings.globe === true;
      case 'radiusKm':
        return planetRadiusKm(settings);
      case 'tilt':
      case 'solar':
      case 'humidity':
      case 'riverThreshold':
        return small.planet[key];
      default:
        return undefined;
    }
  };
  return {
    n,
    globe: mesh.kind === 'sphere',
    get,
    field: (name) => {
      // 名字来自脚本：只认自己的键（field('constructor') 不能拿到 Object）
      if (!Object.hasOwn(causes.fields, name)) return undefined;
      const arr = causes.fields[name];
      const corr = Object.hasOwn(d.corrF, name) ? d.corrF[name] : undefined;
      return corr ? (lazy(`field:${name}`, () => arr.map((v, i) => v + corr[i])) as Float32Array) : arr;
    },
    river: opts.river,
  };
}
