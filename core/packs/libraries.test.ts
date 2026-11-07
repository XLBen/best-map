import { describe, expect, it } from 'vitest';
import { danglingLinks, linkProblems, linkTable, packScope, worldScope } from '../content/links';
import { digest } from '../digest';
import { Engine } from '../engine';
import { cultureGroupById, worldCultureGroups, worldCultures } from '../human/era';
import { type PackNode, PACK_DEPTH, PACK_MAX_SUBPACKS, findPack, ownItems, packItems, subPacks } from '../packs';
import { NO_CURRENTS, engineFor, humanDigest } from '../testing/fixtures';
import saved from './libraries-digests.json';
import { DEFAULT_LIBRARY, LIBRARY_BASE_PACKS, builtinItem, builtinPacks, isBuiltinSame, worldPartsOf } from './builtin-tree';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_ERAS, CULTURE_REGIONS, ERA_PACKS } from './eras';
import { packImportCommands, packImportPlan } from './import';
import { writeFileSync } from 'node:fs';

// 第五十一轮：每个时代一个完整的库，“通用”拆进了各库。这里查每个库单独就够用：世界的底子都在、引用都找得到、
// 新世界只带默认的文化组（别的比重是 0，不参与生成）。各库的摘要记在 libraries-digests.json（LIB_RECORD=1 重录，只在有意改变结果时）。
// 第七十三轮重录六个库的 content、origin：时代换了样子（国家格局）、多了国家格局这种内容；生成的那些（人口、国家、集团……）一个没变
// （核对过把时代写回旧的 relations、去掉国家格局和它的来源时与原来的值逐个相同）

const LIB = builtinPacks();
const top = (id: string): PackNode => LIB.find((p) => p.id === id)!;
const HISTORY = ['antiquity', 'medieval', 'industrial', 'modern'];
const EU4 = CULTURE_REGIONS.flatMap((r) => r.groups);
const record = !!process.env.LIB_RECORD;
const out: Record<string, unknown> = record ? {} : saved;

// 一个库新建世界（向导默认：先加世界的底子，再生成地形；生成之前加时代包里的、默认的组）
const defaultsOf = (id: string) => ERA_PACKS.get(id)!.cultures.map(([g, w]) => ({ id: g, weight: w }));
function libraryWorld(id: string, groups = defaultsOf(id)): Engine {
  const eng = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
  for (const c of packImportCommands(LIB, { packs: worldPartsOf(id), groups: [] }, eng.world)) eng.exec(c);
  eng.exec(NO_CURRENTS);
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
  for (const c of packImportCommands(LIB, { packs: [[id]], groups: groups.map((g) => g.id) }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [[id]], groups, countries: {}, settlements: {} });
  return eng;
}

