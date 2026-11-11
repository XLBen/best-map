import { beforeEach, describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import { settingsSchema } from '../core/world';
import type { MirrorLog, Request, Response, StagePing } from './protocol';
import { CANCELLED, EngineHost, STOPPED_BACK, type WorkerLike, readWorkerMessage } from './sandbox';
import { FakeClock } from './testing/fake-clock';

// 第九十七轮：带提示的一步走到哪了（Worker 发来的 stage）、“取消”轻的那一种（cancelEdits：请 Worker 在阶段之间自己停下）

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
  say(data: unknown) {
    this.onmessage?.({ data });
  }
}

const settings = settingsSchema.parse({ cells: 2000, seed: 1 });
const cmd = (humidity: number): Command => ({ op: 'set_planet', patch: { humidity } });
const log = (epoch: number, from: number, commands: Command[], ids: number[]): MirrorLog => ({ format: 'map2-world', version: 22, settings, epoch, from, commands, ids });
const docOf = (commands: Command[]): WorldDoc => ({ format: 'map2-world', version: 22, settings, commands });

function opened() {
  FakeWorker.all = [];
  const stages: [StagePing, Request['kind']][] = [];
  const seen = { reset: [] as string[], restored: 0 };
  const host = new EngineHost(() => new FakeWorker(), { reset: (m) => seen.reset.push(m), restored: () => seen.restored++, stage: (p, req) => stages.push([p, req.kind]) }, new FakeClock());
  const replies: Response[] = [];
  host.send({ kind: 'init', settings }, (r) => replies.push(r));
  const w = FakeWorker.all[0];
  w.say({ id: w.last().id, ok: true, log: log(1, 0, [cmd(0.1)], [1]) });
  return { host, w, replies, stages, seen };
}

beforeEach(() => {
  FakeWorker.all = [];
});

describe('走到哪一步了', () => {
  it('消息先检查：只认整数的编号、短的名字、第几步不超过共几步；别的不要', () => {
    expect(readWorkerMessage({ kind: 'stage', req: 3, step: 'climate', k: 2, n: 5 })).toEqual({ type: 'stage', ping: { kind: 'stage', req: 3, step: 'climate', k: 2, n: 5 } });
    expect(readWorkerMessage({ kind: 'stage', req: 3, step: 'replay', k: 0, n: 800, inner: true, extra: '不要' })).toEqual({ type: 'stage', ping: { kind: 'stage', req: 3, step: 'replay', k: 0, n: 800, inner: true } });
    // 名字截短
    const long = readWorkerMessage({ kind: 'stage', req: 3, step: 'x'.repeat(500), k: 1, n: 1 });
    expect(long?.type === 'stage' && long.ping.step.length).toBe(40);
    for (const bad of [
      { kind: 'stage', req: 1.5, step: 'a', k: 1, n: 1 },
      { kind: 'stage', req: 1, step: '', k: 1, n: 1 },
      { kind: 'stage', req: 1, step: 7, k: 1, n: 1 },
      { kind: 'stage', req: 1, step: 'a', k: 3, n: 2 },
      { kind: 'stage', req: 1, step: 'a', k: -1, n: 2 },
      { kind: 'stage', req: 1, step: 'a', k: 1, n: Infinity },
      { kind: 'stage', req: 1, step: 'a', k: '1', n: 2 },
    ])
      expect(readWorkerMessage(bad), JSON.stringify(bad)).toBeNull();
  });

  it('交给界面，连同是哪一个请求；不在等的请求的、停掉了的 Worker 的不要', () => {
    const { host, w, stages, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.5) }, (r) => replies.push(r));
    const id = w.last().id;
    w.say({ kind: 'stage', req: id, step: 'elevation', k: 1, n: 5 });
    w.say({ kind: 'stage', req: id + 100, step: 'climate', k: 2, n: 5 });
    expect(stages).toEqual([[{ kind: 'stage', req: id, step: 'elevation', k: 1, n: 5 }, 'exec']]);
    // 回复了以后再来的不要
    w.say({ id, ok: true, log: log(1, 1, [cmd(0.5)], [1, 2]) });
    w.say({ kind: 'stage', req: id, step: 'features', k: 5, n: 5 });
    expect(stages.length).toBe(1);
    // 不算回复：还在等的照样在等
    expect(replies.length).toBe(2);
  });
});

