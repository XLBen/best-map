import { afterEach, describe, expect, it } from 'vitest';
import { relationOf } from '../../../core/content/arrange';
import { type ResourcePack, packItems } from '../../../core/packs';
import { builtinPacks } from '../../../core/packs/builtin-tree';
import { importGates } from '../../../core/packs/closure';
import { continents } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { libEdits } from '../../library-edit';
import { changeNote, worldEpoch } from '../../state';
import { type OtherOpen, hasOther, ontoOf, otherDetail, otherLibs, otherSections, pickFrom, sameOther } from './other-view';
import { addPicked } from './pick-add';
import { pickStore, picksOf, setPickDest, togglePickIn } from './pick-store';
import { pickView } from './pick-view';
import type { PageCtx, SourceRef } from './page-source';
import { closeLibrary, closeOther, libPanel, libWide, openLibrary, setSource, toggleOther } from './panel-store';

// 第六十八轮：“从别的库加”的右栏（other-view.ts）

const PACKS = builtinPacks();
const LIB: LibraryEntry[] = PACKS.map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const mineOf = (id: string, parts: Record<string, unknown> = {}): LibraryEntry => ({ key: id, pack: { format: 'map2-pack', version: 1, id, name: '我的库', ...parts } as ResourcePack, builtin: false, mine: true, installedAt: 1 });
const lib = (key: string): SourceRef => ({ t: 'lib', key });
const rows = (s: ReturnType<typeof otherSections>) => s.flatMap((x) => x.rows);
const RELIGION: OtherOpen = { kind: 'popValue', dim: 'religion', label: '宗教' };
// 用中世纪的时代规则的世界（和 pick-view.test.ts 一样）
const eraWorld = (id: string) => {
  const eng = continents();
  const eras = packItems<{ id: string }>(PACKS.find((p) => p.id === id)!, 'eras');
  eng.exec({ op: 'set_content', kind: 'era', id: eras[0].id, item: eras[0] as unknown as Record<string, unknown> });
  return eng;
};

afterEach(() => {
  pickStore.value = { epoch: worldEpoch.value, bySource: {}, dest: null };
  libPanel.value = null;
  library.value = LIB;
});

describe('来自哪个库', () => {
  it('不列目的地自己；数是可加的（没有、不灰）和这个库勾了几项；没有这一种的库不列', () => {
    const copy = mineOf('m-copy', { popValues: packItems(PACKS.find((p) => p.id === 'medieval')!, 'popValues') });
    const ctx: PageCtx = { world: null, lib: [...LIB, copy] };
    setPickDest({ lib: copy.key });
    const libs = otherLibs(RELIGION, lib(copy.key), ctx);
    expect(libs.map((l) => l.key)).not.toContain(copy.key);
    expect(libs.length).toBeGreaterThan(1);
    for (const l of libs) {
      expect(l.total).toBeGreaterThan(0);
      // 可加的数就是列表上能勾、没勾的行数
      const looks = rows(otherSections(l.key, RELIGION, lib(copy.key), ctx)).map((r) => r.look!);
      expect(looks.length).toBe(l.total);
      expect(looks.filter((x) => x.mark === 'off' || x.mark === 'on').length).toBe(l.can);
      expect(l.picked).toBe(0);
    }
    // 中世纪的宗教都抄进来了：都是 ✓，写“这个库已有”
    const med = rows(otherSections('medieval', RELIGION, lib(copy.key), ctx));
    expect(med.every((r) => r.look!.mark === 'have' && r.look!.note === '这个库已有')).toBe(true);
    expect(libs.find((l) => l.key === 'medieval')!.can).toBe(0);
    // 勾了：已勾 1
    const other = libs.find((l) => l.can > 0)!;
    const first = rows(otherSections(other.key, RELIGION, lib(copy.key), ctx)).find((r) => r.look!.mark === 'off')!;
    togglePickIn(other.key, first.ref, true, ctx);
    expect(otherLibs(RELIGION, lib(copy.key), ctx).find((l) => l.key === other.key)!.picked).toBe(1);
    // 不写 id：名字就是名字，分段按那个库自己的列表
    expect(rows(otherSections(other.key, RELIGION, lib(copy.key), ctx)).every((r) => r.name !== r.ref.id || /[^\x00-\x7f]/.test(r.name))).toBe(true);
  });

  it('打开时看上次用的库；它没有这一种时看第一个有的', () => {
    const ctx: PageCtx = { world: null, lib: [...LIB, mineOf('m')] };
    const libs = otherLibs(RELIGION, lib('m'), ctx);
    expect(libs.some((l) => l.key === pickFrom(libs, lib('m'), ctx))).toBe(true);
    const only = libs.slice(-1);
    expect(pickFrom(only, lib('m'), ctx)).toBe(only[0].key);
    expect(hasOther(RELIGION, lib('m'), ctx)).toBe(true);
    expect(hasOther({ kind: 'popValue', dim: 'no-such-dim' }, lib('m'), ctx)).toBe(false);
  });
});

