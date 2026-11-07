import { describe, expect, it } from 'vitest';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_POP_VALUES, BUILTIN_VALUE_GROUPS, CULTURE_REGIONS, ERA_PACKS, VALUE_ERAS } from '../packs/eras';
import { BUILTIN_COUNTRY_TIERS } from '../packs/countries';
import { BUILTIN_GOVERNMENTS } from '../packs/governments';
import { BUILTIN_STYLES } from '../packs/names';
import { continents, engineFor, humanExec } from '../testing/fixtures';
import { defaultsOf, eraOf } from '../testing/eras';
import type { World } from '../world';
import { countryList, cultureContext } from './countries';
import { cultureTendency, faithRelation, weightedList } from './era';
import { govAllowed, govTitles, governmentById } from './government';

// 第四十四轮：奇幻、科幻的文化组（仿 EU4：组名短，文化是“地名 + 人”或种族的说法）、奇幻的宗教组、各族的政体

const EU4 = new Set(CULTURE_REGIONS.flatMap((r) => r.groups));
const FANTASY = ['elven', 'dwarven', 'halfling', 'gnomish', 'orcish', 'goblinoid', 'draconic', 'westmark', 'northmark', 'sandsea', 'seafolk'];
const SCIFI = ['terran', 'spacer', 'augment', 'synthetic', 'tidal', 'lithic', 'sporal', 'chitin', 'avian'];
const SMALL = { content: { cultureGroup: Object.fromEntries(BUILTIN_CULTURE_GROUPS.map((g) => [g.id, g])), popValue: Object.fromEntries(BUILTIN_POP_VALUES.map((v) => [v.id, v])), valueGroup: Object.fromEntries(BUILTIN_VALUE_GROUPS.map((g) => [g.id, g])) } } as never;
const groupsOf = (era: string) => ERA_PACKS.get(era)!.cultures.map(([id]) => id);
const STYLE = new Map(BUILTIN_STYLES.map((s) => [s.id, s]));

describe('奇幻、科幻的文化组', () => {
  it('奇幻 11 组、科幻 9 组，时代包默认全带；不带 EU4 的地球文化组', () => {
    expect(groupsOf('fantasy')).toEqual(FANTASY);
    expect(groupsOf('scifi')).toEqual(SCIFI);
    for (const id of [...FANTASY, ...SCIFI]) expect(EU4.has(id), id).toBe(false);
  });

  it('每组 3–8 个文化，每个文化都在一组里；组名短；名字不与别的重', () => {
    for (const id of [...FANTASY, ...SCIFI]) {
      const g = BUILTIN_CULTURE_GROUPS.find((x) => x.id === id)!;
      expect(g, id).toBeDefined();
      expect(g.name.length, id).toBeLessThanOrEqual(3);
      expect(g.orig, id).toMatch(/^[A-Z]/);
      const list = BUILTIN_CULTURES.filter((c) => c.group === id);
      expect(list.length, id).toBeGreaterThanOrEqual(3);
      expect(list.length, id).toBeLessThanOrEqual(8);
      for (const c of list) {
        expect(c.orig, c.id).toMatch(/^[A-Z]/);
        expect(c.description?.length ?? 0, c.id).toBeGreaterThan(5);
      }
    }
    const fiction = BUILTIN_CULTURES.filter((c) => !EU4.has(c.group));
    for (const c of fiction) expect([...FANTASY, ...SCIFI], c.id).toContain(c.group);
    expect(fiction.length).toBeGreaterThanOrEqual(80);
  });

  it('一组一种自己的地名风格（幻想·…、科幻·…），文化不另写；风格只给这一组用', () => {
    const used = new Set<string>();
    for (const [ids, prefix] of [[FANTASY, 'fantasy-'], [SCIFI, 'scifi-']] as const)
      for (const id of ids) {
        const g = BUILTIN_CULTURE_GROUPS.find((x) => x.id === id)!;
        expect(g.nameStyle?.startsWith(prefix), id).toBe(true);
        expect(STYLE.has(g.nameStyle!), id).toBe(true);
        expect(used.has(g.nameStyle!), id).toBe(false);
        used.add(g.nameStyle!);
        for (const c of BUILTIN_CULTURES.filter((x) => x.group === id)) expect(c.nameStyle, c.id).toBeUndefined();
      }
    for (const g of BUILTIN_CULTURE_GROUPS) if (EU4.has(g.id)) expect(used.has(g.nameStyle ?? ''), g.id).toBe(false);
  });

  it('倾向引用的都在这个时代：种族 / 物种、宗教 / 阵营、政体；每个文化每一维都有', () => {
    for (const [era, ids] of [['fantasy', FANTASY], ['scifi', SCIFI]] as const) {
      const e = eraOf(era);
      const govs = ERA_PACKS.get(era)!.governments;
      for (const c of BUILTIN_CULTURES.filter((x) => ids.includes(x.group))) {
        for (const dim of [...e.dimensions.map((d) => d.id), 'government']) {
          const list = weightedList(cultureTendency(SMALL, c, dim, era));
          expect(list.length, `${c.id} ${dim}`).toBeGreaterThan(0);
          for (const [id] of list) {
            if (dim === 'government') expect(govs, `${c.id}: ${id}`).toContain(id);
            else {
              const v = BUILTIN_POP_VALUES.find((x) => x.id === id);
              expect(v?.dimension, `${c.id}: ${id}`).toBe(dim);
              expect(VALUE_ERAS.get(id), `${c.id}: ${id}`).toContain(era);
            }
          }
        }
      }
    }
  });

  it('不用现成设定里的专名', () => {
    const text = JSON.stringify([
      BUILTIN_CULTURE_GROUPS.filter((g) => !EU4.has(g.id)),
      BUILTIN_CULTURES.filter((c) => !EU4.has(c.group)),
      BUILTIN_POP_VALUES.filter((v) => ['fantasy', 'scifi'].some((e) => VALUE_ERAS.get(v.id)?.includes(e))),
      BUILTIN_GOVERNMENTS.filter((g) => ERA_PACKS.get('fantasy')!.governments.includes(g.id) || ERA_PACKS.get('scifi')!.governments.includes(g.id)),
    ]);
    for (const w of ['提夫林', 'Tiefling', '卓尔', 'Drow', '霍比特', 'Hobbit', 'Moradin', 'Lolth', 'Gruumsh', 'Bahamut', 'Tiamat', 'Corellon', 'Faer', 'Sith', 'Jedi', 'Klingon', 'Zerg', 'Protoss', 'Eldar', 'Asari', 'Krogan']) expect(text.includes(w), w).toBe(false);
  });
});

