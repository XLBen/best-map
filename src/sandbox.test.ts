import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { WorldDoc } from '../core/engine';
import { settingsSchema } from '../core/world';
import type { MirrorLog, Request, Response } from './protocol';
import { CANCELLED, type Clock, EngineHost, type HostOptions, Mirror, WATCH, Watchdog, type WorkerLike, readWorkerMessage } from './sandbox';

// 计算 Worker 的看护：看门狗只在脚本运行期间计时、电脑睡眠不算；卡住、停下时停掉 Worker，用主线程的命令记录另开一个恢复；
// 恢复也卡住就用安全模式；旧的纪元、旧的 Worker 的消息不要。这里的时钟、Worker 都是假的

class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; ms: number; f: () => void; on: boolean }[] = [];
  now = () => this.t;
  every = (ms: number, f: () => void) => {
    const timer = { at: this.t + ms, ms, f, on: true };
    this.timers.push(timer);
    return () => {
      timer.on = false;
    };
  };
  // 时间往前走 ms，到点的定时器按时触发
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.on && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      next.at += next.ms;
      next.f();
    }
    this.t = end;
    this.timers = this.timers.filter((x) => x.on);
  }
  // 电脑睡了 ms：期间定时器都没触发，醒来时到期的各触发一次（浏览器把错过的合并成一次）
  sleep(ms: number) {
    this.t += ms;
    for (const x of this.timers.filter((y) => y.on && y.at <= this.t)) {
      x.at = this.t + x.ms;
      x.f();
    }
  }
}

class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: { id: number; req: Request }[] = [];
  // 每条消息的转移列表
  transfers: (Transferable[] | undefined)[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown, transfer?: Transferable[]) {
    this.sent.push(m as { id: number; req: Request });
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
  replyLast(r: Omit<Extract<Response, { ok: true }>, 'id' | 'ok'>) {
    this.emit({ id: this.last().id, ok: true, ...r });
  }
  enter(label: string) {
    this.emit({ kind: 'script', phase: 'enter', label });
  }
}

const settings = settingsSchema.parse({ cells: 2000, seed: 1 });
const cmd = (humidity: number): Command => ({ op: 'set_planet', patch: { humidity } });
const log = (epoch: number, from: number, commands: Command[], ids: number[]): MirrorLog => ({ format: 'map2-world', version: 5, settings, epoch, from, commands, ids });
const docOf = (commands: Command[]): WorldDoc => ({ format: 'map2-world', version: 5, settings, commands });

function setup(opts?: HostOptions) {
  FakeWorker.all = [];
  const clock = new FakeClock();
  const events = { slow: vi.fn(), reset: vi.fn(), restored: vi.fn(), failed: vi.fn(), abandoned: vi.fn(), checkpoint: vi.fn() };
  const host = new EngineHost(() => new FakeWorker(), events, clock, opts);
  const results: Response[] = [];
  const send = (req: Request) => host.send(req, (r) => results.push(r));
  return { clock, events, host, results, send, worker: (k: number) => FakeWorker.all[k] };
}

// 打开一个两步的世界：命令记录里是 cmd(1.1)、cmd(1.2)
function opened(opts?: HostOptions) {
  const t = setup(opts);
  t.send({ kind: 'load', doc: docOf([cmd(1.1)]) });
  t.worker(0).replyLast({ log: log(1, 0, [cmd(1.1)], [1]), safe: false });
  t.send({ kind: 'exec', cmd: cmd(1.2) });
  t.worker(0).replyLast({ summary: '改了', log: log(1, 1, [cmd(1.2)], [1, 2]) });
  expect(t.host.mirror.doc()!.commands).toEqual([cmd(1.1), cmd(1.2)]);
  t.results.length = 0;
  return t;
}

