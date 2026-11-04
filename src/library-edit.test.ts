import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { itemId, kindOf } from '../core/content/registry';
import { type ResourcePack, packItems, parsePack, walkPacks } from '../core/packs';
import { builtinPacks, worldPartsOf } from '../core/packs/builtin-tree';
import { packImportCommands } from '../core/packs/import';
import { type LibraryEntry, type Stored, installPack, library, refreshLibrary } from './library';
import { FLUSH_MS, FLUSH_SOON_MS, type LibBackend, type Wal, copiedPack, copyLibrary, createLibEditor, createLibrary, deleteLibrary, libEdits } from './library-edit';
import { Engine } from '../core/engine';
import { humanDigest, meshFor } from '../core/testing/fixtures';
import { newWorldCommands } from './ui/forms';
import { chooseLibrary, defaultChoice, generateCommand } from './ui/human';
import { isLibrary, libRoots, libraryOptions, worldContentCommands, worldContentPacks, worldLibrary } from './ui/packChoice';
import { closeLibrary, openLibrary, setSource } from './ui/packs/panel-store';

// 第五十九轮：我的库改一项只查这一项、写进日志，整个库晚一点才写；有自己的撤销；复制成我的库

const pack = (): ResourcePack => ({
  format: 'map2-pack',
  version: 1,
  id: 'mine',
  name: '我的库',
  packs: [
    { id: 'a', name: 'A', cultureGroups: [{ id: 'g', name: '组', color: '#112233' }], cultures: [{ id: 'c1', group: 'g', name: '一', color: '#111111' }] },
    { id: 'b', name: 'B', cultures: [{ id: 'c2', group: 'g', name: '二', color: '#222222' }] },
    // 同一项在两个小包里
    { id: 'marks', name: '地标', resources: [] },
  ],
});

// 假的存储：put 记下写了什么，日志在一张表里；“刷新页面”就是用同一个存储新建一个编辑器
function fakeBackend() {
  const packs = new Map<string, Stored>();
  const wal = new Map<string, Wal>();
  const puts: Stored[] = [];
  const backend: LibBackend = {
    put: async (rec) => {
      puts.push(rec);
      packs.set(rec.key, rec);
      return true;
    },
    walRead: (key) => wal.get(key) ?? null,
    walWrite: (key, w) => {
      if (w) wal.set(key, JSON.parse(JSON.stringify(w)) as Wal);
      else wal.delete(key);
      return true;
    },
  };
  return { backend, packs, wal, puts };
}

function setup(start: ResourcePack = pack()) {
  const store = fakeBackend();
  let list: LibraryEntry[] = [{ key: 'mine', pack: start, builtin: false, mine: true, installedAt: 1 }];
  const ed = createLibEditor(store.backend, {
    entries: () => list,
    publish: (key, p) => {
      list = list.map((e) => (e.key === key ? { ...e, pack: p } : e));
    },
  });
  return { ...store, ed, cur: () => list[0].pack };
}

