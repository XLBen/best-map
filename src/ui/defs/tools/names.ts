import { LassoSelect, MapPinPlus, PenLine } from 'lucide-preact';
import type { ToolSpec } from '../types';

// 工具表的“地名”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const NAME_TOOLS = {
  rename: {
    category: 'names',
    icon: PenLine,
    name: '改名',
    short: '改名',
    how: '点地图上的名字',
    bar: () => [{ kind: 'custom', panel: 'NamesBar' }],
    cursor: 'pointer',
  },
  area: {
    category: 'names',
    icon: LassoSelect,
    name: '圈地名',
    short: '圈地名',
    how: '按住画圈，给圈里起名',
    bar: () => [{ kind: 'custom', panel: 'NamesBar' }],
  },
  spot: {
    category: 'names',
    icon: MapPinPlus,
    name: '放地名',
    short: '放地名',
    how: '点击放地名，如城镇、渡口',
    bar: () => [{ kind: 'custom', panel: 'NamesBar' }],
  },
} satisfies Record<string, ToolSpec>;
