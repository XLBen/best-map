import { z } from 'zod';
import { hashString } from '../names';
import { mixSeed, mulberry32, noise2, noise3 } from '../rng';
import { typeIdSchema } from '../type-id';
import type { Mesh } from '../mesh';
import type { SmallState, World } from '../world';
import { type CellInputs, type CompiledRule, cellRuleSchema, compileRule, ruleMatches } from './rules';
import { HEX } from './terrain-class';

// 资源（第二十一轮）：每格最多一种（粮食、木材、铁、金……），也可以没有。按分布规则（地形类别、生态、海拔、海岸、河……）
// 与一层噪声自动放（derived.resourceAuto），点格、笔刷可以改（causes.resource：0 自动，255 明确没有，否则是编号）。
// 同一个世界种子、同一份资源，结果一样；与格数无关（噪声按地图上的位置、以 km 计）。
//
// 世界里有哪些资源：small.content.resource 里的（第三十轮起内置的也是普通内容，从资源包加进来）

export const RESOURCE_NONE = 255;

export const RESOURCE_CATEGORIES = ['farm', 'wood', 'herd', 'fish', 'ore', 'luxury', 'magic'] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<ResourceCategory, string> = { farm: '农', wood: '林', herd: '牧', fish: '渔', ore: '矿', luxury: '奢侈', magic: '奇幻' };

export const resourceSchema = z.object({
  id: typeIdSchema.refine((id) => id !== 'none', '“none” 留给“没有资源”'),
  name: z.string().min(1).max(20),
  color: HEX,
  // 图标（界面按它画；不认识的画成圆点）
  icon: z.string().max(30).optional(),
  category: z.enum(RESOURCE_CATEGORIES),
  description: z.string().max(200).optional(),
  // 能长在哪里：满足任何一条就行；空的不自动出现，只能画上去
  rules: z.array(cellRuleSchema).max(16).default([]),
  // 能长的格里大约多少比例有它（不算别的资源抢走的）
  rarity: z.number().min(0).max(1).default(0.2),
  // 几种都能长时谁占上（越大越容易）
  weight: z.number().min(0).max(100).default(1),
  // 成片的大小（km）
  cluster: z.number().min(10).max(5000).default(300),
  // 噪声的种子（省略时按 id；撞 id 改名时用原来的，分布不变）
  seedKey: typeIdSchema.optional(),
});
export type Resource = z.output<typeof resourceSchema>;

type ResSmall = Pick<Partial<SmallState>, 'content'>;

// 世界里的资源（编号 = 下标 + 1，按加进世界的先后）。第三十轮起只读世界里的（内置的通用一套在“通用 ▸ 基础”里，
// 奇幻的一套在“奇幻 ▸ 资源”里）；没有时没有资源层
const EMPTY: readonly Resource[] = [];
const lists = new WeakMap<object, Resource[]>();
export function worldResources(small: ResSmall): readonly Resource[] {
  const own = small.content?.resource as Record<string, Resource> | undefined;
  if (!own) return EMPTY;
  let list = lists.get(own);
  if (!list) lists.set(own, (list = Object.values(own)));
  return list;
}

export function resourceCode(small: ResSmall, id: string): number {
  return worldResources(small).findIndex((r) => r.id === id) + 1;
}
export function resourceAt(small: ResSmall, code: number): Resource | undefined {
  return code > 0 && code !== RESOURCE_NONE ? worldResources(small)[code - 1] : undefined;
}

// ---------- 分布 ----------

// 一格的取值：成片的噪声 + 四分之一的细噪声，约在 [-1, 1]
function value2(s1: number, s2: number, x: number, y: number): number {
  return 0.75 * noise2(s1, x, y) + 0.25 * noise2(s2, x * 4, y * 4);
}
function value3(s1: number, s2: number, x: number, y: number, z: number): number {
  return 0.75 * noise3(s1, x, y, z) + 0.25 * noise3(s2, x * 4, y * 4, z * 4);
}

// 取值的分位数（一次标定，固定的种子与采样点）：稀有度 r 的门槛是 1 − r 分位
const QUANTILES: { 2?: Float64Array; 3?: Float64Array } = {};
const SAMPLES = 16384;
function quantiles(dim: 2 | 3): Float64Array {
  let q = QUANTILES[dim];
  if (q) return q;
  const rand = mulberry32(0x5eed + dim);
  const v = new Float64Array(SAMPLES);
  for (let k = 0; k < SAMPLES; k++) {
    const x = rand() * 512;
    const y = rand() * 512;
    v[k] = dim === 2 ? value2(0x1234, 0x4321, x, y) : value3(0x1234, 0x4321, x, y, rand() * 512);
  }
  v.sort();
  QUANTILES[dim] = q = v;
  return q;
}
export function rarityThreshold(rarity: number, dim: 2 | 3): number {
  if (rarity >= 1) return -Infinity;
  if (rarity <= 0) return Infinity;
  const q = quantiles(dim);
  return q[Math.min(SAMPLES - 1, Math.max(0, Math.floor((1 - rarity) * (SAMPLES - 1))))];
}

// 每种资源每格的噪声取值只取决于网格、种子、成片大小：按网格记下（NaN 是还没算的格），画地形类别、资源时只查表。
// 最多记 FIELD_CACHE 份（拖“成片大小”会一直出新的），多了先丢最早的
const FIELD_CACHE = 48;
const fields = new WeakMap<Mesh, Map<string, Float32Array>>();
function fieldOf(mesh: Mesh, key: string): Float32Array {
  let m = fields.get(mesh);
  if (!m) fields.set(mesh, (m = new Map()));
  let f = m.get(key);
  if (f) {
    m.delete(key);
    m.set(key, f);
    return f;
  }
  f = new Float32Array(mesh.n).fill(NaN);
  m.set(key, f);
  if (m.size > FIELD_CACHE) m.delete(m.keys().next().value!);
  return f;
}

