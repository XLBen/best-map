import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../commands';
import { type ContentKind, allKinds, enableCommand, itemId, kindOf } from '../content/registry';
import { digest } from '../digest';
import type { Engine } from '../engine';
import type { Era } from '../human/era';
import { PACK_FORMAT, PACK_VERSION, type PackNode, type ResourcePack, packItems, planPack, sameItem } from '../packs';
import { NO_CURRENTS, engineFor } from '../testing/fixtures';
import { addDimensionCommand } from './add-dimension';
import { builtinPacks, worldPartsOf } from './builtin-tree';
import { importCommand } from './closure';
import { newWorldContentCommands, packImportCommands } from './import';
import { type DiffLib, savedBackItem, sourceDiff, sourceDiffs, usedSourceItem } from './source-diff';

// 第六十二轮：世界里的一项和来源的库比

const BUILTIN = builtinPacks();
const LIBS: DiffLib[] = BUILTIN.map((p) => ({ key: p.id, pack: p }));
const ROOTS = LIBS.map((l) => ({ key: l.key, pack: l.pack }));

let bare: Engine;
beforeAll(() => {
  bare = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
});

// 用这个库新建世界、生成人文和国家（和向导一样：世界的底子一步，库里生成要用的一步）
function worldOf(lib: string, libs: readonly DiffLib[] = LIBS, more: { countries?: boolean } = { countries: true }): Engine {
  const e = bare.clone();
  const roots = libs.map((l) => ({ key: l.key, pack: l.pack }));
  const root = libs.find((l) => l.key === lib)!.pack;
  for (const c of newWorldContentCommands(roots, worldPartsOf(lib, root))) e.exec(c);
  const g = packItems<{ id: string; weight?: number }>(root, 'cultureGroups')
    .filter((x) => x.weight !== 0)
    .map((x) => ({ id: x.id, weight: 1 }));
  for (const c of packImportCommands(roots, { packs: [[lib]], groups: g.map((x) => x.id) }, e.world)) e.exec(c);
  e.exec({ op: 'generate_human', packs: [[lib]], groups: g, ...(more.countries ? { countries: {} } : {}) } as Command);
  e.update();
  return e;
}

const marked = (e: Engine, libs: readonly DiffLib[] = LIBS) => allKinds().flatMap((k) => [...sourceDiffs(k, e.world, libs)].filter(([, d]) => d.t === 'changed' || d.t === 'trimmed').map(([id, d]) => `${k.id}:${id}:${d.t}`));

const item = (e: Engine, kind: string, id: string) => {
  const k = kindOf(kind)!;
  return k.inWorld(e.world).find((x) => itemId(k, x) === id) as Record<string, unknown>;
};
const diffOf = (e: Engine, kind: string, id: string, libs: readonly DiffLib[] = LIBS) => sourceDiff(kindOf(kind)!, id, item(e, kind, id), e.world, libs);
const edit = (e: Engine, kind: string, id: string, patch: Record<string, unknown>) => {
  const k = kindOf(kind)! as ContentKind;
  e.exec(enableCommand(k, { ...item(e, kind, id), ...patch }, e.world));
  e.update();
};
const firstOf = (e: Engine, kind: string) => {
  const k = kindOf(kind)!;
  return itemId(k, k.inWorld(e.world)[0]);
};

// 一个我的库：整个库的副本（树是同一份）
const copyLib = (from: string, key: string): DiffLib => ({ key, pack: { ...LIBS.find((l) => l.key === from)!.pack, id: key, name: key } as PackNode });

describe('没改过的不标', () => {
  it.each(BUILTIN.map((p) => p.id))('%s：新建世界、生成人文和国家之后一项都不标', (lib) => {
    expect(marked(worldOf(lib))).toEqual([]);
  });

  it('我的库建的世界：和这个库比', () => {
    const mine = copyLib('medieval', 'my-med');
    const libs = [...LIBS, mine];
    expect(marked(worldOf('my-med', libs), libs)).toEqual([]);
  });
});

