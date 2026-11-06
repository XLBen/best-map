import { Droplet, Spline, Trash2 } from 'lucide-preact';
import { selectedLake, selectedRiver } from '../../../state';
import { lakeSizeDraft } from '../../domain/lakeInfo';
import { selectedRiverFocus } from '../../map/highlights';
import { LAKE, RIVER, riverModes, riverEnds } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“水系”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const WATER_TOOLS = {
  river: {
    category: 'water',
    icon: Spline,
    name: '画河',
    short: '画河',
    how: '从河上起笔改河，别处起笔画新河',
    // 选中一条河时，底部条换成那条河的设置（新河的大小先收起来）
    size: { ...RIVER, enabled: () => !selectedRiver.value },
    bar: () =>
      selectedRiver.value
        ? [{ kind: 'custom', panel: 'RiverBar' }]
        : [riverModes, riverEnds, { kind: 'custom', panel: 'NewRiverTypePick' }],
    // 离开画河：选中的河不要了
    onLeave(): void {
      selectedRiver.value = null;
    },
    watch: (): unknown => selectedRiver.value,
    focus: selectedRiverFocus,
  },
  lake: {
    category: 'water',
    icon: Droplet,
    name: '放湖',
    short: '放湖',
    how: '点击放湖，往外拖定直径',
    // 选中一个湖时，底部条换成这个湖的设置（新湖的大小先收起来）
    size: { ...LAKE, enabled: () => !selectedLake.value },
    bar: () => (selectedLake.value ? [{ kind: 'custom', panel: 'LakeBar' }] : [{ kind: 'custom', panel: 'NewLakeTypePick' }]),
    // 离开放湖：选中的湖不要了
    onLeave(): void {
      selectedLake.value = null;
    },
    watch: (): unknown => [selectedLake.value, lakeSizeDraft.value],
  },
  unwater: {
    category: 'water',
    icon: Trash2,
    name: '删除河湖',
    short: '删河湖',
    how: '点击删除画的河或湖',
    cursor: 'pointer',
  },
} satisfies Record<string, ToolSpec>;
