import type { z } from 'zod';
import { type FieldDesc, contentItems, registerKind } from '../content/registry';
import { sameItem } from '../content/refs';
import { BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES, BUILTIN_RANKS } from '../packs/settlements';
import { isBuiltinLandmarkType, isBuiltinPointType, isBuiltinRank, worldCityRanks, worldLandmarkTypes, worldPointTypes } from './settle-content';
import { type CityRank, LANDMARK_DETECTORS, LANDMARK_PLACES, type LandmarkType, type PointType, cityRankSchema, landmarkTypeSchema, pointTypeSchema } from './settle-types';

// 第二十四轮的三种内容登记进登记表：城市等级、地标类型、自定义点的类型（都放在 small.content，命令是 set_content）。
// 内置的总在世界里（不用启用、不能停用）：small.content 里同 id 的一项是改过的那一份，停用它就换回内置的。
// 城市、地标的名字、等级都是现算的，改了这几种不用重算推导（dirty 是 none）

const changed = <T extends { id: string }>(items: Record<string, T>, builtin: readonly T[]): T[] =>
  Object.values(items).filter((x) => {
    const b = builtin.find((y) => y.id === x.id);
    return !b || !sameItem(b, x);
  });
const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

const RANK_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'icon', label: '图标', type: 'text', hint: 'star、double-ring、circle、dot……' },
  { key: 'color', label: '颜色', type: 'color', optional: true },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'capital', label: '首都用', type: 'bool', optional: true },
  { key: 'level', label: '重要', type: 'number', min: 0, max: 100, step: 1, hint: '越大越重要' },
  { key: 'minShare', label: '占本国人口', type: 'number', min: 0, max: 1, step: 0.001, hint: '比例下限' },
  { key: 'minPop', label: '人数下限', type: 'number', optional: true, min: 0, max: 1e10, step: 1000 },
  { key: 'label', label: '字号', type: 'number', min: 0.3, max: 4, step: 0.05, hint: '1 是普通城市' },
  { key: 'major', label: '连大道', type: 'bool', optional: true },
];

const LANDMARK_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  {
    key: 'category',
    label: '类别',
    type: 'enum',
    options: [
      { value: 'natural', label: '自然' },
      { value: 'manmade', label: '人造' },
    ],
  },
  { key: 'icon', label: '图标', type: 'text' },
  { key: 'color', label: '颜色', type: 'color', optional: true },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'detector', label: '怎么找', type: 'enum', optional: true, options: LANDMARK_DETECTORS.map((d) => ({ value: d, label: d })), when: { key: 'category', is: 'natural' } },
  { key: 'eras', label: '时代', type: 'tags', optional: true, hint: '空着时不限' },
  { key: 'cultureGroups', label: '文化组', type: 'tags', optional: true, hint: '空着时不限' },
  { key: 'governments', label: '政体的类别', type: 'tags', optional: true, hint: '空着时不限' },
  { key: 'place', label: '放在哪', type: 'enum', options: LANDMARK_PLACES.map((p) => ({ value: p, label: p })) },
  {
    key: 'per',
    label: '个数按',
    type: 'enum',
    options: [
      { value: 'country', label: '每个国家' },
      { value: 'world', label: '整个世界' },
    ],
  },
  { key: 'count', label: '个数', type: 'number', min: 0, max: 100, step: 0.1 },
  { key: 'chance', label: '可能', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'label', label: '名字的写法', type: 'json', hint: '“{city}神庙”，或按文化：{"default": "{city}神庙"}' },
  { key: 'manual', label: '不自动放', type: 'bool', optional: true },
];

const POINT_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'icon', label: '图标', type: 'text', optional: true },
  { key: 'image', label: '图片', type: 'text', optional: true, hint: 'data:image/… 的小图' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  {
    key: 'actsAsCity',
    label: '当作城市',
    type: 'json',
    optional: true,
    of: [
      { key: 'capital', label: '算首都', type: 'bool', optional: true },
      { key: 'rank', label: '等级', type: 'text', optional: true },
    ],
  },
];

// 由 human/kinds.ts 在政体、派系之后调用
export function registerSettleKinds(): void {
  registerKind<CityRank>({
    id: 'cityRank',
    label: '城市等级',
    short: '城市等级',
    order: 43,
    store: 'content',
    maxInWorld: 32,
    schema: cityRankSchema as unknown as z.ZodType<CityRank>,
    inWorld: (w) => worldCityRanks(w.small),
    builtin: () => BUILTIN_RANKS,
    dirty: () => 'none',
    alwaysOn: (id) => (isBuiltinRank(id) ? '内置的城市等级总在' : undefined),
    blank: () => ({ id: 'my-rank', name: '新等级', icon: 'circle', level: 2, minShare: 0.01, label: 1 }),
    fields: RANK_FIELDS,
    pack: {
      key: 'cityRanks',
      max: 32,
      listed: true,
      checked: true,
      withId: (r, id, from) => (id === from ? r : { ...r, id, name: renamed(r.name, id, from) }),
      fromWorld: (w) => changed(contentItems<CityRank>(w.small, 'cityRank'), BUILTIN_RANKS).map((r) => structuredClone(r)),
      exportItem: (r) => structuredClone(r),
    },
  });

  registerKind<LandmarkType>({
    id: 'landmarkType',
    label: '地标类型',
    short: '地标',
    order: 44,
    store: 'content',
    maxInWorld: 128,
    schema: landmarkTypeSchema as unknown as z.ZodType<LandmarkType>,
    inWorld: (w) => worldLandmarkTypes(w.small),
    builtin: () => BUILTIN_LANDMARK_TYPES,
    dirty: () => 'none',
    alwaysOn: (id) => (isBuiltinLandmarkType(id) ? '内置的地标类型总在' : undefined),
    blank: () => ({ id: 'my-landmark', name: '新地标', category: 'manmade', icon: 'monument', place: 'capital', per: 'country', count: 1, chance: 1, label: '{city}纪念碑' }),
    fields: LANDMARK_FIELDS,
    pack: {
      key: 'landmarkTypes',
      max: 128,
      listed: true,
      checked: true,
      withId: (t, id, from) => (id === from ? t : { ...t, id, name: renamed(t.name, id, from) }),
      fromWorld: (w) => changed(contentItems<LandmarkType>(w.small, 'landmarkType'), BUILTIN_LANDMARK_TYPES).map((t) => structuredClone(t)),
      exportItem: (t) => structuredClone(t),
    },
  });

  registerKind<PointType>({
    id: 'pointType',
    label: '自定义点的类型',
    short: '点',
    order: 45,
    store: 'content',
    maxInWorld: 128,
    schema: pointTypeSchema as unknown as z.ZodType<PointType>,
    inWorld: (w) => worldPointTypes(w.small),
    builtin: () => BUILTIN_POINT_TYPES,
    dirty: () => 'none',
    alwaysOn: (id) => (isBuiltinPointType(id) ? '内置的点的类型总在' : undefined),
    blank: () => ({ id: 'my-point', name: '新的点', icon: 'pin', color: '#d94a3d' }),
    fields: POINT_FIELDS,
    pack: {
      key: 'pointTypes',
      max: 128,
      listed: true,
      checked: true,
      withId: (t, id, from) => (id === from ? t : { ...t, id, name: renamed(t.name, id, from) }),
      fromWorld: (w) => changed(contentItems<PointType>(w.small, 'pointType'), BUILTIN_POINT_TYPES).map((t) => structuredClone(t)),
      exportItem: (t) => structuredClone(t),
    },
  });
}
