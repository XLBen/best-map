import { afterEach, describe, expect, it } from 'vitest';
import { allKinds, itemId, kindOf } from '../../../core/content/registry';
import { type ResourcePack, itemErrors, packItems, packSections } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import type { Species } from '../../../core/species';
import { PLAIN_TYPE, type WaterType } from '../../../core/water-types';
import { waterAllowed } from '../../../core/water-table';
import { continents, snapshot, type HumanCommand, humanExec } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { copiedPack, libEdits } from '../../library-edit';
import { world } from '../../state';
import { commitItem, commitWaterBlock, commitWaterCell, copyItemIn, deleteFromLibrary, newItemIn, speciesPatch, worldItemCommand } from './page-actions';
import { DEFAULT_INSIDE, HOME_LAYOUT } from './page-layout';
import { fieldBrief, initialOpen, segmentBrief, segmentsOf } from './page-segments';
import {
  HOME,
  type PageCtx,
  type Route,
  type SourceRef,
  WORLD_SOURCE,
  backLabel,
  crumbs,
  dimensionsOf,
  eraSummary,
  homePage,
  itemActions,
  itemOf,
  itemPage,
  itemsOf,
  kindReadonly,
  listPage,
  listedKinds,
  liveSource,
  liveStack,
  openTarget,
  popRoute,
  pushRoute,
  reachableKinds,
  readonlyWhy,
  refRoute,
  regenNote,
  rowsOf,
  sourceKind,
  sourceMenu,
  sourceTitle,
  undoTarget,
  waterHub,
  waterLists,
  waterTable,
} from './pages';
import { closeLibrary, goBack, goDepth, goTo, libPanel, livePanel, moveToCopy, openLibrary, setSource } from './panel-store';

// 第五十九轮：新面板的逻辑。首页、点进去、面包屑、一项的页面、只读、总表和生态页河湖页同一份

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mineEntry = (pack: ResourcePack, key = pack.id): LibraryEntry => ({ key, pack, builtin: false, mine: true, installedAt: 1 });
const medieval = builtinPacks().find((p) => p.id === 'medieval')!;
const fantasy = builtinPacks().find((p) => p.id === 'fantasy')!;

const GEN: HumanCommand = { op: 'generate_human', era: 'medieval', groups: [{ id: 'germanic', weight: 3 }, { id: 'chinese', weight: 3 }], countries: {}, settlements: {} };
const peopled = () =>
  snapshot('r59:peopled', () => {
    const e = continents();
    humanExec(e, GEN);
    return e;
  });

const ctxOf = (world: PageCtx['world'] = null, extra: LibraryEntry[] = []): PageCtx => ({ world, lib: [...BUILTIN, ...extra] });
const lib = (key: string): SourceRef => ({ t: 'lib', key });

afterEach(() => {
  libPanel.value = null;
  library.value = BUILTIN;
  world.value = null;
});

describe('来源：本世界、内置的库、我的库', () => {
  const copy = mineEntry(copiedPack(medieval, 'm2', '我的中世纪'));
  const imported: LibraryEntry = { key: 'x', pack: { format: 'map2-pack', version: 1, id: 'x', name: '别人的' }, builtin: false, mine: false, installedAt: 2 };

  it('下拉：本世界 / 内置六个 / 我的库 / 导入的', () => {
    const m = sourceMenu(lib('m2'), ctxOf(null, [copy, imported]));
    expect(m.world).toMatchObject({ name: '本世界', on: false });
    expect(m.builtin.map((x) => x.name).length).toBe(6);
    expect(m.mine).toEqual([{ src: lib('m2'), name: '我的中世纪', on: true }]);
    expect(m.imported.map((x) => x.name)).toEqual(['别人的']);
  });

  it('只读：内置的、导入的只读，我的库和本世界能改；本世界里星球形态不能改', () => {
    const ctx = ctxOf(continents().world, [copy, imported]);
    expect(readonlyWhy(lib('medieval'), ctx)).toBe('内置的库只读');
    expect(readonlyWhy(lib('x'), ctx)).toBe('导入的库只读');
    expect(readonlyWhy(lib('m2'), ctx)).toBeNull();
    expect(readonlyWhy(WORLD_SOURCE, ctx)).toBeNull();
    expect(kindReadonly(WORLD_SOURCE, kindOf('planetForm')!, ctx)).toContain('星球形态');
    expect(kindReadonly(lib('m2'), kindOf('planetForm')!, ctx)).toBeNull();
    expect(sourceKind(lib('no-such'), ctx)).toBeNull();
    expect(sourceTitle(lib('m2'), ctx)).toBe('我的中世纪');
  });

  it('库不在了回到本世界', () => {
    expect(liveSource(lib('no-such'), ctxOf())).toEqual(WORLD_SOURCE);
    expect(liveSource(lib('medieval'), ctxOf())).toEqual(lib('medieval'));
  });
});

