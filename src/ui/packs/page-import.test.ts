import { afterEach, describe, expect, it } from 'vitest';
import { linkKey } from '../../../core/content/links';
import { itemId, kindOf } from '../../../core/content/registry';
import { type PackNode, type ResourcePack, packItems, packSections } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { importCommand, importGates, importPreview } from '../../../core/packs/closure';
import { continents } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { viewLibrary } from './PackDialog';
import { closeLibrary, libPanel } from './panel-store';
import { packDialog } from './store';
import { type ImportWindow, addBlock, addGates, addRows, addedLine, askOf, chooseFile, chooseFrom, closeImport, defaultFrom, doneLine, importWindow, openImport, otherLibOptions, pickSections, regenLine, removeRow, setPicks, skippedLine, sourceOf, targetOf, togglePick } from './page-import';
import { type LookCtx, basketGroups, filterRows, foldText, hasZeroWeightGroup, initialOpen, refKey, rowLook, rowPath, sectionLook, soleValue, whyText } from './page-import-tree';
import { type PageCtx, type SourceRef, rowsOf } from './page-source';

// 第六十一轮：导入窗口的逻辑（闭包的测试在 core/packs/closure.test.ts）

const PACKS = builtinPacks();
const LIB: LibraryEntry[] = PACKS.map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mine = (id = 'mine'): LibraryEntry => ({ key: id, pack: { format: 'map2-pack', version: 1, id, name: '我的库' } as ResourcePack, builtin: false, mine: true, installedAt: 1 });
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({ world: null, lib: [...LIB, mine()], ...over });
const MINE: SourceRef = { t: 'lib', key: 'mine' };
const st = (): ImportWindow => importWindow.value!;

afterEach(closeImport);

// 只有这个库的时代的世界（没有别的内容）
const eraWorld = (id: string) => {
  const eng = continents();
  const eras = packItems<{ id: string }>(PACKS.find((p) => p.id === id)!, 'eras');
  eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
  return eng;
};

describe('打开', () => {
  it('默认从内置的第一个库，不是目的地自己；勾好一项时展开那一种', () => {
    expect(defaultFrom(MINE, ctx())).toBe('antiquity');
    openImport({ target: MINE, from: 'modern', pick: { kind: 'government', id: 'socialist-republic' } }, ctx());
    expect(st()).toMatchObject({ from: 'modern', picks: [{ kind: 'government', id: 'socialist-republic' }], focus: 'government' });
  });

  it('换来源时清空勾选，下一次默认用它', () => {
    openImport({ target: MINE, pick: { kind: 'government', id: 'x' } }, ctx());
    chooseFrom('fantasy');
    expect(st()).toMatchObject({ from: 'fantasy', picks: [] });
    expect(defaultFrom(MINE, ctx())).toBe('fantasy');
    chooseFrom('antiquity');
  });
});

describe('勾', () => {
  it('勾一项、整组勾；子项去掉、勾回来', () => {
    openImport({ target: MINE, from: 'modern' }, ctx());
    togglePick({ kind: 'government', id: 'a' }, true);
    togglePick({ kind: 'government', id: 'a' }, true);
    expect(st().picks.length).toBe(1);
    setPicks([{ kind: 'government', id: 'a' }, { kind: 'government', id: 'b' }], true);
    expect(st().picks.map((p) => p.id)).toEqual(['a', 'b']);
    setPicks([{ kind: 'government', id: 'a' }, { kind: 'government', id: 'b' }], false);
    expect(st().picks).toEqual([]);
    removeRow({ kind: 'faction', id: 'f' });
    expect(st().off).toEqual([{ kind: 'faction', id: 'f' }]);
    // 取消了的依赖又直接勾上：勾的算数
    togglePick({ kind: 'faction', id: 'f' }, true);
    expect(st().off).toEqual([]);
  });

  it('弹窗里的“查看”：弹窗和导入窗口都关上，面板换到那个库（第六十三轮）', () => {
    openImport({ target: MINE, from: 'modern' }, ctx());
    packDialog.value = { view: 'packs' };
    const had = library.value;
    library.value = [...ctx().lib];
    viewLibrary('modern');
    expect(packDialog.value).toBeNull();
    expect(importWindow.value).toBeNull();
    expect(libPanel.value?.source).toEqual({ t: 'lib', key: 'modern' });
    closeLibrary();
    library.value = had;
  });

  it('太大的文件不读进内存，窗口里说为什么', async () => {
    openImport({ target: MINE, from: 'modern' }, ctx());
    await chooseFile({ name: '大.json', size: 1e9, text: () => Promise.reject(new Error('不该读')) } as unknown as File);
    expect(st().file?.read).toEqual({ ok: false, errors: ['文件太大（1000 MB），不是资源包'] });
  });

  it('来源和目的地：世界没了、库没了时 null', () => {
    openImport({ target: { t: 'world' }, from: 'modern' }, ctx());
    expect(sourceOf(st(), ctx())).toBe(PACKS.find((p) => p.id === 'modern'));
    expect(targetOf(st(), ctx())).toBeNull();
    expect(askOf(st(), ctx())).toBeNull();
    openImport({ target: { t: 'lib', key: 'gone' }, from: 'modern' }, ctx());
    expect(targetOf(st(), ctx())).toBeNull();
  });
});

