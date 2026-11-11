import type { IslandType } from '../../../core/island-types';

// 岛的种类在列表里的色块（第九十三轮从 panels/island-types.ts 原样搬来，那里照旧导出：资源库的行也用，不用引用面板的模块）：
// 自己选的颜色；白沙、沙洲按样子；和周围一样的画成草地的绿
export function islandSwatch(t: IslandType | undefined): string {
  const c = t?.color;
  if (!c) return '#7f9a68';
  if (c === 'coral') return '#f2eedd';
  if (c === 'marsh') return '#a8b89a';
  return c;
}