describe('看门狗', () => {
  const watch = () => {
    const clock = new FakeClock();
    const on = { hung: vi.fn(), slow: vi.fn() };
    return { clock, on, wd: new Watchdog(clock, on) };
  };

  it('进入脚本后 4 秒没有消息判定卡住；1.5 秒时说“正在运行”；没在跑脚本时不计时', () => {
    const { clock, on, wd } = watch();
    clock.advance(20000);
    expect(on.hung).not.toHaveBeenCalled();
    wd.ping('enter', '水晶丛林');
    clock.advance(1000);
    expect(on.slow).not.toHaveBeenCalled();
    clock.advance(500);
    expect(on.slow).toHaveBeenLastCalledWith('水晶丛林');
    clock.advance(WATCH.silence - 1500 - 1);
    expect(on.hung).not.toHaveBeenCalled();
    clock.advance(600);
    expect(on.hung).toHaveBeenCalledTimes(1);
    expect(on.hung).toHaveBeenCalledWith('水晶丛林');
    // 判定之后不再计时，“正在运行”去掉
    expect(on.slow).toHaveBeenLastCalledWith(null);
    expect(wd.running).toBeNull();
    clock.advance(20000);
    expect(on.hung).toHaveBeenCalledTimes(1);
  });

  it('一直报平安（每 250 毫秒）不算卡住；算完就不再计时', () => {
    const { clock, on, wd } = watch();
    wd.ping('enter', '死亡森林');
    for (let k = 0; k < 120; k++) {
      clock.advance(250);
      wd.ping('tick', '死亡森林');
    }
    expect(on.hung).not.toHaveBeenCalled();
    wd.ping('exit', '死亡森林');
    expect(on.slow).toHaveBeenLastCalledWith(null);
    clock.advance(30000);
    expect(on.hung).not.toHaveBeenCalled();
    // 算完后来的“平安”不会重新开始计时
    wd.ping('tick', '死亡森林');
    clock.advance(30000);
    expect(on.hung).not.toHaveBeenCalled();
  });

  it('电脑睡眠（检查晚了 2 秒以上）不算卡住，醒来后重新计时', () => {
    const { clock, on, wd } = watch();
    wd.ping('enter', '虫群占领区');
    clock.advance(3000);
    clock.sleep(60000);
    expect(on.hung).not.toHaveBeenCalled();
    clock.advance(3500);
    expect(on.hung).not.toHaveBeenCalled();
    clock.advance(1000);
    expect(on.hung).toHaveBeenCalledWith('虫群占领区');
  });
});

describe('Worker 发来的消息', () => {
  it('只认带 id 的回复和脚本的进入、平安、算完；字符串截短', () => {
    expect(readWorkerMessage(null)).toBeNull();
    expect(readWorkerMessage('hello')).toBeNull();
    expect(readWorkerMessage([1, 2])).toBeNull();
    expect(readWorkerMessage({ kind: 'checkpointData', cp: {} })).toBeNull();
    expect(readWorkerMessage({ kind: 'script', phase: 'boom', label: 'x' })).toBeNull();
    expect(readWorkerMessage({ kind: 'script', phase: 'tick', label: 3 })).toBeNull();
    expect(readWorkerMessage({ id: '1', ok: true })).toBeNull();
    expect(readWorkerMessage({ id: 1.5, ok: true })).toBeNull();
    expect(readWorkerMessage({ id: 1 })).toBeNull();
    const ping = readWorkerMessage({ kind: 'script', phase: 'enter', label: '名'.repeat(500) });
    expect(ping).toMatchObject({ type: 'script', ping: { phase: 'enter' } });
    expect((ping as { ping: { label: string } }).ping.label.length).toBe(60);
    const err = readWorkerMessage({ id: 3, ok: false, error: 'x'.repeat(10000) });
    expect((err as { reply: { error: string } }).reply.error.length).toBe(2000);
    expect(readWorkerMessage({ id: 4, ok: false })).toEqual({ type: 'reply', reply: { id: 4, ok: false, error: '计算出错' } });
  });

  it('没有在等的回复、伪造的怪消息不影响任何请求', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.3) });
    t.worker(0).emit({ id: 999, ok: true, summary: '假的' });
    t.worker(0).emit({ kind: 'hello' });
    expect(t.results).toEqual([]);
    t.worker(0).replyLast({ summary: '真的', log: log(1, 2, [cmd(1.3)], [1, 2, 3]) });
    expect(t.results).toMatchObject([{ ok: true, summary: '真的' }]);
  });
});

