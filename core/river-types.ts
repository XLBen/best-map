import { z } from 'zod';
import { LAKE_PREFIX, lakeBank } from './lake-types';
import { joinsRiver } from './rivers';
import { type InputValue, type ScriptInputs, type ScriptIssue, runScript, scriptsEnabled, worldInputs } from './script';
import { PLAIN_TYPE, bankField, bankRadiusKm, checkMatchScripts, majorityOf, waterTypeDirty, waterTypeOwner, waterTypeShape } from './water-types';
import type { Derived, Guide, SmallState, World } from './world';

// 河流类型（第三批）：血河、晶川、冥河……每种有自己的颜色、画法、两岸的影响、起名模板，
// 以及“哪些自然的河是这一种”的脚本（match）。
//
// 每格是哪一种河（d.riverType：0 普通，k + 1 是第 k 种）按这几步定：
//   1. 带类型的河道（画的河、固定下来的河）先定下它自己的河格（后画的说了算；汇入别的河的那一格是那条河的，不算）；
//   2. 每种类型的 match 脚本每条河只算一次：一条河是从源头顺着“最大的上游”一直往下、到汇入更大的河（或入海、入湖）为止的那一段，
//      脚本读的变量是整条河的汇总（气候、海拔、坡度取平均，流量取最大，位置取源头），所以一条河不会一段红一段蓝；
//      有一格已经由河道定下类型（或者是选了“普通的河”的河道）的河不再匹配；
//   3. 往下游传：还没有类型的河格，它最大的上游有类型、并且那条上游的水不少于这一格的一半时，跟着上游。
//      所以带类型的河流进更大的河就停了。
// 没有河流类型的世界里根本没有 riverType 这个键（旧存档的推导逐值不变）

// 画法
export const RIVER_STYLES = ['solid', 'dashed', 'double', 'glow'] as const;
export type RiverStyle = (typeof RIVER_STYLES)[number];
export const RIVER_STYLE_LABEL: Record<RiverStyle, string> = { solid: '实线', dashed: '虚线', double: '双线', glow: '发光' };

// 选了“普通的河”的河道（type 写成这个）：不按 match 脚本变成别的类型，带类型的河也不往它里面传。
// 所以这个 id 不能用作河流类型的 id（与湖的“普通的湖”是同一个，见 water-types.ts）
export const PLAIN_RIVER = PLAIN_TYPE;

// 一个世界里最多这么多种（每格的类型存成一个字节）
export const MAX_RIVER_TYPES = 64;

// 格式：与湖泊类型共有的几项（water-types.ts），再加粗细、画法
export const riverTypeSchema = z.object({
  ...waterTypeShape('河流类型', '河'),
  // 粗细倍数（只影响画法）
  width: z.number().min(0.3).max(3).optional(),
  style: z.enum(RIVER_STYLES).optional(),
});
export type RiverType = z.output<typeof riverTypeSchema>;
export type RiverTypeInput = z.input<typeof riverTypeSchema>;

export const riverTypesOf = (small: Pick<SmallState, 'riverTypes'>): readonly RiverType[] => small.riverTypes ?? [];

// 类型显示用的名字（出错说明、看门狗提示）
export const riverTypeOwner = (t: RiverType) => waterTypeOwner(t);

// 添加、修改时检查脚本：只能有 match，语法要对（错了整条命令不生效，并说明第几行错了）
export const checkRiverTypeScripts = (t: RiverType): void => checkMatchScripts(t, '河流类型', '河');

// 改一种河流类型要从哪一层重算（见 water-types.ts 的 waterTypeDirty）：颜色、地图集颜色、画法、粗细只重画
const LOOK_KEYS = new Set(['color', 'atlasColor', 'style', 'width']);
export const riverTypeDirty = (before: RiverType | undefined, after: RiverType | undefined) => waterTypeDirty(before, after, LOOK_KEYS);

// ---------- 每格是哪一种河 ----------

const isRiverAt = (world: World, d: Derived, i: number) => world.causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= world.small.planet.riverThreshold;

// 河网：每格最大的上游（下游是它、也是河格；流量相同取编号小的），以及一条条河（源头到汇入更大的河、入海、入湖为止）。
// 每个河格正好在一条河上：从它顺着“最大的上游”往上走，到的是唯一一个源头
export interface RiverNet {
  isRiver: Uint8Array;
  mainDonor: Int32Array;
  // 每条河的格（从源头往下）
  stems: Int32Array[];
}

