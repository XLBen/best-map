import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../../core/commands';
import { kindOf } from '../../../core/content/registry';
import { PACK_FORMAT, PACK_VERSION, readPack } from '../../../core/packs';
import { DEFAULT_SPECIES } from '../../../core/packs/nature';
import { ALPINE_LOW, CONDITIONS, type ConditionId, HEIGHT_MAX, type HeightRange, type Rect, type Species, type Tolerance, advancedTolerances, withCondition, withRect } from '../../../core/species';
import { continents } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import type { LibraryEntry } from '../../library';
import type { PageCtx } from '../packs/page-source';

// 第七十二轮：生态抽屉和资源库的通用表单合成一个编辑器。这里查：
//   - 同样的改动，补丁、命令和以前的生态抽屉一样（下面“以前的写法”是从 ClimateChart.tsx 原样抄来的，不要改它）；
//   - 本世界里发 update_species（立即的走 exec，排队的走 queueSpeciesEdit），我的库里和以前的表单一样换掉一项（commitItem）；
//   - “导出”写资源包，读得回来

const execs: [Command, string | undefined][] = [];
const queued: [string, string, (cur: Species) => Record<string, unknown> | null][] = [];
const commits: { key: string | null; kind: string; id: string; next: unknown }[] = [];
let ctx: PageCtx = { world: null, lib: [] };

vi.mock('../../state', async (orig) => ({
  ...(await orig<typeof import('../../state')>()),
  exec: async (cmd: Command, label?: string) => {
    execs.push([cmd, label]);
    return true;
  },
}));
vi.mock('./species-scripts', () => ({
  queueSpeciesEdit: async (id: string, label: string, make: (cur: Species) => Record<string, unknown> | null) => {
    queued.push([id, label, make]);
    return true;
  },
}));
vi.mock('../packs/page-actions', () => ({
  commitItem: (src: { t: string; key?: string }, kind: { id: string }, id: string, next: unknown) => {
    commits.push({ key: src.t === 'lib' ? src.key! : null, kind: kind.id, id, next });
    return 'saved';
  },
}));
vi.mock('../packs/panel-store', () => ({ pageCtx: () => ctx }));

const { alpinePatch, applyPatch, biomesPack, conditionPatch, copySpeciesCommand, elevationPatch, heightPatch, newSpeciesCommand, rectPatch, shownTolerances, tolerancesPatch } = await import('./biome-edit');
const { biomeTarget } = await import('./biome-target');

// ---------- 以前的写法（ClimateChart.tsx，第七十一轮），不要改它 ----------
const OLD = {
  rect: (sp: Species, rect: Rect): Command => ({ op: 'update_species', id: sp.id, patch: { tolerances: withRect(sp, rect).tolerances } }),
  cond: (sp: Species, id: ConditionId, on: boolean): Command => ({ op: 'update_species', id: sp.id, patch: { tolerances: withCondition(sp, id, on).tolerances } }),
  height: (sp: Species, h: HeightRange): Command => ({ op: 'update_species', id: sp.id, patch: { height: h.low <= 0 && h.high >= HEIGHT_MAX ? null : h } }),
  tolerances: (sp: Species, next: Tolerance[]): Command => {
    const tols = advancedTolerances(sp);
    const others = sp.tolerances.filter((t) => !tols.includes(t));
    return { op: 'update_species', id: sp.id, patch: { tolerances: [...others, ...next] } };
  },
  addNew: (w: World): Command => {
    const PALETTE = ['#8a6fb0', '#c0607a', '#4f9fb0', '#b08a3a', '#6aa050', '#d07a40', '#5a70c0', '#a05a9a'];
    let k = w.small.species.length + 1;
    let id = `custom_${k}`;
    while (w.small.species.some((s) => s.id === id)) id = `custom_${++k}`;
    const base: Species = { id, name: `新生态 ${k}`, color: PALETTE[k % PALETTE.length], terrain: 'plains', competition: 3, tolerances: [], natural: false };
    return { op: 'add_species', species: withRect(base, { t0: 5, t1: 18, m0: 0.6, m1: 1.6 }) };
  },
  copy: (w: World, sp: Species): Command => {
    let id = `${sp.id}_copy`;
    for (let k = 2; w.small.species.some((s) => s.id === id); k++) id = `${sp.id}_copy${k}`;
    return { op: 'add_species', species: { ...structuredClone(sp), id, name: `${sp.name}（副本）`, natural: false } };
  },
};

