import type { Command } from './commands';
import type { Species } from './species';
import { type WaterType, PLAIN_TYPE } from './water-types';
import type { SmallState } from './world';

// 允许表（第五十六轮）：纵列生态，横行水系，普通河、普通湖也是一行。生态页和河湖页（第五十九轮的总表）都读写这里，数据只存一份：
//   · 普通河、普通湖那一行在生态上：species.plainRiver、plainLake（false 不允许，省略为允许）。普通的河湖没有自己的记录；
//   · 别的行在这种水上：type.biomes（省略为全部）。它本来就在引用表里（导入改名跟着改、依赖关系都有），生态不用反过来引用河湖，
//     导入一种生态不会拖来一堆河；河湖的包也是自足的。
// 所以一格只在一个地方，不用两边同步。

export type WaterKind = 'river' | 'lake';

type TypeLists = Pick<SmallState, 'riverTypes' | 'lakeTypes'>;
const listOf = (small: TypeLists, kind: WaterKind): readonly WaterType[] => (kind === 'river' ? small.riverTypes : small.lakeTypes) ?? [];
const plainKey = (kind: WaterKind): 'plainRiver' | 'plainLake' => (kind === 'river' ? 'plainRiver' : 'plainLake');

// 一格：这种生态允不允许这种水（typeId 是 PLAIN_TYPE 时是普通的）。这种水不存在时为 false
export function waterAllowed(small: TypeLists, sp: Pick<Species, 'id' | 'plainRiver' | 'plainLake'>, kind: WaterKind, typeId: string): boolean {
  if (typeId === PLAIN_TYPE) return sp[plainKey(kind)] !== false;
  const t = listOf(small, kind).find((x) => x.id === typeId);
  return !!t && (!t.biomes || t.biomes.includes(sp.id));
}

// 这种水换上这一格之后的样子（ids：世界里的生态，按先后存，结果与点的先后无关）
export function withWaterBiome<T extends Pick<WaterType, 'biomes'>>(t: T, ids: readonly string[], spId: string, on: boolean): T {
  const now = new Set(t.biomes ?? ids);
  if (on) now.add(spId);
  else now.delete(spId);
  const list = ids.filter((id) => now.has(id));
  const { biomes: _, ...rest } = t;
  return (list.length === ids.length ? rest : { ...rest, biomes: list }) as T;
}

// 打勾、取消的命令（什么都不用改时为 null）。这种水没列生态（全部允许）时，取消一格写成列出别的所有生态；全都允许了就不再列
export function setWaterAllowed(small: TypeLists & Pick<SmallState, 'species'>, spId: string, kind: WaterKind, typeId: string, on: boolean): Command | null {
  const sp = small.species.find((s) => s.id === spId);
  if (!sp || waterAllowed(small, sp, kind, typeId) === on) return null;
  if (typeId === PLAIN_TYPE) return { op: 'update_species', id: spId, patch: { [plainKey(kind)]: on ? null : false } };
  const t = listOf(small, kind).find((x) => x.id === typeId);
  if (!t) return null;
  const next = withWaterBiome(t, small.species.map((s) => s.id), spId, on);
  return kind === 'river' ? { op: 'set_river_type', type: next as never } : { op: 'set_lake_type', type: next as never };
}

// 不允许时怎么办。选“断流”而普通河还允许时，同一步取消普通河：否则普通河照常流过，什么都不会发生
export function setWaterBlock(small: Pick<SmallState, 'species'>, spId: string, mode: 'swap' | 'stop'): Command | null {
  const sp = small.species.find((s) => s.id === spId);
  if (!sp || (sp.waterBlock ?? 'swap') === mode) return null;
  if (mode === 'swap') return { op: 'update_species', id: spId, patch: { waterBlock: null } };
  return { op: 'update_species', id: spId, patch: { waterBlock: 'stop', ...(sp.plainRiver === false ? {} : { plainRiver: false }) } };
}
