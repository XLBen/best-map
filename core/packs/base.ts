import type { CellRule } from '../human/rules';
import type { Resource, ResourceCategory } from '../human/resources';
import type { TerrainClass } from '../human/terrain-class';
import type { IslandType } from '../island-types';

// “通用 ▸ 基础”里由代码写出的几样（第三十轮以前它们总在世界里，现在和别的内容一样从资源包加进世界，新建时默认勾上“基础”）：
// 地形类别、通用资源（奇幻的一套在“奇幻 ▸ 资源”）、岛的种类。城市等级、地标、点的类型在 settlements/ 的 JSON 里，
// 中文·默认在 names/zh-default.json。只在主线程用（资源库、向导）：计算 Worker 只读世界里的内容。
// 宜居度的倍数（habitability）以前按 id 查 human/habitability.ts 的 CLASS_HABITABILITY，现在写在类别自己身上（数值相同）

// ---------- 地形类别（第二十一轮，见 human/terrain-class.ts） ----------

const cls = (id: string, name: string, color: string, terrain: string, priority: number, rules: CellRule[], extra: Partial<TerrainClass> = {}): TerrainClass => ({ id, name, color, terrain, priority, rules, ...extra });

// 内置的一套（第二十七轮起只管起伏：平原、丘陵、高原、山地、山峰，按高度、坡度算；森林、沙漠、沼泽、冻原、冰川……是生态，
// 不再是地形类别）。阈值按生成的世界标定：陆地的坡度中位数约 1.3 m/km、九成以下约 9；海拔四分之三以下约 900 m
export const BUILTIN_CLASSES: readonly TerrainClass[] = [
  cls('plains', '平原', '#c9d88f', 'plains', 0, [], { habitability: 1, movement: 1, fallback: true, description: '低平的地方（别的几类都不是时）' }),
  cls('hills', '丘陵', '#b79a68', 'hills', 50, [{ slopeMin: 4.5 }, { elevMin: 700, slopeMin: 2.5 }], { habitability: 0.92, movement: 1.5, ore: true, description: '起伏的低山：坡度 4.5 m/km 以上，或 700 m 以上、坡度 2.5 以上' }),
  cls('highlands', '高原', '#c8ad84', 'highlands', 65, [{ elevMin: 1100, slopeMax: 4 }], { habitability: 0.82, movement: 1.3, ore: true, description: '高而平：1100 m 以上、坡度不到 4 m/km' }),
  cls('mountains', '山地', '#8e7d6c', 'mountains', 70, [{ elevMin: 1900 }, { elevMin: 1100, slopeMin: 7 }], { habitability: 0.5, movement: 2.5, ore: true, peaks: true, description: '1900 m 以上，或 1100 m 以上、坡度 7 m/km 以上' }),
  cls('peaks', '山峰', '#5f5550', 'mountains', 80, [{ elevMin: 3000, slopeMin: 8 }, { elevMin: 4200, slopeMin: 3 }], { habitability: 0.09, movement: 4, ore: true, peaks: true, description: '最高最陡的山：3000 m 以上、坡度 8 以上，或 4200 m 以上' }),
];

// ---------- 资源（第二十一轮，见 human/resources.ts） ----------

const res = (id: string, name: string, color: string, category: ResourceCategory, rarity: number, rules: CellRule[], extra: Partial<Resource> = {}): Resource => ({
  id,
  name,
  color,
  icon: id,
  category,
  rules,
  rarity,
  weight: 1,
  cluster: 300,
  ...extra,
});

// 第二十七轮：地形类别只管起伏，植被按生态的地形（terrain）写；原来的植被类别只在平地上（起伏优先），所以多半带着 classes: ['plains']
const ROCK = ['hills', 'mountains', 'peaks', 'highlands'];
const GRASS = ['steppe', 'savanna'];
// 粮食：草原与灌木（林地另算，湿润指数 0.8 以上的密林不算）
const GRASS_FIELDS = ['steppe', 'savanna', 'hills'];
const WOODED = ['forest', 'jungle'];
// 冰川上（年均温 −18 °C 以下，原来的“冰川”类别）不出矿
const ICE = -18;

