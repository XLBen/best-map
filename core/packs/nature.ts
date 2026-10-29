import { type ConditionId, type Rect, type Species, withCondition, withRect } from '../species';

// 内置的 13 种生态（“通用 ▸ 自然”这个小包，见 builtin-tree.ts）。第三十轮以前新世界自带它们（world.ts 的 defaultSmall），
// 现在和别的内容一样从资源包加进世界（新建时默认勾上“自然”）。只在主线程用：计算 Worker 只读世界里的生态。
//
// 写明“自然生成”（natural: true）：从资源包加进世界时没写的会关掉（packs.ts 的 finalize），普通的生态要照常长。
// 第三十轮：宜居度（habitability）、通行难度（movement）、大类（group）写在生态自己身上，
// 不再由算法按 id 查表（以前的 BIOME_HABITABILITY、BIOME_MOVEMENT、features.ts 的大类）；数值与原来的表逐个相同，结果不变

type Extra = Pick<Species, 'habitability' | 'movement' | 'group'>;

const make = (id: string, name: string, color: string, terrain: string, competition: number, r: Rect, extra: Extra, conds: ConditionId[] = []): Species => {
  let sp: Species = withRect({ id, name, color, terrain, competition, tolerances: [] }, r);
  for (const c of conds) sp = withCondition(sp, c, true);
  return { ...sp, ...extra, natural: true };
};

// 一套接近地球的默认生态（年均温与湿润程度的分区接近 Whittaker 生物群系图），供架空世界在此基础上修改或替换。
// 第十三轮换了配色：相邻的生态更容易分开（CIEDE2000 最近的相邻一对从约 4 到约 9），仍是自然的颜色
export const DEFAULT_SPECIES: Species[] = [
  make('ice', '冰盖', '#eef3f7', 'arctic', 8, { t0: -40, t1: -17, m0: 0, m1: 50 }, { habitability: 0.002, movement: 3, group: 'icecap' }),
  make('tundra', '苔原', '#a8ab8e', 'arctic', 3, { t0: -17, t1: -9, m0: 0.12, m1: 50 }, { habitability: 0.1, movement: 1.3, group: 'tundra' }),
  make('taiga', '针叶林', '#3d6a52', 'forest', 3, { t0: -9, t1: 3, m0: 0.55, m1: 50 }, { habitability: 0.31, movement: 1.4, group: 'forest' }),
  make('temperate_forest', '温带阔叶林', '#8aac5a', 'forest', 3, { t0: 3, t1: 14, m0: 0.9, m1: 50 }, { habitability: 0.72, movement: 1.3, group: 'forest' }),
  make('steppe', '温带草原', '#c9c27c', 'steppe', 2, { t0: -6, t1: 16, m0: 0.25, m1: 0.6 }, { habitability: 0.6, movement: 1 }),
  make('shrubland', '地中海灌木', '#a08c58', 'hills', 3.5, { t0: 12, t1: 20, m0: 0.3, m1: 0.9 }, { habitability: 0.71, movement: 1.25 }, ['winterRain']),
  make('subtropical_forest', '亚热带常绿林', '#3c8c58', 'forest', 3, { t0: 14, t1: 21, m0: 1.0, m1: 50 }, { habitability: 0.68, movement: 1.4, group: 'forest' }),
  make('savanna', '稀树草原', '#d2ad56', 'savanna', 3, { t0: 20, t1: 40, m0: 0.3, m1: 0.72 }, { habitability: 0.57, movement: 1 }),
  make('dry_forest', '热带干燥林', '#959a3e', 'forest', 3, { t0: 20, t1: 40, m0: 0.72, m1: 1.4 }, { habitability: 0.54, movement: 1.25, group: 'forest' }),
  make('monsoon_forest', '热带季雨林', '#55a02c', 'jungle', 3.2, { t0: 20, t1: 40, m0: 0.9, m1: 2.5 }, { habitability: 0.53, movement: 1.8, group: 'forest' }, ['summerRain']),
  make('rainforest', '热带雨林', '#1d6633', 'jungle', 4, { t0: 22, t1: 40, m0: 1.4, m1: 50 }, { habitability: 0.25, movement: 2, group: 'forest' }),
  make('wetland', '沼泽湿地', '#4c8c86', 'marsh', 6, { t0: -2, t1: 40, m0: 0.5, m1: 50 }, { habitability: 0.18, movement: 2, group: 'wetland' }, ['wetland', 'flat']),
  make('desert', '荒漠', '#efd8a8', 'desert', 1, { t0: -6, t1: 40, m0: 0, m1: 0.15 }, { habitability: 0.042, movement: 1.5, group: 'desert' }),
];
