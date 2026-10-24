import type { Causes, Derived, SmallState } from '../world';

// 地名跟着文化（第二十二轮，name-styles.ts 的 styleFor 用）：一处地方（地物、省份、一格）没有自己选的风格时，
// 用当地占多数的文化的地名风格——按人数算（每格人口里占多数的文化，derived.popCulture × 人数）；
// 一个人都没有的地方（海、荒地）按格数取最近的文化（derived.cultureNear）。没有人文的世界什么都不返回。
// 只读数据，不引用别的人文模块（name-styles.ts 引用它，避免循环引用）

export interface CultureWorld {
  small: Pick<Partial<SmallState>, 'content' | 'human'>;
  causes?: Pick<Partial<Causes>, 'popTotal' | 'province'>;
  derived?: Pick<Partial<Derived>, 'popCulture' | 'cultureNear' | 'popDensity'>;
}

// 按 popCulture、popDensity 两个数组（内容不变时重算也沿用同一个）缓存：地物的格列表 → 文化的编号
const cache = new WeakMap<Uint16Array, WeakMap<object, WeakMap<object, number>>>();

// cells 里占多数的文化的编号（worldCultures 的下标 + 1；没有时为 0）
export type Cells = ArrayLike<number> & object;

export function majorityCulture(world: CultureWorld, cells: Cells): number {
  const d = world.derived;
  const pc = d?.popCulture;
  const near = d?.cultureNear;
  const pop = world.causes?.popTotal;
  if (!world.small.human || !pc || !near || !pop || pc.length !== near.length) return 0;
  const key = d.popDensity ?? pc;
  let byPop = cache.get(pc);
  if (!byPop) cache.set(pc, (byPop = new WeakMap()));
  let m = byPop.get(key);
  if (!m) byPop.set(key, (m = new WeakMap()));
  const hit = m.get(cells);
  if (hit !== undefined) return hit;
  const w = new Map<number, number>();
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const c = pc[i];
    if (c && pop[i] > 0) w.set(c, (w.get(c) ?? 0) + pop[i]);
  }
  if (!w.size) {
    for (let k = 0; k < cells.length; k++) {
      const c = near[cells[k]];
      if (c) w.set(c, (w.get(c) ?? 0) + 1);
    }
  }
  let best = 0;
  let bv = 0;
  for (const [c, v] of w) {
    if (v > bv || (v === bv && c < best)) {
      bv = v;
      best = c;
    }
  }
  if (cells.length > 1) m.set(cells, best);
  return best;
}

// 那个文化的地名风格 id（没有时 undefined）
export function cultureStyleId(world: CultureWorld, cells: Cells): string | undefined {
  const code = majorityCulture(world, cells);
  if (!code) return undefined;
  const list = Object.values(world.small.content?.culture ?? {}) as { nameStyle?: string }[];
  return list[code - 1]?.nameStyle;
}
