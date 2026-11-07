import type { Faction } from '../human/government';
import type { Era } from '../human/era';
import type { Link } from './links';

// 引用表的每种内容一条（第四十九轮，见 links.ts）：大部分引用从字段表（FieldDesc 的 ref、keyRef、script、tendencies）推出来，
// 这里是字段表说不清的部分。新登记一种内容必须在这里加一条（links.test.ts 查着），想过了没有别的引用也要写一句，
// 所以以后的轮次不会悄悄漏掉。
//   note      这一种里哪些看着像引用、其实不是
//   provides  这一项还提供什么可以被引用的（时代提供维度：维度不是单独的一项）
//   extra     字段表推不出来的引用（只有隐含的：写在键或值里的 id 都该写进字段表）
// 依赖类别写在字段表的 dep 上（registry.ts 的 LinkClass）。dep: 'gate' 是“限谁用”，缺的目标去掉，全部落空就不能导入：
// 只写在最外层的列表字段上（linkProblems 查着）：government.only、landmarkType.cultureGroups、terrainClass.rules、resource.rules

export interface KindLinks {
  note: string;
  provides?(item: unknown): { kind: string; id: string }[];
  extra?(item: unknown): Link[];
}

// 时代里的维度
export const DIMENSION = 'dimension';
// 倾向里政体那一维：不是时代写的维度，取值是政体
export const GOVERNMENT_DIM = 'government';
// 称号里“其余的”：不是引用
export const DEFAULT_KEY = 'default';
// 写在字段表 ref 里、不是内容种类的：维度、生态的条件（river:x、lake:x、field:x 或内置变量）、
// 政体的类别（标签：不进表，没有“这一项”可以点过去，没人用这个类别也没关系）
export const REF_PSEUDO: ReadonlySet<string> = new Set([DIMENSION, 'tolerance', 'govCategory']);

// 派系的来源写了“与国教”、没写维度时，说的是宗教这一维（见 country-layers.ts）
const FAITH_DIM = 'religion';

export const KIND_LINKS: Readonly<Record<string, KindLinks>> = {
  biome: { note: '耐受条件、脚本、侵占的目标都在字段表里。terrain 是导出用的地形标签；seedKey 是原来的 id，改了名花纹不变，不是引用；起名模板的 {词表} 不属于哪一项' },
  riverType: { note: '“只在这些生态里”、脚本在字段表里。seedKey 同生态；起名模板同生态' },
  lakeType: { note: '同河的种类' },
  islandType: { note: '没有引用。起名模板同生态' },
  planetForm: { note: '脚本在字段表里。base 是固定的六种星球，不是内容' },
  nameStyle: { note: '没有引用：词表、各类地物都是它自己的' },
  terrainClass: { note: '规则里的生态在字段表里（dep: gate，全部落空时不能导入）。规则的 terrain 是生态的地形标签，不是 id；terrain 字段是导出给游戏的名字' },
  resource: { note: '规则里的生态、地形类别在字段表里（dep: gate）。规则的 terrain 是标签；seedKey 同生态' },
  era: {
    note: '国家等级的比例、国家格局（patterns，dep: auto：时代加进来时带上它用的格局）在字段表里。dimensions 是它定义的维度，别的内容引用它们',
    provides: (item) => ((item as Era).dimensions ?? []).map((d) => ({ kind: DIMENSION, id: d.id })),
  },
  valueGroup: { note: '维度在字段表里' },
  popValue: { note: '维度、组、喜欢的地方在字段表里' },
  cultureGroup: { note: '地名风格、倾向、喜欢的地方在字段表里。组里有哪些文化由文化写（culture.group），不是组的依赖' },
  culture: { note: '组、地名风格、倾向、喜欢的地方在字段表里' },
  government: { note: '派系的名单、称号的键、换说法、限谁用（dep: gate）在字段表里。category 是标签；emblems、layouts 是旗帜的纹章和样式（固定的几种），不是格局' },
  faction: {
    note: '来源在字段表里。“与国教”没写维度时隐含宗教这一维（下面的 extra）',
    extra: (item) =>
      ((item as Faction).drivers ?? []).flatMap((d, k): Link[] =>
        d.faith && !d.dimension ? [{ kinds: [DIMENSION], id: FAITH_DIM, cls: 'strip', label: '与国教', path: ['drivers', k, 'faith'], at: 'implicit', drop: ['drivers', k], chain: [{ when: ['drivers'], remove: ['drivers'] }] }] : [],
      ),
  },
  countryTier: { note: '没有引用' },
  countryPattern: { note: '没有引用：module 是代码里的格局模块（countries/patterns.ts），不是内容；参数都是数' },
  cityRank: { note: '没有引用' },
  landmarkType: { note: '文化组（dep: gate）、名字写法的键在字段表里。governments 是政体的类别（标签）；icon 是图标名' },
  pointType: { note: '当作城市的等级在字段表里' },
  mapStyle: { note: '没有引用：只有颜色和画法' },
  provinceRules: { note: '没有引用：只有数和开关' },
  field: { note: '没有引用：一项就是一个名字' },
};
