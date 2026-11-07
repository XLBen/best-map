import { describe, expect, it } from 'vitest';
import { type PackNode, parsePack, readPack, packItems, nestByKind, type ResourcePack } from '../packs';
import { builtinPacks } from '../packs/builtin-tree';
import { Engine } from '../engine';
import { digest, worldDigest } from '../digest';
import { packImportCommands } from '../packs/import';
import { worldPartsOf } from '../packs/builtin-tree';
import { NO_CURRENTS, engineFor } from '../testing/fixtures';
import { type Arrange, PRESET_ARRANGE, RELATIONS, arrangeOf, arrangeProblems, canMerge, childrenOf, linkTable, looseItems, mergeInto, parentsFor, parentsOf, relationOf, sameArrange, splitOut, withArrange } from './arrange';
import { kindOf } from './registry';

// 第六十轮：融入。只改显示，不改生成。这里查三件事：下面有哪些算得对、方向没弄反；复制导出不丢；换任何一种安排，生成的世界和包的内容逐值相同

const LIB = builtinPacks();
const medieval = LIB.find((p) => p.id === 'medieval')!;
const ids = (xs: readonly unknown[]) => xs.map((x) => (x as { id: string }).id);
const itemsIn = (pack: PackNode) => (kind: string) => packItems(pack, kindOf(kind)?.pack.key ?? kind);
const items = itemsIn(medieval);

describe('下面有哪些', () => {
  const group = (id: string) => items('cultureGroup').find((g) => (g as { id: string }).id === id);
  const sec = (a: Arrange, parentKind: string, parent: unknown, child: string) => childrenOf(a, parentKind, parent, items).find((c) => c.relation.child === child)!;

  it('文化按文化的 group；地名风格是组写的加组里文化写的；地标按地标写的 cultureGroups', () => {
    const han = group('chinese') as { id: string; nameStyle: string };
    const cultures = sec(PRESET_ARRANGE, 'cultureGroup', han, 'culture');
    expect(ids(cultures.items)).toEqual(ids(items('culture').filter((c) => (c as { group: string }).group === 'chinese')));
    const styles = ids(sec(PRESET_ARRANGE, 'cultureGroup', han, 'nameStyle').items);
    expect(styles[0]).toBe(han.nameStyle);
    for (const c of cultures.items as { nameStyle?: string }[]) if (c.nameStyle) expect(styles).toContain(c.nameStyle);
    expect(ids(sec(PRESET_ARRANGE, 'cultureGroup', han, 'landmarkType').items)).toEqual(['great-wall']);
  });

  it('属于多个组的地标每个组都列；不属于任何组的不在组里，算在 looseItems', () => {
    const antiquity = LIB.find((p) => p.id === 'antiquity')!;
    const of = itemsIn(antiquity);
    const pyramid = of('landmarkType').find((l) => (l as { id: string }).id === 'pyramid') as { cultureGroups: string[] };
    expect(pyramid.cultureGroups.length).toBeGreaterThan(1);
    for (const g of pyramid.cultureGroups) {
      const parent = of('cultureGroup').find((x) => (x as { id: string }).id === g);
      expect(ids(childrenOf(PRESET_ARRANGE, 'cultureGroup', parent, of).find((c) => c.relation.child === 'landmarkType')!.items)).toContain('pyramid');
    }
    const rel = relationOf('landmarkType', 'cultureGroup')!;
    const loose = ids(looseItems(rel, of));
    expect(loose).toContain('famous-peak');
    expect(loose).not.toContain('pyramid');
    expect(ids(parentsOf(rel, pyramid, of))).toEqual(pyramid.cultureGroups);
  });

  it('派系由政体写的 factions 决定，按政体写的先后；取值按 group', () => {
    const gov = items('government')[0] as { factions: string[] };
    expect(ids(sec(PRESET_ARRANGE, 'government', gov, 'faction').items)).toEqual(gov.factions);
    const vg = items('valueGroup')[0] as { id: string };
    expect(ids(sec(PRESET_ARRANGE, 'valueGroup', vg, 'popValue').items)).toEqual(ids(items('popValue').filter((v) => (v as { group?: string }).group === vg.id)));
  });

  it('没融入时这一段没有；写到了但这一份里没有的不列', () => {
    const han = group('chinese');
    expect(childrenOf({}, 'cultureGroup', han, items)).toEqual([]);
    const gov = { id: 'g', factions: ['nobles', 'no-such'] };
    const c = childrenOf(PRESET_ARRANGE, 'government', gov, (k) => (k === 'government' ? [gov] : k === 'faction' ? [{ id: 'nobles' }] : []))[0];
    expect(ids(c.items)).toEqual(['nobles']);
  });

  it('内置的库：派系、文化都有上级（格局也是）；上级不在这一份里的算不属于', () => {
    for (const p of LIB) {
      const of = itemsIn(p);
      expect(looseItems(relationOf('faction', 'government')!, of), p.id).toEqual([]);
      expect(looseItems(relationOf('culture', 'cultureGroup')!, of), p.id).toEqual([]);
    }
    const rel = relationOf('culture', 'cultureGroup')!;
    expect(ids(looseItems(rel, (k) => (k === 'culture' ? [{ id: 'c', group: 'gone' }] : [])))).toEqual(['c']);
  });

  it('变量读时代写的维度', () => {
    const era = items('era')[0] as { dimensions: { id: string }[] };
    const v = childrenOf(PRESET_ARRANGE, 'era', era, items).find((c) => c.relation.child === 'variables')!;
    expect(ids(v.items)).toEqual(era.dimensions.map((d) => d.id));
    expect(linkTable(v.relation, items).byChild.get(era.dimensions[0].id)).toContain((era as unknown as { id: string }).id);
  });
});

