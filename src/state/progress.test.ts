import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryAutosaveIo, memoryDisk } from '../autosave-io';
import type { Command } from '../../core/commands';
import { PROGRESS_KEY } from '../progress';
import { FakeEngineWorker, docOf, nameCmd, tick, workerControl } from '../testing/fake-engine-worker';

// 第九十七轮：进度接到带提示的请求上（state/progress.ts）。短的一步什么都不显示；正在算的那一步过了“多久才显示”才有进度，
// 做完就没了；连着的几笔各算各的；做过一次的下一次按那一次真实的耗时估。计算 Worker 是假的（替它说“走到哪一步了”）

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
const fakeStorage = {
  get length() {
    return storage.size;
  },
  key: (k: number) => [...storage.keys()][k] ?? null,
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};
vi.stubGlobal('localStorage', fakeStorage);
vi.stubGlobal('Worker', FakeEngineWorker);

const { autosaveNow, busy, exec, newWorld, progressView, stopBusy, world } = await import('../state');
const { useAutosaveIo } = await import('./autosave');
const { currentHost, stallWait } = await import('./worker-host');
const { progressTiming, resetProgressBook } = await import('./progress');
const { useBackupIo } = await import('./backups');
const { memoryBackupIo } = await import('../backups');

const cmds = (extra: Command[]) => docOf(extra).commands;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function opened() {
  expect(await newWorld(docOf().settings, cmds([nameCmd(1)]))).toBe(true);
  await autosaveNow();
}

beforeEach(() => {
  storage.clear();
  workerControl.reset();
  progressTiming.showAfter = 60;
  progressTiming.tick = 10;
  progressTiming.margin = 20;
  progressTiming.extra = 60;
  stallWait.ms = 5000;
  resetProgressBook(fakeStorage);
  useBackupIo(memoryBackupIo());
  useAutosaveIo(memoryAutosaveIo(memoryDisk()), null);
});
afterEach(async () => {
  workerControl.reset();
  currentHost()?.stopAny();
  await tick();
  await autosaveNow().catch(() => {});
});

