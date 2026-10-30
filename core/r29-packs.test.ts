import { describe, expect, it } from 'vitest';

import { compactDoc, compactWorldDoc, splitWorldContent } from './compact';
import { allKinds, builtinOf, itemId, kindOf, usageOf } from './content/registry';
import { strictWorld } from './content/usage';
import { unusedContent } from './content/unused';
import { Engine } from './engine';
import { digest, worldDigest } from './digest';

import { addToPack, findPack, ownItems, packItems, packPaths, packProblems, parsePack, planPack, readPack, type ResourcePack, subPacks } from './packs';
import { BASE_PATH, builtinItem, builtinItems, builtinOrigin, builtinPacks, isBuiltinSame, originOf } from './packs/builtin-tree';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES, ERA_PACKS, VALUE_ERAS } from './packs/eras';
import { BUILTIN_PLANET_FORMS } from './packs/planet-forms';

import { FANTASY_RIVER_TYPES } from './packs/fantasy-rivers';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from './packs/governments';
import { BUILTIN_STYLES } from './packs/names';

import { continents, snapshot, humanExec, FANTASY_PACK, type HumanCommand } from './testing/fixtures';
import { mapDiff } from './tidy';
import { BUILTIN_ISLAND_TYPES } from './packs/base';
import { DEFAULT_SPECIES } from './packs/nature';

// 第二十九轮的核心：资源包的树、内容的来源、生成后只留用到的、整理本世界、压缩世界文件、打开时拆开。
// 第三十轮：生成只读世界里的内容（测试里 humanExec 先把时代包加进世界），清理不论是不是内置原样

const top = (id: string) => builtinPacks().find((p) => p.id === id)!;
const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }], countries: {} };
const peopled = () =>
  snapshot('r29:peopled', () => {
    const e = continents();
    humanExec(e, GEN);
    return e;
  });

