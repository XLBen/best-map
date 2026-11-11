import type { Clock } from '../sandbox';

// 测试用的假时钟（sandbox.ts 的 Clock；第九十六轮从 sandbox.test.ts 里照样写一份出来，几个测试共用）
export class FakeClock implements Clock {
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
  // 还挂着几个定时器
  get active(): number {
    return this.timers.filter((x) => x.on).length;
  }
}
