import { afterEach, describe, expect, it } from 'vitest';
import { type ResourcePack, packItems } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { continents } from '../../../core/testing/fixtures';
import { type LibraryEntry, fileLibrary, library } from '../../library';
import { world, worldEpoch } from '../../state';
import { viewLibrary } from './PackDialog';
import { closeFile, openFile, readFileAsPack } from './lib-file';
import { homePage } from './pages';
import type { PageCtx, SourceRef } from './page-source';
import { searchSource } from './page-search';
import { closeLibrary, closeSide, finishPicking, libPanel, libWide, listOf, lookAt, openLibrary, openRoute, rowFlash, setSource, startPicking } from './panel-store';
import { defaultFrom, rememberFrom } from './pick-other';
import { canPick, destFor, pickCount, pickLead, pickStore, picksOf, setPickDest, togglePickIn } from './pick-store';
import { boxOf, cardPicks, kindPickable, lookOf, pickMode, pickView, pressOf, pressRow } from './pick-view';
import { packDialog } from './store';

// 第六十七轮：看库就是添加。资源库面板上一个库的勾选怎么画、点了做什么（组件只照这些画）；两栏、右栏、“去看看”；读文件；下拉里别的库的项直接加

const PACKS = builtinPacks();
const LIB: LibraryEntry[] = PACKS.map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mine = (id = 'mine'): LibraryEntry => ({ key: id, pack: { format: 'map2-pack', version: 1, id, name: '我的库' } as ResourcePack, builtin: false, mine: true, installedAt: 1 });
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({ world: null, lib: [...LIB, mine()], ...over });
const pack = (id: string) => PACKS.find((p) => p.id === id)!;
const lib = (key: string): SourceRef => ({ t: 'lib', key });

const eraWorld = (id: string) => {
  const eng = continents();
  const eras = packItems<{ id: string }>(pack(id), 'eras');
  eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
  return eng;
};

const socialism = { kind: 'government', id: 'socialist-republic' };

afterEach(() => {
  pickStore.value = { epoch: worldEpoch.value, bySource: {}, dest: null };
  libPanel.value = null;
  library.value = LIB;
  world.value = null;
  rowFlash.value = null;
});

describe('哪里能勾', () => {
  it('有世界时任何库都能勾（我的库也是，加到本世界）；没有世界时加到别的我的库；都没有时不出勾', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    expect(destFor('modern', c)).toBe('world');
    expect(destFor('mine', c)).toBe('world');
    // 选的目的地是这个库自己：换成本世界
    setPickDest({ lib: 'mine' });
    expect(destFor('mine', c)).toBe('world');
    expect(destFor('modern', c)).toEqual({ lib: 'mine' });
    // 没有世界：第一个我的库；看的就是它时换成别的我的库，没有别的时不能勾
    const noWorld = ctx();
    expect(destFor('modern', noWorld)).toEqual({ lib: 'mine' });
    expect(canPick('mine', noWorld)).toBe(false);
    expect(destFor('mine', ctx({ lib: [...LIB, mine(), mine('m2')] }))).toEqual({ lib: 'm2' });
    expect(canPick('modern', { world: null, lib: LIB })).toBe(false);
    expect(pickView(lib('modern'), { world: null, lib: LIB })).toBeNull();
    expect(pickView({ t: 'world' }, c)).toBeNull();
  });

  it('同一份勾选只算一遍；勾了就换一份', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    const a = pickView(lib('modern'), c);
    expect(pickView(lib('modern'), c)).toBe(a);
    togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, c);
    const b = pickView(lib('modern'), c)!;
    expect(b).not.toBe(a);
    expect(b.preview.count).toBeGreaterThan(1);
  });

  it('世界里放不进的种类（星球形态）不出勾', () => {
    const v = pickView(lib('modern'), ctx({ world: eraWorld('fantasy').world }))!;
    expect(kindPickable(v, 'planetForm')).toBe(false);
    expect(kindPickable(v, 'government')).toBe(true);
    setPickDest({ lib: 'mine' });
    expect(kindPickable(pickView(lib('modern'), ctx({ world: eraWorld('fantasy').world }))!, 'planetForm')).toBe(true);
  });
});

