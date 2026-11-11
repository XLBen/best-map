import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutosaveIo, type MemoryDisk, memoryAutosaveIo, memoryDisk } from '../autosave-io';
import { docText } from '../doc-text';
import { memoryFile, memoryFileIo } from '../file-save';
import { createMap, memoryMapStore } from '../maps';
import { FakeEngineWorker, docOf, nameCmd, workerControl } from '../testing/fake-engine-worker';
import { VERSION_EVERY_MS, type MemoryVersionIo, mapSeries, memoryVersionIo, sortVersions, worldSeries } from '../versions';

// 第九十五轮：以前的版本、存到电脑上的文件接到自动保存上的那一层（state/versions.ts、state/file-save.ts）。
// 计算 Worker 是假的（带命令记录），自动保存、版本、文件的存储都是内存里的

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

const { autosaveNow, exec, loadDoc, resumeLast, saveFail, undo, worldEpoch } = await import('../state');
const { mapLink } = await import('../maps');
const { useAutosaveIo } = await import('./autosave');
const { useBackupIo } = await import('./backups');
const { memoryBackupIo } = await import('../backups');
const { adoptWorldId, currentSeries, freeVersionRoom, keepVersion, noteMapSeen, overwriteLinked, seriesNow, useVersionIo, versionEvents, versionText, versions, versionsMoved, worldId } = await import('./versions');
const { fileFlush, fileMoved, fileStatus, fileSupported, resumeFile, saveToFile, stopFile, useFileIo } = await import('./file-save');

// 这个页面现在的世界
const mine = () => docOf(FakeEngineWorker.last.done.map((h) => h.cmd).slice(docOf().commands.length));
const settle = async () => {
  for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
};

let disk: MemoryDisk;
let vio: MemoryVersionIo;
let clock: number;
beforeEach(() => {
  disk = memoryDisk();
  vio = memoryVersionIo();
  storage.clear();
  workerControl.reset();
  useBackupIo(memoryBackupIo());
  useAutosaveIo(memoryAutosaveIo(disk), null);
  useVersionIo(vio);
  useFileIo(memoryFileIo());
  mapLink.value = null;
  // 钟：从现在起，测试自己拨
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  await autosaveNow().catch(() => {});
  await settle();
  vi.restoreAllMocks();
});