describe('内置资源包的树', () => {
  it('每一个内置项至少在一个包里：政体、派系、取值、生态、河湖、资源、星球形态、文化组、文化、地名风格……一项不漏', () => {
    const missing: string[] = [];
    const has = (kind: string, id: string) => !!builtinItem(kind, id)?.paths.length;
    for (const k of allKinds()) for (const x of builtinOf(k.id)) if (!has(k.id, itemId(k, x))) missing.push(`${k.id}:${itemId(k, x)}`);
    for (const k of allKinds()) for (const x of packItems(FANTASY_PACK, k.pack.key)) if (!has(k.id, itemId(k, x))) missing.push(`fantasy ${k.id}:${itemId(k, x)}`);
    for (const t of BUILTIN_ISLAND_TYPES) if (!has('islandType', t.id)) missing.push(`island:${t.id}`);
    expect(missing).toEqual([]);
    // 几样数一数
    const count = (kind: string) => builtinItems().filter((b) => b.kind === kind).length;
    expect(count('government')).toBe(BUILTIN_GOVERNMENTS.length);
    expect(count('faction')).toBe(BUILTIN_FACTIONS.length);
    expect(count('popValue')).toBe(BUILTIN_POP_VALUES.length);
    expect(count('culture')).toBe(BUILTIN_CULTURES.length);
    expect(count('cultureGroup')).toBe(BUILTIN_CULTURE_GROUPS.length);
    expect(count('nameStyle')).toBe(BUILTIN_STYLES.length);
    expect(count('biome')).toBe(DEFAULT_SPECIES.length + packItems(FANTASY_PACK, 'biomes').length);
    expect(count('riverType')).toBe(FANTASY_RIVER_TYPES.length);
    expect(count('planetForm')).toBe(packItems(FANTASY_PACK, 'planetForms').length + BUILTIN_PLANET_FORMS.length);
  });

  it('大包：每个内置时代一个，加上通用；每个时代包里有这个时代的全部政体、派系、取值', () => {
    expect(builtinPacks().map((p) => p.id)).toEqual([...BUILTIN_ERAS.map((e) => e.id), 'common']);
    for (const era of BUILTIN_ERAS) {
      const p = top(era.id);
      expect(ownItems(findPack(p, ['era'])!, 'eras')).toEqual([era]);
      const govs = packItems<{ id: string }>(findPack(p, ['governments'])!, 'governments').map((g) => g.id);
      for (const id of ERA_PACKS.get(era.id)!.governments) expect(govs).toContain(id);
      const facs = packItems<{ id: string }>(findPack(p, ['factions'])!, 'factions').map((f) => f.id);
      for (const id of ERA_PACKS.get(era.id)!.factions) expect(facs).toContain(id);
      for (const d of era.dimensions) {
        const want = BUILTIN_POP_VALUES.filter((v) => v.dimension === d.id && (!VALUE_ERAS.get(v.id) || VALUE_ERAS.get(v.id)!.includes(era.id))).map((v) => v.id);
        expect(ownItems<{ id: string }>(findPack(p, [d.id])!, 'popValues').map((v) => v.id)).toEqual(want);
      }
      // 默认带的文化组每组一个小包：组、文化、地名风格
      for (const [g] of ERA_PACKS.get(era.id)!.cultures) {
        const node = findPack(p, ['cultures', String(g)])!;
        expect(ownItems<{ id: string }>(node, 'cultureGroups').map((x) => x.id)).toEqual([g]);
        expect(ownItems<{ id: string }>(node, 'cultures').map((c) => c.id)).toEqual(BUILTIN_CULTURES.filter((c) => c.group === g).map((c) => c.id));
      }
    }
    // 中世纪 ▸ 政体：13 种全在
    expect(ownItems(findPack(top('medieval'), ['governments'])!, 'governments').length).toBe(13);
    // 几个时代共用的政体：同一份
    const a = ownItems(findPack(top('medieval'), ['governments'])!, 'governments').find((g) => (g as { id: string }).id === 'empire');
    const b = ownItems(findPack(top('industrial'), ['governments'])!, 'governments').find((g) => (g as { id: string }).id === 'empire');
    expect(a).toBe(b);
    expect(builtinItem('government', 'empire')!.paths.map((p) => p[0])).toEqual(['medieval', 'industrial', 'fantasy']);
    // 奇幻另有生态、河、湖、资源、星球形态
    expect(subPacks(top('fantasy')).map((x) => x.id)).toEqual(expect.arrayContaining(['biomes', 'rivers', 'lakes', 'resources', 'forms']));
    // 通用：基础、自然、地名（中文、按地区）、星球形态、文化（没有时代默认带的组）
    const common = top('common');
    expect(subPacks(common).map((x) => x.id)).toEqual(['base', 'nature', 'names', 'forms', 'cultures']);
    expect(packItems(findPack(common, ['nature'])!, 'biomes')).toEqual(DEFAULT_SPECIES);
    expect(subPacks(findPack(common, ['names'])!).length).toBeGreaterThan(5);
    const rest = packItems<{ id: string }>(findPack(common, ['cultures'])!, 'cultureGroups').map((g) => g.id);
    const byEra = new Set(BUILTIN_ERAS.flatMap((e) => ERA_PACKS.get(e.id)!.cultures.map(([g]) => g)));
    expect(rest.sort()).toEqual(BUILTIN_CULTURE_GROUPS.map((g) => g.id).filter((g) => !byEra.has(g)).sort());
    expect(builtinOrigin('islandType', 'atoll')).toEqual([...BASE_PATH]);
  });

  it('内置的大包能写成文件、读回来、检查（没有问题）', () => {
    for (const p of builtinPacks()) {
      const r = readPack(JSON.stringify(p));
      expect(r.ok, p.id).toBe(true);
      if (!r.ok) continue;
      expect(JSON.parse(JSON.stringify(r.pack))).toEqual(JSON.parse(JSON.stringify(p)));
      expect(packProblems(r.pack).filter((x) => x.includes('id 都是')), p.id).toEqual([]);
    }
  });
});

