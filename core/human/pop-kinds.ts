import type { z } from 'zod';
import { type FieldDesc, contentItems, registerKind } from '../content/registry';
import { sameItem } from '../content/refs';
import { BUILTIN_STYLES } from '../packs/names';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../packs/eras';
import { type Culture, type CultureGroup, type Era, type PopValue, cultureGroupSchema, cultureSchema, eraSchema, popValueSchema } from './era';
import { RESOURCE_RULE_FIELDS } from './rules';

// 第二十二轮的四种内容登记进登记表：时代、人口维度的取值、文化组、文化（都放在 small.content，命令是 set_content）。
// 内置的不是总在的：仓库里启用，或者生成人文时自动复制进来（见 generate.ts 的 ensureHumanContent）

const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

// 世界里改过、加的项（与内置的一模一样的不导出）
const changed = <T extends { id: string }>(items: Record<string, T>, builtin: readonly T[]): T[] =>
  Object.values(items).filter((x) => {
    const b = builtin.find((y) => y.id === x.id);
    return !b || !sameItem(b, x);
  });

// 偏好：按格的条件加一个倍数
export const PREF_FIELDS: readonly FieldDesc[] = [{ key: 'factor', label: '倍数', type: 'number', min: 0, max: 20, step: 0.1, hint: '满足时宜居度乘以它' }, ...RESOURCE_RULE_FIELDS];
const PREFS: FieldDesc = { key: 'prefs', label: '喜欢的地方', type: 'list', optional: true, of: PREF_FIELDS, hint: '满足条件时宜居度乘以倍数' };

const ERA_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color', optional: true },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  {
    key: 'dimensions',
    label: '人口的维度',
    type: 'list',
    hint: '文化之外的，最多 3 维',
    of: [
      { key: 'id', label: 'id', type: 'text' },
      { key: 'label', label: '名字', type: 'text', hint: '宗教、种族……' },
      { key: 'required', label: '每人都有', type: 'bool', optional: true },
    ],
  },
  { key: 'popDensity', label: '人口密度', type: 'number', min: 0.001, max: 10000, step: 0.1, hint: '人 / km² 陆地' },
  { key: 'sparsity', label: '集中程度', type: 'number', min: 0.5, max: 5, step: 0.1, hint: '大了人挤在最宜居的地方' },
  { key: 'urbanization', label: '城市化率', type: 'number', min: 0, max: 1, step: 0.01 },
  {
    key: 'unclaimed',
    label: '无主地',
    type: 'json',
    of: [
      { key: 'minHabitability', label: '宜居度下限', type: 'number', min: 0, max: 1, step: 0.01, hint: '低于它的地方人少' },
      { key: 'nomads', label: '游牧', type: 'number', min: 0, max: 1, step: 0.05, hint: '那些地方的人口倍数' },
    ],
  },
  { key: 'seaClaimKm', label: '领海', type: 'number', min: 0, max: 2000, step: 10, hint: 'km；0 是海不归国家' },
  { key: 'defaultGroups', label: '默认的文化组', type: 'weighted', optional: true },
  { key: 'cultureGroups', label: '能用的文化组', type: 'tags', optional: true, hint: '空着时不限' },
  { key: 'governments', label: '政体', type: 'tags', optional: true },
  { key: 'factions', label: '派系', type: 'tags', optional: true },
  { key: 'resources', label: '资源', type: 'tags', optional: true },
  { key: 'countryKm2', label: '国家大小', type: 'number', optional: true, min: 1000, max: 1e9, step: 10000, hint: 'km²；一个国家平均占的能住人的陆地' },
  { key: 'years', label: '年份', type: 'json', optional: true, hint: '[最早, 现在]，建国年份在这里面' },
];

const VALUE_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'dimension', label: '维度', type: 'text', hint: '时代里维度的 id：religion……' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '原文', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'eras', label: '时代', type: 'tags', optional: true, hint: '空着时不限' },
  PREFS,
];

