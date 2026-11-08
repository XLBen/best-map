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

// 一行最多一个小标记（第八十一轮：以前“本世界改过”“和库不同”“默认”“在用”可以一起出来）：
// 默认 / 在用（这一项现在起作用）先，其次和库不同（本世界），最后本世界改过（库里看）。变淡不算标记（是样子）
export interface MarkInput {
  isDefault?: boolean;
  // 画风是“在用”，别的是“默认”
  inUse?: boolean;
  changed?: boolean;
  modified?: boolean;
}
export function oneMark(m: MarkInput): { text: string; diff: boolean } | null {
  if (m.isDefault) return { text: m.inUse ? '在用' : '默认', diff: false };
  if (m.changed) return { text: '和库不同', diff: true };
  if (m.modified) return { text: '本世界改过', diff: false };
  return null;
}
