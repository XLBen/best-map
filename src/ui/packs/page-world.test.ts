import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { cleanableContent } from '../../../core/content/cleanable';
import { linkTable, packScope, referrersOf, worldScope } from '../../../core/content/links';
import { allKinds, enableCommand, itemId, kindOf, usageOf } from '../../../core/content/registry';
import { digest } from '../../../core/digest';
import type { Engine } from '../../../core/engine';
import { type ResourcePack, packItems } from '../../../core/packs';
import { addDimensionCommand } from '../../../core/packs/add-dimension';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { importCommand } from '../../../core/packs/closure';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import { NO_CURRENTS, engineFor, humanDigest, setGroupWeights } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { RegenTrack } from '../../regen-track';
import { useSourceCommand, repointCommand } from './page-actions';
import { itemPage, listPage, type PageCtx, type SourceRef, WORLD_SOURCE, rowsOf } from './pages';
import { mapPlaces, usedByOf } from './page-used-by';
import { regenCommand, regenNeed } from './regen';
import { tidyLines, tidyText } from './tidy';

// 第六十二轮：本世界的列表上的标记（和库不同、变淡）、谁用到它、重新生成的按钮

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const medieval = builtinPacks().find((p) => p.id === 'medieval')!;
// 世界每次都是新的对象（应用里每次快照都是）
const ctxOf = (w: PageCtx['world'], extra: LibraryEntry[] = []): PageCtx => ({ world: w && { ...w }, lib: [...BUILTIN, ...extra] });

let bare: Engine;
beforeAll(() => {
  bare = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  library.value = BUILTIN;
});
afterEach(() => {
  library.value = BUILTIN;
});

function worldOf(lib = 'medieval', count = 3, more: Record<string, unknown> = { countries: {}, settlements: {} }): Engine {
  const e = bare.clone();
  const root = builtinPacks().find((p) => p.id === lib)!;
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf(lib))) e.exec(c);
  const all = packItems<{ id: string; weight?: number }>(root, 'cultureGroups');
  const groups = all.filter((g) => g.weight !== 0).slice(0, count).map((g) => ({ id: g.id, weight: 1 }));
  // 和新建向导一样只加选的组（第六十七轮以前加的是全部组：库里默认不带的组比重写成没写，第六十七轮起这种组会参与重新生成）
  for (const c of packImportCommands(ROOTS, { packs: [[lib]], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  // 第七十七轮：以前命令写的权重写进世界里的组（命令只写 id），结果不变
  setGroupWeights(e, groups);
  e.exec({ op: 'generate_human', packs: [[lib]], groups: groups.map((g) => g.id), ...more } as Command);
  e.update();
  return e;
}

const item = (e: Engine, kind: string, id: string) => {
  const k = kindOf(kind)!;
  return k.inWorld(e.world).find((x) => itemId(k, x) === id) as Record<string, unknown>;
};
const edit = (e: Engine, kind: string, id: string, patch: Record<string, unknown>) => {
  e.exec(enableCommand(kindOf(kind)!, { ...item(e, kind, id), ...patch }, e.world));
  e.update();
};
const allRows = (p: ReturnType<typeof listPage>) => p!.sections.flatMap((s) => s.rows);

describe('列表上的标记', () => {
  it('没改过的不标；改过的标；只看本世界', () => {
    const e = worldOf();
    const id = itemId(kindOf('culture')!, kindOf('culture')!.inWorld(e.world)[0]);
    expect(allRows(listPage(WORLD_SOURCE, { p: 'list', kind: 'culture' }, ctxOf(e.world))).filter((r) => r.mark?.changed)).toEqual([]);
    edit(e, 'culture', id, { name: '改过' });
    const rows = allRows(listPage(WORLD_SOURCE, { p: 'list', kind: 'culture' }, ctxOf(e.world)));
    expect(rows.filter((r) => r.mark?.changed).map((r) => r.id)).toEqual([id]);
    const lib: SourceRef = { t: 'lib', key: 'medieval' };
    expect(allRows(listPage(lib, { p: 'list', kind: 'culture' }, ctxOf(e.world))).every((r) => !r.mark)).toBe(true);
  });

  it('变淡的就是清理会清的（列表、上级页面都一样）', () => {
    const e = worldOf();
    const ctx = ctxOf(e.world);
    const clean = new Set(cleanableContent(e.world).map((r) => `${r.kind}:${r.id}`));
    for (const kind of ['government', 'faction', 'cultureGroup', 'culture', 'nameStyle']) {
      const rows = allRows(listPage(WORLD_SOURCE, { p: 'list', kind }, ctx));
      for (const r of rows) expect(!!r.mark?.faint, `${r.kind.id}:${r.id}`).toBe(clean.has(`${r.kind.id}:${r.id}`));
    }
    expect(clean.size).toBeGreaterThan(0);
    // 河湖、生态不变淡
    for (const kind of ['riverType', 'lakeType', 'biome']) expect(allRows(listPage(WORLD_SOURCE, { p: 'list', kind }, ctx)).some((r) => r.mark?.faint)).toBe(false);
    // 文化组的页面上，融入的文化一样变淡
    const group = e.world.small.human!.groups[0];
    const page = itemPage(WORLD_SOURCE, { p: 'item', kind: 'cultureGroup', id: group }, ctx)!;
    const sec = page.children.find((s) => s.key === 'culture')!;
    for (const r of sec.rows) expect(!!r.mark?.faint, r.id).toBe(clean.has(`culture:${r.id}`));
  });

  it('清理：问话列要清哪些', () => {
    const e = worldOf();
    const plan = e.planTidy({ only: cleanableContent(e.world) });
    const lines = tidyLines(plan);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /\d+$/.test(l.label))).toBe(true);
    expect(tidyText(plan)).toContain(`删除 ${plan.removed.length} 项`);
    expect(tidyText(plan)).toContain('河、湖、生态');
    // 包一层写历史里的字：移出的照样报出来（自己做的存进资源库），一次撤销
    const before = JSON.stringify(e.world.small.content);
    e.exec({ op: 'batch', label: '清理没用到的', commands: [plan.command!] });
    expect(e.lastRemoved.length).toBe(plan.removed.length);
    expect(e.history[e.history.length - 1].summary).toBe('清理没用到的');
    e.undo();
    expect(JSON.stringify(e.world.small.content)).toBe(before);
  });
});

