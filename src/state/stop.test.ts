import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diskRaw, memoryAutosaveIo, memoryDisk, type MemoryDisk } from '../autosave-io';
import type { Command } from '../../core/commands';
import { OPEN_GUARD_KEY } from '../open-guard';
import { STOPPED_BACK } from '../sandbox';
import { FakeEngineWorker, docOf, nameCmd, tick, workerControl } from '../testing/fake-engine-worker';

// 第九十六轮：计算程序不应答时——能导出、能保存（用主线程手上的命令记录）；什么请求都能停，世界回到这一步之前；
// 启动时打开上次的世界也能停，连着两次没打开成下次先问。计算 Worker 是假的（能装“卡住了，什么都不回”），存储是内存里的

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
const downloads: { name: string; text: string }[] = [];
vi.mock('./export-host', async (orig) => ({
  ...(await orig<typeof import('./export-host')>()),
  download: (name: string, data: string) => void downloads.push({ name, text: data }),
}));

const { ask, autosaveNow, busy, canRedo, docNow, exec, newWorld, resumeLast, stalled, stopBusy, toast, undo, unsaved, world, worldState } = await import('../state');
const { useAutosaveIo } = await import('./autosave');
const { currentHost, docWait, docTailNow } = await import('./worker-host');
const { openSettle } = await import('./open');
const { useBackupIo } = await import('./backups');
const { memoryBackupIo } = await import('../backups');
const { exportCurrent, BEHIND_NOTE } = await import('../ui/maps/store');
const { OPEN_TWICE_TEXT, STOP_TEXT } = await import('../crash-text');

let disk: MemoryDisk;
beforeEach(() => {
  disk = memoryDisk();
  storage.clear();
  kv.clear();
  downloads.length = 0;
  workerControl.reset();
  toast.value = null;
  docWait.ms = 40;
  openSettle.ms = 20;
  useBackupIo(memoryBackupIo());
  useAutosaveIo(memoryAutosaveIo(disk), null);
});
afterEach(async () => {
  workerControl.reset();
  ask.value?.resolve('cancel');
  stopBusy();
  await tick();
  await autosaveNow().catch(() => {});
});

const mirrorDoc = () => currentHost()!.mirror.doc()!;
const cmds = (extra: Command[]) => docOf(extra).commands;

// 一个开着的世界，做了一步
async function opened(extra: Command[] = [nameCmd(1)]) {
  expect(await newWorld(docOf().settings, cmds(extra))).toBe(true);
  await autosaveNow();
  expect(unsaved.value).toBe(false);
}

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
function lastTime(extra: Command[], savedAt = 1234) {
  const doc = docOf(extra);
  const { commands, ...head } = doc;
  disk.head = { ...head, savedAt, count: commands.length, writer: '上一次', gen: 3 };
  commands.forEach((c, k) => disk.rows.set(k, c));
  storage.set('map2.autosave', JSON.stringify({ savedAt, doc }));
  return doc;
}

describe('计算程序卡住时也能导出、能保存', () => {
  it('没有在算的：命令记录就是现在的世界，不问计算程序', async () => {
    await opened();
    const asked = FakeEngineWorker.kinds().length;
    const got = (await docNow())!;
    expect(got.behind).toBe(false);
    expect(got.doc.commands).toEqual(cmds([nameCmd(1)]));
    expect(FakeEngineWorker.kinds().length).toBe(asked);
  });

  it('在算的一步很快算完：等到了，那一步在里面', async () => {
    await opened();
    workerControl.holdExec = true;
    const done = exec(nameCmd(2), '改名');
    setTimeout(() => workerControl.release(), 5);
    const got = (await docNow(2000))!;
    expect(got.behind).toBe(false);
    expect(got.doc.commands).toEqual(cmds([nameCmd(1), nameCmd(2)]));
    await done;
  });

  it('卡住了：几十毫秒内拿到世界文件——到最后一条应答过的命令为止，并且说明还在算的那一步不在里面', async () => {
    await opened();
    workerControl.holdAll = true;
    void exec(nameCmd(2), '改名');
    await tick(2);
    const t0 = Date.now();
    const got = (await docNow())!;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(got.behind).toBe(true);
    expect(got.doc.commands).toEqual(cmds([nameCmd(1)]));
    // “导出文件”：下载的就是这一份，原样（卡着时不去整理），顶上说一句
    await exportCurrent();
    expect(downloads.length).toBe(1);
    expect(JSON.parse(downloads[0].text)).toEqual(JSON.parse(JSON.stringify(docOf([nameCmd(1)]))));
    expect(toast.value).toEqual({ text: `已导出。${BEHIND_NOTE}`, error: false });
  });

  it('卡住了自动保存照样写：已经应答的每一步都存下去，不会一直等着', async () => {
    await opened();
    // 又做成一步（还没到自动保存的时候）
    await exec(nameCmd(2), '改名');
    expect(unsaved.value).toBe(true);
    // 然后卡住了：这一步没应答
    workerControl.holdAll = true;
    void exec(nameCmd(3), '改名');
    await tick(2);
    const t0 = Date.now();
    await autosaveNow();
    expect(Date.now() - t0).toBeLessThan(1000);
    // 存下的是应答过的那两步（没算完的第三步不在）
    expect((diskRaw(disk)!.doc as { commands: unknown[] }).commands).toEqual(cmds([nameCmd(1), nameCmd(2)]));
    // 命令记录算的和计算程序给的是同一份：之后它活过来，照常接着只写变了的
    workerControl.holdAll = false;
    workerControl.release();
    await tick();
    await autosaveNow();
    expect((diskRaw(disk)!.doc as { commands: unknown[] }).commands).toEqual(cmds([nameCmd(1), nameCmd(2), nameCmd(3)]));
    expect(disk.backups.size).toBe(0);
    expect(unsaved.value).toBe(false);
  });

  it('docTailNow：计算程序回得来时用它的（顺带写检查点）；回不来时用命令记录，两份逐值相同', async () => {
    await opened([nameCmd(1), nameCmd(2)]);
    const a = (await docTailNow([]))!;
    expect(a.behind).toBe(false);
    workerControl.holdAll = true;
    const b = (await docTailNow([]))!;
    expect(b.behind).toBe(true);
    expect(b.tail).toEqual(a.tail);
    expect(b.key).toBe(a.key);
    const base = a.tail.ids.slice(0, 2);
    const c = (await docTailNow(base))!;
    expect(c.tail.from).toBe(2);
    expect(c.tail.commands).toEqual(a.tail.commands.slice(2));
  });
});

