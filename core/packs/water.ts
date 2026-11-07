import type { LakeType } from '../lake-types';
import type { RiverType } from '../river-types';
import { BIOME_ID as B } from './biome-ids';

// 现实的水系（第五十七轮）：七种河、七种湖，每个库的“水系”小包（见 builtin-tree.ts），新世界默认带上。
// 只有声明式的条件（生态、高度、坡度、气温、流量；湖另有大小），不写脚本，不写起名模板（同一条河的名字和没有这些类型时相同），
// 没有两岸的影响、不挖河床：高程、水、气候、生态都不变，变的只有 riverType、lakeType 和画出来的样子。
// 条件、颜色的理由和量到的数见 docs/dev/history/第57轮.md。
//
// 点名的生态用 biome-ids.ts 的 id（第七十一轮）。
// 必须写明 natural: true（包里没写的加进世界时是关着的）。先后有意义：前面的说了算，所以窄的、一眼看得出的在前。
// 只在主线程用：计算 Worker 只读世界里的内容

// 写的是滑块的数：到两头（高度 0–9000、坡度 0–100、气温 −40–35、流量 0–20000、大小 0–200，water-types.ts 的 WHEN_RANGE，测试查着）是不限

export const REAL_RIVER_TYPES: RiverType[] = [
  {
    id: 'glacier_river',
    name: '冰川河',
    color: '#8cc6e8',
    atlasColor: '#7fa9c4',
    width: 0.9,
    natural: true,
    when: { height: { low: 1200, high: 9000 }, temp: { low: -40, high: -3 } },
  },
  {
    id: 'mountain_torrent',
    name: '山溪急流',
    color: '#4f96cc',
    atlasColor: '#5f8fb0',
    width: 0.8,
    natural: true,
    when: { slope: { low: 10, high: 100 }, flow: { low: 0, high: 1500 } },
  },
  {
    id: 'silt_river',
    name: '泥沙大河',
    color: '#a58a58',
    atlasColor: '#9c7f4f',
    width: 1.15,
    natural: true,
    when: { flow: { low: 2000, high: 20000 }, slope: { low: 0, high: 3 } },
  },
  {
    id: 'dry_bed',
    name: '干河床',
    color: '#c4ae88',
    atlasColor: '#b39f7c',
    style: 'dashed',
    width: 0.7,
    natural: true,
    biomes: [B.desert],
    when: { flow: { low: 0, high: 400 } },
  },
  {
    id: 'seasonal_river',
    name: '季节河',
    color: '#6d8fa6',
    atlasColor: '#6f8a96',
    style: 'dashed',
    width: 0.85,
    natural: true,
    biomes: [B.desert, B.savanna, B.shrubland],
    when: { flow: { low: 0, high: 600 } },
  },
  {
    id: 'swamp_meander',
    name: '沼泽曲流',
    color: '#3f7f78',
    atlasColor: '#4f7f6f',
    natural: true,
    biomes: [B.wetland],
    when: { slope: { low: 0, high: 1 }, flow: { low: 250, high: 20000 } },
  },
  {
    id: 'blackwater_river',
    name: '黑水河',
    color: '#1f3044',
    atlasColor: '#30384a',
    natural: true,
    biomes: [B.rainforest, B.monsoonForest],
    when: { slope: { low: 0, high: 3 } },
  },
];

export const REAL_LAKE_TYPES: LakeType[] = [
  {
    id: 'glacial_lake',
    name: '冰川湖',
    color: '#8fc8e4',
    atlasColor: '#88b4c8',
    natural: true,
    when: { temp: { low: -40, high: -3 } },
  },
  {
    id: 'crater_lake',
    name: '火山口湖',
    color: '#2a5f9e',
    atlasColor: '#3f6488',
    natural: true,
    when: { height: { low: 200, high: 9000 }, slope: { low: 5, high: 100 }, size: { low: 0, high: 4 } },
  },
  {
    id: 'alpine_lake',
    name: '高山湖',
    color: '#3f8fb5',
    atlasColor: '#5a93aa',
    natural: true,
    when: { height: { low: 800, high: 9000 } },
  },
  {
    id: 'dry_lake',
    name: '干湖',
    color: '#d8c8a0',
    atlasColor: '#c8b88e',
    style: 'playa',
    natural: true,
    biomes: [B.desert, B.savanna, B.shrubland, B.steppe],
    when: { flow: { low: 0, high: 150 }, temp: { low: 5, high: 35 } },
  },
  {
    id: 'salt_lake',
    name: '盐湖',
    color: '#d6e0dc',
    atlasColor: '#c8d0c8',
    natural: true,
    biomes: [B.desert, B.steppe, B.shrubland],
    when: { flow: { low: 0, high: 400 }, temp: { low: 5, high: 35 } },
  },
  {
    id: 'swamp_lake',
    name: '沼泽湖',
    color: '#4f7a6a',
    atlasColor: '#5f7f6a',
    natural: true,
    biomes: [B.wetland, B.rainforest, B.monsoonForest, B.subtropicalForest, B.temperateForest],
    when: { height: { low: 0, high: 200 }, slope: { low: 0, high: 1 } },
  },
  {
    id: 'oxbow_lake',
    name: '牛轭湖',
    color: '#5c8aa0',
    atlasColor: '#6d90a0',
    natural: true,
    when: { flow: { low: 1000, high: 20000 }, slope: { low: 0, high: 1 }, size: { low: 0, high: 5 } },
  },
];