describe('六个库', () => {
  it('六个，没有通用；一层 128 个小包够放下“文化”的 71 组（也还能加）；层数没变', () => {
    expect(LIB.map((p) => p.id)).toEqual(['antiquity', 'medieval', 'industrial', 'modern', 'fantasy', 'scifi']);
    expect(BUILTIN_ERAS.map((e) => e.id)).toEqual(LIB.map((p) => p.id));
    expect(PACK_DEPTH).toBe(2);
    expect(EU4.length).toBe(71);
    expect(PACK_MAX_SUBPACKS).toBeGreaterThan(EU4.length + 20);
    for (const p of LIB) for (const n of subPacks(p)) expect(subPacks(n).length, `${p.id}/${n.id}`).toBeLessThanOrEqual(PACK_MAX_SUBPACKS);
  });

  it('基础、自然、地名、星球形态、画风、国家等级每个库都有；是同一份，不多占内存', () => {
    for (const p of LIB) {
      for (const id of LIBRARY_BASE_PACKS) expect(findPack(p, [id]), `${p.id}/${id}`).toBeDefined();
      for (const path of worldPartsOf(p.id)) expect(findPack(p, path.slice(1)), path.join('/')).toBeDefined();
      for (const id of ['base', 'nature', 'names', 'styles', 'tiers']) expect(findPack(p, [id])).toBe(findPack(top(DEFAULT_LIBRARY), [id]));
    }
    // 地名风格的项也是同一份
    expect(ownItems(findPack(top('antiquity'), ['names', 'zh'])!, 'nameStyles')[0]).toBe(ownItems(findPack(top('scifi'), ['names', 'zh'])!, 'nameStyles')[0]);
  });

  it('比重 0 的组：四个历史库共用一份小包，加了 weight: 0 的组别的字段和内置的是同一份；内置的原样是没写比重的那一份', () => {
    const kongoIn = (id: string) => findPack(top(id), ['cultures', 'kongo'])!;
    expect(kongoIn('medieval').weight).toBe(0);
    expect(kongoIn('antiquity')).toBe(kongoIn('medieval'));
    expect(kongoIn('industrial').weight).toBeGreaterThan(0);
    const spare = ownItems<{ id: string; weight?: number; name: string }>(kongoIn('medieval'), 'cultureGroups')[0];
    const plain = BUILTIN_CULTURE_GROUPS.find((g) => g.id === 'kongo')!;
    expect(spare.weight).toBe(0);
    expect(plain.weight).toBeUndefined();
    expect({ ...spare, weight: undefined }).toEqual({ ...plain, weight: undefined });
    expect(builtinItem('cultureGroup', 'kongo')!.item).toBe(plain);
    expect(isBuiltinSame('cultureGroup', spare)).toBe(true);
    // 一个只有比重 0 的组（哪个时代都不默认带）也认得内置的原样
    const never = EU4.find((g) => !HISTORY.some((id) => ERA_PACKS.get(id)!.cultures.some(([x]) => x === g)))!;
    expect((builtinItem('cultureGroup', never)!.item as { weight?: number }).weight).toBeUndefined();
  });

  it('奇幻、科幻不带 EU4 的文化；四个历史库带全部，默认带的还是时代文件写的那些', () => {
    for (const id of ['fantasy', 'scifi']) {
      const groups = packItems<{ id: string }>(top(id), 'cultureGroups').map((g) => g.id);
      expect(groups.filter((g) => EU4.includes(g)), id).toEqual([]);
      expect(groups).toEqual(ERA_PACKS.get(id)!.cultures.map(([g]) => g));
    }
    for (const id of HISTORY) {
      const nodes = subPacks(findPack(top(id), ['cultures'])!);
      expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(EU4));
      expect(nodes.filter((n) => n.weight !== 0).map((n) => n.id)).toEqual(ERA_PACKS.get(id)!.cultures.map(([g]) => g));
    }
  });
});

