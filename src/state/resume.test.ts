import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryAutosaveIo, memoryDisk, diskRaw, type MemoryDisk } from '../autosave-io';
import { scriptHash } from '../../core/script';
import { type Species, withRect } from '../../core/species';
import type { Command } from '../../core/commands';
import { FakeEngineWorker, docOf, nameCmd, workerControl } from '../testing/fake-engine-worker';

// 第九十四轮：上次的世界没能打开时先问，不直接进向导；那一份自动保存在被新世界盖掉之前原样留进“留着的旧世界”。
// 计算 Worker 是假的（能装“打开出错”），自动保存的存储是内存里的

vi.mock('../idb', () => ({
  openDb: () => Promise.reject(new Error('没有 IndexedDB')),
  idbTx: () => Promise.reject(new Error('没有 IndexedDB')),
  idbGet: () => Promise.reject(new Error('没有 IndexedDB')),
  idbAll: () => Promise.reject(new Error('没有 IndexedDB')),
  kvGet: async (k: string) => structuredClone(kv.get(k)),
  kvPut: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
  kvDelete: async (k: string) => void kv.delete(k),
}));
const kv = new Map<string, unknown>();
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return storage.size;
  },
  key: (k: number) => [...storage.keys()][k] ?? null,
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});
vi.stubGlobal('Worker', FakeEngineWorker);
// 导出文件：记下下载了什么
const downloads: { name: string; text: string }[] = [];
vi.mock('./export-host', async (orig) => ({
  ...(await orig<typeof import('./export-host')>()),
  download: (name: string, data: string) => void downloads.push({ name, text: data }),
}));

const { ask, autosaveNow, newWorld, resumeLast, safeMode, toast, unsaved, world } = await import('../state');
const { useAutosaveIo } = await import('./autosave');
const { RESUME_FAILED: T, resumeFileName } = await import('./open');
const { backups, useBackupIo } = await import('./backups');
const { memoryBackupIo } = await import('../backups');
const { backupNotice } = await import('../ui/maps/backups');

const species = (id: string, src: string): Species =>
  withRect({ id, name: `生态${id}`, color: '#336699', terrain: 'plains', competition: 2, tolerances: [], scripts: { placement: { api: 1 as const, src } } }, { t0: -40, t1: 40, m0: 0, m1: 50 });

// 上一次打开页面时写下的自动保存
function lastTime(disk: MemoryDisk, extra: Command[], savedAt = 1234) {
  const doc = docOf(extra);
  const { commands, ...head } = doc;
  disk.head = { ...head, savedAt, count: commands.length, writer: '上一次', gen: 3 };
  commands.forEach((c, k) => disk.rows.set(k, c));
  return doc;
}

let disk: MemoryDisk;
beforeEach(() => {
  disk = memoryDisk();
  storage.clear();
  kv.clear();
  downloads.length = 0;
  workerControl.reset();
  useBackupIo(memoryBackupIo());
  // 读自动保存走的是浏览器那条路（这里没有 IndexedDB）：把内存里的那一份放在 localStorage 的后备上给它读，写走内存里的存储
  useAutosaveIo(memoryAutosaveIo(disk), null);
});
afterEach(async () => {
  ask.value?.resolve('cancel');
  await autosaveNow().catch(() => {});
});

// 等下一个问话出来（机器忙时不靠数几轮计时器）：prev 是上一个问话（同一个标题再问一次时认新的那一个）
type AskNow = NonNullable<typeof ask.value>;
const nextAsk = (prev: AskNow | null = null): Promise<AskNow> =>
  vi.waitFor(
    () => {
      const a = ask.value;
      if (!a || a === prev) throw new Error('问话还没出来');
      return a;
    },
    { timeout: 30000, interval: 10 },
  );

// resumeLast 读的是后备的位置：这里把同一份放过去（IndexedDB 那条读的路在 autosave-backups.test.ts 里测）
const expose = (doc: unknown, savedAt = 1234) => storage.set('map2.autosave', JSON.stringify({ savedAt, doc }));