describe('首页', () => {
  const world = () => continents().world;

  it('分五段，时代规则在最上面；每种列出来的内容都到得了', () => {
    const p = homePage(lib('medieval'), ctxOf());
    expect(p.sections.map((s) => s.title)).toEqual(['人文', '政治', '城市与地标', '地理', '外观']);
    expect(p.era).toMatchObject({ title: '时代规则', route: { p: 'item', kind: 'era', id: 'medieval' } });
    expect(p.era!.summary).toContain('人口密度');
    expect(new Set(reachableKinds())).toEqual(new Set(listedKinds()));
  });

  it('本世界和库的卡片一模一样，只差数', () => {
    const w = peopled().world;
    const titles = (s: SourceRef, ctx: PageCtx) => homePage(s, ctx).sections.map((x) => [x.title, x.cards.map((c) => c.id)]);
    const ctx = ctxOf(w);
    expect(titles(WORLD_SOURCE, ctx)).toEqual(titles(lib('medieval'), ctx));
    const n = (s: SourceRef, id: string) => homePage(s, ctx).sections.flatMap((x) => x.cards).find((c) => c.id === id)!.count;
    expect(n(lib('medieval'), 'cultureGroup')).toBe(String(packItems(medieval, 'cultureGroups').length));
    expect(n(WORLD_SOURCE, 'cultureGroup')).toBe(String(itemsOf(WORLD_SOURCE, kindOf('cultureGroup')!, ctx).length));
  });

  it('时代的每一维一张卡片，写几组（点进去只看这一维）；变量是时代规则的那一段', () => {
    const ctx = ctxOf();
    const cards = homePage(lib('medieval'), ctx).sections[0].cards;
    const religion = cards.find((c) => c.id === 'dim:religion')!;
    expect(religion.title).toBe('宗教');
    expect(religion.count).toMatch(/^\d+ 组$/);
    expect(religion.route).toEqual({ p: 'list', kind: 'popValue', dim: 'religion' });
    expect(cards.find((c) => c.id === 'variables')!.route).toEqual({ p: 'item', kind: 'era', id: 'medieval', seg: 'dims' });
  });

  it('没有世界也能看库；本世界一页只写没有世界', () => {
    expect(homePage(WORLD_SOURCE, ctxOf(null))).toMatchObject({ noWorld: true, era: null, sections: [] });
    expect(homePage(lib('modern'), ctxOf(null)).noWorld).toBe(false);
  });

  it('空的库：卡片都在，写着 0；写一句新建世界时选不到', () => {
    const empty = mineEntry({ format: 'map2-pack', version: 1, id: 'e', name: '空的' });
    const p = homePage(lib('e'), ctxOf(null, [empty]));
    expect(p.era).toMatchObject({ summary: '没有', empty: true, route: { p: 'list', kind: 'era' } });
    expect(p.note).toContain('选不到');
    const culture = p.sections[0].cards.find((c) => c.id === 'culture')!;
    expect([culture.count, culture.empty]).toEqual(['0', true]);
  });

  it('归属由表决定（第六十轮的 arrange）：归到别的卡片下面的不单独列，上级写“含”', () => {
    expect(DEFAULT_INSIDE).toEqual({});
    const p = homePage(lib('medieval'), ctxOf(), { culture: 'cultureGroup', nameStyle: 'cultureGroup', faction: 'government' });
    const human = p.sections[0].cards;
    expect(human.some((c) => c.id === 'culture' || c.id === 'nameStyle')).toBe(false);
    expect(human.find((c) => c.id === 'cultureGroup')!.contains).toBe('含文化、地名风格');
    expect(p.sections[1].cards.find((c) => c.id === 'government')!.contains).toBe('含派系');
    // 上级不在时不藏
    expect(homePage(lib('medieval'), ctxOf(), { culture: 'no-such' }).sections[0].cards.some((c) => c.id === 'culture')).toBe(true);
  });

  it('世界里的卡片数和世界一样', () => {
    const w = world();
    const ctx = ctxOf(w);
    expect(homePage(WORLD_SOURCE, ctx).sections.flatMap((s) => s.cards).find((c) => c.id === 'terrainClass')!.count).toBe(String(kindOf('terrainClass')!.inWorld(w).length));
  });

  it('生态与水系：生态、河、湖、总表', () => {
    const hub = waterHub(lib('fantasy'), ctxOf());
    expect(hub.cards.map((c) => c.title)).toEqual(['生态', '河', '湖', '总表']);
    expect(hub.cards.map((c) => c.route)).toEqual([{ p: 'list', kind: 'biome' }, { p: 'list', kind: 'riverType' }, { p: 'list', kind: 'lakeType' }, { p: 'table' }]);
    expect(HOME_LAYOUT.find((s) => s.id === 'geo')!.cards).toContain('water');
  });

  it('时代规则的一句话', () => {
    const era = packItems<import('../../../core/human').Era>(medieval, 'eras')[0];
    const s = eraSummary(era);
    expect(s).toContain(`人口密度 ${era.popDensity}`);
    if (era.years) expect(s).toContain(`${era.years[0]}–${era.years[1]}`);
  });
});