// 自动放资源：每格在能长的资源里取“权重 × 高出门槛多少”最大的那种，都不够门槛时没有。cls 是生效的地形类别
// base（第三十五轮提速）：上一次按同样的资源、类别、种子算出的结果与这一次要重算的格（输入或类别变了的格，见 human/cell-memo.ts）：
// 别的格照抄 base.out（每格的结果只取决于这一格的输入、类别与噪声），与整个重算逐值相同
export function distributeResources(world: World, x: CellInputs, cls: Uint8Array, list: readonly Resource[], classIds: readonly string[], base?: { out: Uint8Array; cells: Int32Array }): Uint8Array {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const dim = sphere ? 3 : 2;
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const biomes = world.small.species;
  const items = list
    .map((r, k) => {
      const s1 = mixSeed(seed, hashString(`resource:${r.seedKey ?? r.id}`));
      const rules = (r.rules ?? []).map((rule) => compileRule(rule, biomes, classIds));
      // 各条规则的类别合在一起（有一条不限类别时为 null）：先按它筛掉大多数格
      let anyCls: Uint8Array | null = new Uint8Array(classIds.length + 1);
      for (const rule of rules) {
        if (!rule.cls) {
          anyCls = null;
          break;
        }
        for (let c = 0; c < rule.cls.length; c++) if (rule.cls[c]) anyCls[c] = 1;
      }
      return {
        code: k + 1,
        rules,
        anyCls,
        t: rarityThreshold(r.rarity ?? 0.2, dim),
        w: r.weight ?? 1,
        // 每 km 几个噪声单位
        f: 1 / (r.cluster ?? 300),
        s1,
        s2: mixSeed(s1, 0x9e37),
        // 记下的取值（同一份网格、种子、成片大小共用；平面按 km/单位，所以也带上它）
        field: fieldOf(mesh, `${s1}:${r.cluster ?? 300}:${world.kmPerUnit}`),
      };
    })
    .filter((r) => r.rules.length && r.w > 0 && r.t < Infinity);
  if (!items.length) return new Uint8Array(x.n);
  // 地图上的位置（km）：平面是 (x, y) × km/单位，球面是单位向量 × 半径
  const km = world.kmPerUnit;
  const at: ResourcePlace = { p: sphere ? mesh.p : null, mx: mesh.x, my: mesh.y, km, radius: km / Math.PI };
  if (base) {
    const out = base.out.slice();
    const cells = base.cells;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      out[i] = x.dry[i] ? resourceOf(items, at, x, cls, i) : 0;
    }
    return out;
  }
  const out = new Uint8Array(x.n);
  distributeAll(items, at, x, cls, out);
  return out;
}

interface ResourceItem {
  code: number;
  rules: CompiledRule[];
  anyCls: Uint8Array | null;
  t: number;
  w: number;
  f: number;
  s1: number;
  s2: number;
  field: Float32Array;
}

// 噪声取在地图上的哪一点（km）：平面是 (x, y) × km/单位，球面是单位向量 × 半径
interface ResourcePlace {
  p: Float64Array | null;
  mx: Float64Array;
  my: Float64Array;
  km: number;
  radius: number;
}

// 整张图（第三十五轮提速：逐格的循环放在小函数里，见开发说明“还没编译好的代码”）
function distributeAll(items: readonly ResourceItem[], at: ResourcePlace, x: CellInputs, cls: Uint8Array, out: Uint8Array) {
  for (let i = 0; i < x.n; i++) if (x.dry[i]) out[i] = resourceOf(items, at, x, cls, i);
}

// 一格（干的陆地）的资源：能长的资源里“权重 × 高出门槛多少”最大的那种（一样大时排在前面的），都不够门槛时 0
function resourceOf(items: readonly ResourceItem[], at: ResourcePlace, x: CellInputs, cls: Uint8Array, i: number): number {
  let best = 0;
  let score = 0;
  const c = cls[i];
  for (let q = 0; q < items.length; q++) {
    const r = items[q];
    if (r.anyCls && !r.anyCls[c]) continue;
    const rules = r.rules;
    let ok = false;
    for (let k = 0; k < rules.length; k++) {
      if (ruleMatches(rules[k], x, i, c)) {
        ok = true;
        break;
      }
    }
    if (!ok) continue;
    let v = r.field[i];
    if (v !== v) {
      const p = at.p;
      v = p
        ? value3(r.s1, r.s2, p[3 * i] * at.radius * r.f, p[3 * i + 1] * at.radius * r.f, p[3 * i + 2] * at.radius * r.f)
        : value2(r.s1, r.s2, at.mx[i] * at.km * r.f, at.my[i] * at.km * r.f);
      // 按记下的（单精度）取值比较：第一次算与之后查表结果一样
      r.field[i] = v;
      v = r.field[i];
    }
    if (v <= r.t) continue;
    const s = r.w * (v - r.t);
    if (s > score) {
      score = s;
      best = r.code;
    }
  }
  return best;
}

// 生效的资源：画过的格用画的（255 是明确没有，资源还在时），别的用自动的
export function effectiveResources(auto: Uint8Array, override: Uint8Array | undefined, dry: Uint8Array, count: number): Uint8Array {
  if (!override) return auto;
  const out = auto.slice();
  for (let i = 0; i < out.length; i++) {
    const v = override[i];
    if (!v || !dry[i]) continue;
    if (v === RESOURCE_NONE) out[i] = 0;
    else if (v <= count) out[i] = v;
  }
  return out;
}
