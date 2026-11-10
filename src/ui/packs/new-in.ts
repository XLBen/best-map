import { itemId, itemName, kindOf } from '../../../core/content/registry';
import type { CultureGroup } from '../../../core/human/era';
import type { World } from '../../../core/world';
import { type PageCtx, type SourceRef, itemsOf } from './page-source';
import { joiningGroups } from './regen';

// 新建时要先选放进哪里的（第九十轮）：文化要有文化组。在某个组里新建就跟这个组；从“全部文化”新建时先选一个组——
// 本世界里只列参与生成的组（放进没参与的组，这个文化不会出现在地图上）；库里列这个库的全部组。以前默认放进 'chinese'（世界里常常没有这一组）

export interface NewChoice {
  // 选了写进新的一项的哪个字段
  field: 'group';
  title: string;
  options: { id: string; name: string }[];
  // 一个能选的都没有时写的一句
  empty: string;
}

export function cultureGroupChoices(src: SourceRef, ctx: PageCtx): NewChoice {
  const kind = kindOf('cultureGroup')!;
  const all = itemsOf(src, kind, ctx) as readonly CultureGroup[];
  const opt = (g: CultureGroup) => ({ id: itemId(kind, g), name: itemName(kind, g) });
  if (src.t !== 'world') return { field: 'group', title: '放进哪个文化组', options: all.map(opt), empty: '先新建一个文化组' };
  const w = ctx.world as World | null;
  const h = w?.small.human;
  // 还没生成人文：生成时会选的是多少不是 0 的组
  const joins = w && h ? joiningGroups(w.small, ctx.lib) : null;
  const options = all.filter((g) => (joins ? joins.has(g.id) : g.weight !== 0)).map(opt);
  return { field: 'group', title: '放进哪个文化组', options, empty: all.length ? '没有参与生成的文化组' : '先新建一个文化组' };
}

// 这一种从整张列表上新建时要先选什么（不用选时 null）
export function newChoiceOf(kindId: string, defaults: Readonly<Record<string, unknown>>, src: SourceRef, ctx: PageCtx): NewChoice | null {
  if (kindId === 'culture' && typeof defaults.group !== 'string') return cultureGroupChoices(src, ctx);
  return null;
}
