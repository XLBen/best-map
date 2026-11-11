import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import { type CountryPatch, type FlagSpec, LAYOUT_COLORS } from '../../core/human';
import { exec } from '../state';
import { patchCommand } from './domain/countries';

// 国家档案（CountryArchive.tsx）的逻辑：旗的样式与图案的名字、换样式、换图案、旗上每种颜色是哪一块、页签

// 执行一条命令（没有时什么都不做）；改这一国的档案（第七十轮从 CountryArchive.tsx 搬来，各页共用）
export const run = (cmd: Command | null, busy = '正在保存…') => (cmd ? exec(cmd, busy) : Promise.resolve(false));
export const patch = (id: number, p: CountryPatch | null) => run(p ? patchCommand(id, p) : null);

// 第九十三轮：样式、图案的名字搬到 domain/flag-names.ts（资源库里政体的旗也用，那边不引用状态），照旧从这里导出
export { EMBLEM_NAMES, LAYOUT_NAMES } from './domain/flag-names';

// 换旗的样式：颜色的种数跟着样式（少了补上现有的或深浅两色）
export function withLayout(flag: FlagSpec, layout: string): FlagSpec {
  const k = LAYOUT_COLORS[layout as keyof typeof LAYOUT_COLORS] ?? 1;
  const colors = flag.colors.slice(0, k);
  const pad = ['#f4f1e8', '#1d1d1f', '#c8102e', '#e8b923'];
  for (let q = 0; colors.length < k; q++) if (!colors.includes(pad[q % pad.length]) || q > 8) colors.push(pad[q % pad.length]);
  return { ...flag, layout: layout as FlagSpec['layout'], colors };
}
export function withEmblem(flag: FlagSpec, emblem: string): FlagSpec {
  if (!emblem) {
    const { emblem: _e, emblemColor: _c, ...rest } = flag;
    return rest;
  }
  return { ...flag, emblem: emblem as FlagSpec['emblem'], emblemColor: flag.emblemColor ?? '#f4f1e8' };
}

// 旗上第 k 种颜色是哪一块（与 flagSvg 的画法对应）
export function flagPartName(layout: string, k: number): string {
  const parts: Record<string, string[]> = {
    'bicolor-h': ['上', '下'],
    'bicolor-v': ['左', '右'],
    'tricolor-h': ['上', '中', '下'],
    'tricolor-v': ['左', '中', '右'],
    cross: ['底色', '十字'],
    nordic: ['底色', '十字'],
    saltire: ['底色', '斜十字'],
    canton: ['底色', '角'],
    chevron: ['底色', '三角'],
    quartered: ['底色', '另两格'],
    border: ['底色', '边'],
    diagonal: ['左上', '右下'],
    stripes: ['底色', '条纹'],
  };
  return parts[layout]?.[k] ?? (k === 0 ? '底色' : `第 ${k + 1} 色`);
}

// 页签（第二十七轮）：换了国家还停在同一页
export type CountryTab = 'overview' | 'politics' | 'people' | 'relations' | 'history';
export const COUNTRY_TABS: [CountryTab, string][] = [
  ['overview', '概览'],
  ['politics', '政治'],
  ['people', '人口与城市'],
  ['relations', '关系'],
  ['history', '历史'],
];
export const countryTab = signal<CountryTab>('overview');
