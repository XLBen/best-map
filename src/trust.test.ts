import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import { scriptHash } from '../core/script';
import { type Species, withRect } from '../core/species';
import { engineFor } from '../core/testing/fixtures';
import type { Request, Snapshot } from './protocol';

// 打开世界时的信任检查（第三批）：没信任过的脚本先问（列出每段），取消就不打开，不运行脚本打开是安全模式；
// 信任过的、自己提交的不再问；安全模式记进自动保存，再打开时照样安全模式；上次打开时页面停止了响应先问用不用安全模式。
// 这里没有浏览器：IndexedDB 换成内存里的表（读写自动保存的命令时照旧失败，退回 localStorage），Worker 换成按请求自动回复的假的

const kv = new Map<string, unknown>();
vi.mock('./idb', () => ({
  openDb: () => Promise.reject(new Error('没有 IndexedDB')),
  idbTx: () => Promise.reject(new Error('没有 IndexedDB')),
  idbGet: () => Promise.reject(new Error('没有 IndexedDB')),
  kvGet: async (k: string) => structuredClone(kv.get(k)),
  kvPut: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
  kvDelete: async (k: string) => void kv.delete(k),
}));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

// 一个小世界的快照（打开的回复里带）
const eng = engineFor({ cells: 1500, seed: 4 });
eng.exec({
  op: 'batch',
  commands: [
    { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true },
    { op: 'set_planet', patch: { terrainWind: 1 } },
  ],
});
const snap = (): Snapshot => {
  const w = eng.world;
  return { settings: w.settings, causes: w.causes, small: w.small, derived: w.derived, history: eng.history, canUndo: eng.canUndo, canRedo: eng.canRedo, timings: eng.lastTimings, stateId: eng.stateId };
};

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Request[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { id: number; req: Request }) {
    this.sent.push(m.req);
    const out = respond(m.req);
    queueMicrotask(() => this.onmessage?.({ data: { id: m.id, ok: true, ...out } }));
  }
  terminate() {
    this.terminated = true;
  }
}
vi.stubGlobal('Worker', FakeWorker);

// 按请求回复：打开回快照（安全模式照请求），自动保存要命令、世界文件时回最近打开的那个
let lastDoc: WorldDoc | null = null;
function respond(req: Request): Record<string, unknown> {
  if (req.kind === 'load') {
    lastDoc = req.doc;
    return { summary: '已打开世界文件', snapshot: snap(), safe: req.safe === true };
  }
  if (req.kind === 'docTail') return { tail: { format: 'map2-world', version: lastDoc!.version, settings: lastDoc!.settings, from: 0, commands: lastDoc!.commands, ids: lastDoc!.commands.map((_, k) => k + 1) } };
  if (req.kind === 'doc') return { doc: lastDoc };
  return { summary: '完成', snapshot: snap() };
}

const { ask, confirmImport, exec, loadDoc, resumeLast, safeMode } = await import('./state');
const { forgetTrustCache } = await import('./trust');

const script = (src: string) => ({ api: 1 as const, src });
const species = (id: string, src: string): Species =>
  withRect({ id, name: `生态${id}`, color: '#336699', terrain: 'plains', competition: 2, tolerances: [], scripts: { placement: script(src) } }, { t0: -40, t1: 40, m0: 0, m1: 50 });
const docWith = (...list: Species[]): WorldDoc => ({
  format: 'map2-world',
  version: 4,
  settings: eng.world.settings,
  commands: [...eng.toDoc().commands, ...list.map((sp): Command => ({ op: 'add_species', species: sp }))],
});
const tick = async () => {
  for (let k = 0; k < 10; k++) await new Promise((r) => setTimeout(r, 0));
};
const sentKinds = () => FakeWorker.all.flatMap((w) => w.sent.map((r) => (r.kind === 'load' && r.safe ? 'load(safe)' : r.kind)));

afterEach(() => {
  ask.value?.resolve('cancel');
});

