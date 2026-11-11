import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC_VERSION, checkDoc } from '../core/doc-version';
import type { DocTail, WorldDoc } from '../core/engine';
import { engineFor } from '../core/testing/fixtures';
import { AutosaveWriter, browserAutosaveIo, dropKeptDb } from './autosave-io';
import { type RescueIo, type SavedWorld, readSavedWorld, rescueExport, rescueFileName } from './rescue-doc';
import { Mirror } from './sandbox';
import { docText } from './doc-text';
import { FakeIDB } from './testing/fake-idb';

// 第九十六轮：自救页的“导出文件”。它自己读存储（不用计算 Worker、不引用自动保存的那几个文件），所以这里拿真的写入
// （AutosaveWriter 经浏览器的那一层写进假的 IndexedDB）写下的东西来读：存储的形状变了、这里没跟上，这几条就不过

// 一个真的小世界：引擎做几步，世界文件是它给的
const eng = engineFor({ cells: 1500, seed: 7 });
eng.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
eng.exec({ op: 'set_planet', patch: { humidity: 0.2 } });
eng.exec({ op: 'set_planet', patch: { humidity: 0.4 } });
const doc: WorldDoc = eng.toDoc();

let idb: FakeIDB;
let local: Map<string, string>;
const localStore = () => ({ getItem: (k: string) => local.get(k) ?? null });
beforeEach(() => {
  idb = new FakeIDB();
  local = new Map();
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('IDBKeyRange', { bound: (lo: number, hi: number) => ({ lo, hi }) });
  dropKeptDb();
});
afterEach(() => vi.unstubAllGlobals());

// 照平常的自动保存写一次（整份）
async function autosave(d: WorldDoc, now: number) {
  const w = new AutosaveWriter(browserAutosaveIo, '这一页', false);
  const tail = (base: readonly number[]): DocTail => ({ ...eng.docTail(base as number[]), commands: d.commands.slice(Math.min(base.length, d.commands.length)), ids: d.commands.map((_, k) => k + 1), from: Math.min(base.length, d.commands.length) });
  for (let round = 0; round < 3; round++) {
    const base = w.savedIds;
    const out = await w.write(tail(base), { wid: 'w1', mapId: 'm1' }, { base, key: 'k', now });
    if (out.kind === 'saved') return;
    if (out.kind !== 'again') throw new Error(`没写成：${out.kind}`);
  }
  throw new Error('没写成');
}

