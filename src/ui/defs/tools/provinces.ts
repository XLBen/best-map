import { Paintbrush, RefreshCw, Scissors, MousePointer2 } from 'lucide-preact';
import { BRUSH } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“省份”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const PROVINCE_TOOLS = {
  pselect: {
    category: 'provinces',
    icon: MousePointer2,
    name: '选省份',
    short: '选择',
    how: '点击选中省份；Shift+点击多选，合并或划给某国',
    bar: () => [{ kind: 'custom', panel: 'ProvinceColorToggle' }, { kind: 'custom', panel: 'ProvinceBar' }],
    cursor: 'pointer',
    mods: { shift: { label: '多选', title: '开着时点省份是加进多选，再点一下去掉' } },
  },
  pbrush: {
    category: 'provinces',
    more: true,
    when: 'provinces',
    icon: Paintbrush,
    name: '省份画笔',
    short: '画笔',
    how: '涂进条上选的省份，或涂出新省份；Alt+点击吸取',
    size: BRUSH,
    // 第二十七轮：条上直接选省份（或“新省份”）
    bar: () => [{ kind: 'custom', panel: 'ProvinceColorToggle' }, { kind: 'custom', panel: 'ProvincePick' }],
    // 离开时“新省份”不要了、吸取、橡皮擦（省份没有“生成时的样子”可以退回：恢复自动是重新划分涂到的省份）：tools/bind.ts
  },
  pcut: {
    category: 'provinces',
    more: true,
    when: 'provinces',
    icon: Scissors,
    name: '剪刀',
    short: '剪刀',
    how: '画线切开省份',
    bar: () => [{ kind: 'custom', panel: 'ProvinceColorToggle' }, { kind: 'custom', panel: 'ProvinceBar' }],
  },
  pregen: {
    category: 'provinces',
    more: true,
    icon: RefreshCw,
    name: '重新划分',
    short: '重划',
    how: '涂一片，重新划分里面的省份',
    size: BRUSH,
    bar: () => [{ kind: 'custom', panel: 'ProvinceColorToggle' }],
  },
} satisfies Record<string, ToolSpec>;
