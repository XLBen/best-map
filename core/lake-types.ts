import { z } from 'zod';
import { type InputValue, type ScriptInputs, type ScriptIssue, runScript, scriptsEnabled, worldInputs } from './script';
import { PLAIN_TYPE, bankField, bankRadiusKm, biomeInputsFor, biomeSet, checkMatchScripts, inBiomes, majorityOf, matchesNaturally, waterTypeDirty, waterTypeOwner, waterTypeShape } from './water-types';
import type { Derived, SmallState, World } from './world';

// 湖泊类型（第九轮）：血池、晶湖、冥湖、熔岩湖……与河流类型同一套：颜色、画法、岸边的影响、起名模板、
// “哪些自然的湖是这一种”的脚本（match）。
//
// 一个湖是一片连着的湖面加上干涸的湖底（d.lake 为 1 或 2 的格连成的一片）。每个湖是哪一种按这几步定：
//   1. 自然的湖自己选的（small.lakeTyping：这一格所在的湖就是这一种，后面的说了算）；
//   2. 放的湖自己选的（lake.type；放的湖所在的那一片都按它，比第 1 步优先）；
//   3. 剩下的湖每种类型的 match 脚本每个湖只算一次（变量是整个湖的汇总：气候、海拔取平均，流量取最大，
//      另有湖的面积、流进来的水、是不是干湖、是不是放的湖），按类型的先后，先匹配上的算。
// 选了“普通的湖”（'plain'）的湖不再匹配。没有湖泊类型的世界里根本没有 lakeType 这个键（推导逐值照旧）

// 画法：实色、发光（湖面亮一些，湖岸一圈光晕）、干湖底（像盐壳一样不透明）
export const LAKE_STYLES = ['solid', 'glow', 'playa'] as const;
export type LakeStyle = (typeof LAKE_STYLES)[number];
export const LAKE_STYLE_LABEL: Record<LakeStyle, string> = { solid: '实色', glow: '发光', playa: '干湖底' };

export const PLAIN_LAKE = PLAIN_TYPE;
export const MAX_LAKE_TYPES = 64;
// 湖岸场的写法：生态的条件里 lake:<id>；脚本里的 nearLake('id') 经 river 那条路取，键是 'lake:id'
export const LAKE_PREFIX = 'lake:';

export const lakeTypeSchema = z.object({
  ...waterTypeShape('湖泊类型', '湖'),
  style: z.enum(LAKE_STYLES).optional(),
});
export type LakeType = z.output<typeof lakeTypeSchema>;
export type LakeTypeInput = z.input<typeof lakeTypeSchema>;

export const lakeTypesOf = (small: Pick<SmallState, 'lakeTypes'>): readonly LakeType[] => small.lakeTypes ?? [];
const lakeTypeOwner = (t: LakeType) => waterTypeOwner(t);
export const checkLakeTypeScripts = (t: LakeType): void => checkMatchScripts(t, '湖泊类型', '湖', 'lake');

// 颜色、地图集颜色、画法只重画
const LOOK_KEYS = new Set(['color', 'atlasColor', 'style']);
export const lakeTypeDirty = (before: LakeType | undefined, after: LakeType | undefined) => waterTypeDirty(before, after, LOOK_KEYS);

// ---------- 一个个湖 ----------

export interface LakeParts {
  // 每个湖的格（从编号最小的那格起按广度）
  lakes: Int32Array[];
  // 每格在第几个湖里（不是湖为 −1）
  of: Int32Array;
}

// 湖面与干涸的湖底连成的一片片（只算陆地上的）
export function lakeParts(world: World, d: Pick<Derived, 'lake'>): LakeParts {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const of = new Int32Array(n).fill(-1);
  const lakes: Int32Array[] = [];
  const q: number[] = [];
  for (let i = 0; i < n; i++) {
    if (of[i] >= 0 || !d.lake[i] || !land[i]) continue;
    const id = lakes.length;
    q.length = 0;
    q.push(i);
    of[i] = id;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (of[j] < 0 && d.lake[j] && land[j]) {
          of[j] = id;
          q.push(j);
        }
      }
    }
    lakes.push(Int32Array.from(q));
  }
  return { lakes, of };
}

// 统计（测试用）：match 脚本一共算了多少个湖
export const matchRunStats = { lakes: 0 };