describe('嵌套的资源包', () => {
  const style = (id: string) => ({ ...BUILTIN_STYLES[1], id, name: `风格${id}` });
  const nested: ResourcePack = {
    format: 'map2-pack',
    version: 1,
    id: 'tree',
    name: '一棵树',
    governments: [],
    packs: [
      { id: 'a', name: '甲', nameStyles: [style('s1')] },
      { id: 'b', name: '乙', packs: [{ id: 'c', name: '丙', nameStyles: [style('s1'), style('s2')] }] },
    ],
  };

  it('读、检查：小包一层层查；最多两层；出错时写明是哪个小包；旧文件照旧读', () => {
    const r = parsePack(nested);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(packItems<{ id: string }>(r.pack, 'nameStyles').map((s) => s.id)).toEqual(['s1', 's2']);
    expect(ownItems(r.pack, 'nameStyles')).toEqual([]);
    expect(packPaths(r.pack, 'nameStyles', 's1')).toEqual([['a'], ['b', 'c']]);
    expect(packProblems(r.pack)).toEqual([]);
    // 两个小包里同一个 id、内容不同：提醒
    const clash = structuredClone(nested);
    (clash.packs![1].packs![0].nameStyles as { name: string }[])[0].name = '别的';
    expect(packProblems(clash)).toContain('有两个地名风格的 id 都是 s1');
    // 第三层不行
    const deep = structuredClone(nested);
    deep.packs![1].packs![0].packs = [{ id: 'd', name: '丁' }];
    const bad = parsePack(deep);
    expect(!bad.ok && bad.errors.join()).toMatch(/小包“乙”里的小包“丙”：不认识的部分：packs/);
    // 小包里的项按格式查
    const broken = structuredClone(nested);
    (broken.packs![0].nameStyles as { kind: string }[])[0].kind = 'nope';
    const b2 = parsePack(broken);
    expect(!b2.ok && b2.errors[0]).toMatch(/^小包“甲”里的地名风格第 1 个“风格s1”的 kind：/);
    // 旧的没有 packs 的文件
    expect(readPack(JSON.stringify(FANTASY_PACK)).ok).toBe(true);
  });

  it('用到世界：整棵树一步；每条命令带上来源（第一次出现的小包），世界里记进 small.origin', () => {
    const eng = continents();
    const plan = planPack(eng.world, nested, { nameStyles: ['s1', 's2'] });
    expect(plan.command.commands.map((c) => (c as { from?: string[] }).from)).toEqual([
      ['tree', 'a'],
      ['tree', 'b', 'c'],
    ]);
    eng.exec(plan.command);
    expect(eng.world.small.origin?.nameStyle).toMatchObject({ s1: ['tree', 'a'], s2: ['tree', 'b', 'c'] });
    // 用一个小包时给它的完整路径
    const sub = planPack(continents().world, findPack(nested, ['b', 'c'])!, { nameStyles: ['s2'] }, { path: ['tree', 'b', 'c'] });
    expect((sub.command.commands[0] as { from?: string[] }).from).toEqual(['tree', 'b', 'c']);
  });

  it('addToPack：按种类分小包，一模一样的不重复存，同 id 不同的换掉', () => {
    const base: ResourcePack = { format: 'map2-pack', version: 1, id: 'from-w', name: '来自《世界》' };
    const one = addToPack(base, [
      { kind: 'nameStyle', item: style('x') },
      { kind: 'government', item: BUILTIN_GOVERNMENTS[0] },
    ]);
    expect([one.added, one.same, one.replaced]).toEqual([2, 0, 0]);
    expect(subPacks(one.pack).map((p) => p.id)).toEqual(['nameStyles', 'governments']);
    const two = addToPack(one.pack, [
      { kind: 'nameStyle', item: style('x') },
      { kind: 'nameStyle', item: { ...style('x'), name: '改过' } },
    ]);
    expect([two.added, two.same, two.replaced]).toEqual([0, 1, 1]);
    expect(packItems<{ name: string }>(two.pack, 'nameStyles').map((s) => s.name)).toEqual(['改过']);
    expect(parsePack(two.pack).ok).toBe(true);
  });
});

