import { afterEach, describe, expect, it } from 'vitest';
import { PRESET_ARRANGE, type Arrange, mergeInto, relationOf, splitOut, withArrange } from '../../../core/content/arrange';
import { kindOf } from '../../../core/content/registry';
import { type ResourcePack, packItems, packSections } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { packImportCommands } from '../../../core/packs/import';
import { engineFor } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { copiedPack, libEdits } from '../../library-edit';
import { world } from '../../state';
import { arrangeFor, arrangeTitle, canArrange, cardActions, dropVerdict, linkView, verdictArrange, whyNotMerge } from './page-arrange';
import { applyArrange, linkChild, newChildIn, unlinkChild } from './page-actions';
import { CHILD_SHOW, childSections, shownRows } from './page-children';
import { HOME, type PageCtx, type Route, type SourceRef, WORLD_SOURCE, crumbs, backLabel, eraVariables, homePage, itemOf, itemPage, listPage, liveStack, popRoute, pushRoute, undoTarget } from './pages';
import { closeLibrary, goBack, goTo, libPanel, openLibrary, setSource } from './panel-store';

// 第六十轮：融入的界面逻辑。首页的卡片、上级页面下面的几段、拖入拖出、不允许的组合、只读、面包屑和返回

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const medieval = builtinPacks().find((p) => p.id === 'medieval')!;
const antiquity = builtinPacks().find((p) => p.id === 'antiquity')!;
const mine = (pack: ResourcePack, key = pack.id): LibraryEntry => ({ key, pack, builtin: false, mine: true, installedAt: 1 });
const copy = (id = 'm2', arrange?: Arrange): LibraryEntry => mine(arrange ? withArrange(copiedPack(medieval, id, id), arrange) : copiedPack(medieval, id, id));
const ctxOf = (w: PageCtx['world'] = null, extra: LibraryEntry[] = []): PageCtx => ({ world: w, lib: [...BUILTIN, ...extra] });
const lib = (key: string): SourceRef => ({ t: 'lib', key });
const cardsOf = (src: SourceRef, ctx: PageCtx) => homePage(src, ctx).sections.flatMap((s) => s.cards);
const cardIds = (src: SourceRef, ctx: PageCtx) => cardsOf(src, ctx).map((c) => c.id);

afterEach(() => {
  libPanel.value = null;
  library.value = BUILTIN;
  world.value = null;
});

