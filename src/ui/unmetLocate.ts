import { signal } from '@preact/signals';
import { activeConflicts } from '../../core/constraints';
import type { World } from '../../core/world';
import { flashCells } from '../state';
import { focusOn } from './camera';

// “自然 ⋯”里“没涂成的地方”旁边的“一处一处看”（第十四轮放在底部条上，第十九轮收进去）：按一下看第一处，再按看下一处，看完一圈回到第一处。
// 先是还要提醒的（没长出来的格；涂到水面上的看涂的那几格），再是说了“就这样”的（没长出来的格；已经长出来的看涂的格）

export function unmetSpots(w: Pick<World, 'small' | 'derived'>): number[][] {
  const conflictOf = (id: string) => w.derived.conflicts.find((c) => c.constraintId === id);
  const cellsOf = (id: string) => w.small.constraints.find((c) => c.id === id)?.cells ?? [];
  const active = activeConflicts(w).map((c) => (c.failing.length ? c.failing : cellsOf(c.constraintId)));
  const ignored = w.small.constraints
    .filter((c) => c.ignored)
    .map((con) => {
      const c = conflictOf(con.id);
      return c?.failing.length ? c.failing : con.cells;
    });
  return [...active, ...ignored].filter((cells) => cells.length > 0);
}

// 上一次看的是第几处（−1：还没看过）
export const unmetLooked = signal(-1);

// 看下一处：镜头移过去，那几格亮一下。返回看的是第几处（没有可看的返回 −1）
export function locateNextUnmet(w: Pick<World, 'small' | 'derived'>): number {
  const spots = unmetSpots(w);
  if (!spots.length) {
    unmetLooked.value = -1;
    return -1;
  }
  const k = (unmetLooked.value + 1) % spots.length;
  unmetLooked.value = k;
  focusOn(spots[k]);
  flashCells(spots[k]);
  return k;
}

// 按钮上的说法：“在地图上看”，看过之后带上“第几处 / 共几处”
export function locateTitle(looked: number, total: number): string {
  return looked >= 0 && looked < total ? `在地图上看（${looked + 1}/${total}，再按看下一处）` : '在地图上看';
}