const GROUP_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '原文', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'eras', label: '时代', type: 'tags', optional: true, hint: '空着时不限' },
  PREFS,
];

const CULTURE_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'group', label: '文化组', type: 'text', hint: '文化组的 id' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'orig', label: '原文', type: 'text', optional: true },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'nameStyle', label: '地名风格', type: 'text', hint: '地名风格的 id' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'weight', label: '在组里占多少', type: 'number', optional: true, min: 0, max: 1000, step: 0.1, hint: '省略为 1' },
  { key: 'tendencies', label: '倾向', type: 'map', optional: true, value: { key: 'value', label: '取值与权重', type: 'weighted' }, hint: '维度 → 更可能的取值' },
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
    builtin: () => BUILTIN_ERAS,
    dirty: () => 'human',
    blank: () => ({ id: 'my-era', name: '新时代', dimensions: [{ id: 'religion', label: '宗教', required: true }], popDensity: 2, sparsity: 1.5, urbanization: 0.1, unclaimed: { minHabitability: 0.05, nomads: 0.3 }, seaClaimKm: 0 }),
    fields: ERA_FIELDS,
    pack: {
      key: 'eras',
      max: 32,
      listed: true,
      checked: true,
      withId: (e, id, from) => (id === from ? e : { ...e, id, name: renamed(e.name, id, from) }),
      fromWorld: (w) => changed(contentItems<Era>(w.small, 'era'), BUILTIN_ERAS).map((e) => structuredClone(e)),
      exportItem: (e) => structuredClone(e),
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
    builtin: () => BUILTIN_POP_VALUES,
    dirty: () => 'human',
    blank: () => ({ id: 'my-value', dimension: 'religion', name: '新取值', color: '#999999' }),
    fields: VALUE_FIELDS,
    pack: {
      key: 'popValues',
      max: 512,
      listed: true,
      checked: true,
      withId: (v, id, from) => (id === from ? v : { ...v, id, name: renamed(v.name, id, from) }),
      fromWorld: (w) => changed(contentItems<PopValue>(w.small, 'popValue'), BUILTIN_POP_VALUES).map((v) => structuredClone(v)),
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
    builtin: () => BUILTIN_CULTURE_GROUPS,
    dirty: () => 'human',
    blank: () => ({ id: 'my-group', name: '新文化组', color: '#999999' }),
    fields: GROUP_FIELDS,
    pack: {
      key: 'cultureGroups',
      max: 128,
      listed: true,
      checked: true,
      withId: (g, id, from) => (id === from ? g : { ...g, id, name: renamed(g.name, id, from) }),
      fromWorld: (w) => changed(contentItems<CultureGroup>(w.small, 'cultureGroup'), BUILTIN_CULTURE_GROUPS).map((g) => structuredClone(g)),
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
    builtin: () => BUILTIN_CULTURES,
    dirty: () => 'human',
    blank: () => ({ id: 'my-culture', group: 'western', name: '新文化', color: '#999999', nameStyle: 'zh-default' }),
    notes: (c) => (c.nameStyle === 'zh-default' || BUILTIN_STYLES.some((s) => s.id === c.nameStyle) ? [] : [`地名风格“${c.nameStyle}”不是内置的：世界里要先启用它`]),
    fields: CULTURE_FIELDS,
    pack: {
      key: 'cultures',
      max: 1024,
      listed: true,
      checked: true,
      withId: (c, id, from) => (id === from ? c : { ...c, id, name: renamed(c.name, id, from) }),
      // 包里的文化组改了 id 时，文化跟着改
      rewrite: (c, renames) => {
        const g = renames.cultureGroups?.get(c.group);
        return g && g !== c.group ? { ...c, group: g } : c;
      },
      fromWorld: (w) => changed(contentItems<Culture>(w.small, 'culture'), BUILTIN_CULTURES).map((c) => structuredClone(c)),
      exportItem: (c) => structuredClone(c),
    },
  });
}