describe('用库里的版本（命令）', () => {
  it('一步，能撤销；之后不再标', () => {
    const e = worldOf();
    const id = itemId(kindOf('culture')!, kindOf('culture')!.inWorld(e.world)[0]);
    edit(e, 'culture', id, { name: '改过' });
    const page = () => itemPage(WORLD_SOURCE, { p: 'item', kind: 'culture', id }, ctxOf(e.world))!;
    expect(page().diff.t).toBe('changed');
    expect(page().diffLib).toBe(medieval.name);
    const cmd = useSourceCommand(kindOf('culture')!, id, e.world, BUILTIN)!;
    expect(cmd.op).toBe('batch');
    e.exec(cmd);
    e.update();
    expect(page().diff.t).toBe('same');
    e.undo();
    e.update();
    expect(page().diff.t).toBe('changed');
    expect(item(e, 'culture', id).name).toBe('改过');
  });

  it('生态：按字段改回去', () => {
    const e = worldOf();
    const k = kindOf('biome')!;
    const id = e.world.small.species[0].id;
    const name = e.world.small.species[0].name;
    e.exec({ op: 'update_species', id, patch: { name: '改过' } });
    e.update();
    e.exec(useSourceCommand(k, id, e.world, BUILTIN)!);
    e.update();
    expect(e.world.small.species[0].name).toBe(name);
    expect(itemPage(WORLD_SOURCE, { p: 'item', kind: 'biome', id }, ctxOf(e.world))!.diff.t).toBe('same');
  });

  it('存回到副本：来源换到副本上之后不再标；别的不动', () => {
    const e = worldOf();
    const kind = kindOf('government')!;
    const id = itemId(kind, kind.inWorld(e.world)[0]);
    edit(e, 'government', id, { name: '改过' });
    const before = humanDigest(e.world);
    const copyKey = 'med-copy';
    const copy: LibraryEntry = { key: copyKey, pack: { ...medieval, id: copyKey, name: '副本' } as ResourcePack, builtin: false, mine: true, installedAt: 1 };
    // 副本里也写进去（setItem 做的事）
    const swap = (n: typeof copy.pack): typeof copy.pack => {
      const out = Array.isArray(n.governments) ? { ...n, governments: n.governments.map((x) => (itemId(kind, x) === id ? item(e, 'government', id) : x)) } : n;
      return (Array.isArray(n.packs) ? { ...out, packs: n.packs.map((c) => swap(c as typeof copy.pack)) } : out) as typeof copy.pack;
    };
    const after: LibraryEntry = { ...copy, pack: swap(copy.pack) };
    const rec = e.world.small.origin!.government[id];
    const cmd = repointCommand(kind, id, item(e, 'government', id), [copyKey, ...rec.slice(1)], e.world)!;
    e.exec(cmd);
    e.update();
    expect(e.world.small.origin!.government[id][0]).toBe(copyKey);
    expect(itemPage(WORLD_SOURCE, { p: 'item', kind: 'government', id }, ctxOf(e.world, [after]))!.diff.t).toBe('same');
    expect(humanDigest(e.world)).toEqual(before);
    e.undo();
    expect(e.world.small.origin!.government[id][0]).toBe('medieval');
  });

  it('存回到副本：生态只记来源', () => {
    const e = worldOf();
    const id = e.world.small.species[0].id;
    const rec = e.world.small.origin!.biome[id];
    e.exec(repointCommand(kindOf('biome')!, id, e.world.small.species[0], ['x', ...rec.slice(1)], e.world)!);
    expect(e.world.small.origin!.biome[id][0]).toBe('x');
  });
});

