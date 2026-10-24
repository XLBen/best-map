import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PACK } from '../core/names';
import { type ResourcePack, readPack } from '../core/packs';
import { FANTASY_PACK } from '../core/packs/fantasy';
import { findScripts } from '../core/script';
import { openDb } from './idb';
import { MY_PACK_NAME, inLibrary, installPack, keepSavedForms, library, refreshLibrary, removePack, saveForm, saveItem } from './library';
import { BUILTIN_STYLES, NAME_STYLES_PACK, NAME_STYLES_PACK_ID } from '../core/packs/names';
import { PACK_MAX } from '../core/packs';
import { TWIN_CONTINENTS } from '../core/packs/fantasy-forms';
import type { PlanetForm } from '../core/planet-form';
import { forgetTrustCache, trustScripts, untrustedScripts } from './trust';

// 资源库与信任的脚本：IndexedDB 换成一个只在内存里的小替身（够这里用的几个操作）

type Data = Map<string, Map<IDBValidKey, unknown>>;

class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

class FakeTx {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private open = 0;
  constructor(private data: Data) {
    // 一个请求都没有的事务也会结束
    setTimeout(() => this.maybeDone(), 0);
  }
  private maybeDone() {
    if (this.open === 0 && this.oncomplete) {
      const f = this.oncomplete;
      this.oncomplete = null;
      f();
    }
  }
  private req(run: () => unknown): FakeRequest {
    const r = new FakeRequest();
    this.open++;
    queueMicrotask(() => {
      r.result = run();
      r.onsuccess?.();
      this.open--;
      setTimeout(() => this.maybeDone(), 0);
    });
    return r;
  }
  objectStore(name: string) {
    const s = this.data.get(name);
    if (!s) throw new Error(`没有表 ${name}`);
    return {
      get: (k: IDBValidKey) => this.req(() => structuredClone(s.get(k))),
      put: (v: unknown, k: IDBValidKey) => this.req(() => void s.set(k, structuredClone(v))),
      delete: (k: IDBValidKey) => this.req(() => void s.delete(k)),
      getAll: () => this.req(() => [...s.values()].map((v) => structuredClone(v))),
    };
  }
}

class FakeIDB {
  data: Data = new Map();
  version = 0;
  created: string[] = [];
  open(_name: string, version: number) {
    const r = new FakeRequest();
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: (n: string) => this.data.has(n) },
        createObjectStore: (n: string) => {
          this.created.push(n);
          this.data.set(n, new Map());
        },
        transaction: () => new FakeTx(this.data),
        close: () => {},
      };
      r.result = db;
      if (version > this.version) {
        this.version = version;
        r.onupgradeneeded?.();
      }
      r.onsuccess?.();
    }, 0);
    return r;
  }
}

let idb: FakeIDB;
beforeEach(() => {
  idb = new FakeIDB();
  vi.stubGlobal('indexedDB', idb);
  forgetTrustCache();
});

const userPack = (id: string, extra: Partial<ResourcePack> = {}): ResourcePack => ({ format: 'map2-pack', version: 1, id, name: id, ...extra });
const withScript = (id: string, src: string) =>
  userPack(id, { biomes: [{ id: `${id}_b`, name: '脚本生态', color: '#123456', terrain: 'plains', competition: 2, tolerances: [], scripts: { placement: { api: 1, src } } }] });

