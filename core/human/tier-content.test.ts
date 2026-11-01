import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import type { Engine } from '../engine';
import { BUILTIN_COUNTRY_LAYOUTS, BUILTIN_COUNTRY_TIERS } from '../packs/countries';
import { BUILTIN_ERAS } from '../packs/eras';
import { continents, humanExec, snapshot, type HumanCommand } from '../testing/fixtures';
import { blocList, countryList } from './index';
import {
  type CountryTierDef,
  FULL_CAPITAL,
  capitalLook,
  confedCentre,
  confedMembers,
  fedMemberTier,
  genTiers,
  layoutById,
  tierWeights,
  vassalOf,
  worldLayouts,
  worldTiers,
} from './tiers';

// 第四十二轮：国家等级与格局是内容（human/tiers.ts）——内置的五档与以前写死的一样；几档都能生成；规则按等级的字段与先后

// 第四十一轮写死在 countries.ts、blocs.ts 里的数（原样拷贝，不要改它）
const R41 = {
  ids: ['city', 'small', 'medium', 'large', 'empire'],
  area: { city: 0.12, small: 0.4, medium: 1, large: 3, empire: 9 },
  govSize: { city: 0.15, small: 0.45, medium: 1, large: 2, empire: 3 },
  defaults: { city: 0.6, small: 2, medium: 3, large: 1.5, empire: 0.4 },
  layouts: {
    mixed: { city: 2, small: 3, medium: 2, large: 1.5, empire: 0.6 },
    petty: { city: 3, small: 4, medium: 1.5, large: 0.2, empire: 0 },
    unified: { city: 0.3, small: 0.7, medium: 1, large: 2, empire: 1.5 },
    powers: { city: 0.5, small: 2, medium: 0.4, large: 2.5, empire: 0.6 },
  } as Record<string, Record<string, number>>,
  // 当附庸：城邦、小国 1，别的 0.5；联邦：大国、帝国；邦联：中心中等，成员 35% 城邦、其余小国；
  // 联邦的成员邦：0.7 倍以上中等、0.2 倍以上小国、其余城邦
  vassal: (id: string) => (id === 'city' || id === 'small' ? 1 : 0.5),
  federation: ['large', 'empire'],
  fedMember: (a: number, T: number) => (a >= 0.7 * T ? 'medium' : a >= 0.2 * T ? 'small' : 'city'),
};

const GROUPS = [
  { id: 'germanic', weight: 3 },
  { id: 'chinese', weight: 3 },
  { id: 'altaic', weight: 1.5 },
];

const tier = (id: string, order: number, more: Partial<CountryTierDef> = {}): CountryTierDef => ({ id, name: `${id}级`, order, area: 1, govSize: 1, ...more });

// 世界里的等级整个换成 list（格局留着：写到的等级不在了就不算）
function setTiers(eng: Engine, list: readonly CountryTierDef[]): void {
  const cmds: Command[] = worldTiers(eng.world.small).map((t) => ({ op: 'set_content', kind: 'countryTier', id: t.id, item: null }));
  for (const t of list) cmds.push({ op: 'set_content', kind: 'countryTier', id: t.id, item: t as unknown as Record<string, unknown> });
  eng.exec({ op: 'batch', commands: cmds });
}

const base = (): Engine => snapshot('r42-tiers-base', () => continents({ provinces: true }));

