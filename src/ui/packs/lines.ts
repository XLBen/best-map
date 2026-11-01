import type { RepoRow, TreeNode } from './repo';

// 资源库左栏的一长列（第四十五轮）：两段（本世界、资源库）的树按展开的样子摊成一行一行，只画看得见的那几十行
// （EU4 的 410 个文化全展开时也不卡）。每一行一样高。不碰界面，测试直接调

export type Side = 'world' | 'library';

export type Line =
  | { t: 'section'; key: string; side: Side; title: string; count: number; collapsed: boolean }
  | { t: 'node'; key: string; side: Side; n: TreeNode; depth: number; open: boolean }
  | { t: 'item'; key: string; side: Side; row: RepoRow; depth: number }
  | { t: 'empty'; key: string; side: Side; text: string };

export interface LineSection {
  side: Side;
  title: string;
  nodes: readonly TreeNode[];
  count: number;
  empty: string;
}

// 一行多高（px，与 styles.css 的 --h-sm 一样）
export const LINE_H = 28;

// open：展开着的包；collapsed：收起的段；searching：在搜索时包都展开
export function treeLines(sections: readonly LineSection[], open: ReadonlySet<string>, collapsed: ReadonlySet<string>, searching: boolean): Line[] {
  const out: Line[] = [];
  const walk = (n: TreeNode, side: Side, depth: number) => {
    const isOpen = searching || open.has(n.key);
    out.push({ t: 'node', key: n.key, side, n, depth, open: isOpen });
    if (!isOpen) return;
    for (const c of n.children) walk(c, side, depth + 1);
    for (const r of n.rows) out.push({ t: 'item', key: r.key, side, row: r, depth });
  };
  for (const s of sections) {
    const shut = collapsed.has(s.side);
    out.push({ t: 'section', key: `sec:${s.side}`, side: s.side, title: s.title, count: s.count, collapsed: shut });
    if (shut) continue;
    if (!s.nodes.length) out.push({ t: 'empty', key: `empty:${s.side}`, side: s.side, text: s.empty });
    for (const n of s.nodes) walk(n, s.side, 0);
  }
  return out;
}

// 看得见的是第几行到第几行（[start, end)），上下各多画 overscan 行
export function visibleRange(scrollTop: number, viewH: number, total: number, overscan = 8, lineH = LINE_H): [number, number] {
  const first = Math.floor(Math.max(0, scrollTop) / lineH);
  const count = Math.ceil(Math.max(0, viewH) / lineH) + 1;
  return [Math.max(0, first - overscan), Math.min(total, first + count + overscan)];
}

// 一行要滚到看得见：新的 scrollTop（已经看得见时不变）
export function scrollToLine(index: number, scrollTop: number, viewH: number, lineH = LINE_H): number {
  const top = index * lineH;
  if (top < scrollTop) return top;
  if (top + lineH > scrollTop + viewH) return top + lineH - viewH;
  return scrollTop;
}

// 树里按键找一项（选中的那一项的详情用）
export function findRow(nodes: readonly TreeNode[], key: string): RepoRow | undefined {
  for (const n of nodes) {
    const r = n.rows.find((x) => x.key === key) ?? findRow(n.children, key);
    if (r) return r;
  }
  return undefined;
}
