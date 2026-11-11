import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MemoryDisk, diskRaw, memoryAutosaveIo, memoryDisk, wholeDoc } from '../autosave-io';
import { AutosaveWriter } from '../autosave-io';
import { type MemoryLocks, SaveRole, memoryLocks } from '../autosave-lock';
import { FakeEngineWorker, docOf, nameCmd, tick, workerControl } from '../testing/fake-engine-worker';

// 第九十四轮：自动保存接起来的那一层（state/autosave.ts）——计算 Worker 换成假的（带命令记录），存储和锁换成内存里的。
// 这个文件就是“一个页面”；“另一个页面”是直接用 AutosaveWriter + SaveRole 搭的一份，和它共用同一个存储、同一把锁

vi.mock('../idb', () => ({
  openDb: () => Promise.reject(new Error('没有 IndexedDB')),
  idbTx: () => Promise.reject(new Error('没有 IndexedDB')),
  idbGet: () => Promise.reject(new Error('没有 IndexedDB')),
  idbAll: () => Promise.reject(new Error('没有 IndexedDB')),
  kvGet: async () => undefined,
  kvPut: async () => {},
  kvDelete: async () => {},
}));
const storage = new Map<string, string>();
let localFail: unknown = null;
vi.stubGlobal('localStorage', {
  get length() {
    return storage.size;
  },
  key: (k: number) => [...storage.keys()][k] ?? null,
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (localFail) throw localFail;
    storage.set(k, v);
  },
  removeItem: (k: string) => void storage.delete(k),
});
vi.stubGlobal('Worker', FakeEngineWorker);

const { autosaveNow, autosaved, exec, flushNow, loadDoc, saveFail, saveProblem, saveRole, takeOverSaving, undo, unsaved } = await import('../state');
const { useAutosaveIo, AUTOSAVE_MS } = await import('./autosave');
const { backups, useBackupIo } = await import('./backups');
const { memoryBackupIo } = await import('../backups');

const quota = () => Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
const stored = (disk: MemoryDisk) => diskRaw(disk)?.doc as { commands: unknown[] } | undefined;
const whole = (disk: MemoryDisk) => !!disk.head && wholeDoc(disk.head, stored(disk)!.commands);
// 这个页面现在的世界（假 Worker 里的命令）
const mine = () => FakeEngineWorker.last.done.map((h) => h.cmd);

// “另一个页面”
function otherPage(disk: MemoryDisk, locks: MemoryLocks, id = '另一页') {
  const lock = locks.page();
  let doc = docOf();
  const writer: AutosaveWriter = new AutosaveWriter(memoryAutosaveIo(disk), id, false, {});
  const role = new SaveRole(lock, id, {
    changed: (r) => {
      if (r === 'other') writer.yield();
      else if (r === 'writer') writer.holder = true;
    },
    canPromote: () => writer.canPromote({ ...doc, ids: doc.commands.map((_, k) => k + 1), key: id }),
  });
  const save = async () => {
    const once = () => {
      const base = writer.savedIds;
      const ids = doc.commands.map((_, k) => k + 1);
      let from = 0;
      while (from < base.length && from < ids.length && base[from] === ids[from]) from++;
      const { commands, ...head } = doc;
      return writer.write({ ...head, from, commands: commands.slice(from), ids }, {}, { base, key: id });
    };
    const out = await once();
    return out.kind === 'again' ? once() : out;
  };
  return {
    writer,
    role,
    save,
    set: (d: typeof doc) => (doc = d),
    close: () => lock.close(),
  };
}

let disk: MemoryDisk;
let locks: MemoryLocks;
beforeEach(() => {
  disk = memoryDisk();
  locks = memoryLocks();
  storage.clear();
  localFail = null;
  workerControl.reset();
  useBackupIo(memoryBackupIo());
});
afterEach(async () => {
  await autosaveNow().catch(() => {});
});

