import { Brush, Dices, Hammer, LandPlot, MountainSnow, TreePalm, Waypoints } from 'lucide-preact';
import { islandSizeRangeKm } from '../../../../core/terrain';
import { options } from '../../../state';
import { RELIEF_MAX } from '../tool-values';
import { fmtKm, BRUSH, ISLAND, CHAIN_SIZE, percent } from '../tool-sliders';
import type { ToolSpec } from '../types';

// 工具表的“地形”一类（第七十轮从 defs/tools.ts 按类分出来）：只写工具是什么，先后就是这一类里的先后（底部工具条上的位置、数字键）
export const TERRAIN_TOOLS = {
  land: {
    category: 'terrain',
    icon: Brush,
    name: '画陆地 / 海',
    short: '陆海',
    how: '按住涂陆地或海；Shift 反过来',
    size: { ...BRUSH, enabled: () => options.value.landShape === 'brush' },
    bar: () => [
      {
        kind: 'choice',
        key: 'landMode',
        options: [
          { value: 'land', label: '画陆地' },
          { value: 'sea', label: '画海' },
        ],
      },
      {
        kind: 'choice',
        key: 'landShape',
        options: [
          { value: 'brush', label: '画笔', hint: '按住拖动涂' },
          { value: 'lasso', label: '圈一片', hint: '圈住的地方变成陆地或海' },
        ],
      },
    ],
  },
  island: {
    category: 'terrain',
    icon: TreePalm,
    name: '放岛',
    short: '放岛',
    how: '点击放岛，往外拖定直径',
    size: ISLAND,
    // 每放一个岛自动换一个形状（只用鼠标，没有“换个形状”按钮）
    bar: () => [{ kind: 'custom', panel: 'IslandTypePick' }],
  },
  chain: {
    category: 'terrain',
    more: true,
    when: 'chains',
    icon: Waypoints,
    name: '画岛链',
    short: '岛链',
    how: '拖一条线，沿线长出一串岛',
    size: CHAIN_SIZE,
    amount: {
      key: 'chainDensity',
      label: '疏密',
      range: () => [0.4, 2.5],
      scale: 'log',
      snap: (v) => Math.round(v * 20) / 20,
      // 写出岛与岛之间大约隔多远（与 chainIslands 的间距同一个算法：岛的半径 × 2.6 ÷ 疏密）
      // 用岛链自己的大小（第十二轮修正：以前误用了放岛的大小）
      format: (v, w) => `${v < 0.75 ? '稀疏' : v < 1.35 ? '正常' : '密集'} ${percent(v, 1)} · 间距约 ${fmtKm((2.6 * Math.max(islandSizeRangeKm(w, options.value.chainKind)[0], options.value.chainKm)) / v)} km`,
    },
    // 每画一条岛链自动换一种排列（只用鼠标，没有“换个排列”按钮）。碎岛的比例（第十八轮）在种类旁边
    bar: () => [{ kind: 'custom', panel: 'ChainTypePick' }, { kind: 'custom', panel: 'ChainFragSlider' }],
  },
  relief: {
    category: 'terrain',
    icon: MountainSnow,
    name: '堆山 / 压低',
    short: '堆山',
    how: '按住涂，抬高或压低地势',
    size: BRUSH,
    amount: { key: 'reliefAmount', label: '力度', range: () => [0.15, RELIEF_MAX], scale: 'log', snap: (v) => Math.round(v * 100) / 100, format: (v) => percent(v, 0.7) },
    bar: () => [
      {
        kind: 'choice',
        key: 'reliefMode',
        options: [
          { value: 'up', label: '堆山' },
          { value: 'down', label: '压低' },
        ],
      },
    ],
  },
  fragment: {
    // 第十八轮：打碎
    category: 'terrain',
    more: true,
    icon: Hammer,
    name: '打碎',
    short: '打碎',
    how: '按住涂，把陆地打碎',
    size: BRUSH,
    amount: { key: 'fragAmount', label: '力度', range: () => [0.1, 1], scale: 'linear', snap: (v) => Math.round(v * 20) / 20, format: (v) => percent(v, 1) },
    bar: () => [
      {
        kind: 'choice',
        key: 'fragMode',
        options: [
          { value: 'blocks', label: '裂成碎块', hint: '裂成碎块，中间是海峡' },
          { value: 'coast', label: '只打碎海岸', hint: '内陆不动，外面撒碎岛' },
        ],
      },
    ],
  },
  reroll: {
    category: 'terrain',
    more: true,
    icon: Dices,
    name: '重画',
    short: '重画',
    how: '点击，圈里的地形重新随机',
    size: BRUSH,
  },
  terrainClass: {
    // 第二十一轮：画地形类别；第五十八轮：地面跟着升降到这一类的典型高度，力度 0 只改类别
    category: 'terrain',
    more: true,
    when: 'classPainted',
    icon: LandPlot,
    name: '地形类别',
    short: '类别',
    how: '按住涂，改地形类别，地面跟着升降；Alt+点击吸取',
    size: BRUSH,
    amount: { key: 'classStrength', label: '力度', range: () => [0, 1], scale: 'linear', snap: (v) => Math.round(v * 20) / 20, format: (v) => (v > 0 ? `${Math.round(v * 100)}%` : '只改类别') },
    bar: () => [{ kind: 'custom', panel: 'ClassPick' }],
    view: 'terrainClass',
  },
} satisfies Record<string, ToolSpec>;