describe('层层点进去', () => {
  it('压栈、返回、面包屑、返回按钮写回到哪里', () => {
    const ctx = ctxOf();
    let s: Route[] = [HOME];
    expect(backLabel(s, lib('medieval'), ctx)).toBeNull();
    s = pushRoute(s, { p: 'list', kind: 'cultureGroup' });
    s = pushRoute(s, { p: 'item', kind: 'cultureGroup', id: 'germanic' });
    const c = crumbs(s, lib('medieval'), ctx);
    expect(c.map((x) => x.label)).toEqual(['中世纪与近世', '文化组', packItems<{ id: string; name: string }>(medieval, 'cultureGroups').find((g) => g.id === 'germanic')!.name]);
    expect(c.map((x) => x.depth)).toEqual([0, 1, null]);
    expect(backLabel(s, lib('medieval'), ctx)).toBe('文化组');
    s = popRoute(s);
    expect(s.at(-1)).toEqual({ p: 'list', kind: 'cultureGroup' });
    expect(popRoute(popRoute(s))).toEqual([HOME]);
  });

  it('这一项没了（撤销了新建、换了来源）时退到还在的那一层', () => {
    const ctx = ctxOf();
    const s: Route[] = [HOME, { p: 'list', kind: 'culture' }, { p: 'item', kind: 'culture', id: 'no-such' }, { p: 'table' }];
    expect(liveStack(s, lib('medieval'), ctx)).toEqual([HOME, { p: 'list', kind: 'culture' }]);
    expect(liveStack([{ p: 'list', kind: 'no-such' }], lib('medieval'), ctx)).toEqual([HOME]);
  });

  it('面板的状态：打开、点进去、返回、换库回到首页；关上再打开回到原来的地方', () => {
    library.value = BUILTIN;
    openLibrary({ entry: 'medieval' });
    expect(libPanel.value).toEqual({ source: lib('medieval'), stack: [HOME] });
    goTo({ p: 'list', kind: 'culture' });
    goTo({ p: 'item', kind: 'culture', id: packItems<{ id: string }>(medieval, 'cultures')[0].id });
    expect(libPanel.value!.stack.length).toBe(3);
    goBack();
    expect(libPanel.value!.stack.length).toBe(2);
    closeLibrary();
    expect(libPanel.value).toBeNull();
    openLibrary();
    expect(libPanel.value).toMatchObject({ source: lib('medieval') });
    expect(libPanel.value!.stack.length).toBe(2);
    goDepth(0);
    expect(libPanel.value!.stack).toEqual([HOME]);
    goTo({ p: 'list', kind: 'culture' });
    setSource(lib('modern'));
    expect(libPanel.value).toEqual({ source: lib('modern'), stack: [HOME] });
  });

  it('复制成我的库之后还在同一页', () => {
    const copy = mineEntry(copiedPack(medieval, 'm2', 'm2'));
    library.value = [...BUILTIN, copy];
    openLibrary({ entry: 'medieval' });
    goTo({ p: 'list', kind: 'culture' });
    moveToCopy(lib('m2'));
    expect(libPanel.value).toEqual({ source: lib('m2'), stack: [HOME, { p: 'list', kind: 'culture' }] });
    const st = libPanel.value!;
    expect(livePanel(st).stack.length).toBe(2);
  });

  it('别处点进来：在世界里看的开本世界；“从资源库添加”开世界用的库、只列不在本世界的', () => {
    const ctx = ctxOf();
    expect(openTarget({ kind: 'culture' }, ctx, 'modern', 'medieval')).toEqual({ source: WORLD_SOURCE, stack: [HOME, { p: 'list', kind: 'culture' }] });
    expect(openTarget({ kind: 'culture', off: true }, ctx, 'modern', 'medieval')).toEqual({ source: lib('modern'), stack: [HOME, { p: 'list', kind: 'culture', hideOn: true }] });
    expect(openTarget({ kind: 'culture', off: true }, ctx, undefined, 'medieval').source).toEqual(lib('medieval'));
    expect(openTarget({ kind: 'biome', off: true, entry: 'fantasy' }, ctx, 'modern', 'medieval').source).toEqual(lib('fantasy'));
    expect(openTarget({}, ctx, undefined, 'medieval')).toEqual({ source: WORLD_SOURCE, stack: [HOME] });
  });
});