describe('自动保存写成之后留一份', () => {
  it('第一次自动保存就留；5 分钟以内再存不留；过了 5 分钟再留一份；世界文件的字和存下的一字不差', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    await autosaveNow();
    await vi.waitFor(() => expect(vio.infos.size).toBe(1), { timeout: 20000, interval: 10 });
    const first = [...vio.infos.values()][0];
    expect(first).toMatchObject({ series: worldSeries(worldId()), why: 'auto', steps: mine().commands.length, at: clock });
    expect(first.kind).toBe('region');
    expect(vio.texts.get(first.id)).toBe(JSON.stringify(mine()));
    expect(versions.value!.map((v) => v.id)).toEqual([first.id]);
    // 接着改、接着存：5 分钟以内不留
    for (const k of [2, 3]) {
      clock += 60_000;
      await exec(nameCmd(k));
      await autosaveNow();
      await settle();
    }
    expect(vio.infos.size).toBe(1);
    // 过了 5 分钟
    clock += VERSION_EVERY_MS;
    await exec(nameCmd(4));
    await autosaveNow();
    await vi.waitFor(() => expect(vio.infos.size).toBe(2), { timeout: 20000, interval: 10 });
    const latest = sortVersions([...vio.infos.values()])[0];
    expect(latest.steps).toBe(mine().commands.length);
    expect(await versionText(latest.id)).toBe(JSON.stringify(mine()));
    // 以前的那一份还是那时的样子
    expect(JSON.parse(vio.texts.get(first.id)!).commands.length).toBe(first.steps);
  });

  it('世界的编号记在自动保存的头里；换了世界换一个编号；打开的是上次的世界时接着用原来的', async () => {
    await loadDoc(docOf());
    const a = worldId();
    await autosaveNow();
    expect(disk.head!.wid).toBe(a);
    expect(seriesNow()).toBe(worldSeries(a));
    expect(currentSeries.value).toBe(worldSeries(a));
    await loadDoc(docOf([nameCmd('别的世界')]));
    const b = worldId();
    expect(b).not.toBe(a);
    await autosaveNow();
    expect(disk.head!.wid).toBe(b);
    // 刷新以后：自动保存里记着的编号
    adoptWorldId('上次的编号');
    expect(worldId()).toBe('上次的编号');
    expect(currentSeries.peek()).toBe(worldSeries('上次的编号'));
    adoptWorldId(undefined);
    expect(worldId()).toBe('上次的编号');
  });

  it('继续上次的世界：编号还是那一个（后备的位置上也记着），打开时的样子留一份', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    const id = worldId();
    // 浏览器存储不可用：整份存在后备的位置上
    disk.down = true;
    await autosaveNow();
    expect(JSON.parse(storage.get('map2.autosave')!).wid).toBe(id);
    disk.down = false;
    await settle();
    vio.infos.clear();
    vio.texts.clear();
    useVersionIo(vio);
    clock += 3_600_000;
    expect(await resumeLast()).toBe(true);
    expect(worldId()).toBe(id);
    await vi.waitFor(() => expect(vio.infos.size).toBe(1), { timeout: 20000, interval: 10 });
    expect([...vio.infos.values()][0]).toMatchObject({ series: worldSeries(id), why: 'opened' });
  });

  it('连着“我的地图”的一张：版本记在那一张上，带着它的名字；第一次存进去时以前的版本跟着改过去', async () => {
    await loadDoc(docOf());
    await autosaveNow();
    await vi.waitFor(() => expect(vio.infos.size).toBe(1), { timeout: 20000, interval: 10 });
    const from = seriesNow()!;
    await versionsMoved(from, mapSeries('m9'));
    mapLink.value = { id: 'm9', name: '赤原', epoch: worldEpoch.value };
    expect(seriesNow()).toBe('m:m9');
    expect([...vio.infos.values()].map((v) => v.series)).toEqual(['m:m9']);
    // 刚挪过来的那一份算“上一次留的”：5 分钟以内不再留
    await exec(nameCmd(1));
    const kept = await keepVersion('before-restore');
    expect(kept).toMatchObject({ series: 'm:m9', name: '赤原', why: 'before-restore' });
    expect(vio.infos.size).toBe(2);
  });

  it('和最新的那一份一样：不重复留，返回原来那一份；撤销回去再留也不重复', async () => {
    await loadDoc(docOf());
    const a = await keepVersion('auto');
    const b = await keepVersion('before-restore');
    expect(b!.id).toBe(a!.id);
    clock += VERSION_EVERY_MS;
    await exec(nameCmd(1));
    const c = await keepVersion('auto');
    expect(c!.id).not.toBe(a!.id);
    clock += VERSION_EVERY_MS;
    await undo();
    // 现在和 a 一样，但最新的是 c：留
    const d = await keepVersion('auto');
    expect(d!.id).not.toBe(c!.id);
    expect(vio.infos.size).toBe(3);
  });

  it('版本的存储用不了：自动保存照样存成，不报错', async () => {
    vio.down = true;
    await loadDoc(docOf());
    await autosaveNow();
    await settle();
    expect(saveFail.value).toBeNull();
    expect(disk.head!.count).toBe(mine().commands.length);
    expect(await keepVersion('auto')).toBeNull();
    expect(versions.value).toEqual([]);
  });

  it('没有世界：不留', async () => {
    useVersionIo(vio);
    const { world } = await import('../state');
    const was = world.value;
    world.value = null;
    expect(seriesNow()).toBeNull();
    expect(await keepVersion('auto')).toBeNull();
    world.value = was;
  });
});

describe('存储满了', () => {
  it('自动保存写不进去：先把以前的版本丢掉一半腾地方，再试一次就存成了', async () => {
    await loadDoc(docOf());
    for (let k = 0; k < 4; k++) {
      clock += VERSION_EVERY_MS;
      await exec(nameCmd(k));
      await keepVersion('auto');
    }
    expect(vio.infos.size).toBe(4);
    // 版本占着地方时自动保存写不进去
    const inner = memoryAutosaveIo(disk);
    const tight: AutosaveIo = {
      ...inner,
      write: async (plan) => {
        if (vio.infos.size > 2) throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
        return inner.write(plan);
      },
    };
    useAutosaveIo(tight, null);
    await loadDoc(mine());
    await exec(nameCmd('新的一步'));
    await autosaveNow();
    expect(saveFail.value).toBeNull();
    expect(disk.head!.count).toBe(mine().commands.length);
    expect(vio.infos.size).toBeLessThanOrEqual(3);
    // 留下的是新的那几份
    expect(sortVersions([...vio.infos.values()])[0].steps).toBeGreaterThanOrEqual(docOf().commands.length + 3);
  });

  it('没有版本可丢：照旧退到后备的位置', async () => {
    useAutosaveIo({ ...memoryAutosaveIo(disk), write: async () => Promise.reject(Object.assign(new Error('满了'), { name: 'QuotaExceededError' })) }, null);
    await loadDoc(docOf());
    await autosaveNow();
    expect(await freeVersionRoom()).toBe(0);
    expect(storage.has('map2.autosave')).toBe(true);
    expect(saveFail.value).toBeNull();
  });
});

