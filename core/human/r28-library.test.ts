import { describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { kindOf, usageOf } from '../content/registry';
import { strictWorld } from '../content/usage';
import { Engine } from '../engine';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from '../packs/eras';
import { FANTASY_BIOMES } from '../packs/fantasy-biomes';
import { FANTASY_RIVER_TYPES } from '../packs/fantasy-rivers';
import { DEFAULT_SPECIES } from '../species';
import { continents, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import { worldCultureGroups, worldCultures, worldEras } from './era';

// 第二十八轮的核心：新世界只带用得上的内容；生成人文后只留用到的文化；在用的内容不能移出世界（引擎也拦）

const GEN: Command = { op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }], countries: {}, settlements: {} };
const peopled = () =>
  snapshot('r28:peopled', () => {
    const e = continents();
    e.exec(GEN);
    return e;
  });

// 每个文化有没有人
function culturesWithPeople(w: World): Set<string> {
  const out = new Set<string>();
  const g = w.causes.popGroup!;
  const s = w.causes.popShare!;
  for (let k = 0; k < g.length; k++) if (g[k] && s[k]) out.add(w.small.popGroups![g[k]].culture);
  return out;
}

describe('新世界只带用得上的', () => {
  it('生态是普通的 13 种，没有奇幻生态，没有河湖的种类（血河在资源库里）', () => {
    const w = continents().world;
    expect(w.small.species.map((s) => s.id)).toEqual(DEFAULT_SPECIES.map((s) => s.id));
    expect(w.small.species.length).toBe(13);
    expect(w.small.species.some((s) => FANTASY_BIOMES.some((f) => f.id === s.id))).toBe(false);
    expect(w.small.riverTypes ?? []).toEqual([]);
    expect(w.small.lakeTypes ?? []).toEqual([]);
    expect(FANTASY_RIVER_TYPES.some((t) => t.id === 'blood_river')).toBe(true);
    // 人文的内容一样都没有（生成时才复制进来）
    expect(w.small.content).toBeUndefined();
  });

  it('生成人文后只留用到的：一个时代、选的两个文化组、有人或被引用的文化', () => {
    const w = peopled().world;
    expect(worldEras(w.small).map((e) => e.id)).toEqual(['medieval']);
    expect(worldCultureGroups(w.small).map((g) => g.id).sort()).toEqual(['eastern', 'western']);
    const people = culturesWithPeople(w);
    const primary = new Set(Object.values(w.small.countries ?? {}).map((c) => c.primaryCulture));
    for (const c of worldCultures(w.small)) expect(people.has(c.id) || primary.has(c.id)).toBe(true);
    // 别的组的文化不在
    expect(worldCultures(w.small).every((c) => c.group === 'western' || c.group === 'eastern')).toBe(true);
    expect(BUILTIN_CULTURE_GROUPS.length).toBeGreaterThan(2);
    // 取值：有人的，或者这个时代每一维能用的
    const dims = new Set(BUILTIN_ERAS.find((e) => e.id === 'medieval')!.dimensions.map((d) => d.id));
    const values = Object.values((w.small.content?.popValue ?? {}) as Record<string, { dimension: string }>);
    expect(values.every((v) => dims.has(v.dimension))).toBe(true);
    expect(values.length).toBeLessThan(BUILTIN_POP_VALUES.length);
  });

  it('重新生成换了时代：旧的时代移出，新的时代、文化组从内置的复制进来；撤销回到原样；重放结果一样', () => {
    const eng = peopled();
    const w = eng.world;
    const before = JSON.stringify(w.small.content);
    eng.exec({ op: 'regenerate_human', era: 'antiquity', groups: [{ id: 'western', weight: 1 }], keepManual: false, countries: {} });
    expect(worldEras(w.small).map((e) => e.id)).toEqual(['antiquity']);
    // 换了时代、国家重新长：东方的文化没人了，一起移出
    expect(worldCultureGroups(w.small).map((g) => g.id)).toEqual(['western']);
    expect(worldCultures(w.small).every((c) => c.group === 'western')).toBe(true);
    const replay = Engine.fromDoc(eng.toDoc(), w.mesh).world;
    expect(JSON.stringify(replay.small.content)).toBe(JSON.stringify(w.small.content));
    eng.undo();
    expect(JSON.stringify(w.small.content)).toBe(before);
  });

  it('自己改过的文化没人也留着（随时能从资源库加回来的只有与内置一模一样的）', () => {
    const eng = continents();
    const zeven = BUILTIN_CULTURES.find((c) => c.group === 'western')!;
    eng.exec({ op: 'set_content', kind: 'culture', id: 'my-lonely', item: { ...zeven, id: 'my-lonely', name: '孤人', group: 'nordic' } });
    eng.exec(GEN);
    expect(worldCultures(eng.world.small).some((c) => c.id === 'my-lonely')).toBe(true);
    // 内置的、没人的文化不在
    expect(worldCultures(eng.world.small).filter((c) => c.id !== 'my-lonely').every((c) => culturesWithPeople(eng.world).has(c.id) || Object.values(eng.world.small.countries ?? {}).some((x) => x.primaryCulture === c.id))).toBe(true);
  });
});