describe('改过的标', () => {
  it.each([['culture'], ['government'], ['faction'], ['landmarkType'], ['cityRank'], ['riverType'], ['lakeType'], ['islandType'], ['nameStyle'], ['cultureGroup'], ['popValue']])('%s', (kind) => {
    const e = worldOf('medieval');
    const id = firstOf(e, kind);
    edit(e, kind, id, { name: '改过' });
    const d = diffOf(e, kind, id);
    expect(d.t).toBe('changed');
    if (d.t === 'changed') {
      expect(d.lib).toBe('medieval');
      expect(d.fields).toEqual([kindOf(kind)!.fields.find((f) => f.key === 'name')?.label ?? 'name']);
    }
    expect(marked(e)).toEqual([`${kind}:${id}:changed`]);
  });

  it('生态：按字段改的也算', () => {
    const e = worldOf('medieval');
    const id = e.world.small.species[0].id;
    e.exec({ op: 'update_species', id, patch: { name: '改过' } });
    e.update();
    expect(diffOf(e, 'biome', id).t).toBe('changed');
  });

  it('库后来改了：世界没动也标（和库不同）', () => {
    const mine = copyLib('medieval', 'my-med');
    const libs0 = [...LIBS, mine];
    const e = worldOf('my-med', libs0);
    const k = kindOf('culture')!;
    const id = firstOf(e, 'culture');
    const changedPack = JSON.parse(JSON.stringify(mine.pack)) as ResourcePack;
    const walk = (n: PackNode) => {
      for (const c of (n.cultures ?? []) as { id: string; name: string }[]) if (c.id === id) c.name = '库里改了';
      for (const s of (n.packs ?? []) as PackNode[]) walk(s);
    };
    walk(changedPack);
    const libs1 = [...LIBS, { key: 'my-med', pack: changedPack }];
    expect(sourceDiff(k, id, item(e, 'culture', id), e.world, libs1).t).toBe('changed');
    expect(sourceDiff(k, id, item(e, 'culture', id), e.world, libs0).t).toBe('same');
  });
});

describe('比重不算', () => {
  it('只改 weight 不标', () => {
    const e = worldOf('medieval');
    const id = e.world.small.human!.groups[0].id;
    edit(e, 'cultureGroup', id, { weight: 0 });
    expect(diffOf(e, 'cultureGroup', id).t).toBe('same');
    edit(e, 'cultureGroup', id, { weight: 7 });
    expect(diffOf(e, 'cultureGroup', id).t).toBe('same');
    expect(marked(e)).toEqual([]);
  });

  it('依赖带来的比重 0 的组不标', () => {
    const e = bare.clone();
    for (const c of newWorldContentCommands(ROOTS, worldPartsOf('modern'))) e.exec(c);
    const source = LIBS.find((l) => l.key === 'modern')!.pack;
    const r = importCommand({ source, target: { t: 'world', world: e.world }, picks: [{ kind: 'culture', id: packItems<{ id: string }>(source, 'cultures')[0].id }] }, { path: ['modern'] });
    e.exec(r.command!);
    e.update();
    const groups = Object.values((e.world.small.content?.cultureGroup ?? {}) as Record<string, { id: string; weight?: number }>);
    expect(groups.some((g) => g.weight === 0)).toBe(true);
    expect(marked(e).filter((x) => x.endsWith(':changed'))).toEqual([]);
  });
});

describe('导入时去掉了引用：单独的一种说法，不标改过', () => {
  // 现代的社会主义共和国导入奇幻世界：自由派写到民族认同的来源去掉了
  function imported(): { e: Engine; removed: string[] } {
    const e = worldOf('fantasy');
    const source = LIBS.find((l) => l.key === 'modern')!.pack;
    const gov = packItems<{ id: string; category?: string[] }>(source, 'governments').find((g) => g.id.includes('socialist') || g.category?.includes('communist'))!;
    const r = importCommand({ source, target: { t: 'world', world: e.world }, picks: [{ kind: 'government', id: gov.id }] }, { path: ['modern'] });
    expect(r.preview.stripped.length).toBeGreaterThan(0);
    e.exec(r.command!);
    e.update();
    return { e, removed: r.preview.stripped.map((s) => `${s.from.kind}:${s.from.id}`) };
  }

  it('不算改过：trimmed，写着去掉了什么', () => {
    const { e, removed } = imported();
    expect(marked(e).filter((x) => x.endsWith(':changed'))).toEqual([]);
    const [kind, id] = removed[0].split(':');
    const d = diffOf(e, kind, id);
    expect(d.t).toBe('trimmed');
    if (d.t === 'trimmed') expect(d.gone.length).toBeGreaterThan(0);
  });

  it('又改了别的地方：改过', () => {
    const { e, removed } = imported();
    const [kind, id] = removed[0].split(':');
    edit(e, kind, id, { name: '改过' });
    expect(diffOf(e, kind, id).t).toBe('changed');
  });

  it('用库里的版本：没有的目标只有 strip 类时原样，有依赖时不把找不到的引用带回来；都不再标', () => {
    const { e, removed } = imported();
    const [kind, id] = removed[0].split(':');
    edit(e, kind, id, { name: '改过' });
    const k = kindOf(kind)!;
    const next = usedSourceItem(k, id, item(e, kind, id), e.world, LIBS)!;
    e.exec(enableCommand(k, next, e.world));
    e.update();
    expect(diffOf(e, kind, id).t).not.toBe('changed');
    // 依赖（政体写的派系）：世界里没有时去掉
    const f = firstOf(e, 'faction');
    const g = kindOf('government')!.inWorld(e.world).find((x) => (x as { factions?: string[] }).factions?.includes(f)) as { id: string; factions: string[] };
    const source = LIBS.find((l) => l.key === 'fantasy')!;
    const inLib = packItems<{ id: string; factions?: string[] }>(source.pack, 'governments').find((x) => x.id === g.id);
    if (inLib?.factions?.length) {
      const mine: DiffLib = { key: 'fantasy', pack: { format: PACK_FORMAT, version: PACK_VERSION, id: 'fantasy', name: 'x', governments: [{ ...inLib, factions: [...inLib.factions, 'not-in-world'], name: '库里改了' }] } as unknown as ResourcePack };
      const cut = usedSourceItem(kindOf('government')!, g.id, item(e, 'government', g.id), e.world, [mine])! as { factions: string[]; name: string };
      expect(cut.factions.includes('not-in-world')).toBe(false);
      expect(cut.name).toBe('库里改了');
    }
  });
});

