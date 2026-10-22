import { z } from 'zod';
import { CommandError } from './errors';
import { type Mesh, graphDistance } from './mesh';
// 只在 z.lazy 里读 scriptsSchema：script.ts 经 world.ts 又引用别的模块，顶层直接读会碰上“初始化之前不能访问”
import { compileScript, scriptsSchema } from './script';
import { typeIdSchema } from './type-id';
import type { World } from './world';

// 水体类型（河流类型、湖泊类型）共用的部分：格式里相同的几项、只能有 match 的脚本、改了哪几项要从哪一层重算、
// 岸边的远近（river:<id>、lake:<id>，0–1）。河的见 river-types.ts，湖的见 lake-types.ts

// 选了“普通的”的河道、湖（type 写成这个）：不按 match 脚本变成别的类型。所以这个 id 不能用作类型的 id
export const PLAIN_TYPE = 'plain';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #rrggbb');

// 两种共有的几项。what：出错说明里的叫法（“河流类型”“湖泊类型”）；kind：match 脚本说明里的“哪些河 / 哪些湖”
export function waterTypeShape(what: string, noun: string) {
  return {
    id: typeIdSchema.refine((id) => id !== PLAIN_TYPE, `“${PLAIN_TYPE}”是留给“普通的${noun}”的，换一个 id`),
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
}

// 类型显示用的名字（出错说明、看门狗提示）
export const waterTypeOwner = (t: Pick<WaterType, 'name' | 'id'>) => t.name || t.id;

// 添加、修改时检查脚本：只能有 match，语法要对（错了整条命令不生效，并说明第几行错了）
export function checkMatchScripts(t: WaterType, what: string, noun: string): void {
  const box = t.scripts;
  if (!box) return;
  for (const [kind, s] of Object.entries(box)) {
    if (!s) continue;
    if (kind !== 'match') throw new CommandError(`${what}「${waterTypeOwner(t)}」只能有“哪些${noun}是这一种”的脚本`);
    compileScript('match', (s as { src: string }).src, waterTypeOwner(t));
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
