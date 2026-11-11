import { beforeEach, describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import { engineFor } from '../core/testing/fixtures';
import { settingsSchema } from '../core/world';
import { EngineWorker, type RawWorker } from './engine-spawn';
import type { MirrorLog, Request, Response } from './protocol';
import { CANCELLED, EngineHost, Mirror, STOPPED_BACK, STOPPED_ONLY, type WorkerLike } from './sandbox';
import { FakeClock } from './testing/fake-clock';

// 第九十六轮：不是脚本的请求也能停（stopAny）；消息解不出来当作 Worker 坏了；命令记录给得出和引擎一样的“变了的命令”

class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessageerror: ((ev: unknown) => void) | null = null;
  sent: { id: number; req: Request }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.sent.push(m as { id: number; req: Request });
  }
  terminate() {
    this.terminated = true;
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
  replyLast(r: Omit<Extract<Response, { ok: true }>, 'id' | 'ok'>) {
    this.onmessage?.({ data: { id: this.last().id, ok: true, ...r } });
  }
}

const settings = settingsSchema.parse({ cells: 2000, seed: 1 });
const cmd = (humidity: number): Command => ({ op: 'set_planet', patch: { humidity } });
const log = (epoch: number, from: number, commands: Command[], ids: number[]): MirrorLog => ({ format: 'map2-world', version: 22, settings, epoch, from, commands, ids });
const docOf = (commands: Command[]): WorldDoc => ({ format: 'map2-world', version: 22, settings, commands });

function setup() {
  FakeWorker.all = [];
  const clock = new FakeClock();
  const seen: { reset: [string, boolean?][]; restored: number; failed: string[]; abandoned: number } = { reset: [], restored: 0, failed: [], abandoned: 0 };
  const host = new EngineHost(
    () => new FakeWorker(),
    {
      reset: (m, calm) => seen.reset.push(calm === undefined ? [m] : [m, calm]),
      restored: () => seen.restored++,
      failed: (m) => seen.failed.push(m),
      abandoned: () => seen.abandoned++,
    },
    clock,
  );
  return { clock, host, seen };
}
// 打开一个世界、做了一步（命令记录里有两条）
function opened() {
  const t = setup();
  const replies: Response[] = [];
  t.host.send({ kind: 'init', settings }, (r) => replies.push(r));
  FakeWorker.all[0].replyLast({ log: log(1, 0, [cmd(0.1)], [1]) });
  t.host.send({ kind: 'exec', cmd: cmd(0.2) }, (r) => replies.push(r));
  FakeWorker.all[0].replyLast({ log: log(1, 1, [cmd(0.2)], [1, 2]) });
  return { ...t, replies };
}

beforeEach(() => {
  FakeWorker.all = [];
});