describe('盖掉“我的地图”里的一张', () => {
  it('别的页面往这一张里存过：盖之前留一份、说一声；这个页面自己接着存不再留', async () => {
    const store = memoryMapStore();
    const e = await createMap(store, { name: '赤原', doc: docOf([nameCmd('最初')]), now: clock });
    noteMapSeen(e.id, e.savedAt);
    const said: string[] = [];
    versionEvents.replaced = (name) => void said.push(name);
    // 别的页面写了一份不一样的
    const other = docOf([nameCmd('别的页面做的'), nameCmd('又一步')]);
    await store.write({ ...e, savedAt: clock + 1000 }, other);
    clock += 2000;
    const r = await overwriteLinked(store, e.id, { doc: docOf([nameCmd('这个页面做的')]), now: clock });
    expect(r!.steps).toBe(docOf().commands.length + 1);
    expect(said).toEqual(['赤原']);
    const kept = [...vio.infos.values()];
    expect(kept.map((v) => [v.series, v.why, v.steps])).toEqual([[mapSeries(e.id), 'replaced', other.commands.length]]);
    expect(vio.texts.get(kept[0].id)).toBe(JSON.stringify(other));
    // 这个页面接着存：存着的就是自己上一次写的，不留
    clock += 2000;
    await overwriteLinked(store, e.id, { doc: docOf([nameCmd('这个页面做的'), nameCmd('第二步')]), now: clock });
    expect(vio.infos.size).toBe(1);
    expect(said).toEqual(['赤原']);
    // 那一张不在了
    expect(await overwriteLinked(store, 'none', { doc: docOf() })).toBeNull();
  });
});

describe('存到电脑上的文件', () => {
  it('选一个文件：马上写一次；之后自动保存跟着写（节流）；⌘S 马上写；写的就是世界文件的字', async () => {
    const io = memoryFileIo();
    useFileIo(io);
    expect(fileSupported()).toBe(true);
    await loadDoc(docOf([nameCmd(1)]));
    await settle();
    expect(fileStatus.value.mode).toBe('off');
    const f = memoryFile('赤原.json');
    io.next = f;
    expect(await saveToFile()).toBe(true);
    expect(f.content).toBe(JSON.stringify(mine()));
    expect(f.content).toBe(docText(mine()));
    expect(fileStatus.value).toMatchObject({ mode: 'on', name: '赤原.json', fail: null, savedAt: clock });
    expect(io.remembered.get(seriesNow()!)).toBe(f);
    // 刚写过：这一次自动保存不马上写文件
    await exec(nameCmd(2));
    await autosaveNow();
    await settle();
    expect(f.writes).toBe(1);
    // ⌘S
    await fileFlush();
    expect(f.writes).toBe(2);
    expect(f.content).toBe(JSON.stringify(mine()));
    // 过了一阵再自动保存：写
    clock += 60_000;
    await exec(nameCmd(3));
    await autosaveNow();
    await vi.waitFor(() => expect(f.writes).toBe(3), { timeout: 20000, interval: 10 });
    expect(f.content).toBe(JSON.stringify(mine()));
  });

  it('换了世界：不把别的世界写进这个文件；浏览器不支持：选不了', async () => {
    const io = memoryFileIo();
    useFileIo(io);
    await loadDoc(docOf([nameCmd(1)]));
    await settle();
    const f = memoryFile('a.json');
    io.next = f;
    await saveToFile();
    const was = f.content;
    await loadDoc(docOf([nameCmd('别的世界')]));
    await settle();
    expect(fileStatus.value.mode).toBe('off');
    clock += 60_000;
    await exec(nameCmd(2));
    await autosaveNow();
    await fileFlush();
    await settle();
    expect(f.content).toBe(was);
    io.support = false;
    expect(fileSupported()).toBe(false);
    expect(await saveToFile()).toBe(false);
  });

  it('要重新给权限：没在写；点了才写；“不再存到这个文件”以后不写、忘掉', async () => {
    const io = memoryFileIo();
    useFileIo(io);
    await loadDoc(docOf());
    await settle();
    const f = memoryFile('a.json');
    f.perm = 'prompt';
    io.remembered.set(seriesNow()!, f);
    // 像刚打开页面那样重新看一遍
    useFileIo(io);
    await settle();
    expect(fileStatus.value).toMatchObject({ mode: 'paused', name: 'a.json' });
    await exec(nameCmd(1));
    await autosaveNow();
    await settle();
    expect(f.writes).toBe(0);
    expect(await resumeFile()).toBe(true);
    expect(f.content).toBe(JSON.stringify(mine()));
    await stopFile();
    expect(fileStatus.value.mode).toBe('off');
    expect(io.remembered.size).toBe(0);
    clock += 60_000;
    await exec(nameCmd(2));
    await autosaveNow();
    await settle();
    expect(f.writes).toBe(1);
  });

  it('第一次存进“我的地图”：文件跟着这个世界走', async () => {
    const io = memoryFileIo();
    useFileIo(io);
    await loadDoc(docOf());
    await settle();
    const f = memoryFile('a.json');
    io.next = f;
    await saveToFile();
    const from = seriesNow()!;
    await fileMoved(from, mapSeries('m1'));
    mapLink.value = { id: 'm1', name: '赤原', epoch: worldEpoch.value };
    await settle();
    expect(fileStatus.value.mode).toBe('on');
    expect([...io.remembered.keys()]).toEqual(['m:m1']);
    clock += 60_000;
    await exec(nameCmd(1));
    await fileFlush();
    expect(f.content).toBe(JSON.stringify(mine()));
  });
});
