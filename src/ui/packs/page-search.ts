import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import type { ListRow, ListSection, PageCtx, SourceRef } from './pages';
import { dimensionLabel, groupKind, itemsOf, kindTitle, listedKinds, rowsOf } from './pages';
import type { ItemRow } from './rows';

// 首页顶上搜整个库（第六十七轮）：每种内容一段，名字或 id 里有这几个字的。一段最多列 SEARCH_SHOW 个，多的写“还有 N 个”。
// 第九十二轮：这张地图的首页也有（以前只有库的首页有）；外文名也搜；每一行灰字写清楚是哪一种、在哪一组（“文化 · 汉组”“政体”），
// 是按外文名、id 找到的时把找到的那个字写在后面。名字对得上的排在前面

export const SEARCH_SHOW = 40;

export interface SearchSection extends ListSection {
  // 没列出来的
  more: number;
}

// 这一项的外文名（文化、文化组、取值、取值组的 orig；国家等级的简称……没有时空的）
const foreignOf = (item: unknown): string => {
  const o = (item as { orig?: unknown }).orig;
  return typeof o === 'string' ? o : '';
};

// 按什么找到的：名字 0、外文名 1、id 2；没找到 -1
export function matchOf(row: Pick<ItemRow, 'name' | 'id' | 'item'>, q: string): number {
  if (row.name.toLowerCase().includes(q)) return 0;
  if (foreignOf(row.item).toLowerCase().includes(q)) return 1;
  if (row.id.toLowerCase().includes(q)) return 2;
  return -1;
}

// 一行的灰字：“文化 · 汉组”“政体”“宗教的取值”。where：这一项所在的上级叫什么（文化的文化组、取值的变量）
export function kindLine(kind: ContentKind, item: unknown, src: SourceRef, ctx: PageCtx, groups: (k: ContentKind) => ReadonlyMap<string, string>): string {
  const title = kindTitle(kind);
  if (kind.id === 'popValue' || kind.id === 'valueGroup') {
    const dim = (item as { dimension?: string }).dimension;
    return dim ? `${dimensionLabel(dim, src, ctx)} · ${title}` : title;
  }
  const up = groupKind(kind);
  const g = up ? (item as { group?: string }).group : undefined;
  const name = up && g ? groups(up).get(g) : undefined;
  return name ? `${title} · ${name}` : title;
}

export function searchSource(src: SourceRef, ctx: PageCtx, query: string): SearchSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchSection[] = [];
  const names = new Map<string, ReadonlyMap<string, string>>();
  const groups = (k: ContentKind): ReadonlyMap<string, string> => {
    let m = names.get(k.id);
    if (!m) names.set(k.id, (m = new Map(itemsOf(src, k, ctx).map((x) => [itemId(k, x), itemName(k, x)]))));
    return m;
  };
  for (const id of listedKinds()) {
    const k = kindOf(id);
    if (!k) continue;
    const hits = rowsOf(src, k, ctx)
      .map((x) => ({ x, how: matchOf(x, q) }))
      .filter((h) => h.how >= 0)
      // 名字对得上的在前（同一档里照原来的先后）
      .sort((a, b) => a.how - b.how);
    if (!hits.length) continue;
    const rows: ListRow[] = hits.slice(0, SEARCH_SHOW).map(({ x, how }) => {
      const where = kindLine(k, x.item, src, ctx, groups);
      const found = how === 1 ? foreignOf(x.item) : how === 2 ? x.id : '';
      return { key: x.key, kind: x.kind, id: x.id, name: x.name, hint: found ? `${where} · ${found}` : where, item: x.item, row: x };
    });
    out.push({ label: kindTitle(k), rows, more: hits.length - rows.length });
  }
  return out;
}
