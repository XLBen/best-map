import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import { settingsSchema } from '../core/world';
import { CheckpointKeeper, CheckpointStore, type SavedCheckpoint, type StorageRequest, type StorageWorkerLike, checkpointFits } from './checkpoint-store';
import { collectBuffers } from './transfer';

// 检查点的存取：存储 Worker 只把对得上这个世界的检查点交给计算 Worker（多出来的步可能是别的世界的，不给）；
// 写：计算 Worker 从通道直接发来，主线程核对步号后说可以写才写（检查点不经过主线程）；数组都转移；存储 Worker 开不起来时不再用它

const settings = settingsSchema.parse({ cells: 2000, seed: 1 });
const cmd = (humidity: number): Command => ({ op: 'set_planet', patch: { humidity } });
const docOf = (commands: Command[], s: unknown = settings): WorldDoc => ({ format: 'map2-world', version: 10, settings: s as WorldDoc['settings'], commands });
const saved = (commands: Command[], build = 'b1', s: unknown = settings) => ({
  build,
  cp: { settings: s, done: commands.map((c, k) => ({ id: k + 1, cmd: c, summary: '', dirty: 0, undo: {} })), causes: { h: new Float32Array(4) } },
});

describe('检查点对不对得上', () => {
  it('版本号、设置相同，检查点里的每一步都是这个世界开头的那几步才给', () => {
    const doc = docOf([cmd(1.1), cmd(1.2), cmd(1.3)]);
    expect(checkpointFits(saved([cmd(1.1), cmd(1.2)]), 'b1', doc)).toBe(true);
    expect(checkpointFits(saved([cmd(1.1), cmd(1.2), cmd(1.3)]), 'b1', doc)).toBe(true);
    // 版本号不同（程序更新了）
    expect(checkpointFits(saved([cmd(1.1)], 'b0'), 'b1', doc)).toBe(false);
    expect(checkpointFits(saved([cmd(1.1)]), '', doc)).toBe(false);
    // 设置不同
    expect(checkpointFits(saved([cmd(1.1)], 'b1', { ...settings, seed: 2 }), 'b1', doc)).toBe(false);
    // 检查点比这个世界多出来的步（开头一样、后面是别的世界的）：不给
    expect(checkpointFits(saved([cmd(1.1), cmd(1.2), cmd(1.3), cmd(9)]), 'b1', doc)).toBe(false);
    expect(checkpointFits(saved([cmd(1.1), cmd(9)]), 'b1', doc)).toBe(false);
    // 没有步、样子不对
    expect(checkpointFits(saved([]), 'b1', doc)).toBe(false);
    expect(checkpointFits(undefined, 'b1', doc)).toBe(false);
    expect(checkpointFits({ build: 'b1', cp: { settings, done: 'x' } }, 'b1', doc)).toBe(false);
    expect(checkpointFits({ build: 'b1', cp: { settings, done: [null] } }, 'b1', doc)).toBe(false);
    // 旧版本的世界（第九轮起不再兼容）：不给
    expect(checkpointFits(saved([cmd(1.1)]), 'b1', { ...doc, version: 4 } as unknown as WorldDoc)).toBe(false);
  });
});

class FakeStorage implements StorageWorkerLike {
  onerror: ((ev: unknown) => void) | null = null;
  sent: { msg: StorageRequest; transfer: Transferable[] }[] = [];
  postMessage(msg: StorageRequest, transfer: Transferable[]) {
    this.sent.push({ msg, transfer });
  }
}

describe('主线程这边', () => {
  it('新建、打开时各开一条通道：一头转移给存储 Worker、一头给计算 Worker，编号一次比一次大；commit 只带编号、纪元、步号', () => {
    const workers: FakeStorage[] = [];
    const store = new CheckpointStore(() => {
      const w = new FakeStorage();
      workers.push(w);
      return w;
    });
    const doc = docOf([cmd(1.1)]);
    const a = store.open('b1', doc)!;
    const b = store.open('b1', null)!;
    expect(b.token).toBeGreaterThan(a.token);
    expect(workers).toHaveLength(1);
    const [first, second] = workers[0].sent;
    expect(first.msg).toMatchObject({ kind: 'open', token: a.token, build: 'b1', doc });
    expect(second.msg).toMatchObject({ kind: 'open', token: b.token, build: 'b1', doc: null });
    if (first.msg.kind === 'open') {
      expect(first.transfer).toEqual([first.msg.port]);
      expect(first.msg.port).not.toBe(a.port);
    }
    store.commit(b.token, 3, [1, 2]);
    expect(workers[0].sent[2]).toEqual({ msg: { kind: 'commit', token: b.token, epoch: 3, ids: [1, 2] }, transfer: [] });
    for (const { msg } of workers[0].sent) if (msg.kind === 'open') msg.port.close();
    a.port.close();
    b.port.close();
  });

  it('存储 Worker 开不起来、出了错：不再用它（计算 Worker 照旧重放、不写检查点）', () => {
    const broken = new CheckpointStore(() => {
      throw new Error('开不了');
    });
    expect(broken.open('b1', docOf([cmd(1.1)]))).toBeNull();
    const w = new FakeStorage();
    const store = new CheckpointStore(() => w);
    const ok = store.open('b1', docOf([cmd(1.1)]))!;
    expect(ok).not.toBeNull();
    w.onerror?.({});
    expect(store.open('b1', docOf([cmd(1.1)]))).toBeNull();
    store.commit(ok.token, 1, [1]);
    expect(w.sent).toHaveLength(1);
    ok.port.close();
    if (w.sent[0].msg.kind === 'open') w.sent[0].msg.port.close();
  });
});