describe('久的一步才有进度', () => {
  it('马上做完的一步：一次都不显示', async () => {
    await opened();
    const seen: unknown[] = [];
    const stop = progressView.subscribe((v) => v && seen.push(v));
    await exec(nameCmd(2), '改名');
    await wait(100);
    stop();
    expect(seen).toEqual([]);
    expect(progressView.value).toBeNull();
  });

  it('做了一阵还没好：出现——先是没有步名（用请求自己的提示）；说了走到哪一步就换成那一步；只增不减；做完就没了', async () => {
    await opened();
    const w = FakeEngineWorker.last;
    workerControl.holdExec = true;
    const running = exec({ op: 'set_planet', patch: { humidity: 1.2 } }, '正在计算…');
    await tick(2);
    expect(progressView.value).toBeNull();
    await vi.waitFor(() => expect(progressView.value).not.toBeNull(), { timeout: 2000 });
    expect(progressView.value).toEqual({ step: null, fraction: 0, count: null, cancel: true });
    const seen: number[] = [];
    const stop = progressView.subscribe((v) => v && seen.push(v.fraction));
    for (const [k, step] of ['climate', 'water', 'habitat', 'features'].entries()) {
      w.stage(step, k + 1, 4);
      await wait(30);
      expect(progressView.value?.step).toBe(step);
    }
    stop();
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeGreaterThanOrEqual(seen[k - 1]);
    expect(seen.at(-1)).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeLessThan(1);
    workerControl.holdExec = false;
    workerControl.release();
    expect(await running).toBe(true);
    expect(progressView.value).toBeNull();
    expect(busy.value).toBeNull();
  });

  it('连着几笔、每一笔都按时算完：忙了很久也不显示（按正在算的这一步做了多久算）', async () => {
    await opened();
    const seen: unknown[] = [];
    const stop = progressView.subscribe((v) => v && seen.push(v));
    workerControl.holdExec = true;
    const all: Promise<boolean>[] = [];
    for (let k = 0; k < 8; k++) all.push(exec(nameCmd(10 + k), '改名'));
    // 每 25 毫秒算完一笔：一共忙了 200 毫秒，超过“多久才显示”的 60
    for (let k = 0; k < 8; k++) {
      await wait(25);
      workerControl.held.shift()?.send();
    }
    await Promise.all(all);
    stop();
    expect(seen).toEqual([]);
  });

  it('到了该显示的时候估着马上就好（已经走到最后一步）：再等一等，这期间做完了就一次都不显示；等过了还没好才显示', async () => {
    await opened();
    const w = FakeEngineWorker.last;
    const seen: unknown[] = [];
    const stop = progressView.subscribe((v) => v && seen.push(v));
    const run = () => {
      workerControl.holdExec = true;
      const p = exec({ op: 'set_planet', patch: { humidity: 1.2 } }, '正在计算…');
      // 很快走到了最后一步（前面几步都做完了）
      void tick(2).then(() => {
        for (const [k, step] of ['elevation', 'climate', 'water', 'habitat'].entries()) w.stage(step, k + 1, 5);
        setTimeout(() => w.stage('features', 5, 5), 30);
      });
      return p;
    };
    // 刚过“多久才显示”就做完：不闪
    const a = run();
    await wait(75);
    expect(seen).toEqual([]);
    workerControl.holdExec = false;
    workerControl.release();
    expect(await a).toBe(true);
    await wait(100);
    expect(seen).toEqual([]);
    // 等过了还没好：显示
    const b = run();
    await vi.waitFor(() => expect(progressView.value?.step).toBe('features'), { timeout: 2000 });
    workerControl.holdExec = false;
    workerControl.release();
    await b;
    stop();
  });

  it('前一笔算完、轮到的下一笔久了：从它轮到的时候算起', async () => {
    await opened();
    workerControl.holdExec = true;
    const a = exec(nameCmd(2), '改名');
    const b = exec(nameCmd(3), '改名');
    await wait(40);
    workerControl.held.shift()?.send();
    await a;
    // 第二笔刚轮到：还不显示（虽然它发出去已经 40 多毫秒）
    await wait(30);
    expect(progressView.value).toBeNull();
    await vi.waitFor(() => expect(progressView.value).not.toBeNull(), { timeout: 2000 });
    workerControl.release();
    await b;
    expect(progressView.value).toBeNull();
  });

  it('做过一次：各步真实的耗时记在浏览器里，下一次同一类请求按它估（刚到第二步就不是 0）', async () => {
    await opened();
    const w = FakeEngineWorker.last;
    const run = async (): Promise<number> => {
      workerControl.holdExec = true;
      const p = exec({ op: 'set_planet', patch: { humidity: 1.2 } }, '正在计算…');
      await tick(2);
      w.stage('climate', 1, 2);
      await wait(80);
      w.stage('water', 2, 2);
      await wait(40);
      const f = progressView.value?.fraction ?? -1;
      workerControl.holdExec = false;
      workerControl.release();
      await p;
      return f;
    };
    await run();
    // 只看这一笔的（机器忙时前面的“新建”也可能久到被记下来）
    const kept = (JSON.parse(storage.get(PROGRESS_KEY)!) as [string, [string, number][]][]).filter((k) => k[0].startsWith('exec:'));
    const key = `exec:set_planet|region|${world.value!.settings.cells}`;
    expect(kept.map((k) => k[0])).toEqual([key]);
    expect(kept[0][1].map((s) => s[0])).toEqual(['climate', 'water']);
    // 第一步约 80 毫秒、第二步约 40 毫秒
    expect(kept[0][1][0][1]).toBeGreaterThan(60);
    expect(kept[0][1][1][1]).toBeGreaterThan(20);
    // 第二次：到第二步 40 毫秒后，按记下的那一次估——闲的时候约在 120 / 120 的九成以内。
    // 下限按记下的第二步的耗时算（机器忙时第一次的两步会比 80、40 毫秒长，写死 0.6 会偶尔不过）：
    // 到第二步至少过了 80 毫秒（定时器不会早到），第二步里至少走了 40 毫秒或估的九成
    const b = kept[0][1][1][1];
    const f = await run();
    expect(f).toBeGreaterThan((80 + Math.min(40, 0.9 * b)) / (80 + b) - 0.05);
    expect(f).toBeLessThan(1);
  });

  it('取消了的、出错的那一次不记', async () => {
    await opened();
    const w = FakeEngineWorker.last;
    workerControl.soft = true;
    workerControl.holdExec = true;
    const p = exec({ op: 'set_planet', patch: { humidity: 1.2 } }, '正在计算…');
    await tick(2);
    w.stage('climate', 1, 2);
    await vi.waitFor(() => expect(progressView.value).not.toBeNull(), { timeout: 2000 });
    stopBusy();
    expect(await p).toBe(false);
    expect(progressView.value).toBeNull();
    // 这一笔没有记（机器忙时前面的“新建”可能久到被记下来：那一条不算）
    const kept = JSON.parse(storage.get(PROGRESS_KEY) ?? '[]') as [string, unknown][];
    expect(kept.filter((k) => k[0].startsWith('exec:'))).toEqual([]);
  });

  it('正在恢复世界（结束了计算程序之后）：也有进度，但不能取消', async () => {
    await opened();
    workerControl.holdAll = true;
    stallWait.ms = 40;
    const stuck = exec(nameCmd(2), '改名');
    await vi.waitFor(() => expect(progressView.value?.cancel).toBe(true), { timeout: 2000 });
    // 卡住了（没动静）：取消就是结束它；另开的那个打开原来的世界，这里也压着
    await wait(80);
    workerControl.holdAll = false;
    workerControl.holdOpen = true;
    stopBusy();
    expect(await stuck).toBe(false);
    expect(busy.value).toBe('正在恢复世界…');
    await vi.waitFor(() => expect(progressView.value?.cancel).toBe(false), { timeout: 2000 });
    FakeEngineWorker.last.stage('replay', 1, 2);
    FakeEngineWorker.last.stage('replay', 2, 2);
    await vi.waitFor(() => expect(progressView.value?.count).toEqual({ k: 2, n: 2 }), { timeout: 2000 });
    workerControl.holdOpen = false;
    workerControl.release();
    await vi.waitFor(() => expect(busy.value).toBeNull(), { timeout: 5000 });
    expect(progressView.value).toBeNull();
  });
});