describe('点一行的勾', () => {
  it('没勾的勾上、勾的取消、子项去掉、跟着来的勾整项；已经有了的不能点', () => {
    const c = ctx({ world: eraWorld('scifi').world });
    const v = () => pickView(lib('medieval'), c)!;
    const culture = packItems<{ id: string; group: string }>(pack('medieval'), 'cultures')[0];
    const ref = { kind: 'culture', id: culture.id };
    expect(pressOf(lookOf(v(), ref))).toEqual({ t: 'on' });
    expect(pressRow('medieval', ref, lookOf(v(), ref), c)).toBe(true);
    expect(boxOf(lookOf(v(), ref))).toEqual({ checked: true, mixed: false, disabled: false });
    const group = { kind: 'cultureGroup', id: culture.group };
    expect(boxOf(lookOf(v(), group))).toMatchObject({ mixed: true });
    expect(pressOf(lookOf(v(), ref))).toEqual({ t: 'off' });
    pressRow('medieval', ref, lookOf(v(), ref), c);
    expect(picksOf('medieval').picks).toEqual([]);
    expect(pressOf({ mark: 'have', picked: false, note: null })).toEqual({ t: 'none' });
    expect(pressOf({ mark: 'child', picked: false, note: null })).toEqual({ t: 'remove' });
    expect(pressOf({ mark: 'grey', picked: false, note: '需要', resolvable: false })).toEqual({ t: 'none' });
    expect(boxOf({ mark: 'grey', picked: false, note: '需要', resolvable: false }).disabled).toBe(true);
  });

  it('灰的能解：点一下把要的一起勾上；撤销条写点的那一项', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    const look = lookOf(pickView(lib('modern'), c)!, socialism);
    expect(look).toMatchObject({ mark: 'grey', resolvable: true });
    expect(pressOf(look)).toEqual({ t: 'needs', choices: [] });
    expect(pressRow('modern', socialism, look, c)).toBe(true);
    expect(picksOf('modern').picks).toEqual(expect.arrayContaining([socialism, { kind: 'dimension', id: 'ideology' }]));
    expect(pickLead(picksOf('modern'))).toEqual(socialism);
  });

  it('几选一：不选不勾（界面弹小菜单），选了就勾', () => {
    const c = ctx({ world: eraWorld('medieval').world });
    const steppe = { kind: 'government', id: 'steppe-horde' };
    const look = lookOf(pickView(lib('antiquity'), c)!, steppe);
    const p = pressOf(look);
    expect(p.t).toBe('needs');
    if (p.t !== 'needs') return;
    expect(p.choices.length).toBeGreaterThan(1);
    expect(pressRow('antiquity', steppe, look, c)).toBe(false);
    expect(pickCount('antiquity')).toBe(0);
    expect(pressRow('antiquity', steppe, look, c, p.choices[0])).toBe(true);
    expect(pickCount('antiquity')).toBe(2);
  });
});

describe('首页', () => {
  it('卡片上写这种勾了几项：融入的子项算在上级的卡片上，变量的卡片算它的取值', () => {
    const c = ctx({ world: eraWorld('fantasy').world });
    togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, c);
    const faction = packItems<{ id: string }>(pack('modern'), 'factions')[0];
    togglePickIn('modern', { kind: 'faction', id: faction.id }, true, c);
    const v = pickView(lib('modern'), c);
    const cards = homePage(lib('modern'), c).sections.flatMap((s) => s.cards);
    const gov = cards.find((x) => x.id === 'government')!;
    expect(gov.kids?.some((k) => k.key === 'faction')).toBe(true);
    expect(cardPicks(gov, v)).toBe(1);
    const dim = cards.find((x) => x.id === 'dim:ideology');
    if (dim) expect(cardPicks(dim, v)).toBe(1);
    expect(cardPicks({ id: 'era', kids: [{ key: 'variables', title: '变量' }] }, v)).toBe(1);
    expect(cardPicks(gov, null)).toBe(0);
  });

  it('搜整个库：每种一段，名字和 id 都搜', () => {
    const c = ctx();
    const hits = searchSource(lib('medieval'), c, '天主');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.flatMap((s) => s.rows.map((r) => r.id))).toContain('catholic');
    expect(searchSource(lib('medieval'), c, 'catholic').flatMap((s) => s.rows.map((r) => r.id))).toContain('catholic');
    expect(searchSource(lib('medieval'), c, '  ')).toEqual([]);
    expect(searchSource(lib('medieval'), c, '没有这个名字')).toEqual([]);
  });
});

