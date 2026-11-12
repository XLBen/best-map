import { Merge, Paintbrush, MousePointerClick, SquarePlus } from 'lucide-preact';
import { BRUSH, NEW_COUNTRY_SHAPES } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“国家”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const COUNTRY_TOOLS = {
  // ---------- 第二十三轮：国家 ----------
  cselect: {
    category: 'countries',
    icon: MousePointerClick,
    name: '选国家',
    short: '选择',
    how: '点击国家，打开档案',
    bar: () => [{ kind: 'custom', panel: 'NoCountryChip' }, { kind: 'custom', panel: 'SelectedCountryChip' }],
    cursor: 'pointer',
    view: 'country',
  },
  territory: {
    category: 'countries',
    icon: Paintbrush,
    name: '领土',
    short: '领土',
    how: '按住涂，改成这一国的领土；Alt+点击吸取',
    size: BRUSH,
    bar: () => [{ kind: 'custom', panel: 'NoCountryChip' }, { kind: 'custom', panel: 'TerritoryPick' }],
    view: 'country',
  },
  newCountry: {
    category: 'countries',
    icon: SquarePlus,
    name: '新建国家',
    short: '新国家',
    how: '点一个省份或圈一片，成为新国家',
    bar: () => [{ kind: 'custom', panel: 'NoCountryChip' }, NEW_COUNTRY_SHAPES],
    view: 'country',
  },
  cmerge: {
    category: 'countries',
    more: true,
    icon: Merge,
    name: '合并国家',
    short: '合并',
    how: '先点一国，再点要并进来的',
    bar: () => [{ kind: 'custom', panel: 'NoCountryChip' }, { kind: 'custom', panel: 'SelectedCountryChip' }],
    cursor: 'pointer',
    view: 'country',
  },
} satisfies Record<string, ToolSpec>;
