import { z } from 'zod';
import { CommandError } from './errors';
import { type Mesh, graphDistance } from './mesh';
// 只在 z.lazy 里读 scriptsSchema：script.ts 经 world.ts 又引用别的模块，顶层直接读会碰上“初始化之前不能访问”
import { type BiomeInputs, codeOnly, compileScript, scriptsSchema, usesBiomeHelpers } from './script';
import { typeIdSchema } from './type-id';
import type { World } from './world';

// 水体类型（河流类型、湖泊类型）共用的部分：格式里相同的几项、只能有 match 的脚本、改了哪几项要从哪一层重算、
// 岸边的远近（river:<id>、lake:<id>，0–1）。河的见 river-types.ts，湖的见 lake-types.ts

// 选了“普通的”的河道、湖（type 写成这个）：不按 match 脚本变成别的类型。所以这个 id 不能用作类型的 id
export const PLAIN_TYPE = 'plain';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #rrggbb');

// ---------- 声明式条件（第五十六轮） ----------

// 每一项的滑块：到两头是“不限”。height 的上限同 species.ts 的 HEIGHT_MAX（这里不能在顶层读它：模块互相引用，测试查着两个数相同）
export const WHEN_KEYS = ['height', 'slope', 'temp', 'flow'] as const;
export type WhenKey = (typeof WHEN_KEYS)[number];
export const WHEN_RANGE: Record<WhenKey, { label: string; unit: string; lo: number; hi: number; step: number }> = {
  height: { label: '高度', unit: 'm', lo: 0, hi: 9000, step: 100 },
  slope: { label: '坡度', unit: 'm/km', lo: 0, hi: 100, step: 1 },
  temp: { label: '气温', unit: '°C', lo: -40, hi: 35, step: 1 },
  flow: { label: '流量', unit: 'm³/s', lo: 0, hi: 20000, step: 10 },
};

const whenRangeSchema = z.object({ low: z.number(), high: z.number() }).refine((r) => r.low <= r.high, { message: '下限不能高于上限' });
export const waterWhenSchema = z.object({
  height: whenRangeSchema.optional(),
  slope: whenRangeSchema.optional(),
  temp: whenRangeSchema.optional(),
  flow: whenRangeSchema.optional(),
});
export type WaterWhen = z.output<typeof waterWhenSchema>;

// 写了条件（空的对象、全是“不限”的不算）
export function hasWhen(t: { when?: WaterWhen }): boolean {
  const w = t.when;
  if (!w) return false;
  for (const k of WHEN_KEYS) {
    const r = w[k];
    if (r && (r.low > WHEN_RANGE[k].lo || r.high < WHEN_RANGE[k].hi)) return true;
  }
  return false;
}

// 条件换成八个数（高度、坡度、气温、流量各一对下限上限；到两头的是无穷）
export function whenBounds(w: WaterWhen): Float64Array {
  const out = new Float64Array(8);
  WHEN_KEYS.forEach((k, q) => {
    const r = w[k];
    out[2 * q] = !r || r.low <= WHEN_RANGE[k].lo ? -Infinity : r.low;
    out[2 * q + 1] = !r || r.high >= WHEN_RANGE[k].hi ? Infinity : r.high;
  });
  return out;
}

export function whenHolds(b: Float64Array, height: number, slope: number, temp: number, flow: number): boolean {
  return height >= b[0] && height <= b[1] && slope >= b[2] && slope <= b[3] && temp >= b[4] && temp <= b[5] && flow >= b[6] && flow <= b[7];
}