describe('上次的世界没能打开', () => {
  it('不进向导、不闪一下就过去：停在问话上，写着原因；它还在原处', async () => {
    const doc = lastTime(disk, [nameCmd(1), nameCmd(2)]);
    expose(doc);
    workerControl.loadError = '重放第 3 步出错：找不到生态';
    const p = resumeLast();
    const a = await nextAsk();
    expect(a.title).toBe('上次的世界没能打开');
    expect(a.text).toContain('没有丢');
    // 原因原样的一行
    expect(a.note).toEqual({ label: '原因', text: '重放第 3 步出错：找不到生态' });
    expect(a.choices.map((c) => c.label)).toEqual(['再试一次', '导出文件', '新建']);
    expect(a.choices.find((c) => c.primary)!.label).toBe('再试一次');
    // 没有另外弹出错的提示条
    expect(toast.value).toBeNull();
    expect(world.value).toBeNull();
    expect(diskRaw(disk)!.doc).toEqual(doc);
    a.resolve('new');
    expect(await p).toBe(false);
    expect(diskRaw(disk)!.doc).toEqual(doc);
  });

  it('“再试一次”：这次打开了，就是原来那个世界；不算有没存的改动；没有留下多余的一份', async () => {
    const doc = lastTime(disk, [nameCmd(1)]);
    expose(doc);
    workerControl.loadError = '计算程序出错';
    workerControl.loadErrorTimes = 2;
    const p = resumeLast();
    const first = await nextAsk();
    first.resolve('retry');
    // 还是不行：再问
    const second = await nextAsk(first);
    expect(second.title).toBe(T.title);
    second.resolve('retry');
    expect(await p).toBe(true);
    expect(FakeEngineWorker.last.done.map((h) => h.cmd)).toEqual(doc.commands);
    expect(unsaved.value).toBe(false);
    await autosaveNow();
    expect(backups.value ?? []).toEqual([]);
  });

  it('“导出文件”：下载的就是那份世界文件，一字不差；之后接着问', async () => {
    const doc = lastTime(disk, [nameCmd(1)], new Date(2026, 10, 11, 9, 0).getTime());
    expose(doc, new Date(2026, 10, 11, 9, 0).getTime());
    workerControl.loadError = '出错';
    const p = resumeLast();
    const first = await nextAsk();
    first.resolve('export');
    const second = await nextAsk(first);
    expect(downloads).toEqual([{ name: '上次的世界 2026-11-11.json', text: JSON.stringify(doc) }]);
    expect(resumeFileName(new Date(2026, 0, 2).getTime())).toBe('上次的世界 2026-01-02.json');
    expect(second.title).toBe(T.title);
    expect(second.text).toBe(T.exported);
    second.resolve('cancel');
    expect(await p).toBe(false);
  });

  it('有脚本时多一个“用安全模式打开”：脚本不运行地打开', async () => {
    const sp = species('s', 'return 0.4;');
    const doc = lastTime(disk, [{ op: 'add_species', species: sp }]);
    expose(doc);
    // 信任过的脚本（不再问信任）
    kv.set('trustedScripts', [scriptHash('return 0.4;')]);
    workerControl.loadError = '脚本出错';
    workerControl.loadErrorTimes = 1;
    const p = resumeLast();
    let a = await nextAsk();
    if (a.title !== T.title) {
      // 没认出信任：先过信任的问话
      const trust = a;
      trust.resolve('run');
      a = await nextAsk(trust);
    }
    expect(a.title).toBe(T.title);
    expect(a.choices.map((c) => c.label)).toEqual(['再试一次', '用安全模式打开', '导出文件', '新建']);
    a.resolve('safe');
    expect(await p).toBe(true);
    expect(FakeEngineWorker.kinds().at(-1)).toBe('load(safe)');
    expect(safeMode.value).toEqual({ reason: '上次的世界没能打开' });
  });

  it('选了“新建”：新世界第一次自动保存之前，那一份原样挪进“留着的旧世界”，写着没能打开和原因', async () => {
    const doc = lastTime(disk, [nameCmd(1), nameCmd(2)]);
    expose(doc);
    workerControl.loadError = '重放出错';
    const p = resumeLast();
    (await nextAsk()).resolve('new');
    expect(await p).toBe(false);
    // 向导里新建
    expect(await newWorld(docOf().settings, [nameCmd('新世界')])).toBe(true);
    await autosaveNow();
    expect((diskRaw(disk)!.doc as { commands: unknown[] }).commands).toEqual([nameCmd('新世界')]);
    const kept = [...disk.backups.values()];
    expect(kept.length).toBe(1);
    expect(kept[0]).toMatchObject({ why: 'failed', error: '重放出错', savedAt: 1234, steps: doc.commands.length });
    expect(kept[0].doc).toEqual(doc);
    // 再写几次：不会再留第二份
    await autosaveNow();
    expect(disk.backups.size).toBe(1);
  });
});

describe('用户自己取消了（不信任脚本）', () => {
  it('不算打不开：不问“没能打开”，照旧进向导；之后新建，那一份在被盖掉之前也留着', async () => {
    const sp = species('c', 'return 0.9;');
    const doc = lastTime(disk, [{ op: 'add_species', species: sp }]);
    expose(doc);
    const p = resumeLast();
    const trust = await nextAsk();
    expect(trust.title).toBe('世界里的脚本');
    trust.resolve('cancel');
    expect(await p).toBe(false);
    expect(ask.value).toBeNull();
    expect(diskRaw(disk)!.doc).toEqual(doc);
    expect(await newWorld(docOf().settings, [nameCmd('新世界')])).toBe(true);
    await autosaveNow();
    const kept = [...disk.backups.values()];
    expect(kept.map((b) => [b.why, b.doc])).toEqual([['cancelled', doc]]);
  });
});

describe('界面上的那一条', () => {
  it('留下来以后说“上次的世界没能打开。它还留着”', () => {
    expect(backupNotice([{ id: 'b', keptAt: 2, savedAt: 1, version: 22, age: 'current', why: 'failed', steps: 3 }])!.text).toBe('上次的世界没能打开。它还留着');
  });
});
