import type { z } from 'zod';
import { type FieldDesc, builtinOf, contentItems, notBuiltin, registerKind } from '../content/registry';
import { type Culture, type CultureGroup, type Era, MAX_DIMENSIONS, type PopValue, type ValueGroup, cultureGroupSchema, cultureSchema, eraSchema, popValueSchema, valueGroupSchema } from './era';
import { RESOURCE_RULE_FIELDS } from './rules';

// 第二十二轮的四种内容登记进登记表：时代、人口维度的取值、文化组、文化（都放在 small.content，命令是 set_content）。
// 第四十三轮加了取值组（宗教组……，排在取值之前）
// 内置的在时代包里（packs/builtin-tree.ts）：生成人文之前由界面加进世界（第三十轮），生成只读世界里的

const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

// 世界里改过、加的项（与内置的一模一样的不导出）
const changed = <T>(kind: string, items: Record<string, T>): T[] => notBuiltin(kind, Object.values(items));

// 偏好：按格的条件加一个倍数
export const PREF_FIELDS: readonly FieldDesc[] = [{ key: 'factor', label: '倍数', type: 'number', min: 0, max: 20, step: 0.1, hint: '满足时宜居度乘以它' }, ...RESOURCE_RULE_FIELDS];
const PREFS: FieldDesc = { key: 'prefs', label: '喜欢的地方', type: 'list', optional: true, of: PREF_FIELDS, dep: 'strip', hint: '满足条件时宜居度乘以倍数' };

const ERA_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color', optional: true },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  {
    key: 'dimensions',
    label: '变量',
    type: 'list',
    hint: `文化之外的，最多 ${MAX_DIMENSIONS} 维`,
    of: [
      { key: 'id', label: 'id', type: 'text' },
      { key: 'label', label: '名字', type: 'text', hint: '宗教、种族……' },
      { key: 'required', label: '每人都有', type: 'bool', optional: true },
    ],
  },
  { key: 'popDensity', label: '人口密度', type: 'number', min: 0.001, max: 10000, step: 0.1, unit: '人/km²', hint: '每平方千米陆地几个人' },
  { key: 'sparsity', label: '聚居', type: 'number', min: 0.5, max: 5, step: 0.1, hint: '越大人越挤在好地方' },
  { key: 'urbanization', label: '城市化率', type: 'number', min: 0, max: 1, step: 0.01, unit: '%', hint: '住在城里的人' },
  {
    key: 'unclaimed',
    label: '无主地',
    type: 'json',
    of: [
      { key: 'minHabitability', label: '宜居度下限', type: 'number', min: 0, max: 1, step: 0.01, hint: '低于它的地方人少' },
      { key: 'nomads', label: '游牧', type: 'number', min: 0, max: 1, step: 0.05, unit: '%', hint: '那些地方的人口是几成' },
      { key: 'bandKm', label: '划进国家', type: 'number', optional: true, min: 0, max: 5000, step: 10, unit: 'km', hint: '国境外这么宽划进国家' },
    ],
  },
  { key: 'seaClaimKm', label: '领海', type: 'number', min: 0, max: 2000, step: 10, unit: 'km', hint: '0 是海不归国家' },
  { key: 'countryKm2', label: '国家大小', type: 'number', optional: true, min: 1000, max: 1e9, step: 10000, unit: 'km²', hint: '一国平均占的能住人的地' },
  {
    key: 'years',
    label: '年份',
    type: 'tuple',
    optional: true,
    hint: '建国年份在这里面',
    items: [
      { key: 'from', label: '最早', type: 'number', min: -100000, max: 100000, step: 1 },
      { key: 'now', label: '现在', type: 'number', min: -100000, max: 100000, step: 1 },
    ],
    default: [500, 1000],
  },
  {
    key: 'tiers',
    label: '国家等级的比例',
    type: 'map',
    optional: true,
    keyRef: 'countryTier',
    dep: 'strip',
    value: { key: 'value', label: '比例', type: 'number', min: 0, max: 100, step: 0.1 },
    hint: '拖分界改；0 的等级不出现',
  },
  {
    key: 'patterns',
    label: '国家格局',
    type: 'list',
    optional: true,
    hint: '没列附庸时照样有附庸',
    of: [
      { key: 'pattern', label: '格局', type: 'text', ref: 'countryPattern', dep: 'auto', follow: true },
      { key: 'amount', label: '多少', type: 'number', optional: true, min: 0, max: 20, step: 0.1, hint: '空着时用格局的' },
    ],
  },
  { key: 'nationalism', label: '按文化分国', type: 'number', optional: true, min: 0, max: 1, step: 0.05, hint: '越大国界越跟着文化走' },
  {
    key: 'relations',
    label: '集团的称号',
    type: 'json',
    optional: true,
    of: [
      {
        key: 'titles',
        label: '称号',
        type: 'json',
        optional: true,
        hint: '盟主的地名加上称号；几种时按种子挑',
        of: [
          { key: 'empire', label: '帝国', type: 'titleList', optional: true },
          { key: 'federation', label: '联邦', type: 'titleList', optional: true },
          { key: 'alliance', label: '同盟', type: 'titleList', optional: true },
          { key: 'member', label: '成员邦', type: 'titleList', optional: true },
        ],
      },
    ],
  },
];