describe('撞过名的项', () => {
  it('改名后 id、引用都不算不同；改了才算', () => {
    const e = worldOf('medieval');
    const id = firstOf(e, 'faction');
    edit(e, 'faction', id, { name: '世界里的' });
    // 从另一个包再加一份同 id 的：撞名，起 id-2
    const mineNode: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: 'mine', name: '我的', factions: [{ ...item(e, 'faction', id), name: '库里的' }] as never };
    const libs = [...LIBS, { key: 'mine', pack: mineNode }];
    const plan = planPack(e.world, mineNode, { factions: [id], defaultStyle: null });
    e.exec(plan.command);
    e.update();
    const to = plan.added[0].id;
    expect(to).not.toBe(id);
    expect(diffOf(e, 'faction', to, libs).t).toBe('same');
    edit(e, 'faction', to, { amount: 3 });
    expect(diffOf(e, 'faction', to, libs).t).toBe('changed');
    // 存回去：id 是库里的
    const saved = savedBackItem(kindOf('faction')!, to, item(e, 'faction', to), e.world, libs)!;
    expect(saved.id).toBe(id);
    expect(saved.item.id).toBe(id);
    expect(saved.lib).toBe('mine');
  });
});

describe('来源不在了', () => {
  it('来源的库删掉：不标，不报错', () => {
    const e = worldOf('medieval');
    edit(e, 'culture', firstOf(e, 'culture'), { name: '改过' });
    const left = LIBS.filter((l) => l.key !== 'medieval');
    expect(marked(e, left)).toEqual([]);
    expect(diffOf(e, 'culture', firstOf(e, 'culture'), left)).toEqual({ t: 'none' });
    expect(usedSourceItem(kindOf('culture')!, firstOf(e, 'culture'), item(e, 'culture', firstOf(e, 'culture')), e.world, left)).toBeNull();
  });

  it('库里没有这一项了：不标', () => {
    const e = worldOf('medieval');
    const id = firstOf(e, 'culture');
    edit(e, 'culture', id, { name: '改过' });
    const empty: DiffLib = { key: 'medieval', pack: { format: PACK_FORMAT, version: PACK_VERSION, id: 'medieval', name: '空的' } as ResourcePack };
    expect(diffOf(e, 'culture', id, [empty]).t).toBe('none');
  });

  it('自己做的（没有来源）不标', () => {
    const e = worldOf('medieval');
    const k = kindOf('faction')!;
    e.exec(enableCommand(k, { ...item(e, 'faction', firstOf(e, 'faction')), id: 'mine-new', name: '新的' }, e.world));
    e.update();
    expect(diffOf(e, 'faction', 'mine-new').t).toBe('none');
  });
});

