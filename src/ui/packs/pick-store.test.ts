import { afterEach, describe, expect, it } from 'vitest';
import { type ResourcePack, packItems } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { importGates, importPreview } from '../../../core/packs/closure';
import { continents } from '../../../core/testing/fixtures';
import type { LibraryEntry } from '../../library';
import { worldEpoch } from '../../state';
import { rowLook } from './page-import-tree';
import type { PageCtx } from './page-source';
import {
  NO_PICKS,
  clearPicks,
  dropFileSource,
  pickCount,
  pickDest,
  pickNeedsIn,
  pickPreview,
  pickStore,
  pickWithNeeds,
  pickedSources,
  picksOf,
  removePickIn,
  setFileSource,
  setPickDest,
  setPicksIn,
  togglePickIn,
} from './pick-store';

// 第六十六轮：按库记的勾选、点灰的行把要的一起勾上（连带的老规则在 page-import.test.ts 里，导入窗口走的是同一套函数）

const PACKS = builtinPacks();
const LIB: LibraryEntry[] = PACKS.map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mine = (id = 'mine'): LibraryEntry => ({ key: id, pack: { format: 'map2-pack', version: 1, id, name: '我的库' } as ResourcePack, builtin: false, mine: true, installedAt: 1 });
const ctx = (over: Partial<PageCtx> = {}): PageCtx => ({ world: null, lib: [...LIB, mine()], ...over });
const pack = (id: string) => PACKS.find((p) => p.id === id)!;

// 只有这个库的时代的世界（没有别的内容）
const eraWorld = (id: string) => {
  const eng = continents();
  const eras = packItems<{ id: string }>(pack(id), 'eras');
  eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
  return eng;
};

afterEach(() => {
  pickStore.value = { epoch: worldEpoch.value, bySource: {}, dest: null };
});

const catholic = { kind: 'popValue', id: 'catholic' };
const ideology = { kind: 'dimension', id: 'ideology' };
const socialism = { kind: 'government', id: 'socialist-republic' };

describe('按库记', () => {
  it('每个库记自己的；换目的地不丢；数得出勾了几项', () => {
    const c = ctx({ world: eraWorld('scifi').world });
    togglePickIn('medieval', catholic, true, c);
    togglePickIn('modern', ideology, true, c);
    expect(picksOf('medieval').picks).toEqual([catholic]);
    expect(picksOf('modern').picks).toEqual([ideology]);
    expect(pickCount('medieval')).toBe(1);
    expect(pickCount('antiquity')).toBe(0);
    expect(pickedSources()).toEqual([
      { key: 'medieval', count: 1 },
      { key: 'modern', count: 1 },
    ]);
    // 目的地：有世界时默认本世界；换到我的库，勾选还在，清单按新的目的地算
    expect(pickDest(c)).toBe('world');
    setPickDest({ lib: 'mine' });
    expect(pickDest(c)).toEqual({ lib: 'mine' });
    expect(pickCount('medieval')).toBe(1);
    expect(pickPreview('medieval', c)!.rows.map((r) => r.id)).toContain('catholic');
    // 我的库没了：回到本世界；没有世界时第一个我的库，也没有我的库时 null
    expect(pickDest(ctx({ world: c.world, lib: LIB }))).toBe('world');
    expect(pickDest(ctx())).toEqual({ lib: 'mine' });
    expect(pickDest({ world: null, lib: LIB })).toBeNull();
    // 不能从一个库加到它自己
    expect(pickPreview('mine', c, { lib: 'mine' })).toBeNull();
  });

  it('清空一个库、清空全部', () => {
    const c = ctx({ world: eraWorld('scifi').world });
    togglePickIn('medieval', catholic, true, c);
    setPicksIn('modern', [ideology, socialism], true, c);
    clearPicks('medieval');
    expect(picksOf('medieval')).toEqual(NO_PICKS);
    expect(pickCount('modern')).toBe(2);
    clearPicks();
    expect(pickedSources()).toEqual([]);
  });

  it('换世界（新建、打开）清掉；同一个世界改了内容不清，目的地留着', () => {
    const eng = eraWorld('scifi');
    const c = ctx({ world: eng.world });
    togglePickIn('medieval', catholic, true, c);
    setPickDest({ lib: 'mine' });
    // 同一个世界改了内容（应用里每次快照都是一个新的世界对象），纪元不变
    const era = packItems<{ id: string }>(pack('scifi'), 'eras')[0];
    eng.exec({ op: 'set_content', kind: 'era', id: era.id, item: { ...era, name: '改过' } as unknown as Record<string, unknown> });
    expect(pickCount('medieval')).toBe(1);
    expect(pickPreview('medieval', { ...c, world: { ...eng.world } })!.rows.map((r) => r.id)).toContain('catholic');
    worldEpoch.value++;
    expect(pickCount('medieval')).toBe(0);
    expect(pickedSources()).toEqual([]);
    expect(pickDest(c)).toEqual({ lib: 'mine' });
    // 接着勾：从空的开始
    togglePickIn('modern', ideology, true, c);
    expect(pickedSources()).toEqual([{ key: 'modern', count: 1 }]);
  });

  it('读进来的文件是一个临时的库：键是 file:名字，去掉时勾选一起没了', () => {
    const src = { format: 'map2-pack', version: 1, id: 'f', name: '文件', cultureGroups: [{ id: 'x', name: '戌', color: '#111111' }] } as ResourcePack;
    const key = setFileSource('甲.json', src);
    expect(key).toBe('file:甲.json');
    const c = ctx({ world: eraWorld('scifi').world });
    togglePickIn(key, { kind: 'cultureGroup', id: 'x' }, true, c);
    expect(pickPreview(key, c)!.rows.map((r) => r.id)).toEqual(['x']);
    dropFileSource(key);
    expect(pickCount(key)).toBe(0);
    expect(pickPreview(key, c)).toBeNull();
  });
});