export function riverNet(world: World, d: Derived): RiverNet {
  const n = world.mesh.n;
  const isRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (isRiverAt(world, d, i)) isRiver[i] = 1;
  const mainDonor = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    if (!isRiver[j]) continue;
    const r = d.receiver[j];
    if (r < 0 || !isRiver[r]) continue;
    const m = mainDonor[r];
    if (m < 0 || d.discharge[j] > d.discharge[m] || (d.discharge[j] === d.discharge[m] && j < m)) mainDonor[r] = j;
  }
  const stems: Int32Array[] = [];
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (!isRiver[s] || mainDonor[s] >= 0) continue;
    const cells: number[] = [];
    for (let c = s, guard = 0; guard < n && !seen[c]; guard++) {
      cells.push(c);
      seen[c] = 1;
      const r = d.receiver[c];
      if (r < 0 || !isRiver[r] || mainDonor[r] !== c) break;
      c = r;
    }
    stems.push(Int32Array.from(cells));
  }
  return { isRiver, mainDonor, stems };
}

// 一条带类型（或选了普通的河）的河道定下的格：河道上的河格，汇入别的河的最后一格不算（那是那条河的）
function guideCells(world: World, d: Derived, g: Guide, isRiver: Uint8Array): number[] {
  const cells = g.end !== 'sink' && joinsRiver(world, d, g) ? g.cells.slice(0, -1) : g.cells;
  return cells.filter((c) => c < isRiver.length && isRiver[c] === 1);
}

// 统计（测试用）：match 脚本一共算了多少条河
export const matchRunStats = { rivers: 0 };

// 每条河一次的 match：变量取整条河的汇总。位置（x、y、经纬度、格的编号……）取源头那一格；
// 流量、汇水取最大（河口那里）；其余取平均。另有只给 match 用的河长、源头海拔
const AT_SOURCE = new Set(['x', 'y', 'lat', 'lon', 'px', 'py', 'pz', 'cell', 'areaKm2']);
const MAXED = new Set(['discharge', 'drainArea']);

function stemInputs(world: World, d: Derived, stems: readonly Int32Array[]): ScriptInputs {
  const base = worldInputs(world, d);
  const n = world.mesh.n;
  const km = world.kmPerUnit;
  const made = new Map<string, InputValue>();
  // 每条河在它的源头那一格放一个数（脚本按源头那一格算）
  const perStem = (f: (cells: Int32Array) => number): Float64Array => {
    const out = new Float64Array(n);
    for (const cells of stems) out[cells[0]] = f(cells);
    return out;
  };
  const aggregate = (src: ArrayLike<number>, max: boolean) =>
    perStem((cells) => {
      let s = max ? -Infinity : 0;
      for (let k = 0; k < cells.length; k++) {
        const v = src[cells[k]];
        if (max) s = v > s ? v : s;
        else s += v;
      }
      return max ? s : s / cells.length;
    });
  const get = (key: string): InputValue | undefined => {
    let v = made.get(key);
    if (v !== undefined) return v;
    if (key === 'riverLength') {
      const { mesh } = world;
      v = perStem((cells) => {
        let len = 0;
        for (let k = 0; k + 1 < cells.length; k++) {
          const a = cells[k];
          const b = cells[k + 1];
          for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) {
            if (mesh.adj[e] === b) {
              len += mesh.dist[e];
              break;
            }
          }
        }
        return (len + mesh.spacing) * km;
      });
    } else if (key === 'sourceElevation') {
      v = perStem((cells) => Math.max(0, d.elevation[cells[0]]));
    } else {
      const b = base.get(key);
      if (b === undefined || typeof b !== 'object' || AT_SOURCE.has(key)) return b;
      v = aggregate(b as ArrayLike<number>, MAXED.has(key));
    }
    made.set(key, v);
    return v;
  };
  return {
    n,
    globe: base.globe,
    get,
    // 自定义场也取整条河的平均
    field: (name) => {
      const k = `field:${name}`;
      let v = made.get(k) as Float64Array | undefined;
      if (!v) {
        const b = base.field?.(name);
        if (!b) return undefined;
        made.set(k, (v = aggregate(b, false)));
      }
      return v;
    },
  };
}