// 内置的通用一套
export const GENERAL_RESOURCES: readonly Resource[] = [
  res('grain', '粮食', '#e8c547', 'farm', 0.5, [{ classes: ['plains'], terrain: GRASS_FIELDS, tempMin: 2, moistMin: 0.45 }, { classes: ['plains'], terrain: ['forest'], tempMin: 2, moistMin: 0.45, moistMax: 0.8 }, { classes: ['plains'], terrain: GRASS, moistMax: 0.35, river: true, tempMin: 5 }, { classes: ['plains'], terrain: ['desert'], river: true, tempMin: 5 }], { weight: 1.2, cluster: 400 }),
  res('livestock', '牲畜', '#c98d5a', 'herd', 0.45, [{ classes: ['plains'], terrain: GRASS }, { classes: ['hills', 'highlands'], tempMin: ICE }, { classes: ['plains'], biomes: ['tundra'], moistMax: 0.8 }], { cluster: 450 }),
  res('fish', '鱼', '#4f9fd6', 'fish', 0.5, [{ coast: true, tempMin: -8, elevMax: 800 }, { lake: true }, { river: true, classes: ['plains'], terrain: ['marsh', 'jungle'] }, { river: true, classes: ['plains'], terrain: ['forest'], moistMin: 0.8 }, { river: true, classes: ['plains'], terrain: GRASS, moistMin: 0.4, elevMax: 500 }], { weight: 1.3, cluster: 250 }),
  res('wood', '木材', '#7a5a35', 'wood', 0.5, [{ classes: ['plains'], terrain: WOODED }, { classes: ['plains'], biomes: ['shrubland'] }], { weight: 1.1, cluster: 350 }),
  res('salt', '盐', '#e9e4dc', 'ore', 0.15, [{ classes: ['plains'], terrain: ['desert', ...GRASS], moistMax: 0.25 }, { coast: true, moistMax: 0.6, tempMin: 12 }], { weight: 1.5, cluster: 250 }),
  res('stone', '石料', '#a3a09a', 'ore', 0.18, [{ classes: ROCK, tempMin: ICE }], { cluster: 250 }),
  res('iron', '铁', '#8a5446', 'ore', 0.2, [{ classes: ROCK, tempMin: ICE }, { classes: ['plains'], terrain: ['marsh'] }], { weight: 1.4, cluster: 350 }),
  res('copper', '铜', '#c8733b', 'ore', 0.12, [{ classes: ROCK, tempMin: ICE }], { weight: 1.5, cluster: 300 }),
  res('tin', '锡', '#b7bcc4', 'ore', 0.05, [{ classes: ['hills', 'mountains'], tempMin: ICE }], { weight: 2, cluster: 250 }),
  res('gold', '金', '#f2c230', 'ore', 0.04, [{ classes: ['hills', 'mountains', 'peaks'], tempMin: ICE }, { river: true, classes: ['hills', 'mountains'], tempMin: ICE }], { weight: 3, cluster: 200 }),
  res('silver', '银', '#c9ced6', 'ore', 0.05, [{ classes: ['mountains', 'peaks', 'hills'], tempMin: ICE }], { weight: 2.5, cluster: 200 }),
  res('coal', '煤', '#3b3a3a', 'ore', 0.08, [{ classes: ['hills', 'mountains'], tempMin: ICE }, { classes: ['plains'], terrain: ['forest'] }], { weight: 1.6, cluster: 400 }),
  res('gems', '宝石', '#b5427a', 'luxury', 0.03, [{ classes: ['mountains', 'peaks'], tempMin: ICE }, { classes: ['hills'], tempMin: 18 }, { classes: ['plains'], terrain: ['jungle'], tempMin: 18 }], { weight: 3, cluster: 150 }),
  res('spices', '香料', '#d0612c', 'luxury', 0.2, [{ classes: ['plains'], terrain: ['forest', 'hills', 'jungle'], tempMin: 20, moistMin: 0.9 }], { weight: 1.8, cluster: 300 }),
  res('fur', '毛皮', '#8c6b4f', 'wood', 0.3, [{ classes: ['plains'], terrain: ['forest'], tempMax: 4 }, { classes: ['plains'], biomes: ['tundra'], tempMax: 4 }], { weight: 1.3, cluster: 400 }),
  res('wine', '葡萄酒', '#7b2340', 'farm', 0.15, [{ classes: ['hills'], tempMin: 10, tempMax: 21, moistMin: 0.3, moistMax: 1.1 }, { classes: ['plains'], terrain: ['forest', 'hills'], tempMin: 10, tempMax: 21, moistMin: 0.3, moistMax: 0.8 }, { classes: ['plains'], terrain: GRASS, tempMin: 10, tempMax: 21, moistMin: 0.4, moistMax: 0.8, elevMax: 500 }], { weight: 1.6, cluster: 250 }),
  res('silk', '丝', '#e6cfe0', 'luxury', 0.08, [{ classes: ['plains', 'hills'], terrain: ['forest', 'hills'], tempMin: 12, tempMax: 25, moistMin: 0.8 }], { weight: 2, cluster: 250 }),
  res('tea', '茶', '#5c8f3c', 'farm', 0.12, [{ classes: ['hills', 'highlands'], tempMin: 13, tempMax: 26, moistMin: 1 }], { weight: 1.8, cluster: 250 }),
];