describe('列表', () => {
  it('本世界：灰的照样列出，写原因；点了能把要的一起勾上；已有的写“本世界已有”', () => {
    const eng = eraWorld('medieval');
    const ctx: PageCtx = { world: eng.world, lib: LIB };
    setPickDest('world');
    const GOV: OtherOpen = { kind: 'government', label: '政体' };
    const all = rows(otherSections('modern', GOV, { t: 'world' }, ctx));
    const soc = all.find((r) => r.ref.id === 'socialist-republic')!;
    expect(importGates(PACKS.find((p) => p.id === 'modern')!, { t: 'world', world: eng.world }).of(soc.ref).t).toBe('gated');
    expect(soc.look).toMatchObject({ mark: 'grey', note: '需要意识形态', resolvable: true });
    const STYLE: OtherOpen = { kind: 'nameStyle', label: '地名风格' };
    const have = LIB.flatMap((e) => rows(otherSections(e.key, STYLE, { t: 'world' }, ctx))).filter((r) => r.look!.mark === 'have');
    expect(have.length).toBeGreaterThan(0);
    for (const r of have) expect(r.look!.note).toBe('本世界已有');
  });

  it('上级页面打开的：放不到这个上级下面的灰着写原因，勾着的照样能取消；添加时只放放得下的', () => {
    const rel = relationOf('popValue', 'valueGroup')!;
    const m = mineOf('m-groups', { valueGroups: [{ id: 'g', dimension: 'religion', name: '我的组', color: '#000000' }] });
    const ctx: PageCtx = { world: null, lib: [...LIB, m] };
    setPickDest({ lib: m.key });
    const o: OtherOpen = { kind: 'popValue', label: '取值', onto: { relation: rel, parent: 'g', title: '我的组' } };
    const all = rows(otherSections('modern', o, lib(m.key), ctx));
    const dimOf = (x: unknown) => (x as { dimension: string }).dimension;
    const out = all.filter((r) => dimOf(r.item) !== 'religion');
    const fit = all.filter((r) => dimOf(r.item) === 'religion');
    expect(out.length).toBeGreaterThan(0);
    expect(fit.length).toBeGreaterThan(0);
    for (const r of out) expect(r.look).toMatchObject({ mark: 'grey', note: '放不到“我的组”下面', resolvable: false });
    for (const r of fit) expect(r.look!.note).not.toBe('放不到“我的组”下面');
    // 先在库里勾了一个放不下的：灰着，但还能取消
    togglePickIn('modern', out[0].ref, true, ctx);
    const again = rows(otherSections('modern', o, lib(m.key), ctx)).find((r) => r.ref.id === out[0].ref.id)!;
    expect(again.look).toMatchObject({ mark: 'grey', picked: true });
    // 添加时只放放得下的（勾了放不下的也不链上）
    const v = pickView(lib('modern'), ctx)!;
    const fitIds = new Set(fit.map((r) => r.ref.id));
    expect((ontoOf(v, o, lib(m.key), ctx)?.children ?? []).every((c) => fitIds.has(c.id))).toBe(true);
  });

  it('换“来自”的库勾的还在；展开写说明和会一起加的', () => {
    const eng = eraWorld('medieval');
    const ctx: PageCtx = { world: eng.world, lib: LIB };
    setPickDest('world');
    const GOV: OtherOpen = { kind: 'government', label: '政体' };
    const soc = rows(otherSections('modern', GOV, { t: 'world' }, ctx)).find((r) => r.ref.id === 'socialist-republic')!;
    const v = pickView(lib('modern'), ctx)!;
    // 灰的：只勾它自己时什么也加不进；勾上意识形态后它会带上派系
    expect(otherDetail(v, soc).along).toEqual([]);
    togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, ctx);
    const free = rows(otherSections('medieval', GOV, { t: 'world' }, ctx)).find((r) => r.look!.mark === 'off')!;
    togglePickIn('medieval', free.ref, true, ctx);
    // 看别的库，再回来：两个库各自的勾都在
    otherSections('fantasy', GOV, { t: 'world' }, ctx);
    expect(picksOf('modern').picks).toEqual([{ kind: 'dimension', id: 'ideology' }]);
    expect(rows(otherSections('medieval', GOV, { t: 'world' }, ctx)).find((r) => r.ref.id === free.ref.id)!.look!.mark).toBe('on');
    const libs = otherLibs(GOV, { t: 'world' }, ctx);
    expect(libs.find((l) => l.key === 'modern')!.picked).toBe(1);
    expect(libs.find((l) => l.key === 'medieval')!.picked).toBe(1);
  });
});

