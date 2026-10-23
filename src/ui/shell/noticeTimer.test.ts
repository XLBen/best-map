import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATE_CLICK_MS, LateClickGuard, NOTE_ACTION_MS, NOTE_MS, PausableTimer, installLateClickGuard } from './noticeTimer';

// 第十二轮修：带“撤销”的提示条留得更久、鼠标停着不消失；刚消失时落在原处的一下不落到地图上

afterEach(() => vi.useRealTimers());

describe('提示条的计时', () => {
  it('带按钮的提示留 20 秒，别的 9 秒', () => {
    expect(NOTE_ACTION_MS).toBe(20000);
    expect(NOTE_MS).toBe(9000);
  });

  it('到时消失；鼠标停着时暂停，移开后接着算剩下的；重新开始时重新计时', () => {
    vi.useFakeTimers();
    let t = 0;
    const fire = vi.fn();
    const timer = new PausableTimer(fire, () => t);
    const advance = (ms: number) => {
      t += ms;
      vi.advanceTimersByTime(ms);
    };
    timer.start(NOTE_ACTION_MS);
    advance(15000);
    timer.pause();
    // 停多久都不消失
    advance(60000);
    expect(fire).not.toHaveBeenCalled();
    timer.resume();
    advance(4999);
    expect(fire).not.toHaveBeenCalled();
    advance(1);
    expect(fire).toHaveBeenCalledTimes(1);
    // 剩得很少时移开：至少再留 1.5 秒
    timer.start(3000);
    advance(2900);
    timer.pause();
    timer.resume();
    advance(1499);
    expect(fire).toHaveBeenCalledTimes(1);
    advance(1);
    expect(fire).toHaveBeenCalledTimes(2);
    // 停着的时候来了新的一句：等移开才开始算
    timer.pause();
    timer.start(NOTE_MS);
    advance(30000);
    expect(fire).toHaveBeenCalledTimes(2);
    timer.resume();
    advance(NOTE_MS);
    expect(fire).toHaveBeenCalledTimes(3);
    // 关上（stop）后不再触发
    timer.start(NOTE_MS);
    timer.stop();
    advance(NOTE_MS * 2);
    expect(fire).toHaveBeenCalledTimes(3);
  });
});

describe('刚消失时落在原处的一下', () => {
  const rect = { left: 100, top: 10, right: 400, bottom: 50 };

  it('消失后 300 毫秒内、按在原来的位置上才吞掉', () => {
    let t = 1000;
    const g = new LateClickGuard(() => t);
    g.shown(rect);
    // 还在显示：不吞（点的就是提示条上的按钮）
    expect(g.swallow(200, 30)).toBe(false);
    g.gone();
    t += 100;
    expect(g.swallow(200, 30)).toBe(true);
    expect(g.swallow(402, 30)).toBe(true);
    // 别处照常
    expect(g.swallow(200, 300)).toBe(false);
    t += LATE_CLICK_MS;
    expect(g.swallow(200, 30)).toBe(false);
    // 又出现了一句：重新算
    g.shown(rect);
    t += 50;
    expect(g.swallow(200, 30)).toBe(false);
  });

  it('装在窗口上：吞掉按下（捕获阶段，地图收不到），同一指针的抬起与随后的点击也吞掉', () => {
    let t = 0;
    const g = new LateClickGuard(() => t);
    const target = new EventTarget();
    installLateClickGuard(target as unknown as Window, g);
    const got: string[] = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) target.addEventListener(type, () => got.push(type));
    const send = (type: string, x: number, y: number) => {
      const e = new Event(type, { cancelable: true });
      Object.assign(e, { clientX: x, clientY: y, pointerId: 1 });
      target.dispatchEvent(e);
      return e;
    };
    g.shown(rect);
    g.gone();
    t = 100;
    const down = send('pointerdown', 200, 30);
    expect(down.defaultPrevented).toBe(true);
    send('pointerup', 200, 30);
    send('click', 200, 30);
    expect(got).toEqual([]);
    // 之后的点击照常
    t = 1000;
    send('pointerdown', 200, 30);
    send('pointerup', 200, 30);
    send('click', 200, 30);
    expect(got).toEqual(['pointerdown', 'pointerup', 'click']);
  });
});