describe('两栏', () => {
  // 第八十一轮：只在挑选时（“从别的库添加…”进，“完成”出）有勾、右栏
  it('挑选时：点一项在右栏打开，左栏不动；勾了东西面板变宽；清空、收起右栏后收回；完成回到原来那一份', () => {
    library.value = [...LIB, mine()];
    openLibrary({ entry: 'modern' });
    // 不在挑选：照旧点进去，没有勾
    openRoute({ p: 'item', kind: 'government', id: 'socialist-republic' });
    expect(libPanel.value!.side).toBeUndefined();
    expect(libPanel.value!.stack.length).toBe(2);
    expect(pickMode.value).toBe(false);
    setSource(lib('mine'));
    startPicking(undefined, 'modern');
    expect(pickMode.value).toBe(true);
    expect(libPanel.value!.source).toEqual(lib('modern'));
    openRoute({ p: 'list', kind: 'government' });
    expect(libPanel.value!.stack.length).toBe(2);
    expect(libWide.value).toBe(false);
    openRoute({ p: 'item', kind: 'government', id: 'socialist-republic' });
    expect(libPanel.value!.stack.length).toBe(2);
    expect(libPanel.value!.side).toEqual({ p: 'item', kind: 'government', id: 'socialist-republic' });
    expect(libWide.value).toBe(true);
    closeSide();
    expect(libPanel.value!.side).toBeUndefined();
    expect(libWide.value).toBe(false);
    togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, ctx());
    expect(libWide.value).toBe(true);
    // 换一个库：右栏收起；勾选还在
    openRoute({ p: 'item', kind: 'government', id: 'socialist-republic' });
    setSource(lib('medieval'));
    expect(libPanel.value!.side).toBeUndefined();
    expect(pickCount('modern')).toBe(1);
    expect(libWide.value).toBe(false);
    // 换库还在挑选；完成回到我的库，勾的还记着
    expect(pickMode.value).toBe(true);
    finishPicking();
    expect(libPanel.value!.source).toEqual(lib('mine'));
    expect(pickMode.value).toBe(false);
    expect(pickCount('modern')).toBe(1);
    closeLibrary();
  });

  it('本世界、不能勾的库照旧层层点进去', () => {
    library.value = LIB;
    openLibrary({ entry: 'modern' });
    openRoute({ p: 'item', kind: 'government', id: 'socialist-republic' });
    expect(libPanel.value!.side).toBeUndefined();
    expect(libPanel.value!.stack.at(-1)).toEqual({ p: 'item', kind: 'government', id: 'socialist-republic' });
    closeLibrary();
  });

  it('“去看看”：切到加到的那一份，打开第一个新加项所在的列表，新加的高亮', () => {
    library.value = [...LIB, mine()];
    openLibrary({ entry: 'modern' });
    lookAt(lib('mine'), [{ kind: 'dimension', id: 'ideology' }, socialism]);
    expect(libPanel.value!.source).toEqual(lib('mine'));
    expect(libPanel.value!.stack.at(-1)).toEqual({ p: 'list', kind: 'popValue', dim: 'ideology' });
    expect(rowFlash.value?.kind).toBe('hl');
    expect(rowFlash.value?.keys.has('government:socialist-republic')).toBe(true);
    expect(listOf({ kind: 'nope', id: 'x' })).toBeNull();
    expect(listOf(socialism)).toEqual({ p: 'list', kind: 'government' });
    closeLibrary();
  });
});

describe('从库里添加…', () => {
  it('切到上次用的库；没有时目的地用的库以外第一个内置库；读进来的文件不算', () => {
    const MINE = lib('mine');
    expect(defaultFrom(MINE, ctx())).toBe('antiquity');
    rememberFrom('fantasy');
    expect(defaultFrom(MINE, ctx())).toBe('fantasy');
    rememberFrom('antiquity');
  });
});

describe('读文件', () => {
  it('太大的不读进内存；读不了的弹窗写原因；读得了的是一个临时的库，面板换到它，能勾', async () => {
    expect(await readFileAsPack({ name: '大.json', size: 1e9, text: () => Promise.reject(new Error('不该读')) })).toEqual({ ok: false, errors: ['文件太大（1000 MB），不是资源包'] });
    expect(await openFile({ name: '坏.json', size: 3, text: () => Promise.resolve('{x') })).toBeNull();
    expect(packDialog.value?.view).toBe('import');
    packDialog.value = null;
    library.value = [...LIB, mine()];
    const text = JSON.stringify({ format: 'map2-pack', version: 1, id: 'f', name: '文件里的', cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }] });
    const key = (await openFile({ name: '甲.json', size: text.length, text: () => Promise.resolve(text) }))!;
    expect(key).toBe('file:甲.json');
    expect(fileLibrary.value.map((e) => e.key)).toEqual([key]);
    expect(libPanel.value?.source).toEqual(lib(key));
    // 读不了的那一次打开了弹窗，弹窗会重读资源库：这里自己给库
    expect(canPick(key, { world: null, lib: [...LIB, mine(), ...fileLibrary.value] })).toBe(true);
    closeFile(key);
    expect(fileLibrary.value).toEqual([]);
    closeLibrary();
  });

  it('弹窗里的“查看”：弹窗关上，面板换到那个库', () => {
    packDialog.value = { view: 'packs' };
    library.value = [...ctx().lib];
    viewLibrary('modern');
    expect(packDialog.value).toBeNull();
    expect(libPanel.value?.source).toEqual(lib('modern'));
    closeLibrary();
  });
});