describe('来源（small.origin）', () => {
  it('添加、改、移出、撤销、重放都一致；本世界自己做的没有来源', () => {
    const eng = continents();
    const w = eng.world;
    const gov = BUILTIN_GOVERNMENTS[0] as unknown as Record<string, unknown>;
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id as string, item: gov, from: ['antiquity', 'governments'] });
    expect(w.small.origin?.government).toEqual({ [gov.id as string]: ['antiquity', 'governments'] });
    // 改一项没写 from：来源照旧
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id as string, item: { ...gov, name: '改过' } });
    expect(w.small.origin?.government?.[gov.id as string]).toEqual(['antiquity', 'governments']);
    // 自己做的：没有来源（离群）
    eng.exec({ op: 'set_content', kind: 'government', id: 'r29-own', item: { ...gov, id: 'r29-own' } });
    expect(w.small.origin?.government?.['r29-own']).toBeUndefined();
    expect(originOf(w.small, 'government', 'r29-own', { ...gov, id: 'r29-own' })).toBeUndefined();
    // 以前的种类：河的种类
    eng.exec({ op: 'set_river_type', type: FANTASY_RIVER_TYPES[0], from: ['fantasy', 'rivers'] });
    expect(w.small.origin?.riverType).toEqual({ [FANTASY_RIVER_TYPES[0].id]: ['fantasy', 'rivers'] });
    const doc = eng.toDoc();
    expect(Engine.fromDoc(doc, w.mesh).world.small.origin).toEqual(w.small.origin);
    // 移出：来源一起去掉；撤销回来
    const before = structuredClone(w.small.origin);
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id as string, item: null });
    eng.exec({ op: 'remove_river_type', id: FANTASY_RIVER_TYPES[0].id });
    expect(w.small.origin?.government).toBeUndefined();
    expect(w.small.origin?.riverType).toBeUndefined();
    eng.undo();
    eng.undo();
    expect(w.small.origin).toEqual(before);
    // 新世界从“通用 ▸ 自然”加进来的生态记着来源
    expect(originOf(w.small, 'biome', DEFAULT_SPECIES[0].id, DEFAULT_SPECIES[0])).toEqual(['common', 'nature']);
    expect(w.small.origin?.biome?.[DEFAULT_SPECIES[0].id]).toEqual(['common', 'nature']);
  });

  it('生成人文之前从时代包加进来的记它在时代包里的位置', () => {
    const w = peopled().world;
    const gov = Object.values(w.small.countries!)[0].government;
    expect(w.small.origin?.government?.[gov]?.[0]).toBe('medieval');
    expect(w.small.origin?.era?.medieval).toEqual(['medieval', 'era']);
    const culture = Object.keys(w.small.content!.culture!)[0];
    expect(w.small.origin?.culture?.[culture]?.slice(0, 2)).toEqual(['medieval', 'cultures']);
    // 记着来源的都在世界里
    for (const [kind, ids] of Object.entries(w.small.origin ?? {})) {
      const k = kindOf(kind)!;
      const have = new Set(k.inWorld(w).map((x) => itemId(k, x)));
      for (const id of Object.keys(ids)) expect(have.has(id), `${kind}:${id}`).toBe(true);
    }
  });
});

