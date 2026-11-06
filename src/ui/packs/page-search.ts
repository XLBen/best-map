import { kindOf } from '../../../core/content/registry';
import type { ListRow, ListSection, PageCtx, SourceRef } from './pages';
import { kindTitle, listedKinds, rowsOf } from './pages';

// 首页顶上搜整个库（第六十七轮）：每种内容一段，名字或 id 里有这几个字的。一段最多列 SEARCH_SHOW 个，多的写“还有 N 个”

export const SEARCH_SHOW = 40;

export interface SearchSection extends ListSection {
  // 没列出来的
  more: number;
}

export function searchSource(src: SourceRef, ctx: PageCtx, query: string): SearchSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchSection[] = [];
  for (const id of listedKinds()) {
    const k = kindOf(id);
    if (!k) continue;
    const hits = rowsOf(src, k, ctx).filter((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
    if (!hits.length) continue;
    const rows: ListRow[] = hits.slice(0, SEARCH_SHOW).map((x) => ({ key: x.key, kind: x.kind, id: x.id, name: x.name, item: x.item, row: x }));
    out.push({ label: kindTitle(k), rows, more: hits.length - rows.length });
  }
  return out;
}