describe('每个库单独够用', () => {
  it('引用表本身没有问题', () => {
    expect(linkProblems()).toEqual([]);
  });

  for (const p of LIB) {
    it(`${p.id}：库里 hard、auto 的引用都找得到；strip 的（缺了能去掉的）只有写明的那几种`, () => {
      const bad = danglingLinks(linkTable(packScope(p)));
      expect(bad.filter((b) => b.link.cls === 'hard').map((b) => `${b.from.kind}:${b.from.id} → ${b.link.id}`)).toEqual([]);
      expect(bad.filter((b) => b.link.cls === 'auto').map((b) => `${b.from.kind}:${b.from.id} → ${b.link.id}`)).toEqual([]);
      const strips = new Map<string, number>();
      for (const b of bad) if (b.link.cls === 'strip') strips.set(`${b.from.kind}→${b.link.kinds[0]}`, (strips.get(`${b.from.kind}→${b.link.kinds[0]}`) ?? 0) + 1);
      const got = Object.fromEntries([...strips].sort());
      if (record) out[`${p.id}:strip`] = got;
      else expect(got).toEqual((saved as Record<string, unknown>)[`${p.id}:strip`]);
    });

    it(`${p.id}：新世界走得通，只带默认的文化组，世界里 hard 的引用都找得到（auto、strip 的目标可能是没带进来的组），摘要记着`, () => {
      const eng = libraryWorld(p.id);
      const small = eng.world.small;
      expect(eng.lastSkipped).toEqual([]);
      expect(small.human!.era).toBe(p.id);
      expect(small.genStamp!.packs).toEqual([[p.id]]);
      const want = ERA_PACKS.get(p.id)!.cultures.map(([g]) => g);
      expect(worldCultureGroups(small).map((g) => g.id)).toEqual(want);
      expect(small.human!.groups.map((g) => g.id)).toEqual(want);
      expect(Object.keys(small.countries!).length).toBeGreaterThan(0);
      // 世界的底子都从这个库来
      for (const [kind, id] of [['biome', 'taiga'], ['terrainClass', 'plains'], ['nameStyle', 'zh-default'], ['mapStyle', 'realistic'], ['countryTier', 'city']] as const) expect(small.origin?.[kind]?.[id]?.[0], `${kind}:${id}`).toBe(p.id);
      const bad = danglingLinks(linkTable(worldScope(eng.world)));
      expect(bad.filter((b) => b.link.cls === 'hard').map((b) => `${b.from.kind}:${b.from.id} → ${b.link.id}`)).toEqual([]);
      const d = { ...humanDigest(eng.world), content: digest(small.content ?? null), origin: digest(small.origin ?? null) };
      if (record) out[p.id] = d;
      else expect(d).toEqual((saved as Record<string, unknown>)[p.id]);
      if (record && p === LIB.at(-1)) writeFileSync(new URL('./libraries-digests.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
    });
  }
});

describe('比重 0 的组', () => {
  const zero = EU4.find((g) => !ERA_PACKS.get('medieval')!.cultures.some(([x]) => x === g))!;

  it('整个库加进世界时不带；点名了才带，带的时候不写这个 0（用户就是要它参与）', () => {
    const eng = libraryWorld('medieval');
    expect(cultureGroupById(eng.world.small, zero)).toBeUndefined();
    const plan = packImportPlan(LIB, { packs: [['medieval']], groups: [zero] }, eng.world);
    expect(plan.groups).toEqual([zero]);
    for (const c of plan.commands) eng.exec(c);
    expect(cultureGroupById(eng.world.small, zero)!.weight).toBeUndefined();
    expect(worldCultures(eng.world.small).some((c) => c.group === zero)).toBe(true);
    expect(cultureGroupById(eng.world.small, zero)).toEqual(BUILTIN_CULTURE_GROUPS.find((g) => g.id === zero));
  });

  it('同一组在几个库里：选的库有就记选的库（第五十二轮）；选的库没有时比重不是 0 的优先，都是 0 时第一个库的', () => {
    // 刚果中世纪不默认带，近现代默认带
    expect(packImportPlan(LIB, { packs: [['medieval']], groups: ['kongo'] }).added.find((a) => a.section === 'cultureGroups')?.id).toBe('kongo');
    const from = (lib: string, id: string) => {
      const cmds = packImportCommands(LIB, { packs: [[lib]], groups: [id] });
      const hit = cmds.flatMap((c) => (c.op === 'batch' ? c.commands : [c])).find((c) => c.op === 'set_content' && c.kind === 'cultureGroup' && c.id === id);
      return (hit as { from?: string[] } | undefined)?.from;
    };
    expect(from('medieval', 'kongo')).toEqual(['medieval', 'cultures', 'kongo']);
    const never = EU4.find((g) => !HISTORY.some((id) => ERA_PACKS.get(id)!.cultures.some(([x]) => x === g)))!;
    expect(from('modern', never)).toEqual(['modern', 'cultures', never]);
    // 奇幻没有 EU4 的组：点名时在别的库里找
    expect(from('fantasy', 'kongo')).toEqual(['industrial', 'cultures', 'kongo']);
    expect(from('fantasy', never)).toEqual(['antiquity', 'cultures', never]);
  });

  it('依赖带来的（整个小包加进来、没有点名）比重是 0，留在世界里不参与生成，和不在世界里逐项相同', () => {
    const a = libraryWorld('medieval');
    const b = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
    for (const c of packImportCommands(LIB, { packs: worldPartsOf('medieval'), groups: [] }, b.world)) b.exec(c);
    b.exec(NO_CURRENTS);
    b.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    b.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    const groups = defaultsOf('medieval');
    // 比重 0 的组的整个小包：没点名，组带着 0
    for (const c of packImportCommands(LIB, { packs: [['medieval', 'cultures', zero]] }, b.world)) b.exec(c);
    expect(cultureGroupById(b.world.small, zero)!.weight).toBe(0);
    for (const c of packImportCommands(LIB, { packs: [['medieval']], groups: groups.map((g) => g.id) }, b.world)) b.exec(c);
    b.exec({ op: 'generate_human', packs: [['medieval']], groups: [...groups, { id: zero, weight: 5 }], countries: {}, settlements: {} });
    expect(b.world.small.human!.groups.map((g) => g.id)).toEqual(groups.map((g) => g.id));
    const bad = new Set(worldCultures(b.world.small).filter((c) => c.group === zero).map((c) => c.id));
    expect(bad.size).toBeGreaterThan(0);
    expect(Object.values(b.world.small.popGroups!).some((t) => bad.has(t.culture))).toBe(false);
    expect(Object.values(b.world.small.countries!).some((c) => bad.has(c.primaryCulture))).toBe(false);
    // 世界里多了这一组，人文、地图与没有它时逐项相同
    expect(humanDigest(b.world)).toEqual(humanDigest(a.world));
  });
});

describe('生成用的包记在 small.genStamp（第五十一轮，以前是 human.packs）', () => {
  it('human 里没有 packs；撤销、重做、去掉人文都跟着；重新生成没写 packs 时照它定规则', () => {
    const eng = libraryWorld('modern');
    const small = () => eng.world.small;
    expect(small().human).not.toHaveProperty('packs');
    expect(small().genStamp).toEqual({ packs: [['modern']] });
    eng.undo();
    expect(small().human).toBeUndefined();
    expect(small().genStamp).toBeUndefined();
    eng.redo();
    expect(small().genStamp).toEqual({ packs: [['modern']] });
    eng.exec({ op: 'regenerate_human' });
    expect(small().human!.era).toBe('modern');
    // 换了包：记新的
    for (const c of packImportCommands(LIB, { packs: [['fantasy']], groups: ['elven'] }, eng.world)) eng.exec(c);
    eng.exec({ op: 'regenerate_human', packs: [['fantasy'], ['modern']], groups: [{ id: 'elven', weight: 1 }] });
    expect(small().genStamp).toEqual({ packs: [['fantasy'], ['modern']] });
    expect(small().human!.era).toBe('fantasy');
    eng.exec({ op: 'remove_human' });
    expect(small().genStamp).toBeUndefined();
  });

  it('世界文件的格式没变：以前的文件（from、packs 写着 common）照样重放，地图不变；来源指向不存在的包，和删掉了那个包一样', () => {
    const eng = libraryWorld('medieval');
    const old = (x: unknown): unknown => (typeof x === 'string' ? x : Array.isArray(x) ? (x[0] === 'medieval' && LIBRARY_BASE_PACKS.has(x[1] as string) ? ['common', ...x.slice(1)] : x.map(old)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, old(v)])) : x);
    const doc = eng.toDoc();
    const replayed = Engine.fromDoc({ ...doc, commands: doc.commands.map(old) as typeof doc.commands }, eng.world.mesh);
    expect(humanDigest(replayed.world)).toEqual(humanDigest(eng.world));
    expect(digest(replayed.world.small.content ?? null)).toBe(digest(eng.world.small.content ?? null));
    expect(replayed.world.small.origin!.biome.taiga).toEqual(['common', 'nature']);
  });
});