describe('生成后只留用到的', () => {
  it('政体、派系、取值只剩用到的；拿掉的都在时代包里，一步加回来', () => {
    const w = peopled().world;
    const strict = strictWorld(w);
    for (const kind of ['government', 'faction', 'popValue']) {
      const ids = Object.keys(w.small.content?.[kind] ?? {});
      expect(ids.length, kind).toBeGreaterThan(0);
      for (const id of ids) expect(usageOf(kindOf(kind)!, strict, id), `${kind}:${id}`).not.toBeNull();
    }
    const medieval = top('medieval');
    const all = packItems<{ id: string }>(findPack(medieval, ['governments'])!, 'governments').map((g) => g.id);
    const left = Object.keys(w.small.content!.government!);
    expect(left.length).toBeLessThan(all.length);
    // 拿掉的在中世纪 ▸ 政体 里，整包加回来一步
    const eng = peopled();
    const plan = planPack(eng.world, findPack(medieval, ['governments'])!, { governments: all }, { path: ['medieval', 'governments'] });
    expect(plan.added.map((a) => a.id).sort()).toEqual(all.filter((id) => !left.includes(id)).sort());
    eng.exec(plan.command);
    expect(Object.keys(eng.world.small.content!.government!).sort()).toEqual([...all].sort());
  });

  it('第三十轮：自己做的、改过的没用到也收掉（报在移出的项里，界面存进资源库）；内置原样的由界面判断', () => {
    const eng = continents();
    const gov = { ...BUILTIN_GOVERNMENTS.find((g) => g.id === 'theocracy')!, id: 'r29-mine', name: '我的政体' } as unknown as Record<string, unknown>;
    eng.exec({ op: 'set_content', kind: 'government', id: 'r29-mine', item: gov });
    humanExec(eng, GEN);
    expect(eng.world.small.content!.government!['r29-mine']).toBeUndefined();
    const mine = eng.lastRemoved.find((r) => r.id === 'r29-mine')!;
    expect(isBuiltinSame(mine.kind, mine.item)).toBe(false);
    // 带进来又收掉的（没国家用的政体）也报着：都是内置原样
    expect(eng.lastRemoved.filter((r) => r.id !== 'r29-mine').every((r) => isBuiltinSame(r.kind, r.item))).toBe(true);
    // 换时代：旧时代那一套没人用了，移出并报出来，来源是中世纪
    // （工业时代还没有自己的政体，借用中世纪的：新的国家还用着的留下）。第三十三轮的地形上新的国家把六种都用上了，
    // 所以查“没人用的都移出、还在的都有国家用”，不再要求一定有移出的
    const govs = Object.keys(eng.world.small.content!.government ?? {});
    humanExec(eng, { op: 'regenerate_human', era: 'industrial', countries: {} });
    const gone = eng.lastRemoved.filter((r) => r.kind === 'government' && r.origin?.[0] === 'medieval');
    const used = new Set(Object.values(eng.world.small.countries ?? {}).map((c) => c.government));
    for (const id of govs) expect(gone.some((r) => r.id === id) !== used.has(id), id).toBe(true);
    expect(gone.every((r) => isBuiltinSame(r.kind, r.item))).toBe(true);
  });

  it('清理掉的再生成时复制回来、排回原来的位置：再生成一次与第一次一模一样', () => {
    const eng = peopled();
    const first = { pop: digest(eng.world.causes.popGroup!), country: digest(eng.world.causes.country!), content: JSON.stringify(eng.world.small.content) };
    humanExec(eng, GEN);
    expect({ pop: digest(eng.world.causes.popGroup!), country: digest(eng.world.causes.country!), content: JSON.stringify(eng.world.small.content) }).toEqual(first);
  });

  it('国家档案换成收掉了的时代政体：先从资源库加回来（记下来源），引擎不再自己复制', () => {
    const eng = peopled();
    const w = eng.world;
    const all = ERA_PACKS.get('medieval')!.governments;
    const idle = all.find((g) => !w.small.content!.government![g])!;
    const id = Object.values(w.small.countries!)[0].id;
    expect(() => eng.exec({ op: 'set_country', id, patch: { government: idle } })).toThrow(/先从资源库添加/);
    const item = BUILTIN_GOVERNMENTS.find((g) => g.id === idle)! as unknown as Record<string, unknown>;
    eng.exec({ op: 'batch', commands: [{ op: 'set_content', kind: 'government', id: idle, item, from: ['medieval', 'governments'] }, { op: 'set_country', id, patch: { government: idle } }] });
    expect(w.small.countries![id].government).toBe(idle);
    expect(w.small.origin?.government?.[idle]).toEqual(['medieval', 'governments']);
  });

  it('点名的文化：只带点名的那几个进来', () => {
    const eng = continents();
    const first = BUILTIN_CULTURES.find((c) => c.group === 'western')!;
    humanExec(eng, { op: 'generate_human', era: 'medieval', groups: [{ id: 'western', weight: 1, cultures: [first.id] }] });
    expect(Object.keys(eng.world.small.content!.culture!)).toEqual([first.id]);
  });

  it('自己做的时代（世界里只有它一个时代）：规则用它；政体只用世界里的，没有时不生成国家，加了包里的政体就有', () => {
    const eng = continents();
    const era = { ...BUILTIN_ERAS.find((e) => e.id === 'medieval')!, id: 'r29-era', name: '我的时代' } as Record<string, unknown>;
    eng.exec({ op: 'set_content', kind: 'era', id: 'r29-era', item: era });
    humanExec(eng, { op: 'generate_human', era: 'r29-era', groups: [{ id: 'western', weight: 1 }], countries: {} });
    expect(eng.world.small.human!.era).toBe('r29-era');
    expect(eng.world.small.countries).toBeUndefined();
    expect(eng.lastSkipped).toContain('没有政体：没有生成国家');
    humanExec(eng, { op: 'generate_human', packs: [['r29-era'], ['medieval', 'governments'], ['medieval', 'factions']], groups: [{ id: 'western', weight: 1 }], countries: {} });
    expect(eng.world.small.human!.era).toBe('r29-era');
    const govs = Object.keys(eng.world.small.content!.government!);
    expect(govs.every((g) => ERA_PACKS.get('medieval')!.governments.includes(g))).toBe(true);
    expect(Object.keys(eng.world.small.countries!).length).toBeGreaterThan(0);
  });

  it('去掉人文、国家：带进来的内容一起移出，报出来；撤销回到原样', () => {
    const eng = peopled();
    const w = eng.world;
    const before = JSON.stringify(w.small.content);
    eng.exec({ op: 'remove_countries' });
    expect(w.small.content?.government).toBeUndefined();
    expect(w.small.content?.faction).toBeUndefined();
    expect(eng.lastRemoved.map((r) => r.kind)).toEqual(expect.arrayContaining(['government', 'faction']));
    eng.exec({ op: 'remove_human' });
    for (const k of ['era', 'popValue', 'cultureGroup', 'culture', 'government', 'faction']) expect(w.small.content?.[k], k).toBeUndefined();
    for (const k of ['era', 'popValue', 'cultureGroup', 'culture']) expect(w.small.origin?.[k], k).toBeUndefined();
    eng.undo();
    eng.undo();
    expect(JSON.stringify(w.small.content)).toBe(before);
  });
});

