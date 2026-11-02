import type { z } from 'zod';
import { type FieldDesc, contentItems, notBuiltin, registerKind } from '../content/registry';
import { type Faction, type Government, factionSchema, governmentSchema } from './government';

// 第二十三轮的两种内容登记进登记表：政体、派系（都放在 small.content，命令是 set_content）。
// 内置的在时代包的“政体”“派系”小包里（packs/builtin-tree.ts）：生成国家之前由界面加进世界，生成只读世界里的

const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

// 换说法的一条（第四十三轮，仿 EU4 的 government_names）
const NAME_RULE_FIELDS: readonly FieldDesc[] = [
  { key: 'cultureGroups', label: '文化组', type: 'tags', optional: true, ref: 'cultureGroup', hint: '主流文化在这几组之一' },
  { key: 'cultures', label: '文化', type: 'tags', optional: true, ref: 'culture' },
  { key: 'valueGroups', label: '取值组', type: 'tags', optional: true, ref: 'valueGroup', hint: '宗教组……' },
  { key: 'values', label: '取值', type: 'tags', optional: true, ref: 'popValue', hint: '宗教……' },
  { key: 'titles', label: '国家称号', type: 'title', optional: true, keyRef: 'countryTier', dep: 'strip', hint: '按等级' },
  { key: 'rulers', label: '统治者称号', type: 'title', optional: true, keyRef: 'countryTier', dep: 'strip', hint: '按等级' },
];

// 限谁用的一条（第四十四轮）
const ONLY_FIELDS: readonly FieldDesc[] = NAME_RULE_FIELDS.filter((f) => f.key !== 'titles' && f.key !== 'rulers');

const GOV_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'category', label: '类别', type: 'tags', ref: 'govCategory', hint: 'monarchy、republic、theocracy、tribal、empire……' },
  { key: 'color', label: '颜色', type: 'color', optional: true },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'titles', label: '国家称号', type: 'title', keyRef: 'countryTier', dep: 'strip', hint: '按国家的等级（没写的等级用最近的一级）；只写一种时各等级都用它' },
  { key: 'rulers', label: '统治者称号', type: 'title', optional: true, keyRef: 'countryTier', dep: 'strip', hint: '写法同国家称号' },
  { key: 'names', label: '换说法', type: 'list', optional: true, of: NAME_RULE_FIELDS, dep: 'strip', hint: '按文化组、宗教……换称号；第一条满足的起作用' },
  { key: 'only', label: '限谁用', type: 'list', optional: true, of: ONLY_FIELDS, dep: 'auto', hint: '满足其中一条的国家才能用（伊克塔只给穆斯林）；不写时谁都能用' },
  { key: 'weight', label: '多见', type: 'number', optional: true, min: 0, max: 100, step: 0.1, hint: '省略为 1' },
  { key: 'size', label: '国土', type: 'number', min: 0.05, max: 10, step: 0.05, hint: '1 是平均' },
  { key: 'expansion', label: '扩张性', type: 'number', min: 0, max: 1, step: 0.05, hint: '越大越多吞进异族的地方' },
  { key: 'coastal', label: '偏海岸', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'urbanization', label: '城市化', type: 'number', min: 0, max: 5, step: 0.1, hint: '首都一带人多多少，1 是平常' },
  { key: 'cohesion', label: '紧凑', type: 'number', min: 0, max: 1, step: 0.05, hint: '越大越不跨海' },
  { key: 'vassals', label: '收附庸', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'nomadic', label: '游牧', type: 'number', min: 0, max: 1, step: 0.05, hint: '能占荒凉的地方' },
  { key: 'emblems', label: '旗上的纹章', type: 'tags', optional: true },
  { key: 'layouts', label: '旗的样式', type: 'tags', optional: true },
];

const DRIVER_FIELDS: readonly FieldDesc[] = [
  { key: 'weight', label: '权重', type: 'number', min: -10, max: 10, step: 0.1, hint: '这部分人的比例乘以它' },
  { key: 'dimension', label: '维度', type: 'text', optional: true, ref: 'dimension' },
  { key: 'value', label: '取值', type: 'text', optional: true, ref: 'popValue' },
  { key: 'culture', label: '文化', type: 'text', optional: true, ref: 'culture' },
  { key: 'cultureGroup', label: '文化组', type: 'text', optional: true, ref: 'cultureGroup' },
  { key: 'primary', label: '主流文化', type: 'bool', optional: true },
  { key: 'minority', label: '少数群体', type: 'bool', optional: true },
  { key: 'coastal', label: '住在海边', type: 'bool', optional: true },
  {
    key: 'faith',
    label: '与国教',
    type: 'enum',
    optional: true,
    options: [
      { value: 'same', label: '信国教' },
      { value: 'heretic', label: '异端（同组不同派）' },
      { value: 'heathen', label: '异教（不同组）' },
    ],
    hint: '维度省略时是宗教',
  },
];

const FACTION_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'base', label: '基础', type: 'map', keyRef: 'govCategory', value: { key: 'value', label: '影响力', type: 'number', min: 0, max: 10, step: 0.1 }, hint: '政体的类别 → 影响力；default 是别的类别' },
  { key: 'drivers', label: '来自人口', type: 'list', optional: true, of: DRIVER_FIELDS, dep: 'strip', hint: '这部分人越多，影响力越大' },
];

// 由 human/kinds.ts 在第二十二轮的四种之后调用
export function registerGovKinds(): void {
  registerKind<Government>({
    id: 'government',
    label: '政体',
    short: '政体',
    order: 41,
    store: 'content',
    maxInWorld: 128,
    schema: governmentSchema as unknown as z.ZodType<Government>,
    inWorld: (w) => Object.values(contentItems<Government>(w.small, 'government')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-government', name: '新政体', category: ['monarchy'], titles: { medium: '公国', large: '王国', empire: '帝国' }, rulers: { medium: '公爵', large: '国王', empire: '皇帝' }, size: 1, expansion: 0.3, coastal: 0, urbanization: 1, cohesion: 0.5, vassals: 0.2, nomadic: 0 }),
    fields: GOV_FIELDS,
    pack: {
      key: 'governments',
      max: 128,
      listed: true,
      checked: true,
      withId: (g, id, from) => (id === from ? g : { ...g, id, name: renamed(g.name, id, from) }),
      fromWorld: (w) => notBuiltin('government', Object.values(contentItems<Government>(w.small, 'government'))).map((g) => structuredClone(g)),
      exportItem: (g) => structuredClone(g),
    },
  });

  registerKind<Faction>({
    id: 'faction',
    label: '派系',
    short: '派系',
    order: 42,
    store: 'content',
    maxInWorld: 128,
    schema: factionSchema as unknown as z.ZodType<Faction>,
    inWorld: (w) => Object.values(contentItems<Faction>(w.small, 'faction')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-faction', name: '新派系', color: '#999999', base: { default: 1 } }),
    fields: FACTION_FIELDS,
    pack: {
      key: 'factions',
      max: 128,
      listed: true,
      checked: true,
      withId: (f, id, from) => (id === from ? f : { ...f, id, name: renamed(f.name, id, from) }),
      fromWorld: (w) => notBuiltin('faction', Object.values(contentItems<Faction>(w.small, 'faction'))).map((f) => structuredClone(f)),
      exportItem: (f) => structuredClone(f),
    },
  });
}