describe('取消：请计算程序自己停下', () => {
  it('发一条 cancel（编号到最后一个请求为止）；它回 soft 的那几步标成用户取消的，Worker 不换、命令记录不动', () => {
    const { host, w, replies, seen } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.5) }, (r) => replies.push(r));
    host.send({ kind: 'exec', cmd: cmd(0.6) }, (r) => replies.push(r));
    const [a, b] = w.sent.slice(-2).map((m) => m.id);
    expect(host.cancelEdits()).toBe(true);
    expect(w.last().req).toEqual({ kind: 'cancel', upTo: b });
    // 取消本身马上回了
    w.say({ id: w.last().id, ok: true });
    w.say({ id: a, ok: false, error: '已取消', soft: true });
    w.say({ id: b, ok: false, error: '已取消', soft: true });
    expect(replies.slice(1)).toEqual([
      { id: a, ok: false, error: STOPPED_BACK, stopped: true, soft: true },
      { id: b, ok: false, error: STOPPED_BACK, stopped: true, soft: true },
    ]);
    expect(w.terminated).toBe(false);
    expect(FakeWorker.all.length).toBe(1);
    expect(seen).toEqual({ reset: [], restored: 0 });
    expect(host.mirror.doc()).toEqual(docOf([cmd(0.1)]));
    expect(host.waiting).toBe(false);
    // 之后照常
    host.send({ kind: 'exec', cmd: cmd(0.7) }, (r) => replies.push(r));
    w.say({ id: w.last().id, ok: true, log: log(1, 1, [cmd(0.7)], [1, 3]) });
    expect(host.mirror.doc()).toEqual(docOf([cmd(0.1), cmd(0.7)]));
  });

  it('没要过它取消：它说的 soft 不作数（脚本伪造不出“被取消了”），只当一条出错', () => {
    const { host, w, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.5) }, (r) => replies.push(r));
    w.say({ id: w.last().id, ok: false, error: '伪造的', soft: true, stopped: true });
    expect(replies.at(-1)).toEqual({ id: w.last().id, ok: false, error: '伪造的' });
  });

  it('要过以后才发的请求：不在取消的范围里，它说 soft 也不作数', () => {
    const { host, w, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.5) }, (r) => replies.push(r));
    const a = w.last().id;
    host.cancelEdits();
    host.send({ kind: 'exec', cmd: cmd(0.6) }, (r) => replies.push(r));
    const b = w.last().id;
    w.say({ id: a, ok: false, error: '已取消', soft: true });
    w.say({ id: b, ok: false, error: '已取消', soft: true });
    expect(replies.slice(1)).toEqual([
      { id: a, ok: false, error: STOPPED_BACK, stopped: true, soft: true },
      { id: b, ok: false, error: '已取消' },
    ]);
  });

  it('没有改动世界的请求在等（只有后台的、正在打开）：不发，返回 false', () => {
    const { host, w } = opened();
    expect(host.cancelEdits()).toBe(false);
    host.send({ kind: 'docTail', ids: [] }, () => {});
    expect(host.cancelEdits()).toBe(false);
    expect(w.sent.some((m) => m.req.kind === 'cancel')).toBe(false);
    host.send({ kind: 'load', doc: docOf([cmd(0.9)]) }, () => {});
    expect(host.opening).toBe(true);
    expect(host.cancelEdits()).toBe(false);
  });

  it('请了它、它却没停下来就算完了：照常算完的那一步作数', () => {
    const { host, w, replies } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.5) }, (r) => replies.push(r));
    const a = w.last().id;
    host.cancelEdits();
    w.say({ id: a, ok: true, log: log(1, 1, [cmd(0.5)], [1, 2]) });
    expect(replies.at(-1)).toMatchObject({ id: a, ok: true });
    expect(host.mirror.doc()).toEqual(docOf([cmd(0.1), cmd(0.5)]));
  });

  it('请了它之后结束它（它一直没动静）：在等的都回“被停下了”，世界用命令记录恢复', () => {
    const { host, w, replies, seen } = opened();
    host.send({ kind: 'exec', cmd: cmd(0.5) }, (r) => replies.push(r));
    host.cancelEdits();
    expect(host.stopAny()).toBe(true);
    expect(w.terminated).toBe(true);
    expect(replies.at(-1)).toEqual({ id: CANCELLED, ok: false, error: STOPPED_BACK, stopped: true });
    expect(seen.reset).toEqual([STOPPED_BACK]);
    expect(FakeWorker.all[1].last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1)]) });
  });
});

describe('正在新建、打开时取消', () => {
  it('那一刻正好有脚本在跑：也是不要这个世界了——不换安全模式接着打开，回到原来的世界', () => {
    const { host, w, replies, seen } = opened();
    host.send({ kind: 'load', doc: docOf([cmd(0.7)]) }, (r) => replies.push(r));
    const w1 = FakeWorker.all[1];
    expect(w.terminated).toBe(true);
    w1.say({ kind: 'script', phase: 'enter', label: '苔原' });
    expect(host.running).toBe('苔原');
    expect(host.stopAny()).toBe(true);
    expect(w1.terminated).toBe(true);
    expect(replies.at(-1)).toMatchObject({ ok: false, stopped: true });
    expect(seen.reset).toEqual(['已取消，回到了原来的世界']);
    // 第三个 Worker 打开的是原来的世界，不是安全模式
    expect(FakeWorker.all[2].last().req).toEqual({ kind: 'load', doc: docOf([cmd(0.1)]) });
    expect(host.safe).toBe(false);
  });
});
