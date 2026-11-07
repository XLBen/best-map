import { HOME, type Route, WORLD_SOURCE } from '../packs/pages';
import { openLibraryAt } from '../packs/panel-store';

// 打开生态编辑器（第七十二轮：生态抽屉去掉了，编辑器就是资源库里本世界的那种生态的页面）：
// 资源库 → 生态与水系 → 生态 → 那一种。id 为 null 时停在生态的列表

export const biomeStack = (id: string | null): Route[] => [HOME, { p: 'ecology' }, { p: 'list', kind: 'biome' }, ...(id ? [{ p: 'item', kind: 'biome', id } as Route] : [])];

export function openBiomeEditor(id: string | null): void {
  openLibraryAt(WORLD_SOURCE, biomeStack(id));
}

// 总表（生态 × 水系）：河湖类型的“出现在这些生态里”在这里改
export function openWaterTable(): void {
  openLibraryAt(WORLD_SOURCE, [HOME, { p: 'ecology' }, { p: 'table' }]);
}