describe('在用的内容不能移出世界', () => {
  it('文化、文化组、时代、政体：用在哪里（几处、一句话、定位的格）；引擎拒绝移出，世界不变', () => {
    const eng = peopled();
    const w = eng.world;
    const culture = [...culturesWithPeople(w)][0];
    const u = usageOf(kindOf('culture')!, strictWorld(w), culture)!;
    expect(u.count).toBeGreaterThan(0);
    expect(u.label).toMatch(/格有这种文化的人/);
    expect(u.cells!.length).toBeGreaterThan(0);
    expect(() => eng.exec({ op: 'set_content', kind: 'culture', id: culture, item: null })).toThrow(/还在用/);
    expect(worldCultures(w.small).some((c) => c.id === culture)).toBe(true);
    expect(usageOf(kindOf('cultureGroup')!, strictWorld(w), 'western')!.label).toMatch(/个文化属于它/);
    expect(() => eng.exec({ op: 'set_content', kind: 'cultureGroup', id: 'western', item: null })).toThrow(/还在用/);
    expect(usageOf(kindOf('era')!, strictWorld(w), 'medieval')).toEqual({ count: 1, label: '人文用的时代' });
    expect(() => eng.exec({ op: 'set_content', kind: 'era', id: 'medieval', item: null })).toThrow(/人文用的时代/);
    const gov = Object.values(w.small.countries!)[0].government;
    const gu = usageOf(kindOf('government')!, strictWorld(w), gov)!;
    expect(gu.label).toMatch(/个国家的政体/);
    expect(gu.cells!.length).toBeGreaterThan(0);
    expect(() => eng.exec({ op: 'set_content', kind: 'government', id: gov, item: null })).toThrow(/还在用/);
    // 没人用的政体照样能移出
    const idle = Object.keys(w.small.content!.government!).find((id) => !usageOf(kindOf('government')!, strictWorld(w), id));
    expect(idle).toBeDefined();
    eng.exec({ op: 'set_content', kind: 'government', id: idle!, item: null });
    expect(w.small.content!.government![idle!]).toBeUndefined();
    // 删掉人文以后，文化就没人用了
    eng.exec({ op: 'remove_countries' } as Command);
    eng.exec({ op: 'remove_human' });
    expect(usageOf(kindOf('culture')!, strictWorld(w), culture)).toBeNull();
    eng.exec({ op: 'set_content', kind: 'culture', id: culture, item: null });
    expect(worldCultures(w.small).some((c) => c.id === culture)).toBe(false);
  });

  it('自己的点的类型：放了点就不能移出，删掉点以后能', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_content', kind: 'pointType', id: 'r28-shrine', item: { id: 'r28-shrine', name: '小庙', color: '#aa3322' } });
    const cell = w.causes.land.findIndex((x) => x === 1);
    eng.exec({ op: 'add_point', type: 'r28-shrine', cell });
    const u = usageOf(kindOf('pointType')!, strictWorld(w), 'r28-shrine')!;
    expect(u).toEqual({ count: 1, label: '1 个点', cells: [cell] });
    expect(() => eng.exec({ op: 'set_content', kind: 'pointType', id: 'r28-shrine', item: null })).toThrow(/小庙”还在用（1 个点）/);
    const id = Number(Object.keys(w.small.points!)[0]);
    eng.exec({ op: 'remove_point', id });
    eng.exec({ op: 'set_content', kind: 'pointType', id: 'r28-shrine', item: null });
    expect(w.small.content?.pointType).toBeUndefined();
  });

  it('画过的地形类别、资源：资源库里算在用；引擎照旧让移出（画的格恢复自动）', () => {
    const eng = continents();
    const w = eng.world;
    const cls = { id: 'r28-class', name: '试验地', color: '#123456', priority: 1, rules: [{ elevMin: 99999 }] };
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: cls.id, item: cls });
    const land = [...w.causes.land.keys()].filter((i) => w.causes.land[i]).slice(0, 5);
    eng.exec({ op: 'set_cell_class', cells: land, class: cls.id });
    expect(usageOf(kindOf('terrainClass')!, strictWorld(w), cls.id)).toMatchObject({ count: 5, label: '5 格画成了它' });
    eng.exec({ op: 'set_content', kind: 'terrainClass', id: cls.id, item: null });
    expect(land.every((i) => w.causes.terrainClass![i] === 0)).toBe(true);
  });
});