describe('打开时的信任检查', () => {
  it('没信任过的脚本：先问（列出每段：谁的、哪一种、源码）；取消就不打开', async () => {
    const before = sentKinds().length;
    const doc = docWith(species('a', 'return 0.5;'), species('b', 'return clamp(elevation / 1000);'), species('c', 'return 0.5;'));
    const p = loadDoc(doc);
    await tick();
    const a = ask.value!;
    expect(a.title).toBe('信任这个世界里的脚本吗？');
    // 同一段源码只列一次
    expect(a.scripts!.map((s) => [s.owner, s.kind, s.src])).toEqual([
      ['生态a', 'placement', 'return 0.5;'],
      ['生态b', 'placement', 'return clamp(elevation / 1000);'],
    ]);
    expect(a.choices.map((c) => c.label)).toEqual(['信任并打开', '不运行脚本打开', '取消']);
    a.resolve('cancel');
    expect(await p).toBe(false);
    expect(sentKinds().length).toBe(before);
  });

  it('不运行脚本打开：安全模式（不记为信任）；信任并打开：记下来，下次不再问', async () => {
    const doc = docWith(species('d', 'return 0.25;'));
    let p = loadDoc(doc);
    await tick();
    ask.value!.resolve('safe');
    expect(await p).toBe(true);
    expect(sentKinds().at(-1)).toBe('load(safe)');
    expect(safeMode.value).toEqual({ reason: '打开时选了不运行脚本' });
    // 还是没信任：再打开照样问
    p = loadDoc(doc);
    await tick();
    expect(ask.value).not.toBeNull();
    ask.value!.resolve('run');
    expect(await p).toBe(true);
    expect(sentKinds().at(-1)).toBe('load');
    expect(safeMode.value).toBeNull();
    // 记进了浏览器（重新读一遍也在）：不再问
    forgetTrustCache();
    expect((kv.get('trustedScripts') as { hash: string }[]).map((e) => e.hash)).toContain(scriptHash('return 0.25;'));
    p = loadDoc(doc);
    await tick();
    expect(ask.value).toBeNull();
    expect(await p).toBe(true);
    // 正常打开带脚本的世界期间记下的标记，打开完就去掉
    expect(kv.has('loadingScripts')).toBe(false);
  });

  it('自己提交的脚本记为信任；导入的（生态 JSON）要先问', async () => {
    const mine = species('e', 'return 0.75;');
    expect(await exec({ op: 'add_species', species: mine })).toBe(true);
    await tick();
    const p = loadDoc(docWith(mine));
    await tick();
    expect(ask.value).toBeNull();
    expect(await p).toBe(true);
    const imported = [species('f', 'return 0.125;')];
    const q = confirmImport(imported);
    await tick();
    expect(ask.value!.choices.map((c) => c.label)).toEqual(['信任并导入', '取消']);
    ask.value!.resolve('cancel');
    expect(await q).toBe(false);
  });

  it('安全模式记进自动保存：再打开时照样用安全模式，不问', async () => {
    const doc = docWith(species('g', 'return 0.3;'));
    const p = loadDoc(doc);
    await tick();
    ask.value!.resolve('safe');
    expect(await p).toBe(true);
    // 自动保存（IndexedDB 用不了，存进 localStorage）
    await vi.waitFor(() => expect(storage.get('map2.autosave')).toBeDefined(), { timeout: 6000, interval: 50 });
    const saved = JSON.parse(storage.get('map2.autosave')!) as { doc: WorldDoc; safe?: string };
    expect(saved.safe).toBe('打开时选了不运行脚本');
    expect(saved.doc.commands).toEqual(doc.commands);
    // “刷新”后继续上次的世界
    const n = sentKinds().length;
    expect(await resumeLast()).toBe(true);
    expect(ask.value).toBeNull();
    expect(sentKinds().slice(n)).toEqual(['load(safe)']);
    expect(safeMode.value).toEqual({ reason: '打开时选了不运行脚本' });
  });

  it('上次打开这个世界时页面停止了响应（标记还在）：先问用不用安全模式', async () => {
    const sp = species('h', 'return 0.6;');
    const doc = docWith(sp);
    // 已经信任过，上次正常打开时卡死了：标记没来得及去掉
    kv.set('loadingScripts', { at: 1, hashes: [scriptHash('return 0.6;')] });
    storage.set('map2.autosave', JSON.stringify({ savedAt: Date.now(), doc }));
    const p = resumeLast();
    await tick();
    expect(ask.value!.title).toBe('上次打开这个世界时程序停止了响应。用安全模式打开吗？（脚本不运行）');
    ask.value!.resolve('safe');
    expect(await p).toBe(true);
    expect(sentKinds().at(-1)).toBe('load(safe)');
    expect(safeMode.value).toEqual({ reason: '上次打开时程序停止了响应' });
    expect(kv.has('loadingScripts')).toBe(false);
  });
});
