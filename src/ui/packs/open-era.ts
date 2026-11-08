import { worldEra } from '../../../core/human';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { libraryRule, worldLibrary } from '../domain/packChoice';
import { HOME, type Route, type SourceRef, WORLD_SOURCE } from './pages';
import { openLibraryAt } from './panel-store';

// 生成的参数在资源库里（第七十七轮）：国家多大、各等级占多少、人口密度是时代的规则，各文化组占多少是组的比重。
// 生成人文、国家的面板上的“时代”按钮打开时代的页面，展开 seg 那一段（“国家”state、“人口”people）。
// 世界里有选的库的时代（生成过人文）时开本世界的那一份（改了重新生成就用上）；还没有时（换库）开库里的

type Small = World['small'];

export function eraPage(library: string | null, small: Small | null | undefined, lib: readonly LibraryEntry[], seg: string): { source: SourceRef; stack: Route[] } | null {
  const here = small ? worldEra(small) : undefined;
  if (here && small && (!library || library === worldLibrary(small))) return { source: WORLD_SOURCE, stack: [HOME, { p: 'item', kind: 'era', id: here.id, seg }] };
  const rule = libraryRule(library, lib);
  if (!rule || !library || !lib.some((e) => e.key === library)) return null;
  return { source: { t: 'lib', key: library }, stack: [HOME, { p: 'item', kind: 'era', id: rule.era.id, seg }] };
}

export function openEraPage(library: string | null, small: Small | null | undefined, lib: readonly LibraryEntry[], seg: string): void {
  const page = eraPage(library, small, lib, seg);
  if (page) openLibraryAt(page.source, page.stack);
}

// 生成设置（第八十一轮，gen-settings.ts）：本世界最常调的几项在一页上。“文化 ⋯”“国家 ⋯”“省份 ⋯”、新建向导建好后都开它
export const GEN_PAGE: { source: SourceRef; stack: Route[] } = { source: WORLD_SOURCE, stack: [HOME, { p: 'gen' }] };
export function openGenSettings(): void {
  openLibraryAt(GEN_PAGE.source, GEN_PAGE.stack);
}