describe('列表', () => {
  it('文化按文化组分段，段的标题点了去那一组；文化组写有几个文化', () => {
    const ctx = ctxOf();
    const p = listPage(lib('medieval'), { p: 'list', kind: 'culture' }, ctx)!;
    expect(p.sections.length).toBeGreaterThan(5);
    const germanic = p.sections.find((s) => s.link && s.link.p === 'item' && s.link.id === 'germanic')!;
    expect(germanic.label).toBe(packItems<{ id: string; name: string }>(medieval, 'cultureGroups').find((g) => g.id === 'germanic')!.name);
    expect(germanic.rows.every((r) => (r.item as { group: string }).group === 'germanic')).toBe(true);
    const groups = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx)!;
    const row = groups.sections[0].rows.find((r) => r.id === 'germanic')!;
    expect(row.hint).toBe(`${packItems<{ group: string }>(medieval, 'cultures').filter((c) => c.group === 'germanic').length} 个文化`);
  });

  it('文化组：比重 0 的（这个库默认不带）放后面一段', () => {
    const p = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctxOf())!;
    expect(p.sections.map((s) => s.label)).toEqual(['这个库默认带的', '这个库默认不带的']);
    expect(p.sections[1].rows.every((r) => (r.item as { weight?: number }).weight === 0)).toBe(true);
  });

  it('只看一维：取值按取值组分段（没有取值的组也列着），新建时带上这一维；一组的文化', () => {
    const ctx = ctxOf();
    const p = listPage(lib('medieval'), { p: 'list', kind: 'popValue', dim: 'religion' }, ctx)!;
    expect(p.title).toBe('宗教');
    expect(p.sections.every((s) => s.rows.every((r) => (r.item as { dimension: string }).dimension === 'religion'))).toBe(true);
    expect(p.defaults).toEqual({ dimension: 'religion' });
    const g = listPage(lib('medieval'), { p: 'list', kind: 'culture', group: 'germanic' }, ctx)!;
    expect(g.sections.length).toBe(1);
    expect(g.defaults).toEqual({ group: 'germanic' });
    expect(g.title).toContain('文化');
  });

  it('搜索：名字或 id', () => {
    const ctx = ctxOf();
    const all = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx)!;
    const one = all.sections[0].rows[0];
    const hit = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx, one.name)!;
    expect(hit.sections.flatMap((s) => s.rows).map((r) => r.id)).toContain(one.id);
    expect(listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx, '没有这个名字')).toMatchObject({ total: 0, empty: '没有找到' });
  });

  it('只读的库不能新建、不能拖；我的库能', () => {
    const copy = mineEntry(copiedPack(medieval, 'm2', 'm2'));
    const ctx = ctxOf(null, [copy]);
    expect(listPage(lib('medieval'), { p: 'list', kind: 'culture' }, ctx)).toMatchObject({ canNew: false, canMove: false, readonly: '内置的库只读' });
    expect(listPage(lib('m2'), { p: 'list', kind: 'culture' }, ctx)).toMatchObject({ canNew: true, canMove: true, readonly: null });
    expect(listPage(lib('m2'), { p: 'list', kind: 'culture' }, ctx, '搜')!.canMove).toBe(false);
  });

  it('每种内容都有新建的样子，样子合格式', () => {
    for (const k of packSections()) {
      if (k.id === 'planetForm') continue;
      expect(k.blank, k.id).toBeTruthy();
      expect(itemErrors(k, k.blank!()), k.id).toEqual([]);
    }
  });

  it('同一项在几个小包里只列一次', () => {
    const rows = rowsOf(lib('medieval'), kindOf('landmarkType')!, ctxOf());
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.length).toBe(packItems(medieval, 'landmarkTypes').length);
  });

  it('库的列表看得到在不在本世界；只看不在的', () => {
    const w = continents().world;
    const ctx = ctxOf(w);
    const list = listPage(lib('medieval'), { p: 'list', kind: 'terrainClass' }, ctx)!;
    expect(list.sections[0].rows.every((r) => r.row.status.on)).toBe(true);
    expect(listPage(lib('medieval'), { p: 'list', kind: 'terrainClass', hideOn: true }, ctx)).toMatchObject({ total: 0, empty: '都在本世界了' });
    expect(listPage(lib('fantasy'), { p: 'list', kind: 'biome', hideOn: true }, ctx)!.total).toBeGreaterThan(0);
  });
});

