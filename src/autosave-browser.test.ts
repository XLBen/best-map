import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC_VERSION } from '../core/doc-version';
import type { DocTail } from '../core/engine';
import { AutosaveWriter, browserAutosaveIo, dropKeptDb } from './autosave-io';
import { backupFileText, browserBackupIo, listBackups } from './backups';
import { autosaved, readAutosave, useAutosaveIo } from './state/autosave';
import { backups, useBackupIo } from './state/backups';
import { FakeIDB } from './testing/fake-idb';

// 第九十四轮：自动保存在浏览器里的那一层（IndexedDB 换成内存里的小替身）——一个事务里读头再写、只写变了的、撤销后删掉多出来的一段；
// 存储满了时什么都不变；关页面的那一下用开着的连接同步发出去；没存完整的自动保存启动时原样挪进“留着的旧世界”

const settings = { seed: 1, cells: 3000, aspect: 2, latNorth: 60, latSouth: 20 } as unknown as DocTail['settings'];
const cmd = (who: string, n: number) => ({ op: 'rename_feature', key: `${who}${n}`, name: who });
function tailOf(who: string, n: number, from = 0): DocTail {
  const commands = Array.from({ length: n }, (_, k) => cmd(who, k));
  return { format: 'map2-world', version: DOC_VERSION, settings, from, commands: commands.slice(from), ids: commands.map((_, k) => k + 1) } as unknown as DocTail;
}

let idb: FakeIDB;
let local: Map<string, string>;
beforeEach(() => {
  idb = new FakeIDB();
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
  dropKeptDb();
  useBackupIo(browserBackupIo);
  useAutosaveIo();
});
afterEach(() => vi.unstubAllGlobals());

const rows = () => idb.data.get('autosave')!;
const head = () => idb.data.get('kv')!.get('autosave') as Record<string, unknown>;
const page = (id: string, holder = true) => {
  const w = new AutosaveWriter(browserAutosaveIo, id, false);
  w.holder = holder;
  return w;
};
const save = async (w: AutosaveWriter, who: string, n: number) => {
  const once = () => {
    const base = w.savedIds;
    return w.write(tailOf(who, n, Math.min(base.length, n)), {}, { base, key: who });
  };
  const out = await once();
  return out.kind === 'again' ? once() : out;
};

describe('浏览器里的存取', () => {
  it('整份写、只写变了的、撤销后删掉多出来的一段；头里记着谁写的、第几代', async () => {
    const w = page('甲');
    expect((await save(w, '甲', 5)).kind).toBe('saved');
    expect(rows().size).toBe(5);
    expect(head()).toMatchObject({ format: 'map2-world', version: DOC_VERSION, count: 5, writer: '甲', gen: 1 });
    await save(w, '甲', 7);
    expect([...rows().keys()].sort((a, b) => Number(a) - Number(b))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(head()).toMatchObject({ count: 7, gen: 2 });
    await save(w, '甲', 3);
    expect([...rows().keys()].sort((a, b) => Number(a) - Number(b))).toEqual([0, 1, 2]);
    expect(head()).toMatchObject({ count: 3, gen: 3 });
  });

  it('存储满了：抛“满了”的错，存着的一点没变；之后腾出地方照常写', async () => {
    const w = page('甲');
    await save(w, '甲', 4);
    const before = JSON.stringify([[...rows()], head()]);
    idb.quota = true;
    await expect(save(w, '甲', 6)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(JSON.stringify([[...rows()], head()])).toBe(before);
    idb.quota = false;
    expect((await save(w, '甲', 6)).kind).toBe('saved');
    expect(rows().size).toBe(6);
  });

  it('两个页面：没有写的权利的那一页写不进去，存着的一直是另一页完整的世界', async () => {
    const a = page('甲');
    const b = page('乙', false);
    await save(a, '甲', 5);
    expect(await save(b, '乙', 8)).toEqual({ kind: 'other' });
    await save(a, '甲', 6);
    expect(await save(b, '乙', 9)).toEqual({ kind: 'other' });
    expect([...rows().values()]).toEqual(Array.from({ length: 6 }, (_, k) => cmd('甲', k)));
    // 乙接过去：整份重写，甲的先留着
    b.claim();
    a.yield();
    expect((await save(b, '乙', 9)).kind).toBe('saved');
    expect([...rows().values()]).toEqual(Array.from({ length: 9 }, (_, k) => cmd('乙', k)));
    const kept = await listBackups(browserBackupIo);
    expect(kept.map((x) => [x.why, x.steps])).toEqual([['other-page', 6]]);
    expect((kept[0].doc as { commands: unknown[] }).commands).toEqual(Array.from({ length: 6 }, (_, k) => cmd('甲', k)));
    expect(Object.keys(kept[0].doc as object).sort()).toEqual(['commands', 'format', 'settings', 'version']);
  });

  it('关页面的那一下：写成过一次以后有开着的连接，同步发出去', async () => {
    const w = page('甲');
    const doc = (n: number) => ({ ...tailOf('甲', n), commands: tailOf('甲', n).commands, key: '甲' });
    // 还没写成过：这样写不了
    expect(w.blind(doc(3), {})).toBe('cannot');
    await save(w, '甲', 3);
    // 连接是写成之后才开的（异步）
    await vi.waitFor(() => expect(w.blind(doc(5), {})).toBe('sent'), { timeout: 20000, interval: 10 });
    await vi.waitFor(() => expect(rows().size).toBe(5), { timeout: 20000, interval: 10 });
    expect(head()).toMatchObject({ count: 5, writer: '甲', gen: 2 });
  });
});

describe('启动时读自动保存', () => {
  it('读出来的世界文件里不带谁写的、第几代；记下读的是哪一份', async () => {
    await save(page('上一次'), '甲', 4);
    const got = (await readAutosave())!;
    expect(Object.keys(got.doc).sort()).toEqual(['commands', 'format', 'settings', 'version']);
    expect(got.doc.commands.length).toBe(4);
    expect(got.mark).toMatchObject({ writer: '上一次', gen: 1, count: 4 });
    expect(autosaved.value).toBe(got.savedAt);
    expect(backups.value).toEqual([]);
  });

  it('没存完整的（头里写的条数和读出来的对不上）：不当没有——原样挪进“留着的旧世界”，说明写着没存完整，能导出', async () => {
    await save(page('上一次'), '甲', 6);
    // 写坏：少了两条（以前两个页面混着写、后开的那个步数少时就是这样）
    rows().delete(2);
    rows().delete(3);
    const partial = { format: 'map2-world', version: DOC_VERSION, settings, commands: [0, 1, 4, 5].map((k) => cmd('甲', k)) };
    expect(await readAutosave()).toBeNull();
    expect(autosaved.value).toBeNull();
    // 位置空出来了
    expect(idb.data.get('kv')!.has('autosave')).toBe(false);
    expect(rows().size).toBe(0);
    const list = await listBackups(browserBackupIo);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ age: 'current', why: 'damaged', version: DOC_VERSION, steps: 4 });
    expect(backupFileText(list[0])).toBe(JSON.stringify(partial));
    expect(backups.value!.map((b) => b.why)).toEqual(['damaged']);
  });

  it('完整的照常打开，不挪', async () => {
    await save(page('上一次'), '甲', 6);
    expect((await readAutosave())!.doc.commands.length).toBe(6);
    expect(await listBackups(browserBackupIo)).toEqual([]);
  });
});