describe('命令记录', () => {
  it('接得上的才要：旧的纪元、步号对不上、更早的 Worker 的一律不要', () => {
    const m = new Mirror();
    expect(m.doc()).toBeNull();
    // 接不上（没有从头发过）
    expect(m.apply(1, log(1, 1, [cmd(1.2)], [1, 2]))).toBe(false);
    expect(m.apply(1, log(1, 0, [cmd(1.1)], [1]))).toBe(true);
    expect(m.apply(1, log(1, 1, [cmd(1.2)], [1, 2]))).toBe(true);
    // 换了一个世界（纪元 2，从头发）
    expect(m.apply(1, log(2, 0, [cmd(2.1)], [1]))).toBe(true);
    // 上一个世界的、步号碰巧对得上的旧消息：不要
    expect(m.apply(1, log(1, 1, [cmd(1.3)], [1, 3]))).toBe(false);
    expect(m.apply(1, log(1, 0, [cmd(9)], [1]))).toBe(false);
    expect(m.doc()!.commands).toEqual([cmd(2.1)]);
    // 步号的前缀对不上
    expect(m.apply(1, log(2, 1, [cmd(2.2)], [7, 8]))).toBe(false);
    // 长短对不上、缺字段
    expect(m.apply(1, { ...log(2, 1, [cmd(2.2)], [1, 2, 3]) })).toBe(false);
    expect(m.apply(1, { epoch: 2, from: 0, commands: [], ids: [] })).toBe(false);
    // 撤销（from 不变、少了命令）
    expect(m.apply(1, log(2, 1, [cmd(2.2)], [1, 2]))).toBe(true);
    expect(m.apply(1, log(2, 1, [], [1]))).toBe(true);
    expect(m.doc()!.commands).toEqual([cmd(2.1)]);
    // 更早的 Worker 的消息不要；新 Worker 从头发的要
    expect(m.apply(2, log(1, 0, [cmd(3.1)], [1]))).toBe(true);
    expect(m.apply(1, log(5, 0, [cmd(4)], [1]))).toBe(false);
    expect(m.doc()!.commands).toEqual([cmd(3.1)]);
  });
});