describe('一项的页面', () => {
  it('每种内容：除了 id，每个字段都在且只在一段里（第五十八轮的典型高度在地形类别的第一段）', () => {
    for (const k of allKinds()) {
      if (!k.pack.listed) continue;
      const segs = segmentsOf(k);
      const inSegs = segs.flatMap((s) => s.fields);
      for (const f of k.fields) {
        if (f.key === 'id') {
          expect(inSegs.includes(f), `${k.id}.id`).toBe(false);
          continue;
        }
        expect(inSegs.filter((x) => x === f).length, `${k.id}.${f.key}`).toBe(1);
      }
      expect(new Set(segs.map((s) => s.id)).size, k.id).toBe(segs.length);
    }
    const cls = segmentsOf(kindOf('terrainClass')!)[0];
    expect(cls.fields.map((f) => f.key)).toContain('height');
    expect(cls.fields.find((f) => f.key === 'height')).toMatchObject({ type: 'number', min: 0, max: 9000 });
  });

  it('一开始展开第一段；从引用点过来时展开那一段', () => {
    const segs = segmentsOf(kindOf('era')!);
    expect([...initialOpen(segs)]).toEqual(['basic']);
    expect([...initialOpen(segs, 'dims')]).toEqual(['dims']);
  });

  it('收起时写一句当前内容', () => {
    const k = kindOf('cultureGroup')!;
    const germanic = packItems<Record<string, unknown>>(medieval, 'cultureGroups').find((g) => g.id === 'germanic')!;
    const names = segmentsOf(k).find((s) => s.id === 'names')!;
    expect(segmentBrief(names, germanic)).toBe(String(germanic.nameStyle));
    expect(segmentBrief(names, germanic, () => '西欧·日耳曼')).toBe('西欧·日耳曼');
    expect(fieldBrief({ key: 'x', label: '比重', type: 'number' }, 3)).toBe('比重 3');
    expect(fieldBrief({ key: 'x', label: '开', type: 'bool' }, false)).toBe('');
    expect(fieldBrief({ key: 'x', label: '规则', type: 'list' }, [1, 2])).toBe('规则 2');
    expect(fieldBrief({ key: 'x', label: '高度', type: 'range', unit: 'm' }, { low: 0, high: 300 })).toBe('高度 0–300m');
    expect(fieldBrief({ key: 'x', label: '目标', type: 'tags' }, ['a', 'b', 'c'])).toBe('a、b 等 3 个');
    expect(fieldBrief({ key: 'x', label: '称号', type: 'title' }, { default: '王国' })).toBe('王国');
  });

  it('内置的库：只读、能复制成我的库；我的库能改', () => {
    const copy = mineEntry(copiedPack(medieval, 'm2', 'm2'));
    const ctx = ctxOf(null, [copy]);
    const r: Route = { p: 'item', kind: 'cultureGroup', id: 'germanic' };
    expect(itemPage(lib('medieval'), r as never, ctx)).toMatchObject({ readonly: '内置的库只读', canCopyLibrary: true });
    expect(itemPage(lib('m2'), r as never, ctx)).toMatchObject({ readonly: null, canCopyLibrary: false });
    expect(itemPage(lib('m2'), { p: 'item', kind: 'culture', id: 'no-such' }, ctx)).toBeNull();
  });

  it('文化组的页面有一行“组里的文化”，点进去只看这一组', () => {
    const p = itemPage(lib('medieval'), { p: 'item', kind: 'cultureGroup', id: 'germanic' }, ctxOf())!;
    expect(p.related).toEqual([{ label: '组里的文化', count: packItems<{ group: string }>(medieval, 'cultures').filter((c) => c.group === 'germanic').length, route: { p: 'list', kind: 'culture', group: 'germanic' } }]);
  });

  it('这一项能做什么：内置的没有删除、能复制库；我的库能删、复制；本世界能移出、在用的写为什么不能', () => {
    const copy = mineEntry(copiedPack(medieval, 'm2', 'm2'));
    const w = continents().world;
    const ctx = ctxOf(w, [copy]);
    const can = { remove: true, usage: null as string | null, restore: false, setDefault: false, hasCells: false, saveable: false, dedicated: false, newable: true };
    const rowOf = (s: SourceRef) => rowsOf(s, kindOf('terrainClass')!, ctx)[0];
    const ids = (s: SourceRef, c = can) => itemActions(s, rowOf(s), ctx, c);
    const builtin = ids(lib('medieval')).map((a) => a.id);
    expect(builtin).toContain('copyLibrary');
    expect(builtin).not.toContain('deleteItem');
    const mine = ids(lib('m2')).map((a) => a.id);
    expect(mine).toEqual(expect.arrayContaining(['deleteItem', 'copyItem', 'exportItem']));
    expect(mine).not.toContain('copyLibrary');
    // 已经在本世界的不能再添加
    expect(ids(lib('medieval')).find((a) => a.id === 'addToWorld')!.disabled).toBe('已在本世界');
    const inWorld = ids(WORLD_SOURCE);
    expect(inWorld.find((a) => a.id === 'removeFromWorld')!.disabled).toBeUndefined();
    const used = ids(WORLD_SOURCE, { ...can, remove: false, usage: '有 3 处在用：x' });
    expect(used.find((a) => a.id === 'removeFromWorld')!.disabled).toBe('有 3 处在用：x');
    // 没有世界时不能添加到本世界
    expect(itemActions(lib('medieval'), rowsOf(lib('medieval'), kindOf('terrainClass')!, ctxOf())[0], ctxOf(), can).map((a) => a.id)).not.toContain('addToWorld');
  });

  it('改了内容要重新生成才用到的写一句（重新生成的按钮在第六十二轮）', () => {
    const w = peopled().world;
    expect(regenNote(kindOf('culture')!, w)).toContain('重新生成');
    expect(regenNote(kindOf('government')!, w)).toContain('重新生成');
    expect(regenNote(kindOf('mapStyle')!, w)).toBeNull();
    expect(regenNote(kindOf('culture')!, continents().world)).toBeNull();
  });
});

