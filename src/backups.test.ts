import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOC_VERSION } from '../core/doc-version';
import {
  AUTOSAVE_KEY,
  LOCAL_BACKUP_PREFIX,
  type RawAutosave,
  backupFileName,
  backupFileText,
  infoOf,
  keepStaleAutosaves,
  listBackups,
  markSeen,
  memoryBackupIo,
  removeBackup,
  staleAge,
  staleLocalAutosave,
} from './backups';
import { DB_STORES, DB_VERSION, openDb } from './idb';
import { backups, deleteBackup, dismissBackups, keepStaleOnce, useBackupIo } from './state/backups';

// 第九十一轮：这一版打不开的自动保存不再无声消失——启动时原样挪进 backups，新世界的自动保存碰不到它，能导出、能删除

const settings = { seed: 1, cells: 3000, aspect: 2, latNorth: 60, latSouth: 20 };
const docOf = (version: unknown, steps = 3) => ({
  format: 'map2-world',
  version,
  settings,
  commands: Array.from({ length: steps }, (_, k) => ({ op: 'set_name', key: `k${k}`, name: `名字${k}`, n: 0.1 + k })),
});
const saved = (version: unknown, savedAt = 1000, more: Partial<RawAutosave> = {}): RawAutosave => ({ savedAt, doc: docOf(version), ...more });

describe('哪些算这一版打不开', () => {
  it('旧版本的、更新的版本做的算；这一版的、不是世界文件的不算', () => {
    expect(staleAge(docOf(DOC_VERSION - 1))).toBe('older');
    expect(staleAge(docOf(5))).toBe('older');
    expect(staleAge(docOf(DOC_VERSION + 1))).toBe('newer');
    expect(staleAge(docOf(DOC_VERSION))).toBeNull();
    expect(staleAge({ format: 'other', version: 3 })).toBeNull();
    expect(staleAge(null)).toBeNull();
  });
});

