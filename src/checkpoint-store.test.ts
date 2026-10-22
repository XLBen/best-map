import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import { settingsSchema } from '../core/world';
import { CheckpointStore, type StorageRequest, type StorageWorkerLike, checkpointFits } from './checkpoint-store';
import { cloneForTransfer, collectBuffers } from './transfer';

// 检查点的存取：存储 Worker 只把对得上这个世界的检查点交给计算 Worker（多出来的步可能是别的世界的，不给）；
// 写、读时数组都转移（主线程不复制）；存储 Worker 开不起来时不再用它

const settings = settingsSchema.parse({ cells: 2000, seed: 1 });
const cmd = (humidity: number): Command => ({ op: 'set_planet', patch: { humidity } });
const docOf = (commands: Command[], s: unknown = settings): WorldDoc => ({ format: 'map2-world', version: 2, settings: s as WorldDoc['settings'], commands });
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
  });
});

class FakeStorage implements StorageWorkerLike {
  onerror: ((ev: unknown) => void) | null = null;
  sent: { msg: StorageRequest; transfer: Transferable[] }[] = [];
  postMessage(msg: StorageRequest, transfer: Transferable[]) {
    this.sent.push({ msg, transfer });
  }
}

describe('主线程这边的存取', () => {
  it('写：数组转移过去；读：通道的一头交给存储 Worker（转移），另一头给计算 Worker', () => {
    const workers: FakeStorage[] = [];
    const store = new CheckpointStore(() => {
      const w = new FakeStorage();
      workers.push(w);
      return w;
    });
    const s = saved([cmd(1.1)]);
    store.put('b1', s.cp as never);
    expect(workers).toHaveLength(1);
    expect(workers[0].sent[0].msg.kind).toBe('put');
    expect(workers[0].sent[0].transfer).toEqual([s.cp.causes.h.buffer]);
    const doc = docOf([cmd(1.1)]);
    const port = store.take('b1', doc)!;
    expect(port).not.toBeNull();
    const { msg, transfer } = workers[0].sent[1];
    expect(msg.kind).toBe('take');
    if (msg.kind === 'take') {
      expect(msg.doc).toBe(doc);
      expect(transfer).toEqual([msg.port]);
      expect(msg.port).not.toBe(port);
      msg.port.close();
    }
    // 只开一个存储 Worker
    expect(workers).toHaveLength(1);
    (port as MessagePort).close();
  });

  it('存储 Worker 开不起来、出了错：不再用它（计算 Worker 照旧重放）', () => {
    const broken = new CheckpointStore(() => {
      throw new Error('开不了');
    });
    expect(broken.take('b1', docOf([cmd(1.1)]))).toBeNull();
    const w = new FakeStorage();
    const store = new CheckpointStore(() => w);
    expect(store.take('b1', docOf([cmd(1.1)]))).not.toBeNull();
    w.onerror?.({});
    expect(store.take('b1', docOf([cmd(1.1)]))).toBeNull();
    store.put('b1', saved([cmd(1.1)]).cp as never);
    expect(w.sent).toHaveLength(1);
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

  it('在 Worker 里复制一份再转移：原来的数组不受影响', () => {
    const cp = { causes: { h: new Float32Array([1, 2, 3]) } };
    const { value, transfer } = cloneForTransfer(cp);
    expect(value.causes.h).not.toBe(cp.causes.h);
    expect(transfer).toEqual([value.causes.h.buffer]);
    structuredClone(value, { transfer });
    expect(value.causes.h.length).toBe(0);
    expect([...cp.causes.h]).toEqual([1, 2, 3]);
  });
});