describe('资源库', () => {
  it('从第 3 版升上来：已有的表和里面的数据都在，只补上 packs、meshes、maps、mapDocs 表', async () => {
    idb.version = 3;
    idb.data.set('kv', new Map([['autosave', { count: 3 }]]));
    idb.data.set('autosave', new Map([[0, { op: 'paint_land' }]]));
    idb.data.set('checkpoint', new Map([['current', { build: 'x' }]]));
    const db = await openDb();
    expect(idb.version).toBe(6);
    expect(idb.created).toEqual(['packs', 'meshes', 'maps', 'mapDocs']);
    expect(db.objectStoreNames.contains('packs')).toBe(true);
    expect(idb.data.get('kv')!.get('autosave')).toEqual({ count: 3 });
    expect(idb.data.get('autosave')!.get(0)).toEqual({ op: 'paint_land' });
    expect(idb.data.get('checkpoint')!.get('current')).toEqual({ build: 'x' });
  });

  it('内置示例包总在最前面、删不掉；装、替换、删除只动资源库', async () => {
    expect((await refreshLibrary()).map((e) => [e.key, e.builtin])).toEqual([['fantasy', true], ['name-styles', true]]);
    await installPack(userPack('a'));
    await installPack(userPack('mine', { name: '我的' }), { mine: true });
    // 我的资源排在导入的前面
    expect(library.value.map((e) => e.key)).toEqual(['fantasy', 'name-styles', 'mine', 'a']);
    // 同一个 id 再装：替换
    await installPack(userPack('a', { name: '新的 a' }));
    expect(library.value.filter((e) => e.key === 'a').map((e) => e.pack.name)).toEqual(['新的 a']);
    // 与内置同 id 的另存一份，不盖住内置的
    const clash = await installPack(userPack('fantasy', { name: '冒名' }));
    expect(clash.entry.key).toBe('fantasy-2');
    expect(library.value[0].pack).toBe(FANTASY_PACK);
    await removePack('fantasy');
    await removePack('a');
    expect(library.value.map((e) => e.key)).toEqual(['fantasy', 'name-styles', 'mine', 'fantasy-2']);
    // 存着的坏数据不列出来
    idb.data.get('packs')!.set('bad', { key: 'bad', pack: { format: 'map2-pack', version: 1 }, installedAt: 1 });
    expect((await refreshLibrary()).map((e) => e.key)).not.toContain('bad');
  });

  it('旧的文字包文件（名字比资源包允许的长）装进去后照样列得出来', async () => {
    const r = readPack(JSON.stringify({ ...DEFAULT_PACK, id: 'long', name: '很长的文字包名字'.repeat(10) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await installPack(r.pack);
    const e = library.value.find((x) => x.key === 'long');
    expect(e?.pack.nameStyles?.[0].name).toBe('很长的文字包名字'.repeat(10));
  });

  it('浏览器不让存时照样能用（只在这一次打开的页面里）', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('不让存');
      },
    });
    const r = await installPack(userPack('temp'));
    expect(r.ok).toBe(false);
    expect(library.value.map((e) => e.key)).toContain('temp');
    const p = withScript('t', 'return 0.5;');
    await trustScripts(await untrustedScripts(p));
    expect(await untrustedScripts(p)).toEqual([]);
    await removePack('temp');
    expect(library.value.map((e) => e.key)).not.toContain('temp');
  });
});

