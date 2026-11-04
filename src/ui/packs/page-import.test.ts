import { afterEach, describe, expect, it } from 'vitest';
import { kindOf } from '../../../core/content/registry';
import { type ResourcePack, packItems } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { importCommand, importPreview } from '../../../core/packs/closure';
import { continents } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { type ImportWindow, addRows, askOf, chooseFrom, closeImport, defaultFrom, hereState, importWindow, openImport, otherLibOptions, pickSections, regenLine, setPicks, sourceOf, targetOf, toggleDep, toggleOptional, togglePick } from './page-import';
import { type PageCtx, type SourceRef, rowsOf } from './page-source';

// 第六十一轮：导入窗口的逻辑（闭包的测试在 core/packs/closure.test.ts）

const PACKS = builtinPacks();
const LIB: LibraryEntry[] = PACKS.map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mine = (id = 'mine'): LibraryEntry => ({ key: id, pack: { format: 'map2-pack', version: 1, id, name: '我的库' } as ResourcePack, builtin: false, mine: true, installedAt: 1 });
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({ world: null, lib: [...LIB, mine()], ...over });
const MINE: SourceRef = { t: 'lib', key: 'mine' };
const st = (): ImportWindow => importWindow.value!;

afterEach(closeImport);

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
  it('勾一项、整组勾；依赖取消、勾回来；可选的勾上', () => {
    openImport({ target: MINE, from: 'modern' }, ctx());
    togglePick({ kind: 'government', id: 'a' }, true);
    togglePick({ kind: 'government', id: 'a' }, true);
    expect(st().picks.length).toBe(1);
    setPicks([{ kind: 'government', id: 'a' }, { kind: 'government', id: 'b' }], true);
    expect(st().picks.map((p) => p.id)).toEqual(['a', 'b']);
    setPicks([{ kind: 'government', id: 'a' }, { kind: 'government', id: 'b' }], false);
    expect(st().picks).toEqual([]);
    toggleDep({ kind: 'faction', id: 'f' }, false);
    expect(st().off).toEqual([{ kind: 'faction', id: 'f' }]);
    // 取消了的依赖又直接勾上：勾的算数
    togglePick({ kind: 'faction', id: 'f' }, true);
    expect(st().off).toEqual([]);
    toggleOptional({ kind: 'dimension', id: 'nation' }, true);
    expect(st().on).toEqual([{ kind: 'dimension', id: 'nation' }]);
    toggleOptional({ kind: 'dimension', id: 'nation' }, false);
    expect(st().on).toEqual([]);
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
    expect(inLib.find((s) => s.kind === 'dimension')!.rows.map((r) => r.id).sort()).toEqual(['ideology', 'nation']);
    expect(inLib.map((s) => s.kind).slice(0, 3)).toEqual(['era', 'cultureGroup', 'culture']);
    // 同一个来源、目的地不算第二遍
    expect(pickSections(modern, { t: 'pack', pack: fantasy })).toBe(inLib);
  });

  it('行上写目的地有没有：一模一样的、同 id 不同内容的', () => {
    const target = { t: 'pack' as const, pack: { format: 'map2-pack', version: 1, id: 't', name: 't', factions: [{ id: 'liberals', name: '我的', color: '#000000', amount: 1 }, packItems<{ id: string }>(modern, 'factions').find((f) => f.id === 'greens')] } as ResourcePack };
    const rows = pickSections(modern, target).find((s) => s.kind === 'faction')!.rows;
    expect(hereState(rows.find((r) => r.id === 'greens')!, target)).toBe('same');
    expect(hereState(rows.find((r) => r.id === 'liberals')!, target)).toBe('differs');
    expect(hereState(rows.find((r) => r.id === 'nationalists')!, target)).toBeNull();
  });

  it('下拉里别的库的：这一份里没有的，同 id 列第一个库；放不下这个上级的不列', () => {
    const c = ctx();
    const o = otherLibOptions('faction', { t: 'lib', key: 'modern' }, c);
    expect(o.some((x) => x.id === 'liberals')).toBe(false);
    expect(o.find((x) => x.id === 'mages')).toMatchObject({ lib: 'fantasy', hint: '奇幻' });
    expect(new Set(o.map((x) => x.id)).size).toBe(o.length);
    expect(otherLibOptions('faction', { t: 'lib', key: 'modern' }, c, () => false)).toEqual([]);
    // 空的库：内置的都能选
    expect(otherLibOptions('government', MINE, c).length).toBeGreaterThan(30);
  });
});

describe('重新生成的一句话', () => {
  it('世界有国家时才写；加了变量写加变量的那句', () => {
    const eng = continents();
    const modern = PACKS.find((p) => p.id === 'modern')!;
    const none = importCommand({ source: modern, target: { t: 'world', world: eng.world }, picks: [{ kind: 'mapStyle', id: packItems<{ id: string }>(modern, 'mapStyles')[0].id }] });
    expect(regenLine(none.preview, { t: 'world', world: eng.world })).toBeNull();
    const human = { small: { ...eng.world.small, human: { era: 'x', countryRules: {} } }, causes: eng.world.causes } as never;
    const gov = importCommand({ source: modern, target: { t: 'world', world: eng.world }, picks: [{ kind: 'faction', id: 'greens' }], off: [{ kind: 'dimension', id: 'ideology' }, { kind: 'era', id: 'modern' }] });
    expect(regenLine(gov.preview, { t: 'world', world: human })).toBe('重新生成国家后才用上');
    expect(regenLine({ ...gov.preview, dims: [{ id: 'd', label: 'd' }] }, { t: 'world', world: human })).toContain('重新生成国家');
    expect(regenLine(gov.preview, { t: 'pack', pack: mine().pack })).toBeNull();
  });
});

describe('列表上的“添加”走同一个闭包', () => {
  it('要加变量时先打开窗口，勾好这几项（不直接动世界）', () => {
    const eng = continents();
    const eras = packItems<{ id: string }>(PACKS.find((p) => p.id === 'fantasy')!, 'eras');
    eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
    const c = ctx({ world: eng.world });
    const src: SourceRef = { t: 'lib', key: 'modern' };
    const row = rowsOf(src, kindOf('government')!, c).find((r) => r.id === 'socialist-republic')!;
    const steps = eng.toDoc().commands.length;
    addRows([row], src, c, '添加');
    expect(st()).toMatchObject({ target: { t: 'world' }, from: 'modern', picks: [{ kind: 'government', id: 'socialist-republic' }], focus: 'government' });
    expect(eng.toDoc().commands.length).toBe(steps);
    // 窗口里算的和单独加一项一样：派系、变量都带
    const p = importPreview(askOf(st(), c)!);
    expect(p.bring.map((r) => r.id).sort()).toEqual(['ideology', 'liberals', 'revolutionary-left']);
  });
});
