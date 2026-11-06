import { Building2, Route, Landmark, MapPin } from 'lucide-preact';
import type { ToolSpec } from '../types';

// 工具表的“城市”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const SETTLEMENT_TOOLS = {
  // ---------- 第二十四轮：城市、道路、地标、自定义点 ----------
  city: {
    category: 'settlements',
    icon: Building2,
    name: '城市',
    short: '城市',
    how: '点空地新建城市，点城市打开档案，拖动挪走',
    bar: () => [{ kind: 'custom', panel: 'NoCityChip' }, { kind: 'custom', panel: 'CityBar' }, { kind: 'custom', panel: 'CityPointChip' }],
    cursor: 'pointer',
  },
  road: {
    category: 'settlements',
    icon: Route,
    name: '道路',
    short: '道路',
    how: '按住画道路；点道路选中，拖控制点改走向',
    bar: () => [{ kind: 'custom', panel: 'RoadBar' }],
  },
  landmark: {
    category: 'settlements',
    icon: Landmark,
    name: '地标',
    short: '地标',
    how: '点击放地标，点地标打开档案，拖动挪走',
    bar: () => [{ kind: 'custom', panel: 'LandmarkPick' }, { kind: 'custom', panel: 'LandmarkChip' }],
    cursor: 'pointer',
  },
  point: {
    category: 'settlements',
    icon: MapPin,
    name: '自定义点',
    short: '点',
    how: '点击放点，点它打开档案，拖动挪走',
    bar: () => [{ kind: 'custom', panel: 'PointPick' }, { kind: 'custom', panel: 'PointChip' }],
    cursor: 'pointer',
  },
} satisfies Record<string, ToolSpec>;