describe('列哪些', () => {
  const modern = PACKS.find((p) => p.id === 'modern')!;
  it('世界里不列星球形态，库里列；变量一段只有目的地的时代没有的', () => {
    const eng = continents();
    const inWorld = pickSections(modern, { t: 'world', world: eng.world });
    expect(inWorld.some((s) => s.kind === 'planetForm')).toBe(false);
    const fantasy = { ...PACKS.find((p) => p.id === 'fantasy')!, format: 'map2-pack', version: 1 } as ResourcePack;
    const inLib = pickSections(modern, { t: 'pack', pack: fantasy });
    expect(inLib.some((s) => s.kind === 'planetForm')).toBe(true);
    // 每个变量一段（变量是不是已经有了，看每一项的状态）
    expect(inLib.filter((s) => s.head).map((s) => s.head!.id)).toEqual(['religion', 'nation', 'ideology']);
    expect(inLib.map((s) => s.key).slice(0, 3)).toEqual(['era', 'cultureGroup', 'dim:religion']);
    // 同一个来源、目的地不算第二遍
    expect(pickSections(modern, { t: 'pack', pack: fantasy })).toBe(inLib);
  });

  it('下拉里别的库的：这一份里没有的，同 id 列第一个库；放不下这个上级的不列', () => {
    const c = ctx();
    const o = otherLibOptions('faction', { t: 'lib', key: 'modern' }, c);
    expect(o.some((x) => x.id === 'liberals')).toBe(false);
    expect(o.length).toBeGreaterThan(0);
    for (const x of o) expect(x.hint).toBe(PACKS.find((p) => p.id === x.lib)!.name);
    // 法师要种族，现代库没有：灰的不列（第六十五轮）
    expect(o.some((x) => x.id === 'mages')).toBe(false);
    expect(new Set(o.map((x) => x.id)).size).toBe(o.length);
    expect(otherLibOptions('faction', { t: 'lib', key: 'modern' }, c, () => false)).toEqual([]);
    // 灰的不列（第六十五轮）：空的库没有变量，派系靠变量的政体都灰；世界里也一样
    const empty = otherLibOptions('government', MINE, c);
    expect(empty.length).toBeLessThan(30);
    for (const o of empty) expect(importGates(PACKS.find((p) => p.id === o.lib)!, { t: 'pack', pack: mine().pack }).of({ kind: 'government', id: o.id }).t).toBe('free');
    const eng = continents();
    const inWorld = otherLibOptions('government', { t: 'world' }, ctx({ world: eng.world }));
    expect(inWorld.some((o) => o.id === 'socialist-republic')).toBe(false);
    for (const o of inWorld) expect(importGates(PACKS.find((p) => p.id === o.lib)!, { t: 'world', world: eng.world }).of({ kind: 'government', id: o.id }).t).not.toBe('gated');
  });
});