// 两种共有的几项。what：出错说明里的叫法（“河流类型”“湖泊类型”）；kind：match 脚本说明里的“哪些河 / 哪些湖”
export function waterTypeShape(what: string, noun: string) {
  return {
    id: typeIdSchema.refine((id) => id !== PLAIN_TYPE, `“${PLAIN_TYPE}”留给“普通的${noun}”，换一个 id`),
    name: z.string().min(1).max(12),
    color: hexColor,
    // 地图集风格里用的颜色（省略时同 color）
    atlasColor: hexColor.optional(),
    // 岸边的影响：离这种水 radiusKm 以内，越近越强（变暖变冷 dT °C、变湿变干：降水乘以 e^dP）。
    // 岸边的远近（river:<id> / lake:<id>，0–1）给生态的条件、脚本用
    bank: z
      .object({
        radiusKm: z.number().min(10).max(1000),
        dT: z.number().min(-10).max(10).optional(),
        dP: z.number().min(-1.5).max(1.5).optional(),
      })
      .optional(),
    // 起名模板（{词表} 用文字包的词表，{__species} 是类型名）
    names: z
      .array(z.object({ p: z.string().min(1).max(40), w: z.number().positive().optional() }))
      .min(1)
      .max(20)
      .optional(),
    // 只有 match：哪些自然的河（湖）是这一种（每条河、每个湖算一次，返回真假）
    scripts: z
      .lazy(() => scriptsSchema)
      .refine((s) => Object.entries(s).every(([k, v]) => k === 'match' || v === undefined), `${what}只能有“哪些${noun}是这一种”（match）的脚本`)
      .optional(),
    // 脚本里噪声、rand 的种子用它（省略时用 id）：资源包里的类型改了 id，匹配的河、湖也不变
    seedKey: z.string().min(1).max(64).optional(),
    // 第十二轮：自然生成。false 时不按规则自己出现（只用在画的河、放的湖、选了它的河和湖上）。
    // 省略为 true（旧的类型照旧）；界面里新建的、资源包里没写的是 false
    natural: z.boolean().optional(),
    // 允许表里的一行（第五十六轮）：这种水可以出现在哪些生态里，省略为全部，空的列表哪里都不行。河按每格的生态看，湖按湖岸一圈至少一半（按不计水体类型的一遍植被）。
    // 自然生成时它也是条件：只选了生态的，那些生态里的河（湖）都是这一种。普通河、普通湖那一行在生态上（species.ts 的 plainRiver、plainLake）
    biomes: z.array(z.string().min(1)).max(256).optional(),
    // 声明式条件（第五十六轮）：高度、坡度、气温、流量，河按每格看，湖按整个湖（平均，流量取最大）。不写脚本
    when: waterWhenSchema.optional(),
  };
}

// 两种都有的几项（编辑器、岸边、效果、起名用）
export interface WaterType {
  id: string;
  name: string;
  color: string;
  atlasColor?: string;
  style?: string;
  bank?: { radiusKm: number; dT?: number; dP?: number };
  names?: { p: string; w?: number }[];
  scripts?: { match?: { api: 1; src: string } } & Record<string, unknown>;
  seedKey?: string;
  natural?: boolean;
  biomes?: string[];
  when?: WaterWhen;
}

// 会不会按规则自己出现：没关掉自然生成，并且有规则（match 脚本、声明式条件）或选了“只在这些生态里”。
// 只选了生态、没写别的时，那些生态里的河（湖）都是这一种
export function matchesNaturally(t: Pick<WaterType, 'natural' | 'scripts' | 'biomes' | 'when'>): boolean {
  return t.natural !== false && (!!t.scripts?.match?.src || t.biomes !== undefined || hasWhen(t));
}

// 有没有按一格（一个湖）看的条件：选了生态或写了声明式条件。只有脚本的类型是整条河一种
export const perCellRule = (t: Pick<WaterType, 'biomes' | 'when'>): boolean => t.biomes !== undefined || hasWhen(t);

// 河、湖的类型要不要读生态（有类型按生态限制，或规则里用了生态的辅助函数）
export function needsBaseBiomes(types: readonly WaterType[]): boolean {
  return types.some((t) => t.biomes !== undefined || (matchesNaturally(t) && !!t.scripts?.match?.src && usesBiomeHelpers(t.scripts.match.src)));
}

// ---------- 一遍水文之后要做什么（第五十六轮，engine.ts 的 pass） ----------

// 生态上和水系有关的几项（species.ts）
export interface WaterSpecies {
  id: string;
  plainRiver?: boolean;
  plainLake?: boolean;
  waterBlock?: 'swap' | 'stop';
  tolerances: readonly { field: string }[];
  scripts?: { placement?: { src: string } };
}

