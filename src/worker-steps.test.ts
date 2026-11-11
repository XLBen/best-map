import { describe, expect, it } from 'vitest';
import { type Pace, Stopped, YIELD_AFTER_MS, channelRest, runSteps } from './worker-steps';

// 第九十七轮：计算 Worker 里久的一步怎么走——短的一口气走完（不让出线程），久的在阶段之间让出、能取消

// 一串分阶段的计算：每一段“用”ms 毫秒（假的时钟往前走）；记下走到了哪、有没有被抛进一个错
function work(clock: { t: number }, stages: number[], log: string[]) {
  return (function* (): Generator<void, string> {
    try {
      for (let k = 0; k < stages.length; k++) {
        clock.t += stages[k];
        log.push(`做完第 ${k + 1} 段`);
        yield;
      }
      return '做完了';
    } catch (e) {
      log.push(`退回：${(e as Error).message}`);
      throw e;
    }
  })();
}
function pace(clock: { t: number }, onRest: () => void = () => {}): Pace & { rests: number } {
  const p = {
    rests: 0,
    now: () => clock.t,
    rest: async () => {
      p.rests++;
      onRest();
    },
  };
  return p;
}

describe('久的一步怎么走', () => {
  it('半秒以内做完的：一次都不让出线程（和以前一口气走完是同一条路）', async () => {
    const clock = { t: 0 };
    const log: string[] = [];
    const p = pace(clock);
    expect(await runSteps(work(clock, [100, 150, 200], log), () => false, p, YIELD_AFTER_MS)).toBe('做完了');
    expect(p.rests).toBe(0);
    expect(log.length).toBe(3);
  });

  it('过了半秒：之后每个阶段的边界让出一次', async () => {
    const clock = { t: 0 };
    const p = pace(clock);
    expect(await runSteps(work(clock, [300, 300, 300, 300], []), () => false, p, YIELD_AFTER_MS)).toBe('做完了');
    // 第 2、3、4 段做完时已经过了半秒
    expect(p.rests).toBe(3);
  });

  it('让出回来发现不要了：往里抛一个错，引擎退回，这个错原样出来；后面的不再算', async () => {
    const clock = { t: 0 };
    const log: string[] = [];
    let cancelled = false;
    const p = pace(clock, () => {
      if (p.rests === 2) cancelled = true;
    });
    await expect(runSteps(work(clock, [600, 100, 100, 100], log), () => cancelled, p, YIELD_AFTER_MS)).rejects.toBeInstanceOf(Stopped);
    expect(log).toEqual(['做完第 1 段', '做完第 2 段', '退回：已取消']);
  });

  it('还没开始就不要了（排着的时候点了取消）：不开始', async () => {
    const clock = { t: 0 };
    const log: string[] = [];
    await expect(runSteps(work(clock, [100], log), () => true, pace(clock), YIELD_AFTER_MS)).rejects.toBeInstanceOf(Stopped);
    expect(log).toEqual([]);
  });

  it('不让出的时候听不到取消：半秒以内做完的照常做完', async () => {
    const clock = { t: 0 };
    let asked = 0;
    const r = await runSteps(
      work(clock, [100, 100], []),
      () => asked++ > 0,
      pace(clock),
      YIELD_AFTER_MS,
    );
    expect(r).toBe('做完了');
    // 只在开始前问了一次
    expect(asked).toBe(1);
  });

  it('让出线程：先发来的消息在回来之前已经处理了', async () => {
    const rest = channelRest();
    const order: string[] = [];
    const ch = new MessageChannel();
    ch.port1.onmessage = () => order.push('别人发来的消息');
    ch.port2.postMessage(0);
    await rest();
    order.push('回来了');
    await rest();
    ch.port1.close();
    ch.port2.close();
    expect(order).toEqual(['别人发来的消息', '回来了']);
  });
});