describe('谁用到它', () => {
  // 全部的种类、全部的项，和引用表一致
  const check = (src: SourceRef, ctx: PageCtx, table: ReturnType<typeof linkTable>) => {
    for (const k of allKinds()) {
      for (const r of rowsOf(src, k, ctx).slice(0, 40)) {
        const u = usedByOf(src, k, r.id, r.item, ctx);
        const want = new Set(referrersOf(table, { kind: k.id, id: r.id }).filter((x) => !(x.from.kind === k.id && x.from.id === r.id)).map((x) => `${x.from.kind}:${x.from.id}`));
        const got = new Set(u.groups.flatMap((g) => g.rows.map((x) => `${x.kind}:${x.id}`)));
        expect(got, `${k.id}:${r.id}`).toEqual(want);
      }
    }
  };

  it('和引用表一致：世界', () => {
    const e = worldOf();
    check(WORLD_SOURCE, ctxOf(e.world), linkTable(worldScope(e.world)));
  });

  it('和引用表一致：库', () => {
    check({ t: 'lib', key: 'medieval' }, ctxOf(null), linkTable(packScope(medieval)));
  });

  it('融入的项：派系在政体的引用里，文化在组下面（“在 X”）；上级是引用它的不写两遍', () => {
    const e = worldOf();
    const ctx = ctxOf(e.world);
    const gov = kindOf('government')!.inWorld(e.world).find((g) => (g as { factions?: string[] }).factions?.length) as { id: string; factions: string[] };
    const fid = gov.factions[0];
    const f = usedByOf(WORLD_SOURCE, kindOf('faction')!, fid, item(e, 'faction', fid), ctx);
    expect(f.groups.find((g) => g.kind === 'government')!.rows.map((r) => r.id)).toContain(gov.id);
    expect(f.parents).toEqual([]);
    const cid = itemId(kindOf('culture')!, kindOf('culture')!.inWorld(e.world)[0]);
    const c = usedByOf(WORLD_SOURCE, kindOf('culture')!, cid, item(e, 'culture', cid), ctx);
    expect(c.parents.map((p) => p.kind)).toEqual(['cultureGroup']);
    expect(c.parents[0].id).toBe((item(e, 'culture', cid) as { group: string }).group);
    expect(c.brief).toContain('在 ');
    // 组的页面：文化引用它
    const g = usedByOf(WORLD_SOURCE, kindOf('cultureGroup')!, c.parents[0].id, item(e, 'cultureGroup', c.parents[0].id), ctx);
    expect(g.groups.find((x) => x.kind === 'culture')!.rows.map((r) => r.id)).toContain(cid);
  });

  it('地图上用到的地方：和 usage.ts 一样；生态、河看推导', () => {
    const e = worldOf();
    const w = e.world;
    const gov = Object.values(w.small.countries!)[0].government;
    const kind = kindOf('government')!;
    const label = usageOf(kind, w, gov)!.label;
    expect(mapPlaces(kind, gov, w)).toBe(label);
    const counts = new Map<number, number>();
    for (const v of w.derived.dominant) if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [k, n] = [...counts.entries()][0];
    expect(mapPlaces(kindOf('biome')!, w.small.species[k].id, w)).toContain(n.toLocaleString('en-US'));
    expect(usedByOf(WORLD_SOURCE, kind, gov, item(e, 'government', gov), ctxOf(w)).places).toBe(label);
  });

  it('刚导入的项、没人用的项', () => {
    const e = worldOf('fantasy', 3);
    const source = builtinPacks().find((p) => p.id === 'modern')!;
    const f = packItems<{ id: string }>(source, 'factions').find((x) => !kindOf('faction')!.inWorld(e.world).some((y) => (y as { id: string }).id === x.id))!;
    const r = importCommand({ source, target: { t: 'world', world: e.world }, picks: [{ kind: 'faction', id: f.id }, { kind: 'dimension', id: 'ideology' }, { kind: 'dimension', id: 'nation' }] }, { path: ['modern'] });
    e.exec(r.command!);
    e.update();
    const u = usedByOf(WORLD_SOURCE, kindOf('faction')!, f.id, item(e, 'faction', f.id), ctxOf(e.world));
    expect(u.empty).toBe(true);
    expect(u.brief).toBe('没有');
    // 库里（没有世界）：没有地图上用到的
    const inLib = usedByOf({ t: 'lib', key: 'modern' }, kindOf('faction')!, f.id, f, ctxOf(null));
    expect(inLib.places).toBeNull();
    expect(inLib.groups.length).toBeGreaterThan(0);
  });
});

