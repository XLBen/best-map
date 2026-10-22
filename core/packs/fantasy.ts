import { PACK_FORMAT, PACK_VERSION, type ResourcePack } from '../packs';
import { FANTASY_BIOMES, FANTASY_FIELDS } from './fantasy-biomes';

// 内置示例资源包“奇幻生态示例”（第三批）：直接是数据，资源库里总在、默认信任，生态抽屉的“添加示例生态…”也用它。
// 生态见 fantasy-biomes.ts。河流类型、星球形态由另外两支做好后在这里接上：
// TODO(河流类型那一支)：import { FANTASY_RIVER_TYPES } from './fantasy-rivers'，填进 riverTypes（血河、晶川、冥河、熔岩河）
// TODO(星球形态那一支)：import { FANTASY_FORMS } from './fantasy-forms'，填进 planetForms（双子大陆、环形内海、极地大陆）

export const FANTASY_PACK_ID = 'fantasy';

export const FANTASY_PACK: ResourcePack = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  id: FANTASY_PACK_ID,
  name: '奇幻生态示例',
  author: 'map_2',
  description: '五种奇幻生态：水晶丛林、死亡森林、虫群占领区、神圣之地、血腥之地。各带花纹、对周围的影响和自己的地名，长在哪里由脚本决定。',
  fields: [...FANTASY_FIELDS],
  biomes: FANTASY_BIOMES,
};