describe('整理本世界（tidy_content）', () => {
  it('移出没用到的：没长的生态、没套上的河湖类型、没用的场、没人用的政体……地图逐值不变；报出移出的项', () => {
    const eng = peopled();
    // 加几样用不上的：一种河、一种湖（只能自己画、自己选）、一个场、一个政体
    const river = { ...FANTASY_RIVER_TYPES.find((t) => t.id === 'styx')!, natural: false };
    eng.exec({ op: 'set_river_type', type: river });
    eng.exec({ op: 'add_field', name: 'r29_field' });
    const gov = { ...BUILTIN_GOVERNMENTS[0], id: 'r29-gov', name: '闲置' } as unknown as Record<string, unknown>;
    eng.exec({ op: 'set_content', kind: 'government', id: 'r29-gov', item: gov });
    const unused = unusedContent(eng.world);
    expect(unused).toEqual(expect.arrayContaining([{ kind: 'riverType', id: 'styx' }, { kind: 'field', id: 'r29_field' }, { kind: 'government', id: 'r29-gov' }]));
    // 有些普通生态在这个世界里没长（没有一格以它为主）
    const dom = new Set(eng.world.derived.dominant);
    const idle = eng.world.small.species.filter((_, k) => !dom.has(k)).map((s) => s.id);
    expect(unused.filter((x) => x.kind === 'biome').map((x) => x.id)).toEqual(idle);
    const ref = eng.clone();
    ref.update();
    const plan = eng.planTidy();
    expect(plan.kept).toEqual([]);
    expect(plan.command!.items!.length).toBe(unused.length);
    eng.exec(plan.command!);
    expect(mapDiff(ref.world, eng.world)).toEqual([]);
    expect(eng.world.small.riverTypes ?? []).toEqual([]);
    expect(eng.world.causes.fields.r29_field).toBeUndefined();
    expect(eng.world.small.content!.government!['r29-gov']).toBeUndefined();
    // 报出来的：自己做的不是内置原样；普通生态、关着自然生成的冥河（就是奇幻包加进世界时的样子）是（界面按内置的树判断）
    const removed = eng.lastRemoved;
    const same = (id: string) => isBuiltinSame(removed.find((r) => r.id === id)!.kind, removed.find((r) => r.id === id)!.item);
    expect(same('r29-gov')).toBe(false);
    expect(same('styx')).toBe(true);
    for (const id of idle) expect(same(id)).toBe(true);
    expect(plan.removed.map((r) => r.id).sort()).toEqual(removed.map((r) => r.id).sort());
    // 一步撤销；重放一样
    expect(Engine.fromDoc(eng.toDoc(), eng.world.mesh).world.small.species.map((s) => s.id)).toEqual(eng.world.small.species.map((s) => s.id));
    eng.undo();
    expect(eng.world.small.riverTypes?.map((t) => t.id)).toEqual(['styx']);
  });

  it('没用到、但移出后地图会变的留着，写明原因', () => {
    const eng = continents();
    // 规则自动套上的血河（自然生成）：推导里有一格是它就算用到，不在候选里
    const river = { ...FANTASY_RIVER_TYPES.find((t) => t.id === 'blood_river')!, natural: true };
    eng.exec({ op: 'set_river_type', type: river });
    eng.update();
    expect((eng.world.derived.riverType ?? new Uint8Array()).some((x) => x === 1)).toBe(true);
    expect(unusedContent(eng.world).some((x) => x.id === 'blood_river')).toBe(false);
    // 硬要整理它（only，界面整个小包移出时这样问）：移出后地图会变，留着并写明原因
    const plan = eng.planTidy({ only: [{ kind: 'riverType', id: 'blood_river' }] });
    expect(plan.command).toBeNull();
    expect(plan.kept).toEqual([{ kind: 'riverType', id: 'blood_river', name: river.name, reason: expect.stringMatching(/^移出后地图会变：\d+ 格的河的种类/) }]);
  });

  it('在用的不能整理掉（命令报错，世界不变）；不在世界里的跳过', () => {
    const eng = peopled();
    const gov = Object.values(eng.world.small.countries!)[0].government;
    expect(() => eng.exec({ op: 'tidy_content', items: [{ kind: 'government', id: gov }] })).toThrow(/还在用/);
    const before = eng.toDoc().commands.length;
    eng.exec({ op: 'tidy_content', items: [{ kind: 'government', id: 'nope' }] });
    expect(eng.toDoc().commands.length).toBe(before);
  });
});

