import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { recordedOrigin } from '../../../core/content/origin';
import { enableCommand, itemId, kindOf } from '../../../core/content/registry';
import type { Engine } from '../../../core/engine';
import { cityList, worldCultures } from '../../../core/human';
import { type ResourcePack, packItems, parsePack } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { importPreview } from '../../../core/packs/closure';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import { sourceDiff } from '../../../core/packs/source-diff';
import { NO_CURRENTS, engineFor, setGroupWeights } from '../../../core/testing/fixtures';
import { type LibraryEntry, LEGACY_SHOWN_NAME, MY_PACK_KEY, library, shownPack } from '../../library';
import { copiedPack } from '../../library-edit';
import { libraryOptions } from '../domain/packChoice';
import { blankItem } from './fields';
import { rememberMine, rememberedMine, setShowAllSources, showAllSources } from './lib-prefs';
import { onMapOf } from './on-map';
import { cellTargets, countryTargets, quickFields, quickNext, settleTargets, worldItemStack } from './open-item';
import { repointCommand, worldItemCommand } from './page-actions';
import { searchSource } from './page-search';
import { type PageCtx, WORLD_SOURCE, homePage, itemActions, liveStack, listPage, rowsOf, sourceMenu, sourceTitle } from './pages';
import { basketLine, bringsNote, bringsOf, haveNote, unpickableNote } from './pick-help';
import { refKey, rowLook } from './pick-look';
import { MY_LIBRARY_NAME, copyBaseOf, mergePlan, mergeable, myLibraryOf, nothingNote, saveLabel, savePlan, saveableRefs, savedNote, usableForNew, worldAsPack } from './save-mine';
import { editingLine, editingText, sourceMenuView } from './source-view';

// 第九十二轮：资源库（三）找得到、分得清。
// 找得到：这张地图的首页能搜、文化有自己的卡片、地图上点到的东西直达库里那一项、“在地图上”都能定位；
// 分得清：顶上一句“改的是哪一份”、来源下拉平时只有这张地图、存到我的库只有一个去向（新建世界时选得到）

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const medieval = builtinPacks().find((p) => p.id === 'medieval')!;
const mineEntry = (pack: ResourcePack, key = pack.id): LibraryEntry => ({ key, pack, builtin: false, mine: true, installedAt: 1 });
const ctxOf = (e: Engine, extra: LibraryEntry[] = []): PageCtx => ({ world: { ...e.world }, lib: [...BUILTIN, ...extra] });

