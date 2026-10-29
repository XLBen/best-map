import { z } from 'zod';
import type { Command } from '../commands';
import type { SmallState } from '../world';
import { type ContentWorld, kindOf, itemId } from './registry';

// 内容的来源（第二十九轮）：世界里每一项来自资源库的哪个包，small.origin[种类][id] = 包的路径（[资源包的 id, 小包的 id, ……]，
// 内置的树见 packs/builtin-tree.ts：[“medieval”, “governments”]）。资源库的“本世界”按它分组，没有来源的是本世界自己做的（“离群”）。
//
// 写进来源的只有命令：启用一项的几种命令（ORIGIN_OPS）带上可选的 from（资源包用到世界时 planPack 写上，资源库里单独添加一项时界面写上）；
// 生成人文、国家时从内置的复制进来的项记它在内置的树里的位置（见 human/generate.ts、countries.ts）。
// 改一项时没写 from 的照旧留着原来的来源；一项不在世界里了（移出、生成后清理、整理……）它的来源由 tidyOrigins 一起去掉。
// 都在小状态里，撤销、重放与别的小状态一样

// 能带 from 的命令
export const ORIGIN_OPS: ReadonlySet<string> = new Set(['set_content', 'add_species', 'update_species', 'set_river_type', 'set_lake_type', 'set_island_type', 'add_field']);

// 包的路径：资源包的 id、各层小包的 id（最多两层小包，再加上资源库里的键，宽松一点）
export const originSchema = z.array(z.string().min(1).max(64)).min(1).max(6);
export type OriginPath = z.output<typeof originSchema>;

// 带 from 的命令说的是哪一项（种类、id）；不是这几种命令时 null
export function originTarget(cmd: Command): { kind: string; id: string } | null {
  switch (cmd.op) {
    case 'set_content':
      return cmd.item === null ? null : { kind: cmd.kind, id: cmd.id };
    case 'add_species':
      return { kind: 'biome', id: cmd.species.id };
    case 'update_species':
      return { kind: 'biome', id: cmd.id };
    case 'set_river_type':
      return { kind: 'riverType', id: cmd.type.id };
    case 'set_lake_type':
      return { kind: 'lakeType', id: cmd.type.id };
    case 'set_island_type':
      return { kind: 'islandType', id: cmd.type.id };
    case 'add_field':
      return { kind: 'field', id: cmd.name };
    default:
      return null;
  }
}

// 记下（或去掉）一项的来源
export function setOrigin(small: Pick<SmallState, 'origin'>, kind: string, id: string, path: readonly string[] | null): void {
  const all = { ...(small.origin ?? {}) };
  const of = { ...(all[kind] ?? {}) };
  if (path) of[id] = [...path];
  else delete of[id];
  if (Object.keys(of).length) all[kind] = of;
  else delete all[kind];
  if (Object.keys(all).length) small.origin = all;
  else delete small.origin;
}

// 世界里记着的来源（没有时 undefined）
export const recordedOrigin = (small: Pick<SmallState, 'origin'>, kind: string, id: string): string[] | undefined => small.origin?.[kind]?.[id];

// 不在世界里的项的来源去掉（每条命令之后，见 commands.ts 的 applyCommand）
export function tidyOrigins(world: ContentWorld): void {
  const origin = world.small.origin;
  if (!origin) return;
  let changed = false;
  const next: Record<string, Record<string, string[]>> = {};
  for (const [kind, ids] of Object.entries(origin)) {
    const k = kindOf(kind);
    const have = new Set(k ? k.inWorld(world).map((x) => itemId(k, x)) : []);
    const kept = Object.fromEntries(Object.entries(ids).filter(([id]) => have.has(id)));
    if (Object.keys(kept).length !== Object.keys(ids).length) changed = true;
    if (Object.keys(kept).length) next[kind] = kept;
  }
  if (!changed) return;
  if (Object.keys(next).length) world.small.origin = next;
  else delete world.small.origin;
}