describe('引用点过去', () => {
  it('这一份里有就到那一项的页面，没有时不能点', () => {
    const ctx = ctxOf();
    expect(refRoute('cultureGroup', 'germanic', lib('medieval'), ctx)).toEqual({ p: 'item', kind: 'cultureGroup', id: 'germanic' });
    expect(refRoute('cultureGroup', 'no-such', lib('medieval'), ctx)).toBeNull();
    // 奇幻库没有 EU4 的组
    expect(refRoute('cultureGroup', 'germanic', lib('fantasy'), ctx)).toBeNull();
    // 政体的类别不是一项
    expect(refRoute('govCategory', 'monarchy', lib('medieval'), ctx)).toBeNull();
    // 文化或文化组
    expect(refRoute(['culture', 'cultureGroup'], 'germanic', lib('medieval'), ctx)).toEqual({ p: 'item', kind: 'cultureGroup', id: 'germanic' });
  });

  it('维度到时代规则的变量那一段；条件里的河到河的页面，内置的条件不能点', () => {
    const ctx = ctxOf();
    expect(refRoute('dimension', 'religion', lib('medieval'), ctx)).toEqual({ p: 'item', kind: 'era', id: 'medieval', seg: 'dims' });
    const blood = packItems<{ id: string }>(fantasy, 'riverTypes')[0].id;
    expect(refRoute('tolerance', `river:${blood}`, lib('fantasy'), ctx)).toEqual({ p: 'item', kind: 'riverType', id: blood });
    expect(refRoute('tolerance', 'tMean', lib('fantasy'), ctx)).toBeNull();
    expect(refRoute('tolerance', 'field:x', lib('fantasy'), ctx)).toBeNull();
  });
});

describe('总表：和生态页、河湖页是同一份', () => {
  // 一个能改的库（奇幻的副本），改完读一遍表和两边的页面
  function mine() {
    const copy = mineEntry(copiedPack(fantasy, 'f2', 'f2'));
    library.value = [...BUILTIN, copy];
    return { src: lib('f2'), ctx: (): PageCtx => ({ world: null, lib: library.value }) };
  }
  afterEach(() => libEdits.forget('f2'));

  it('纵列生态，横行水系，普通河、普通湖也是一行', () => {
    const t = waterTable(lib('fantasy'), ctxOf());
    const lists = waterLists(lib('fantasy'), ctxOf());
    expect(t.biomes.map((b) => b.id)).toEqual(lists.species.map((s) => s.id));
    expect(t.rows.length).toBe(lists.riverTypes.length + lists.lakeTypes.length + 2);
    expect(t.rows[0]).toMatchObject({ kind: 'river', id: PLAIN_TYPE, name: '普通河', route: null });
    expect(t.rows[t.lakesFrom]).toMatchObject({ kind: 'lake', id: PLAIN_TYPE, name: '普通湖' });
    expect(t.rows.every((r) => r.cells.length === t.biomes.length)).toBe(true);
  });

  it('写在脚本里的河标出来：每一格都勾着', () => {
    const t = waterTable(lib('fantasy'), ctxOf());
    expect(t.anyScript).toBe(true);
    const lingmai = t.rows.find((r) => r.script)!;
    expect(lingmai.cells.every(Boolean)).toBe(true);
  });

  it('在表上取消一格 → 河的页面的条件（biomes）跟着变；再勾上恢复成没列', () => {
    const { src, ctx } = mine();
    const type = waterLists(src, ctx()).riverTypes.find((t) => !t.biomes)!;
    const sp = waterLists(src, ctx()).species[0];
    expect(commitWaterCell(src, sp.id, 'river', type.id, false, ctx())).toBe(true);
    const after = waterLists(src, ctx()).riverTypes.find((t) => t.id === type.id)!;
    expect(after.biomes).not.toContain(sp.id);
    expect(after.biomes!.length).toBe(waterLists(src, ctx()).species.length - 1);
    // 河的页面看到的是同一项
    expect((itemOf(src, kindOf('riverType')!, type.id, ctx()) as WaterType).biomes).toEqual(after.biomes);
    // 表上这一格也变了
    const row = waterTable(src, ctx()).rows.find((r) => r.id === type.id)!;
    expect(row.cells[0]).toBe(false);
    expect(commitWaterCell(src, sp.id, 'river', type.id, true, ctx())).toBe(true);
    expect(waterLists(src, ctx()).riverTypes.find((t) => t.id === type.id)!.biomes).toBeUndefined();
  });

  it('在河的页面上改（改 biomes 这一项）→ 表和生态页都变', () => {
    const { src, ctx } = mine();
    const lists = waterLists(src, ctx());
    const type = lists.riverTypes.find((t) => !t.biomes)!;
    const only = lists.species.slice(0, 2).map((s) => s.id);
    expect(commitItem(src, kindOf('riverType')!, type.id, { ...type, biomes: only } as never, ctx())).toBe('saved');
    const t = waterTable(src, ctx());
    const row = t.rows.find((r) => r.id === type.id)!;
    expect(row.cells.filter(Boolean).length).toBe(2);
    const sp = waterLists(src, ctx()).species[5] as Species;
    expect(waterAllowed(waterLists(src, ctx()), sp, 'river', type.id)).toBe(false);
    expect(waterAllowed(waterLists(src, ctx()), waterLists(src, ctx()).species[0], 'river', type.id)).toBe(true);
  });

  it('普通河那一格写在生态上：表上取消 → 生态页的 plainRiver 是 false；再勾上去掉这个字段', () => {
    const { src, ctx } = mine();
    const sp = waterLists(src, ctx()).species[0];
    expect(commitWaterCell(src, sp.id, 'river', PLAIN_TYPE, false, ctx())).toBe(true);
    expect((itemOf(src, kindOf('biome')!, sp.id, ctx()) as Species).plainRiver).toBe(false);
    expect(waterTable(src, ctx()).rows[0].cells[0]).toBe(false);
    expect(commitWaterCell(src, sp.id, 'river', PLAIN_TYPE, true, ctx())).toBe(true);
    expect('plainRiver' in (itemOf(src, kindOf('biome')!, sp.id, ctx()) as object)).toBe(false);
  });

  it('选断流：同一步取消普通河；换回换类型去掉这个字段', () => {
    const { src, ctx } = mine();
    const sp = waterLists(src, ctx()).species[0];
    expect(commitWaterBlock(src, sp.id, 'stop', ctx())).toBe(true);
    const a = itemOf(src, kindOf('biome')!, sp.id, ctx()) as Species;
    expect([a.waterBlock, a.plainRiver]).toEqual(['stop', false]);
    expect(commitWaterBlock(src, sp.id, 'swap', ctx())).toBe(true);
    expect('waterBlock' in (itemOf(src, kindOf('biome')!, sp.id, ctx()) as object)).toBe(false);
  });

  it('本世界：表上的一格走世界的命令（和生态抽屉、河湖编辑同一条）；只读的库一格都不动', () => {
    const w = continents().world;
    const lists = waterLists(WORLD_SOURCE, ctxOf(w));
    expect(lists.species.length).toBe(w.small.species.length);
    expect(lists.riverTypes.length).toBe((w.small.riverTypes ?? []).length);
    expect(commitWaterCell(lib('medieval'), lists.species[0].id, 'river', PLAIN_TYPE, false, ctxOf())).toBe(false);
    expect(commitWaterBlock(lib('medieval'), lists.species[0].id, 'stop', ctxOf())).toBe(false);
  });

  it('断流的说明、河的多数说明写在页面上', () => {
    const seg = segmentsOf(kindOf('riverType')!).find((s) => s.id === 'where')!;
    expect(seg.hint).toContain('占一半以上');
    expect(seg.custom).toBe('waterBiomes');
    expect(segmentsOf(kindOf('biome')!).find((s) => s.id === 'water')!.custom).toBe('biomeWater');
    // 河的条件没有大小，湖有
    const when = (k: string) => kindOf(k)!.fields.find((f) => f.key === 'when')!.of!.map((f) => f.key);
    expect(when('riverType')).not.toContain('size');
    expect(when('lakeType')).toContain('size');
  });
});

