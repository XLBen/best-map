// 内置生态的 id（第七十一轮）：packs/nature.ts 用它们建那 15 种生态；别的内置数据要点名某几种生态时
// （水系的河湖长在哪些生态里、资源的规则……）也从这里取，不再各写一遍字符串。
// 能按大类（group）说清的不点名：用 nature.ts 的 builtinBiomesIn（比如“森林类”“苔原类”）。
// 这些 id 是存在世界、资源包里的，改了旧数据就对不上：只能加，不能改
export const BIOME_ID = {
  ice: 'ice',
  tundra: 'tundra',
  taiga: 'taiga',
  temperateForest: 'temperate_forest',
  steppe: 'steppe',
  shrubland: 'shrubland',
  subtropicalForest: 'subtropical_forest',
  savanna: 'savanna',
  dryForest: 'dry_forest',
  monsoonForest: 'monsoon_forest',
  rainforest: 'rainforest',
  wetland: 'wetland',
  alpineMeadow: 'alpine_meadow',
  alpineTundra: 'alpine_tundra',
  desert: 'desert',
} as const;