describe('停下不是脚本的请求', () => {
  it('一步算了很久：停掉 Worker，这一步回“被停下了”，世界用命令记录回到这一步之前（不是安全模式）', () => {
    const { host, seen, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.9) }, (r) => replies.push(r));
    // 排在后面的也一样
    host.send({ kind: 'docTail', ids: [] }, (r) => replies.push(r));
    expect(host.waiting).toBe(true);
    expect(host.stopAny()).toBe(true);
    const w0 = FakeWorker.all[0];
    expect(w0.terminated).toBe(true);
    expect(replies.slice(2)).toEqual([
      { id: CANCELLED, ok: false, error: STOPPED_BACK, stopped: true },
      { id: CANCELLED, ok: false, error: STOPPED_BACK, stopped: true },
    ]);
    // 说的是“已停止，回到了这一步之前”，而且标着是用户自己停的
    expect(seen.reset).toEqual([['已停止，回到了这一步之前', true]]);
    // 另开一个，打开的是这一步之前的世界（没算完的那一步不在里面）
    const w1 = FakeWorker.all[1];
    expect(w1.last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1), cmd(0.2)]) });
    w1.replyLast({ log: log(1, 0, [cmd(0.1), cmd(0.2)], [1, 2]), snapshot: {} as never });
    expect(seen.restored).toBe(1);
    expect(host.safe).toBe(false);
    expect(seen.failed).toEqual([]);
    // 停掉的那个 Worker 之后才送到的回复不算
    w0.onmessage?.({ data: { id: 3, ok: true, log: log(1, 2, [cmd(0.9)], [1, 2, 3]) } });
    expect(host.mirror.doc()).toEqual(docOf([cmd(0.1), cmd(0.2)]));
  });

  it('没有在等的请求：什么都不做', () => {
    const { host, seen } = opened();
    expect(host.waiting).toBe(false);
    expect(host.stopAny()).toBe(false);
    expect(FakeWorker.all[0].terminated).toBe(false);
    expect(seen.reset).toEqual([]);
  });

  it('正在跑脚本时：和原来的“停下”一样（说的是脚本）', () => {
    const { host, seen, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.9) }, (r) => replies.push(r));
    FakeWorker.all[0].onmessage?.({ data: { kind: 'script', phase: 'enter', label: '苔原' } });
    expect(host.stopAny()).toBe(true);
    expect(seen.reset).toEqual([['已停止“苔原”的脚本，这一步没做。重做记录已清空']]);
    expect(replies.at(-1)).toEqual({ id: CANCELLED, ok: false, error: '已停止“苔原”的脚本，这一步没做。重做记录已清空' });
  });

  it('启动时正在打开上次的世界（还没有世界）：只是不打开了——不换安全模式再开，不恢复，不另说一句', () => {
    const { host, seen } = setup();
    const replies: Response[] = [];
    host.send({ kind: 'load', doc: docOf([cmd(0.1)]) }, (r) => replies.push(r));
    expect(host.stopAny()).toBe(true);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(replies).toEqual([{ id: CANCELLED, ok: false, error: STOPPED_ONLY, stopped: true }]);
    // 没有再开 Worker
    expect(FakeWorker.all.length).toBe(1);
    expect(seen).toEqual({ reset: [], restored: 0, failed: [], abandoned: 0 });
    expect(host.alive).toBe(false);
    // 之后再打开照常
    host.send({ kind: 'load', doc: docOf([cmd(0.1)]) }, (r) => replies.push(r));
    expect(FakeWorker.all.length).toBe(2);
    expect(FakeWorker.all[1].last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1)]) });
  });

  it('开着一个世界时新建、打开别的世界到一半停下：回到原来的世界', () => {
    const { host, seen, replies } = opened();
    host.send({ kind: 'load', doc: docOf([cmd(0.7)]) }, (r) => replies.push(r));
    // 原来的 Worker 已经换掉（一个 Worker 只装一个世界），新的在打开
    expect(FakeWorker.all.length).toBe(2);
    expect(host.stopAny()).toBe(true);
    expect(replies.at(-1)).toEqual({ id: CANCELLED, ok: false, error: STOPPED_BACK, stopped: true });
    expect(FakeWorker.all[1].terminated).toBe(true);
    // 第三个 Worker 打开的是原来的世界，不是安全模式
    expect(FakeWorker.all[2].last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1), cmd(0.2)]) });
    expect(seen.reset).toEqual([[STOPPED_BACK, true]]);
  });

  it('安全模式打开的世界里停下：还是按安全模式打开回来', () => {
    const { host } = setup();
    host.send({ kind: 'load', doc: docOf([cmd(0.1)]), safe: true }, () => {}, '打开时选了不运行脚本');
    FakeWorker.all[0].replyLast({ log: log(1, 0, [cmd(0.1)], [1]), safe: true });
    host.send({ kind: 'exec', cmd: cmd(0.5) }, () => {});
    expect(host.stopAny()).toBe(true);
    expect(FakeWorker.all[1].last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1)]), safe: true });
    expect(host.safe).toBe(true);
    expect(host.safeReason).toBe('打开时选了不运行脚本');
  });

  it('伪造不了“被停下了”：Worker 自己回的出错不带这个记号', () => {
    const { host } = opened();
    const replies: Response[] = [];
    host.send({ kind: 'exec', cmd: cmd(0.9) }, (r) => replies.push(r));
    const w = FakeWorker.all[0];
    w.onmessage?.({ data: { id: w.last().id, ok: false, error: 'x', stopped: true } });
    expect(replies).toEqual([{ id: w.last().id, ok: false, error: 'x' }]);
  });
});

