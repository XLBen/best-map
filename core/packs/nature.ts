import { type BiomeGroup, type ConditionId, HEIGHT_MAX, type Rect, type Species, withCondition, withRect } from '../species';
import { BIOME_ID as B } from './biome-ids';

// 内置的 16 种生态（第八十六轮加了红树林）（每个库的“自然”这个小包，见 builtin-tree.ts）。第三十轮以前新世界自带它们（world.ts 的 defaultSmall），
// 现在和别的内容一样从资源包加进世界（新建时默认勾上“自然”）。只在主线程用：计算 Worker 只读世界里的生态。
//
// 写明“自然生成”（natural: true）：从资源包加进世界时没写的会关掉（packs.ts 的 finalize），普通的生态要照常长。
// 第三十轮：宜居度（habitability）、通行难度（movement）、大类（group）写在生态自己身上，
// 不再由算法按 id 查表（以前的 BIOME_HABITABILITY、BIOME_MOVEMENT、features.ts 的大类）；数值与原来的表逐个相同，结果不变

type Extra = Pick<Species, 'habitability' | 'movement' | 'group' | 'height'>;
const TOP = HEIGHT_MAX;

const make = (id: string, name: string, color: string, terrain: string, competition: number, r: Rect, extra: Extra, conds: ConditionId[] = []): Species => {
  let sp: Species = withRect({ id, name, color, terrain, competition, tolerances: [] }, r);
  for (const c of conds) sp = withCondition(sp, c, true);
  return { ...sp, ...extra, natural: true };
};

// 一套接近地球的默认生态（年均温与湿润程度的分区接近 Whittaker 生物群系图），供架空世界在此基础上修改或替换。
// 第十三轮换了配色：相邻的生态更容易分开（CIEDE2000 最近的相邻一对从约 4 到约 9），仍是自然的颜色
// 第五十五轮：高度范围（海拔，米；表和理由见 docs/dev/history/第55轮.md）。森林线、雪线跟气温走：气温已经随海拔降，这里的上限只拦气候够得着、常识上不会有的地方，
// 下限只有两种高山生态有（低地够冷的地方是苔原、针叶林）。上限要留够：同样的气温在赤道上比中纬度高得多（年均 6 °C 的地方，中纬度约 1200 m，赤道约 3300 m），
// 否则热带的高山上气温、湿度都合适却长不了，出现没有生态的格。沼泽 300 m 以下
export const DEFAULT_SPECIES: Species[] = [
  make(B.ice, '冰盖', '#eef3f7', 'arctic', 8, { t0: -40, t1: -17, m0: 0, m1: 50 }, { habitability: 0.002, movement: 3, group: 'icecap', height: { low: 0, high: TOP } }),
  make(B.tundra, '苔原', '#a8ab8e', 'arctic', 3, { t0: -17, t1: -9, m0: 0.12, m1: 50 }, { habitability: 0.1, movement: 1.3, group: 'tundra', height: { low: 0, high: 1500 } }),
  make(B.taiga, '针叶林', '#3d6a52', 'forest', 3, { t0: -9, t1: 3, m0: 0.55, m1: 50 }, { habitability: 0.31, movement: 1.4, group: 'forest', height: { low: 0, high: 4200 } }),
  make(B.temperateForest, '温带阔叶林', '#8aac5a', 'forest', 3, { t0: 3, t1: 14, m0: 0.9, m1: 50 }, { habitability: 0.72, movement: 1.3, group: 'forest', height: { low: 0, high: 3500 } }),
  make(B.steppe, '温带草原', '#c9c27c', 'steppe', 2, { t0: -6, t1: 16, m0: 0.25, m1: 0.6 }, { habitability: 0.6, movement: 1, height: { low: 0, high: 5000 } }),
  make(B.shrubland, '地中海灌木', '#a08c58', 'hills', 3.5, { t0: 12, t1: 20, m0: 0.3, m1: 0.9 }, { habitability: 0.71, movement: 1.25, height: { low: 0, high: 2500 } }, ['winterRain']),
  make(B.subtropicalForest, '亚热带常绿林', '#3c8c58', 'forest', 3, { t0: 14, t1: 21, m0: 1.0, m1: 50 }, { habitability: 0.68, movement: 1.4, group: 'forest', height: { low: 0, high: 3000 } }),
  make(B.savanna, '稀树草原', '#d2ad56', 'savanna', 3, { t0: 20, t1: 40, m0: 0.3, m1: 0.72 }, { habitability: 0.57, movement: 1, height: { low: 0, high: 2200 } }),
  make(B.dryForest, '热带干燥林', '#959a3e', 'forest', 3, { t0: 20, t1: 40, m0: 0.72, m1: 1.4 }, { habitability: 0.54, movement: 1.25, group: 'forest', height: { low: 0, high: 1800 } }),
  make(B.monsoonForest, '热带季雨林', '#55a02c', 'jungle', 3.2, { t0: 20, t1: 40, m0: 0.9, m1: 2.5 }, { habitability: 0.53, movement: 1.8, group: 'forest', height: { low: 0, high: 2200 } }, ['summerRain']),
  make(B.rainforest, '热带雨林', '#1d6633', 'jungle', 4, { t0: 22, t1: 40, m0: 1.4, m1: 50 }, { habitability: 0.25, movement: 2, group: 'forest', height: { low: 0, high: 1500 } }),
  make(B.wetland, '沼泽湿地', '#4c8c86', 'marsh', 6, { t0: -2, t1: 40, m0: 0.5, m1: 50 }, { habitability: 0.18, movement: 2, group: 'wetland', height: { low: 0, high: 300 } }, ['wetland', 'flat']),
  make(B.alpineMeadow, '高山草甸', '#9cc08f', 'highlands', 3.5, { t0: -9, t1: -1, m0: 0.4, m1: 50 }, { habitability: 0.2, movement: 1.5, height: { low: 1000, high: TOP } }),
  make(B.alpineTundra, '高山苔原', '#b4aca8', 'arctic', 4, { t0: -17, t1: -6, m0: 0, m1: 50 }, { habitability: 0.04, movement: 2, group: 'tundra', height: { low: 1000, high: TOP } }),
  make(B.desert, '荒漠', '#efd8a8', 'desert', 1, { t0: -6, t1: 40, m0: 0, m1: 0.15 }, { habitability: 0.042, movement: 1.5, group: 'desert', height: { low: 0, high: TOP } }),
  // 第八十六轮：红树林——热带（年均 20 °C 以上）、低平（12 m 以下、平地）、紧挨海（大陆度 0.06 以下才满）的海岸与河口，湿；
  // 竞争力比沼泽强，在热带低平的海岸上占上风
  mangrove(),
];

function mangrove(): Species {
  const sp = make(B.mangrove, '红树林', '#36603a', 'marsh', 7, { t0: 20, t1: 40, m0: 0.6, m1: 50 }, { habitability: 0.12, movement: 2.2, group: 'wetland', height: { low: 0, high: 12 } }, ['flat']);
  return { ...sp, tolerances: [...sp.tolerances, { field: 'continentality', min: 0, optLow: 0, optHigh: 0.06, max: 0.14 }] };
}

// 内置生态里属于某一大类的 id（按上面的先后）。“森林类都算”这样的规则（奇幻的侵占、资源）用它，不再手写一串 id
export function builtinBiomesIn(group: BiomeGroup): string[] {
  return DEFAULT_SPECIES.filter((s) => s.group === group).map((s) => s.id);
}
