import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropKeptDb } from '../../autosave-io';
import { browserBackupIo } from '../../backups';
import { createMap, idbMapStore, mapLink } from '../../maps';
import { FakeIDB } from '../../testing/fake-idb';
import { FakeEngineWorker, docOf, nameCmd, workerControl } from '../../testing/fake-engine-worker';
import { type VersionInfo, mapSeries, sortVersions, worldSeries } from '../../versions';

// 第九十五轮：以前的版本的界面这边——一行写什么、弹窗怎么分段、回到某一份（先把现在的样子留一份）、导出、删除。
// 计算 Worker 是假的（带命令记录），浏览器的存储是内存里的假 IndexedDB：我的地图、版本、自动保存都走真的那一层

vi.stubGlobal('Worker', FakeEngineWorker);
const downloads: { name: string; text: string }[] = [];
vi.mock('../../state/export-host', async (orig) => ({
  ...(await orig<typeof import('../../state/export-host')>()),
  download: (name: string, data: string) => void downloads.push({ name, text: data }),
}));

const { ask, autosaveNow, exec, keepVersion, loadDoc, toast, versions, worldEpoch, worldId } = await import('../../state');
const { useAutosaveIo } = await import('../../state/autosave');
const { useBackupIo } = await import('../../state/backups');
const { currentSeries, refreshVersions, useVersionIo } = await import('../../state/versions');
const { VERSION_TEXT: T, SAVE_TEXT } = await import('../copy');
const { exportVersion, mapVersionCount, openVersions, removeVersionAsk, restoreVersion, versionCount, versionGroups, versionRow, versionWhen, versionsDialog } = await import('./versions');
const { reloadSaved } = await import('../shell/save-note');

const mine = () => FakeEngineWorker.last.done.map((h) => h.cmd);
const settle = async () => {
  for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
};
type AskNow = NonNullable<typeof ask.value>;
const nextAsk = (): Promise<AskNow> =>
  vi.waitFor(
    () => {
      const a = ask.value;
      if (!a) throw new Error('问话还没出来');
      return a;
    },
    { timeout: 30000, interval: 10 },
  );

let idb: FakeIDB;
let clock: number;
beforeEach(() => {
  idb = new FakeIDB();
  const local = new Map<string, string>();
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
  dropKeptDb();
  workerControl.reset();
  useBackupIo(browserBackupIo);
  useAutosaveIo();
  useVersionIo();
  mapLink.value = null;
  downloads.length = 0;
  versionsDialog.value = null;
  clock = new Date(2026, 10, 11, 14, 5).getTime();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  ask.value?.resolve('cancel');
  await autosaveNow().catch(() => {});
  await settle();
  vi.restoreAllMocks();
});

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const info = (more: Partial<VersionInfo> = {}): VersionInfo => ({ id: 'v1', series: 'w:a', at: at(2026, 11, 11, 14, 5), steps: 132, bytes: 10, why: 'auto', ...more });

describe('一行写什么', () => {
  it('时间：今天、昨天、几月几日，不是今年的带年份', () => {
    const now = at(2026, 11, 11, 16, 0);
    expect(versionWhen(at(2026, 11, 11, 14, 5), now)).toBe('今天 14:05');
    expect(versionWhen(at(2026, 11, 11, 0, 0), now)).toBe('今天 00:00');
    expect(versionWhen(at(2026, 11, 10, 23, 59), now)).toBe('昨天 23:59');
    expect(versionWhen(at(2026, 11, 3, 9, 7), now)).toBe('11月3日 09:07');
    expect(versionWhen(at(2025, 12, 31, 20, 10), now)).toBe('2025年12月31日 20:10');
    // 半夜刚过：十分钟前是“昨天”
    expect(versionWhen(at(2026, 11, 10, 23, 55), at(2026, 11, 11, 0, 5))).toBe('昨天 23:55');
  });

  it('灰字：几步、为什么留的（平常隔一阵留的不写）', () => {
    const now = at(2026, 11, 11, 16, 0);
    expect(versionRow(info(), now)).toEqual({ when: '今天 14:05', note: '132 步' });
    expect(versionRow(info({ why: 'before-restore' }), now).note).toBe('132 步 · 回去之前留的');
    expect(versionRow(info({ why: 'replaced' }), now).note).toBe('132 步 · 被换掉之前留的');
    expect(versionRow(info({ why: 'before-reload' }), now).note).toBe('132 步 · 重新载入之前留的');
    expect(versionRow(info({ why: 'opened' }), now).note).toBe('132 步 · 打开时的样子');
  });

  it('说人话：不说实现上的词', () => {
    const all = JSON.stringify(T, (_k, v) => (typeof v === 'function' ? v('X', 'Y') : v));
    expect(all).not.toMatch(/IndexedDB|localStorage|标签页|句柄|事务|快照|series|备份/);
  });
});