// 内置的奇幻一套（默认不在，在仓库里启用）
export const FANTASY_RESOURCES: readonly Resource[] = [
  res('mithril', '秘银', '#9fd3e6', 'magic', 0.03, [{ classes: ['mountains', 'peaks'], elevMin: 2200, tempMin: ICE }], { weight: 4, cluster: 200 }),
  res('mana-crystal', '魔晶', '#8e5cd9', 'magic', 0.03, [{ classes: ROCK }, { classes: ['plains'], terrain: ['desert'] }, { tempMax: ICE }], { weight: 3.5, cluster: 250 }),
  res('dragonbone', '龙骨', '#d8cfb4', 'magic', 0.02, [{ classes: ['mountains', 'highlands'], moistMax: 0.5 }, { classes: ['plains'], terrain: ['desert'] }, { classes: ['plains'], terrain: [...GRASS, 'hills'], moistMax: 0.35 }], { weight: 4, cluster: 300 }),
  res('spiritwood', '灵木', '#4fbf8f', 'magic', 0.04, [{ classes: ['plains'], terrain: ['forest'], moistMin: 0.8 }, { classes: ['plains'], terrain: ['jungle'] }], { weight: 3, cluster: 250 }),
  res('star-iron', '星陨铁', '#5d6a8f', 'magic', 0.01, [{}], { weight: 5, cluster: 150 }),
];

// ---------- 岛的种类（第十四轮，见 island-types.ts） ----------

// 内置的五种（与自己的用同一套说法）。第三十轮起是普通内容：世界里的编号按世界里的先后（新建时按这里的先后加进来，
// 大陆岛是 1、低平岛 2、珊瑚岛 3、小礁 4、碎岛 5，与以前的固定编号相同）
export const BUILTIN_ISLAND_TYPES: readonly IslandType[] = [
  { id: 'continental', name: '大陆岛', hint: '形状不规则，有丘陵', shape: 'rugged', height: 'hilly', province: 'land' },
  { id: 'low', name: '低平岛', hint: '平坦低矮，多沙洲和沼泽', shape: 'long', height: 'flat', color: 'marsh', rock: 3.2, province: 'land' },
  { id: 'atoll', name: '珊瑚岛', hint: '环形白沙岛，中间是青绿的浅潟湖', shape: 'ring', height: 'flat', color: 'coral', rock: 4.8, province: 'land' },
  { id: 'reef', name: '小礁', hint: '一格的白沙小岛，归海省', shape: 'cell', height: 'flat', color: 'coral', rock: 4.3, province: 'sea' },
  // 第十八轮：一片比一格还小的碎岛（格还是海，只是画出来；归海省，一片碎岛起一个列岛 / 群岛的名字）
  { id: 'shards', name: '碎岛', hint: '比一格还小的碎岛，归海省', shape: 'frag', height: 'flat', province: 'sea' },
];