describe('卡住了：恢复', () => {
  it('编辑时卡住：停掉 Worker，这一步回 {ok:false}，另开一个用命令记录打开（不是安全模式）', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.5) });
    t.send({ kind: 'preview', cmd: cmd(1.6) });
    t.worker(0).enter('水晶丛林');
    t.clock.advance(WATCH.silence + WATCH.interval);
    expect(t.worker(0).terminated).toBe(true);
    expect(t.results).toHaveLength(2);
    expect(t.results[0]).toMatchObject({ ok: false });
    expect((t.results[0] as { error: string }).error).toBe('「水晶丛林」的脚本卡住了（4 秒没有算完），已经停下，这一步没有做。重做记录清空了');
    expect(t.results[1]).toMatchObject({ ok: false });
    expect(t.events.reset).toHaveBeenCalledTimes(1);
    // 新的 Worker 打开的是命令记录里的世界（卡住的那一步不在里面）
    const w1 = t.worker(1);
    expect(w1.sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2)]) }]);
    // 恢复期间来的请求排在打开后面
    t.send({ kind: 'exec', cmd: cmd(1.7) });
    expect(w1.sent.map((m) => m.req.kind)).toEqual(['load', 'exec']);
    w1.emit({ id: w1.sent[0].id, ok: true, summary: '已打开世界文件', log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: false });
    expect(t.events.restored).toHaveBeenCalledTimes(1);
    expect(t.events.restored.mock.calls[0][1]).toBeNull();
    // 停掉的 Worker 后来的消息不要
    t.worker(0).emit({ id: t.worker(0).sent[2].id, ok: true, summary: '迟到的' });
    expect(t.results).toHaveLength(2);
    w1.emit({ id: w1.sent[1].id, ok: true, summary: '改了', log: log(1, 2, [cmd(1.7)], [1, 2, 3]) });
    expect(t.results[2]).toMatchObject({ ok: true, summary: '改了' });
    expect(t.host.mirror.doc()!.commands).toEqual([cmd(1.1), cmd(1.2), cmd(1.7)]);
  });

  it('恢复时又卡住：用安全模式打开同一个世界', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.5) });
    t.worker(0).enter('死亡森林');
    t.clock.advance(5000);
    const w1 = t.worker(1);
    w1.enter('死亡森林');
    t.clock.advance(5000);
    expect(w1.terminated).toBe(true);
    const w2 = t.worker(2);
    expect(w2.sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2)]), safe: true }]);
    expect(t.host.safe).toBe(true);
    w2.replyLast({ summary: '已打开世界文件', log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: true });
    expect(t.events.restored).toHaveBeenCalledTimes(1);
    expect(t.events.restored.mock.calls[0][1]).toBe('「死亡森林」的脚本卡住了');
    // 安全模式的 Worker 里不跑脚本：之后一直用它，直到打开别的世界
    t.send({ kind: 'undo' });
    expect(FakeWorker.all).toHaveLength(3);
    expect(w2.last().req).toEqual({ kind: 'undo' });
  });

  it('打开的世界卡住了：直接用安全模式打开它，回复照旧交给打开的请求', () => {
    const t = opened();
    const doc = docOf([cmd(5)]);
    // 一个 Worker 只装一个世界：打开别的世界时另开
    t.send({ kind: 'load', doc });
    t.send({ kind: 'docTail', ids: [] });
    t.worker(1).enter('神圣之地');
    t.clock.advance(5000);
    // 后面排着的作废；打开的请求还没有回复
    expect(t.results).toMatchObject([{ ok: false }]);
    expect(t.events.reset).not.toHaveBeenCalled();
    const w1 = t.worker(2);
    expect(w1.sent.map((m) => m.req)).toEqual([{ kind: 'load', doc, safe: true }]);
    w1.replyLast({ summary: '已打开世界文件', log: log(1, 0, [cmd(5)], [1]), safe: true });
    expect(t.results[1]).toMatchObject({ ok: true, safe: true });
    expect(t.host.safeReason).toBe('「神圣之地」的脚本卡住了');
    expect(t.events.restored).not.toHaveBeenCalled();
    expect(t.host.mirror.doc()!.commands).toEqual([cmd(5)]);
  });

  it('“停下”：与卡住一样恢复；没在跑脚本时什么都不做', () => {
    const t = opened();
    expect(t.host.stop()).toBe(false);
    t.send({ kind: 'exec', cmd: cmd(1.5) });
    t.worker(0).enter('血腥之地');
    t.clock.advance(1600);
    expect(t.events.slow).toHaveBeenLastCalledWith('血腥之地');
    expect(t.host.running).toBe('血腥之地');
    expect(t.host.stop()).toBe(true);
    expect(t.events.slow).toHaveBeenLastCalledWith(null);
    expect((t.results[0] as { error: string }).error).toBe('已经停下「血腥之地」的脚本，这一步没有做。重做记录清空了');
    expect(t.worker(1).sent[0].req).toEqual({ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2)]) });
  });

  it('Worker 崩了：同样用命令记录恢复；恢复时打开出错就用安全模式', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.5) });
    t.worker(0).onerror?.(new Error('崩了'));
    expect((t.results[0] as { error: string }).error).toBe('计算程序停止了响应，这一步没有做。重做记录清空了');
    const w1 = t.worker(1);
    w1.emit({ id: w1.last().id, ok: false, error: '第 2 条命令失败：坏了' });
    const w2 = t.worker(2);
    expect(w2.sent[0].req).toMatchObject({ kind: 'load', safe: true });
    w2.replyLast({ log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: true });
    expect(t.events.restored.mock.calls[0][1]).toBe('恢复时出错');
  });

  it('换模式时另开一个 Worker（一个 Worker 的模式从开起就固定）', () => {
    const t = opened();
    t.send({ kind: 'preview', cmd: cmd(2) });
    t.send({ kind: 'load', doc: docOf([cmd(3)]), safe: true });
    expect(t.worker(0).terminated).toBe(true);
    expect(t.results).toMatchObject([{ ok: false }]);
    expect(t.worker(1).sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(3)]), safe: true }]);
    t.worker(1).replyLast({ log: log(1, 0, [cmd(3)], [1]), safe: true });
    // 同样是安全模式：也另开（一个 Worker 只装一个世界），原因换成这一次的
    t.host.send({ kind: 'load', doc: docOf([cmd(4)]), safe: true }, () => undefined, '打开时选了不运行脚本');
    expect(FakeWorker.all).toHaveLength(3);
    expect(t.host.safe).toBe(true);
    expect(t.host.safeReason).toBe('打开时选了不运行脚本');
    // 再试一次（正常打开）：另开
    t.send({ kind: 'load', doc: docOf([cmd(4)]) });
    expect(FakeWorker.all).toHaveLength(4);
    expect(t.host.safe).toBe(false);
  });

  it('安全模式下 Worker 也崩了：不自动重开；下次用到世界时按安全模式打开命令记录里的世界', () => {
    const t = setup();
    t.send({ kind: 'load', doc: docOf([cmd(7)]), safe: true });
    t.worker(0).replyLast({ log: log(1, 0, [cmd(7)], [1]), safe: true });
    t.worker(0).onerror?.(new Error('崩了'));
    expect(t.events.failed).toHaveBeenCalledTimes(1);
    expect(FakeWorker.all).toHaveLength(1);
    // 向导的缩略图用不着世界
    t.send({ kind: 'thumb', settings: {}, gen: { seed: 1, type: 'continents' }, width: 8, height: 4 });
    expect(t.worker(1).sent.map((m) => m.req.kind)).toEqual(['thumb']);
    t.worker(1).replyLast({});
    t.send({ kind: 'undo' });
    const w = FakeWorker.all.at(-1)!;
    expect(w.sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(7)]), safe: true }, { kind: 'undo' }]);
    expect(t.host.safe).toBe(true);
  });

  it('换模式另开的 Worker 打开失败：原来的世界按原来的模式打开回来（不会留下一个没有世界的 Worker）', () => {
    const t = opened();
    t.send({ kind: 'load', doc: docOf([cmd(3)]), safe: true });
    const w1 = t.worker(1);
    w1.emit({ id: w1.last().id, ok: false, error: '不是 map2 世界文件' });
    expect(t.results).toMatchObject([{ ok: false, error: '不是 map2 世界文件' }]);
    expect(w1.terminated).toBe(true);
    const w2 = t.worker(2);
    expect(w2.sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2)]) }]);
    expect(t.host.safe).toBe(false);
    w2.replyLast({ log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: false });
    expect(t.events.restored).toHaveBeenCalledTimes(1);
    expect(t.events.restored.mock.calls[0][1]).toBeNull();
    // 再打开别的世界（另开的 Worker）失败：原来的世界照样打开回来
    t.send({ kind: 'load', doc: docOf([cmd(9)]) });
    expect(w2.terminated).toBe(true);
    const w3 = t.worker(3);
    w3.emit({ id: w3.last().id, ok: false, error: '坏了' });
    expect(t.results.at(-1)).toMatchObject({ ok: false, error: '坏了' });
    expect(t.worker(4).sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2)]) }]);
  });

  it('恢复到一半打开了别的世界（换了模式）：恢复作废，不另开安全模式的 Worker，新世界照要的模式打开', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.5) });
    t.worker(0).enter('水晶丛林');
    t.clock.advance(5000);
    expect(t.worker(1).sent.map((m) => m.req.kind)).toEqual(['load']);
    // 正常模式恢复还没打开好，用户用“不运行脚本打开”打开了另一个世界
    const other = docOf([cmd(8)]);
    t.send({ kind: 'load', doc: other, safe: true });
    expect(t.worker(1).terminated).toBe(true);
    expect(t.events.abandoned).toHaveBeenCalledTimes(1);
    expect(t.events.failed).not.toHaveBeenCalled();
    expect(FakeWorker.all).toHaveLength(3);
    expect(t.worker(2).sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: other, safe: true }]);
    t.worker(2).replyLast({ log: log(1, 0, [cmd(8)], [1]), safe: true });
    expect(t.results.at(-1)).toMatchObject({ ok: true, safe: true });
    expect(t.events.restored).not.toHaveBeenCalled();

    // 反过来：安全模式的恢复还没好，用户正常打开别的世界
    const u = opened();
    u.send({ kind: 'exec', cmd: cmd(1.5) });
    u.worker(0).enter('死亡森林');
    u.clock.advance(5000);
    u.worker(1).enter('死亡森林');
    u.clock.advance(5000);
    expect(u.worker(2).sent[0].req).toMatchObject({ kind: 'load', safe: true });
    u.send({ kind: 'load', doc: other });
    expect(u.events.abandoned).toHaveBeenCalledTimes(1);
    expect(u.events.failed).not.toHaveBeenCalled();
    expect(u.worker(3).sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: other }]);
    expect(u.host.safe).toBe(false);
  });

  it('还没有世界时卡住（向导的缩略图）：不恢复、不说“重做记录清空了”；没有在等的请求时说一句', () => {
    const t = setup();
    t.send({ kind: 'thumb', settings: {}, gen: { seed: 1, type: 'continents' }, width: 8, height: 4 });
    t.worker(0).enter('双子大陆');
    t.clock.advance(5000);
    expect(t.results).toEqual([{ id: 0, ok: false, error: '「双子大陆」的脚本卡住了（4 秒没有算完），已经停下，这一步没有做' }]);
    // 星球形态编辑器按这个编号认出“被停下了”（同样的脚本不再自动重算缩略图）
    expect(t.results[0].id).toBe(CANCELLED);
    expect(t.events.reset).not.toHaveBeenCalled();
    expect(t.events.failed).not.toHaveBeenCalled();
    expect(FakeWorker.all).toHaveLength(1);
    // 下一张缩略图另开 Worker；它在后台卡住（没有在等的请求）
    t.send({ kind: 'thumb', settings: {}, gen: { seed: 2, type: 'continents' }, width: 8, height: 4 });
    t.worker(1).replyLast({});
    t.worker(1).enter('双子大陆');
    t.clock.advance(5000);
    expect(t.events.failed).toHaveBeenCalledWith('「双子大陆」的脚本卡住了（4 秒没有算完），已经停下');
    expect(t.events.reset).not.toHaveBeenCalled();
  });

  it('刚恢复的世界在后台又卡住（没有在等的请求）：改用安全模式，不会一直循环；在它里面算成过一步后照常恢复', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.5) });
    t.worker(0).enter('神圣之地');
    t.clock.advance(5000);
    const w1 = t.worker(1);
    w1.replyLast({ log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: false });
    expect(t.events.restored.mock.calls[0][1]).toBeNull();
    // 打开回复之后，Worker 在后台补算时卡住
    w1.enter('神圣之地');
    t.clock.advance(5000);
    expect(t.events.reset).toHaveBeenLastCalledWith('「神圣之地」的脚本卡住了（4 秒没有算完），已经停下。重做记录清空了');
    const w2 = t.worker(2);
    expect(w2.sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2)]), safe: true }]);
    w2.replyLast({ log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: true });
    expect(t.events.restored.mock.calls[1][1]).toBe('「神圣之地」的脚本卡住了');

    // 恢复后用户的一步算成了：之后再卡住照常（正常模式）恢复
    const u = opened();
    u.send({ kind: 'exec', cmd: cmd(1.5) });
    u.worker(0).enter('神圣之地');
    u.clock.advance(5000);
    u.worker(1).replyLast({ log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: false });
    u.send({ kind: 'exec', cmd: cmd(1.6) });
    u.worker(1).replyLast({ summary: '改了', log: log(1, 2, [cmd(1.6)], [1, 2, 3]) });
    u.worker(1).enter('神圣之地');
    u.clock.advance(5000);
    expect(u.worker(2).sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(1.1), cmd(1.2), cmd(1.6)]) }]);
  });
});