// 生态读不读河岸、湖岸（条件里的 river:<id>、lake:<id>，“长在哪里”脚本里的 river()、hasRiver()、nearLake()、hasLake()）。
// 读的话生态要等河湖的类型定了才算得出来；不读的话植被和河湖的类型无关（颜色脚本不决定长什么，不算）
const BANK_NAME = /(?<![\p{ID_Continue}$.])(river|hasRiver|nearLake|hasLake)(?![\p{ID_Continue}$])/u;
function readsBanks(sp: WaterSpecies): boolean {
  const src = sp.scripts?.placement?.src;
  return sp.tolerances.some((t) => t.field.startsWith('river:') || t.field.startsWith('lake:')) || (!!src && BANK_NAME.test(codeOnly(src)));
}

export interface WaterPlan {
  // 河、湖的类型要读生态（否则类型照旧在植被之前定，读不到生态）
  biomes: boolean;
  // 生态读河岸、湖岸：只有这时才要先多算一遍不计水体类型的植被（baseBiomes）。别的世界里那一遍和真的植被逐值相同，算一遍就够
  baseFirst: boolean;
  // 有生态会让河断流（不允许普通河、设成“断流”）：水文要多算一遍
  stops: boolean;
}

// 测试用：baseFirst 为 true 时照第五十六轮以前的走法（读生态的世界总是先多算一遍），和提速后的结果对照
export const waterPlanDebug = { baseFirst: false };

export function waterPlan(small: { species: readonly WaterSpecies[]; riverTypes?: readonly WaterType[]; lakeTypes?: readonly WaterType[] }): WaterPlan {
  const rivers = small.riverTypes ?? [];
  const lakes = small.lakeTypes ?? [];
  const species = small.species;
  const stops = species.some((s) => s.waterBlock === 'stop' && s.plainRiver === false);
  const plain = (rivers.length > 0 && species.some((s) => s.plainRiver === false)) || (lakes.length > 0 && species.some((s) => s.plainLake === false));
  const biomes = stops || plain || needsBaseBiomes(rivers) || needsBaseBiomes(lakes);
  return { biomes, baseFirst: biomes && (waterPlanDebug.baseFirst || species.some(readsBanks)), stops };
}

// ---------- 允许表（第五十六轮） ----------
// 表的一格只存一份：普通河、普通湖那一行在生态上（plainRiver、plainLake，省略为允许），别的行在这种水上（biomes，省略为全部）。
// 读写都走 water-table.ts

export interface WaterRules {
  S: number;
  // 这种水有没有列生态、第 k 种能不能在第 s 种生态里（k × S + s）
  listed: Uint8Array;
  allow: Uint8Array;
  // 这种生态允许普通的河（湖）吗
  plainOK: Uint8Array;
  // 这种生态不允许时断流（只有河）
  stop: Uint8Array;
  // 不允许时换成哪一种：这一列从上往下第一种允许、自然生成的；没有为 −1
  fallback: Int16Array;
  // 按一格看的条件：第 k 种的条件（没有为 null）
  bounds: (Float64Array | null)[];
  // 有哪一种生态不允许普通的河（湖），或哪一种水列了生态
  restricted: boolean;
}

// 这一种水系的规则。没有规则（没有哪一种列了生态、写了条件，也没有哪种生态不允许普通的）时为 null：走第五十六轮以前的算法，逐值不变
export function waterRules(species: readonly WaterSpecies[], types: readonly WaterType[], plainKey: 'plainRiver' | 'plainLake'): WaterRules | null {
  const plainOff = species.some((s) => s[plainKey] === false);
  if (!plainOff && !types.some((t) => t.biomes !== undefined || (t.natural !== false && hasWhen(t)))) return null;
  const S = species.length;
  const T = types.length;
  const listed = new Uint8Array(T);
  const allow = new Uint8Array(T * S).fill(1);
  const index = new Map(species.map((s, q) => [s.id, q]));
  types.forEach((t, k) => {
    if (!t.biomes) return;
    listed[k] = 1;
    allow.fill(0, k * S, (k + 1) * S);
    for (const id of t.biomes) {
      const q = index.get(id);
      if (q !== undefined) allow[k * S + q] = 1;
    }
  });
  const plainOK = new Uint8Array(S);
  const stop = new Uint8Array(S);
  const fallback = new Int16Array(S).fill(-1);
  species.forEach((sp, q) => {
    plainOK[q] = sp[plainKey] === false ? 0 : 1;
    stop[q] = sp.waterBlock === 'stop' ? 1 : 0;
    for (let k = 0; k < T && fallback[q] < 0; k++) if (types[k].natural !== false && allow[k * S + q]) fallback[q] = k;
  });
  return {
    S,
    listed,
    allow,
    plainOK,
    stop,
    fallback,
    bounds: types.map((t) => (hasWhen(t) ? whenBounds(t.when!) : null)),
    restricted: plainOff || listed.some((v) => v === 1),
  };
}