const culture = (p: ResourcePack, id: string) => packItems<{ id: string; name: string }>(p, 'cultures').find((c) => c.id === id);
const c1 = { id: 'c1', group: 'g', name: '改过', color: '#111111' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('改一项：只查这一项，延迟写入', () => {
  it('内存里马上变，日志马上有；整个库停手之后才写一次', async () => {
    const { ed, cur, wal, puts } = setup();
    expect(ed.setItem('mine', 'culture', 'c1', c1)).toEqual({ ok: true });
    expect(culture(cur(), 'c1')!.name).toBe('改过');
    expect(wal.get('mine')!.ops.map((o) => o.id)).toEqual(['c1']);
    expect(puts.length).toBe(0);
    // 连着改几下，还是一次
    ed.setItem('mine', 'culture', 'c1', { ...c1, name: '再改' });
    ed.setItem('mine', 'culture', 'c2', { id: 'c2', group: 'g', name: '二改', color: '#222222' });
    expect(wal.get('mine')!.ops.length).toBe(2);
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
    expect(puts.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(puts.length).toBe(1);
    expect(culture(puts[0].pack, 'c1')!.name).toBe('再改');
    // 写完去掉日志
    expect(wal.has('mine')).toBe(false);
    expect(ed.isDirty('mine')).toBe(false);
  });

  it('只换这一项到树根的路，别的小包是同一个对象（所以不用整库 parsePack，撤销也不占地方）', () => {
    const { ed, cur } = setup();
    const before = cur();
    ed.setItem('mine', 'culture', 'c1', c1);
    const after = cur();
    expect(after).not.toBe(before);
    expect(after.packs![0]).not.toBe(before.packs![0]);
    expect(after.packs![1]).toBe(before.packs![1]);
    expect(after.packs![2]).toBe(before.packs![2]);
  });

  it('不合格式的不改，说为什么；和现在一样的不算一步', () => {
    const { ed, cur } = setup();
    const before = cur();
    const bad = ed.setItem('mine', 'culture', 'c1', { ...c1, color: 'red' });
    expect(bad.ok).toBe(false);
    expect(cur()).toBe(before);
    expect(ed.setItem('mine', 'culture', 'c1', culture(before, 'c1'))).toEqual({ ok: true, noop: true });
    expect(ed.canUndo('mine')).toBe(false);
  });

  it('同一项在几个小包里：每一处都换', () => {
    const shared = { id: 'r', name: '铁', color: '#333333', category: 'ore', rules: [], rarity: 0.1, weight: 1, cluster: 300 };
    const start: ResourcePack = { format: 'map2-pack', version: 1, id: 'mine', name: 'x', packs: [{ id: 'a', name: 'A', resources: [shared] }, { id: 'b', name: 'B', resources: [shared] }] };
    const { ed, cur } = setup(start);
    expect(ed.setItem('mine', 'resource', 'r', { ...shared, name: '钢' })).toEqual({ ok: true });
    const names: string[] = [];
    walkPacks(cur(), (n) => {
      for (const x of (n.resources as { name: string }[] | undefined) ?? []) names.push(x.name);
    });
    expect(names).toEqual(['钢', '钢']);
  });

  it('延迟期间刷新页面（新的编辑器读同一个存储）：日志补上，不丢，再写进存储', async () => {
    const { ed, backend, packs, wal, puts } = setup();
    packs.set('mine', { key: 'mine', pack: pack(), installedAt: 1, mine: true, rev: 1 });
    ed.setItem('mine', 'culture', 'c1', c1);
    expect(puts.length).toBe(0);
    // 刷新：内存没了，存储里还是旧的，日志还在
    let list: LibraryEntry[] = [];
    const fresh = createLibEditor(backend, { entries: () => list, publish: () => {} });
    const p = fresh.adopt(packs.get('mine')!, pack());
    expect(culture(p, 'c1')!.name).toBe('改过');
    list = [{ key: 'mine', pack: p, builtin: false, mine: true, installedAt: 1 }];
    expect(fresh.isDirty('mine')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(culture(packs.get('mine')!.pack, 'c1')!.name).toBe('改过');
    expect(wal.has('mine')).toBe(false);
    // 刷新之后的撤销不留着（和世界一样，撤销只在这次打开的页面里）
    expect(fresh.canUndo('mine')).toBe(false);
  });

  it('写进存储之后才去掉日志；日志比存着的旧（已经写进去、或者别处换掉了）不补', async () => {
    const { ed, backend, packs, wal } = setup();
    packs.set('mine', { key: 'mine', pack: pack(), installedAt: 1, mine: true, rev: 1 });
    ed.setItem('mine', 'culture', 'c1', c1);
    const log = wal.get('mine')!;
    // 别处写了一个更新的包
    const newer: Stored = { key: 'mine', pack: pack(), installedAt: 1, mine: true, rev: log.rev + 1 };
    const fresh = createLibEditor(backend, { entries: () => [], publish: () => {} });
    expect(culture(fresh.adopt(newer, newer.pack), 'c1')!.name).toBe('一');
    expect(wal.has('mine')).toBe(false);
  });

  it('关掉面板、切换库（flush）：马上写；写的时候又改了，日志留着', async () => {
    const { ed, wal, puts, backend, packs } = setup();
    ed.setItem('mine', 'culture', 'c1', c1);
    await ed.flush('mine');
    expect(puts.length).toBe(1);
    expect(wal.has('mine')).toBe(false);
    // 慢的写入：写的中间又改一项
    let release = () => {};
    const slow: LibBackend = {
      ...backend,
      put: (rec) =>
        new Promise((res) => {
          release = () => {
            packs.set(rec.key, rec);
            res(true);
          };
        }),
    };
    let list: LibraryEntry[] = [{ key: 'mine', pack: pack(), builtin: false, mine: true, installedAt: 1 }];
    const ed2 = createLibEditor(slow, { entries: () => list, publish: (_k, p) => void (list = [{ ...list[0], pack: p }]) });
    ed2.setItem('mine', 'culture', 'c1', c1);
    const writing = ed2.flush('mine');
    ed2.setItem('mine', 'culture', 'c2', { id: 'c2', group: 'g', name: '二改', color: '#222222' });
    release();
    await writing;
    expect(wal.get('mine')!.ops.map((o) => o.id)).toEqual(['c1', 'c2']);
    expect(ed2.isDirty('mine')).toBe(true);
  });

  it('日志写不进去（隐私模式、满了）：很快写整个库', async () => {
    const { ed, backend, puts } = (() => {
      const s = fakeBackend();
      s.backend.walWrite = () => false;
      let list: LibraryEntry[] = [{ key: 'mine', pack: pack(), builtin: false, mine: true, installedAt: 1 }];
      return { ...s, ed: createLibEditor(s.backend, { entries: () => list, publish: (_k, p) => void (list = [{ ...list[0], pack: p }]) }) };
    })();
    void backend;
    ed.setItem('mine', 'culture', 'c1', c1);
    await vi.advanceTimersByTimeAsync(300);
    expect(puts.length).toBe(1);
  });
});

describe('真的日志（localStorage）', () => {
  // 一张表当 localStorage
  function fakeStorage() {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('改一项写进 localStorage，只有这一项；写不进去（满了）时很快写整个库', async () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    let list: LibraryEntry[] = [{ key: 'mine', pack: pack(), builtin: false, mine: true, installedAt: 1 }];
    const ed = createLibEditor(undefined, { entries: () => list, publish: (_k, p) => void (list = [{ ...list[0], pack: p }]) });
    ed.setItem('mine', 'culture', 'c1', c1);
    const raw = s.m.get('map2.libWal.mine')!;
    expect(JSON.parse(raw).ops).toEqual([{ section: 'cultures', id: 'c1', item: c1 }]);
    expect(raw.length).toBeLessThan(200);
    // 刷新页面：新的编辑器从 localStorage 读到日志
    const fresh = createLibEditor(undefined, { entries: () => [], publish: () => {} });
    const p = fresh.adopt({ key: 'mine', pack: pack(), installedAt: 1, mine: true, rev: 1 }, pack());
    expect(culture(p, 'c1')!.name).toBe('改过');
    // 坏掉的日志当没有
    s.m.set('map2.libWal.mine', '不是 JSON');
    const fresh2 = createLibEditor(undefined, { entries: () => [], publish: () => {} });
    const base = pack();
    expect(fresh2.adopt({ key: 'mine', pack: base, installedAt: 1, mine: true, rev: 1 }, base)).toBe(base);
    // 满了
    s.setItem = () => {
      throw new Error('满了');
    };
    expect(ed.setItem('mine', 'culture', 'c1', { ...c1, name: '满了也改' })).toEqual({ ok: true });
    expect(culture(list[0].pack, 'c1')!.name).toBe('满了也改');
    await vi.advanceTimersByTimeAsync(FLUSH_SOON_MS);
    expect(ed.isDirty('mine')).toBe(false);
  });

  it('日志里不合格式的一项（版本变了）不补，别的照补', () => {
    const { backend, wal } = fakeBackend();
    wal.set('mine', {
      rev: 9e15,
      ops: [
        { section: 'cultures', id: 'c1', item: c1 },
        { section: 'cultures', id: 'c2', item: { id: 'c2', color: 'red' } },
        { section: '没有这一段', id: 'x', item: {} },
      ],
    });
    const ed = createLibEditor(backend, { entries: () => [], publish: () => {} });
    const p = ed.adopt({ key: 'mine', pack: pack(), installedAt: 1, mine: true, rev: 1 }, pack());
    expect(culture(p, 'c1')!.name).toBe('改过');
    expect(culture(p, 'c2')!.name).toBe('二');
  });
});

describe('我的库的撤销', () => {
  it('改一项、撤销、重做，回到一模一样的对象', () => {
    const { ed, cur } = setup();
    const before = cur();
    ed.setItem('mine', 'culture', 'c1', c1, '改文化');
    const after = cur();
    expect(ed.undo('mine')).toBe('改文化');
    expect(cur()).toBe(before);
    expect(ed.canRedo('mine')).toBe(true);
    expect(ed.redo('mine')).toBe('改文化');
    expect(cur()).toBe(after);
    expect(ed.canRedo('mine')).toBe(false);
  });

  it('撤销也写进日志：撤销之后刷新，还是撤销之后的样子', () => {
    const { ed, wal } = setup();
    ed.setItem('mine', 'culture', 'c1', c1);
    ed.undo('mine');
    expect(wal.get('mine')!.ops).toEqual([{ section: 'cultures', id: 'c1', item: { id: 'c1', group: 'g', name: '一', color: '#111111' } }]);
  });

  it('切走再回来（编辑器不换）撤销还在，和别的库分开', () => {
    const store = fakeBackend();
    let list: LibraryEntry[] = [
      { key: 'mine', pack: pack(), builtin: false, mine: true, installedAt: 1 },
      { key: 'other', pack: { ...pack(), id: 'other' }, builtin: false, mine: true, installedAt: 2 },
    ];
    const ed = createLibEditor(store.backend, { entries: () => list, publish: (k, p) => void (list = list.map((e) => (e.key === k ? { ...e, pack: p } : e))) });
    ed.setItem('mine', 'culture', 'c1', c1);
    ed.setItem('other', 'culture', 'c2', { id: 'c2', group: 'g', name: '别的', color: '#222222' });
    expect(ed.undo('other')).not.toBeNull();
    expect(culture(list[0].pack, 'c1')!.name).toBe('改过');
    expect(ed.canUndo('mine')).toBe(true);
    expect(ed.undo('mine')).not.toBeNull();
    expect(culture(list[0].pack, 'c1')!.name).toBe('一');
  });

  it('加、删、换先后也能撤销，马上写整个库', async () => {
    const { ed, cur, puts } = setup();
    const before = cur();
    expect(ed.addItem('mine', 'culture', { id: 'c3', group: 'g', name: '三', color: '#333333' })).toEqual({ ok: true });
    // 文化放进它的组所在的小包
    expect((cur().packs![0].cultures as { id: string }[]).map((c) => c.id)).toEqual(['c1', 'c3']);
    await vi.advanceTimersByTimeAsync(0);
    expect(puts.length).toBe(1);
    expect(ed.addItem('mine', 'culture', { id: 'c3', group: 'g', name: '三', color: '#333333' }).ok).toBe(false);
    expect(ed.moveItem('mine', 'culture', 'c3', 'c1')).toEqual({ ok: true });
    expect((cur().packs![0].cultures as { id: string }[]).map((c) => c.id)).toEqual(['c3', 'c1']);
    expect(ed.moveItem('mine', 'culture', 'c1', 'c2').ok).toBe(false);
    expect(ed.removeItem('mine', 'culture', 'c3')).toEqual({ ok: true });
    expect(culture(cur(), 'c3')).toBeUndefined();
    ed.undo('mine');
    ed.undo('mine');
    ed.undo('mine');
    expect(cur()).toBe(before);
  });

  it('改名只改名字，键不变；空的名字不行', () => {
    const { ed, cur } = setup();
    expect(ed.rename('mine', '  新名字 ')).toEqual({ ok: true });
    expect([cur().id, cur().name]).toEqual(['mine', '新名字']);
    expect(ed.rename('mine', '').ok).toBe(false);
    ed.undo('mine');
    expect(cur().name).toBe('我的库');
  });
});

describe('内置的、导入的不能改', () => {
  it('编辑器拒绝', () => {
    const store = fakeBackend();
    const list: LibraryEntry[] = [
      { key: 'medieval', pack: builtinPacks()[1], builtin: true, mine: false, installedAt: 0 },
      { key: 'x', pack: pack(), builtin: false, mine: false, installedAt: 1 },
    ];
    const ed = createLibEditor(store.backend, { entries: () => list, publish: () => {} });
    expect(ed.canEdit('medieval')).toBe(false);
    expect(ed.setItem('medieval', 'culture', 'x', {}).ok).toBe(false);
    expect(ed.setItem('x', 'culture', 'c1', c1).ok).toBe(false);
    expect(ed.addItem('medieval', 'culture', c1).ok).toBe(false);
    expect(ed.removeItem('medieval', 'culture', 'x').ok).toBe(false);
    expect(ed.rename('medieval', '不行').ok).toBe(false);
  });
});

describe('复制成我的库', () => {
  const entryOf = (p: ResourcePack, mine = false): LibraryEntry => ({ key: p.id, pack: p, builtin: !mine, mine, installedAt: mine ? 2 : 0 });

  it('六个内置的库的副本都能过格式检查、还是够得上一个库', () => {
    for (const b of builtinPacks()) {
      const c = copiedPack(b, `${b.id}-copy`, `${b.name} 的副本`);
      const r = parsePack(c);
      expect(r.ok, b.id).toBe(true);
      expect(isLibrary(c, true), b.id).toBe(true);
      // 内容一项不少
      for (const key of ['cultures', 'governments', 'biomes', 'riverTypes']) expect(packItems(c, key).length, `${b.id} ${key}`).toBe(packItems(b, key).length);
    }
  });

  it('奇幻的副本照样带上奇幻的生态和河湖（看小包在不在，不看键），别的库不带', () => {
    const fantasy = builtinPacks().find((p) => p.id === 'fantasy')!;
    const c = copiedPack(fantasy, '我的奇幻', '我的奇幻');
    const parts = worldPartsOf('我的奇幻', c);
    expect(parts.map((p) => p.slice(1).join('/'))).toEqual(worldPartsOf('fantasy').map((p) => p.slice(1).join('/')));
    expect(parts.map((p) => p[1])).toContain('biomes');
    expect(worldPartsOf('fantasy').map((p) => p[1])).toContain('rivers');
    const lib = [...builtinPacks().map((p) => entryOf(p)), entryOf(c, true)];
    expect(worldContentPacks('我的奇幻', lib).map((p) => p[1])).toEqual(worldPartsOf('fantasy').map((p) => p[1]));
    expect(libraryOptions(lib, true).map((o) => o.key)).toContain('我的奇幻');
    // 世界里带上的生态、河、湖和内置奇幻库一样（来源记的是副本）
    const cmds = (root: string) => packImportCommands(libRoots(lib), { packs: worldContentPacks(root, lib), groups: [] });
    const ids = (root: string, op: string) => JSON.stringify(cmds(root).flatMap((x) => ('commands' in x ? x.commands : [x])).filter((x) => x.op === op).map((x) => JSON.stringify({ ...x, from: undefined })));
    for (const op of ['add_species', 'set_river_type', 'set_lake_type', 'set_content']) expect(ids('我的奇幻', op), op).toBe(ids('fantasy', op));
    // 中世纪的副本不带奇幻的
    const m = copiedPack(builtinPacks().find((p) => p.id === 'medieval')!, 'm2', 'm2');
    expect(worldPartsOf('m2', m).map((p) => p[1])).toEqual(['base', 'nature', 'names', 'styles', 'tiers', 'water']);
  });

  it('用奇幻的副本新建世界、生成人文：和用内置的奇幻库一模一样，只差来源（在这个副本里）', () => {
    vi.useRealTimers();
    const c = copiedPack(builtinPacks().find((p) => p.id === 'fantasy')!, '我的奇幻', '我的奇幻');
    const lib = [...builtinPacks().map((p) => entryOf(p)), entryOf(c, true)];
    const make = (key: string) => {
      const choice = chooseLibrary(defaultChoice(null, true, lib), key, lib);
      const settings = { cells: 6000, seed: 1, latNorth: 60, latSouth: 20 };
      const eng = new Engine(settings, meshFor(settings));
      for (const cmd of newWorldCommands({ seed: 5, type: 'continents', landFraction: 0.4 }, '像地球', 5, [], generateCommand(choice, null, lib), worldContentCommands(choice, lib))) eng.exec(cmd);
      return eng.world;
    };
    const a = make('fantasy');
    const b = make('我的奇幻');
    expect(humanDigest(b)).toEqual(humanDigest(a));
    expect(b.small.species.map((s) => s.id)).toEqual(a.small.species.map((s) => s.id));
    expect(b.small.species.some((s) => s.id === 'crystal_jungle')).toBe(true);
    expect(b.small.riverTypes!.map((t) => t.id)).toEqual(a.small.riverTypes!.map((t) => t.id));
    expect(b.small.content).toEqual(a.small.content);
    expect(worldLibrary(b.small)).toBe('我的奇幻');
    expect(b.small.origin!.biome.crystal_jungle[0]).toBe('我的奇幻');
    vi.useFakeTimers();
  });

  it('副本和内置的共用同一份内容（不复制 1.5 MB）；改副本不碰内置的', () => {
    const b = builtinPacks().find((p) => p.id === 'medieval')!;
    const c = copiedPack(b, 'm2', 'm2');
    expect(c.packs).toBe(b.packs);
    const store = fakeBackend();
    let list: LibraryEntry[] = [{ key: 'm2', pack: c, builtin: false, mine: true, installedAt: 2 }];
    const ed = createLibEditor(store.backend, { entries: () => list, publish: (_k, p) => void (list = [{ ...list[0], pack: p }]) });
    const kind = kindOf('culture')!;
    const first = packItems<{ id: string; name: string }>(c, 'cultures')[0];
    const orig = first.name;
    expect(ed.setItem('m2', 'culture', first.id, { ...first, name: '改过' })).toEqual({ ok: true });
    expect(packItems<{ id: string; name: string }>(list[0].pack, 'cultures').find((x) => itemId(kind, x) === first.id)!.name).toBe('改过');
    expect(packItems<{ id: string; name: string }>(b, 'cultures').find((x) => x.id === first.id)!.name).toBe(orig);
  });
});

describe('应用里的一份：新建、复制、删除、读存储', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('复制、改一项、读一遍存储、再删除', async () => {
    await refreshLibrary();
    const made = await copyLibrary('medieval');
    expect(made).not.toBeNull();
    const key = made!.key;
    expect(library.value.find((e) => e.key === key)!.mine).toBe(true);
    expect(library.value.find((e) => e.key === key)!.pack.name).toBe('中世纪与近世的副本');
    const c = packItems<{ id: string; name: string }>(library.value.find((e) => e.key === key)!.pack, 'cultures')[0];
    expect(libEdits.setItem(key, 'culture', c.id, { ...c, name: '刚改的' })).toEqual({ ok: true });
    // 还没写进存储时读一遍：内存里的留着
    await refreshLibrary();
    expect(packItems<{ id: string; name: string }>(library.value.find((e) => e.key === key)!.pack, 'cultures')[0].name).toBe('刚改的');
    await libEdits.flushAll();
    await refreshLibrary();
    expect(packItems<{ id: string; name: string }>(library.value.find((e) => e.key === key)!.pack, 'cultures')[0].name).toBe('刚改的');
    await deleteLibrary(key);
    expect(library.value.some((e) => e.key === key)).toBe(false);
    expect(libEdits.canUndo(key)).toBe(false);
  });

  it('延迟期间关掉面板、切换库：马上写进存储', async () => {
    await refreshLibrary();
    const made = (await copyLibrary('medieval', '延迟'))!;
    const c = packItems<{ id: string; name: string }>(library.value.find((e) => e.key === made.key)!.pack, 'cultures')[0];
    const edit = (name: string) => libEdits.setItem(made.key, 'culture', c.id, { ...c, name });
    openLibrary({ entry: made.key });
    edit('一');
    expect(libEdits.isDirty(made.key)).toBe(true);
    closeLibrary();
    await vi.waitFor(() => expect(libEdits.isDirty(made.key)).toBe(false));
    openLibrary({ entry: made.key });
    edit('二');
    expect(libEdits.isDirty(made.key)).toBe(true);
    setSource({ t: 'lib', key: 'medieval' });
    await vi.waitFor(() => expect(libEdits.isDirty(made.key)).toBe(false));
    // 切走再回来，撤销还在
    expect(libEdits.canUndo(made.key)).toBe(true);
    closeLibrary();
    await deleteLibrary(made.key);
  });

  it('删掉一个库之后，还没写的不会把它写回来', async () => {
    await refreshLibrary();
    const made = (await copyLibrary('medieval', '要删的'))!;
    const c = packItems<{ id: string; name: string }>(library.value.find((e) => e.key === made.key)!.pack, 'cultures')[0];
    libEdits.setItem(made.key, 'culture', c.id, { ...c, name: '没写的' });
    await deleteLibrary(made.key);
    expect(libEdits.isDirty(made.key)).toBe(false);
    await libEdits.flushAll();
    await refreshLibrary();
    expect(library.value.some((e) => e.key === made.key)).toBe(false);
  });

  it('别处换掉了这个包（存进资源库、再导入）：用新的，改到一半的撤销去掉', async () => {
    await refreshLibrary();
    const made = (await createLibrary('别处换'))!;
    const e = () => library.value.find((x) => x.key === made.key)!;
    expect(libEdits.addItem(made.key, 'culture', { id: 'c9', group: 'g', name: '九', color: '#999999' })).toEqual({ ok: true });
    await libEdits.flushAll();
    expect(libEdits.canUndo(made.key)).toBe(true);
    await installPack({ ...e().pack, name: '新装的' }, { mine: true });
    expect(e().pack.name).toBe('新装的');
    expect(libEdits.canUndo(made.key)).toBe(false);
    await deleteLibrary(made.key);
  });

  it('新建空的库：名字重复时键另起', async () => {
    await refreshLibrary();
    const a = await createLibrary('空的');
    const b = await createLibrary('空的');
    expect(a.key).not.toBe(b.key);
    expect(library.value.find((e) => e.key === a.key)!.mine).toBe(true);
    await deleteLibrary(a.key);
    await deleteLibrary(b.key);
  });
});