describe('启动时：旧版本的自动保存留下来，不丢', () => {
  it('IndexedDB 里的：原样挪进 backups（连命令、时间、它自己的版本号），自动保存的位置空出来', async () => {
    const io = memoryBackupIo();
    const old = saved(DOC_VERSION - 1, 1234, { safe: '上次是安全模式', mapId: 'm1' });
    io.autosave = structuredClone(old);
    const kept = await keepStaleAutosaves(io, 5000);
    expect(kept.length).toBe(1);
    expect(io.autosave).toBeNull();
    const [b] = await listBackups(io);
    expect(b).toMatchObject({ keptAt: 5000, savedAt: 1234, version: DOC_VERSION - 1, age: 'older', steps: 3, safe: '上次是安全模式', mapId: 'm1' });
    expect(b.doc).toEqual(old.doc);
    // 导出的内容和原来的世界文件一字不差，里面写着它自己的版本号
    expect(backupFileText(b)).toBe(JSON.stringify(old.doc));
    expect(JSON.parse(backupFileText(b)).version).toBe(DOC_VERSION - 1);
  });

  it('之后新世界自动保存（盖在原来的位置上）、再启动几次，它都还在', async () => {
    const io = memoryBackupIo();
    const old = saved(DOC_VERSION - 1);
    io.autosave = structuredClone(old);
    await keepStaleAutosaves(io, 5000);
    // 新世界的自动保存写在原来的位置
    io.autosave = saved(DOC_VERSION, 6000);
    io.storage.set(AUTOSAVE_KEY, JSON.stringify(saved(DOC_VERSION, 6001)));
    expect(await keepStaleAutosaves(io, 7000)).toEqual([]);
    expect(await keepStaleAutosaves(io, 8000)).toEqual([]);
    // 这一版的自动保存不动
    expect(io.autosave?.savedAt).toBe(6000);
    expect(io.storage.has(AUTOSAVE_KEY)).toBe(true);
    const list = await listBackups(io);
    expect(list.length).toBe(1);
    expect(backupFileText(list[0])).toBe(JSON.stringify(old.doc));
  });

  it('更新的版本做的也留下（不让这一版的自动保存盖掉）', async () => {
    const io = memoryBackupIo();
    io.autosave = saved(DOC_VERSION + 2);
    const [b] = await keepStaleAutosaves(io, 1);
    expect(b).toMatchObject({ age: 'newer', version: DOC_VERSION + 2 });
    expect(io.autosave).toBeNull();
  });

  it('localStorage 后备里的：放进 backups，原来的键去掉', async () => {
    const io = memoryBackupIo();
    const old = saved(DOC_VERSION - 3, 900);
    io.storage.set(AUTOSAVE_KEY, JSON.stringify(old));
    const kept = await keepStaleAutosaves(io, 2000);
    expect(kept.length).toBe(1);
    expect(io.storage.has(AUTOSAVE_KEY)).toBe(false);
    expect(io.table.size).toBe(1);
    expect(backupFileText((await listBackups(io))[0])).toBe(JSON.stringify(old.doc));
  });

  it('两处都有旧的：两份都留下，编号不重', async () => {
    const io = memoryBackupIo();
    io.autosave = saved(DOC_VERSION - 1, 1000);
    io.storage.set(AUTOSAVE_KEY, JSON.stringify(saved(DOC_VERSION - 2, 1000)));
    const kept = await keepStaleAutosaves(io, 2000);
    expect(kept.map((b) => b.id)).toEqual(['b1000', 'b1000-2']);
    expect((await listBackups(io)).map((b) => b.version).sort()).toEqual([DOC_VERSION - 2, DOC_VERSION - 1]);
  });

  it('IndexedDB 用不了（隐私模式）：localStorage 里的换一个键留着，新的自动保存写原来的键也盖不到', async () => {
    const io = memoryBackupIo();
    io.idbDown = true;
    const old = saved(DOC_VERSION - 1, 700);
    const raw = JSON.stringify(old);
    io.storage.set(AUTOSAVE_KEY, raw);
    // 放得下一份多一点，放不下两份：也要挪得成
    io.quota = raw.length + 400;
    const kept = await keepStaleAutosaves(io, 2000);
    expect(kept.length).toBe(1);
    expect(io.storage.has(AUTOSAVE_KEY)).toBe(false);
    expect(io.storage.has(`${LOCAL_BACKUP_PREFIX}b700`)).toBe(true);
    const list = await listBackups(io);
    expect(list.length).toBe(1);
    expect(backupFileText(list[0])).toBe(JSON.stringify(old.doc));
    // 实在写不进去（一点空也没有）：放回原处，写后备的自动保存之前查得到，不盖它
    const io2 = memoryBackupIo();
    io2.idbDown = true;
    io2.storage.set(AUTOSAVE_KEY, raw);
    io2.quota = raw.length;
    expect(await keepStaleAutosaves(io2, 2000)).toEqual([]);
    expect(io2.storage.get(AUTOSAVE_KEY)).toBe(raw);
    expect(staleLocalAutosave(io2.local())).toBe(true);
    expect(staleLocalAutosave(io.local())).toBe(false);
  });

  it('这一版的自动保存、坏了的、不是世界文件的：不动', async () => {
    const io = memoryBackupIo();
    io.autosave = saved(DOC_VERSION);
    io.storage.set(AUTOSAVE_KEY, '{坏了');
    expect(await keepStaleAutosaves(io, 1)).toEqual([]);
    expect(io.autosave).not.toBeNull();
    expect(io.storage.get(AUTOSAVE_KEY)).toBe('{坏了');
    expect(await listBackups(io)).toEqual([]);
  });

  it('删除、关掉提示：删了就没有；关掉提示只记一笔，还在', async () => {
    const io = memoryBackupIo();
    io.autosave = saved(DOC_VERSION - 1, 100);
    await keepStaleAutosaves(io, 200);
    io.idbDown = true;
    io.storage.set(AUTOSAVE_KEY, JSON.stringify(saved(DOC_VERSION - 1, 300)));
    await keepStaleAutosaves(io, 400);
    io.idbDown = false;
    let list = await listBackups(io);
    expect(list.map((b) => b.id)).toEqual(['b300', 'b100']);
    await markSeen(io, ['b300', 'b100']);
    list = await listBackups(io);
    expect(list.map((b) => b.seen)).toEqual([true, true]);
    expect(list.every((b) => !!b.doc)).toBe(true);
    await removeBackup(io, 'b300');
    await removeBackup(io, 'b100');
    expect(await listBackups(io)).toEqual([]);
  });

  it('文件名写着日期和版本', () => {
    expect(backupFileName({ savedAt: new Date(2026, 10, 9, 8).getTime(), version: 21 })).toBe('旧世界 2026-11-09 第21版.json');
    expect(backupFileName({ savedAt: new Date(2026, 0, 2).getTime(), version: null })).toBe('旧世界 2026-01-02.json');
  });
});

