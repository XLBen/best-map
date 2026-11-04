import { cleanableSet, isCleanable } from '../../../core/content/cleanable';
import type { ContentKind } from '../../../core/content/registry';
import { type SourceDiff, sourceDiff } from '../../../core/packs/source-diff';
import type { PageCtx, SourceRef } from './page-source';

// 本世界的列表上一行带的两种标记（第六十二轮）：和来源的库不同（core/packs/source-diff.ts）、生成后没用到（core/content/cleanable.ts，
// 变淡的就是“清理没用到的”会清的）。只看本世界；比较用的字按对象记，404 个文化的列表第一次约 1 ms，之后几乎不要时间

export type { SourceDiff };
export type WorldMark = 'changed' | 'faint';

export interface RowMark {
  changed: boolean;
  faint: boolean;
}

const NONE: SourceDiff = { t: 'none' };

export function worldDiff(src: SourceRef, kind: ContentKind, id: string, item: unknown, ctx: PageCtx): SourceDiff {
  return src.t === 'world' && ctx.world ? sourceDiff(kind, id, item, ctx.world, ctx.lib) : NONE;
}

// 问一行的标记：不是本世界时 null
export function rowMarks(src: SourceRef, ctx: PageCtx): ((kind: ContentKind, id: string, item: unknown) => RowMark) | null {
  const w = ctx.world;
  if (src.t !== 'world' || !w) return null;
  const faint = cleanableSet(w);
  return (kind, id, item) => ({ changed: sourceDiff(kind, id, item, w, ctx.lib).t === 'changed', faint: isCleanable(faint, kind.id, id) });
}