const VALUE_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'dimension', label: '变量', type: 'text', ref: 'dimension', hint: '时代里的变量：宗教……' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '外文名', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'group', label: '组', type: 'text', optional: true, ref: 'valueGroup', hint: '取值组：同组是异端，不同组是异教' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  PREFS,
];

// 取值组（第四十三轮）：宗教组……
const VALUE_GROUP_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'dimension', label: '变量', type: 'text', ref: 'dimension', hint: '时代里的变量：宗教……' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '外文名', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
];

// 倾向（第四十三轮起文化组也有）：不分时代的、按时代的
// 第四十五轮起资源库里画成一张表（行是维度，每行是取值与权重），表上面选时代
const TENDENCIES: FieldDesc = { key: 'tendencies', label: '倾向', type: 'tendencies', optional: true, dep: 'strip', hint: '每一维更可能是哪些取值（政体也算一维）' };
const ERA_TENDENCIES: FieldDesc = { key: 'eraTendencies', label: '按时代的倾向', type: 'tendencies', byEra: true, optional: true, dep: 'strip', hint: '写了的那几维换掉不分时代的' };

const GROUP_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '外文名', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'nameStyle', label: '地名风格', type: 'text', optional: true, ref: 'nameStyle', dep: 'auto', hint: '组里文化默认的地名风格' },
  { key: 'weight', label: '多少', type: 'number', optional: true, min: 0, max: 1000, step: 0.1, hint: '各组占多少；0 不参与' },
  { ...TENDENCIES, hint: '组里文化默认的倾向（政体也算一维）' },
  ERA_TENDENCIES,
  PREFS,
];

const CULTURE_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'group', label: '文化组', type: 'text', ref: 'cultureGroup' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '外文名', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'nameStyle', label: '地名风格', type: 'text', optional: true, ref: 'nameStyle', dep: 'auto', hint: '空着时用文化组的' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'weight', label: '多少', type: 'number', optional: true, min: 0, max: 1000, step: 0.1, hint: '在组里占多少；省略为 1' },
  { ...TENDENCIES, hint: '只写与文化组不同的维度' },
  ERA_TENDENCIES,
  PREFS,
];