describe('改一项就存', () => {
  const m2 = () => mineEntry(copiedPack(medieval, 'm2', 'm2'));
  afterEach(() => libEdits.forget('m2'));

  it('我的库：改了马上存，撤销回来，切走再回来撤销还在', () => {
    const entry = m2();
    library.value = [...BUILTIN, entry];
    const ctx = (): PageCtx => ({ world: null, lib: library.value });
    const k = kindOf('culture')!;
    const c = packItems<Record<string, unknown>>(medieval, 'cultures')[0];
    const id = itemId(k, c);
    expect(commitItem(lib('m2'), k, id, { ...c, name: '新名字' }, ctx())).toBe('saved');
    expect((itemOf(lib('m2'), k, id, ctx()) as { name: string }).name).toBe('新名字');
    // 内置的库不变
    expect((itemOf(lib('medieval'), k, id, ctx()) as { name: string }).name).toBe(c.name);
    // 看别的库，再回来
    openLibrary({ entry: 'medieval' });
    setSource(lib('m2'));
    expect(libEdits.canUndo('m2')).toBe(true);
    libEdits.undo('m2');
    expect((itemOf(lib('m2'), k, id, ctx()) as { name: string }).name).toBe(c.name);
    libEdits.redo('m2');
    expect((itemOf(lib('m2'), k, id, ctx()) as { name: string }).name).toBe('新名字');
  });

  it('有错的不存，留在页面上；一样的不算；只读的不动', () => {
    const entry = m2();
    library.value = [...BUILTIN, entry];
    const ctx = (): PageCtx => ({ world: null, lib: library.value });
    const k = kindOf('culture')!;
    const c = packItems<Record<string, unknown>>(medieval, 'cultures')[0];
    const id = itemId(k, c);
    expect(commitItem(lib('m2'), k, id, { ...c, color: '不是颜色' }, ctx())).toBe('invalid');
    expect(commitItem(lib('m2'), k, id, c, ctx())).toBe('same');
    expect(commitItem(lib('medieval'), k, id, { ...c, name: 'x' }, ctx())).toBe('readonly');
    expect(libEdits.canUndo('m2')).toBe(false);
  });

  it('新建、复制、删除：到新的一项的页面，撤销回到没有', () => {
    const entry = m2();
    library.value = [...BUILTIN, entry];
    const ctx = (): PageCtx => ({ world: null, lib: library.value });
    const src = lib('m2');
    const k = kindOf('riverType')!;
    const r = newItemIn(src, k, ctx()) as Route;
    expect(r.p).toBe('item');
    const id = (r as { id: string }).id;
    expect(itemOf(src, k, id, ctx())).toBeDefined();
    // 河放进“水系”这个小包
    const dup = copyItemIn(src, k, itemOf(src, k, id, ctx()), ctx()) as Route;
    expect((dup as { id: string }).id).not.toBe(id);
    expect(deleteFromLibrary(src, k, id, 'x')).toBe(true);
    expect(itemOf(src, k, id, ctx())).toBeUndefined();
    libEdits.undo('m2');
    expect(itemOf(src, k, id, ctx())).toBeDefined();
    // 只读的库不能新建
    expect(newItemIn(lib('medieval'), k, ctx())).toBeNull();
    // 只看一维时新建的取值写着这一维
    const v = newItemIn(src, kindOf('popValue')!, ctx(), { dimension: 'culture-x' }) as Route;
    expect((itemOf(src, kindOf('popValue')!, (v as { id: string }).id, ctx()) as { dimension: string }).dimension).toBe('culture-x');
  });

  it('新的文化组放进“文化”下面自己的小包', () => {
    const entry = m2();
    library.value = [...BUILTIN, entry];
    const ctx = (): PageCtx => ({ world: null, lib: library.value });
    const r = newItemIn(lib('m2'), kindOf('cultureGroup')!, ctx()) as { id: string };
    const pack = library.value.find((e) => e.key === 'm2')!.pack;
    const cultures = pack.packs!.find((p) => p.id === 'cultures')!;
    expect(cultures.packs!.at(-1)).toMatchObject({ id: r.id, weight: 1 });
  });

  it('本世界：生态的命令按字段（去掉的写 null），别的整项换掉；一样时没有命令', () => {
    const w = continents().world;
    const sp = w.small.species[0];
    const k = kindOf('biome')!;
    expect(worldItemCommand(k, sp.id, sp as never, w)).toBeNull();
    const { height: _, ...rest } = sp;
    const cmd = worldItemCommand(k, sp.id, { ...rest, name: '新的' } as never, w)!;
    expect(cmd).toMatchObject({ op: 'batch', commands: [{ op: 'update_species', id: sp.id, patch: { name: '新的', ...(sp.height ? { height: null } : {}) } }] });
    expect(speciesPatch(sp, { ...sp, color: '#000000' } as never)).toEqual({ color: '#000000' });
    const cls = kindOf('terrainClass')!;
    const item = cls.inWorld(w)[0] as Record<string, unknown>;
    expect(worldItemCommand(cls, item.id as string, { ...item, height: 700 }, w)).toMatchObject({ op: 'batch', commands: [{ op: 'set_content', kind: 'terrainClass' }] });
    // 星球形态在世界里没有命令
    expect(worldItemCommand(kindOf('planetForm')!, 'x', {}, w)).toBeNull();
  });
});

