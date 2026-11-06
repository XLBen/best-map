import type { LucideIcon } from 'lucide-preact';
import { itemId, kindOf } from '../../../core/content/registry';
import { originOf } from '../../../core/packs/builtin-tree';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import { openPanel } from '../../state';
import { openLibrary } from '../packs/panel-store';

// 选“哪一种”的列表（TypePicker.tsx）的逻辑：一行的样子、按来源的包分段、“从资源库添加…”

export interface TypeChoice {
  label: string;
  // 色块的颜色（没有时不画：地名风格）
  swatch?: string;
  on: boolean;
  hint?: string;
  // 右边灰色的一小段（画法、形状）
  meta?: string;
  // 分组（第二十二轮：文化按文化组列）：与上一行不同时先写一行小标题
  group?: string;
  // 本世界里这一项的 id（第二十九轮：没写 group 时按它的来源分段）
  id?: string;
  // 图标（第二十四轮：地标、自定义点的类型）
  icon?: LucideIcon;
  // 上传的小图（自定义点的类型）
  image?: string;
  onPick: () => void;
}

export const LOOSE_GROUP = '离群';

// 按来源的包分段（第二十九轮）：写了 id、都没写 group 的项按 small.origin 的大包（资源库里的名字）分段，先后照资源库，离群的（本世界做的）放最后；
// 没写 id 的（恢复自动、无……）留在最前。只有一段时不写小标题
export function originGroups(items: readonly TypeChoice[], kind: string, w: Pick<World, 'small' | 'causes'> | null, lib: readonly LibraryEntry[]): TypeChoice[] {
  const k = kindOf(kind);
  if (!k || !w || items.some((it) => it.group !== undefined)) return [...items];
  const byId = new Map(k.inWorld(w).map((x) => [itemId(k, x), x]));
  const nameOf = (top: string) => lib.find((e) => e.key === top)?.pack.name ?? top;
  const labels = items.map((it) => {
    if (it.id === undefined) return null;
    const path = originOf(w.small, kind, it.id, byId.get(it.id));
    return path?.length ? nameOf(path[0]) : LOOSE_GROUP;
  });
  const distinct = [...new Set(labels.filter((x): x is string => x !== null))];
  if (distinct.length <= 1) return [...items];
  // 先后照资源库（内置的按时代，之后是我的、装上的）
  const rank = (label: string) => (label === LOOSE_GROUP ? Infinity : lib.findIndex((e) => e.pack.name === label) >>> 0);
  const order = [...distinct].sort((a, b) => rank(a) - rank(b));
  const head = items.filter((_, i) => labels[i] === null);
  const rest = items.map((it, i) => ({ it, g: labels[i] })).filter((x): x is { it: TypeChoice; g: string } => x.g !== null);
  rest.sort((a, b) => order.indexOf(a.g) - order.indexOf(b.g));
  return [...head, ...rest.map(({ it, g }) => ({ ...it, group: g }))];
}

// 打开资源库，筛到这一种不在本世界的（工具里的“从资源库添加…”）
export function openLibraryFor(kind: string) {
  openPanel.value = null;
  openLibrary({ kind, off: true });
}