describe('重新生成的按钮', () => {
  // 记一遍生成之后的样子
  const trackOf = (e: Engine) => {
    const t = new RegenTrack();
    t.reset(0, e.world.small.content);
    return t;
  };
  const need = (e: Engine, t: RegenTrack) => regenNeed(e.world.small, t.base());

  it('生成之后没有；改了文化要重新生成人文；撤销就没了', () => {
    const e = worldOf();
    const t = trackOf(e);
    expect(need(e, t)).toBeNull();
    const id = itemId(kindOf('culture')!, kindOf('culture')!.inWorld(e.world).find((c) => e.world.small.human!.groups.includes((c as { group: string }).group))!);
    edit(e, 'culture', id, { name: '改过' });
    t.step(1, e.world.small.content);
    expect(need(e, t)).toMatchObject({ label: '重新生成人文', count: 1 });
    e.undo();
    t.pending = 'history';
    t.step(0, e.world.small.content);
    expect(need(e, t)).toBeNull();
  });

  it('改了政体：重新生成国家；两样都改：一步做完；按钮发的命令能执行，之后没有了，撤销回来', () => {
    const e = worldOf();
    const t = trackOf(e);
    const gov = Object.values(e.world.small.countries!)[0].government;
    edit(e, 'government', gov, { name: '改过' });
    t.step(1, e.world.small.content);
    const n = need(e, t)!;
    expect(n.label).toBe('重新生成国家');
    expect(n.what).toContain('锁定的不动');
    const cmd = regenCommand(n, e.world.small, BUILTIN);
    e.exec(cmd);
    e.update();
    t.pending = cmd;
    t.step(2, e.world.small.content);
    expect(need(e, t)).toBeNull();
    e.undo();
    t.pending = 'history';
    t.step(1, e.world.small.content);
    expect(need(e, t)!.label).toBe('重新生成国家');
    // 再改一个文化：两样都要
    const cid = e.world.small.human!.groups[0];
    edit(e, 'cultureGroup', cid, { name: '改组' });
    t.pending = { op: 'set_content', kind: 'cultureGroup', id: cid, item: null };
    t.step(2, e.world.small.content);
    const both = need(e, t)!;
    expect(both.label).toBe('重新生成人文和国家');
    const c2 = regenCommand(both, e.world.small, BUILTIN);
    e.exec(c2);
    t.pending = c2;
    t.step(3, e.world.small.content);
    expect(need(e, t)).toBeNull();
  });

  it('城市等级：重新生成城市；没有城市时不出现', () => {
    const e = worldOf();
    const t = trackOf(e);
    const k = kindOf('cityRank')!;
    const id = itemId(k, k.inWorld(e.world)[0]);
    // 第九十轮：名字是画的时候现读的，不算（以前改名也算）；“连大道”生成道路时才读，算
    edit(e, 'cityRank', id, { name: '改过' });
    t.step(1, e.world.small.content);
    expect(need(e, t)).toBeNull();
    edit(e, 'cityRank', id, { major: false });
    t.step(2, e.world.small.content);
    const n = need(e, t)!;
    expect(n.label).toBe('重新生成城市');
    e.exec(regenCommand(n, e.world.small, BUILTIN));
    const none = worldOf('medieval', 3, { countries: {} });
    const t2 = trackOf(none);
    edit(none, 'cityRank', id, { major: false });
    t2.step(1, none.world.small.content);
    expect(need(none, t2)).toBeNull();
  });

  it('没有国家时政体不算；没有人文时都不算', () => {
    const e = worldOf('medieval', 3, {});
    const t = trackOf(e);
    const k = kindOf('government')!;
    edit(e, 'government', itemId(k, k.inWorld(e.world)[0]), { name: '改过' });
    t.step(1, e.world.small.content);
    expect(need(e, t)).toBeNull();
    const n = bare.clone();
    const t2 = trackOf(n);
    for (const c of packImportCommands(ROOTS, { packs: [['medieval']], groups: ['germanic'] }, n.world)) n.exec(c);
    t2.step(1, n.world.small.content);
    expect(need(n, t2)).toBeNull();
  });

  // 第七十七轮：比重是各组占多少，改了也要重新生成（以前只看是不是 0）
  it('只改说明、颜色不出现（重新生成后摘要也相同）；改了比重要重新生成', () => {
    const e = worldOf();
    const t = trackOf(e);
    const group = e.world.small.human!.groups[0];
    const culture = itemId(kindOf('culture')!, kindOf('culture')!.inWorld(e.world).find((c) => (c as { group: string }).group === group)!);
    const gov = Object.values(e.world.small.countries!)[0].government;
    edit(e, 'culture', culture, { color: '#123456' });
    edit(e, 'cultureGroup', group, { color: '#654321' });
    edit(e, 'government', gov, { description: '说明', color: '#112233' });
    t.step(1, e.world.small.content);
    expect(need(e, t)).toBeNull();
    // 重新生成的结果和没改时一样：真的不需要
    const plain = worldOf();
    plain.exec({ op: 'regenerate_countries' });
    plain.update();
    e.exec({ op: 'regenerate_countries' });
    e.update();
    // 只差国家的颜色、旗子（生成时从文化的颜色取的）；人口、领土、城市、名字都一样
    const { countries: a, ...restA } = humanDigest(e.world);
    const { countries: b, ...restB } = humanDigest(plain.world);
    expect(restA).toEqual(restB);
    const bare = (w: Engine) => Object.values(w.world.small.countries!).map(({ color: _c, flag: _f, ...m }) => m);
    expect(a === b || JSON.stringify(bare(e)) === JSON.stringify(bare(plain))).toBe(true);
    // 比重改成 9：各组占多少变了，要重新生成
    edit(e, 'cultureGroup', group, { weight: 9 });
    t.pending = null;
    t.step(3, e.world.small.content);
    expect(need(e, t)!.label).toBe('重新生成人文');
    // 比重改成 0：退出生成，要重新生成
    edit(e, 'cultureGroup', group, { weight: 0 });
    t.pending = null;
    t.step(4, e.world.small.content);
    expect(need(e, t)!.label).toBe('重新生成人文');
  });

  it('移出、清理不出现；别的时代、比重 0 的组不出现', () => {
    const e = worldOf('fantasy');
    const t = trackOf(e);
    const plan = e.planTidy({ only: cleanableContent(e.world) });
    e.exec(plan.command!);
    e.update();
    t.step(1, e.world.small.content);
    expect(need(e, t)).toBeNull();
    // 比重 0 的组、它的文化。第六十六轮起勾的文化带来的组参与生成（要重新生成人文），比重改成 0 才不参与
    const source = builtinPacks().find((p) => p.id === 'modern')!;
    const inWorld = new Set(kindOf('culture')!.inWorld(e.world).map((c) => (c as { id: string }).id));
    const c = packItems<{ id: string; group: string }>(source, 'cultures').find((x) => !inWorld.has(x.id))!;
    e.exec(importCommand({ source, target: { t: 'world', world: e.world }, picks: [{ kind: 'culture', id: c.id }] }, { path: ['modern'] }).command!);
    e.update();
    t.step(2, e.world.small.content);
    expect(need(e, t)?.label).toBe('重新生成人文');
    edit(e, 'cultureGroup', c.group, { weight: 0 });
    t.step(3, e.world.small.content);
    expect(need(e, t)).toBeNull();
  });

  it('世界加变量：不出现（只算新变量，文化、国家都不变）；取值也不算', () => {
    const e = worldOf('fantasy');
    const t = trackOf(e);
    e.exec(addDimensionCommand(ROOTS, e.world, 'ideology', 'modern')!);
    e.update();
    t.step(1, e.world.small.content);
    expect(need(e, t)).toBeNull();
  });

  it('导入一个要变量的政体：重新生成国家（地图原来不变，点了才用上）', () => {
    const e = worldOf('fantasy');
    const t = trackOf(e);
    const source = builtinPacks().find((p) => p.id === 'modern')!;
    const gov = packItems<{ id: string; category?: string[] }>(source, 'governments').find((g) => g.category?.includes('communist'))!;
    const before = digest(e.world.causes.country!);
    e.exec(importCommand({ source, target: { t: 'world', world: e.world }, picks: [{ kind: 'government', id: gov.id }, { kind: 'dimension', id: 'ideology' }] }, { path: ['modern'] }).command!);
    e.update();
    t.step(1, e.world.small.content);
    expect(digest(e.world.causes.country!)).toBe(before);
    const n = need(e, t)!;
    expect(n.label).toBe('重新生成国家');
  });

  it('开着面板时世界里的改动也算（比的是世界，不是这一页）：就地展开改的项走同一条', () => {
    const e = worldOf();
    const t = trackOf(e);
    const group = e.world.small.human!.groups[0];
    const page = itemPage(WORLD_SOURCE, { p: 'item', kind: 'cultureGroup', id: group }, ctxOf(e.world))!;
    const child = page.children.find((s) => s.key === 'culture')!.rows[0];
    edit(e, 'culture', child.id, { name: '展开里改的' });
    t.step(1, e.world.small.content);
    expect(need(e, t)!.label).toBe('重新生成人文');
  });
});

