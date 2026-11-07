import { kindOf } from '../../../core/content/registry';
import type { Species } from '../../../core/species';
import { exec } from '../../state';
import type { Obj } from '../packs/fields';
import { commitItem } from '../packs/page-actions';
import { type PageCtx, type SourceRef, itemOf, itemsOf, kindReadonly } from '../packs/page-source';
import { pageCtx } from '../packs/panel-store';
import { type Patch, applyPatch } from './biome-edit';
import { queueSpeciesEdit } from './species-scripts';

// 生态编辑器改的是哪一份（第七十二轮）：本世界还是一个库。两边只差怎么存——
//   本世界：update_species，和以前的生态抽屉同一条命令、同一个撤销（edit 立即发，queue 排队按世界上最新的样子做补丁）；
//   我的库：补丁落到那一项上，换掉这一项（和以前资源库的表单一样走 commitItem → library-edit.ts，这个库自己的撤销）；
//   只读的库（内置的、导入的）：什么都不存。
// 只有以前的表单才改的字段（宜居度、通行难度）两边都照表单的路走（replace）

export interface BiomeTarget {
  src: SourceRef;
  inWorld: boolean;
  // 不能改的原因（只读的库）；能改时 null
  readonly: string | null;
  // 这一份里的全部生态（气候图上的色块、侵占的目标）
  all: readonly Species[];
  // 改一种（id 可以是别的那种：气候图上拖的不一定是这一页的）。busy：世界里算的时候顶上那句话（不写时用 exec 的默认）
  edit(id: string, patch: Patch, busy?: string): Promise<boolean>;
  // 排队：轮到时按那时最新的样子做补丁（null 不改）
  queue(id: string, busy: string, make: (cur: Species) => Patch | null): Promise<boolean>;
  // 整项换掉（以前表单的那条路）
  replace(id: string, next: Obj): Promise<boolean>;
}

const done = (r: unknown): Promise<boolean> => Promise.resolve(r).then((v) => v === 'saved' || v === 'same');

export function biomeTarget(src: SourceRef, ctx: PageCtx): BiomeTarget {
  const kind = kindOf('biome')!;
  const readonly = kindReadonly(src, kind, ctx);
  const all = itemsOf(src, kind, ctx) as readonly Species[];
  const replace = (id: string, next: Obj) => (readonly ? Promise.resolve(false) : done(commitItem(src, kind, id, next, pageCtx())));
  if (src.t === 'world') {
    return {
      src,
      inWorld: true,
      readonly,
      all,
      edit: (id, patch, busy) => (readonly ? Promise.resolve(false) : exec({ op: 'update_species', id, patch }, busy)),
      queue: (id, busy, make) => (readonly ? Promise.resolve(false) : queueSpeciesEdit(id, busy, make)),
      replace,
    };
  }
  // 库里：按面板现在的这一份做（同一步里连着改几处时，前一处已经写进去了）
  const now = (id: string) => itemOf(src, kind, id, pageCtx()) as Species | undefined;
  const put = (id: string, patch: Patch | null) => {
    const cur = now(id);
    return cur && patch ? replace(id, applyPatch(cur, patch) as unknown as Obj) : Promise.resolve(false);
  };
  return {
    src,
    inWorld: false,
    readonly,
    all,
    edit: (id, patch) => put(id, patch),
    queue: (id, _busy, make) => {
      const cur = now(id);
      return put(id, cur ? make(cur) : null);
    },
    replace,
  };
}