describe('弹窗里列哪些', () => {
  const list = [
    info({ id: 'a2', series: 'w:a', at: 30 }),
    info({ id: 'm1', series: 'm:x', at: 25 }),
    info({ id: 'o2', series: 'w:old', at: 20, kind: 'region', sizeKm: 4400, cells: 40000 }),
    info({ id: 'a1', series: 'w:a', at: 10 }),
    info({ id: 'o1', series: 'w:old', at: 5 }),
    info({ id: 'p1', series: 'w:older', at: 3 }),
  ];

  it('看现在的世界：先是它自己的；再是别的没存进“我的地图”的世界，一个世界一段；别的地图的不在这里', () => {
    const g = versionGroups(list, { t: 'world' }, 'w:a');
    expect(g.map((x) => [x.current, x.title, x.rows.map((v) => v.id)])).toEqual([
      [true, null, ['a2', 'a1']],
      [false, T.others, ['o2', 'o1']],
      [false, null, ['p1']],
    ]);
    expect(g[1].hint).toBe(T.othersHint);
    expect(versionCount(list, 'w:a')).toBe(5);
    expect(versionCount(list, 'm:x')).toBe(6);
    expect(versionCount(null, 'w:a')).toBe(0);
  });

  it('现在的世界连着一张地图：它那一张的是“现在的”；看一张地图：只有它的', () => {
    expect(versionGroups(list, { t: 'world' }, 'm:x')[0].rows.map((v) => v.id)).toEqual(['m1']);
    const g = versionGroups(list, { t: 'map', id: 'x', name: '赤原' }, 'w:a');
    expect(g).toEqual([{ current: false, title: null, hint: null, rows: [list[1]] }]);
    expect(versionGroups(list, { t: 'map', id: 'x', name: '赤原' }, 'm:x')[0].current).toBe(true);
    expect(mapVersionCount(list, 'x')).toBe(1);
    expect(mapVersionCount(list, 'none')).toBe(0);
  });
});

describe('回到这一份', () => {
  it('现在的世界：先把现在的样子留一份，再换成那一份；编号不变，回去本身能反悔', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    const id = worldId();
    const old = (await keepVersion('auto'))!;
    const oldDoc = docOf([nameCmd(1)]);
    clock += 10 * 60_000;
    await exec(nameCmd('画坏了'));
    await exec(nameCmd('又一步'));
    const bad = [...mine()];
    openVersions();
    expect(versionsDialog.value).toEqual({ t: 'world' });
    expect(await restoreVersion(old)).toBe(true);
    expect(mine()).toEqual(oldDoc.commands);
    expect(worldId()).toBe(id);
    expect(currentSeries.value).toBe(worldSeries(id));
    expect(versionsDialog.value).toBeNull();
    expect(toast.value?.text).toBe(T.restored('今天 14:05'));
    // 回去之前的样子留着
    const list = sortVersions(await refreshVersions());
    expect(list.map((v) => [v.why, v.steps])).toEqual([
      ['before-restore', bad.length],
      ['auto', oldDoc.commands.length],
    ]);
    // 反悔：回到“回去之前留的”那一份
    clock += 60_000;
    expect(await restoreVersion(list[0])).toBe(true);
    expect(mine()).toEqual(bad);
    await autosaveNow();
    await settle();
  });

  it('“我的地图”里没开着的一张：它现在存着的样子先留一份，打开那一份，接着连着它', async () => {
    const mapDoc1 = docOf([nameCmd('地图第一版')]);
    const e = await createMap(idbMapStore, { name: '赤原', doc: mapDoc1, now: clock });
    // 那一张以前的一份
    await loadDoc(mapDoc1);
    mapLink.value = { id: e.id, name: e.name, epoch: worldEpoch.value };
    const v1 = (await keepVersion('auto'))!;
    expect(v1.series).toBe(mapSeries(e.id));
    // 之后那一张又存了新的样子；现在开着的是别的世界（连着另一张，不用问保存）
    const mapDoc2 = docOf([nameCmd('地图第一版'), nameCmd('地图第二版')]);
    await idbMapStore.write({ ...e, savedAt: clock + 1000, steps: mapDoc2.commands.length }, mapDoc2);
    const other = await createMap(idbMapStore, { name: '别的', doc: docOf(), now: clock });
    await loadDoc(docOf());
    mapLink.value = { id: other.id, name: other.name, epoch: worldEpoch.value };
    clock += 10 * 60_000;
    expect(await restoreVersion(v1)).toBe(true);
    expect(mine()).toEqual(mapDoc1.commands);
    expect(mapLink.value).toMatchObject({ id: e.id, name: '赤原', epoch: worldEpoch.value });
    const kept = sortVersions(await refreshVersions()).filter((v) => v.series === mapSeries(e.id));
    expect(kept.map((v) => [v.why, v.steps])).toEqual([
      ['before-restore', mapDoc2.commands.length],
      ['auto', mapDoc1.commands.length],
    ]);
    // 自动保存跟着把那一张换成这一份
    await autosaveNow();
    await vi.waitFor(async () => expect((await idbMapStore.doc(e.id))!.commands).toEqual(mapDoc1.commands), { timeout: 20000, interval: 20 });
  });

  it('别的没存的世界：“打开”——现在的世界留一份，换成那个世界，接着用它的编号', async () => {
    await loadDoc(docOf([nameCmd('旧世界')]));
    const oldId = worldId();
    const v = (await keepVersion('auto'))!;
    await loadDoc(docOf([nameCmd('新世界'), nameCmd('第二步'), nameCmd('第三步')]));
    const newId = worldId();
    expect(newId).not.toBe(oldId);
    clock += 10 * 60_000;
    const p = restoreVersion(v);
    // 现在的世界没存进“我的地图”、改过：先问要不要保存
    const a = await Promise.race([nextAsk(), p.then(() => null)]);
    a?.resolve('drop');
    expect(await p).toBe(true);
    expect(mine()).toEqual(docOf([nameCmd('旧世界')]).commands);
    expect(worldId()).toBe(oldId);
    expect(toast.value?.text).toBe(T.opened('今天 14:05'));
  });

  it('那一份已经不在了：说一声，世界不动', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    const was = [...mine()];
    expect(await restoreVersion(info({ id: 'gone', series: currentSeries.value! }))).toBe(false);
    expect(toast.value?.text).toBe(T.gone);
    expect(mine()).toEqual(was);
  });

  it('现在的样子没能留下来（存储满了）：先问；取消就不回去', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    const old = (await keepVersion('auto'))!;
    clock += 10 * 60_000;
    await exec(nameCmd(2));
    const was = [...mine()];
    idb.quota = true;
    const p = restoreVersion(old);
    const a = await nextAsk();
    expect(a.title).toBe(T.notKept.title);
    expect(a.choices.map((c) => c.label)).toEqual(['导出文件', '仍然回去', '取消']);
    a.resolve('cancel');
    expect(await p).toBe(false);
    expect(mine()).toEqual(was);
    idb.quota = false;
  });
});