describe('奇幻的宗教组', () => {
  it('6 组，每种宗教都有组；同组是异端，不同组是异教', () => {
    const rel = BUILTIN_POP_VALUES.filter((v) => v.dimension === 'religion' && VALUE_ERAS.get(v.id)?.includes('fantasy'));
    const groups = [...new Set(rel.map((v) => v.group))];
    expect(groups).toEqual(['radiant', 'natural', 'ancestral', 'arcane', 'umbral', 'draconic']);
    for (const v of rel) {
      expect(BUILTIN_VALUE_GROUPS.find((g) => g.id === v.group)?.dimension, v.id).toBe('religion');
      expect(v.orig, v.id).toMatch(/^[A-Z]/);
    }
    expect(rel.length).toBeGreaterThanOrEqual(18);
    expect(faithRelation(SMALL, 'dawnlord', 'oathbound')).toBe('heretic');
    expect(faithRelation(SMALL, 'dawnlord', 'grove-mother')).toBe('heathen');
    expect(faithRelation(SMALL, 'elder-dragons', 'ember-flame')).toBe('heretic');
  });
});

describe('奇幻、科幻的政体', () => {
  it('每种政体给本时代每个组、每个等级都有国家称号与统治者称号；各族自己的政体限给自己', () => {
    for (const [era, ids] of [['fantasy', FANTASY], ['scifi', SCIFI]] as const)
      for (const gid of ERA_PACKS.get(era)!.governments) {
        const g = BUILTIN_GOVERNMENTS.find((x) => x.id === gid)!;
        for (const id of ids) {
          const c = BUILTIN_CULTURES.find((x) => x.group === id)!;
          const world = { small: SMALL } as unknown as World;
          const ctx = cultureContext(world, c.id, eraOf(era));
          for (const t of BUILTIN_COUNTRY_TIERS) {
            const r = govTitles(g, { ...ctx, tier: t.id, tiers: BUILTIN_COUNTRY_TIERS });
            expect(r.title?.zh, `${gid}/${id}/${t.id}`).toBeTruthy();
            expect(r.ruler?.zh, `${gid}/${id}/${t.id}`).toBeTruthy();
          }
        }
      }
    const only = (id: string) => BUILTIN_GOVERNMENTS.find((g) => g.id === id)!.only;
    expect(only('elven-council')).toEqual([{ cultureGroups: ['elven'] }]);
    expect(only('dwarven-hold')).toEqual([{ cultureGroups: ['dwarven'] }]);
    expect(only('holy-order')).toEqual([{ valueGroups: ['radiant'] }]);
    expect(only('machine-mind')).toEqual([{ cultureGroups: ['synthetic'] }]);
  });

  // 按默认生成（地区与整个星球）：没有一国的政体不许它用
  const check = (w: World, era: string, where: string) => {
    const list = countryList(w.small);
    expect(list.length, where).toBeGreaterThan(3);
    for (const m of list) expect(govAllowed(governmentById(w.small, m.government)!, cultureContext(w, m.primaryCulture, eraOf(era))), `${where}: ${m.name} ${m.government} ${m.primaryCulture}`).toBe(true);
    return list;
  };
  for (const era of ['fantasy', 'scifi'])
    it(`${eraOf(era).name}：生成的国家都合限法，各族的政体都有人用`, () => {
      const used = new Set<string>();
      for (const seed of [1, 5]) {
        const eng = continents();
        humanExec(eng, { op: 'generate_human', packs: [[era]], groups: defaultsOf(eraOf(era)), countries: { seed } });
        for (const m of check(eng.world, era, `${era} ${seed}`)) used.add(m.government);
      }
      const eng = engineFor({ seed: 3, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
      eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
      humanExec(eng, { op: 'generate_human', packs: [[era]], groups: defaultsOf(eraOf(era)), countries: {} });
      for (const m of check(eng.world, era, `${era} 星球`)) used.add(m.government);
      expect(used.size, [...used].join()).toBeGreaterThanOrEqual(6);
    }, 120000);
});