// 每个湖一次的 match：位置取湖里编号最小的那格（x、y、经纬度、格的编号、这一格的面积），流量、汇水取最大，其余取平均；
// 另有只给湖的：面积（含干涸的湖底）、流进来的水、是不是干湖、是不是放的湖、是不是常年有水
const AT_FIRST = new Set(['x', 'y', 'lat', 'lon', 'px', 'py', 'pz', 'cell', 'areaKm2']);
const MAXED = new Set(['discharge', 'drainArea']);

// 湖岸：一个湖周围一圈不是这个湖的陆地格（第十二轮：按生态限制、脚本里的 biome() 用它）
export function lakeShores(world: World, parts: LakeParts): Int32Array[] {
  const { mesh } = world;
  const land = world.causes.land;
  return parts.lakes.map((cells, k) => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (parts.of[j] !== k && land[j] === 1 && !seen.has(j)) {
          seen.add(j);
          out.push(j);
        }
      }
    }
    return Int32Array.from(out.sort((a, b) => a - b));
  });
}

function lakeInputs(world: World, d: Derived, parts: LakeParts, open: readonly number[], biomes: { base: Int16Array; shores: Int32Array[] } | null): ScriptInputs {
  const base = worldInputs(world, d);
  const { mesh } = world;
  const n = mesh.n;
  const km2 = world.kmPerUnit * world.kmPerUnit;
  const made = new Map<string, InputValue>();
  const perLake = (f: (cells: Int32Array, k: number) => number): Float64Array => {
    const out = new Float64Array(n);
    for (const k of open) out[parts.lakes[k][0]] = f(parts.lakes[k], k);
    return out;
  };
  const aggregate = (src: ArrayLike<number>, max: boolean) =>
    perLake((cells) => {
      let s = max ? -Infinity : 0;
      for (let q = 0; q < cells.length; q++) {
        const v = src[cells[q]];
        if (max) s = v > s ? v : s;
        else s += v;
      }
      return max ? s : s / cells.length;
    });
  const placed = (k: number, perennialOnly: boolean) =>
    world.small.lakes.some((l) => parts.of[l.cell] === k && (!perennialOnly || l.perennial)) ? 1 : 0;
  const get = (key: string): InputValue | undefined => {
    let v = made.get(key);
    if (v !== undefined) return v;
    if (key === 'lakeArea') {
      v = perLake((cells) => {
        let a = 0;
        for (let q = 0; q < cells.length; q++) a += mesh.area[cells[q]];
        return a * km2;
      });
    } else if (key === 'inflow') {
      // 流进这个湖的水：湖外的格流进湖里的流量加起来
      v = perLake((cells, k) => {
        let s = 0;
        for (let q = 0; q < cells.length; q++) {
          const c = cells[q];
          for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
            const j = mesh.adj[e];
            if (parts.of[j] !== k && d.receiver[j] === c) s += d.discharge[j];
          }
        }
        return s;
      });
    } else if (key === 'dryLake') {
      v = perLake((cells) => (Array.prototype.some.call(cells, (c: number) => d.lake[c] === 1) ? 0 : 1));
    } else if (key === 'placedLake') {
      v = perLake((_, k) => placed(k, false));
    } else if (key === 'perennial') {
      v = perLake((_, k) => placed(k, true));
    } else {
      const b = base.get(key);
      if (b === undefined || typeof b !== 'object' || AT_FIRST.has(key)) return b;
      v = aggregate(b as ArrayLike<number>, MAXED.has(key));
    }
    made.set(key, v);
    return v;
  };
  return {
    n,
    globe: base.globe,
    get,
    // 生态（第十二轮）：湖岸一圈
    biomes: biomes
      ? biomeInputsFor(
          world.small.species,
          biomes.base,
          n,
          open.map((k) => biomes.shores[k]),
          Int32Array.from(open, (k) => parts.lakes[k][0]),
        )
      : undefined,
    field: (name) => {
      const key = `field:${name}`;
      let v = made.get(key) as Float64Array | undefined;
      if (!v) {
        const b = base.field?.(name);
        if (!b) return undefined;
        made.set(key, (v = aggregate(b, false)));
      }
      return v;
    },
  };
}