describe('跟着撤销的先后记', () => {
  const content = (name: string) => ({ culture: { c: { id: 'c', name } } }) as never;

  it('撤销、重做回到那个位置的那一份；新的一步丢掉后面的', () => {
    const t = new RegenTrack();
    const a = content('a');
    const b = content('b');
    const c = content('c');
    t.reset(0, a);
    t.pending = { op: 'set_content', kind: 'culture', id: 'c', item: null };
    t.step(1, b);
    expect(t.base()!.human).toBe(a);
    t.pending = { op: 'regenerate_human' };
    t.step(2, b);
    expect(t.base()!.human).toBe(b);
    expect(t.base()!.countries).toBe(a);
    t.pending = 'history';
    t.step(1, b);
    expect(t.base()!.human).toBe(a);
    t.pending = 'history';
    t.step(2, b);
    expect(t.base()!.human).toBe(b);
    t.pending = 'history';
    t.step(1, b);
    t.pending = { op: 'batch', commands: [{ op: 'regenerate_countries' }] } as Command;
    t.step(2, c);
    expect(t.base()).toMatchObject({ human: c, countries: c, settlements: c });
    t.pending = 'history';
    t.step(1, b);
    expect(t.base()!.human).toBe(a);
  });

  it('不走 exec 的命令（一笔）：不算生成；打开世界以前的步骤：从现在的内容算起', () => {
    const t = new RegenTrack();
    const a = content('a');
    const b = content('b');
    t.reset(5, a);
    t.step(6, b);
    expect(t.base()!.human).toBe(a);
    t.pending = 'history';
    t.step(5, a);
    t.pending = 'history';
    t.step(4, b);
    expect(t.base()!.human).toBe(b);
  });
});