describe('内置的国家等级与第四十一轮写死的一样', () => {
  const tiers = [...BUILTIN_COUNTRY_TIERS].sort((a, b) => a.order - b.order);
  it('五档：id、先后、面积倍数、相配的政体、时代没写时的比例、名字', () => {
    expect(tiers.map((t) => t.id)).toEqual(R41.ids);
    for (const t of tiers) {
      expect(t.area, t.id).toBe(R41.area[t.id as keyof typeof R41.area]);
      expect(t.govSize, t.id).toBe(R41.govSize[t.id as keyof typeof R41.govSize]);
      expect(t.weight, t.id).toBe(R41.defaults[t.id as keyof typeof R41.defaults]);
    }
    expect(tiers.map((t) => [t.name, t.short])).toEqual([
      ['城邦级行政', '城邦级'],
      ['侯国级行政', '侯国级'],
      ['公国级行政', '公国级'],
      ['王国级行政', '王国级'],
      ['帝国级行政', '帝国级'],
    ]);
  });

  it('附庸、联邦、邦联的规则', () => {
    for (const t of tiers) expect(vassalOf(t), t.id).toBe(R41.vassal(t.id));
    expect(tiers.filter((t) => t.federation).map((t) => t.id)).toEqual(R41.federation);
    expect(confedCentre(tiers).id).toBe('medium');
    const m = confedMembers(tiers);
    expect(m.list.map((t) => [t.id, m.weight(t)])).toEqual([
      ['city', 0.35],
      ['small', 0.65],
    ]);
    // 成员按比例挑：与以前的 rand() < 0.35 ? 城邦 : 小国 一样（比例加起来正好是 1）
    expect(m.list.reduce((s, t) => s + m.weight(t), 0)).toBe(1);
    const T = 1000;
    for (let a = 0; a <= 2 * T; a += 7.3) expect(fedMemberTier(tiers, a, T).id).toBe(R41.fedMember(a, T));
    for (const a of [0.2 * T, 0.7 * T, 0.2 * T - 1e-9, 0.7 * T - 1e-9]) expect(fedMemberTier(tiers, a, T).id).toBe(R41.fedMember(a, T));
  });

  it('四种格局的比例；时代的比例', () => {
    expect(BUILTIN_COUNTRY_LAYOUTS.map((l) => [l.id, l.name])).toEqual([
      ['mixed', '混合'],
      ['petty', '诸侯林立'],
      ['unified', '大一统'],
      ['powers', '列强并立'],
    ]);
    for (const l of BUILTIN_COUNTRY_LAYOUTS) expect(tierWeights(tiers, undefined, l)).toEqual(R41.ids.map((id) => R41.layouts[l.id][id]));
    for (const era of BUILTIN_ERAS) expect(tierWeights(tiers, era, undefined)).toEqual(era.tiers ? R41.ids.map((id) => era.tiers![id] ?? 0) : R41.ids.map((id) => R41.defaults[id as keyof typeof R41.defaults]));
  });
});

describe('生效的比例', () => {
  const tiers = [tier('a', 1, { weight: 2 }), tier('b', 2), tier('c', 3, { weight: 0 })];
  it('世界里没有的等级不算，没写的等级为 0；全是 0 时往下一种退', () => {
    const layout = { id: 'x', name: 'x', weights: { a: 1, zzz: 9 } };
    expect(tierWeights(tiers, { tiers: { b: 3 } }, layout)).toEqual([1, 0, 0]);
    expect(tierWeights(tiers, { tiers: { b: 3, zzz: 5 } }, undefined)).toEqual([0, 3, 0]);
    // 格局写的等级都不在世界里：按时代
    expect(tierWeights(tiers, { tiers: { b: 3 } }, { id: 'y', name: 'y', weights: { zzz: 1 } })).toEqual([0, 3, 0]);
    // 时代写的也都不在：按各等级的 weight（省略为 1）
    expect(tierWeights(tiers, { tiers: { zzz: 3 } }, undefined)).toEqual([2, 1, 0]);
    expect(tierWeights(tiers, undefined, undefined)).toEqual([2, 1, 0]);
  });

  it('没写邦联、联邦成员的等级：中心取正中的一级，成员取最低的一级', () => {
    const seven = [...Array(7).keys()].map((k) => tier(`t${k}`, k * 10));
    expect(confedCentre(seven).id).toBe('t3');
    expect(confedMembers(seven).list.map((t) => t.id)).toEqual(['t0']);
    expect(fedMemberTier(seven, 5, 1).id).toBe('t0');
    // 写了的够不上时取写了的里最低的一级
    const some = seven.map((t, k) => (k === 2 || k === 4 ? { ...t, fedMember: k } : t));
    expect(fedMemberTier(some, 0.5, 1).id).toBe('t2');
    expect(fedMemberTier(some, 3, 1).id).toBe('t2');
    expect(fedMemberTier(some, 4, 1).id).toBe('t4');
  });

  it('按 order 排（一样时按 id）；没有时生成用一档“一般”', () => {
    const small = { content: { countryTier: { z: tier('z', 5), a: tier('a', 5), m: tier('m', -1) } } };
    expect(worldTiers(small).map((t) => t.id)).toEqual(['m', 'a', 'z']);
    expect(worldTiers({}).length).toBe(0);
    expect(genTiers({}).map((t) => [t.id, t.area])).toEqual([['', 1]]);
    expect(layoutById({}, 'mixed')).toBeUndefined();
    expect(layoutById({ content: { countryLayout: { era: { id: 'era', name: 'x', weights: {} } } } }, 'era')).toBeUndefined();
  });
});