// 信任只有一处（trust.ts，按源码的 SHA-256）：资源库只是登记成总是信任的来源
describe('自己做的星球形态存进资源库', () => {
  const form = (id: string, name = id): PlanetForm => ({ id, name, api: 1, base: 'archipelago', profile: { landFraction: 0.2 } });
  it('存进“我的资源”：没有就新建；再存一个接在后面；同一个 id 换成新的；包里原来的生态留着', async () => {
    await installPack(userPack(MY_PACK_NAME, { biomes: withScript('x', 'return 1;').biomes }), { mine: true });
    const a = await saveForm(form('my_a', '千岛'));
    expect(a.ok && a.entry.key).toBe(MY_PACK_NAME);
    expect(a.ok && a.stored).toBe(true);
    await saveForm({ ...TWIN_CONTINENTS, id: 'my_b', name: '双子大陆 2' });
    await saveForm(form('my_a', '万岛'));
    const mine = library.value.find((e) => e.key === MY_PACK_NAME)!;
    expect(mine.mine).toBe(true);
    expect(mine.pack.biomes!.map((b) => b.id)).toEqual(['x_b']);
    expect(mine.pack.planetForms!.map((f) => [f.id, f.name])).toEqual([
      ['my_b', '双子大陆 2'],
      ['my_a', '万岛'],
    ]);
    // 存的是副本
    expect(mine.pack.planetForms![0]).not.toBe(TWIN_CONTINENTS);
  });

  it('没有“我的资源”时新建一个；超过上限时不存（存了整个包会读不回来），说一句', async () => {
    const first = await saveForm(form('my_0'));
    expect(first.ok && first.entry.pack).toEqual({ format: 'map2-pack', version: 1, id: MY_PACK_NAME, name: MY_PACK_NAME, planetForms: [form('my_0')] });
    for (let k = 1; k < PACK_MAX.planetForms; k++) expect((await saveForm(form(`my_${k}`))).ok).toBe(true);
    const over = await saveForm(form('my_over'));
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toContain('已满 32 个');
    // 替换已有的照样可以
    expect((await saveForm(form('my_3', '改过的'))).ok).toBe(true);
    expect(library.value.find((e) => e.key === MY_PACK_NAME)!.pack.planetForms!.length).toBe(PACK_MAX.planetForms);
  });

  it('从世界导出存进“我的资源”（替换它）时，形态编辑器存在里面的星球形态留着；同一个 id 用导出的；别人的包、新的名字不管', async () => {
    await saveForm(form('my_a', '千岛'));
    await saveForm(form('my_b', '万岛'));
    // 导出的包：世界里的生态和世界在用的形态（与存着的 my_b 同 id、改过）
    const exported = userPack(MY_PACK_NAME, { biomes: withScript('y', 'return 1;').biomes, planetForms: [form('my_b', '万岛新') as never] });
    const old = inLibrary(exported);
    expect(old?.mine).toBe(true);
    const stored = keepSavedForms(exported, old);
    expect(stored.planetForms!.map((f) => [f.id, f.name])).toEqual([
      ['my_b', '万岛新'],
      ['my_a', '千岛'],
    ]);
    expect(stored.biomes).toBe(exported.biomes);
    await installPack(stored, { mine: true });
    expect(library.value.find((e) => e.key === MY_PACK_NAME)!.pack.planetForms!.map((f) => f.id)).toEqual(['my_b', 'my_a']);
    // 没有形态的导出也一样留着
    const plain = userPack(MY_PACK_NAME, { biomes: withScript('z', 'return 1;').biomes });
    expect(keepSavedForms(plain, inLibrary(plain)).planetForms!.map((f) => f.id)).toEqual(['my_b', 'my_a']);
    // 替换的不是自己的包、没有要替换的：原样
    await installPack(userPack('别人的', { planetForms: [form('x_1') as never] }));
    const theirs = userPack('别人的', { name: '别人的' });
    expect(keepSavedForms(theirs, inLibrary(theirs))).toBe(theirs);
    const fresh = userPack('新的');
    expect(keepSavedForms(fresh, inLibrary(fresh))).toBe(fresh);
    // 加起来超过上限的不留（存了整个包会读不回来）
    const many = { ...old!, pack: { ...old!.pack, planetForms: Array.from({ length: PACK_MAX.planetForms }, (_, k) => form(`my_${k}`) as never) } };
    expect(keepSavedForms(exported, many).planetForms!.length).toBe(PACK_MAX.planetForms);
  });
});

describe('仓库的编辑器存进“我的资源”（第二十轮）', () => {
  it('地名风格存进“我的资源”：同一个 id 换成新的；从世界导出替换“我的资源”时它留着', async () => {
    const style = { ...BUILTIN_STYLES.find((s) => s.id === 'west-germanic')!, id: 'my-g', name: '我的日耳曼' };
    const a = await saveItem('nameStyles', style);
    expect(a.ok && a.entry.pack.nameStyles!.map((s) => s.name)).toEqual(['我的日耳曼']);
    await saveItem('nameStyles', { ...style, name: '改过的' });
    const mine = library.value.find((e) => e.key === MY_PACK_NAME)!;
    expect(mine.pack.nameStyles!.map((s) => [s.id, s.name])).toEqual([['my-g', '改过的']]);
    const exported = userPack(MY_PACK_NAME, { biomes: withScript('y', 'return 1;').biomes });
    expect(keepSavedForms(exported, inLibrary(exported)).nameStyles!.map((s) => s.id)).toEqual(['my-g']);
    // 坏的存不进去
    const bad = await saveItem('nameStyles', { ...style, id: 'bad', kind: 'nope' });
    expect(bad.ok).toBe(false);
    expect((await saveItem('nope', style)).ok).toBe(false);
  });

  it('地名风格示例是内置的：在最前面、默认信任、删不掉', async () => {
    const list = await refreshLibrary();
    const e = list.find((x) => x.key === NAME_STYLES_PACK_ID)!;
    expect([e.builtin, e.pack]).toEqual([true, NAME_STYLES_PACK]);
    await removePack(NAME_STYLES_PACK_ID);
    expect(library.value.map((x) => x.key)).toContain(NAME_STYLES_PACK_ID);
    expect((await installPack(userPack(NAME_STYLES_PACK_ID))).entry.key).toBe(`${NAME_STYLES_PACK_ID}-2`);
  });
});