describe('加、移出改的是内容自己，方向没弄反', () => {
  const rel = (c: string, p: string) => relationOf(c, p)!;

  it('文化改自己的 group，不能没有组', () => {
    const r = rel('culture', 'cultureGroup');
    expect(r.link!({ id: 'g2' }, { id: 'c', group: 'g1' })).toEqual({ side: 'child', next: { id: 'c', group: 'g2' } });
    expect(r.moveOnly).toBe(true);
    expect(r.unlink).toBeUndefined();
  });

  it('派系改政体的 factions；地标改地标的 cultureGroups；空了去掉字段（和不写一样）', () => {
    const f = rel('faction', 'government');
    expect(f.link!({ id: 'g', factions: ['a'] }, { id: 'b' })).toEqual({ side: 'parent', next: { id: 'g', factions: ['a', 'b'] } });
    expect(f.unlink!({ id: 'g', factions: ['a'] }, { id: 'a' })).toEqual({ side: 'parent', next: { id: 'g' } });
    const l = rel('landmarkType', 'cultureGroup');
    expect(l.link!({ id: 'g' }, { id: 'l' })).toEqual({ side: 'child', next: { id: 'l', cultureGroups: ['g'] } });
    expect(l.unlink!({ id: 'g' }, { id: 'l', cultureGroups: ['g', 'h'] })).toEqual({ side: 'child', next: { id: 'l', cultureGroups: ['h'] } });
    expect(l.unlink!({ id: 'g' }, { id: 'l', cultureGroups: ['g'] })).toEqual({ side: 'child', next: { id: 'l' } });
  });

  it('地名风格：组的默认能移出；是文化写的不能', () => {
    const r = rel('nameStyle', 'cultureGroup');
    expect(r.unlink!({ id: 'g', nameStyle: 's' }, { id: 's' })).toEqual({ side: 'parent', next: { id: 'g' } });
    expect(r.unlink!({ id: 'g', nameStyle: 's' }, { id: 't' })).toBeNull();
    expect(r.link!({ id: 'g', nameStyle: 's' }, { id: 't' })).toEqual({ side: 'parent', next: { id: 'g', nameStyle: 't' } });
  });

  // 第七十七轮去掉了格局（countryLayout → countryTier 的融入）
  it('取值要同一维；新建的取值写上这一组', () => {
    const v = rel('popValue', 'valueGroup');
    expect(v.fits!({ dimension: 'a' }, { dimension: 'b' })).toBe(false);
    expect(v.fresh!({ id: 'g', dimension: 'a' }, { id: 'v', dimension: 'religion' })).toEqual({ id: 'v', dimension: 'a', group: 'g' });
    expect(v.unlink!({ id: 'g' }, { id: 'v', group: 'g' })).toEqual({ side: 'child', next: { id: 'v' } });
  });

  it('每种内容的 link 之后的样子都过格式', () => {
    const of = itemsIn(LIB.find((p) => p.id === 'antiquity')!);
    for (const r of RELATIONS) {
      if (!r.link) continue;
      const kind = kindOf(r.child)!;
      const up = kindOf(r.parent)!;
      const p = of(r.parent)[0] as Record<string, unknown>;
      const c = (of(r.child)[0] ?? kind.blank!()) as Record<string, unknown>;
      const e = r.link(p, c);
      const k = e.side === 'parent' ? up : kind;
      expect(k.schema.safeParse(e.next).success, `${r.child}→${r.parent}`).toBe(true);
    }
  });
});