describe('压缩世界文件', () => {
  it('加过又移出的两条都去掉，没用上的加的那条去掉，末尾补整理；重放的世界与“原来的 + 整理”一模一样', () => {
    const eng = continents();
    const river = { ...FANTASY_RIVER_TYPES.find((t) => t.id === 'styx')!, natural: false };
    eng.exec({ op: 'set_river_type', type: river });
    eng.exec({ op: 'set_content', kind: 'pointType', id: 'r29-pt', item: { id: 'r29-pt', name: '小庙', color: '#aa3322' } });
    eng.exec({ op: 'remove_river_type', id: 'styx' });
    const gov = { ...BUILTIN_GOVERNMENTS[0], id: 'r29-gov' } as unknown as Record<string, unknown>;
    eng.exec({ op: 'batch', commands: [{ op: 'add_field', name: 'r29_f' }, { op: 'set_content', kind: 'government', id: 'r29-gov', item: gov }] });
    const doc = eng.toDoc();
    const r = compactWorldDoc(doc, { mesh: eng.world.mesh });
    expect(r.verified).toBe(true);
    expect(r.changed).toBe(true);
    const ops = JSON.stringify(r.doc.commands);
    expect(ops).not.toContain('styx');
    expect(ops).not.toContain('r29_f');
    expect(ops).not.toContain('r29-gov');
    // 第三十轮：新世界加的生态里在这个世界没长的也是“加了没用上”的，从加内容的那一步里去掉（不再留给末尾的整理）
    expect(r.dropped).toBeGreaterThanOrEqual(4);
    const idle = unusedContent(eng.world).filter((x) => x.kind === 'biome').map((x) => x.id);
    for (const id of idle) expect(ops).not.toContain(`"id":"${id}"`);
    expect(r.removed.map((x) => x.id)).toEqual(expect.arrayContaining(['r29-gov', 'r29_f']));
    // 重放：与原来的 + 整理一模一样
    const target = Engine.fromDoc(doc, eng.world.mesh);
    target.exec(target.planTidy().command!);
    target.update();
    expect(worldDigest(Engine.fromDoc(r.doc, eng.world.mesh).world)).toBe(worldDigest(target.world));
    // 当前的世界不变
    expect(eng.toDoc()).toEqual(doc);
    expect(compactDoc(doc, { mesh: eng.world.mesh })).toEqual(r.doc);
  });

  it('核对不上时退回原来的命令（末尾照样补上整理）', () => {
    const eng = continents();
    eng.exec({ op: 'add_field', name: 'r29_g' });
    eng.exec({ op: 'remove_field', name: 'r29_g' });
    const doc = eng.toDoc();
    let n = 0;
    const r = compactWorldDoc(doc, { mesh: eng.world.mesh, digestOf: () => String(n++) });
    expect(r.verified).toBe(false);
    expect(r.dropped).toBe(0);
    expect(r.doc.commands.slice(0, doc.commands.length)).toEqual(doc.commands);
  });

  it('提到它的命令在中间时不去掉', () => {
    const eng = continents();
    const river = { ...FANTASY_RIVER_TYPES.find((t) => t.id === 'styx')!, natural: false };
    eng.exec({ op: 'set_river_type', type: river });
    eng.exec({ op: 'set_river_type', type: { ...river, name: '改名' } });
    eng.exec({ op: 'remove_river_type', id: 'styx' });
    const r = compactWorldDoc(eng.toDoc(), { mesh: eng.world.mesh });
    // 只去掉新世界加的、没长的生态；冥河的三条都留着
    expect(r.doc.commands.filter((c) => c.op === 'set_river_type').length).toBe(2);
    expect(r.doc.commands.filter((c) => c.op === 'remove_river_type').length).toBe(1);
  });
});