describe('读浏览器里存着的那一份', () => {
  it('真的自动保存写下的：读出来就是那份世界文件，这一版打得开', async () => {
    await autosave(doc, 5000);
    const got = (await readSavedWorld(idb as unknown as IDBFactory, localStore()))!;
    expect(got.savedAt).toBe(5000);
    expect(got.steps).toBe(doc.commands.length);
    expect(got.whole).toBe(true);
    const back = JSON.parse(got.text) as WorldDoc;
    // 只有世界文件的那几项（头里的 savedAt、count、writer、gen、wid、mapId 不在里面）
    expect(Object.keys(back).sort()).toEqual(Object.keys(doc).sort());
    expect(back).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(() => checkDoc(back)).not.toThrow();
    expect(back.version).toBe(DOC_VERSION);
    // 读只是读：存着的东西没动
    expect(idb.data.get('autosave')!.size).toBe(doc.commands.length);
  });

  it('表里更后面的是以前的世界剩下的：只要条数以内的', async () => {
    await autosave(doc, 1);
    idb.data.get('autosave')!.set(doc.commands.length, { op: 'rename_feature', key: 'x', name: '旧的' });
    const got = (await readSavedWorld(idb as unknown as IDBFactory, null))!;
    expect(got.steps).toBe(doc.commands.length);
    expect(got.whole).toBe(true);
  });

  it('没存完整（头里写的条数比读出来的多）：照样给出存下的那一部分，标着不完整', async () => {
    await autosave(doc, 1);
    idb.data.get('autosave')!.delete(doc.commands.length - 1);
    const got = (await readSavedWorld(idb as unknown as IDBFactory, null))!;
    expect(got.whole).toBe(false);
    expect(got.steps).toBe(doc.commands.length - 1);
    expect((JSON.parse(got.text) as WorldDoc).commands).toEqual(JSON.parse(JSON.stringify(doc.commands.slice(0, -1))));
  });

  it('IndexedDB 里没有、用不了：看 localStorage 的后备；两边都有用较新的', async () => {
    expect(await readSavedWorld(idb as unknown as IDBFactory, localStore())).toBeNull();
    expect(await readSavedWorld(undefined, null)).toBeNull();
    local.set('map2.autosave', JSON.stringify({ savedAt: 300, doc }));
    const only = (await readSavedWorld(undefined, localStore()))!;
    expect(only).toMatchObject({ savedAt: 300, steps: doc.commands.length, whole: true });
    expect(JSON.parse(only.text)).toEqual(JSON.parse(JSON.stringify(doc)));
    await autosave({ ...doc, commands: doc.commands.slice(0, 2) }, 200);
    expect((await readSavedWorld(idb as unknown as IDBFactory, localStore()))!.savedAt).toBe(300);
    await autosave(doc, 400);
    expect((await readSavedWorld(idb as unknown as IDBFactory, localStore()))!.savedAt).toBe(400);
  });

  it('存着的是坏的、打开库就出错：当没有，不抛', async () => {
    local.set('map2.autosave', '{不是 JSON');
    expect(await readSavedWorld(undefined, localStore())).toBeNull();
    local.set('map2.autosave', JSON.stringify({ savedAt: 1, doc: { format: '别的东西', commands: [] } }));
    expect(await readSavedWorld(undefined, localStore())).toBeNull();
    const broken = {
      open: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    expect(await readSavedWorld(broken, null)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(await readSavedWorld(undefined, throwing)).toBeNull();
  });

  it('没有这个库时不留下一个空的（中止那一次新建）', async () => {
    let aborted = 0;
    const req: Record<string, unknown> = { transaction: { abort: () => aborted++ }, result: { close: () => {} } };
    const fresh = {
      open: () => {
        setTimeout(() => {
          (req.onupgradeneeded as () => void)?.();
          (req.onerror as (e: unknown) => void)?.({ preventDefault: () => {} });
        }, 0);
        return req;
      },
    } as unknown as IDBFactory;
    expect(await readSavedWorld(fresh, null)).toBeNull();
    expect(aborted).toBe(1);
  });
});

describe('导出', () => {
  const saved = (text: string, more: Partial<SavedWorld> = {}): SavedWorld => ({ text, savedAt: new Date(2026, 10, 10, 9, 5).getTime(), steps: 3, whole: true, ...more });
  function io(over: Partial<RescueIo>) {
    const files: { name: string; text: string }[] = [];
    const base: RescueIo = { saved: async () => null, download: (name, text) => void files.push({ name, text }), now: () => new Date(2026, 10, 11, 14, 5).getTime(), ...over };
    return { files, io: base };
  }

  it('页面里现在的世界拿得到：导出的是它（主线程手上的命令记录，不问计算程序），和世界文件一字不差', async () => {
    // 命令记录：就是计算程序每次回复带回来的那些
    const mirror = new Mirror();
    mirror.apply(1, { ...eng.docTail([]), epoch: 1 });
    const { files, io: x } = io({ live: () => docText(mirror.doc()), saved: async () => saved('{"format":"map2-world","旧的":true,"commands":[]}') });
    const r = await rescueExport(x);
    expect(r).toMatchObject({ ok: true, from: 'live', name: '世界 2026-11-11 1405.json', whole: true });
    expect(files).toEqual([{ name: '世界 2026-11-11 1405.json', text: JSON.stringify(doc) }]);
    expect(() => checkDoc(JSON.parse(files[0].text) as WorldDoc)).not.toThrow();
  });

  it('页面里的拿不到（没有世界、取的时候抛错、给的不是世界文件）：用浏览器里存着的，文件名是它保存的时间', async () => {
    const text = JSON.stringify(doc);
    for (const live of [undefined, () => null, () => 'undefined', () => '', () => '{"半截', (): string => {
      throw new Error('坏了');
    }]) {
      const { files, io: x } = io({ ...(live ? { live } : {}), saved: async () => saved(text) });
      const r = await rescueExport(x);
      expect(r).toMatchObject({ ok: true, from: 'saved', name: '世界 2026-11-10 0905.json', whole: true });
      expect(files).toEqual([{ name: '世界 2026-11-10 0905.json', text }]);
    }
  });

  it('存着的不完整：照样导出，结果里标着', async () => {
    const { io: x } = io({ saved: async () => saved(JSON.stringify(doc), { whole: false }) });
    expect(await rescueExport(x)).toMatchObject({ ok: true, from: 'saved', whole: false });
  });

  it('哪里都没有、读的时候出错、下载不了：说没能导出，不抛', async () => {
    expect(await rescueExport(io({}).io)).toEqual({ ok: false });
    expect(
      await rescueExport(
        io({
          saved: async () => {
            throw new Error('读不了');
          },
        }).io,
      ),
    ).toEqual({ ok: false });
    expect(
      await rescueExport(
        io({
          live: () => JSON.stringify(doc),
          saved: async () => saved(JSON.stringify(doc)),
          download: () => {
            throw new Error('不让下载');
          },
        }).io,
      ),
    ).toEqual({ ok: false });
  });

  it('页面里的下载不了、存着的下载得了：给存着的', async () => {
    const files: string[] = [];
    let first = true;
    const r = await rescueExport({
      live: () => JSON.stringify(doc),
      saved: async () => saved(JSON.stringify(doc)),
      download: (name) => {
        if (first) {
          first = false;
          throw new Error('一时不行');
        }
        files.push(name);
      },
      now: () => 0,
    });
    expect(r).toMatchObject({ ok: true, from: 'saved' });
    expect(files.length).toBe(1);
  });

  it('文件名', () => {
    expect(rescueFileName(new Date(2026, 0, 2, 3, 4).getTime())).toBe('世界 2026-01-02 0304.json');
  });
});
