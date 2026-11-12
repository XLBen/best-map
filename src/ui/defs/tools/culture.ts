import { Users, Flag, Languages } from 'lucide-preact';
import { worldDimensions } from '../../../../core/human';
import { options, world } from '../../../state';
import { percentText } from '../tool-values';
import { BRUSH, percent } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“文化”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const CULTURE_TOOLS = {
  culture: {
    // 第二十二轮：文化笔刷
    category: 'culture',
    icon: Languages,
    name: '文化',
    short: '文化',
    how: '按住涂，这里的人换成这种文化；Alt+点击吸取',
    size: BRUSH,
    amount: { key: 'cultureAmount', label: '力度', range: () => [0.05, 1], scale: 'linear', snap: (v) => Math.round(v * 20) / 20, format: (v) => percent(v, 1) },
    bar: () => [
      { kind: 'custom', panel: 'NoHumanChip' },
      { kind: 'custom', panel: 'CulturePick' },
      {
        kind: 'choice',
        key: 'cultureMode',
        options: [
          { value: 'keep', label: '只换文化', hint: '宗教等别的变量不变' },
          { value: 'typical', label: '连同倾向', hint: '换成这个文化最常见的一群人' },
        ],
      },
    ],
    view: 'culture',
  },
  pop: {
    // 人口笔刷：改成分、改人数、改一个维度
    category: 'culture',
    icon: Users,
    name: '人口',
    short: '人口',
    how: '按住涂，改这里的人口；Alt+点击吸取',
    size: BRUSH,
    // 第二十七轮：力度可以为负（往外推，这一类减少）；Shift 反过来
    amount: {
      key: 'popAmount',
      label: '力度',
      range: () => [-1, 1],
      scale: 'linear',
      snap: (v) => Math.round(v * 20) / 20,
      format: (v) => percentText(v),
      enabled: () => options.value.popMode !== 'count',
    },
    bar: () => [
      { kind: 'custom', panel: 'NoHumanChip' },
      {
        kind: 'choice',
        key: 'popMode',
        options: [
          { value: 'share', label: '改成分', hint: '这群人的占比升降，人数不变；力度为负或 Shift 减少' },
          { value: 'count', label: '改人数', hint: '人数增减；Shift 反过来' },
          { value: 'value', label: '改一个变量', hint: '改宗、传教：只改这一个变量；力度为负或 Shift 减少' },
        ],
      },
      { kind: 'custom', panel: 'PopTuplePick' },
      { kind: 'custom', panel: 'ValuePick' },
      { kind: 'custom', panel: 'FactorSlider' },
    ],
    // 底图跟着模式：改成分看文化，改人数看人口密度，改一个维度看那一维
    view: () => (options.value.popMode === 'share' ? 'culture' : options.value.popMode === 'count' ? 'popDensity' : `dim:${options.value.popDim || (world.value ? (worldDimensions(world.value.small)[0]?.id ?? '') : '')}`),
  },
  hearth: {
    // 发源地：拖动，人文重新生成
    category: 'culture',
    more: true,
    when: 'hearthMoved',
    icon: Flag,
    name: '发源地',
    short: '发源地',
    how: '拖动发源地，人文重新生成',
    bar: () => [{ kind: 'custom', panel: 'NoHumanChip' }, { kind: 'custom', panel: 'HearthBar' }],
    view: 'cultureGroup',
  },
} satisfies Record<string, ToolSpec>;