// 一串格里属于 biomes（生态下标的集合）的比例至少一半。base：每格的生态下标（不长植被的格为 −1，不算进分母）
export function inBiomes(base: Int16Array, cells: ArrayLike<number>, set: ReadonlySet<number>): boolean {
  let total = 0;
  let hit = 0;
  for (let k = 0; k < cells.length; k++) {
    const b = base[cells[k]];
    if (b < 0) continue;
    total++;
    if (set.has(b)) hit++;
  }
  return total > 0 && hit * 2 >= total;
}

// 生态 id 换成下标的集合（找不到的不算）
export function biomeSet(species: readonly { id: string }[], ids: readonly string[] | undefined): Set<number> {
  const out = new Set<number>();
  for (const id of ids ?? []) {
    const k = species.findIndex((s) => s.id === id);
    if (k >= 0) out.add(k);
  }
  return out;
}

// 给 match 脚本的生态（biome、dominantBiome……）：groups[j] 是第 j 条河（第 j 个湖）用来统计的格，key[j] 是脚本按哪一格算（源头、第一格）。
// source / mouth：河的源头、河口那一格（湖没有）
export function biomeInputsFor(
  species: readonly { id: string }[],
  base: Int16Array,
  n: number,
  groups: readonly ArrayLike<number>[],
  key: ArrayLike<number>,
  ends?: { source: ArrayLike<number>; mouth: ArrayLike<number> },
): BiomeInputs {
  const S = species.length;
  const counts: Int32Array[] = groups.map((cells) => {
    const c = new Int32Array(S + 1);
    for (let q = 0; q < cells.length; q++) {
      const b = base[cells[q]];
      if (b >= 0) {
        c[b]++;
        c[S]++;
      }
    }
    return c;
  });
  const at = new Map<number, number>();
  for (let j = 0; j < key.length; j++) if (!at.has(key[j])) at.set(key[j], j);
  const idOf = (b: number) => (b >= 0 && b < S ? species[b].id : '');
  return {
    share(id) {
      const out = new Float64Array(n);
      const s = species.findIndex((x) => x.id === id);
      if (s < 0) return out;
      groups.forEach((_, j) => {
        const c = counts[j];
        out[key[j]] = c[S] ? c[s] / c[S] : 0;
      });
      return out;
    },
    dominant(cell) {
      const j = at.get(cell);
      if (j === undefined) return '';
      const c = counts[j];
      let best = -1;
      for (let s = 0; s < S; s++) if (c[s] > 0 && (best < 0 || c[s] > c[best])) best = s;
      return idOf(best);
    },
    ...(ends
      ? {
          atSource: (cell: number) => {
            const j = at.get(cell);
            return j === undefined ? '' : idOf(base[ends.source[j]]);
          },
          atMouth: (cell: number) => {
            const j = at.get(cell);
            return j === undefined ? '' : idOf(base[ends.mouth[j]]);
          },
        }
      : {}),
  };
}

// 类型显示用的名字（出错说明、看门狗提示）
export const waterTypeOwner = (t: Pick<WaterType, 'name' | 'id'>) => t.name || t.id;