describe('导出、删除', () => {
  it('导出：那一份原样存成世界文件，名字里带时间', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    const v = (await keepVersion('auto'))!;
    expect(await exportVersion(v)).toBe(true);
    expect(downloads).toEqual([{ name: '世界 2026-11-11 1405.json', text: JSON.stringify(docOf([nameCmd(1)])) }]);
    expect(await exportVersion(info({ id: 'gone' }))).toBe(false);
    expect(toast.value?.text).toBe(T.gone);
  });

  it('删除：先问；点了删除才删', async () => {
    await loadDoc(docOf([nameCmd(1)]));
    const v = (await keepVersion('auto'))!;
    const p = removeVersionAsk(v);
    const a = await nextAsk();
    expect(a.title).toBe(T.deleteTitle);
    a.resolve('cancel');
    expect(await p).toBe(false);
    expect(versions.value!.length).toBe(1);
    const q = removeVersionAsk(v);
    (await nextAsk()).resolve('delete');
    expect(await q).toBe(true);
    expect(versions.value).toEqual([]);
  });
});

describe('“重新载入”（这个页面里的是旧的）', () => {
  it('先把这个页面里的样子留一份，再重新载入', async () => {
    await loadDoc(docOf([nameCmd('这个页面里的')]));
    let reloaded = 0;
    expect(await reloadSaved(() => reloaded++)).toBe(true);
    expect(reloaded).toBe(1);
    const list = await refreshVersions();
    expect(list.map((v) => [v.why, v.steps])).toEqual([['before-reload', mine().length]]);
  });

  it('留不下来：先问；取消就不重新载入；“重新载入”才载入', async () => {
    await loadDoc(docOf([nameCmd('这个页面里的')]));
    idb.quota = true;
    let reloaded = 0;
    const p = reloadSaved(() => reloaded++);
    const a = await nextAsk();
    expect(a.title).toBe(SAVE_TEXT.reloadNotKept.title);
    a.resolve('cancel');
    expect(await p).toBe(false);
    expect(reloaded).toBe(0);
    const q = reloadSaved(() => reloaded++);
    const b = await nextAsk();
    expect(b.choices.map((c) => c.label)).toEqual(['导出文件', '重新载入', '取消']);
    b.resolve('go');
    expect(await q).toBe(true);
    expect(reloaded).toBe(1);
    idb.quota = false;
  });
});
