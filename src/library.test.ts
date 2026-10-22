import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PACK } from '../core/names';
import { type ResourcePack, readPack } from '../core/packs';
import { FANTASY_PACK } from '../core/packs/fantasy';
import { scriptHash } from '../core/script';
import { openDb } from './idb';
import { TRUST_KEY, installPack, library, refreshLibrary, removePack, trustScripts, trustedHashes, untrustedScripts } from './library';

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
});

const userPack = (id: string, extra: Partial<ResourcePack> = {}): ResourcePack => ({ format: 'map2-pack', version: 1, id, name: id, ...extra });
const withScript = (id: string, src: string) =>
  userPack(id, { biomes: [{ id: `${id}_b`, name: '脚本生态', color: '#123456', terrain: 'plains', competition: 2, tolerances: [], scripts: { placement: { api: 1, src } } }] });

describe('资源库', () => {
  it('从第 3 版升上来：已有的表和里面的数据都在，只补上 packs 表', async () => {
    idb.version = 3;
    idb.data.set('kv', new Map([['autosave', { count: 3 }]]));
    idb.data.set('autosave', new Map([[0, { op: 'paint_land' }]]));
    idb.data.set('checkpoint', new Map([['current', { build: 'x' }]]));
    const db = await openDb();
    expect(idb.version).toBe(4);
    expect(idb.created).toEqual(['packs']);
    expect(db.objectStoreNames.contains('packs')).toBe(true);
    expect(idb.data.get('kv')!.get('autosave')).toEqual({ count: 3 });
    expect(idb.data.get('autosave')!.get(0)).toEqual({ op: 'paint_land' });
    expect(idb.data.get('checkpoint')!.get('current')).toEqual({ build: 'x' });
  });

  it('内置示例包总在最前面、删不掉；装、替换、删除只动资源库', async () => {
    expect((await refreshLibrary()).map((e) => [e.key, e.builtin])).toEqual([['fantasy', true]]);
    await installPack(userPack('a'));
    await installPack(userPack('mine', { name: '我的' }), { mine: true });
    // 我的资源排在导入的前面
    expect(library.value.map((e) => e.key)).toEqual(['fantasy', 'mine', 'a']);
    // 同一个 id 再装：替换
    await installPack(userPack('a', { name: '新的 a' }));
    expect(library.value.filter((e) => e.key === 'a').map((e) => e.pack.name)).toEqual(['新的 a']);
    // 与内置同 id 的另存一份，不盖住内置的
    const clash = await installPack(userPack('fantasy', { name: '冒名' }));
    expect(clash.entry.key).toBe('fantasy-2');
    expect(library.value[0].pack).toBe(FANTASY_PACK);
    await removePack('fantasy');
    await removePack('a');
    expect(library.value.map((e) => e.key)).toEqual(['fantasy', 'mine', 'fantasy-2']);
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
    expect(e?.pack.textPacks?.[0].name).toBe('很长的文字包名字'.repeat(10));
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
    await trustScripts([scriptHash('return 0.5;')]);
    expect((await trustedHashes()).has(scriptHash('return 0.5;'))).toBe(true);
    await removePack('temp');
    expect(library.value.map((e) => e.key)).not.toContain('temp');
  });
});

describe('信任的脚本', () => {
  it('内置示例包的脚本总是信任的', async () => {
    expect(await untrustedScripts(FANTASY_PACK)).toEqual([]);
  });

  it('信任过的哈希存进 kv 的 trustedScripts（16 位十六进制的数组），之后不再问', async () => {
    await openDb();
    const p = withScript('s', 'return 0.25;');
    const before = await untrustedScripts(p);
    expect(before.map((s) => [s.owner, s.kind])).toEqual([['脚本生态', 'placement']]);
    await trustScripts(before.map((s) => s.hash));
    await trustScripts([scriptHash('return 1;'), 'not-a-hash']);
    const saved = idb.data.get('kv')!.get(TRUST_KEY) as string[];
    expect(saved).toEqual([scriptHash('return 0.25;'), scriptHash('return 1;')]);
    expect(saved.every((h) => /^[0-9a-f]{16}$/.test(h))).toBe(true);
    expect(await untrustedScripts(p)).toEqual([]);
    // 改了一个字就是另一段脚本，要重新问
    expect((await untrustedScripts(withScript('s', 'return 0.26;'))).length).toBe(1);
  });
});