describe('界面读的那一份', () => {
  it('启动时挪一次并列出来；关掉提示以后还列着；删除以后没有', async () => {
    const io = memoryBackupIo();
    io.autosave = saved(DOC_VERSION - 1, 100);
    useBackupIo(io);
    expect(backups.value).toBeNull();
    await keepStaleOnce();
    expect(backups.value).toEqual([infoOf((await listBackups(io))[0])]);
    expect(backups.value![0].seen).toBeUndefined();
    // 这一次打开页面只挪一次
    io.autosave = saved(DOC_VERSION - 1, 150);
    await keepStaleOnce();
    expect(backups.value!.length).toBe(1);
    await dismissBackups();
    expect(backups.value![0].seen).toBe(true);
    expect((await listBackups(io))[0].seen).toBe(true);
    // 再启动：还列着，记着关过提示
    useBackupIo(io);
    await keepStaleOnce();
    expect(backups.value!.map((b) => [b.id, b.seen])).toEqual([
      ['b150', undefined],
      ['b100', true],
    ]);
    await deleteBackup('b100');
    await deleteBackup('b150');
    expect(backups.value).toEqual([]);
  });

  it('存储都用不了时：当没有，不报错', async () => {
    const io = memoryBackupIo();
    io.idbDown = true;
    io.local = () => {
      throw new Error('no storage');
    };
    useBackupIo(io);
    await keepStaleOnce();
    expect(backups.value).toEqual([]);
  });
});

describe('IndexedDB 的库', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('第 7 版：多一张 backups；升级只补缺的表，已有的表不动', async () => {
    expect(DB_VERSION).toBe(7);
    expect(DB_STORES).toContain('backups');
    // 从第 6 版升上来：七张表都在
    const have = new Set(['kv', 'autosave', 'checkpoint', 'packs', 'meshes', 'maps', 'mapDocs']);
    const created: string[] = [];
    const deleted: string[] = [];
    const db = {
      objectStoreNames: { contains: (n: string) => have.has(n) },
      createObjectStore: (n: string) => void (created.push(n), have.add(n)),
      deleteObjectStore: (n: string) => void deleted.push(n),
      close: () => {},
      onversionchange: null as (() => void) | null,
    };
    const req = { result: db, error: null, onsuccess: null as (() => void) | null, onerror: null, onblocked: null, onupgradeneeded: null as (() => void) | null };
    let asked = 0;
    vi.stubGlobal('indexedDB', {
      open: (_name: string, version: number) => {
        asked = version;
        return req;
      },
    });
    const p = openDb();
    req.onupgradeneeded!();
    req.onsuccess!();
    await p;
    expect(asked).toBe(7);
    expect(created).toEqual(['backups']);
    expect(deleted).toEqual([]);
  });
});