describe('右栏开关', () => {
  it('再点一次收起；换页面、换来源收起；开着时面板两栏；加到的是左栏这一份', () => {
    library.value = [...LIB, mineOf('m-open')];
    openLibrary();
    setSource(lib('m-open'));
    const o: OtherOpen = { kind: 'faction', label: '派系' };
    toggleOther(o);
    expect(sameOther(libPanel.value?.other, o)).toBe(true);
    expect(libWide.value).toBe(true);
    expect(pickStore.value.dest).toEqual({ lib: 'm-open' });
    toggleOther(o);
    expect(libPanel.value?.other ?? null).toBeNull();
    toggleOther(o);
    closeOther();
    expect(libPanel.value?.other ?? null).toBeNull();
    toggleOther(o);
    setSource(lib('modern'));
    expect(libPanel.value?.other ?? null).toBeNull();
    closeLibrary();
  });
});

describe('添加', () => {
  it('加到我的库：一步，撤销条写点的那一项，不带“去看看”；上级页面打开的两项都放到上级下面，一次撤销全撤', async () => {
    const rel = relationOf('popValue', 'valueGroup')!;
    const m = mineOf('m-add', {
      eras: [{ id: 'e', name: '时代', dimensions: [{ id: 'religion', label: '宗教' }], popDensity: 2, sparsity: 1.5, urbanization: 0.1, unclaimed: { minHabitability: 0.05, nomads: 0.3 }, seaClaimKm: 0 }],
      valueGroups: [{ id: 'g', dimension: 'religion', name: '我的组', color: '#000000' }],
    });
    library.value = [...LIB, m];
    try {
      const ctx: PageCtx = { world: null, lib: library.value };
      setPickDest({ lib: m.key });
      const o: OtherOpen = { kind: 'popValue', dim: 'religion', label: '宗教', onto: { relation: rel, parent: 'g', title: '我的组' } };
      const free = rows(otherSections('medieval', o, lib(m.key), ctx)).filter((r) => r.look!.mark === 'off').slice(0, 2);
      expect(free.length).toBe(2);
      for (const r of free) togglePickIn('medieval', r.ref, true, ctx);
      const v = pickView(lib('medieval'), ctx)!;
      const onto = ontoOf(v, o, lib(m.key), ctx)!;
      expect(onto.children.map((c) => c.id).sort()).toEqual(free.map((r) => r.ref.id).sort());
      const r = await addPicked('medieval', ctx, { onto });
      expect(r).toMatchObject({ ok: true });
      const now = library.value.find((e) => e.key === m.key)!.pack;
      const vals = packItems<{ id: string; group?: string }>(now, 'popValues');
      for (const x of free) expect(vals.find((y) => y.id === x.ref.id)?.group).toBe('g');
      expect(changeNote.value?.action).toBeUndefined();
      expect(changeNote.value?.undo).toBeDefined();
      libEdits.undo(m.key);
      expect(packItems(library.value.find((e) => e.key === m.key)!.pack, 'popValues')).toEqual([]);
    } finally {
      await libEdits.flushAll();
      libEdits.forget(m.key);
      changeNote.value = null;
    }
  });
});
