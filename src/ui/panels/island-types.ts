import { kindOf } from '../../../core/content/registry';
import { type IslandType, islandTypesOf } from '../../../core/island-types';
import type { World } from '../../../core/world';
import { exec, openPanel, setOptions, world } from '../../state';
import { blankItem } from '../packs/fields';
import { openWorldItem } from '../packs/panel-store';

// 岛的种类（islandTypes.tsx）的逻辑：色块、新建并用上。
// 第九十三轮：这里以前还有“地形 ⋯”里另一个编辑器的排队（editIslandType）和打开它的请求——那个编辑器并进了资源库里这一种的页面
// （和生态一样，只有一处能改），新建之后直达那一页

// 列表里的色块（第九十三轮搬到 domain/island-swatch.ts，照旧从这里导出）
export { islandSwatch } from '../domain/island-swatch';

export type Which = 'island' | 'chain';
export const KEY: Record<Which, 'islandKind' | 'chainKind'> = { island: 'islandKind', chain: 'chainKind' };

export const NEW_COLORS = ['#3d3a38', '#b5523b', '#6b8f3a', '#c9a24a', '#4d7f9c', '#8a5aa8'];
// 新的一种：和资源库列表上的“新建”同一个样子、同一种 id（packs/fields.ts 的 blankItem：my-island、my-island-2……），只是颜色轮着取
export function newIslandType(w: World): IslandType {
  const all = islandTypesOf(w.small);
  const blank = blankItem(kindOf('islandType')!, new Set(all.map((t) => t.id)))!;
  return { ...(blank as unknown as IslandType), color: NEW_COLORS[all.length % NEW_COLORS.length] };
}

// 新建一种（放岛、岛链的“新建…”时用上它），然后打开资源库里这一种的页面
export async function createAndUse(which: Which | null): Promise<void> {
  const w = world.value;
  if (!w) return;
  openPanel.value = null;
  const t = newIslandType(w);
  const ok = await exec({ op: 'set_island_type', type: t }, '正在新建…');
  if (!ok) return;
  if (which) setOptions({ [KEY[which]]: t.id });
  openWorldItem('islandType', t.id);
}