describe('用库里的版本', () => {
  it('之后不再标，别的不动；撤销回到改过的样子', () => {
    const e = worldOf('medieval');
    const id = firstOf(e, 'government');
    edit(e, 'government', id, { name: '改过' });
    const before = digest(e.world.small.content);
    const k = kindOf('government')!;
    const next = usedSourceItem(k, id, item(e, 'government', id), e.world, LIBS)!;
    e.exec(enableCommand(k, next, e.world));
    e.update();
    expect(diffOf(e, 'government', id).t).toBe('same');
    expect(marked(e)).toEqual([]);
    e.undo();
    expect(digest(e.world.small.content)).toBe(before);
  });

  it('文化组留着世界的比重', () => {
    const e = worldOf('medieval');
    const id = e.world.small.human!.groups[0].id;
    edit(e, 'cultureGroup', id, { name: '改过', weight: 0 });
    const next = usedSourceItem(kindOf('cultureGroup')!, id, item(e, 'cultureGroup', id), e.world, LIBS)!;
    expect(next.weight).toBe(0);
    expect(next.name).not.toBe('改过');
  });

  it('时代：留着世界加过的变量（added）；之后不标', () => {
    const e = worldOf('fantasy');
    const era = e.world.small.human!.era;
    const roots = ROOTS.filter((r) => r.key === 'modern');
    e.exec(addDimensionCommand(roots, e.world, 'ideology', 'modern')!);
    e.update();
    const added = (item(e, 'era', era) as unknown as Era).dimensions.filter((d) => d.added);
    expect(added.map((d) => d.id)).toEqual(['ideology']);
    // 只加了变量：不算改过
    expect(diffOf(e, 'era', era).t).toBe('same');
    edit(e, 'era', era, { popDensity: 9 });
    expect(diffOf(e, 'era', era).t).toBe('changed');
    const k = kindOf('era')!;
    const pop = digest(e.world.small.popGroups);
    const next = usedSourceItem(k, era, item(e, 'era', era), e.world, LIBS)!;
    e.exec(enableCommand(k, next, e.world));
    e.update();
    const after = item(e, 'era', era) as unknown as Era;
    expect(after.dimensions.filter((d) => d.added).map((d) => d.id)).toEqual(['ideology']);
    expect(after.popDensity).not.toBe(9);
    expect(diffOf(e, 'era', era).t).toBe('same');
    expect(digest(e.world.small.popGroups)).toBe(pop);
  });

  it('时代：库后来多了、少了变量都不算不同，变量表不跟着库变', () => {
    const e = worldOf('medieval');
    const era = e.world.small.human!.era;
    const lib = LIBS.find((l) => l.key === 'medieval')!;
    const orig = packItems<Era>(lib.pack, 'eras')[0];
    const mk = (dims: Era['dimensions'], more: object = {}): DiffLib => ({ key: 'medieval', pack: { format: PACK_FORMAT, version: PACK_VERSION, id: 'medieval', name: 'x', eras: [{ ...orig, dimensions: dims, ...more }] } as unknown as ResourcePack });
    const one = [mk([...orig.dimensions, { id: 'newdim', label: '新的' }])];
    expect(diffOf(e, 'era', era, one).t).toBe('same');
    const two = [mk(orig.dimensions.slice(1))];
    expect(diffOf(e, 'era', era, two).t).toBe('same');
    const three = [mk([...orig.dimensions, { id: 'newdim', label: '新的' }], { popDensity: 77 })];
    expect(diffOf(e, 'era', era, three).t).toBe('changed');
    const next = usedSourceItem(kindOf('era')!, era, item(e, 'era', era), e.world, three)! as unknown as Era;
    expect(next.dimensions.map((d) => d.id)).toEqual(orig.dimensions.map((d) => d.id));
    expect(next.popDensity).toBe(77);
  });
});