describe('打开世界文件时拆开', () => {
  it('自己做的、改过的内置项列出来；内置原样（含用到世界时关了自然生成的奇幻河）不列', () => {
    const eng = continents();
    const blood = FANTASY_RIVER_TYPES.find((t) => t.id === 'blood_river')!;
    eng.exec(planPack(eng.world, top('fantasy'), { riverTypes: [blood.id] }).command);
    const gov = { ...BUILTIN_GOVERNMENTS[0], name: '改过' } as unknown as Record<string, unknown>;
    eng.exec({ op: 'set_content', kind: 'government', id: gov.id as string, item: gov, from: ['antiquity', 'governments'] });
    eng.exec({ op: 'set_content', kind: 'government', id: 'r29-own', item: { ...gov, id: 'r29-own' } });
    expect(isBuiltinSame('riverType', eng.world.small.riverTypes![0])).toBe(true);
    const items = splitWorldContent(eng.world);
    expect(items.map((x) => `${x.kind}:${x.id}`).sort()).toEqual([`government:${gov.id}`, 'government:r29-own']);
    expect(items.find((x) => x.id === gov.id)!.origin).toEqual(['antiquity', 'governments']);
    // 存进“来自《世界》”：再存一次不重复
    const pack: ResourcePack = { format: 'map2-pack', version: 1, id: 'from', name: '来自《世界》' };
    const once = addToPack(pack, items);
    expect(once.added).toBe(2);
    expect(addToPack(once.pack, items).same).toBe(2);
  });
});