describe('什么请求都能停', () => {
  it('一步卡住了：停下——这一步没做，世界还在、回到这一步之前，说一句；之后照常能改', async () => {
    await opened();
    const before = mirrorDoc();
    const w0 = FakeEngineWorker.last;
    workerControl.holdAll = true;
    const stuck = exec(nameCmd(2), '改名');
    await tick(2);
    expect(busy.value).not.toBeNull();
    // 卡住的只是原来那个 Worker（它的那一步一直压着）；另开的那个照常
    workerControl.holdAll = false;
    expect(stopBusy()).toBe(true);
    await stuck;
    await vi.waitFor(() => expect(busy.value).toBeNull(), { timeout: 5000 });
    expect(w0.terminated).toBe(true);
    expect(FakeEngineWorker.last).not.toBe(w0);
    // 另开的那个打开的是这一步之前的世界
    expect(FakeEngineWorker.last.done.map((h) => h.cmd)).toEqual(before.commands);
    expect(world.value).not.toBeNull();
    expect(mirrorDoc()).toEqual(before);
    // 不当成报错说
    expect(toast.value).toEqual({ text: STOPPED_BACK, error: false });
    expect(stalled.value).toBe(false);
    // 接着改
    await exec(nameCmd(3), '改名');
    expect(mirrorDoc().commands).toEqual(cmds([nameCmd(1), nameCmd(3)]));
    await autosaveNow();
    expect((diskRaw(disk)!.doc as { commands: unknown[] }).commands).toEqual(cmds([nameCmd(1), nameCmd(3)]));
  });

  it('撤销过几步再停下：重做记录没了，添一句', async () => {
    await opened([nameCmd(1), nameCmd(2)]);
    await undo();
    canRedo.value = true;
    workerControl.holdAll = true;
    const stuck = exec(nameCmd(5), '改名');
    await tick(2);
    workerControl.holdAll = false;
    stopBusy();
    await stuck;
    expect(toast.value?.text).toBe(`${STOPPED_BACK}。重做记录已清空`);
  });

  it('没有在算的：停不了什么，世界不动', async () => {
    await opened();
    const state = worldState.value;
    const w = FakeEngineWorker.last;
    expect(stopBusy()).toBe(false);
    expect(w.terminated).toBe(false);
    expect(worldState.value).toBe(state);
  });

  it('新建到一半停下（原来开着一个世界）：回到原来的世界', async () => {
    await opened();
    const before = mirrorDoc();
    workerControl.holdOpen = true;
    const p = newWorld(docOf().settings, cmds([nameCmd('新的')]));
    await tick(3);
    workerControl.holdOpen = false;
    expect(stopBusy()).toBe(true);
    expect(await p).toBe(false);
    await vi.waitFor(() => expect(busy.value).toBeNull(), { timeout: 5000 });
    expect(mirrorDoc()).toEqual(before);
    expect(FakeEngineWorker.last.done.map((h) => h.cmd)).toEqual(before.commands);
    expect(toast.value).toEqual({ text: STOPPED_BACK, error: false });
  });
});

