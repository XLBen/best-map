import type { Command } from '../../../core/commands';
import { type MapStyle, worldMapStyleId, worldMapStyles } from '../../../core/map-style';
import { DEFAULT_LIBRARY, DRAWN_PACK } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { addFromLibrary, itemsInPacks, librarySelectable } from './packChoice';

// 画风的选择（第八十七轮）：世界里的画风，加上世界用的库里“手绘画风”这个小包里世界还没有的（手绘）：
// 新建世界不带手绘（新世界与以前一样），在“图层 → 画风”里点它时从库里加进世界并选上（一整步，撤销一次全撤）

export interface StyleChoice {
  style: MapStyle;
  // 从资源库加：在库里的路径（世界里已有的为 undefined）
  path?: string[];
}

type Small = World['small'];

// 世界用的库（没有时默认的库）里手绘画风的小包
function drawnPath(small: Small, lib: readonly LibraryEntry[]): string[] | null {
  const key = worldLibrary(small);
  const has = (k: string | undefined) => !!k && lib.some((e) => e.key === k);
  const root = has(key) ? key! : has(DEFAULT_LIBRARY) ? DEFAULT_LIBRARY : null;
  return root ? [root, DRAWN_PACK] : null;
}

// 按小数据记住（世界里的画风、资源库换了才重查）
const memo = new WeakMap<object, { lib: readonly LibraryEntry[]; styles: unknown; list: StyleChoice[] }>();
export function mapStyleChoices(small: Small, lib: readonly LibraryEntry[]): StyleChoice[] {
  const inWorld = worldMapStyles(small);
  const hit = memo.get(small);
  if (hit && hit.lib === lib && hit.styles === inWorld) return hit.list;
  const list: StyleChoice[] = Object.values(inWorld).map((style) => ({ style }));
  const at = drawnPath(small, lib);
  if (at) {
    const selectable = librarySelectable(small, lib, 'mapStyles');
    for (const x of itemsInPacks<MapStyle>([at], lib, 'mapStyles')) if (!inWorld[x.item.id] && selectable(x.item.id, x.path)) list.push({ style: x.item, path: x.path });
  }
  memo.set(small, { lib, styles: inWorld, list });
  return list;
}

// 换成这种画风的命令：世界里没有的先从资源库加进来（一整步）；不用换时 null
export function mapStyleCommand(w: World, c: StyleChoice, lib: readonly LibraryEntry[]): Command | null {
  if (!c.path) return c.style.id === worldMapStyleId(w.small) ? null : { op: 'set_map_style', id: c.style.id };
  const add = addFromLibrary(w.small, lib, 'mapStyles', c.style.id, c.path);
  if (add.id === null) return null;
  return { op: 'batch', label: `画风换成“${c.style.name}”`, commands: [...add.commands, { op: 'set_map_style', id: add.id }] };
}