describe('检查点（隔离）', () => {
  // 打包好的程序：有版本号；向存储 Worker 要的通道（假的）按顺序编号；commit 记下来
  function withBuild() {
    const ports: { port: number }[] = [];
    const opened: [string, WorldDoc | null][] = [];
    const commits: [number, number, number[]][] = [];
    const opts: HostOptions = {
      build: 'b1',
      storeChannel: (build, doc) => {
        opened.push([build, doc]);
        const p = { port: ports.length };
        ports.push(p);
        return { port: p as unknown as Transferable, token: 100 + ports.length - 1 };
      },
      commit: (token, epoch, ids) => void commits.push([token, epoch, ids]),
    };
    return { opts, ports, opened, commits };
  }
  const ready = (epoch: number, ids: number[]) => ({ kind: 'checkpointReady', epoch, ids });

  it('写好检查点的通知：纪元、每一步的编号都要像样（只有编号，检查点本身不经过主线程）', () => {
    expect(readWorkerMessage(ready(1, [1, 2]))).toEqual({ type: 'checkpoint', epoch: 1, ids: [1, 2] });
    expect(readWorkerMessage(ready(1, []))).toEqual({ type: 'checkpoint', epoch: 1, ids: [] });
    expect(readWorkerMessage(ready(1.5, [1]))).toBeNull();
    expect(readWorkerMessage(ready(1, ['1' as unknown as number]))).toBeNull();
    expect(readWorkerMessage(ready(1, [1.5]))).toBeNull();
    expect(readWorkerMessage({ kind: 'checkpointReady', epoch: 1, ids: 'x' })).toBeNull();
    // 以前的样子（连同检查点发给主线程）不认
    expect(readWorkerMessage({ kind: 'checkpointData', build: 'b1', epoch: 1, cp: { done: [{ id: 1 }] } })).toBeNull();
  });

  it('新建、打开时带上版本号和存储的端口（端口转移，每次一条新的）；留着的请求里没有端口，恢复时另要一个；安全模式不要', () => {
    const b = withBuild();
    const t = setup(b.opts);
    const doc = docOf([cmd(1.1)]);
    t.send({ kind: 'load', doc });
    expect(b.opened).toEqual([['b1', doc]]);
    expect(t.worker(0).sent[0].req).toEqual({ kind: 'load', doc, build: 'b1', store: b.ports[0] });
    expect(t.worker(0).transfers[0]).toEqual([b.ports[0]]);
    t.worker(0).replyLast({ log: log(1, 0, [cmd(1.1)], [1]), safe: false });
    t.send({ kind: 'init', settings: {} });
    expect(b.opened[1]).toEqual(['b1', null]);
    expect(t.worker(1).last().req).toEqual({ kind: 'init', settings: {}, build: 'b1', store: b.ports[1] });
    expect(t.worker(1).transfers[0]).toEqual([b.ports[1]]);
    t.worker(1).replyLast({ log: log(1, 0, [cmd(2.1)], [1]), safe: false });
    // 别的请求不带
    t.send({ kind: 'exec', cmd: cmd(2.2) });
    expect(t.worker(1).last().req).toEqual({ kind: 'exec', cmd: cmd(2.2) });
    expect(t.worker(1).transfers[1]).toEqual([]);
    // 卡住了：恢复时的打开另要一个端口；它也卡住，用安全模式打开时不要
    t.worker(1).enter('水晶丛林');
    t.clock.advance(5000);
    expect(t.worker(2).sent[0].req).toEqual({ kind: 'load', doc: docOf([cmd(2.1)]), build: 'b1', store: b.ports[2] });
    t.clock.advance(1000);
    t.worker(2).enter('水晶丛林');
    t.clock.advance(5000);
    expect(t.worker(3).sent[0].req).toEqual({ kind: 'load', doc: docOf([cmd(2.1)]), safe: true, build: 'b1' });
    expect(b.ports).toHaveLength(3);
  });

  it('写好的检查点：步号与命令记录一模一样，才让存储 Worker 写下当前通道上的那一份', () => {
    const b = withBuild();
    const t = opened(b.opts);
    t.worker(0).emit(ready(1, [1, 2]));
    expect(b.commits).toEqual([[100, 1, [1, 2]]]);
    // 步号对不上（旧的、多了、少了、换了一步）、纪元不同：不要
    for (const ids of [[1], [1, 2, 3], [1, 3], []]) t.worker(0).emit(ready(1, ids));
    t.worker(0).emit(ready(2, [1, 2]));
    expect(b.commits).toHaveLength(1);
    // 不打扰在等的请求
    t.send({ kind: 'exec', cmd: cmd(1.3) });
    t.worker(0).emit(ready(1, [1, 2]));
    t.worker(0).replyLast({ summary: '改了', log: log(1, 2, [cmd(1.3)], [1, 2, 3]) });
    expect(t.results).toMatchObject([{ ok: true, summary: '改了' }]);
    t.worker(0).emit(ready(1, [1, 2, 3]));
    expect(b.commits).toEqual([
      [100, 1, [1, 2]],
      [100, 1, [1, 2]],
      [100, 1, [1, 2, 3]],
    ]);
    // 又打开了一个世界（另开的 Worker）：之后的按新通道的编号；旧 Worker 的不要
    t.send({ kind: 'load', doc: docOf([cmd(3.1)]) });
    t.worker(1).replyLast({ log: log(1, 0, [cmd(3.1)], [1]), safe: false });
    t.worker(0).emit(ready(1, [1, 2, 3]));
    t.worker(1).emit(ready(1, [1]));
    expect(b.commits.at(-1)).toEqual([101, 1, [1]]);
    expect(b.commits).toHaveLength(4);
  });

  it('停掉的旧 Worker、安全模式的 Worker 的通知不要；要不到通道（存储 Worker 用不了）、没有版本号（开发时）也不要', () => {
    const b = withBuild();
    const t = opened(b.opts);
    t.worker(0).enter('死亡森林');
    t.clock.advance(5000);
    const old = t.worker(0);
    t.worker(1).replyLast({ log: log(1, 0, [cmd(1.1), cmd(1.2)], [1, 2]), safe: false });
    old.emit(ready(1, [1, 2]));
    expect(b.commits).toEqual([]);
    // 安全模式
    t.send({ kind: 'load', doc: docOf([cmd(5)]), safe: true });
    t.worker(2).replyLast({ log: log(1, 0, [cmd(5)], [1]), safe: true });
    t.worker(2).emit(ready(1, [1]));
    expect(b.commits).toEqual([]);
    // 要不到通道
    const commits: unknown[] = [];
    const v = opened({ build: 'b1', storeChannel: () => null, commit: (...a) => void commits.push(a) });
    expect(v.worker(0).sent[0].req).toEqual({ kind: 'load', doc: docOf([cmd(1.1)]), build: 'b1' });
    v.worker(0).emit(ready(1, [1, 2]));
    expect(commits).toEqual([]);
    // 开发时：不带版本号和端口，也不写
    const u = opened({ storeChannel: () => ({ port: {} as Transferable, token: 1 }), commit: (...a) => void commits.push(a) });
    expect(u.worker(0).sent[0].req).toEqual({ kind: 'load', doc: docOf([cmd(1.1)]) });
    u.worker(0).emit(ready(1, [1, 2]));
    expect(commits).toEqual([]);
  });
});

