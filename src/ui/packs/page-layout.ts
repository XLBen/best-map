// 首页的排法（第五十九轮，计划里的草图）：哪几段、每段哪几张卡片。
// 'dims' 是时代写的每一维一张（宗教……），'variables' 是时代规则里的变量，'ecology' 是生态与水系（第七十一轮以前叫 water）。别的是内容种类的 id。
// 本世界的首页最上面另有一张“生成设置”（第八十一轮，gen-settings.ts、PageGen.tsx），时代的卡片在它下面。
// 卡片的归属（融入）由库的 arrange 决定（第六十轮，core/content/arrange.ts）：homePage 收一张“卡片 → 上级”的表（Inside）。这里列的是都单独成卡时的样子

export type CardDef = 'dims' | 'variables' | 'ecology' | (string & {});

export const HOME_LAYOUT: readonly { id: string; title: string; cards: readonly CardDef[] }[] = [
  { id: 'human', title: '人文', cards: ['cultureGroup', 'culture', 'nameStyle', 'dims', 'valueGroup', 'variables'] },
  { id: 'politics', title: '政治', cards: ['government', 'faction', 'countryTier', 'countryPattern'] },
  { id: 'settle', title: '城市与地标', cards: ['cityRank', 'landmarkType', 'pointType'] },
  { id: 'geo', title: '地理', cards: ['ecology', 'islandType', 'planetForm', 'terrainClass', 'resource', 'provinceRules'] },
  { id: 'look', title: '外观', cards: ['mapStyle'] },
];

// 第九十二轮：这张地图的首页上，融入了上级的这几种也留着自己的卡片（上级照旧写“含……”）：文化是最常找的，
// 不该先想起它在哪个文化组里。库的首页不变（库的安排是库自己的）；登记表、融入的安排都没动
export const WORLD_OWN_CARDS: readonly string[] = ['culture'];

// “生态与水系”这一张卡片里面的
export const ECOLOGY_KINDS: readonly string[] = ['biome', 'riverType', 'lakeType'];

// 卡片 → 归到哪一张下面
export type Inside = Readonly<Record<string, string | undefined>>;

// 卡片的图标（页面上换成 lucide，见 PageHome.tsx）
export const CARD_ICON: Record<string, string> = {
  cultureGroup: 'cultureGroup',
  culture: 'culture',
  nameStyle: 'nameStyle',
  valueGroup: 'valueGroup',
  government: 'government',
  faction: 'faction',
  countryTier: 'countryTier',
  countryPattern: 'countryPattern',
  cityRank: 'cityRank',
  landmarkType: 'landmarkType',
  pointType: 'pointType',
  islandType: 'islandType',
  planetForm: 'planetForm',
  terrainClass: 'terrainClass',
  resource: 'resource',
  mapStyle: 'mapStyle',
  provinceRules: 'provinceRules',
  biome: 'biome',
  riverType: 'riverType',
  lakeType: 'lakeType',
};
