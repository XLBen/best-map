import { PACK_FORMAT, PACK_VERSION, type PackItem, type ResourcePack } from '../packs';
import { FANTASY_BIOMES, FANTASY_FIELDS } from './fantasy-biomes';
import { FANTASY_FORMS } from './fantasy-forms';
import { FANTASY_ISLAND_TYPES } from './fantasy-islands';
import { FANTASY_LAKE_TYPES } from './fantasy-lakes';
import { FANTASY_RIVER_TYPES } from './fantasy-rivers';

// 内置示例资源包“奇幻生态示例”（第三批）：直接是数据，资源库里总在、默认信任，生态抽屉的“添加示例生态…”也用它。
// 生态见 fantasy-biomes.ts，河流类型见 fantasy-rivers.ts（血河、晶川、冥河、熔岩河），湖泊类型见 fantasy-lakes.ts，
// 星球形态见 fantasy-forms.ts（新建世界的向导、调整 → 星球形态 里都列出来），岛的种类见 fantasy-islands.ts（湖心岛）。

export const FANTASY_PACK_ID = 'fantasy';

export const FANTASY_PACK: ResourcePack = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  id: FANTASY_PACK_ID,
  name: '奇幻生态示例',
  author: 'map_2',
  description:
    '五种奇幻生态：水晶丛林、死亡森林、虫群占领区、神圣之地、血腥之地。各带花纹、对周围的影响和自己的地名，长在哪里由脚本决定。' +
    '四种河：血河、晶川、冥河（只能自己画）、熔岩河，各有画法、两岸的影响和自己的地名。' +
    '四种湖：血池、晶湖、冥湖（只能自己选）、熔岩湖。' +
    '一种岛：湖心岛（只能放在湖里，岛的样子由脚本决定）。' +
    '还有三种星球形态：双子大陆、环形内海、极地大陆，新建整个星球时可以选。',
  fields: [...FANTASY_FIELDS],
  biomes: FANTASY_BIOMES,
  riverTypes: FANTASY_RIVER_TYPES as unknown as PackItem[],
  lakeTypes: FANTASY_LAKE_TYPES as unknown as PackItem[],
  islandTypes: FANTASY_ISLAND_TYPES as unknown as PackItem[],
  planetForms: FANTASY_FORMS as unknown as PackItem[],
};
