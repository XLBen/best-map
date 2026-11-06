import { signal } from '@preact/signals';
import { type IslandType, islandTypesOf } from '../../../core/island-types';
import type { World } from '../../../core/world';
import { exec, openPanel, setOptions, whenEditsIdle, world, worldEpoch } from '../../state';

// 岛的种类（islandTypes.tsx）的逻辑：色块、新建并用上、连着改几项时排队、别处要打开某一种的设置

// 列表里的色块：自己选的颜色；白沙、沙洲按样子；和周围一样的画成草地的绿
export function islandSwatch(t: IslandType | undefined): string {
  const c = t?.color;
  if (!c) return '#7f9a68';
  if (c === 'coral') return '#f2eedd';
  if (c === 'marsh') return '#a8b89a';
  return c;
}

export type Which = 'island' | 'chain';
export const KEY: Record<Which, 'islandKind' | 'chainKind'> = { island: 'islandKind', chain: 'chainKind' };
// “地形 ⋯”里要展开哪一种（新建之后打开它的设置）
export const editorRequest = signal<string | null>(null);
// 别处（资源库的“编辑”）要打开某一种的设置
export const requestIslandTypeEditor = (id: string) => void (editorRequest.value = id);

export const NEW_COLORS = ['#3d3a38', '#b5523b', '#6b8f3a', '#c9a24a', '#4d7f9c', '#8a5aa8'];
export function newIslandType(w: World): IslandType {
  const ids = new Set(islandTypesOf(w.small).map((t) => t.id));
  let k = 1;
  while (ids.has(`island-type-${k}`)) k++;
  return { id: `island-type-${k}`, name: `新的岛 ${k}`, shape: 'rugged', height: 'hilly', color: NEW_COLORS[(k - 1) % NEW_COLORS.length], province: 'land' };
}

export async function createAndUse(which: Which | null): Promise<void> {
  const w = world.value;
  if (!w) return;
  openPanel.value = null;
  const t = newIslandType(w);
  const ok = await exec({ op: 'set_island_type', type: t }, '正在新建…');
  if (!ok) return;
  if (which) setOptions({ [KEY[which]]: t.id });
  editorRequest.value = t.id;
  openPanel.value = 'cat:terrain';
}

// 连着改几项时排队：后一步按前一步改完之后世界上的这一种做出整份（set_island_type 是整份换掉）
let tail: Promise<unknown> = Promise.resolve();
export function editIslandType(id: string, make: (t: IslandType) => IslandType) {
  const epoch = worldEpoch.value;
  tail = tail.then(async () => {
    await whenEditsIdle();
    const w = world.value;
    if (worldEpoch.value !== epoch || !w) return;
    const t = islandTypesOf(w.small).find((x) => x.id === id);
    if (!t) return;
    const next = make(structuredClone(t));
    const out = { ...next } as Record<string, unknown>;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    if (JSON.stringify(out) !== JSON.stringify(t)) await exec({ op: 'set_island_type', type: out as unknown as IslandType }, '正在修改…');
  });
}
