import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC_VERSION } from '../../core/doc-version';
import { AUTOSAVE_KEY, backupFileText, browserBackupIo, listBackups } from '../backups';
import { autosaved, readAutosave } from './autosave';
import { backups, useBackupIo } from './backups';
import { FakeIDB } from '../testing/fake-idb';

// 第九十一轮：启动时读自动保存的那一条路（readAutosave → 浏览器里的存取）。IndexedDB、localStorage 换成内存里的小替身：
// 旧版本的自动保存挪进 backups 表（库从第 6 版升上来时才补这张表），原来的位置空出来；之后新世界的自动保存写在原处，它还在

const settings = { seed: 1, cells: 3000, aspect: 2, latNorth: 60, latSouth: 20 };
const commands = [
  { op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true },
  { op: 'set_name', key: 'k1', name: '赤原' },
];
const head = (version: number) => ({ format: 'map2-world', version, settings });

let idb: FakeIDB;
let local: Map<string, string>;
beforeEach(() => {
  idb = new FakeIDB();
  // 第 6 版的库：还没有 backups 表
  idb.version = 6;
  for (const name of ['kv', 'autosave', 'checkpoint', 'packs', 'meshes', 'maps', 'mapDocs']) idb.data.set(name, new Map());
  local = new Map();
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('IDBKeyRange', { bound: (lo: number, hi: number) => ({ lo, hi }) });
  vi.stubGlobal('localStorage', {
    get length() {
      return local.size;
    },
    key: (k: number) => [...local.keys()][k] ?? null,
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  });
  useBackupIo(browserBackupIo);
});
afterEach(() => vi.unstubAllGlobals());

function putAutosave(version: number, savedAt: number, more: Record<string, unknown> = {}) {
  idb.data.get('kv')!.set('autosave', { ...head(version), savedAt, count: commands.length, ...more });
  const store = idb.data.get('autosave')!;
  store.clear();
  commands.forEach((c, k) => store.set(k, c));
}

describe('启动时读自动保存', () => {
  it('旧版本的：不打开（返回 null、进向导），但原样挪进 backups；库升到第 7 版只补这一张表', async () => {
    putAutosave(DOC_VERSION - 1, 1234, { mapId: 'm1', mapSynced: true });
    idb.data.get('checkpoint')!.set('current', { build: 'x' });
    idb.data.get('mapDocs')!.set('m1', { any: 1 });
    expect(await readAutosave()).toBeNull();
    expect(autosaved.value).toBeNull();
    expect(idb.created).toEqual(['backups']);
    // 原来的位置空了：新世界的自动保存碰不到它
    expect(idb.data.get('kv')!.has('autosave')).toBe(false);
    expect(idb.data.get('autosave')!.size).toBe(0);
    // 别的表不动
    expect(idb.data.get('checkpoint')!.get('current')).toEqual({ build: 'x' });
    expect(idb.data.get('mapDocs')!.get('m1')).toEqual({ any: 1 });
    const list = await listBackups(browserBackupIo);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ savedAt: 1234, version: DOC_VERSION - 1, age: 'older', steps: 2, mapId: 'm1' });
    // 导出的就是原来的世界文件，一字不差
    expect(backupFileText(list[0])).toBe(JSON.stringify({ ...head(DOC_VERSION - 1), commands }));
    expect(backups.value!.map((b) => b.id)).toEqual([list[0].id]);
  });

  it('之后新世界自动保存、再启动：打开的是新的，旧的还在 backups 里', async () => {
    putAutosave(DOC_VERSION - 1, 1234);
    await readAutosave();
    const kept = JSON.stringify(await listBackups(browserBackupIo));
    // 新世界的自动保存写在原处
    putAutosave(DOC_VERSION, 5000);
    // 再启动
    useBackupIo(browserBackupIo);
    const got = await readAutosave();
    expect(got).toMatchObject({ savedAt: 5000, doc: { ...head(DOC_VERSION), commands } });
    expect(autosaved.value).toBe(5000);
    expect(JSON.stringify(await listBackups(browserBackupIo))).toBe(kept);
    expect(backups.value!.length).toBe(1);
  });

  it('这一版的自动保存照旧打开，不进 backups', async () => {
    putAutosave(DOC_VERSION, 777, { safe: '安全模式' });
    expect(await readAutosave()).toMatchObject({ savedAt: 777, safe: '安全模式' });
    expect(idb.data.get('backups')!.size).toBe(0);
    expect(backups.value).toEqual([]);
  });

  it('更新的版本做的、localStorage 后备里旧版本的：也都留下', async () => {
    putAutosave(DOC_VERSION + 1, 100);
    const old = { savedAt: 200, doc: { ...head(DOC_VERSION - 2), commands } };
    local.set(AUTOSAVE_KEY, JSON.stringify(old));
    expect(await readAutosave()).toBeNull();
    expect(local.has(AUTOSAVE_KEY)).toBe(false);
    const list = await listBackups(browserBackupIo);
    expect(list.map((b) => [b.age, b.version]).sort()).toEqual(
      [
        ['newer', DOC_VERSION + 1],
        ['older', DOC_VERSION - 2],
      ].sort(),
    );
    expect(backupFileText(list.find((b) => b.age === 'older')!)).toBe(JSON.stringify(old.doc));
  });
});
