import type { World } from '../../../core/world';
import { HOME, type Route, type SourceRef, WORLD_SOURCE } from './pages';
import { openLibraryAt } from './panel-store';

// 省份划分的规则在资源库里（第七十八轮）：“省份 ⋯”里的“省份划分”按钮打开本世界那一份的页面（改了再“划分省份”就用上）。
// 世界里没有省份划分时（移出了，按默认的划分）开本世界的省份划分列表，从库里加一份

export function provinceRulesPage(small: Pick<World['small'], 'content'>): { source: SourceRef; stack: Route[] } {
  const id = Object.keys(small.content?.provinceRules ?? {})[0];
  return { source: WORLD_SOURCE, stack: [HOME, id ? { p: 'item', kind: 'provinceRules', id } : { p: 'list', kind: 'provinceRules' }] };
}

export function openProvinceRules(small: Pick<World['small'], 'content'>): void {
  const page = provinceRulesPage(small);
  openLibraryAt(page.source, page.stack);
}