describe('一个页面', () => {
  it('打开世界以后过一会儿自己写；改一步有没存的改动，写完就没有；只写变了的', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    expect(await loadDoc(docOf([nameCmd(1)]))).toBe(true);
    expect(unsaved.value).toBe(true);
    await vi.waitFor(() => expect(disk.commits).toBe(1), { timeout: AUTOSAVE_MS + 30000, interval: 50 });
    expect(stored(disk)!.commands).toEqual(mine());
    await vi.waitFor(() => expect(unsaved.value).toBe(false), { timeout: 20000, interval: 10 });
    expect(saveRole.value).toBe('writer');
    expect(saveProblem.value).toBeNull();
    expect(autosaved.value).toBe(disk.head!.savedAt);
    // 改一步
    const rows = new Map(disk.rows);
    await exec(nameCmd(2));
    expect(unsaved.value).toBe(true);
    await autosaveNow();
    expect(unsaved.value).toBe(false);
    expect(stored(disk)!.commands).toEqual(mine());
    for (const [k, v] of rows) expect(disk.rows.get(k)).toBe(v);
    // 撤销
    await undo();
    expect(unsaved.value).toBe(true);
    await autosaveNow();
    expect(stored(disk)!.commands).toEqual(mine());
    expect(disk.rows.size).toBe(mine().length);
    expect(unsaved.value).toBe(false);
  });

  it('计算程序里还有没应答的编辑：算有没存的改动', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    await autosaveNow();
    expect(unsaved.value).toBe(false);
    workerControl.holdExec = true;
    const p = exec(nameCmd(3));
    expect(unsaved.value).toBe(true);
    await tick();
    expect(unsaved.value).toBe(true);
    workerControl.holdExec = false;
    workerControl.release();
    await p;
    await autosaveNow();
    expect(unsaved.value).toBe(false);
  });

  it('关页面的那一下：刚改的一步不等 Worker、同步写下；之后平常那一次只核对', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    await autosaveNow();
    expect(flushNow()).toBe('nothing');
    await exec(nameCmd(4));
    await exec(nameCmd(5));
    const kinds = FakeEngineWorker.kinds().length;
    expect(flushNow()).toBe('sent');
    // 同步：没有问 Worker，已经在存储里了
    expect(FakeEngineWorker.kinds().length).toBe(kinds);
    expect(stored(disk)!.commands).toEqual(mine());
    expect(whole(disk)).toBe(true);
    const rows = new Map(disk.rows);
    await autosaveNow();
    expect(stored(disk)!.commands).toEqual(mine());
    for (const [k, v] of rows) expect(disk.rows.get(k)).toBe(v);
    expect(unsaved.value).toBe(false);
  });

  it('换了一个世界还没轮到平常那一次就关页面：整份写新的，不接在旧世界的下标后面', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf([nameCmd('旧1'), nameCmd('旧2'), nameCmd('旧3')]));
    await autosaveNow();
    await loadDoc(docOf([nameCmd('新')]));
    expect(flushNow()).toBe('sent');
    expect(stored(disk)!.commands).toEqual(mine());
    expect(disk.rows.size).toBe(mine().length);
    expect(whole(disk)).toBe(true);
  });

  it('还没写成过就关页面：同步写不了，走平常那条路', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    expect(flushNow()).toBe('cannot');
    await autosaveNow();
    expect(stored(disk)!.commands).toEqual(mine());
  });
});

describe('没存成：原因一直在，存成了才清', () => {
  it('存储满了、不可用、世界太大各是一种；下一次成功了就没有', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    await autosaveNow();
    expect(saveFail.value).toBeNull();
    // 存储满了（退回的小地方也写不进）
    await exec(nameCmd(1));
    disk.full = true;
    localFail = quota();
    await autosaveNow();
    expect(saveFail.value).toBe('quota');
    expect(saveProblem.value).toBe('quota');
    expect(unsaved.value).toBe(true);
    // 还是不行：原因还在
    await exec(nameCmd(2));
    await autosaveNow();
    expect(saveFail.value).toBe('quota');
    // 腾出地方：下一次写成，记号消失
    disk.full = false;
    localFail = null;
    await autosaveNow();
    expect(saveFail.value).toBeNull();
    expect(saveProblem.value).toBeNull();
    expect(unsaved.value).toBe(false);
    expect(stored(disk)!.commands).toEqual(mine());
    // 浏览器存储不可用（隐私模式）：退回 localStorage 也不让写
    await exec(nameCmd(3));
    disk.down = true;
    localFail = Object.assign(new Error('不让用'), { name: 'SecurityError' });
    await autosaveNow();
    expect(saveFail.value).toBe('unavailable');
    // 存储不可用、退回的小地方放不下：世界太大
    localFail = quota();
    await autosaveNow();
    expect(saveFail.value).toBe('too-big');
    // 退回的小地方放得下：算存成了
    localFail = null;
    await autosaveNow();
    expect(saveFail.value).toBeNull();
    expect(JSON.parse(storage.get('map2.autosave')!).doc.commands).toEqual(mine());
    expect(unsaved.value).toBe(false);
  });
});