describe('启动时打开上次的世界', () => {
  it('能停：不问“没能打开”，进向导；那一份留在原处，新建以后在“留着的旧世界”里', async () => {
    const doc = lastTime([nameCmd(1), nameCmd(2)]);
    workerControl.holdOpen = true;
    const p = resumeLast();
    await vi.waitFor(() => expect(busy.value).toBe('正在打开世界…'), { timeout: 5000 });
    expect(stopBusy()).toBe(true);
    workerControl.holdOpen = false;
    expect(await p).toBe(false);
    expect(ask.value).toBeNull();
    expect(world.value === null || mirrorDoc() !== null).toBe(true);
    expect(toast.value).toEqual({ text: STOP_TEXT.openStopped, error: false });
    expect(diskRaw(disk)!.doc).toEqual(doc);
    // 记的那一笔没擦
    expect(JSON.parse(storage.get(OPEN_GUARD_KEY)!)).toMatchObject({ n: 1, saved: 1234 });
    expect(await newWorld(docOf().settings, cmds([nameCmd('新世界')]))).toBe(true);
    await autosaveNow();
    expect([...disk.backups.values()].map((b) => [b.why, b.doc])).toEqual([['cancelled', doc]]);
  });

  it('连着两次没打开成（被停下、页面出了问题）：第三次先问，不直接打开；再试一次打开了就不再问', async () => {
    const doc = lastTime([nameCmd(1)]);
    // 前两次：动手了，没成（这里直接写下那两笔，和页面崩了留下的一样）
    storage.set(OPEN_GUARD_KEY, JSON.stringify({ n: 2, saved: 1234, at: 1 }));
    const sent = FakeEngineWorker.kinds().length;
    const p = resumeLast();
    const a = await nextAsk();
    expect(a.title).toBe(OPEN_TWICE_TEXT.title);
    expect(a.text).toContain('没有丢');
    expect(a.note).toBeUndefined();
    expect(a.choices.map((c) => c.label)).toEqual(['再试一次', '导出文件', '新建']);
    // 还没去打开
    expect(FakeEngineWorker.kinds().length).toBe(sent);
    // 先导出：就是那份世界文件；接着问
    a.resolve('export');
    const b = await nextAsk(a);
    expect(downloads.map((d) => d.text)).toEqual([JSON.stringify(doc)]);
    b.resolve('retry');
    expect(await p).toBe(true);
    expect(FakeEngineWorker.last.done.map((h) => h.cmd)).toEqual(doc.commands);
    // 打开以后过一会儿界面没坏：那几笔擦掉
    await vi.waitFor(() => expect(storage.has(OPEN_GUARD_KEY)).toBe(false), { timeout: 5000 });
  });

  it('先问的时候选了“新建”：那一份留着（写着连着两次没打开成），记的擦掉', async () => {
    const doc = lastTime([nameCmd(1)]);
    storage.set(OPEN_GUARD_KEY, JSON.stringify({ n: 3, saved: 1234, at: 1 }));
    const p = resumeLast();
    (await nextAsk()).resolve('new');
    expect(await p).toBe(false);
    expect(storage.has(OPEN_GUARD_KEY)).toBe(false);
    expect(await newWorld(docOf().settings, cmds([nameCmd('新世界')]))).toBe(true);
    await autosaveNow();
    expect([...disk.backups.values()].map((b) => [b.why, b.error, b.doc])).toEqual([['failed', OPEN_TWICE_TEXT.why, doc]]);
  });

  it('记的是别的一份自动保存：不问', async () => {
    lastTime([nameCmd(1)], 5555);
    storage.set(OPEN_GUARD_KEY, JSON.stringify({ n: 5, saved: 1234, at: 1 }));
    expect(await resumeLast()).toBe(true);
    expect(ask.value).toBeNull();
  });

  it('有原因的没打开（问过了）、用户取消：不留那一笔', async () => {
    lastTime([nameCmd(1)]);
    workerControl.loadError = '重放出错';
    const p = resumeLast();
    const a = await nextAsk();
    expect(storage.has(OPEN_GUARD_KEY)).toBe(false);
    a.resolve('new');
    expect(await p).toBe(false);
    expect(storage.has(OPEN_GUARD_KEY)).toBe(false);
  });

  it('原因里的英文翻成人话，原话折叠着留着', async () => {
    lastTime([nameCmd(1)]);
    workerControl.loadError = '第 7 条命令失败：命令参数无效：(根)：Invalid input';
    const p = resumeLast();
    const a = await nextAsk();
    expect(a.note).toEqual({ label: '原因', text: '第 7 步做不出来：这一步的内容格式不对', detail: '第 7 条命令失败：命令参数无效：(根)：Invalid input' });
    a.resolve('new');
    await p;
  });
});