describe('排树', () => {
  const pack = (id: string) => PACKS.find((p) => p.id === id)!;
  const inWorld = () => ({ t: 'world' as const, world: continents().world });

  it('按首页的先后分段：融入的不单独成段，排在上级下面；地标不属于任何组的还有一段', () => {
    const secs = pickSections(pack('medieval'), inWorld());
    const keys = secs.map((s) => s.key);
    expect(keys.indexOf('era')).toBe(0);
    expect(keys.indexOf('cultureGroup')).toBeLessThan(keys.indexOf('dim:religion'));
    expect(keys.indexOf('dim:religion')).toBeLessThan(keys.indexOf('government'));
    expect(keys.indexOf('government')).toBeLessThan(keys.indexOf('countryTier'));
    for (const merged of ['culture', 'faction', 'valueGroup', 'countryLayout', 'variables']) expect(keys, merged).not.toContain(merged);
    // 政体 ▸ 派系；文化组 ▸ 文化；取值组 ▸ 取值；时代 ▸ 变量
    const gov = secs.find((s) => s.key === 'government')!;
    expect(gov.rows.find((r) => (r.item as { factions?: string[] }).factions?.length)!.children[0].kind).toBe('faction');
    const groups = secs.find((s) => s.key === 'cultureGroup')!;
    expect(groups.rows[0].children.some((c) => c.kind === 'culture')).toBe(true);
    const religion = secs.find((s) => s.key === 'dim:religion')!;
    expect(religion.head).toEqual({ kind: 'dimension', id: 'religion' });
    expect(religion.rows[0].kind).toBe('valueGroup');
    expect(religion.rows[0].children[0].kind).toBe('popValue');
    expect(secs[0].rows[0].children.map((c) => [c.kind, c.id])).toEqual([['dimension', 'religion']]);
  });

  it('每一项都在：树里（包括下面的）能找到来源的每一项，一项有几个上级时每处都有', () => {
    for (const source of PACKS) {
      const secs = pickSections(source, { t: 'pack', pack: mine().pack });
      const inTree = new Set(secs.flatMap((s) => s.refs.map(refKey)));
      for (const k of packSections()) {
        for (const x of packItems(source, k.pack.key)) expect(inTree.has(linkKey(k.id, itemId(k, x))), `${source.id} ${k.id} ${itemId(k, x)}`).toBe(true);
      }
    }
    // 一个地名风格写在几个组上（同一项）
    const groups = pickSections(pack('medieval'), inWorld()).find((s) => s.key === 'cultureGroup')!;
    const styles = groups.rows.flatMap((r) => r.children.filter((c) => c.kind === 'nameStyle').map((c) => c.id));
    expect(styles.length).toBeGreaterThan(new Set(styles).size);
  });

  it('库拆开了（arrange 没写）：不融入，单独成段', () => {
    const source = { ...pack('modern'), arrange: { culture: 'cultureGroup' } } as PackNode;
    const secs = pickSections(source, inWorld());
    expect(secs.map((s) => s.key)).toContain('faction');
    expect(secs.find((s) => s.key === 'government')!.rows.every((r) => !r.children.length)).toBe(true);
    expect(secs.map((s) => s.key)).toContain('valueGroup');
  });

  it('散项列在上级后面', () => {
    const source: PackNode = { id: 's', name: 's', governments: [{ id: 'g', name: '政体', factions: ['f'] }], factions: [{ id: 'f', name: '在里面' }, { id: 'x', name: '散的' }] } as never;
    const gov = pickSections(source, inWorld()).find((s) => s.key === 'government')!;
    expect(gov.rows.map((r) => r.id)).toEqual(['g', 'x']);
    expect(gov.rows[0].children.map((c) => c.id)).toEqual(['f']);
  });

  it('搜索：搜到下面的只留搜到的并展开；一开始展开勾好的项所在的地方', () => {
    const secs = pickSections(pack('medieval'), inWorld());
    const groups = secs.find((s) => s.key === 'cultureGroup')!;
    const target = groups.rows.find((r) => r.children.some((c) => c.kind === 'culture'))!.children.find((c) => c.kind === 'culture')!;
    const hit = filterRows(groups.rows, target.name.toLowerCase());
    expect(hit.some((r) => r.opened && r.children.some((c) => c.id === target.id))).toBe(true);
    expect(filterRows(groups.rows, '没有这个名字的文化')).toEqual([]);
    const open = initialOpen(secs, [{ kind: 'culture', id: target.id }]);
    expect([...open.sections]).toEqual(['cultureGroup']);
    const parent = groups.rows.find((r) => r.children.some((c) => c.id === target.id))!;
    expect(open.rows.has(rowPath('cultureGroup', parent))).toBe(true);
  });
});