describe('⌘Z 撤销哪一边', () => {
  const copy = mineEntry(copiedPack(medieval, 'm2', 'm2'));
  const ctx = ctxOf(null, [copy]);
  it('我的库、最后点的是面板：这个库；点的是地图：世界；本世界、面板关着：世界；内置的库不撤销世界', () => {
    expect(undoTarget(lib('m2'), ctx, true)).toBe('library');
    expect(undoTarget(lib('m2'), ctx, false)).toBe('world');
    expect(undoTarget(WORLD_SOURCE, ctx, true)).toBe('world');
    expect(undoTarget(null, ctx, true)).toBe('world');
    expect(undoTarget(lib('medieval'), ctx, true)).toBe('none');
  });
});

describe('内容和维度', () => {
  it('维度：时代写的，加上取值写到的', () => {
    const ctx = ctxOf();
    expect(dimensionsOf(lib('medieval'), ctx).map((d) => d.id)).toContain('religion');
    const p: ResourcePack = { format: 'map2-pack', version: 1, id: 'p', name: 'p', popValues: [{ id: 'v', dimension: 'my-dim', name: 'v', color: '#111111' }] } as never;
    expect(dimensionsOf(lib('p'), ctxOf(null, [mineEntry(p)]))).toEqual([{ id: 'my-dim', label: 'my-dim' }]);
  });
});