const w = continents({ cells: 3000 }).world as World;
const taiga = structuredClone(w.small.species.find((s) => s.id === 'taiga')!);
const upd = (sp: Species, patch: Record<string, unknown>): Command => ({ op: 'update_species', id: sp.id, patch });

beforeEach(() => {
  execs.length = 0;
  queued.length = 0;
  commits.length = 0;
});

describe('补丁和以前的生态抽屉一样', () => {
  it('气候图、只长在……、雨季、高度范围、更精细的条件', () => {
    for (const r of [
      { t0: -5, t1: 10, m0: 0.4, m1: 2 },
      { t0: -40, t1: 40, m0: 0, m1: 50 },
    ])
      expect(upd(taiga, rectPatch(taiga, r))).toEqual(OLD.rect(taiga, r));
    for (const id of Object.keys(CONDITIONS) as ConditionId[]) for (const on of [true, false]) expect(upd(taiga, conditionPatch(taiga, id, on))).toEqual(OLD.cond(taiga, id, on));
    for (const h of [
      { low: 0, high: HEIGHT_MAX },
      { low: 300, high: 2400 },
      { low: 0, high: 1200 },
    ])
      expect(upd(taiga, heightPatch(h))).toEqual(OLD.height(taiga, h));
    const extra: Tolerance = { field: 'slope', min: 0, optLow: 0, optHigh: 3, max: 6 };
    const withExtra = { ...taiga, tolerances: [...taiga.tolerances, extra] };
    expect(shownTolerances(withExtra)).toEqual(advancedTolerances(withExtra));
    for (const next of [[], [extra, { ...extra, field: 'precip' }]]) expect(upd(withExtra, tolerancesPatch(withExtra, next))).toEqual(OLD.tolerances(withExtra, next));
  });

  it('新建、复制', () => {
    expect(newSpeciesCommand(w).cmd).toEqual(OLD.addNew(w));
    expect(copySpeciesCommand(w, taiga).cmd).toEqual(OLD.copy(w, taiga));
  });

  it('“只长在高山上”只动高度范围的下限；海拔条件不再单独列', () => {
    expect(alpinePatch({})).toEqual({ height: { low: ALPINE_LOW, high: HEIGHT_MAX } });
    expect(alpinePatch({ height: { low: ALPINE_LOW, high: 3000 } })).toEqual({ height: { low: 0, high: 3000 } });
    expect(alpinePatch({ height: { low: 0, high: 800 } })).toEqual({ height: { low: ALPINE_LOW, high: ALPINE_LOW } });
    const old = { ...taiga, tolerances: [...taiga.tolerances, CONDITIONS.mountain.tol(), { field: 'elevation', min: 0, optLow: 0, optHigh: 2000, max: 3000 }] };
    expect(shownTolerances(old).some((t) => t.field === 'elevation')).toBe(false);
    // 改别的条件时海拔条件照样留着
    expect((tolerancesPatch(old, []).tolerances as Tolerance[]).filter((t) => t.field === 'elevation')).toHaveLength(2);
    // “换成高度范围”（用户点了才换）
    const { height: _, ...noHeight } = old;
    expect(elevationPatch(noHeight as Species)).toEqual({ tolerances: taiga.tolerances, height: { low: ALPINE_LOW, high: 2000 } });
    expect(elevationPatch(old)).toEqual({ tolerances: taiga.tolerances });
  });
});

