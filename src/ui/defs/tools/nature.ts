import { Gem, LassoSelect, Move, Paintbrush } from 'lucide-preact';
import { BRUSH, REACH, biomeModes } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“自然”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const NATURE_TOOLS = {
  biome: {
    category: 'nature',
    icon: Paintbrush,
    name: '涂生态',
    short: '涂生态',
    how: '在陆地上涂；Alt+点击吸取生态',
    size: BRUSH,
    amount: REACH,
    bar: () => [{ kind: 'custom', panel: 'BiomeChip' }, biomeModes, { kind: 'custom', panel: 'UnmetChip' }],
  },
  grow: {
    category: 'nature',
    more: true,
    icon: Move,
    name: '拖动扩张',
    short: '扩张',
    how: '按住生态往外拖，越远长得越多',
    size: BRUSH,
    amount: REACH,
    bar: () => [biomeModes, { kind: 'custom', panel: 'UnmetChip' }],
    // 拖的是鼠标下的那一片生态：没有要吸的
  },
  range: {
    // 第十二轮：给生态选“长在哪里”（从生态编辑器的“选岛”“圈一下”进来，不在工具列表里）
    category: 'nature',
    icon: LassoSelect,
    name: '选生态的范围',
    short: '选范围',
    how: '点岛或圈一片，生态只长在那里',
    hidden: () => true,
    bar: () => [{ kind: 'custom', panel: 'RangeBar' }],
    cursor: 'pointer',
    // 离开时不选了、地图跟着选的范围重画：tools/bind.ts
  },
  resource: {
    // 第二十一轮：画资源
    category: 'nature',
    more: true,
    when: 'resourcePainted',
    icon: Gem,
    name: '资源',
    short: '资源',
    how: '按住涂，改资源；Alt+点击吸取',
    size: BRUSH,
    bar: () => [{ kind: 'custom', panel: 'ResourcePick' }],
    view: 'resource',
  },
} satisfies Record<string, ToolSpec>;