describe('消息解不出来', () => {
  it('当作 Worker 坏了：停掉它，在等的回出错，用命令记录恢复', () => {
    const { host, seen, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.9) }, (r) => replies.push(r));
    const w0 = FakeWorker.all[0];
    w0.onmessageerror!({});
    expect(w0.terminated).toBe(true);
    expect(replies.at(-1)).toMatchObject({ id: CANCELLED, ok: false });
    expect((replies.at(-1) as { stopped?: boolean }).stopped).toBeUndefined();
    expect(seen.reset).toEqual([['计算程序没有响应，这一步没做。重做记录已清空']]);
    expect(FakeWorker.all[1].last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1), cmd(0.2)]) });
    // 停掉以后那个 Worker 的事件不再接着
    expect(w0.onmessageerror).toBeNull();
  });

  it('开 Worker 的那一层把它传上来；还没打招呼时的和报错一样换普通的', async () => {
    const raws: (RawWorker & { url: string })[] = [];
    const create = (url: string): RawWorker => {
      const w = { url, onmessage: null, onerror: null, onmessageerror: null, postMessage: () => {}, terminate: () => {} } as RawWorker & { url: string };
      raws.push(w);
      return w;
    };
    const isolated: boolean[] = [];
    const ew = new EngineWorker({ code: async () => 'self.x=1', url: '/engine.js', create, isolated: (on) => isolated.push(on), setTimer: () => 0, clearTimer: () => {} });
    let errors = 0;
    ew.onmessageerror = () => errors++;
    await Promise.resolve();
    await Promise.resolve();
    expect(raws.length).toBe(1);
    expect(raws[0].url.startsWith('data:')).toBe(true);
    // 还没打招呼就解不出来：换普通的
    raws[0].onmessageerror!({});
    expect(raws.length).toBe(2);
    expect(raws[1].url).toBe('/engine.js');
    expect(isolated).toEqual([false]);
    expect(errors).toBe(0);
    // 之后的传上去
    raws[1].onmessageerror!({});
    expect(errors).toBe(1);
  });
});

describe('命令记录给的“变了的命令”', () => {
  it('和引擎的 docTail 逐值相同：执行、撤销、重做、换一个之后，各种“已经写下的”', () => {
    const eng = engineFor({ cells: 1500, seed: 3 });
    const mirror = new Mirror();
    let reported: number[] = [];
    const sync = () => {
      const l = { ...eng.docTail(reported), epoch: 1 };
      expect(mirror.apply(1, l)).toBe(true);
      reported = l.ids;
    };
    expect(mirror.tail([])).toBeNull();
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    sync();
    const bases: number[][] = [[]];
    const check = () => {
      bases.push(eng.docTail([]).ids);
      // 命令记录就是引擎的世界文件
      expect(mirror.doc()).toEqual(eng.toDoc());
      for (const base of [...bases, [99, 98], reported.slice(0, 1), [...reported, 1234]]) expect(mirror.tail(base)).toEqual(eng.docTail(base));
    };
    check();
    for (let k = 0; k < 6; k++) {
      eng.exec(cmd(0.1 * (k + 1)));
      sync();
      check();
    }
    eng.undo();
    sync();
    check();
    eng.undo();
    sync();
    check();
    eng.redo();
    sync();
    check();
    eng.replaceLast(cmd(0.77));
    sync();
    check();
    eng.exec(cmd(0.33));
    sync();
    check();
  });
});
