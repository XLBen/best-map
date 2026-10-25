import type { z } from 'zod';
import { type FieldDesc, contentItems, registerKind } from '../content/registry';
import { sameItem } from '../content/refs';
import { CATEGORY_LABEL, FANTASY_RESOURCES, GENERAL_RESOURCES, RESOURCE_CATEGORIES, RESOURCE_NONE, type Resource, isGeneralResource, resourceSchema, worldResources } from './resources';
import { registerPopKinds } from './pop-kinds';
import { registerGovKinds } from './gov-kinds';
import { RESOURCE_RULE_FIELDS, RULE_FIELDS } from './rules';
import { BUILTIN_CLASSES, type TerrainClass, checkTerrainClass, isBuiltinClass, remapCodes, terrainClassItems, terrainClassSchema, worldTerrainClasses } from './terrain-class';

// 第二十一轮的两种内容登记进登记表：地形类别、资源（都放在 small.content，命令是 set_content）。
// 内置的地形类别、通用资源总在世界里（不用启用）：small.content 里同 id 的一项是改过的那一份，停用它就换回内置的

// 世界里改过、加的项（不含没改过的内置项）
const changed = <T extends { id: string }>(items: Record<string, T>, builtin: readonly T[]): T[] =>
  Object.values(items).filter((x) => {
    const b = builtin.find((y) => y.id === x.id);
    return !b || !sameItem(b, x);
  });

// 撞 id 改名：名字带上编号
const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

const CLASS_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'exportColor', label: '导出的颜色', type: 'color', optional: true, hint: 'terrain_class.bmp 用；省略时同颜色' },
  { key: 'terrain', label: '游戏里的地形', type: 'text', optional: true, hint: '导出给游戏时对应的地形名' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'priority', label: '优先级', type: 'number', min: -1000, max: 1000, step: 1, hint: '几种都满足时大的优先' },
  { key: 'rules', label: '自动规则', type: 'list', of: RULE_FIELDS, hint: '满足任何一条就是这一类' },
  { key: 'fallback', label: '兜底', type: 'bool', optional: true, hint: '别的规则都不满足时用它' },
  { key: 'ore', label: '写有没有矿', type: 'bool', optional: true },
  { key: 'peaks', label: '有山峰', type: 'bool', optional: true, hint: '比四周都高的格算山峰' },
  { key: 'movement', label: '通行难度', type: 'number', optional: true, min: 0.1, max: 20, step: 0.1, hint: '平原为 1' },
  { key: 'habitability', label: '宜居度倍数', type: 'number', optional: true, min: 0, max: 3, step: 0.05, hint: '平原为 1' },
];

const RESOURCE_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'icon', label: '图标', type: 'text', optional: true },
  { key: 'category', label: '类别', type: 'enum', options: RESOURCE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })) },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'rules', label: '长在哪里', type: 'list', of: RESOURCE_RULE_FIELDS, hint: '满足任何一条就能长' },
  { key: 'rarity', label: '稀有度', type: 'number', min: 0, max: 1, step: 0.01, hint: '能长的地方约多少比例有它' },
  { key: 'weight', label: '权重', type: 'number', min: 0, max: 100, step: 0.1, hint: '几种都能长时越大越容易占上' },
  { key: 'cluster', label: '成片大小', type: 'number', min: 10, max: 5000, step: 10, hint: 'km' },
];

const ALL_RESOURCES = [...GENERAL_RESOURCES, ...FANTASY_RESOURCES];

// 由 content/kinds.ts 在地名风格之后调用（登记的先后就是仓库里的先后）
export function registerHumanKinds(): void {
  registerKind<TerrainClass>({
    id: 'terrainClass',
    label: '地形类别',
    short: '地形类别',
    order: 35,
    store: 'content',
    maxInWorld: 64,
    schema: terrainClassSchema as unknown as z.ZodType<TerrainClass>,
    inWorld: (w) => worldTerrainClasses(w.small),
    builtin: () => BUILTIN_CLASSES,
    dirty: () => 'human',
    check: (c) => checkTerrainClass(c),
    arrays: ['terrainClass'],
    // 停用了新加的一种：画成它的格恢复自动，后面的编号往前挪
    afterSet: (w, before) => remapCodes(w.causes.terrainClass, before, worldTerrainClasses(w.small).map((c) => c.id)),
    alwaysOn: (id) => (isBuiltinClass(id) ? '内置的地形类别总在' : undefined),
    blank: () => ({ id: 'my-class', name: '新类别', color: '#999999', priority: 10, rules: [{ elevMin: 500 }] }),
    fields: CLASS_FIELDS,
    pack: {
      key: 'terrainClasses',
      max: 64,
      listed: true,
      checked: true,
      withId: (c, id, from) => (id === from ? c : { ...c, id, name: renamed(c.name, id, from) }),
      fromWorld: (w) => changed(terrainClassItems(w.small), BUILTIN_CLASSES).map((c) => structuredClone(c)),
      exportItem: (c) => structuredClone(c),
      problems: (items) => items.flatMap((c) => ((c.rules ?? []).some((r) => r.classes?.length) ? [`地形类别“${c.name}”的规则里按地形类别：不起作用`] : [])),
    },
  });

  registerKind<Resource>({
    id: 'resource',
    label: '资源',
    short: '资源',
    order: 36,
    store: 'content',
    // 加上内置的通用一套不超过 254 种（255 留给“明确没有”）
    maxInWorld: 128,
    schema: resourceSchema as unknown as z.ZodType<Resource>,
    inWorld: (w) => worldResources(w.small),
    builtin: () => ALL_RESOURCES,
    dirty: () => 'human',
    arrays: ['resource'],
    afterSet: (w, before) => remapCodes(w.causes.resource, before, worldResources(w.small).map((r) => r.id), (v) => v === RESOURCE_NONE),
    alwaysOn: (id) => (isGeneralResource(id) ? '内置的通用资源总在' : undefined),
    blank: () => ({ id: 'my-resource', name: '新资源', color: '#999999', category: 'ore', rules: [{ classes: ['mountains'] }], rarity: 0.1, weight: 1, cluster: 300 }),
    fields: RESOURCE_FIELDS,
    pack: {
      key: 'resources',
      max: 128,
      listed: true,
      checked: true,
      // 种子用原来的：改了名分布不变
      withId: (r, id, from) => (id === from ? r : { ...r, id, name: renamed(r.name, id, from), seedKey: r.seedKey ?? from }),
      fromWorld: (w) => changed(contentItems<Resource>(w.small, 'resource'), ALL_RESOURCES).map((r) => structuredClone(r)),
      exportItem: (r) => structuredClone(r),
    },
  });
  // 第二十二轮：时代、人口维度的取值、文化组、文化
  registerPopKinds();
  // 第二十三轮：政体、派系
  registerGovKinds();
}
