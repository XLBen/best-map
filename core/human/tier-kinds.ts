import type { z } from 'zod';
import { type FieldDesc, notBuiltin, registerKind } from '../content/registry';
import { type CountryLayoutDef, type CountryTierDef, countryLayoutSchema, countryTierSchema, worldLayouts, worldTiers } from './tiers';

// 第四十二轮的两种内容登记进登记表：国家等级、格局（都放在 small.content，命令是 set_content）。
// 只在生成国家时读，地图上按等级画首都：改了不重算（dirty 是 none），重新生成国家时按新的。
// 内置的在“通用 ▸ 国家等级”（新建世界默认带上）

const renamed = (name: string, id: string, from: string) => `${name} ${id.slice(from.length + 1) || id}`.slice(0, 20);

const TIER_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'short', label: '简称', type: 'text', optional: true, hint: '列表、档案里写；空着时写名字' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'order', label: '高低', type: 'number', min: -1000, max: 1000, step: 1, hint: '越大越高；生成、画首都按它排' },
  { key: 'area', label: '面积倍数', type: 'number', min: 0.01, max: 100, step: 0.01, hint: '1 是平均的国家' },
  { key: 'weight', label: '多见', type: 'number', optional: true, min: 0, max: 100, step: 0.1, hint: '时代没写比例时占多少；省略为 1' },
  { key: 'govSize', label: '相配的政体', type: 'number', min: 0.05, max: 10, step: 0.05, hint: '政体的“国土”离它越近越容易是这一级' },
  { key: 'vassal', label: '当附庸', type: 'number', optional: true, min: 0, max: 1, step: 0.05, hint: '乘在宗主的“收附庸”上；省略为 0.5' },
  { key: 'federation', label: '能分成联邦', type: 'bool', optional: true, hint: '时代有联邦时，这一级够大的国家可能分成几个成员邦' },
  { key: 'fedMember', label: '成员邦从几倍起', type: 'number', optional: true, min: 0, max: 100, step: 0.05, hint: '联邦的成员邦面积至少是平均的几倍时算这一级；空着时成员邦不算这一级' },
  { key: 'confedCentre', label: '邦联的中心', type: 'bool', optional: true, hint: '诸侯林立的一片地方，皇帝的那一国是这一级' },
  { key: 'confedMember', label: '邦联的成员', type: 'number', optional: true, min: 0, max: 100, step: 0.05, hint: '诸侯里这一级占多少；空着时不当成员' },
  { key: 'capitalIcon', label: '首都图标', type: 'number', optional: true, min: 0.3, max: 2, step: 0.05, hint: '首都图标的大小；最高的一级总是 1' },
  { key: 'capitalAlpha', label: '首都浓淡', type: 'number', optional: true, min: 0.1, max: 1, step: 0.05, hint: '1 不透明；最高的一级总是 1' },
  { key: 'capitalLabel', label: '首都字号', type: 'number', optional: true, min: 0.3, max: 2, step: 0.05, hint: '首都名字的字号倍数' },
  { key: 'capitalBold', label: '首都名字加粗', type: 'bool', optional: true },
];

const LAYOUT_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'description', label: '说明', type: 'longtext', optional: true },
  { key: 'weights', label: '各等级占多少', type: 'map', keyRef: 'countryTier', dep: 'auto', value: { key: 'value', label: '比例', type: 'number', min: 0, max: 100, step: 0.1 }, hint: '空着的等级不出现' },
];

// 由 human/kinds.ts 在政体、派系之后调用
export function registerTierKinds(): void {
  registerKind<CountryTierDef>({
    id: 'countryTier',
    label: '国家等级',
    short: '国家等级',
    order: 43,
    store: 'content',
    maxInWorld: 32,
    schema: countryTierSchema as unknown as z.ZodType<CountryTierDef>,
    inWorld: (w) => worldTiers(w.small),
    dirty: () => 'none',
    blank: () => ({ id: 'my-tier', name: '新等级', order: 25, area: 2, govSize: 1.5 }),
    fields: TIER_FIELDS,
    pack: {
      key: 'countryTiers',
      max: 32,
      listed: true,
      checked: true,
      withId: (t, id, from) => (id === from ? t : { ...t, id, name: renamed(t.name, id, from) }),
      fromWorld: (w) => notBuiltin('countryTier', worldTiers(w.small)).map((t) => structuredClone(t)),
      exportItem: (t) => structuredClone(t),
    },
  });

  registerKind<CountryLayoutDef>({
    id: 'countryLayout',
    label: '格局',
    short: '格局',
    order: 44,
    store: 'content',
    maxInWorld: 32,
    schema: countryLayoutSchema as unknown as z.ZodType<CountryLayoutDef>,
    inWorld: (w) => worldLayouts(w.small),
    dirty: () => 'none',
    blank: () => ({ id: 'my-layout', name: '新格局', weights: { medium: 1 } }),
    fields: LAYOUT_FIELDS,
    pack: {
      key: 'countryLayouts',
      max: 32,
      listed: true,
      checked: true,
      withId: (l, id, from) => (id === from ? l : { ...l, id, name: renamed(l.name, id, from).slice(0, 12) }),
      fromWorld: (w) => notBuiltin('countryLayout', worldLayouts(w.small)).map((l) => structuredClone(l)),
      exportItem: (l) => structuredClone(l),
      problems: (items, ctx) => {
        const tiers = ctx.ids('countryTiers');
        if (!tiers.size) return [];
        return items.flatMap((l) => Object.keys(l.weights).filter((id) => !tiers.has(id)).map((id) => `格局“${l.name}”写的等级 ${id} 不在资源包里：世界里没有它时不算`));
      },
    },
  });
}