// 每格是哪一种湖：写进 d.lakeType。没有湖泊类型时为 undefined（从来没有过的世界里没有这个键）。
// 返回 match 脚本出的问题（出错的那种这一次按“不匹配”处理，不挡操作）。
// biomes：不计水体类型的一遍植被的主导生态（第十二轮，见 vegetation.ts 的 baseBiomes），用不到时为 null
export function typeLakes(world: World, d: Derived, seed: number, biomes: Int16Array | null = null): ScriptIssue[] {
  const types = lakeTypesOf(world.small);
  if (!types.length) {
    if (d.lakeType !== undefined) d.lakeType = undefined;
    return [];
  }
  const n = world.mesh.n;
  const lt = d.lakeType?.length === n ? d.lakeType : new Uint8Array(n);
  lt.fill(0);
  const index = new Map(types.map((t, k) => [t.id, k]));
  const parts = lakeParts(world, d);
  // 每个湖：−2 还没定，−1 普通的湖，k 第 k 种
  const chosen = new Int32Array(parts.lakes.length).fill(-2);
  const choose = (cell: number, type: string) => {
    const at = cell < n ? parts.of[cell] : -1;
    if (at < 0) return;
    const k = type === PLAIN_LAKE ? -1 : index.get(type);
    // 类型已经删掉了的：当作没选
    if (k !== undefined) chosen[at] = k;
  };
  for (const e of world.small.lakeTyping ?? []) choose(e.cell, e.type);
  for (const l of world.small.lakes) if (l.type !== undefined) choose(l.cell, l.type);
  // 每个湖一次的 match（按类型的先后，先匹配上的算）。安全模式下带脚本的类型跳过：按不匹配，不记问题。
  // 第十二轮：关掉了自然生成的类型不匹配；选了“只在这些生态里”的，湖岸一圈至少一半是那几种生态才算
  const issues: ScriptIssue[] = [];
  const scriptsOn = scriptsEnabled();
  let open: number[] = [];
  for (let k = 0; k < chosen.length; k++) if (chosen[k] === -2) open.push(k);
  let inputs: ScriptInputs | null = null;
  let shores: Int32Array[] | null = null;
  const shoresOf = () => (shores ??= lakeShores(world, parts));
  types.forEach((t, k) => {
    if (!matchesNaturally(t) || !open.length) return;
    const src = t.scripts?.match?.src;
    if (src && !scriptsOn) return;
    let match: ArrayLike<number> | null = null;
    if (src) {
      inputs ??= lakeInputs(world, d, parts, open, biomes ? { base: biomes, shores: shoresOf() } : null);
      const firsts = Int32Array.from(open, (j) => parts.lakes[j][0]);
      matchRunStats.lakes += firsts.length;
      const r = runScript({ kind: 'match', src, scope: 'lake' }, { owner: lakeTypeOwner(t), id: t.id, seedKey: t.seedKey, seed, inputs, cells: firsts });
      if (!r.ok) {
        issues.push(r.issue);
        return;
      }
      match = r.output.match;
    }
    const set = t.biomes?.length ? biomeSet(world.small.species, t.biomes) : null;
    const rest: number[] = [];
    open.forEach((j, q) => {
      const ok = (!match || match[q]) && (!set || (biomes !== null && inBiomes(biomes, shoresOf()[j], set)));
      if (ok) chosen[j] = k;
      else rest.push(j);
    });
    open = rest;
  });
  chosen.forEach((k, j) => {
    if (k < 0) return;
    const cells = parts.lakes[j];
    for (let q = 0; q < cells.length; q++) lt[cells[q]] = k + 1;
  });
  d.lakeType = lt;
  return issues;
}

// ---------- 湖岸场 lake:<id> ----------

// 离这种湖多近（0–1，湖上为 1）；这种湖一格都没有（或者没有这种类型）时为 undefined
export function lakeBank(world: World, d: Derived, typeId: string): Float32Array | undefined {
  const types = lakeTypesOf(world.small);
  const k = types.findIndex((t) => t.id === typeId);
  if (k < 0) return undefined;
  return bankField(world, d.lakeType, k + 1, bankRadiusKm(world, types[k]));
}

// 一串格里多数是哪一种湖（下标，没有为 −1）
export const majorityLakeType = (d: Pick<Derived, 'lakeType'>, cells: ArrayLike<number>): number => majorityOf(d.lakeType, cells);
