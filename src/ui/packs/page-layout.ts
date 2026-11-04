// 首页的排法（第五十九轮，计划里的草图）：哪几段、每段哪几张卡片。
// 'dims' 是时代写的每一维一张（宗教……），'variables' 是时代规则里的变量，'water' 是生态与水系。别的是内容种类的 id。
// 卡片的归属（融入）第六十轮由库的 arrange 决定：homePage 收一张“卡片 → 上级”的表（Inside），这一轮是空的

export type CardDef = 'dims' | 'variables' | 'water' | (string & {});

export const HOME_LAYOUT: readonly { id: string; title: string; cards: readonly CardDef[] }[] = [
  { id: 'human', title: '人文', cards: ['cultureGroup', 'culture', 'nameStyle', 'dims', 'valueGroup', 'variables'] },
  { id: 'politics', title: '政治', cards: ['government', 'faction', 'countryTier', 'countryLayout'] },
  { id: 'settle', title: '城市与地标', cards: ['cityRank', 'landmarkType', 'pointType'] },
  { id: 'geo', title: '地理', cards: ['water', 'islandType', 'planetForm', 'terrainClass', 'resource'] },
  { id: 'look', title: '外观', cards: ['mapStyle'] },
];

// “生态与水系”这一张卡片里面的
export const WATER_KINDS: readonly string[] = ['biome', 'riverType', 'lakeType'];

// 卡片 → 归到哪一张下面
export type Inside = Readonly<Record<string, string | undefined>>;
export const DEFAULT_INSIDE: Inside = {};

// 卡片的图标（页面上换成 lucide，见 PageHome.tsx）
export const CARD_ICON: Record<string, string> = {
  cultureGroup: 'cultureGroup',
  culture: 'culture',
  nameStyle: 'nameStyle',
  valueGroup: 'valueGroup',
  government: 'government',
  faction: 'faction',
  countryTier: 'countryTier',
  countryLayout: 'countryLayout',
  cityRank: 'cityRank',
  landmarkType: 'landmarkType',
  pointType: 'pointType',
  islandType: 'islandType',
  planetForm: 'planetForm',
  terrainClass: 'terrainClass',
  resource: 'resource',
  mapStyle: 'mapStyle',
  biome: 'biome',
  riverType: 'riverType',
  lakeType: 'lakeType',
};