describe('信任的脚本', () => {
  it('内置示例包的脚本总是信任的', async () => {
    expect(await untrustedScripts(FANTASY_PACK)).toEqual([]);
  });

  it('信任过的存进 kv 的 trustedScripts（按源码的 SHA-256），之后不再问', async () => {
    await openDb();
    const p = withScript('s', 'return 0.25;');
    const before = await untrustedScripts(p);
    expect(before.map((s) => [s.owner, s.kind])).toEqual([['脚本生态', 'placement']]);
    await trustScripts(before);
    const saved = idb.data.get('kv')!.get('trustedScripts') as { hash: string }[];
    expect(saved.map((e) => e.hash.slice(0, 7))).toEqual(['sha256:']);
    forgetTrustCache();
    expect(await untrustedScripts(p)).toEqual([]);
    // 改了一个字就是另一段脚本，要重新问
    expect((await untrustedScripts(withScript('s', 'return 0.26;'))).length).toBe(1);
  });

  it('导入装进来的包一直信任（整理信任列表挤不掉）；“我的资源”不算', async () => {
    await refreshLibrary();
    const theirs = withScript('theirs', 'return 0.31;');
    const mine = withScript('mine2', 'return 0.32;');
    expect((await untrustedScripts(theirs)).length).toBe(1);
    await installPack(theirs);
    await installPack(mine, { mine: true });
    expect(await untrustedScripts(theirs)).toEqual([]);
    expect((await untrustedScripts(mine)).length).toBe(1);
    await removePack('theirs');
    await removePack('mine2');
  });

  it('删掉资源库里的包就不再总是信任（资源库的列表变了，信任那边重算）', async () => {
    const theirs = withScript('gone', 'return 0.33;');
    await installPack(theirs);
    expect(await untrustedScripts(theirs)).toEqual([]);
    await removePack('gone');
    expect((await untrustedScripts(theirs)).map((s) => s.src)).toEqual(['return 0.33;']);
  });

  it('文字包带不进脚本（只认词表和模板）；河流类型、星球形态里的脚本导入时照样列出来问', async () => {
    const words = readPack(JSON.stringify({ ...DEFAULT_PACK, id: 'w', name: '带脚本的文字包', scripts: { placement: { api: 1, src: 'return 0.61;' } } }));
    expect(words.ok && words.legacy).toBe('wordPack');
    expect(words.ok && findScripts(words.pack)).toEqual([]);
    const other = readPack(
      JSON.stringify({
        format: 'map2-pack',
        version: 1,
        id: 'other',
        name: 'other',
        // 河流类型按 river-types.ts 的格式检查（要有名字、颜色，脚本只能是 match）
        riverTypes: [{ id: 'blood', name: '血河', color: '#8f1414', scripts: { match: { api: 1, src: 'return 流量 > 1000;' } } }],
        // 星球形态按 planet-form.ts 的格式检查（要写 api、从哪种星球改起）
        planetForms: [{ id: 'ring', name: '环', api: 1, base: 'inland_sea', scripts: { crust: { api: 1, src: 'return height;' } } }],
      }),
    );
    expect(other.ok).toBe(true);
    expect((await untrustedScripts(other.ok && other.pack)).map((s) => [s.owner, s.kind, s.src])).toEqual([
      ['血河', 'match', 'return 流量 > 1000;'],
      ['环', 'crust', 'return height;'],
    ]);
  });

  it('刚打开页面（还没开过资源包对话框）时，存着的、装进来的包也算信任', async () => {
    await openDb();
    const theirs = withScript('stored', 'return 0.41;');
    const mine = withScript('stored-mine', 'return 0.42;');
    idb.data.get('packs')!.set('stored', { key: 'stored', pack: theirs, installedAt: 1 });
    idb.data.get('packs')!.set('stored-mine', { key: 'stored-mine', pack: mine, installedAt: 2, mine: true });
    // 新的一页：模块重新载入，资源库还只有内置的
    vi.resetModules();
    const lib = await import('./library');
    const tr = await import('./trust');
    expect(lib.library.value.map((e) => e.key)).toEqual(['fantasy', 'name-styles']);
    expect(await tr.untrustedScripts(theirs)).toEqual([]);
    expect((await tr.untrustedScripts(mine)).length).toBe(1);
  });
});