describe('一个 Worker 只装一个世界', () => {
  it('一个 Worker 只装一个世界：新建、打开别的世界时另开一个；同一个世界里接着改不换', () => {
    const t = opened();
    t.send({ kind: 'exec', cmd: cmd(1.3) });
    t.worker(0).enter('水晶丛林');
    t.worker(0).emit({ kind: 'script', phase: 'exit', label: '水晶丛林' });
    t.worker(0).replyLast({ summary: '改了', log: log(1, 2, [cmd(1.3)], [1, 2, 3]) });
    // 在同一个世界里接着改：不换
    t.send({ kind: 'exec', cmd: cmd(1.4) });
    expect(FakeWorker.all).toHaveLength(1);
    t.worker(0).replyLast({ summary: '改了', log: log(1, 3, [cmd(1.4)], [1, 2, 3, 4]) });
    // 打开别的世界（没有脚本也一样）：另开，旧的停掉
    t.send({ kind: 'load', doc: docOf([cmd(2.1)]) });
    expect(t.worker(0).terminated).toBe(true);
    expect(t.worker(1).sent.map((m) => m.req)).toEqual([{ kind: 'load', doc: docOf([cmd(2.1)]) }]);
    t.worker(1).replyLast({ log: log(1, 0, [cmd(2.1)], [1]), safe: false });
    expect(t.host.mirror.doc()!.commands).toEqual([cmd(2.1)]);
    t.send({ kind: 'init', settings: {} });
    expect(t.worker(1).terminated).toBe(true);
    expect(t.worker(2).sent.map((m) => m.req.kind)).toEqual(['init']);
  });

  it('没装过世界的 Worker（只算过缩略图）接着用；缩略图里跑过脚本的不用', () => {
    const t = setup();
    t.send({ kind: 'thumb', settings: {}, gen: { seed: 2, type: 'continents' }, width: 8, height: 4 });
    t.worker(0).replyLast({});
    t.send({ kind: 'init', settings: {} });
    expect(FakeWorker.all).toHaveLength(1);
    t.worker(0).replyLast({ log: log(1, 0, [cmd(2.1)], [1]), safe: false });
    const u = setup();
    u.send({ kind: 'thumb', settings: {}, gen: { seed: 2, type: 'continents' }, width: 8, height: 4 });
    u.worker(0).enter('双子大陆');
    u.worker(0).emit({ kind: 'script', phase: 'exit', label: '双子大陆' });
    u.worker(0).replyLast({});
    u.send({ kind: 'init', settings: {} });
    expect(u.worker(0).terminated).toBe(true);
    expect(u.worker(1).sent.map((m) => m.req.kind)).toEqual(['init']);
  });

  it('warm：还没有 Worker 时先开一个（不是安全模式），打开世界时接着用它', () => {
    const t = setup();
    t.host.warm();
    t.host.warm();
    expect(FakeWorker.all).toHaveLength(1);
    expect(t.host.isCurrent(t.worker(0))).toBe(true);
    t.send({ kind: 'load', doc: docOf([cmd(1.1)]) });
    expect(FakeWorker.all).toHaveLength(1);
    expect(t.worker(0).sent).toHaveLength(1);
    // 要安全模式：另开
    t.worker(0).replyLast({ log: log(1, 0, [cmd(1.1)], [1]), safe: false });
    t.send({ kind: 'load', doc: docOf([cmd(1.1)]), safe: true });
    expect(t.host.isCurrent(t.worker(0))).toBe(false);
    expect(t.host.isCurrent(t.worker(1))).toBe(true);
  });
});
