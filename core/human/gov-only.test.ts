import { describe, expect, it } from 'vitest';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_POP_VALUES, BUILTIN_VALUE_GROUPS } from '../packs/eras';
import { BUILTIN_GOVERNMENTS } from '../packs/governments';
import { continents, engineFor, humanExec } from '../testing/fixtures';
import { defaultsOf, eraOf } from '../testing/eras';
import type { World } from '../world';
import { countryFaith } from './country-layers';
import { countryList, cultureContext } from './countries';
import { governmentSchema, govAllowed, governmentById } from './government';

// 第四十四轮：政体限谁用（only，仿 EU4：伊克塔只给穆斯林、幕府只给日本、天朝只给汉……）。
// 第四十三轮的毛病：挑政体时倾向里没写的政体都给 0.15 的余地，九州人也会挑到伊克塔，成了信神道教的“南野苏丹国”

const HISTORY = ['antiquity', 'medieval', 'industrial', 'modern'];
const MUSLIM = new Set(BUILTIN_POP_VALUES.filter((v) => v.group === 'muslim').map((v) => v.id));

describe('政体限谁用', () => {
  it('一条里写了的几项都满足、几条里满足一条就行；不写时谁都能用', () => {
    const g = governmentSchema.parse({ id: 'x', name: 'x', category: ['monarchy'], titles: '国', only: [{ cultureGroups: ['altaic'] }, { cultures: ['scythian'], valueGroups: ['pagan'] }] });
    expect(govAllowed(g, { culture: 'mongol', group: 'altaic', values: [], valueGroups: [] })).toBe(true);
    expect(govAllowed(g, { culture: 'scythian', group: 'lost', values: ['tengri'], valueGroups: ['pagan'] })).toBe(true);
    expect(govAllowed(g, { culture: 'scythian', group: 'lost', values: ['zoroastrian'], valueGroups: ['zoroastrian-group'] })).toBe(false);
    expect(govAllowed(g, { culture: 'english', group: 'british', values: [], valueGroups: [] })).toBe(false);
    expect(govAllowed({}, { values: [], valueGroups: [] })).toBe(true);
  });

  it('内置的限法引用的文化、组、取值、取值组都认得；仿 EU4 的几种限了', () => {
    const ids = {
      cultures: new Set(BUILTIN_CULTURES.map((c) => c.id)),
      cultureGroups: new Set(BUILTIN_CULTURE_GROUPS.map((g) => g.id)),
      values: new Set(BUILTIN_POP_VALUES.map((v) => v.id)),
      valueGroups: new Set(BUILTIN_VALUE_GROUPS.map((g) => g.id)),
    };
    for (const g of BUILTIN_GOVERNMENTS)
      for (const r of g.only ?? []) {
        expect(Object.keys(r).length, g.id).toBeGreaterThan(0);
        for (const k of ['cultures', 'cultureGroups', 'values', 'valueGroups'] as const) for (const id of r[k] ?? []) expect(ids[k], `${g.id}: ${id}`).toContain(id);
      }
    const only = (id: string) => BUILTIN_GOVERNMENTS.find((g) => g.id === id)!.only;
    expect(only('iqta')).toEqual([{ valueGroups: ['muslim'] }]);
    expect(only('shogunate')).toEqual([{ cultureGroups: ['japanese'] }]);
    expect(only('celestial-empire')).toEqual([{ cultureGroups: ['chinese'] }]);
    expect(only('monastic-order')).toEqual([{ valueGroups: ['christian'] }]);
    expect(only('steppe-horde')![0].cultureGroups).toEqual(['altaic', 'tatar']);
  });

  // 每个历史时代按默认的组，几个种子、地区与整个星球：没有一国的政体不许它用；“苏丹”只出现在国教是伊斯兰教的国家
  const check = (w: World, era: string, where: string) => {
    const list = countryList(w.small);
    expect(list.length, where).toBeGreaterThan(3);
    for (const m of list) {
      const g = governmentById(w.small, m.government)!;
      expect(govAllowed(g, cultureContext(w, m.primaryCulture, eraOf(era))), `${where}: ${m.name} ${m.government} ${m.primaryCulture}`).toBe(true);
      if (m.name.includes('苏丹') || m.ruler.title === '苏丹') expect(MUSLIM.has(countryFaith(w, m.id)?.id ?? ''), `${where}: ${m.name}`).toBe(true);
    }
  };

  for (const era of HISTORY)
    it(`${eraOf(era).name}：地区（三个种子）与整个星球上没有违反限法的国家`, () => {
      const groups = defaultsOf(eraOf(era));
      for (const seed of [1, 5, 12]) {
        const eng = continents();
        humanExec(eng, { op: 'generate_human', packs: [[era]], groups, countries: { seed } });
        check(eng.world, era, `${era} 地区 ${seed}`);
      }
      const eng = engineFor({ seed: 3, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
      eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
      humanExec(eng, { op: 'generate_human', packs: [[era]], groups, countries: {} });
      check(eng.world, era, `${era} 星球`);
    }, 120000);
});