describe('连带', () => {
  const medieval = PACKS.find((p) => p.id === 'medieval')!;
  // 目的地：科幻的时代（没有宗教、没有基督教组）
  const target = (): { c: PageCtx } => ({ c: ctx({ world: eraWorld('scifi').world }) });
  const rows = (c: PageCtx) => importPreview(askOf(st(), c)!).rows;
  const ids = (c: PageCtx) => rows(c).map((r) => r.id).sort();

  it('× 文化组：连要它的文化一起去掉，什么都不留', () => {
    const { c } = target();
    const culture = packItems<{ id: string; group: string }>(medieval, 'cultures')[0];
    openImport({ target: { t: 'world' }, from: 'medieval', pick: { kind: 'culture', id: culture.id } }, c);
    expect(rows(c).find((r) => r.id === culture.group)).toMatchObject({ role: 'follow' });
    removeRow({ kind: 'cultureGroup', id: culture.group }, c);
    expect(st().picks).toEqual([]);
    expect(st().off).toEqual([]);
    expect(rows(c)).toEqual([]);
    // 不留下 off：再勾这个组里别的文化，组还能跟着来
    const other = packItems<{ id: string; group: string }>(medieval, 'cultures').find((x) => x.group === culture.group && x.id !== culture.id)!;
    togglePick({ kind: 'culture', id: other.id }, true, c);
    expect(ids(c)).toEqual([other.id, culture.group].sort());
  });

  it('× 跟着来的变量：连要它的取值一起去掉；× 勾的取值，变量也不在了', () => {
    const { c } = target();
    const v = { kind: 'popValue', id: 'catholic' };
    openImport({ target: { t: 'world' }, from: 'medieval', pick: v }, c);
    expect(rows(c).map((r) => [r.kind, r.id, r.role])).toEqual(expect.arrayContaining([['dimension', 'religion', 'follow'], ['popValue', 'catholic', 'pick']]));
    removeRow({ kind: 'dimension', id: 'religion' }, c);
    expect([st().picks, st().off, rows(c)]).toEqual([[], [], []]);
    togglePick(v, true, c);
    removeRow(v, c);
    expect(rows(c)).toEqual([]);
  });

  it('去掉变量：要它的政体从勾选里拿掉（取消勾选、× 都一样）', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    const dim = { kind: 'dimension', id: 'ideology' };
    const gov = { kind: 'government', id: 'socialist-republic' };
    openImport({ target: { t: 'world' }, from: 'modern' }, c);
    togglePick(dim, true, c);
    togglePick(gov, true, c);
    expect(rows(c).some((r) => r.id === gov.id)).toBe(true);
    togglePick(dim, false, c);
    expect(st().picks).toEqual([]);
    expect(rows(c)).toEqual([]);
    togglePick(dim, true, c);
    togglePick(gov, true, c);
    removeRow(dim, c);
    expect(st().picks).toEqual([]);
    expect(st().off).toEqual([]);
    expect(importPreview(askOf(st(), c)!).dropped).toEqual([]);
  });

  it('去掉子项：记进 off，名单少这一个；勾回来不多记一笔；取消又勾上级时都回来', () => {
    const eng = eraWorld('medieval');
    const c = ctx({ world: eng.world });
    const gov = packItems<{ id: string; factions?: string[] }>(medieval, 'governments').find((g) => g.factions?.length && importGates(medieval, { t: 'world', world: eng.world }).of({ kind: 'government', id: g.id }).t === 'free')!;
    const govRef = { kind: 'government', id: gov.id };
    const f = { kind: 'faction', id: gov.factions![0] };
    openImport({ target: { t: 'world' }, from: 'medieval', pick: govRef }, c);
    expect(rows(c).find((r) => r.id === f.id)?.role).toBe('child');
    removeRow(f, c);
    expect(st().off).toEqual([f]);
    expect(rows(c).some((r) => r.id === f.id)).toBe(false);
    expect(st().picks).toEqual([govRef]);
    // 勾回来：上级带着，不多记一笔
    togglePick(f, true, c);
    expect([st().picks, st().off]).toEqual([[govRef], []]);
    // 子项也单独勾了、再取消：还在上级下面，去掉
    setPicks([f], true, c);
    togglePick(f, false, c);
    expect([st().picks, st().off]).toEqual([[govRef], [f]]);
    // 取消又勾上级：去掉过的回来
    togglePick(govRef, false, c);
    togglePick(govRef, true, c);
    expect(st().off).toEqual([]);
    expect(rows(c).find((r) => r.id === f.id)?.role).toBe('child');
  });

  it('跟着来的勾上是勾整项；取消后变回跟着来的；整段取消连子项一起', () => {
    const { c } = target();
    const culture = packItems<{ id: string; group: string }>(medieval, 'cultures')[0];
    const group = { kind: 'cultureGroup', id: culture.group };
    openImport({ target: { t: 'world' }, from: 'medieval', pick: { kind: 'culture', id: culture.id } }, c);
    togglePick(group, true, c);
    expect(rows(c).find((r) => r.id === culture.group)!.role).toBe('pick');
    expect(rows(c).filter((r) => r.kind === 'culture').length).toBeGreaterThan(1);
    togglePick(group, false, c);
    expect(rows(c).find((r) => r.id === culture.group)!.role).toBe('follow');
    expect(rows(c).filter((r) => r.kind === 'culture').map((r) => r.id)).toEqual([culture.id]);
    const sec = pickSections(medieval, askOf(st(), c)!.target).find((s) => s.key === 'cultureGroup')!;
    setPicks(sec.refs, false, c);
    expect(rows(c)).toEqual([]);
  });
});

