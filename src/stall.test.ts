import { describe, expect, it } from 'vitest';
import { STOP_AFTER_MS, Stall } from './stall';
import { FakeClock } from './testing/fake-clock';

// 第九十六轮：计算程序多久没应答就给“停止”。按“多久没有回过一条”算，不按“忙了多久”

function setup() {
  const clock = new FakeClock();
  const seen: boolean[] = [];
  const stall = new Stall(clock, (on) => seen.push(on));
  return { clock, seen, stall };
}

describe('多久没应答就给“停止”', () => {
  it('有请求在等、5 秒没有回过一条：出现；回了就收起', () => {
    const { clock, seen, stall } = setup();
    stall.set(1);
    clock.advance(STOP_AFTER_MS - 600);
    expect(seen).toEqual([]);
    clock.advance(700);
    expect(seen).toEqual([true]);
    expect(stall.stalled).toBe(true);
    stall.progress();
    stall.set(0);
    expect(seen).toEqual([true, false]);
    expect(stall.stalled).toBe(false);
    // 没有在等的：不再计时
    expect(clock.active).toBe(0);
    clock.advance(60000);
    expect(seen).toEqual([true, false]);
  });

  it('连着画十秒、每一笔都按时算完：不出现', () => {
    const { clock, seen, stall } = setup();
    let waiting = 0;
    for (let k = 0; k < 50; k++) {
      // 每 200 毫秒发一笔，一笔算 300 毫秒：总有一两笔在等
      stall.set(++waiting);
      clock.advance(200);
      if (k > 0) {
        stall.progress();
        stall.set(--waiting);
      }
    }
    expect(clock.now()).toBe(10000);
    expect(seen).toEqual([]);
  });

  it('排着几笔、第一笔卡住了：从最后一次回复起算', () => {
    const { clock, seen, stall } = setup();
    stall.set(1);
    clock.advance(3000);
    stall.progress();
    stall.set(2);
    stall.set(3);
    clock.advance(STOP_AFTER_MS - 600);
    expect(seen).toEqual([]);
    clock.advance(700);
    expect(seen).toEqual([true]);
  });

  it('后台的回复（预览、自动保存要的）也算它还活着', () => {
    const { clock, seen, stall } = setup();
    stall.set(1);
    for (let k = 0; k < 20; k++) {
      clock.advance(1000);
      stall.progress();
    }
    expect(seen).toEqual([]);
  });

  it('电脑睡过、页面在后台被节流：重新计时，不是一醒来就出现', () => {
    const { clock, seen, stall } = setup();
    stall.set(1);
    clock.advance(1000);
    clock.sleep(60000);
    expect(seen).toEqual([]);
    clock.advance(STOP_AFTER_MS - 600);
    expect(seen).toEqual([]);
    clock.advance(700);
    expect(seen).toEqual([true]);
  });

  it('停下以后（在等的都回了）再有请求：从头算', () => {
    const { clock, seen, stall } = setup();
    stall.set(1);
    clock.advance(6000);
    stall.set(0);
    stall.set(1);
    clock.advance(4000);
    expect(seen).toEqual([true, false]);
    clock.advance(1500);
    expect(seen).toEqual([true, false, true]);
  });

  it('第九十七轮：“走到哪一步了”的消息也算它还活着——一步一步往下说着的不算卡住；一步里停了 5 秒才算', () => {
    const { clock, seen, stall } = setup();
    stall.set(1);
    for (let k = 0; k < 10; k++) {
      clock.advance(2000);
      stall.progress();
    }
    expect(seen).toEqual([]);
    clock.advance(STOP_AFTER_MS + 100);
    expect(seen).toEqual([true]);
  });

  it('要等多久可以是一个函数（测试里改短）：很短时看得勤一些', () => {
    const clock = new FakeClock();
    const seen: boolean[] = [];
    let ms = 40;
    const stall = new Stall(clock, (on) => seen.push(on), () => ms);
    stall.set(1);
    clock.advance(30);
    expect(seen).toEqual([]);
    clock.advance(30);
    expect(seen).toEqual([true]);
    stall.set(0);
    ms = STOP_AFTER_MS;
    stall.set(1);
    clock.advance(STOP_AFTER_MS - 600);
    expect(seen).toEqual([true, false]);
    clock.advance(700);
    expect(seen).toEqual([true, false, true]);
  });
});
