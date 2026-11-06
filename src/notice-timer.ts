// 顶部提示条（改完后的一句话）多久消失、鼠标停在上面时不消失，以及刚消失时落在原处的一下点击（第十二轮修）。
// 带“撤销”等按钮的提示留 20 秒（9 秒常常来不及点）；鼠标停在提示条上时计时暂停，移开后接着算。
// 提示条刚消失（300 毫秒内）时按在它原来的位置上的一下，本来是想点“撤销”的：吞掉，不落到地图上去涂一笔

export const NOTE_MS = 9000;
export const NOTE_ACTION_MS = 20000;
export const LATE_CLICK_MS = 300;

// 能暂停的定时器：start 重新计时；pause 记下还剩多久；resume 接着算（剩下的不足 1.5 秒时给 1.5 秒，移开鼠标不会一下就消失）
export class PausableTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private left = 0;
  private since = 0;
  private held = false;
  constructor(
    private readonly fire: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(ms: number) {
    this.stop();
    this.left = ms;
    if (!this.held) this.run();
  }

  pause() {
    if (this.held) return;
    this.held = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.left = Math.max(0, this.left - (this.now() - this.since));
    }
  }

  resume() {
    if (!this.held) return;
    this.held = false;
    if (this.left > 0) {
      this.left = Math.max(this.left, 1500);
      this.run();
    }
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.left = 0;
  }

  private run() {
    this.since = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.left = 0;
      this.fire();
    }, this.left);
  }
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// 提示条刚消失时落在它原来位置上的按下：shown 记下提示条现在的位置，gone 记下消失的时刻；
// swallow(x, y) 为真时这一下要吞掉（按下、随后的抬起与点击都不往下传）
export class LateClickGuard {
  private rect: Rect | null = null;
  private goneAt = -Infinity;
  constructor(private readonly now: () => number = () => performance.now()) {}

  shown(rect: Rect | null) {
    this.rect = rect;
    this.goneAt = -Infinity;
  }

  gone() {
    if (this.rect) this.goneAt = this.now();
  }

  swallow(x: number, y: number): boolean {
    const r = this.rect;
    if (!r || this.now() - this.goneAt > LATE_CLICK_MS) return false;
    // 边上留几像素：手抖一点也算
    const m = 4;
    return x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m;
  }
}

export const lateClicks = new LateClickGuard();

// 在窗口上（捕获阶段）拦下要吞掉的按下，以及同一指针随后的抬起、点击。只装一次
let installed = false;
export function installLateClickGuard(on?: Window, guard: LateClickGuard = lateClicks) {
  if (!on) {
    if (installed) return;
    installed = true;
  }
  const target = on ?? window;
  let swallowing: number | null = null;
  // 吞掉的抬起之后紧跟着的那一下点击（没有点击时过一会儿就不再等）
  let clickUntil = -Infinity;
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  target.addEventListener(
    'pointerdown',
    (e) => {
      if (!guard.swallow(e.clientX, e.clientY)) return;
      swallowing = e.pointerId;
      stop(e);
    },
    true,
  );
  target.addEventListener(
    'pointerup',
    (e) => {
      if (swallowing === null || e.pointerId !== swallowing) return;
      swallowing = null;
      clickUntil = e.timeStamp + 500;
      stop(e);
    },
    true,
  );
  target.addEventListener(
    'click',
    (e) => {
      if (e.timeStamp > clickUntil) return;
      clickUntil = -Infinity;
      stop(e);
    },
    true,
  );
}