// 每格是哪一种河：写进 d.riverType。没有河流类型时为 undefined（从来没有过的世界里没有这个键）。
// 返回 match 脚本出的问题（出错的那段这一次按“不匹配”处理，不挡操作）
export function typeRivers(world: World, d: Derived, seed: number): ScriptIssue[] {
  const types = riverTypesOf(world.small);
  if (!types.length) {
    if (d.riverType !== undefined) d.riverType = undefined;
    return [];
  }
  const n = world.mesh.n;
  const rt = d.riverType?.length === n ? d.riverType : new Uint8Array(n);
  rt.fill(0);
  const index = new Map(types.map((t, k) => [t.id, k]));
  const net = riverNet(world, d);
  const { isRiver, mainDonor, stems } = net;
  // 由河道定下的格（带类型的、选了普通的河的）：不再匹配，也不往里传
  const claimed = new Uint8Array(n);
  for (const g of world.small.guides) {
    if (g.type === undefined) continue;
    const k = g.type === PLAIN_RIVER ? -1 : index.get(g.type);
    // 类型已经删掉了的：当作没选
    if (k === undefined) continue;
    for (const c of guideCells(world, d, g, isRiver)) {
      rt[c] = k + 1;
      claimed[c] = 1;
    }
  }
  // 每条河一次的 match（按类型的先后，先匹配上的算）。安全模式（脚本不运行）下与生态的脚本一样整个跳过：按不匹配，不记问题
  const issues: ScriptIssue[] = [];
  let open = scriptsEnabled() ? stems.filter((cells) => cells.every((c) => !claimed[c])) : [];
  let inputs: ScriptInputs | null = null;
  types.forEach((t, k) => {
    const src = t.scripts?.match?.src;
    if (!src || !open.length) return;
    inputs ??= stemInputs(world, d, open);
    const sources = Int32Array.from(open, (cells) => cells[0]);
    matchRunStats.rivers += sources.length;
    const r = runScript({ kind: 'match', src }, { owner: riverTypeOwner(t), id: t.id, seedKey: t.seedKey, seed, inputs, cells: sources });
    if (!r.ok) {
      issues.push(r.issue);
      return;
    }
    const match = r.output.match;
    const rest: Int32Array[] = [];
    open.forEach((cells, j) => {
      if (match[j]) for (let q = 0; q < cells.length; q++) rt[cells[q]] = k + 1;
      else rest.push(cells);
    });
    open = rest;
  });
  // 往下游传（同一条河上：一格最大的上游就是这条河上的前一格）
  for (const cells of stems) {
    for (let q = 1; q < cells.length; q++) {
      const c = cells[q];
      if (rt[c] !== 0 || claimed[c]) continue;
      const m = mainDonor[c];
      if (m >= 0 && rt[m] !== 0 && d.discharge[m] >= 0.5 * d.discharge[c]) rt[c] = rt[m];
    }
  }
  d.riverType = rt;
  return issues;
}

// ---------- 两岸：河岸场 river:<id> ----------

export { bankRadiusKm };

// 离第 k 种河多近：1 − smoothstep(0, R, 到这种河的格图距离)，河上为 1，R 以外为 0（见 water-types.ts 的 bankField）。
// 这种河一格都没有（或者没有这种类型）时为 undefined：脚本里 river() 为 0、hasRiver() 为 false
export function riverBank(world: World, d: Derived, typeId: string): Float32Array | undefined {
  const types = riverTypesOf(world.small);
  const k = types.findIndex((t) => t.id === typeId);
  if (k < 0) return undefined;
  return bankField(world, d.riverType, k + 1, bankRadiusKm(world, types[k]));
}

// 引擎给脚本的 river(typeId) / hasRiver(typeId)；湖岸（nearLake、hasLake）借同一条路，写成 'lake:类型'（见 lake-types.ts）
export const riverProvider = (world: World, d: Derived) => (typeId: string) =>
  typeId.startsWith(LAKE_PREFIX) ? lakeBank(world, d, typeId.slice(LAKE_PREFIX.length)) : riverBank(world, d, typeId);

// 一串格里多数是哪一种河（超过一半的格是同一种时为它的下标，否则 −1）
export const majorityType = (d: Derived, cells: ArrayLike<number>): number => majorityOf(d.riverType, cells);