describe('一行的状态', () => {
  const medieval = PACKS.find((p) => p.id === 'medieval')!;
  const lookOf = (c: PageCtx): LookCtx => {
    const p = importPreview(askOf(st(), c)!);
    return { picks: new Set(st().picks.map(refKey)), planned: new Map(p.rows.map((r) => [refKey(r), r])), gates: p.gates, here: '本世界' };
  };
  const world = eraWorld;

  it('勾的、子项、跟着来的、已经有了、灰的', () => {
    const eng = world('scifi');
    const c = ctx({ world: eng.world });
    const culture = packItems<{ id: string; group: string }>(medieval, 'cultures')[0];
    openImport({ target: { t: 'world' }, from: 'medieval', pick: { kind: 'culture', id: culture.id } }, c);
    const look = lookOf(c);
    expect(rowLook({ kind: 'culture', id: culture.id }, look)).toMatchObject({ mark: 'on', picked: true });
    const group = rowLook({ kind: 'cultureGroup', id: culture.group }, look);
    expect(group.mark).toBe('follow');
    expect(group.note).toBe(`${packItems<{ id: string; name: string }>(medieval, 'cultures')[0].name}要它`);
    // 灰的：写原因（这个世界没有宗教）
    expect(rowLook({ kind: 'government', id: 'iqta' }, look)).toMatchObject({ mark: 'grey' });
    expect(rowLook({ kind: 'government', id: 'iqta' }, look).note).toMatch(/^需要/);
    // 变量没有：能勾
    expect(rowLook({ kind: 'dimension', id: 'religion' }, look).mark).toBe('off');
  });

  it('已经有了：✓；同 id 不同内容：写“有一份不同的”；导入的改名不写英文', () => {
    const modern = PACKS.find((p) => p.id === 'modern')!;
    const f = packItems<{ id: string; name: string }>(modern, 'factions')[0];
    const pack = { format: 'map2-pack', version: 1, id: 'm', name: '我的', eras: packItems(modern, 'eras'), factions: [f, { ...packItems<{ id: string; name: string }>(modern, 'factions')[1], name: '改过' }] } as unknown as ResourcePack;
    const entry: LibraryEntry = { key: 'm', pack, builtin: false, mine: true, installedAt: 1 };
    const c: PageCtx = { world: null, lib: [...LIB, entry] };
    openImport({ target: { t: 'lib', key: 'm' }, from: 'modern' }, c);
    const look = { ...lookOf(c), here: '这个库' };
    expect(rowLook({ kind: 'faction', id: f.id }, look).mark).toBe('have');
    const other = packItems<{ id: string }>(modern, 'factions')[1];
    expect(rowLook({ kind: 'faction', id: other.id }, look)).toMatchObject({ mark: 'off', note: '这个库有一份不同的，导入后并存' });
  });

  it('整段：变量那一段勾的是变量；已经有了时勾能选的行；都灰时不能勾', () => {
    const eng = world('fantasy');
    const c = ctx({ world: eng.world });
    openImport({ target: { t: 'world' }, from: 'modern' }, c);
    const secs = pickSections(PACKS.find((p) => p.id === 'modern')!, askOf(st(), c)!.target);
    const ideology = secs.find((s) => s.key === 'dim:ideology')!;
    expect(sectionLook(ideology, lookOf(c))).toMatchObject({ checked: false, mixed: false, disabled: false, acts: [{ kind: 'dimension', id: 'ideology' }] });
    setPicks(sectionLook(ideology, lookOf(c)).acts, true, c);
    expect(sectionLook(ideology, lookOf(c))).toMatchObject({ checked: true, count: ideology.refs.length });
    // 去掉一个取值：半勾
    removeRow(ideology.refs[0], c);
    expect(sectionLook(ideology, lookOf(c))).toMatchObject({ checked: false, mixed: true });
    // 整段勾：去掉的回来
    setPicks(sectionLook(ideology, lookOf(c)).acts, true, c);
    expect(st().off).toEqual([]);
    // 世界有这个变量时（奇幻的宗教）：整段勾的是行
    const religion = secs.find((s) => s.key === 'dim:religion')!;
    const acts = sectionLook(religion, lookOf(c)).acts;
    expect(acts.every((a) => a.kind !== 'dimension')).toBe(true);
  });
});