describe('两个页面', () => {
  it('这个世界已在另一个页面打开：这个页面不写，一直说着；那个页面存的不受影响', async () => {
    const a = otherPage(disk, locks);
    await a.role.start();
    await a.save();
    const was = structuredClone(stored(disk));
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf([nameCmd('这一页')]));
    await autosaveNow();
    expect(saveRole.value).toBe('other');
    expect(saveProblem.value).toBe('other-page');
    await exec(nameCmd('这一页2'));
    const kinds = FakeEngineWorker.kinds().length;
    await autosaveNow();
    // 不写，也不去问 Worker
    expect(FakeEngineWorker.kinds().length).toBe(kinds);
    expect(flushNow()).toBe('cannot');
    expect(stored(disk)).toEqual(was);
    expect(unsaved.value).toBe(true);
    a.close();
  });

  it('“在这里接着做”：这个页面整份写下，那个页面存的不一样的世界先留着；那个页面不再写', async () => {
    const io = memoryBackupIo();
    useBackupIo(io);
    const a = otherPage(disk, locks);
    await a.role.start();
    a.set(docOf([nameCmd('那一页1'), nameCmd('那一页2')]));
    await a.save();
    const was = structuredClone(stored(disk));
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf([nameCmd('这一页')]));
    await autosaveNow();
    expect(saveProblem.value).toBe('other-page');
    await takeOverSaving();
    expect(saveRole.value).toBe('writer');
    expect(saveProblem.value).toBeNull();
    expect(stored(disk)!.commands).toEqual(mine());
    expect(whole(disk)).toBe(true);
    expect(unsaved.value).toBe(false);
    const kept = [...disk.backups.values()];
    expect(kept.map((b) => [b.why, b.doc])).toEqual([['other-page', was]]);
    // 那个页面知道了，不再写
    await vi.waitFor(() => expect(a.role.role).toBe('other'), { timeout: 20000, interval: 10 });
    a.set(docOf([nameCmd('那一页1'), nameCmd('那一页2'), nameCmd('那一页3')]));
    expect(await a.save()).toEqual({ kind: 'other' });
    expect(stored(disk)!.commands).toEqual(mine());
    // 这个页面接着改：照常只写变了的
    await exec(nameCmd('这一页2'));
    await autosaveNow();
    expect(stored(disk)!.commands).toEqual(mine());
    expect(disk.backups.size).toBe(1);
    a.close();
  });

  it('那个页面把写的权利拿回去：这个页面不再写，说着', async () => {
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    await autosaveNow();
    expect(saveRole.value).toBe('writer');
    const a = otherPage(disk, locks);
    await a.role.start();
    expect(a.role.role).toBe('other');
    await a.role.take();
    a.writer.claim();
    await vi.waitFor(() => expect(saveRole.value).toBe('other'), { timeout: 20000, interval: 10 });
    expect(saveProblem.value).toBe('other-page');
    await exec(nameCmd(1));
    const before = structuredClone(stored(disk));
    await autosaveNow();
    expect(stored(disk)).toEqual(before);
    a.close();
  });

  it('那个页面关了：存着的就是这一页的开头，不用问就接着写', async () => {
    const a = otherPage(disk, locks);
    await a.role.start();
    await a.save();
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    await exec(nameCmd('这一页'));
    await autosaveNow();
    expect(saveRole.value).toBe('other');
    a.close();
    await vi.waitFor(() => expect(saveRole.value).toBe('writer'), { timeout: 20000, interval: 10 });
    await vi.waitFor(() => expect(stored(disk)!.commands).toEqual(mine()), { timeout: AUTOSAVE_MS + 30000, interval: 50 });
    expect(disk.backups.size).toBe(0);
    expect(saveProblem.value).toBeNull();
  });

  it('那个页面后来又做了几步才关：这一页是旧的，不自己接（不拿旧的盖新的），还说着；点了才接，那一份先留着', async () => {
    const a = otherPage(disk, locks);
    await a.role.start();
    await a.save();
    useAutosaveIo(memoryAutosaveIo(disk), locks.page());
    await loadDoc(docOf());
    await autosaveNow();
    a.set(docOf([nameCmd('那一页后来做的')]));
    await a.save();
    const was = structuredClone(stored(disk));
    a.close();
    // 轮到过这一页（拿到锁、看了一眼不能接）：锁又放开了（没有占着不写）
    await vi.waitFor(() => expect(locks.holder()).toBe(-1), { timeout: 20000, interval: 10 });
    await tick(30);
    // 第九十五轮：那一页已经关了——不再说“已在另一个页面打开”，说“这个页面里的是旧的”（主要的按钮是“重新载入”）
    expect(saveRole.value).toBe('stale');
    expect(saveProblem.value).toBe('stale-page');
    expect(stored(disk)).toEqual(was);
    expect(locks.holder()).toBe(-1);
    await takeOverSaving();
    expect(saveRole.value).toBe('writer');
    expect(saveProblem.value).toBeNull();
    expect(stored(disk)!.commands).toEqual(mine());
    expect([...disk.backups.values()].map((b) => b.doc)).toEqual([was]);
    expect(backups.value).not.toBeNull();
  });
});