// 添加、修改时检查脚本：只能有 match，语法要对（错了整条命令不生效，并说明第几行错了）
export function checkMatchScripts(t: WaterType, what: string, noun: string, scope: 'river' | 'lake' = 'river'): void {
  const box = t.scripts;
  if (!box) return;
  for (const [kind, s] of Object.entries(box)) {
    if (!s) continue;
    if (kind !== 'match') throw new CommandError(`${what}“${waterTypeOwner(t)}”只能有“哪些${noun}是这一种”的脚本`);
    compileScript('match', (s as { src: string }).src, waterTypeOwner(t), scope);
  }
}

// 改一种类型要从哪一层重算（按真的改了哪几项，不看命令里写了什么）：
//   · 只改样子（lookKeys：颜色、地图集颜色、画法、粗细）：推导什么都不变，只重画（Worker 发轻快照）；
//   · 只改名字、起名模板：只重新起名（带脚本的类型改名除外：脚本出错的说明里有它的名字，要与重放一致）；
//   · 别的（脚本、岸边的影响、种子）：从水文起重算
const NAME_KEYS = new Set(['name', 'names']);
export function waterTypeDirty(before: WaterType | undefined, after: WaterType | undefined, lookKeys: ReadonlySet<string>): 'none' | 'names' | 'vegetation' {
  if (!before || !after) return 'vegetation';
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (changed.every((k) => lookKeys.has(k))) return 'none';
  if (changed.includes('name') && (before.scripts?.match || after.scripts?.match)) return 'vegetation';
  if (changed.every((k) => lookKeys.has(k) || NAME_KEYS.has(k))) return 'names';
  return 'vegetation';
}

// ---------- 岸边：离这种水多近 ----------

// 岸边的范围（km）：给了 bank 用它，否则取 max(100 km, 两格半)
export function bankRadiusKm(world: World, t: Pick<WaterType, 'bank'>): number {
  return t.bank?.radiusKm ?? Math.max(100, 2.5 * world.mesh.spacing * world.kmPerUnit);
}

const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// 按内容缓存（每格的类型数组是原地改的，不能按数组对象做键）：键是这种水的格、范围；按网格各留最近用过的几份。
// 返回的数组是缓存本身，只读
interface BankMemo {
  mask: Uint8Array;
  radius: number;
  value: Float32Array;
}
const bankMemo = new WeakMap<Mesh, BankMemo[]>();
const MAX_BANKS = 8;

function sameMask(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 离 perCell 里值为 v 的格多近：1 − smoothstep(0, R, 格图距离)，那些格上为 1，R 以外为 0。
// 一格都没有时为 undefined（脚本里 river() 为 0、hasRiver() 为 false）
export function bankField(world: World, perCell: Uint8Array | undefined, v: number, radiusKm: number): Float32Array | undefined {
  if (!perCell) return undefined;
  const { mesh } = world;
  const n = mesh.n;
  const mask = new Uint8Array(n);
  const seeds: number[] = [];
  for (let i = 0; i < n; i++) {
    if (perCell[i] === v) {
      mask[i] = 1;
      seeds.push(i);
    }
  }
  if (!seeds.length) return undefined;
  const radius = radiusKm / world.kmPerUnit;
  const list = bankMemo.get(mesh) ?? [];
  const hit = list.find((m) => m.radius === radius && sameMask(m.mask, mask));
  if (hit) {
    bankMemo.set(mesh, [hit, ...list.filter((m) => m !== hit)]);
    return hit.value;
  }
  const dist = graphDistance(mesh, seeds, radius);
  const value = new Float32Array(n);
  for (let i = 0; i < n; i++) value[i] = dist[i] <= radius ? 1 - smooth01(dist[i] / radius) : 0;
  bankMemo.set(mesh, [{ mask, radius, value }, ...list].slice(0, MAX_BANKS));
  return value;
}

// 一串格里多数是哪一种（超过一半的格是同一种时为它的下标，否则 −1）
export function majorityOf(perCell: Uint8Array | undefined, cells: ArrayLike<number>): number {
  if (!perCell || !cells.length) return -1;
  const count = new Map<number, number>();
  for (let k = 0; k < cells.length; k++) {
    const v = perCell[cells[k]];
    if (v) count.set(v, (count.get(v) ?? 0) + 1);
  }
  for (const [v, c] of count) if (c * 2 > cells.length) return v - 1;
  return -1;
}