describe('点灰的行', () => {
  const fantasy = () => ctx({ world: eraWorld('fantasy').world });

  it('现代到奇幻世界：勾社会主义共和国，意识形态一起勾上，清单写“为了社会主义共和国加的”', () => {
    const c = fantasy();
    const p0 = pickPreview('modern', c)!;
    expect(p0.gates.of(socialism)).toMatchObject({ t: 'gated', any: false, resolvable: true, reason: '需要意识形态' });
    // 一行的状态写着能点（第六十七轮的列表用它）
    expect(rowLook(socialism, { picks: new Set(), planned: new Map(), gates: p0.gates, here: '本世界' })).toMatchObject({ mark: 'grey', resolvable: true });
    expect(pickNeedsIn('modern', socialism, c)).toBe(true);
    expect(picksOf('modern').picks).toEqual([socialism, ideology]);
    expect(picksOf('modern').added).toEqual([{ need: ideology, for: socialism }]);
    const p = pickPreview('modern', c)!;
    expect(p.dropped).toEqual([]);
    expect(p.rows.find((r) => r.id === 'socialist-republic')).toMatchObject({ role: 'pick', because: [] });
    expect(p.rows.find((r) => r.id === 'ideology')).toMatchObject({ role: 'pick', because: ['为了社会主义共和国加的'] });
    // 和第六十四轮量到的一样：19 项
    expect(p.count).toBe(19);
  });

  it('去掉意识形态（× 或取消），两个都没；去掉社会主义共和国，为它加的意识形态也没', () => {
    const c = fantasy();
    pickNeedsIn('modern', socialism, c);
    removePickIn('modern', ideology, c);
    expect(picksOf('modern').picks).toEqual([]);
    expect(picksOf('modern').added).toEqual([]);
    expect(pickPreview('modern', c)!.rows).toEqual([]);
    pickNeedsIn('modern', socialism, c);
    togglePickIn('modern', ideology, false, c);
    expect(picksOf('modern').picks).toEqual([]);
    pickNeedsIn('modern', socialism, c);
    togglePickIn('modern', socialism, false, c);
    expect(picksOf('modern')).toMatchObject({ picks: [], added: [] });
    pickNeedsIn('modern', socialism, c);
    removePickIn('modern', socialism, c);
    expect(picksOf('modern').picks).toEqual([]);
    expect(pickPreview('modern', c)!.rows).toEqual([]);
  });

  it('别的勾着的项也要它：去掉 X 时留着；自己勾过的不算为它加的', () => {
    const c = fantasy();
    const world = { t: 'world' as const, world: c.world! };
    const gates = importGates(pack('modern'), world);
    const other = packItems<{ id: string }>(pack('modern'), 'governments')
      .map((g) => ({ kind: 'government', id: g.id }))
      .find((g) => {
        const x = gates.of(g);
        return g.id !== socialism.id && x.t === 'gated' && x.needs.length > 0 && x.needs.every((n) => n.id === 'ideology');
      })!;
    expect(other).toBeDefined();
    pickNeedsIn('modern', socialism, c);
    // 意识形态勾上了，它也能选了：直接勾
    togglePickIn('modern', other, true, c);
    togglePickIn('modern', socialism, false, c);
    expect(picksOf('modern').picks).toEqual([ideology, other]);
    expect(picksOf('modern').added).toEqual([]);
    // 先自己勾了意识形态：后来勾的政体不灰，不记为它加的
    clearPicks();
    togglePickIn('modern', ideology, true, c);
    togglePickIn('modern', socialism, true, c);
    togglePickIn('modern', socialism, false, c);
    expect(picksOf('modern').picks).toEqual([ideology]);
  });

  it('几选一（青铜与古典的草原游牧）：不选不勾；选一个就能勾', () => {
    const c = ctx({ world: eraWorld('medieval').world });
    const steppe = { kind: 'government', id: 'steppe-horde' };
    const g = pickPreview('antiquity', c)!.gates.of(steppe);
    expect(g).toMatchObject({ t: 'gated', any: true, resolvable: true });
    if (g.t !== 'gated') return;
    expect(g.reason).toMatch(/^需要.+或/);
    expect(g.choices.length).toBeGreaterThan(1);
    expect(pickNeedsIn('antiquity', steppe, c)).toBe(false);
    expect(picksOf('antiquity')).toEqual(NO_PICKS);
    const choice = g.choices.find((n) => n.kind === 'culture')!;
    expect(pickNeedsIn('antiquity', steppe, c, choice)).toBe(true);
    expect(picksOf('antiquity').picks).toEqual([steppe, { kind: choice.kind, id: choice.id }]);
    const p = pickPreview('antiquity', c)!;
    expect(p.dropped).toEqual([]);
    expect(p.rows.find((r) => r.id === 'steppe-horde')?.role).toBe('pick');
    expect(p.rows.find((r) => r.id === choice.id)?.because).toEqual(['为了草原游牧加的']);
    // 选的不在几个里面：不勾
    clearPicks();
    expect(pickNeedsIn('antiquity', steppe, c, { kind: 'culture', id: 'nope' })).toBe(false);
  });

  it('要的东西这个来源里没有：resolvable 是 false，点了不动；不灰的照常勾', () => {
    const GOV = { category: ['monarchy'], titles: '王国', size: 1, expansion: 0.3, coastal: 0, urbanization: 1, cohesion: 0.5, vassals: 0.2, nomadic: 0 };
    const src = { format: 'map2-pack', version: 1, id: 's', name: '来源', governments: [{ id: 'g', name: '政体', ...GOV, only: [{ cultureGroups: ['elsewhere'] }] }, { id: 'h', name: '不限', ...GOV }] } as unknown as ResourcePack;
    const key = setFileSource('来源.json', src);
    const c = ctx({ world: eraWorld('scifi').world });
    expect(pickPreview(key, c)!.gates.of({ kind: 'government', id: 'g' })).toMatchObject({ t: 'gated', resolvable: false });
    expect(pickNeedsIn(key, { kind: 'government', id: 'g' }, c)).toBe(false);
    expect(pickCount(key)).toBe(0);
    expect(pickNeedsIn(key, { kind: 'government', id: 'h' }, c)).toBe(true);
    expect(picksOf(key).picks).toEqual([{ kind: 'government', id: 'h' }]);
    dropFileSource(key);
  });

  it('纯函数：导入窗口也用它，勾选原来的对象不动', () => {
    const c = fantasy();
    const ask = { source: pack('modern'), target: { t: 'world' as const, world: c.world! }, picks: [], off: [] };
    const before = { picks: [], off: [], added: [] };
    const next = pickWithNeeds(ask, before, socialism)!;
    expect(before.picks).toEqual([]);
    expect(importPreview({ ...ask, picks: next.picks }).dropped).toEqual([]);
  });
});