describe('清单', () => {
  const medieval = PACKS.find((p) => p.id === 'medieval')!;
  const world = eraWorld;

  it('科幻世界勾天主教：变量和取值两项，取值挂在变量下面，写明里面只有它', () => {
    const eng = world('scifi');
    const c = ctx({ world: eng.world });
    openImport({ target: { t: 'world' }, from: 'medieval', pick: { kind: 'popValue', id: 'catholic' } }, c);
    const p = importPreview(askOf(st(), c)!);
    expect(p.count).toBe(2);
    const g = basketGroups(p, medieval);
    expect(g.map((x) => x.title)).toEqual(['变量']);
    expect(g[0].nodes.map((n) => n.row.id)).toEqual(['religion']);
    expect(g[0].nodes[0].children.map((n) => n.row.id)).toEqual(['catholic']);
    expect(soleValue(p, medieval, p.rows.find((r) => r.kind === 'dimension')!)).toBe('天主教');
  });

  it('变量已经有了时小标题写变量的名字；勾整个变量时取值收成一行', () => {
    const eng = world('medieval');
    const c = ctx({ world: eng.world });
    openImport({ target: { t: 'world' }, from: 'antiquity' }, c);
    const value = packItems<{ id: string; name: string; dimension: string }>(PACKS.find((p) => p.id === 'antiquity')!, 'popValues').find((v) => !packItems<{ id: string }>(medieval, 'popValues').some((x) => x.id === v.id))!;
    togglePick({ kind: 'popValue', id: value.id }, true, c);
    const p = importPreview(askOf(st(), c)!);
    expect(basketGroups(p, PACKS.find((x) => x.id === 'antiquity')!).map((x) => x.title)).toContain('宗教');
    const eng2 = world('fantasy');
    const c2 = ctx({ world: eng2.world });
    openImport({ target: { t: 'world' }, from: 'modern', pick: { kind: 'dimension', id: 'ideology' } }, c2);
    const p2 = importPreview(askOf(st(), c2)!);
    const dim = basketGroups(p2, PACKS.find((x) => x.id === 'modern')!)[0].nodes[0];
    expect(foldText(dim.children)).toBe('15 种取值');
    expect(p2.count).toBe(dim.children.length + 1);
  });

  it('跟着来的文化组写一句比重是 0；为什么写在一起', () => {
    const eng = world('scifi');
    const c = ctx({ world: eng.world });
    const culture = packItems<{ id: string }>(medieval, 'cultures')[0];
    openImport({ target: { t: 'world' }, from: 'medieval', pick: { kind: 'culture', id: culture.id } }, c);
    expect(hasZeroWeightGroup(importPreview(askOf(st(), c)!))).toBe(true);
    expect(whyText(['直隶人 要它'])).toBe('直隶人要它');
    expect(whyText(['甲 要它', '乙 要它', '丙 要它'])).toBe('甲、乙 等 3 项要它');
    expect(whyText(['封建君主制 里的'])).toBe('封建君主制里的');
  });
});

