import type { z } from 'zod';
import { type FieldDesc, contentItems, registerKind } from '../content/registry';
import { sameItem } from '../content/refs';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from '../packs/governments';
import { type Faction, type Government, factionSchema, governmentSchema } from './government';

// 第二十三轮的两种内容登记进登记表：政体、派系（都放在 small.content，命令是 set_content）。
// 内置的不是总在的：仓库里启用，或者生成国家时自动复制进来（见 countries.ts 的 ensureGovContent）

const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);
const changed = <T extends { id: string }>(items: Record<string, T>, builtin: readonly T[]): T[] =>
  Object.values(items).filter((x) => {
    const b = builtin.find((y) => y.id === x.id);
    return !b || !sameItem(b, x);
  });

const GOV_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'category', label: '类别', type: 'tags', hint: 'monarchy、republic、theocracy、tribal、empire……' },
  { key: 'color', label: '颜色', type: 'color', optional: true },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'title', label: '国家称号', type: 'json', hint: '“王国”，或按文化：{"default": "王国", "steppe": "汗国"}' },
  { key: 'rulerTitle', label: '统治者称号', type: 'json', optional: true, hint: '写法同国家称号' },
  { key: 'eras', label: '时代', type: 'tags', optional: true, hint: '空着时不限' },
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
  { key: 'dimension', label: '维度', type: 'text', optional: true },
  { key: 'value', label: '取值', type: 'text', optional: true },
  { key: 'culture', label: '文化', type: 'text', optional: true },
  { key: 'cultureGroup', label: '文化组', type: 'text', optional: true },
  { key: 'primary', label: '主流文化', type: 'bool', optional: true },
  { key: 'minority', label: '少数群体', type: 'bool', optional: true },
  { key: 'coastal', label: '住在海边', type: 'bool', optional: true },
];

const FACTION_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'eras', label: '时代', type: 'tags', optional: true, hint: '空着时不限' },
  { key: 'base', label: '基础', type: 'map', value: { key: 'value', label: '影响力', type: 'number', min: 0, max: 10, step: 0.1 }, hint: '政体的类别 → 影响力；default 是别的类别' },
  { key: 'drivers', label: '来自人口', type: 'list', optional: true, of: DRIVER_FIELDS, hint: '这部分人越多，影响力越大' },
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
    builtin: () => BUILTIN_GOVERNMENTS,
    dirty: () => 'human',
    blank: () => ({ id: 'my-government', name: '新政体', category: ['monarchy'], title: '王国', size: 1, expansion: 0.3, coastal: 0, urbanization: 1, cohesion: 0.5, vassals: 0.2, nomadic: 0 }),
    fields: GOV_FIELDS,
    pack: {
      key: 'governments',
      max: 128,
      listed: true,
      checked: true,
      withId: (g, id, from) => (id === from ? g : { ...g, id, name: renamed(g.name, id, from) }),
      fromWorld: (w) => changed(contentItems<Government>(w.small, 'government'), BUILTIN_GOVERNMENTS).map((g) => structuredClone(g)),
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
    builtin: () => BUILTIN_FACTIONS,
    dirty: () => 'human',
    blank: () => ({ id: 'my-faction', name: '新派系', color: '#999999', base: { default: 1 } }),
    fields: FACTION_FIELDS,
    pack: {
      key: 'factions',
      max: 128,
      listed: true,
      checked: true,
      withId: (f, id, from) => (id === from ? f : { ...f, id, name: renamed(f.name, id, from) }),
      fromWorld: (w) => changed(contentItems<Faction>(w.small, 'faction'), BUILTIN_FACTIONS).map((f) => structuredClone(f)),
      exportItem: (f) => structuredClone(f),
    },
  });
}