describe('哪些组合可以', () => {
  it('预设都在表里；表里只有一层', () => {
    expect(arrangeProblems(PRESET_ARRANGE)).toEqual([]);
    const parents = new Set(RELATIONS.map((r) => r.parent));
    const children = new Set(RELATIONS.map((r) => r.child));
    for (const p of parents) expect(children.has(p), p).toBe(false);
  });

  it('讲得通的才行', () => {
    expect(canMerge('faction', 'government')).toBe(true);
    expect(canMerge('countryLayout', 'countryTier')).toBe(false);
    expect(canMerge('landmarkType', 'government')).toBe(true);
    expect(canMerge('culture', 'government')).toBe(false);
    expect(canMerge('mapStyle', 'government')).toBe(false);
    expect(parentsFor('landmarkType')).toEqual(['cultureGroup', 'government']);
    expect(parentsFor('mapStyle')).toEqual([]);
    expect(mergeInto(PRESET_ARRANGE, 'mapStyle', 'government')).toBe(PRESET_ARRANGE);
  });

  it('融入、拆出来；地标换一个上级就只在那一个下面', () => {
    const a = splitOut(PRESET_ARRANGE, 'faction');
    expect(a.faction).toBeUndefined();
    expect(sameArrange(mergeInto(a, 'faction', 'government'), PRESET_ARRANGE)).toBe(true);
    expect(mergeInto(PRESET_ARRANGE, 'landmarkType', 'government').landmarkType).toBe('government');
  });
});

describe('存在库里，复制、导出不丢', () => {
  const small: ResourcePack = { format: 'map2-pack', version: 1, id: 'p', name: '包' };

  it('没写时用预设；和预设一样的不写；空的表就是都单独成卡', () => {
    expect(arrangeOf(small)).toBe(PRESET_ARRANGE);
    expect(arrangeOf({ ...small, arrange: {} })).toEqual({});
    expect(withArrange(small, PRESET_ARRANGE)).toEqual(small);
    expect(withArrange({ ...small, arrange: { faction: 'government' } }, PRESET_ARRANGE)).toEqual(small);
    expect(withArrange(small, {})).toEqual({ ...small, arrange: {} });
  });

  it('parsePack 读得回来；导出成文件再读一样；旧的文件没有这个字段照常', () => {
    const a = withArrange(small, splitOut(PRESET_ARRANGE, 'faction'));
    const r = parsePack(JSON.parse(JSON.stringify(a)));
    expect(r.ok && r.pack.arrange).toEqual(a.arrange);
    const read = readPack(JSON.stringify(a));
    expect(read.ok && read.pack.arrange).toEqual(a.arrange);
    const old = parsePack(small);
    expect(old.ok && old.pack.arrange).toBeUndefined();
  });

  it('严格：讲不通的组合、小包里写的都读不进来', () => {
    const bad = parsePack({ ...small, arrange: { culture: 'government' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join()).toContain('融入的安排');
    expect(parsePack({ ...small, arrange: 'x' }).ok).toBe(false);
    expect(parsePack({ ...small, packs: [{ id: 'a', name: 'A', arrange: {} }] }).ok).toBe(false);
  });

  it('按种类分小包时带着（存进我的库、导入到库走这里）', () => {
    expect(nestByKind({ ...small, arrange: { faction: 'government' } }).arrange).toEqual({ faction: 'government' });
  });
});

describe('门槛：安排不改变任何摘要', () => {
  const ARRANGES: Arrange[] = [
    {},
    splitOut(PRESET_ARRANGE, 'faction'),
    mergeInto(PRESET_ARRANGE, 'landmarkType', 'government'),
    { resource: 'terrainClass', faction: 'government' },
    Object.fromEntries(RELATIONS.filter((r) => r.parent !== 'government' || r.child !== 'landmarkType').map((r) => [r.child, r.parent])),
  ];

  it('包的内容除 arrange 外不变（是同一份对象）', () => {
    const before = digest(medieval);
    for (const a of ARRANGES) {
      const p = withArrange(medieval, a);
      const { arrange: _, ...rest } = p;
      expect(Object.keys(rest).sort()).toEqual(Object.keys(medieval).sort());
      for (const k of Object.keys(rest)) expect(rest[k]).toBe(medieval[k]);
      expect(digest(rest)).toBe(before);
    }
  });

  // 用这个库新建世界、生成人文：和没写安排的库逐值相同
  function worldOf(pack: ResourcePack): Engine {
    const lib = LIB.map((p) => (p.id === pack.id ? pack : p));
    const groups = ['germanic', 'chinese'];
    const eng = engineFor({ cells: 3000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
    for (const c of packImportCommands(lib, { packs: worldPartsOf(pack.id), groups: [] }, eng.world)) eng.exec(c);
    eng.exec(NO_CURRENTS);
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 5 } });
    for (const c of packImportCommands(lib, { packs: [[pack.id]], groups }, eng.world)) eng.exec(c);
    eng.exec({ op: 'generate_human', packs: [[pack.id]], groups, countries: {}, settlements: {} });
    return eng;
  }

  it('换各种安排，生成的世界逐值相同', () => {
    const base = worldDigest(worldOf(medieval).world);
    for (const a of ARRANGES) expect(worldDigest(worldOf(withArrange(medieval, a)).world)).toBe(base);
  });
});