// 由 human/kinds.ts 在地形类别、资源之后调用
export function registerPopKinds(): void {
  registerKind<Era>({
    id: 'era',
    label: '时代',
    short: '时代',
    order: 37,
    store: 'content',
    maxInWorld: 32,
    schema: eraSchema as unknown as z.ZodType<Era>,
    inWorld: (w) => Object.values(contentItems<Era>(w.small, 'era')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-era', name: '新时代', dimensions: [{ id: 'religion', label: '宗教', required: true }], popDensity: 2, sparsity: 1.5, urbanization: 0.1, unclaimed: { minHabitability: 0.05, nomads: 0.3 }, seaClaimKm: 0 }),
    fields: ERA_FIELDS,
    pack: {
      key: 'eras',
      max: 32,
      listed: true,
      checked: true,
      withId: (e, id, from) => (id === from ? e : { ...e, id, name: renamed(e.name, id, from) }),
      fromWorld: (w) => changed('era', contentItems<Era>(w.small, 'era')).map((e) => structuredClone(e)),
      exportItem: (e) => structuredClone(e),
    },
  });

  registerKind<ValueGroup>({
    id: 'valueGroup',
    label: '取值组',
    short: '取值组',
    order: 37.5,
    store: 'content',
    maxInWorld: 128,
    schema: valueGroupSchema as unknown as z.ZodType<ValueGroup>,
    inWorld: (w) => Object.values(contentItems<ValueGroup>(w.small, 'valueGroup')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-value-group', dimension: 'religion', name: '新取值组', color: '#999999' }),
    fields: VALUE_GROUP_FIELDS,
    pack: {
      key: 'valueGroups',
      max: 128,
      listed: true,
      checked: true,
      withId: (g, id, from) => (id === from ? g : { ...g, id, name: renamed(g.name, id, from) }),
      fromWorld: (w) => changed('valueGroup', contentItems<ValueGroup>(w.small, 'valueGroup')).map((g) => structuredClone(g)),
      exportItem: (g) => structuredClone(g),
    },
  });

  registerKind<PopValue>({
    id: 'popValue',
    label: '人口维度的取值',
    short: '取值',
    order: 38,
    store: 'content',
    maxInWorld: 512,
    schema: popValueSchema as unknown as z.ZodType<PopValue>,
    inWorld: (w) => Object.values(contentItems<PopValue>(w.small, 'popValue')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-value', dimension: 'religion', name: '新取值', color: '#999999' }),
    fields: VALUE_FIELDS,
    pack: {
      key: 'popValues',
      max: 512,
      listed: true,
      checked: true,
      withId: (v, id, from) => (id === from ? v : { ...v, id, name: renamed(v.name, id, from) }),
      fromWorld: (w) => changed('popValue', contentItems<PopValue>(w.small, 'popValue')).map((v) => structuredClone(v)),
      exportItem: (v) => structuredClone(v),
    },
  });

  registerKind<CultureGroup>({
    id: 'cultureGroup',
    label: '文化组',
    short: '文化组',
    order: 39,
    store: 'content',
    maxInWorld: 128,
    schema: cultureGroupSchema as unknown as z.ZodType<CultureGroup>,
    inWorld: (w) => Object.values(contentItems<CultureGroup>(w.small, 'cultureGroup')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-group', name: '新文化组', color: '#999999' }),
    fields: GROUP_FIELDS,
    pack: {
      key: 'cultureGroups',
      max: 128,
      listed: true,
      checked: true,
      // 同一组在不同的库里只差比重时算同一项（见 refs.ts 的 sameContent）
      sameIgnore: ['weight'],
      withId: (g, id, from) => (id === from ? g : { ...g, id, name: renamed(g.name, id, from) }),
      fromWorld: (w) => changed('cultureGroup', contentItems<CultureGroup>(w.small, 'cultureGroup')).map((g) => structuredClone(g)),
      exportItem: (g) => structuredClone(g),
    },
  });

  registerKind<Culture>({
    id: 'culture',
    label: '文化',
    short: '文化',
    order: 40,
    store: 'content',
    maxInWorld: 1024,
    schema: cultureSchema as unknown as z.ZodType<Culture>,
    inWorld: (w) => Object.values(contentItems<Culture>(w.small, 'culture')),
    dirty: () => 'human',
    blank: () => ({ id: 'my-culture', group: 'chinese', name: '新文化', color: '#999999' }),
    notes: (c) => (c.nameStyle === undefined || builtinOf<{ id: string }>('nameStyle').some((s) => s.id === c.nameStyle) ? [] : [`地名风格“${c.nameStyle}”不是内置的：世界里要先启用它`]),
    fields: CULTURE_FIELDS,
    pack: {
      key: 'cultures',
      max: 1024,
      listed: true,
      checked: true,
      withId: (c, id, from) => (id === from ? c : { ...c, id, name: renamed(c.name, id, from) }),
      fromWorld: (w) => changed('culture', contentItems<Culture>(w.small, 'culture')).map((c) => structuredClone(c)),
      exportItem: (c) => structuredClone(c),
    },
  });
}