describe('存回我的库', () => {
  const writeBack = (lib: DiffLib, kind: ContentKind, id: string, next: unknown): DiffLib => {
    const swap = (n: PackNode): PackNode => {
      const list = n[kind.pack.key];
      const out: PackNode = Array.isArray(list) ? { ...n, [kind.pack.key]: list.map((x) => (itemId(kind, x) === id ? next : x)) } : n;
      return Array.isArray(n.packs) ? { ...out, packs: n.packs.map(swap) } : out;
    };
    return { key: lib.key, pack: swap(lib.pack) };
  };

  it('存回之后不再标；比重留库的', () => {
    const mine = copyLib('medieval', 'my-med');
    const libs = [...LIBS, mine];
    const e = worldOf('my-med', libs);
    const id = e.world.small.human!.groups[0].id;
    const k = kindOf('cultureGroup')!;
    const libWeight = packItems<{ id: string; weight?: number }>(mine.pack, 'cultureGroups').find((x) => x.id === id)!.weight;
    edit(e, 'cultureGroup', id, { name: '改过', weight: 5 });
    const saved = savedBackItem(k, id, item(e, 'cultureGroup', id), e.world, libs)!;
    expect(saved.item.name).toBe('改过');
    expect(saved.item.weight).toBe(libWeight);
    const after = [...LIBS, writeBack(mine, k, id, saved.item)];
    expect(sourceDiff(k, id, item(e, 'cultureGroup', id), e.world, after).t).toBe('same');
  });

  it('时代：世界加的变量不进库，存回之后不标', () => {
    const mine = copyLib('fantasy', 'my-fan');
    const libs = [...LIBS, mine];
    const e = worldOf('my-fan', libs);
    const era = e.world.small.human!.era;
    e.exec(addDimensionCommand(ROOTS.filter((r) => r.key === 'modern'), e.world, 'ideology', 'modern')!);
    edit(e, 'era', era, { popDensity: 9 });
    const k = kindOf('era')!;
    const saved = savedBackItem(k, era, item(e, 'era', era), e.world, libs)!;
    expect((saved.item as unknown as Era).dimensions.some((d) => d.id === 'ideology')).toBe(false);
    expect(saved.item.popDensity).toBe(9);
    const after = [...LIBS, writeBack(mine, k, era, saved.item)];
    expect(sourceDiff(k, era, item(e, 'era', era), e.world, after).t).toBe('same');
    expect((item(e, 'era', era) as unknown as Era).dimensions.some((d) => d.id === 'ideology')).toBe(true);
  });

  it('奇幻的河：加进世界时关掉的“自然生成”不写回去', () => {
    const e = worldOf('fantasy');
    const k = kindOf('riverType')!;
    const river = { ...(k.inWorld(e.world)[0] as Record<string, unknown>), id: 'my-river', name: '我的河' };
    delete river.natural;
    const mine: DiffLib = { key: 'mine', pack: { format: PACK_FORMAT, version: PACK_VERSION, id: 'mine', name: '我的', riverTypes: [river] } as unknown as ResourcePack };
    const libs = [...LIBS, mine];
    e.exec(planPack(e.world, mine.pack, { riverTypes: ['my-river'], defaultStyle: null }, { path: ['mine'] }).command);
    e.update();
    expect(item(e, 'riverType', 'my-river').natural).toBe(false);
    expect(diffOf(e, 'riverType', 'my-river', libs).t).toBe('same');
    edit(e, 'riverType', 'my-river', { name: '改过' });
    const saved = savedBackItem(k, 'my-river', item(e, 'riverType', 'my-river'), e.world, libs)!;
    expect(saved.item.natural).toBeUndefined();
    const after = [...LIBS, writeBack(mine, k, 'my-river', saved.item)];
    expect(sourceDiff(k, 'my-river', item(e, 'riverType', 'my-river'), e.world, after).t).toBe('same');
  });

  it('写到库里没有的项：说出来', () => {
    const mine = copyLib('medieval', 'my-med');
    const libs = [...LIBS, mine];
    const e = worldOf('my-med', libs);
    const fk = kindOf('faction')!;
    e.exec(enableCommand(fk, { ...item(e, 'faction', firstOf(e, 'faction')), id: 'only-here', name: '只在世界里' }, e.world));
    const gov = firstOf(e, 'government');
    const g = item(e, 'government', gov) as { factions?: string[] };
    edit(e, 'government', gov, { factions: [...(g.factions ?? []), 'only-here'] });
    const saved = savedBackItem(kindOf('government')!, gov, item(e, 'government', gov), e.world, libs)!;
    expect(saved.missing).toEqual(['只在世界里']);
    expect(sameItem(saved.item.factions, [...(g.factions ?? []), 'only-here'])).toBe(true);
  });
});

describe('比较用的字按对象记', () => {
  it('包和世界里的项不被改动', () => {
    const before = JSON.stringify(LIBS.find((l) => l.key === 'medieval')!.pack);
    const e = worldOf('medieval');
    const content = JSON.stringify(e.world.small.content);
    marked(e);
    const id = firstOf(e, 'culture');
    edit(e, 'culture', id, { name: '改过' });
    savedBackItem(kindOf('culture')!, id, item(e, 'culture', id), e.world, LIBS);
    usedSourceItem(kindOf('culture')!, id, item(e, 'culture', id), e.world, LIBS);
    e.undo();
    expect(JSON.stringify(e.world.small.content)).toBe(content);
    expect(JSON.stringify(LIBS.find((l) => l.key === 'medieval')!.pack)).toBe(before);
  });
});