describe('首页', () => {
  it('融入后没有单独的卡片，上级写“含”；计划里的样子', () => {
    const ctx = ctxOf();
    const p = homePage(lib('medieval'), ctx);
    const ids = p.sections.flatMap((s) => s.cards.map((c) => c.id));
    for (const gone of ['culture', 'nameStyle', 'faction', 'variables', 'valueGroup']) expect(ids, gone).not.toContain(gone);
    const card = (id: string) => p.sections.flatMap((s) => s.cards).find((c) => c.id === id)!;
    expect(card('cultureGroup').contains).toBe('含文化、地名风格、地标');
    expect(card('government').contains).toBe('含派系');
    expect(card('countryTier').contains).toBeUndefined();
    expect(card('dim:religion').contains).toBe('含取值');
    expect(p.era!.contains).toBe('含变量');
    expect(p.sections.map((s) => s.cards.map((c) => c.title))[0]).toEqual(['文化组', '宗教']);
  });

  it('不属于任何组的地标还在“城市与地标”，只列它们；地标都有组时没有这张卡片', () => {
    const ctx = ctxOf();
    const settle = homePage(lib('medieval'), ctx).sections.find((s) => s.id === 'settle')!;
    const lm = settle.cards.find((c) => c.id === 'landmarkType')!;
    const all = packItems<{ cultureGroups?: string[] }>(medieval, 'landmarkTypes');
    expect(lm.count).toBe(String(all.filter((l) => !l.cultureGroups?.length).length));
    expect(lm.route).toEqual({ p: 'list', kind: 'landmarkType', loose: 'cultureGroup' });
    const rows = listPage(lib('medieval'), lm.route as never, ctx)!.sections.flatMap((s) => s.rows);
    expect(rows.map((r) => r.id)).not.toContain('great-wall');
    expect(rows.length).toBe(all.filter((l) => !l.cultureGroups?.length).length);
    // 每个地标都写了组
    const tied = mine({ format: 'map2-pack', version: 1, id: 't', name: 'T', cultureGroups: [{ id: 'g', name: '组', color: '#111111' }], landmarkTypes: [{ ...packItems<object>(medieval, 'landmarkTypes')[0], cultureGroups: ['g'] }] });
    expect(cardIds(lib('t'), ctxOf(null, [tied]))).not.toContain('landmarkType');
  });

  it('全部单独成卡时和第 59 轮一样；每种内容都到得了', () => {
    const flat = copy('flat', {});
    const ctx = ctxOf(null, [flat]);
    expect(cardIds(lib('flat'), ctx)).toEqual(expect.arrayContaining(['culture', 'nameStyle', 'faction', 'variables', 'valueGroup', 'landmarkType']));
    expect(cardsOf(lib('flat'), ctx).every((c) => !c.contains)).toBe(true);
    // 融入着的：上级的列表最上面“全部 X”到得了
    const preset = ctxOf();
    const reach = new Set<string>();
    for (const c of cardsOf(lib('medieval'), preset)) {
      if (c.route.p === 'list') {
        reach.add(c.route.kind);
        for (const x of listPage(lib('medieval'), c.route, preset)!.inside) reach.add(x.key);
      }
      if (c.id.startsWith('dim:')) reach.add('valueGroup');
      if (c.route.p === 'ecology') for (const id of ['biome', 'riverType', 'lakeType']) reach.add(id);
    }
    reach.add('era');
    expect([...reach].sort()).toEqual(packSections().map((k) => k.id).sort());
  });

  it('本世界没有自己的安排：看来自的库，那个库不在了用预设；世界里什么都不记', () => {
    const eng = engineFor({ cells: 3000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
    const mineLib = copy('m3', splitOut(PRESET_ARRANGE, 'faction'));
    for (const c of packImportCommands([...builtinPacks(), mineLib.pack], { packs: worldPartsOf('m3').length ? worldPartsOf('m3') : [['m3', 'base']], groups: [] }, eng.world)) eng.exec(c);
    const w = eng.world;
    const before = JSON.stringify(w.small);
    expect(arrangeFor(WORLD_SOURCE, ctxOf(w, [mineLib])).faction).toBeUndefined();
    expect(arrangeFor(WORLD_SOURCE, ctxOf(w))).toBe(PRESET_ARRANGE);
    expect(arrangeFor(WORLD_SOURCE, ctxOf(null))).toBe(PRESET_ARRANGE);
    expect(JSON.stringify(w.small)).toBe(before);
    expect(canArrange(WORLD_SOURCE, ctxOf(w, [mineLib]))).toBe(false);
  });
});

describe('拖卡片', () => {
  const a = PRESET_ARRANGE;

  it('拖到讲得通的上级上：融入', () => {
    const flat = splitOut(a, 'faction');
    const v = dropVerdict('faction', 'government', flat);
    expect(v).toMatchObject({ t: 'merge', parent: 'government', text: '融入政体' });
    expect(verdictArrange(v, flat)!.faction).toBe('government');
  });

  it('不讲得通的不接受，给一句提示；安排不变', () => {
    const v = dropVerdict('mapStyle', 'government', a);
    expect(v).toMatchObject({ t: 'no', text: '画风不能融入别的内容' });
    expect(verdictArrange(v, a)).toBeNull();
    expect(dropVerdict('culture', 'government', splitOut(a, 'culture'))).toMatchObject({ t: 'no', text: '文化只能融入文化组' });
    expect(dropVerdict('faction', 'cultureGroup', splitOut(a, 'faction'))).toMatchObject({ t: 'no', text: '派系只能融入政体' });
    expect(whyNotMerge('landmarkType')).toBe('地标只能融入文化组、政体');
    expect(dropVerdict('cultureGroup', 'government', a).t).toBe('no');
  });

  it('拖到空的地方：融入着的拆出来，单独的什么都不做；拖回自己的上级什么都不做', () => {
    const out = dropVerdict('faction', null, a);
    expect(out.t).toBe('out');
    expect(verdictArrange(out, a)!.faction).toBeUndefined();
    expect(dropVerdict('mapStyle', null, a).t).toBe('none');
    expect(dropVerdict('faction', 'government', a)).toMatchObject({ t: 'none', text: '派系已经在政体里' });
    expect(dropVerdict('mapStyle', 'mapStyle', a, 'mapStyle').t).toBe('none');
  });

  it('地标从文化组拖到政体：换上级', () => {
    const v = dropVerdict('landmarkType', 'government', a);
    expect(v).toMatchObject({ t: 'merge', parent: 'government' });
    expect(verdictArrange(v, a)!.landmarkType).toBe('government');
  });

  it('取值：一维的卡片拖到取值组上就融入；融入后一维的卡片就是取值组', () => {
    const flat = splitOut(a, 'popValue');
    expect(dropVerdict('popValue', 'valueGroup', flat).t).toBe('merge');
    expect(dropVerdict('popValue', 'dim:religion', a).t).toBe('none');
    expect(dropVerdict('faction', 'dim:religion', splitOut(a, 'faction')).t).toBe('no');
  });

  it('“⋯”：融入到哪里、拆出来', () => {
    const labels = (id: string, ar: Arrange, kids: { key: string; title: string }[] = []) => cardActions(id, ar, kids).map((x) => x.label);
    expect(labels('landmarkType', a)).toEqual(['融入到政体', '拆出来']);
    expect(labels('government', a, [{ key: 'faction', title: '派系' }])).toEqual(['拆出派系']);
    expect(labels('faction', splitOut(a, 'faction'))).toEqual(['融入到政体']);
    expect(labels('mapStyle', a)).toEqual([]);
    expect(labels('dim:religion', a, [{ key: 'popValue', title: '取值' }])).toEqual(['拆出取值']);
    expect(labels('dim:religion', splitOut(a, 'popValue'))).toEqual(['融入到取值组']);
    expect(cardActions('government', a, [{ key: 'faction', title: '派系' }])[0].next.faction).toBeUndefined();
  });

  it('只读：内置的库、导入的库、本世界都不能换；只有我的库能', () => {
    const c = copy();
    const imported: LibraryEntry = { key: 'x', pack: { format: 'map2-pack', version: 1, id: 'x', name: 'x' }, builtin: false, mine: false, installedAt: 2 };
    const ctx = ctxOf(null, [c, imported]);
    expect(canArrange(lib('medieval'), ctx)).toBe(false);
    expect(canArrange(lib('x'), ctx)).toBe(false);
    expect(canArrange(WORLD_SOURCE, ctx)).toBe(false);
    expect(canArrange(lib('m2'), ctx)).toBe(true);
    library.value = [...BUILTIN, c, imported];
    expect(applyArrange(lib('medieval'), {}, '改', ctx)).toBe(false);
    expect(applyArrange(lib('x'), {}, '改', ctx)).toBe(false);
    expect(applyArrange(WORLD_SOURCE, {}, '改', ctx)).toBe(false);
    expect(library.value.find((e) => e.key === 'medieval')!.pack).toBe(medieval);
  });

  it('我的库：换了马上生效，能撤销、重做；别的内容是同一份', () => {
    const c = copy('m4');
    library.value = [...BUILTIN, c];
    const now = () => ctxOf(null, library.value.filter((e) => !e.builtin));
    expect(applyArrange(lib('m4'), splitOut(PRESET_ARRANGE, 'faction'), '拆出派系', now())).toBe(true);
    expect(cardIds(lib('m4'), now())).toContain('faction');
    expect(library.value.find((e) => e.key === 'm4')!.pack.cultures).toBe(c.pack.cultures);
    expect(libEdits.undo('m4')).toBe('拆出派系');
    expect(cardIds(lib('m4'), now())).not.toContain('faction');
    expect(libEdits.redo('m4')).toBe('拆出派系');
    expect(cardIds(lib('m4'), now())).toContain('faction');
    libEdits.forget('m4');
  });
});

describe('上级页面', () => {
  const page = (src: SourceRef, kind: string, id: string, ctx: PageCtx) => itemPage(src, { p: 'item', kind, id }, ctx)!;

  it('文化组：文化、地名风格、地标三段；风格字段由这一段代替', () => {
    const p = page(lib('medieval'), 'cultureGroup', 'chinese', ctxOf());
    expect(p.children.map((s) => s.title)).toEqual(['文化', '地名风格', '地标']);
    expect(p.segments.flatMap((s) => s.fields.map((f) => f.key))).not.toContain('nameStyle');
    expect(p.segments.map((s) => s.id)).not.toContain('names');
    expect(p.related).toEqual([]);
    const flat = copy('flat', {});
    const q = page(lib('flat'), 'cultureGroup', 'chinese', ctxOf(null, [flat]));
    expect(q.children).toEqual([]);
    expect(q.segments.flatMap((s) => s.fields.map((f) => f.key))).toContain('nameStyle');
  });

  it('政体页只列有哪些派系，没有比重；字段由这一段代替', () => {
    const gov = packItems<{ id: string; factions: string[] }>(medieval, 'governments')[0];
    const p = page(lib('medieval'), 'government', gov.id, ctxOf());
    expect(p.children.map((s) => s.key)).toEqual(['faction']);
    const s = p.children[0];
    expect(s.rows.map((r) => r.id)).toEqual(gov.factions);
    expect(s.rows.every((r) => !r.hint)).toBe(true);
    expect(p.segments.flatMap((x) => x.fields.map((f) => f.key))).not.toContain('factions');
  });

  it('属于多个组的地标每个组都列；不是这个组的不列；页面上写在哪几组', () => {
    const groups = packItems<{ id: string; cultureGroups?: string[] }>(antiquity, 'landmarkTypes').find((l) => l.id === 'pyramid')!.cultureGroups!;
    const ctx = ctxOf();
    for (const g of groups) {
      const s = page(lib('antiquity'), 'cultureGroup', g, ctx).children.find((x) => x.key === 'landmarkType')!;
      expect(s.rows.find((r) => r.id === 'pyramid')!.hint).toBe(`还在另外 ${groups.length - 1} 组`);
    }
    const p = page(lib('antiquity'), 'landmarkType', 'pyramid', ctx);
    expect(p.usedBy.parents.map((x) => x.id)).toEqual(groups);
    expect(p.usedBy.parents[0]).toMatchObject({ kind: 'cultureGroup' });
  });

  it('内置的库：能看、不能加、不能拆；我的库都能', () => {
    const r = page(lib('medieval'), 'cultureGroup', 'chinese', ctxOf()).children[0];
    expect(r).toMatchObject({ readonly: '内置的库只读', canLink: false, canNew: false, canSplit: false });
    const c = copy();
    const m = page(lib('m2'), 'cultureGroup', 'chinese', ctxOf(null, [c])).children[0];
    expect(m).toMatchObject({ readonly: null, canLink: true, canNew: true, canSplit: true, addLabel: '加文化' });
    expect(m.rows[0].out).toBe('move');
  });

  it('加、移出、新建都走内容本身：一步，能撤销；文化能移到别的组；组的默认风格能移出，文化写的不能', () => {
    const c = copy('m5');
    library.value = [...BUILTIN, c];
    const ctx = () => ctxOf(null, library.value.filter((e) => !e.builtin));
    const src = lib('m5');
    const gov = packItems<{ id: string; factions: string[] }>(medieval, 'governments')[0];
    const secOf = () => page(src, 'government', gov.id, ctx()).children[0];
    const rel = relationOf('faction', 'government')!;
    const govItem = () => itemOf(src, kindOf('government')!, gov.id, ctx()) as Record<string, unknown>;
    // 移出：政体的名单少一个，派系本身还在
    const first = secOf().rows[0];
    expect(unlinkChild(src, rel, govItem(), first.item, ctx())).toBe('saved');
    expect(secOf().rows.map((r) => r.id)).toEqual(gov.factions.slice(1));
    expect(itemOf(src, kindOf('faction')!, first.id, ctx())).toBeDefined();
    expect(libEdits.undo('m5')).not.toBeNull();
    expect(secOf().rows.map((r) => r.id)).toEqual(gov.factions);
    // 加：能加的不含已经有的
    const opts = secOf().options.map((o) => o.id);
    expect(opts.some((id) => gov.factions.includes(id))).toBe(false);
    expect(opts.length).toBeGreaterThan(0);
    const other = itemOf(src, kindOf('faction')!, opts[0], ctx()) as Record<string, unknown>;
    expect(linkChild(src, rel, govItem(), other, ctx())).toBe('saved');
    expect(secOf().rows.map((r) => r.id)).toContain(opts[0]);
    libEdits.undo('m5');
    // 新建：新的派系和政体的名单是一步
    const id = newChildIn(src, rel, govItem(), ctx()) as string;
    expect(secOf().rows.map((r) => r.id)).toContain(id);
    libEdits.undo('m5');
    expect(secOf().rows.map((r) => r.id)).not.toContain(id);
    expect(itemOf(src, kindOf('faction')!, id, ctx())).toBeUndefined();
    // 文化移到别的组
    const cr = relationOf('culture', 'cultureGroup')!;
    const cul = page(src, 'cultureGroup', 'chinese', ctx()).children[0].rows[0];
    const other2 = itemOf(src, kindOf('cultureGroup')!, 'germanic', ctx()) as Record<string, unknown>;
    expect(linkChild(src, cr, other2, cul.item, ctx())).toBe('saved');
    expect(page(src, 'cultureGroup', 'germanic', ctx()).children[0].rows.map((r) => r.id)).toContain(cul.id);
    expect(page(src, 'cultureGroup', 'chinese', ctx()).children[0].rows.map((r) => r.id)).not.toContain(cul.id);
    libEdits.undo('m5');
    // 风格
    const styles = page(src, 'cultureGroup', 'chinese', ctx()).children.find((s) => s.key === 'nameStyle')!;
    expect(styles.rows[0]).toMatchObject({ hint: '组的默认', out: 'ok' });
    expect(styles.addLabel).toBe('换地名风格');
    const byCulture = styles.rows.find((r) => r.hint?.includes('文化写着'));
    if (byCulture) expect(byCulture.out).toBeNull();
    libEdits.forget('m5');
  });

  it('新建的地标、格局、取值已经属于这一项', () => {
    const c = copy('m6');
    library.value = [...BUILTIN, c];
    const ctx = () => ctxOf(null, library.value.filter((e) => !e.builtin));
    const src = lib('m6');
    const group = itemOf(src, kindOf('cultureGroup')!, 'chinese', ctx()) as Record<string, unknown>;
    const lm = newChildIn(src, relationOf('landmarkType', 'cultureGroup')!, group, ctx()) as string;
    expect((itemOf(src, kindOf('landmarkType')!, lm, ctx()) as { cultureGroups: string[] }).cultureGroups).toEqual(['chinese']);
    const vg = packItems<{ id: string; dimension: string }>(medieval, 'valueGroups')[0];
    const val = newChildIn(src, relationOf('popValue', 'valueGroup')!, vg as never, ctx()) as string;
    expect(itemOf(src, kindOf('popValue')!, val, ctx())).toMatchObject({ group: vg.id, dimension: vg.dimension });
    libEdits.forget('m6');
  });

  it('本世界：页面有这几段，能改内容，不能换安排', () => {
    const eng = engineFor({ cells: 3000, seed: 2, latNorth: 70, latSouth: 15 }, { bare: true });
    for (const c of packImportCommands(builtinPacks(), { packs: [...worldPartsOf('medieval'), ['medieval']], groups: ['chinese'] }, eng.world)) eng.exec(c);
    const w = eng.world;
    const p = page(WORLD_SOURCE, 'cultureGroup', 'chinese', ctxOf(w));
    const s = p.children[0];
    expect(s.rows.length).toBeGreaterThan(0);
    expect(s).toMatchObject({ readonly: null, canLink: true, canSplit: false });
    // 能加的只有本世界里的
    for (const o of p.children.flatMap((x) => x.options)) expect(o.id).toBeTruthy();
  });

  it('文化组列出很多文化时只算一次表', () => {
    const many = Array.from({ length: 3000 }, (_, k) => ({ id: `c${k}`, group: 'g', name: `文化${k}`, color: '#111111' }));
    const big = mine({ format: 'map2-pack', version: 1, id: 'big', name: 'big', cultureGroups: [{ id: 'g', name: '组', color: '#222222' }], cultures: many });
    const ctx = ctxOf(null, [big]);
    const v1 = linkView(lib('big'), ctx);
    const t = v1.table(relationOf('culture', 'cultureGroup')!);
    expect(linkView(lib('big'), ctx).table(relationOf('culture', 'cultureGroup')!)).toBe(t);
    const t0 = performance.now();
    const secs = childSections(lib('big'), kindOf('cultureGroup')!, packItems(big.pack, 'cultureGroups')[0], ctx);
    expect(secs[0].rows.length).toBe(3000);
    expect(performance.now() - t0).toBeLessThan(500);
    // 先画一部分；搜索在全部里找
    const first = shownRows(secs[0].rows, '', CHILD_SHOW);
    expect([first.rows.length, first.more]).toEqual([CHILD_SHOW, 3000 - CHILD_SHOW]);
    expect(shownRows(secs[0].rows, '文化2999', CHILD_SHOW)).toMatchObject({ more: 0, rows: [{ id: 'c2999' }] });
  });
});

describe('面包屑和返回', () => {
  it('首页 → 文化组 → 这一组 → 这个文化：返回回到这一组，一路都写得清楚', () => {
    const ctx = ctxOf();
    const src = lib('medieval');
    let s: Route[] = [HOME, { p: 'list', kind: 'cultureGroup' }, { p: 'item', kind: 'cultureGroup', id: 'chinese' }];
    const cul = itemPage(src, s[2] as never, ctx)!.children[0].rows[0];
    s = pushRoute(s, { p: 'item', kind: 'culture', id: cul.id });
    expect(crumbs(s, src, ctx).map((c) => c.label)).toEqual(['中世纪与近世', '文化组', '汉', cul.name]);
    expect(backLabel(s, src, ctx)).toBe('汉');
    expect(popRoute(s).at(-1)).toEqual({ p: 'item', kind: 'cultureGroup', id: 'chinese' });
  });

  it('移到别的组之后，这个文化的页面还在，上级页面也在', () => {
    const ctx = ctxOf();
    const s: Route[] = [HOME, { p: 'list', kind: 'landmarkType', loose: 'cultureGroup' }, { p: 'item', kind: 'landmarkType', id: 'volcano' }];
    expect(liveStack(s, lib('medieval'), ctx)).toEqual(s);
  });

  it('面板：点进去、返回；换了库回到首页', () => {
    library.value = BUILTIN;
    openLibrary({ entry: 'medieval' });
    goTo({ p: 'list', kind: 'government' });
    goTo({ p: 'item', kind: 'government', id: packItems<{ id: string }>(medieval, 'governments')[0].id });
    goTo({ p: 'item', kind: 'faction', id: packItems<{ id: string }>(medieval, 'factions')[0].id });
    goBack();
    expect(libPanel.value!.stack.at(-1)).toMatchObject({ kind: 'government' });
    setSource(lib('modern'));
    expect(libPanel.value!.stack).toEqual([HOME]);
    closeLibrary();
  });

  it('⌘Z：改安排和改内容在我的库的同一个栈里', () => {
    const ctx = ctxOf(null, [copy()]);
    expect(undoTarget(lib('m2'), ctx)).toBe('library');
  });
});

describe('搜索和列表', () => {
  it('上级的列表里搜得到融入的项，灰字写在哪一组', () => {
    const ctx = ctxOf();
    const cul = packItems<{ id: string; name: string; group: string }>(medieval, 'cultures').find((c) => c.group === 'chinese')!;
    const p = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx, cul.name)!;
    const sec = p.sections.find((s) => s.label === '文化')!;
    expect(sec.rows.map((r) => r.id)).toContain(cul.id);
    expect(sec.rows.find((r) => r.id === cul.id)!.hint).toBe('在汉');
    expect(sec.rows[0].kind.id).toBe('culture');
  });

  it('政体的列表里搜得到派系，列出在哪几个政体；地标多个组时写几组', () => {
    const ctx = ctxOf();
    const f = packItems<{ id: string; name: string }>(medieval, 'factions')[0];
    const g = listPage(lib('medieval'), { p: 'list', kind: 'government' }, ctx, f.name)!;
    expect(g.sections.find((s) => s.label === '派系')!.rows.map((r) => r.id)).toContain(f.id);
    expect(listPage(lib('medieval'), { p: 'list', kind: 'countryTier' }, ctx)!.searchable).toBe(false);
    expect(listPage(lib('medieval'), { p: 'list', kind: 'government' }, ctx)!.searchable).toBe(true);
    const a = listPage(lib('antiquity'), { p: 'list', kind: 'cultureGroup' }, ctx, 'pyramid')!;
    expect(a.sections.find((s) => s.label === '地标')!.rows[0].hint).toMatch(/^在.+等 \d+ 个$/);
  });

  it('含哪几种列在最上面，点进去是全部；不属于任何组的风格在最后一段；搜索时不重复', () => {
    const ctx = ctxOf();
    const p = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx)!;
    expect(p.inside.map((x) => [x.key, x.title, x.route])).toEqual([
      ['culture', '文化', { p: 'list', kind: 'culture' }],
      ['nameStyle', '地名风格', { p: 'list', kind: 'nameStyle' }],
      ['landmarkType', '地标', { p: 'list', kind: 'landmarkType' }],
    ]);
    expect(p.inside.every((x) => !x.canSplit)).toBe(true);
    const loose = p.sections.at(-1)!;
    expect(loose.label).toBe('不属于文化组的地名风格');
    expect(loose.rows.map((r) => r.id)).toContain('fantasy-elf');
    expect(loose.rows.every((r) => r.kind.id === 'nameStyle')).toBe(true);
    const q = listPage(lib('medieval'), { p: 'list', kind: 'cultureGroup' }, ctx, 'fantasy-elf')!;
    expect(q.sections.map((s) => s.label)).toEqual(['地名风格']);
    // 全部文化的列表还在，还按组分段
    expect(listPage(lib('medieval'), { p: 'list', kind: 'culture' }, ctx)!.sections.length).toBeGreaterThan(5);
    // 只看不在本世界的、只看一组时不列
    expect(listPage(lib('medieval'), { p: 'list', kind: 'culture', group: 'chinese' }, ctx)!.inside).toEqual([]);
  });

  it('一维的卡片融入时仍按组分段；单独成卡时取值组有自己的卡片', () => {
    const flat = copy('flat', splitOut(PRESET_ARRANGE, 'popValue'));
    const ctx = ctxOf(null, [flat]);
    expect(cardIds(lib('flat'), ctx)).toContain('valueGroup');
    expect(cardsOf(lib('flat'), ctx).find((c) => c.id === 'dim:religion')!.contains).toBeUndefined();
    const m = mergeInto(splitOut(PRESET_ARRANGE, 'popValue'), 'popValue', 'valueGroup');
    expect(m.popValue).toBe('valueGroup');
    expect(arrangeTitle('dim:religion')).toBe('取值');
  });
});

describe('时代规则的变量', () => {
  it('每一维有几个取值，点过去到这一维', () => {
    const era = packItems<import('../../../core/human').Era>(medieval, 'eras')[0];
    const v = eraVariables(lib('medieval'), era, ctxOf());
    expect(v[0]).toMatchObject({ id: 'religion', label: '宗教', route: { p: 'list', kind: 'popValue', dim: 'religion' } });
    expect(v[0].count).toBe(packItems<{ dimension: string }>(medieval, 'popValues').filter((x) => x.dimension === 'religion').length);
  });
});