describe('存到哪里', () => {
  it('本世界：立即的是 update_species（exec），排队的按最新的样子做补丁（queueSpeciesEdit）', async () => {
    ctx = { world: w, lib: [] };
    const t = biomeTarget({ t: 'world' }, ctx);
    expect(t.inWorld).toBe(true);
    expect(t.all).toBe(w.small.species);
    await t.edit('taiga', heightPatch({ low: 200, high: 1800 }), '正在计算…');
    await t.edit('taiga', { name: '泰加' });
    expect(execs).toEqual([
      [OLD.height(taiga, { low: 200, high: 1800 }), '正在计算…'],
      [{ op: 'update_species', id: 'taiga', patch: { name: '泰加' } }, undefined],
    ]);
    const make = () => ({ visual: null });
    await t.queue('taiga', '正在计算…', make);
    expect(queued).toEqual([['taiga', '正在计算…', make]]);
    expect(commits).toEqual([]);
  });

  it('我的库：补丁落到那一项上整项换掉，和以前的表单一样（null 去掉这个字段）', async () => {
    const lib = { key: 'mine', mine: true, builtin: false, pack: { format: PACK_FORMAT, version: PACK_VERSION, id: 'mine', name: '我的库', biomes: [taiga] } } as unknown as LibraryEntry;
    ctx = { world: w, lib: [lib] };
    const t = biomeTarget({ t: 'lib', key: 'mine' }, ctx);
    expect([t.inWorld, t.readonly]).toEqual([false, null]);
    await t.edit('taiga', { competition: 4.5 });
    await t.edit('taiga', heightPatch({ low: 0, high: HEIGHT_MAX }));
    await t.queue('taiga', '正在计算…', () => ({ visual: { pattern: 'spots' } }));
    expect(execs).toEqual([]);
    expect(commits).toEqual([
      { key: 'mine', kind: 'biome', id: 'taiga', next: { ...taiga, competition: 4.5 } },
      { key: 'mine', kind: 'biome', id: 'taiga', next: (({ height: _, ...rest }) => rest)(taiga) },
      { key: 'mine', kind: 'biome', id: 'taiga', next: { ...taiga, visual: { pattern: 'spots' } } },
    ]);
    expect(applyPatch(taiga, { natural: null, color: '#123456' })).toEqual((({ natural: _, ...rest }) => ({ ...rest, color: '#123456' }))(taiga));
  });

  it('内置的库只读：什么都不存', async () => {
    const lib = { key: 'b', builtin: true, pack: { format: PACK_FORMAT, version: PACK_VERSION, id: 'b', name: '内置', biomes: [taiga] } } as unknown as LibraryEntry;
    ctx = { world: w, lib: [lib] };
    const t = biomeTarget({ t: 'lib', key: 'b' }, ctx);
    expect(t.readonly).toBeTruthy();
    expect(await t.edit('taiga', { competition: 2 })).toBe(false);
    expect(await t.replace('taiga', { ...taiga } as never)).toBe(false);
    expect(commits).toEqual([]);
  });
});

describe('导出', () => {
  it('写资源包（不再是裸的生态数组），读得回来：世界里的写明自然生成', () => {
    const pack = biomesPack('本世界的生态', w.small.species, true);
    expect(Array.isArray(pack)).toBe(false);
    expect(pack.format).toBe(PACK_FORMAT);
    const r = readPack(JSON.stringify(pack, null, 2));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const exportItem = kindOf('biome')!.pack.exportItem!;
    expect(r.pack.biomes).toEqual(w.small.species.map((s) => exportItem(s)));
    expect(r.pack.biomes!.every((b) => b.natural !== undefined)).toBe(true);
    expect(r.pack.biomes!.map((b) => b.id)).toEqual(DEFAULT_SPECIES.map((s) => s.id));
  });

  it('库里的原样导出', () => {
    const own = { ...taiga, id: 'mine', natural: undefined };
    const r = readPack(JSON.stringify(biomesPack('生态', [own], false)));
    expect(r.ok && r.pack.biomes).toEqual([JSON.parse(JSON.stringify(own))]);
  });
});