let full: Engine;
beforeAll(() => {
  const e = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  e.exec(NO_CURRENTS);
  e.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  e.exec({ op: 'generate_provinces', seed: 1 });
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf('medieval'))) e.exec(c);
  const groups = packItems<{ id: string; weight?: number }>(medieval, 'cultureGroups')
    .filter((g) => g.weight !== 0)
    .slice(0, 3)
    .map((g) => ({ id: g.id, weight: 1 }));
  for (const c of packImportCommands(ROOTS, { packs: [['medieval']], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  setGroupWeights(e, groups);
  e.exec({ op: 'generate_human', packs: [['medieval']], groups: groups.map((g) => g.id), countries: {}, settlements: {} } as Command);
  e.update();
  full = e;
  library.value = BUILTIN;
});
afterEach(() => {
  library.value = BUILTIN;
});

const items = (e: Engine, kind: string) => kindOf(kind)!.inWorld(e.world) as Record<string, unknown>[];
const item = (e: Engine, kind: string, id: string) => items(e, kind).find((x) => itemId(kindOf(kind)!, x) === id)!;
const put = (e: Engine, kind: string, next: Record<string, unknown>) => {
  e.exec(enableCommand(kindOf(kind)!, next, e.world));
  e.update();
};
const add = (e: Engine, kind: string, patch: Record<string, unknown> = {}) => {
  const k = kindOf(kind)!;
  const blank = { ...blankItem(k, new Set(items(e, kind).map((x) => itemId(k, x))))!, ...patch };
  put(e, kind, blank);
  return blank;
};
// 我的库：中世纪的一份副本（界面第一次“存到我的库”时就是这样做出来的）
const myCopy = (key = 'mine-lib') => mineEntry(copiedPack(medieval, key, MY_LIBRARY_NAME), key);

describe('找得到：这张地图的首页', () => {
  it('能搜：名字、外文名、id；每一行写清楚是哪一种、在哪一组', () => {
    const ctx = ctxOf(full);
    const c = worldCultures(full.world.small).find((x) => (x as { orig?: string }).orig) as { id: string; name: string; group: string; orig: string };
    const groupName = String(item(full, 'cultureGroup', c.group).name);
    const byName = searchSource(WORLD_SOURCE, ctx, c.name);
    const row = byName.flatMap((s) => s.rows).find((r) => r.kind.id === 'culture' && r.id === c.id)!;
    expect(row.hint).toBe(`文化 · ${groupName}`);
    // 外文名、id 找到的把找到的那个字写在后面
    const byOrig = searchSource(WORLD_SOURCE, ctx, c.orig.toUpperCase()).flatMap((s) => s.rows).find((r) => r.kind.id === 'culture' && r.id === c.id)!;
    expect(byOrig.hint).toBe(`文化 · ${groupName} · ${c.orig}`);
    const gov = items(full, 'government')[0] as { id: string; name: string };
    const byId = searchSource(WORLD_SOURCE, ctx, gov.id).flatMap((s) => s.rows).find((r) => r.kind.id === 'government' && r.id === gov.id)!;
    expect(byId.hint === '政体' || byId.hint === `政体 · ${gov.id}`).toBe(true);
    // 点一行到的那一页在这张地图里
    expect(liveStack(worldItemStack('culture', c.id), WORLD_SOURCE, ctx)).toHaveLength(3);
    expect(searchSource(WORLD_SOURCE, ctx, '没有这个名字')).toEqual([]);
  });

  it('名字对得上的排在按外文名、id 找到的前面；列表上的搜索也搜外文名', () => {
    const ctx = ctxOf(full);
    const c = worldCultures(full.world.small).find((x) => (x as { orig?: string }).orig) as { id: string; orig: string };
    const list = listPage(WORLD_SOURCE, { p: 'list', kind: 'culture' }, ctx, c.orig)!;
    expect(list.sections.flatMap((s) => s.rows).some((r) => r.id === c.id)).toBe(true);
    const rows = searchSource(WORLD_SOURCE, ctx, 'a').flatMap((s) => s.rows.filter((r) => r.kind.id === 'culture'));
    const byName = rows.map((r) => r.name.toLowerCase().includes('a'));
    // 名字里有的都排在没有的前面
    expect(byName.lastIndexOf(true) < byName.indexOf(false) || !byName.includes(false) || !byName.includes(true)).toBe(true);
  });

  it('文化有自己的卡片（文化组照旧写“含文化”）；库的首页不变', () => {
    const ctx = ctxOf(full);
    const cards = homePage(WORLD_SOURCE, ctx).sections.flatMap((s) => s.cards);
    const culture = cards.find((c) => c.id === 'culture')!;
    expect(culture.route).toEqual({ p: 'list', kind: 'culture' });
    expect(Number(culture.count)).toBe(worldCultures(full.world.small).length);
    expect(cards.find((c) => c.id === 'cultureGroup')!.contains).toContain('文化');
    expect(homePage({ t: 'lib', key: 'medieval' }, ctx).sections.flatMap((s) => s.cards).some((c) => c.id === 'culture')).toBe(false);
  });
});

describe('地图上点到什么就改什么', () => {
  it('国家 → 政体、等级、主流文化；格 → 生态、文化、地形、资源；城市 → 城市等级', () => {
    const w = full.world;
    const m = Object.values(w.small.countries!)[0];
    const t = countryTargets(w, m);
    expect(t.map((x) => x.kind)).toEqual(['government', ...(m.tier ? ['countryTier'] : []), 'culture']);
    expect(t[0]).toMatchObject({ label: '政体', id: m.government, name: item(full, 'government', m.government).name });
    const cell = m.capitalCell!;
    const cells = cellTargets(w, cell);
    expect(cells.map((x) => x.kind)).toContain('biome');
    expect(cells.find((x) => x.kind === 'biome')!.id).toBe(w.small.species[w.derived.dominant[cell]].id);
    expect(cells.find((x) => x.kind === 'culture')?.id).toBe(worldCultures(w.small)[w.derived.popCulture![cell] - 1].id);
    // 海上没有可说的
    const sea = w.causes.land.findIndex((v) => v === 0);
    expect(cellTargets(w, sea)).toEqual([]);
    expect(cellTargets(w, -1)).toEqual([]);
    const city = cityList(w).find((c) => !c.point)!;
    expect(settleTargets(w, { kind: 'city', id: city.id })).toEqual([expect.objectContaining({ kind: 'cityRank', id: city.rank.id })]);
  });

  it('直达的那一页真的在：每一项的栈都留得住，生态在“生态与水系”下面', () => {
    const ctx = ctxOf(full);
    const m = Object.values(full.world.small.countries!)[0];
    for (const t of [...countryTargets(full.world, m), ...cellTargets(full.world, m.capitalCell!)]) {
      const stack = worldItemStack(t.kind, t.id);
      expect(liveStack(stack, WORLD_SOURCE, ctx)).toEqual(stack);
    }
    expect(worldItemStack('biome', 'x')[1]).toEqual({ p: 'ecology' });
  });

  it('名字、颜色在档案里直接改：和面板里改是同一条命令，一步，能撤销', () => {
    const e = full.clone();
    const m = Object.values(e.world.small.countries!)[0];
    expect(quickFields('government')).toEqual({ name: true, color: true });
    const hit = quickNext(e.world, 'government', m.government, { name: '  新名字  ' })!;
    expect(hit.next.name).toBe('新名字');
    const cmd = worldItemCommand(hit.kind, m.government, hit.next, e.world)!;
    e.exec(cmd);
    e.update();
    expect(item(e, 'government', m.government).name).toBe('新名字');
    e.undo();
    e.update();
    expect(item(e, 'government', m.government).name).not.toBe('新名字');
    // 没变、名字空的不发命令
    expect(quickNext(e.world, 'government', m.government, { name: '   ' })).toBeNull();
    expect(quickNext(e.world, 'government', m.government, { name: String(item(e, 'government', m.government).name) })).toBeNull();
    expect(quickNext(e.world, 'government', 'no-such', { name: 'x' })).toBeNull();
    // 生态走按字段的命令
    const sp = e.world.small.species[0];
    const b = quickNext(e.world, 'biome', sp.id, { color: '#123456' })!;
    expect(worldItemCommand(b.kind, sp.id, b.next, e.world)).toMatchObject({ commands: [{ op: 'update_species', patch: { color: '#123456' } }] });
  });

  it('“在地图上”：时代、省份划分、取值组、国家格局也能定位', () => {
    const ctx = ctxOf(full);
    const w = full.world;
    const of = (kind: string, id: string) => onMapOf(kindOf(kind)!, id, item(full, kind, id), ctx)!;
    expect(of('era', w.small.human!.era).cells!.length).toBeGreaterThan(0);
    const rules = items(full, 'provinceRules')[0];
    if (rules) expect(of('provinceRules', String(rules.id)).cells!.length).toBeGreaterThan(0);
    const vg = items(full, 'valueGroup').find((g) => items(full, 'popValue').some((v) => v.group === g.id && onMapOf(kindOf('popValue')!, String(v.id), v, ctx)?.cells));
    if (vg) expect(of('valueGroup', String(vg.id)).cells!.length).toBeGreaterThan(0);
    // 画风、星球形态定位不了：不给格
    expect(onMapOf(kindOf('mapStyle')!, 'x', {}, ctx)?.cells).toBeUndefined();
  });
});

describe('分得清：改的是哪一份', () => {
  it('顶上一句：这张地图、我的库（新世界会用）、只能看；挑选时写加到哪', () => {
    const mine = myCopy();
    const ctx = ctxOf(full, [mine]);
    expect(editingText(editingLine(WORLD_SOURCE, ctx)!)).toBe('改的是：这张地图');
    expect(editingLine(WORLD_SOURCE, ctx)!.tone).toBe('world');
    const m = editingLine({ t: 'lib', key: mine.key }, ctx)!;
    expect(m.tone).toBe('mine');
    expect(editingText(m)).toBe('改的是：我的库“我的库”（新世界会用，这张地图不变）');
    const r = editingLine({ t: 'lib', key: 'medieval' }, ctx)!;
    expect(r.tone).toBe('readonly');
    expect(editingText(r)).toBe(`只能看：${medieval.name}`);
    expect(editingText(editingLine({ t: 'lib', key: 'medieval' }, ctx, WORLD_SOURCE)!)).toBe('挑了加到：这张地图');
    expect(editingLine(WORLD_SOURCE, { world: null, lib: BUILTIN })).toBeNull();
    expect(sourceTitle(WORLD_SOURCE, ctx)).toBe('这张地图');
  });

  it('来源下拉：平时只有这张地图和“从别的库添加…”，别的收在“更多”里；看着“更多”里的一份时展开着', () => {
    const mine = myCopy();
    const ctx = ctxOf(full, [mine]);
    const base = { all: false, picking: false, canPick: true, hasWorld: true };
    const v = sourceMenuView(sourceMenu(WORLD_SOURCE, ctx), base);
    expect(v.top.map((x) => x.name)).toEqual(['这张地图']);
    expect(v.pickEntry).toBe(true);
    expect(v.groups).toEqual([]);
    expect(v.more!.map((g) => g.title)).toEqual(['我的库', '内置的库']);
    expect(v.moreOpen).toBe(false);
    expect(sourceMenuView(sourceMenu({ t: 'lib', key: mine.key }, ctx), base).moreOpen).toBe(true);
    // 都摊开（第九十九轮的开关）：没有“更多”这一层
    const all = sourceMenuView(sourceMenu(WORLD_SOURCE, ctx), { ...base, all: true });
    expect(all.more).toBeNull();
    expect(all.groups.map((g) => g.title)).toEqual(['我的库', '内置的库']);
    // 挑选时选的是从哪个库挑：库都列着，内置的在前，没有“从别的库添加…”
    const pick = sourceMenuView(sourceMenu({ t: 'lib', key: 'medieval' }, ctx), { ...base, picking: true });
    expect(pick.more).toBeNull();
    expect(pick.pickEntry).toBe(false);
    expect(pick.groups.map((g) => g.title)).toEqual(['内置的库', '我的库']);
    // 没有世界：只能看库，都列着
    expect(sourceMenuView(sourceMenu({ t: 'lib', key: 'medieval' }, { world: null, lib: BUILTIN }), { ...base, hasWorld: false }).top).toEqual([]);
  });
});

describe('本机记着的两样', () => {
  it('来源下拉默认不摊开（第九十九轮的开关接在 showAllSources 上）；记着存进哪个库', () => {
    expect(showAllSources()).toBe(false);
    setShowAllSources(true);
    expect(showAllSources()).toBe(true);
    setShowAllSources(false);
    expect(showAllSources()).toBe(false);
    expect(rememberedMine()).toBeNull();
    rememberMine('a');
    expect(rememberedMine()).toBe('a');
    rememberMine(null);
  });
});

describe('存到我的库：一个动作、一个去向', () => {
  it('去向：这张地图用的库是我的库时是它，不然上次的，不然第一个新建世界时选得到的；没有时复制这张地图用的库', () => {
    const a = myCopy('a');
    const b = myCopy('b');
    const noEra = mineEntry({ format: 'map2-pack', version: 1, id: 'old', name: '旧的', cultures: [] } as ResourcePack);
    expect(usableForNew(a)).toBe(true);
    expect(usableForNew(noEra)).toBe(false);
    expect(usableForNew(BUILTIN[0])).toBe(false);
    const lib = [...BUILTIN, noEra, a, b];
    expect(myLibraryOf(lib, 'medieval', null)?.key).toBe('a');
    expect(myLibraryOf(lib, 'medieval', 'b')?.key).toBe('b');
    expect(myLibraryOf(lib, 'b', 'a')?.key).toBe('b');
    expect(myLibraryOf(lib, 'medieval', 'old')?.key).toBe('a');
    expect(myLibraryOf([...BUILTIN, noEra], 'medieval', null)).toBeNull();
    expect(copyBaseOf(BUILTIN, 'fantasy')).toBe('fantasy');
    expect(copyBaseOf(BUILTIN, 'gone')).toBe('medieval');
    expect(copyBaseOf(BUILTIN, undefined)).toBe('medieval');
  });

  it('存进去的库新建世界的向导里选得到，读得回来', () => {
    const e = full.clone();
    const mine = myCopy();
    const c = worldCultures(e.world.small)[0];
    put(e, 'culture', { ...item(e, 'culture', c.id), name: '改过的文化' });
    const plan = savePlan([{ kind: 'culture', id: c.id }], e.world, mine.pack);
    expect(plan.count).toBe(1);
    expect(plan.names).toEqual(['改过的文化']);
    const saved = packItems<{ id: string; name: string }>(plan.pack, 'cultures').find((x) => x.id === c.id)!;
    expect(saved.name).toBe('改过的文化');
    // 库别的地方一个没动（同一批对象）
    expect(packItems(plan.pack, 'governments')).toEqual(packItems(mine.pack, 'governments'));
    expect(parsePack(plan.pack).ok).toBe(true);
    const options = libraryOptions([...BUILTIN, mineEntry(plan.pack, mine.key)], true);
    expect(options.find((o) => o.key === mine.key)).toMatchObject({ name: MY_LIBRARY_NAME, builtin: false });
    expect(saveLabel(plan)).toBe('存“改过的文化”');
    expect(savedNote(plan, MY_LIBRARY_NAME)).toBe('已把“改过的文化”存到“我的库”：新建世界时选“我的库”就带上');
  });

  it('没改过的不存；再存一次也不存（库里已经是这样）', () => {
    const e = full.clone();
    const mine = myCopy();
    const c = worldCultures(e.world.small)[0];
    const same = savePlan([{ kind: 'culture', id: c.id }], e.world, mine.pack);
    expect(same.count).toBe(0);
    expect(same.pack).toBe(mine.pack);
    expect(same.same).toEqual([c.name]);
    expect(nothingNote(same, MY_LIBRARY_NAME)).toBe('“我的库”里已经是这样');
    put(e, 'culture', { ...item(e, 'culture', c.id), name: '改过' });
    const once = savePlan([{ kind: 'culture', id: c.id }], e.world, mine.pack);
    const twice = savePlan([{ kind: 'culture', id: c.id }], e.world, once.pack);
    expect(twice.count).toBe(0);
    expect(twice.pack).toBe(once.pack);
  });

  it('自己新建的一项：它写到的、库里没有的一起带上（新文化组里的新文化）', () => {
    const e = full.clone();
    const mine = myCopy();
    const g = add(e, 'cultureGroup', { name: '我的组' });
    const c = add(e, 'culture', { name: '我的文化', group: g.id });
    const plan = savePlan([{ kind: 'culture', id: String(c.id) }], e.world, mine.pack);
    expect(plan.count).toBe(2);
    expect(plan.names[0]).toBe('我的文化');
    expect(plan.names).toContain('我的组');
    expect(packItems<{ id: string }>(plan.pack, 'cultures').some((x) => x.id === c.id)).toBe(true);
    expect(packItems<{ id: string }>(plan.pack, 'cultureGroups').some((x) => x.id === g.id)).toBe(true);
    expect(parsePack(plan.pack).ok).toBe(true);
    expect(savedNote(plan, MY_LIBRARY_NAME)).toBe('已把“我的文化”等 2 项存到“我的库”：新建世界时选“我的库”就带上');
    // 存过以后又改了：换掉库里的那一份，不另存一份
    put(e, 'culture', { ...item(e, 'culture', String(c.id)), name: '我的文化二' });
    const again = savePlan([{ kind: 'culture', id: String(c.id) }], e.world, plan.pack);
    expect(again.count).toBe(1);
    expect(packItems<{ id: string; name: string }>(again.pack, 'cultures').filter((x) => x.id === c.id).map((x) => x.name)).toEqual(['我的文化二']);
  });

  it('存完把来源记成我的库：标记、再存都和它比；一项的页面上只有一个“存到我的库”', () => {
    const e = full.clone();
    const mine = myCopy();
    const c = worldCultures(e.world.small)[0];
    put(e, 'culture', { ...item(e, 'culture', c.id), name: '改过' });
    const kind = kindOf('culture')!;
    const plan = savePlan([{ kind: 'culture', id: c.id }], e.world, mine.pack);
    const rec = recordedOrigin(e.world.small, 'culture', c.id)!;
    e.exec(repointCommand(kind, c.id, item(e, 'culture', c.id), [mine.key, ...rec.slice(1)], e.world)!);
    e.update();
    expect(recordedOrigin(e.world.small, 'culture', c.id)![0]).toBe(mine.key);
    const libs = [{ key: mine.key, pack: plan.pack }, ...ROOTS];
    expect(sourceDiff(kind, c.id, item(e, 'culture', c.id), e.world, libs).t).toBe('same');
    // 按钮：改过的、自己做的都是同一个 saveToMine，没有“存回”
    const ctx = ctxOf(e);
    const row = rowsOf(WORLD_SOURCE, kind, ctx)[0];
    const can = { remove: false, usage: null, setDefault: false, hasCells: false, dedicated: false, newable: true };
    const ids = (changed: boolean, saveable: boolean) => itemActions(WORLD_SOURCE, row, ctx, { ...can, changed, saveable }).map((a) => a.id);
    expect(ids(true, false).filter((x) => x === 'saveToMine')).toHaveLength(1);
    expect(ids(false, true).filter((x) => x === 'saveToMine')).toHaveLength(1);
    expect(ids(true, true).filter((x) => x === 'saveToMine')).toHaveLength(1);
    expect(ids(false, false)).not.toContain('saveToMine');
    expect(ids(true, false)).not.toContain('saveBack');
  });

  it('“⋯ → 存到我的库…”：改过的、自己做的都算，没动过的不算；一步存完', () => {
    const e = full.clone();
    const mine = myCopy();
    expect(saveableRefs(e.world, mine.pack)).toEqual([]);
    const c = worldCultures(e.world.small)[0];
    put(e, 'culture', { ...item(e, 'culture', c.id), name: '改过' });
    const g = add(e, 'government', { name: '我的政体' });
    const refs = saveableRefs(e.world, mine.pack);
    expect(refs).toEqual(expect.arrayContaining([{ kind: 'culture', id: c.id }, { kind: 'government', id: g.id }]));
    expect(refs).toHaveLength(2);
    const plan = savePlan(refs, e.world, mine.pack);
    expect(plan.count).toBe(2);
    expect(saveableRefs(e.world, plan.pack).filter((r) => r.kind === 'government')).toEqual([]);
    expect(parsePack(plan.pack).ok).toBe(true);
  });

  it('这张地图当作来源：只有能存进库的种类，按世界记着', () => {
    const p = worldAsPack(full.world);
    expect(worldAsPack(full.world)).toBe(p);
    expect(packItems(p, 'cultures').length).toBe(worldCultures(full.world.small).length);
    expect(importPreview({ source: p, target: { t: 'pack', pack: myCopy().pack }, picks: [] }).count).toBe(0);
  });
});

describe('以前存的“我的资源”：读得到，能并进我的库', () => {
  const legacy = (): ResourcePack => {
    const r = parsePack({
      format: 'map2-pack',
      version: 1,
      id: MY_PACK_KEY,
      name: '我的资源',
      governments: [{ ...packItems<Record<string, unknown>>(medieval, 'governments')[0], id: 'my-old-gov', name: '以前存的政体' }],
    });
    if (!r.ok) throw new Error(r.errors.join('；'));
    return r.pack;
  };

  it('显示成“以前存的内容”（内容一样，同一个包给同一个对象）；别的包不动', () => {
    const p = legacy();
    const s = shownPack(MY_PACK_KEY, p);
    expect(s.name).toBe(LEGACY_SHOWN_NAME);
    expect(shownPack(MY_PACK_KEY, p)).toBe(s);
    expect(s.governments).toBe(p.governments);
    expect(shownPack('other', p)).toBe(p);
    const renamed = { ...p, name: '我改过名字' };
    expect(shownPack(MY_PACK_KEY, renamed)).toBe(renamed);
  });

  it('首页写新建世界时选不到，能并进我的库；并进去的都在，原来的不动', () => {
    const old = mineEntry(shownPack(MY_PACK_KEY, legacy()), MY_PACK_KEY);
    const mine = myCopy();
    const ctx: PageCtx = { world: null, lib: [...BUILTIN, old, mine] };
    const home = homePage({ t: 'lib', key: old.key }, ctx);
    expect(home.note).toBe('这个库没有时代，新建世界时选不到');
    expect(home.mergeKey).toBe(old.key);
    expect(mergeable(old)).toBe(true);
    // 新建世界时选得到的库、内置的库没有这一句
    expect(homePage({ t: 'lib', key: mine.key }, ctx).note).toBeNull();
    expect(homePage({ t: 'lib', key: 'medieval' }, ctx).note).toBeNull();
    expect(mergeable(mine)).toBe(false);
    const plan = mergePlan(old.pack, mine.pack);
    expect(plan.count).toBe(1);
    expect(plan.names).toEqual(['以前存的政体']);
    expect(packItems<{ id: string }>(plan.pack, 'governments').some((g) => g.id === 'my-old-gov')).toBe(true);
    expect(packItems(old.pack, 'governments')).toHaveLength(1);
    expect(parsePack(plan.pack).ok).toBe(true);
    // 再并一次什么都不加
    expect(mergePlan(old.pack, plan.pack).count).toBe(0);
  });
});

describe('从别的库添加：每一步一句人话', () => {
  it('连带了几样、清单的一句、不能选的为什么', () => {
    const rows = [
      { name: '封建君主制', role: 'pick' as const, because: [] },
      { name: '贵族', role: 'child' as const, because: ['封建君主制 里的'] },
      { name: '教士', role: 'follow' as const, because: ['封建君主制 要它', '神权国 要它'] },
      { name: '神权国', role: 'pick' as const, because: [] },
    ];
    const holder = {};
    const m = bringsOf(rows, holder);
    expect(m.get('封建君主制')).toBe(2);
    expect(m.get('神权国')).toBe(1);
    expect(bringsOf([], holder)).toBe(m);
    expect(bringsNote(2)).toBe('勾了它，它用到的 2 样会一起带上');
    expect(basketLine({ rows: rows as never, count: 4 })).toBe('勾了 2 项，它们用到的 2 项一起带上');
    expect(basketLine({ rows: rows.slice(0, 1) as never, count: 1 })).toBe('勾了 1 项，没有连带别的');
    expect(basketLine({ rows: [], count: 0 })).toBeNull();
    expect(haveNote('这张地图')).toBe('这张地图已经有了');
    expect(unpickableNote('这张地图')).toBe('这一种不能加到这张地图');
  });

  it('列表的一行：勾着的写连带几样，已经有了的、灰的都写着原因', () => {
    const planned = new Map(
      [
        { kind: 'government', id: 'g', name: '封建君主制', role: 'pick', state: 'new', because: [] },
        { kind: 'faction', id: 'f', name: '贵族', role: 'child', state: 'new', because: ['封建君主制 里的'] },
      ].map((r) => [refKey(r), r]),
    );
    const gates = { of: (r: { kind: string; id: string }) => (r.id === 'have' ? { t: 'have' } : r.id === 'grey' ? { t: 'gated', reason: '需要意识形态', needs: [], any: false, resolvable: false } : { t: 'free' }) };
    const key = (kind: string, id: string) => ({ kind, id });
    const c = { picks: new Set([refKey(key('government', 'g'))]), planned, gates, here: '这张地图' } as never;
    expect(rowLook(key('government', 'g'), c)).toMatchObject({ mark: 'on', note: '勾了它，它用到的 1 样会一起带上' });
    expect(rowLook(key('faction', 'f'), c)).toMatchObject({ mark: 'child', note: null });
    expect(rowLook(key('government', 'have'), c)).toMatchObject({ mark: 'have', note: '这张地图已经有了' });
    expect(rowLook(key('government', 'grey'), c)).toMatchObject({ mark: 'grey', note: '需要意识形态' });
  });
});
