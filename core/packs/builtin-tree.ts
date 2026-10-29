import { kindByPackKey } from '../content/registry';
import { recordedOrigin } from '../content/origin';
import type { PackItem, ResourcePack } from '../packs';
import type { SmallState } from '../world';
import { type BuiltinItem, buildBaseTree, builtinOrigin, indexTree, isBuiltinSame, useFullTree } from './builtin-base';
import { FANTASY_BIOMES, FANTASY_FIELDS } from './fantasy-biomes';
import { FANTASY_FORMS } from './fantasy-forms';
import { FANTASY_LAKE_TYPES } from './fantasy-lakes';
import { FANTASY_RIVER_TYPES } from './fantasy-rivers';

// 内置资源包的完整的树（第二十九轮）：主干在 builtin-base.ts（时代、取值、政体、派系、文化、地名、基础、自然），
// 这里在“奇幻”大包里补上奇幻的生态（带它们用到的自定义场）、河、湖、星球形态（fantasy.ts 的那几样）。
// 界面（资源库、向导）用这个文件；载入时让 builtin-base.ts 的查法换成完整的树

export { BASE_PATH, COMMON_PACK_ID, type BuiltinItem, builtinOrder, builtinOrigin, eraValues, isBuiltinSame, recordBuiltinOrigins } from './builtin-base';

const asItems = (list: readonly unknown[]): PackItem[] => list as PackItem[];

function build(): ResourcePack[] {
  return buildBaseTree().map((top) =>
    top.id !== 'fantasy'
      ? top
      : {
          ...top,
          packs: [
            ...(top.packs ?? []),
            { id: 'biomes', name: '奇幻生态', fields: [...FANTASY_FIELDS], biomes: asItems(FANTASY_BIOMES) },
            { id: 'rivers', name: '奇幻的河', riverTypes: asItems(FANTASY_RIVER_TYPES) },
            { id: 'lakes', name: '奇幻的湖', lakeTypes: asItems(FANTASY_LAKE_TYPES) },
            { id: 'forms', name: '星球形态', planetForms: asItems(FANTASY_FORMS) },
          ],
        },
  );
}

let tree: ResourcePack[] | null = null;

// 内置的大包（按时代的先后，通用在最后）
export function builtinPacks(): readonly ResourcePack[] {
  return (tree ??= build());
}

let index: Map<string, BuiltinItem> | null = null;
const fullIndex = () => (index ??= indexTree(builtinPacks()));

// 内置的树里的每一项和它在哪几个包里
export function builtinItems(): readonly BuiltinItem[] {
  return [...fullIndex().values()];
}

// 一项在内置的树里（没有时 undefined）
export const builtinItem = (kind: string, id: string): BuiltinItem | undefined => fullIndex().get(`${kind}\u0000${id}`);

useFullTree(builtinItem);

// 世界里一项的来源：记着的；没记、但与内置的一模一样时按内置的树（新世界自带的 13 种生态、总在的基础内容）；都没有时 undefined（离群）
export function originOf(small: Pick<SmallState, 'origin'>, kind: string, id: string, item?: unknown): string[] | undefined {
  const rec = recordedOrigin(small, kind, id);
  if (rec) return [...rec];
  if (item !== undefined && !isBuiltinSame(kind, item)) return undefined;
  return builtinOrigin(kind, id);
}

// 资源包的段名 → 种类 id（界面按段名走树时用）
export const kindOfKey = (key: string): string | undefined => kindByPackKey(key)?.id;