describe('几档都能生成（加、删、改等级）', () => {
  it('新世界默认带着内置的五档与四种格局', () => {
    const w = base().world;
    expect(worldTiers(w.small).map((t) => t.id)).toEqual(R41.ids);
    expect(worldLayouts(w.small).map((l) => l.id)).toEqual(['mixed', 'petty', 'unified', 'powers']);
  });

  it('三档：国家都是这三档里的，大的面积大；格局按这三档', () => {
    const eng = base();
    setTiers(eng, [tier('lo', 1, { area: 0.3, govSize: 0.3, vassal: 1, confedMember: 1 }), tier('mid', 2, { confedCentre: true }), tier('hi', 3, { area: 4, govSize: 2.5, federation: true })]);
    humanExec(eng, { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: { seed: 3 } } as HumanCommand);
    const metas = countryList(eng.world.small);
    expect(metas.length).toBeGreaterThan(5);
    for (const m of metas) expect(['lo', 'mid', 'hi']).toContain(m.tier);
    expect(new Set(metas.map((m) => m.tier)).size).toBeGreaterThan(1);
    expect(eng.lastSkipped ?? []).not.toContain('没有国家等级：国家都按一般的大小');
    // 格局“诸侯林立”写的五档里只有这三档以外的：都不在，按时代
    humanExec(eng, { op: 'regenerate_countries', layout: 'petty' });
    for (const m of countryList(eng.world.small)) expect(['lo', 'mid', 'hi']).toContain(m.tier);
  });

  it('七档（现代，有联邦）：国家、联邦切出来的成员邦都是这七档里的', () => {
    const eng = base();
    const seven = [...Array(7).keys()].map((k) => tier(`t${k}`, k, { area: 0.1 * 2 ** k, govSize: 0.1 * 1.7 ** k, federation: k >= 4, fedMember: k <= 3 ? [0, 0.15, 0.4, 0.9][k] : undefined }));
    setTiers(eng, seven);
    humanExec(eng, { op: 'generate_human', era: 'modern', groups: GROUPS, countries: {} } as HumanCommand);
    const ids = new Set(seven.map((t) => t.id));
    const metas = countryList(eng.world.small);
    expect(metas.length).toBeGreaterThan(5);
    for (const m of metas) expect(ids.has(m.tier!)).toBe(true);
    const feds = blocList(eng.world.small).filter((b) => b.kind === 'federation');
    for (const b of feds) for (const id of b.members) expect(['t0', 't1', 't2', 't3']).toContain(eng.world.small.countries![id].tier);
  });

  it('一档都没有：照样生成，国家都按一般的大小（档案里没有等级），写明', () => {
    const eng = base();
    setTiers(eng, []);
    humanExec(eng, { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} } as HumanCommand);
    const metas = countryList(eng.world.small);
    expect(metas.length).toBeGreaterThan(5);
    for (const m of metas) expect(m.tier).toBeUndefined();
    humanExec(eng, { op: 'regenerate_countries' });
    expect(eng.lastSkipped).toContain('没有国家等级：国家都按一般的大小');
  });

  it('改名不影响生成；首都的样子按等级：最高的一级、自己建的、不在世界里的照最醒目的画', () => {
    const eng = base();
    const s0 = eng.world.small;
    expect(capitalLook(s0, 'empire')).toBe(FULL_CAPITAL);
    expect(capitalLook(s0, undefined)).toBe(FULL_CAPITAL);
    expect(capitalLook(s0, 'nope')).toBe(FULL_CAPITAL);
    expect(capitalLook(s0, 'small')).toEqual({ icon: 0.72, alpha: 0.8, label: 0.8, bold: false });
    expect(capitalLook(s0, 'large')).toEqual({ icon: 0.9, alpha: 0.95, label: 0.92, bold: true });
    // 加一个比帝国级还高的：帝国级按它自己写的（没写，都是 1），最高的那一级照最醒目的画（不看它写的）
    const top = tier('hyper', 99, { capitalAlpha: 0.2, capitalIcon: 0.5 });
    eng.exec({ op: 'set_content', kind: 'countryTier', id: top.id, item: top as unknown as Record<string, unknown> });
    expect(capitalLook(eng.world.small, 'hyper')).toBe(FULL_CAPITAL);
    expect(capitalLook(eng.world.small, 'empire')).toBe(FULL_CAPITAL);
    // 改名：只是名字
    const empire = worldTiers(eng.world.small).find((t) => t.id === 'empire')!;
    eng.exec({ op: 'set_content', kind: 'countryTier', id: 'empire', item: { ...empire, name: '天下', short: '天下级' } as unknown as Record<string, unknown> });
    expect(worldTiers(eng.world.small).find((t) => t.id === 'empire')!.short).toBe('天下级');
    // 改了等级不重算（只是生成国家时、画首都时读）
    eng.undo();
    expect(worldTiers(eng.world.small).find((t) => t.id === 'empire')!.short).toBe('帝国级');
  });
});