describe('重新生成的一句话', () => {
  it('世界有国家时才写；加了变量写加变量的那句', () => {
    const eng = continents();
    const modern = PACKS.find((p) => p.id === 'modern')!;
    const none = importCommand({ source: modern, target: { t: 'world', world: eng.world }, picks: [{ kind: 'mapStyle', id: packItems<{ id: string }>(modern, 'mapStyles')[0].id }] });
    expect(regenLine(none.preview, { t: 'world', world: eng.world })).toBeNull();
    const human = { small: { ...eng.world.small, human: { era: 'x', countryRules: {} } }, causes: eng.world.causes } as never;
    const gov = importCommand({ source: { id: 's', name: 's', countryTiers: [{ id: 'new-tier', name: '新' }] }, target: { t: 'world', world: eng.world }, picks: [{ kind: 'countryTier', id: 'new-tier' }] });
    expect(regenLine(gov.preview, { t: 'world', world: human })).toBe('重新生成国家后才用上');
    expect(regenLine({ ...gov.preview, dims: [{ id: 'd', label: 'd' }] }, { t: 'world', world: human })).toContain('重新生成国家');
    expect(regenLine(gov.preview, { t: 'pack', pack: mine().pack })).toBeNull();
    // 加到已有变量的取值：已有人口不变，重新生成人文才分到人；新变量的取值不写这句
    const eras = packItems<{ id: string }>(PACKS.find((p) => p.id === 'medieval')!, 'eras');
    eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
    const withEra = importCommand({ source: { id: 's', name: 's', popValues: [{ id: 'nv', name: '新', dimension: 'religion' }] } as PackNode, target: { t: 'world', world: eng.world }, picks: [{ kind: 'popValue', id: 'nv' }] });
    expect(regenLine(withEra.preview, { t: 'world', world: human })).toContain('重新生成人文才分到人');
  });
});

describe('列表上的“添加”走同一个闭包，不开窗口', () => {
  const fantasyWorld = () => eraWorld('fantasy');
  const src: SourceRef = { t: 'lib', key: 'modern' };
  const modern = PACKS.find((p) => p.id === 'modern')!;

  it('灰的不开窗口，不动世界，行上写着原因', () => {
    const eng = fantasyWorld();
    const c = ctx({ world: eng.world });
    const row = rowsOf(src, kindOf('government')!, c).find((r) => r.id === 'socialist-republic')!;
    expect(addBlock(addGates(src, c), row)).toBe('需要意识形态');
    const steps = eng.toDoc().commands.length;
    addRows([row], src, c, '添加');
    expect(importWindow.value).toBeNull();
    expect(eng.toDoc().commands.length).toBe(steps);
    // 没有世界、看的不是库：不问
    expect(addGates(src, ctx())).toBeNull();
    expect(addGates({ t: 'world' }, c)).toBeNull();
    expect(addBlock(null, row)).toBeNull();
  });

  it('全部添加的提示：写几项、带上了什么、灰的几项按真实原因写', () => {
    const eng = fantasyWorld();
    const c = ctx({ world: eng.world });
    const target = { t: 'world' as const, world: eng.world };
    const picks = rowsOf(src, kindOf('government')!, c).map((r) => ({ kind: 'government', id: r.id }));
    const p = importPreview({ source: modern, target, picks });
    expect(p.dropped.length).toBeGreaterThan(0);
    expect(p.dropped.length + p.rows.filter((r) => r.role === 'pick').length).toBe(picks.length);
    const line = addedLine(p, modern, target);
    expect(line).toContain(`已添加 ${p.count} 项`);
    expect(line).toContain(`还有 ${p.dropped.length} 项`);
    expect(line).toContain('需要');
    expect(skippedLine([])).toBeNull();
    expect(skippedLine([{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '需要意识形态' }])).toBe('还有 1 项需要意识形态，没加');
    expect(skippedLine([{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '政体最多 3 个' }])).toBe('还有 1 项没加：政体最多 3 个');
    expect(skippedLine([{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '需要意识形态' }, { kind: 'government', id: 'b', name: 'B', kindLabel: '政体', reason: '需要民族认同' }])).toBe('还有 2 项缺别的内容，没加');
    expect(doneLine({ ok: true, count: 2, skipped: [{ kind: 'government', id: 'a', name: 'A', kindLabel: '政体', reason: '需要意识形态' }] }, null)).toBe('已导入 2 项。还有 1 项需要意识形态，没加');
  });

  it('加一个取值、世界里没有这个变量：提示写明里面只有它', () => {
    const eng = eraWorld('scifi');
    const medieval = PACKS.find((p) => p.id === 'medieval')!;
    const target = { t: 'world' as const, world: eng.world };
    const p = importPreview({ source: medieval, target, picks: [{ kind: 'popValue', id: 'catholic' }] });
    const line = addedLine(p, medieval, target);
    expect(line).toContain('已添加 2 项，带上了宗教');
    expect(line).toContain('宗教里面只有天主教，所有人都是它');
  });
});
