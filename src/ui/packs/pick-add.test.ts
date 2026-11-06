import { beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../../core/commands';
import { digest, worldDigest } from '../../../core/digest';
import { Engine } from '../../../core/engine';
import { type ResourcePack, packItems } from '../../../core/packs';
import { builtinPacks, worldPartsOf } from '../../../core/packs/builtin-tree';
import { type ImportAsk, importLabel } from '../../../core/packs/closure';
import { newWorldContentCommands, packImportCommands } from '../../../core/packs/import';
import { NO_CURRENTS, engineFor } from '../../../core/testing/fixtures';
import { type LibraryEntry, library } from '../../library';
import { libEdits } from '../../library-edit';
import { addPicked, addRegenButton, contentAfter, worldAddCommand } from './pick-add';
import { pickCount, pickStore, picksOf, setPickDest, togglePickIn } from './pick-store';
import { addRegenLabel } from './regen';
import { regenerateCommand, withPackImports } from '../human';

// 第六十六轮：添加并重新生成（一个 batch，一次撤销全撤）、只勾一个文化时组参与生成

const BUILTIN: LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const ROOTS = BUILTIN.map((e) => ({ key: e.key, pack: e.pack }));
const pack = (id: string) => builtinPacks().find((p) => p.id === id)!;

let bare: Engine;
beforeAll(() => {
  bare = engineFor({ cells: 3000, seed: 2 }, { bare: true });
  bare.exec(NO_CURRENTS);
  bare.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
});

// 用这个库新建世界、生成人文（和 page-world.test.ts 一样）
function worldOf(lib = 'fantasy', more: Record<string, unknown> = { countries: {}, settlements: {} }): Engine {
  const e = bare.clone();
  const root = pack(lib);
  for (const c of newWorldContentCommands(ROOTS, worldPartsOf(lib))) e.exec(c);
  const all = packItems<{ id: string; weight?: number }>(root, 'cultureGroups');
  const groups = all.filter((g) => g.weight !== 0).slice(0, 3).map((g) => ({ id: g.id, weight: 1 }));
  // 和新建向导一样只加选的组（第六十七轮：库里默认不带、世界里比重不是 0 的组参与重新生成）
  for (const c of packImportCommands(ROOTS, { packs: [[lib]], groups: groups.map((g) => g.id) }, e.world)) e.exec(c);
  e.exec({ op: 'generate_human', packs: [[lib]], groups, ...more } as Command);
  e.update();
  return e;
}

const askOf = (e: Engine, from: string, picks: ImportAsk['picks']): ImportAsk => ({ source: pack(from), target: { t: 'world', world: e.world }, picks });
const socialism = [
  { kind: 'government', id: 'socialist-republic' },
  { kind: 'dimension', id: 'ideology' },
];

describe('按钮的名字', () => {
  it('按加了什么：政体是国家，文化是人文；世界没生成过那一样时没有按钮', () => {
    const e = worldOf();
    expect(addRegenButton(askOf(e, 'modern', socialism), BUILTIN)).toBe('添加并重新生成国家');
    expect(addRegenButton(askOf(e, 'medieval', [{ kind: 'culture', id: 'zhili' }]), BUILTIN)).toBe('添加并重新生成人文');
    // 画风：地图按现在的样子画，不用重新生成
    const style = packItems<{ id: string }>(pack('modern'), 'mapStyles')[0];
    if (style) expect(addRegenButton(askOf(e, 'modern', [{ kind: 'mapStyle', id: style.id }]), BUILTIN)).toBeNull();
    expect(addRegenButton(askOf(e, 'modern', []), BUILTIN)).toBeNull();
    expect(addRegenButton(null)).toBeNull();
    // 没有国家：加政体不给按钮
    const noCountries = worldOf('fantasy', {});
    expect(addRegenButton(askOf(noCountries, 'modern', socialism), BUILTIN)).toBeNull();
    // 没有人文：都不给
    expect(addRegenButton(askOf(bare.clone(), 'medieval', [{ kind: 'culture', id: 'zhili' }]), BUILTIN)).toBeNull();
    // 加到库里：没有按钮
    expect(addRegenButton({ ...askOf(e, 'modern', socialism), target: { t: 'pack', pack: { format: 'map2-pack', version: 1, id: 'm', name: 'm' } } }, BUILTIN)).toBeNull();
    expect(addRegenLabel(null)).toBeNull();
    expect(addRegenLabel({ label: '重新生成城市' })).toBe('添加并重新生成城市');
  });
});

describe('添加并重新生成', () => {
  it('加政体并重新生成国家是一步；锁定的国家不动；撤销回到原样，重做、存档重放逐值相同', () => {
    const e = worldOf();
    const locked = Object.values(e.world.small.countries!)[0];
    e.exec({ op: 'set_country', id: locked.id, patch: { locked: true } });
    e.update();
    const cellsOf = (id: number) => [...e.world.causes.country!].flatMap((c, i) => (c === id ? [i] : []));
    const lockedCells = cellsOf(locked.id);
    // 盟友、对手是和别的国家的关系：别的国家重新长了，这两项跟着变（同面板顶上的“重新生成国家”）
    const own = (id: number) => {
      const { allies: _, rivals: __, ...rest } = e.world.small.countries![id];
      return JSON.stringify(rest);
    };
    const lockedItem = own(locked.id);
    const base = worldDigest(e.world);
    const countriesBefore = digest(e.world.causes.country!);
    const steps = e.toDoc().commands.length;

    const r = worldAddCommand(askOf(e, 'modern', socialism), { path: ['modern'], regen: true }, BUILTIN);
    expect(r.regen?.label).toBe('重新生成国家');
    expect(r.command!.label).toBe(`${importLabel(r.preview)}，重新生成国家`);
    expect(r.command!.label).toBe('添加“意识形态”等 19 项，重新生成国家');
    // 第六十七轮：撤销条写用户点的那一项（点社会主义共和国时意识形态是为它一起勾上的）
    expect(worldAddCommand(askOf(e, 'modern', socialism), { path: ['modern'], lead: socialism[0] }, BUILTIN).command!.label).toBe('添加“社会主义共和国”等 19 项');
    expect(r.command!.commands.at(-1)).toMatchObject({ op: 'regenerate_countries' });
    e.exec(r.command!);
    e.update();
    const after = worldDigest(e.world);
    expect(e.toDoc().commands.length).toBe(steps + 1);
    expect(digest(e.world.causes.country!)).not.toBe(countriesBefore);
    expect(e.world.small.content!.government!['socialist-republic']).toBeDefined();
    expect(cellsOf(locked.id)).toEqual(lockedCells);
    expect(own(locked.id)).toBe(lockedItem);

    e.undo();
    e.update();
    expect(worldDigest(e.world)).toBe(base);
    e.redo();
    e.update();
    expect(worldDigest(e.world)).toBe(after);
    const doc = JSON.parse(JSON.stringify(e.toDoc()));
    const replay = Engine.fromDoc(doc, e.world.mesh);
    replay.update();
    expect(worldDigest(replay.world)).toBe(after);
  });

  it('不要重新生成：只添加，地图不变', () => {
    const e = worldOf();
    const countries = digest(e.world.causes.country!);
    const r = worldAddCommand(askOf(e, 'modern', socialism), { path: ['modern'] }, BUILTIN);
    expect(r.regen?.label).toBe('重新生成国家');
    expect(r.command!.commands.some((c) => c.op === 'regenerate_countries')).toBe(false);
    e.exec(r.command!);
    e.update();
    expect(digest(e.world.causes.country!)).toBe(countries);
  });

  it('只勾直隶人：组“汉”比重是来源的值、组里只有直隶人；添加并重新生成人文后地图上有直隶人，一次撤销全撤', () => {
    const e = worldOf();
    const base = worldDigest(e.world);
    const source = pack('medieval');
    const chinese = packItems<{ id: string; weight?: number }>(source, 'cultureGroups').find((g) => g.id === 'chinese')!;
    const r = worldAddCommand(askOf(e, 'medieval', [{ kind: 'culture', id: 'zhili' }]), { path: ['medieval'], regen: true }, BUILTIN);
    expect(r.regen?.label).toBe('重新生成人文');
    e.exec(r.command!);
    e.update();
    const content = e.world.small.content!;
    const group = content.cultureGroup!.chinese as { name: string; weight?: number };
    expect(group.name).toBe('汉');
    expect(group.weight).toBe(chinese.weight);
    expect(Object.values(content.culture!).filter((c) => (c as { group: string }).group === 'chinese').map((c) => (c as { id: string }).id)).toEqual(['zhili']);
    // 重新生成后有人是直隶人
    const pg = e.world.small.popGroups!;
    const codes = new Set(Object.entries(pg).flatMap(([code, g]) => (g.culture === 'zhili' ? [Number(code)] : [])));
    expect(codes.size).toBeGreaterThan(0);
    const c = e.world.causes;
    let share = 0;
    for (let i = 0; i < c.popGroup!.length; i++) if (codes.has(c.popGroup![i])) share += c.popShare![i];
    expect(share).toBeGreaterThan(0);
    e.undo();
    e.update();
    expect(worldDigest(e.world)).toBe(base);
  });
});

// 第六十七轮：组是世界正在用的库里比重 0 的组（这个库默认不带）。勾组里的一个文化，添加并重新生成人文后地图上有它
describe('世界用的库里默认不带的组', () => {
  // 用中世纪新建世界：只加默认带的组（和新建向导一样，比重 0 的组不进世界）
  function medievalWorld(): Engine {
    const e = bare.clone();
    for (const c of newWorldContentCommands(ROOTS, worldPartsOf('medieval'))) e.exec(c);
    const groups = packItems<{ id: string; weight?: number }>(pack('medieval'), 'cultureGroups').filter((g) => g.weight !== 0).map((g) => g.id);
    for (const c of packImportCommands(ROOTS, { packs: [['medieval']], groups }, e.world)) e.exec(c);
    e.exec({ op: 'generate_human', packs: [['medieval']], groups: groups.slice(0, 3).map((id) => ({ id, weight: 1 })), countries: {} } as Command);
    e.update();
    return e;
  }
  const shareOf = (e: Engine, culture: string) => {
    const codes = new Set(Object.entries(e.world.small.popGroups!).flatMap(([code, g]) => (g.culture === culture ? [Number(code)] : [])));
    const c = e.world.causes;
    let share = 0;
    for (let i = 0; i < c.popGroup!.length; i++) if (codes.has(c.popGroup![i])) share += c.popShare![i];
    return share;
  };

  it('勾一个文化：出“添加并重新生成人文”，重新生成后有人是它，一次撤销全撤；下次的重新生成也带着这个组', () => {
    const e = medievalWorld();
    const source = pack('medieval');
    const zero = new Set(packItems<{ id: string; weight?: number }>(source, 'cultureGroups').filter((g) => g.weight === 0).map((g) => g.id));
    const culture = packItems<{ id: string; group: string }>(source, 'cultures').find((c) => zero.has(c.group))!;
    expect(e.world.small.content!.cultureGroup?.[culture.group]).toBeUndefined();
    const base = worldDigest(e.world);
    const ask = askOf(e, 'medieval', [{ kind: 'culture', id: culture.id }]);
    expect(addRegenButton(ask, BUILTIN)).toBe('添加并重新生成人文');
    const r = worldAddCommand(ask, { path: ['medieval'], regen: true }, BUILTIN);
    e.exec(r.command!);
    e.update();
    expect(shareOf(e, culture.id)).toBeGreaterThan(0);
    expect(e.world.small.human!.groups.map((g) => g.id)).toContain(culture.group);
    e.undo();
    e.update();
    expect(worldDigest(e.world)).toBe(base);
    // 只添加、之后点面板顶上的重新生成：组也参与
    e.exec(worldAddCommand(ask, { path: ['medieval'] }, BUILTIN).command!);
    e.update();
    e.exec(regenerateCommand(e.world.small, BUILTIN));
    e.update();
    expect(shareOf(e, culture.id)).toBeGreaterThan(0);
  });

  it('没有这样添加过：重新生成的命令和以前一样（不多带组）', () => {
    const e = medievalWorld();
    expect(regenerateCommand(e.world.small, BUILTIN)).toEqual(withPackImports({ op: 'regenerate_human' }, e.world.small, BUILTIN));
  });
});

describe('添加之后的内容', () => {
  it('只看 set_content，batch 里的都算；原来的不动', () => {
    const before = { culture: { a: { id: 'a' } } } as never;
    const after = contentAfter(before, {
      op: 'batch',
      commands: [
        { op: 'set_content', kind: 'culture', id: 'b', item: { id: 'b' } },
        { op: 'set_content', kind: 'culture', id: 'a', item: null },
        { op: 'regenerate_human' },
      ],
    });
    expect(after).toEqual({ culture: { b: { id: 'b' } } });
    expect(before).toEqual({ culture: { a: { id: 'a' } } });
  });
});

describe('从按库记的勾选添加', () => {
  it('加到我的库：一步，成功后清掉这个库的勾选，别的库的不动', async () => {
    const had = library.value;
    const mine: LibraryEntry = { key: 'pick-add-mine', pack: { format: 'map2-pack', version: 1, id: 'pick-add-mine', name: '我的库' } as ResourcePack, builtin: false, mine: true, installedAt: 1 };
    library.value = [...BUILTIN, mine];
    try {
      const ctx = { world: null, lib: library.value };
      setPickDest({ lib: mine.key });
      togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, ctx);
      togglePickIn('medieval', { kind: 'popValue', id: 'catholic' }, true, ctx);
      const r = await addPicked('modern', ctx);
      expect(r).toMatchObject({ ok: true });
      expect(r.count).toBeGreaterThan(1);
      expect(pickCount('modern')).toBe(0);
      expect(picksOf('medieval').picks).toEqual([{ kind: 'popValue', id: 'catholic' }]);
      const now = library.value.find((e) => e.key === mine.key)!.pack;
      expect(packItems<{ dimension: string }>(now, 'popValues').every((v) => v.dimension === 'ideology')).toBe(true);
      // 勾的是变量：加到库里时它跟着时代来，清单里没有它这一行，写项数（第六十七轮起勾的项在清单里时写它，见 pick-view.test.ts）
      expect(libEdits.undo(mine.key)).toBe(`添加 ${r.count} 项`);
      // 来源或目的地不在了：不动勾选
      togglePickIn('modern', { kind: 'dimension', id: 'ideology' }, true, ctx);
      expect(await addPicked('modern', { world: null, lib: BUILTIN })).toMatchObject({ ok: false });
      expect(pickCount('modern')).toBe(1);
    } finally {
      await libEdits.flushAll();
      libEdits.forget(mine.key);
      library.value = had;
      pickStore.value = { ...pickStore.value, bySource: {}, dest: null };
    }
  });
});