// 存储 Worker 里的逻辑：真的 MessageChannel，假的 IndexedDB
describe('存储 Worker 这边', () => {
  const until = async (ok: () => boolean) => {
    for (let k = 0; k < 500 && !ok(); k++) await new Promise((r) => setTimeout(r, 2));
    expect(ok()).toBe(true);
  };
  function keeper(stored: unknown = null, mesh: unknown = undefined) {
    const puts: SavedCheckpoint[] = [];
    let current = stored;
    const k = new CheckpointKeeper({
      get: async () => current,
      put: async (saved) => {
        puts.push(saved);
        current = saved;
      },
      ...(mesh !== undefined ? { mesh: async () => mesh } : {}),
    });
    // 计算 Worker 那一头收到的
    const got: unknown[] = [];
    const ports: MessagePort[] = [];
    let token = 0;
    const open = (doc: WorldDoc | null, build = 'b1', meshKey?: string) => {
      const ch = new MessageChannel();
      ports.push(ch.port1, ch.port2);
      ch.port2.onmessage = (ev) => got.push(ev.data);
      k.handle({ kind: 'open', token: ++token, build, doc, port: ch.port1, meshKey });
      return { engine: ch.port2, token };
    };
    const close = () => ports.forEach((p) => p.close());
    return { k, puts, got, open, close };
  }
  const cpWith = (ids: number[]) => ({ settings, done: ids.map((id) => ({ id, cmd: cmd(id) })), causes: { h: new Float32Array([1, 2]) } });

  it('打开时只把对得上这个世界的检查点发过去（数组转移），对不上发 null', async () => {
    const s = saved([cmd(1.1), cmd(1.2)]);
    const t = keeper(s);
    t.open(docOf([cmd(1.1), cmd(1.2), cmd(1.3)]));
    await until(() => t.got.length === 1);
    expect((t.got[0] as { cp: { done: unknown[] } }).cp.done).toHaveLength(2);
    // 转移了：存储 Worker 这边的数组空了
    expect(s.cp.causes.h.length).toBe(0);
    const u = keeper(saved([cmd(1.1), cmd(9)]));
    u.open(docOf([cmd(1.1), cmd(1.2)]));
    await until(() => u.got.length === 1);
    expect(u.got[0]).toEqual({ cp: null });
    // 新建：不发
    u.open(null);
    await u.k.idle();
    await new Promise((r) => setTimeout(r, 10));
    expect(u.got).toHaveLength(1);
    t.close();
    u.close();
  });

  it('打开时存着的网格键对得上才连同网格一起发（数组转移）；对不上、没给键时不带网格', async () => {
    const mesh = { scalars: { n: 2 }, arrays: { x: new Float64Array([1, 2]) } };
    const t = keeper(saved([cmd(1.1)]), { key: 'b1|globe:2:1', mesh });
    t.open(docOf([cmd(1.1)]), 'b1', 'b1|globe:2:1');
    await until(() => t.got.length === 1);
    const r = t.got[0] as { cp: unknown; mesh?: typeof mesh };
    expect(r.cp).not.toBeNull();
    expect(Array.from(r.mesh!.arrays.x)).toEqual([1, 2]);
    expect(mesh.arrays.x.length).toBe(0);
    const u = keeper(null, { key: 'b1|globe:2:1', mesh: { arrays: {} } });
    u.open(docOf([cmd(1.1)]), 'b1', 'b2|globe:2:1');
    u.open(docOf([cmd(1.1)]), 'b1');
    await until(() => u.got.length === 2);
    expect(u.got).toEqual([{ cp: null }, { cp: null }]);
    t.close();
    u.close();
  });

  it('写：通道上收到的那一份，纪元、步号与主线程说的相同才写（谁先到都行）；对不上、编号不对的不写', async () => {
    const t = keeper();
    const { engine, token } = t.open(null);
    // 检查点先到
    engine.postMessage({ epoch: 1, cp: cpWith([1, 2]) });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.puts).toHaveLength(0);
    t.k.handle({ kind: 'commit', token, epoch: 1, ids: [1, 2] });
    await until(() => t.puts.length === 1);
    expect(t.puts[0].build).toBe('b1');
    expect(t.puts[0].cp.done.map((h) => h.id)).toEqual([1, 2]);
    // 主线程先说
    t.k.handle({ kind: 'commit', token, epoch: 1, ids: [1, 2, 3] });
    engine.postMessage({ epoch: 1, cp: cpWith([1, 2, 3]) });
    await until(() => t.puts.length === 2);
    // 步号、纪元对不上，编号不是当前通道的：不写
    engine.postMessage({ epoch: 1, cp: cpWith([1, 2, 4]) });
    t.k.handle({ kind: 'commit', token, epoch: 1, ids: [1, 2, 5] });
    t.k.handle({ kind: 'commit', token, epoch: 2, ids: [1, 2, 4] });
    t.k.handle({ kind: 'commit', token: token + 7, epoch: 1, ids: [1, 2, 4] });
    // 样子不对的
    engine.postMessage({ epoch: 1.5, cp: cpWith([1]) });
    engine.postMessage({ epoch: 1, cp: { done: [{ id: 'x' }] } });
    engine.postMessage(null);
    t.k.handle({ kind: 'commit', token, epoch: 1, ids: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    await t.k.idle();
    expect(t.puts).toHaveLength(2);
    // 写过的不再写第二次
    t.k.handle({ kind: 'commit', token, epoch: 1, ids: [1, 2, 3] });
    await t.k.idle();
    expect(t.puts).toHaveLength(2);
    t.close();
  });

  it('换了通道（又新建、打开了）：旧通道上的不写，之前说过的也不算；读到的是刚写的', async () => {
    const t = keeper();
    const a = t.open(null);
    t.k.handle({ kind: 'commit', token: a.token, epoch: 1, ids: [1] });
    const b = t.open(null);
    a.engine.postMessage({ epoch: 1, cp: cpWith([1]) });
    // 旧通道的编号
    b.engine.postMessage({ epoch: 1, cp: cpWith([1]) });
    t.k.handle({ kind: 'commit', token: a.token, epoch: 1, ids: [1] });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.puts).toHaveLength(0);
    t.k.handle({ kind: 'commit', token: b.token, epoch: 1, ids: [1] });
    await until(() => t.puts.length === 1);
    // 接着打开这个世界：读到刚写的
    t.open(docOf([cmd(1)]));
    await until(() => t.got.length === 1);
    expect((t.got[0] as { cp: { done: { id: number }[] } }).cp.done.map((h) => h.id)).toEqual([1]);
    t.close();
  });

  it('刚打开就又打开了别的：前一个照样收到它的那一条（不让计算 Worker 白等），之后它的通道不再收', async () => {
    const t = keeper(saved([cmd(1.1)]));
    const got: unknown[] = [];
    const a = t.open(docOf([cmd(1.1)]));
    a.engine.onmessage = (ev) => got.push(ev.data);
    t.open(docOf([cmd(2.1)]));
    await until(() => got.length === 1 && t.got.length === 1);
    expect((got[0] as { cp: unknown }).cp).not.toBeNull();
    expect(t.got[0]).toEqual({ cp: null });
    a.engine.postMessage({ epoch: 1, cp: cpWith([1]) });
    t.k.handle({ kind: 'commit', token: a.token, epoch: 1, ids: [1] });
    await new Promise((r) => setTimeout(r, 20));
    await t.k.idle();
    expect(t.puts).toHaveLength(0);
    t.close();
  });
});

describe('转移列表', () => {
  it('找出全部的 ArrayBuffer：共用的只算一次；Map、Set、循环引用都不怕；数组里的数不进栈', () => {
    const shared = new Float32Array(8);
    const a = shared.subarray(0, 4);
    const b = shared.subarray(4);
    const own = new Int32Array(3);
    const loop: Record<string, unknown> = { a, b };
    loop.self = loop;
    const v = { loop, m: new Map([['k', { own }]]), s: new Set([own]), nums: Array.from({ length: 1000 }, (_, k) => k), raw: new ArrayBuffer(2) };
    const got = collectBuffers(v);
    expect(got).toHaveLength(3);
    expect(new Set(got)).toEqual(new Set([shared.buffer, own.buffer, v.raw]));
    // 对象太多：放弃（照常复制）
    expect(collectBuffers(v, 3)).toEqual([]);
  });
});
