import type { Clock } from './sandbox';

// 计算程序多久没应答就给“停止”（第九十六轮）：纯规则，时钟可换（见 stall.test.ts）。
// 脚本卡住由 sandbox.ts 的看门狗管（它知道脚本在不在跑、会自己停）；这里管别的：有带提示的请求在等（执行、撤销、新建、打开……），
// 而计算程序已经连着 STOP_AFTER_MS 没有回过任何一条——顶上的“正在计算…”旁出现“停止”。不自动停：算得久不等于卡住，由用户决定。
//
// 为什么是 5 秒：平常的一步是几十到几百毫秒，量到的最慢的几步在半秒上下（第九十五轮 tools/bench-median 的数：一块地区描河
// 560–640 毫秒、整个星球的 hotRelief 340–450 毫秒），5 秒是它的八倍以上——编辑时碰不到。5 秒以上的只有新建、打开很大的世界
// 和真的卡住了：前一种多一个“停止”正好能取消，后一种这是唯一的出路。再短，慢机器上的一步会让按钮一闪；
// 再长，卡住的人要盯着转圈等更久才知道能做什么。
// 按“多久没有回过一条”算，不按“忙了多久”：连着画十秒、每一笔都按时算完的，不出现“停止”
export const STOP_AFTER_MS = 5000;
// 多久看一次；看的这一下本身晚了这么多算睡眠、后台节流（重新计时，和看门狗一样）
const INTERVAL = 500;
const LATE = 2000;

export class Stall {
  private waiting = 0;
  private since = 0;
  private checked = 0;
  private cancel: (() => void) | null = null;
  private shown = false;

  constructor(
    private readonly clock: Clock,
    private readonly on: (stalled: boolean) => void,
    private readonly ms = STOP_AFTER_MS,
  ) {}

  get stalled(): boolean {
    return this.shown;
  }

  // 还没回来的带提示的请求有几个（发出去时、回来时各说一次）
  set(waiting: number) {
    const was = this.waiting;
    this.waiting = Math.max(0, waiting);
    if (this.waiting === 0) {
      this.cancel?.();
      this.cancel = null;
      this.show(false);
      return;
    }
    if (was === 0) {
      this.since = this.checked = this.clock.now();
      this.cancel = this.clock.every(INTERVAL, () => this.check());
    }
  }

  // 计算程序回了一条（哪一条都算：它还活着、在往下算）
  progress() {
    this.since = this.clock.now();
    this.show(false);
  }

  private check() {
    if (this.waiting === 0) return;
    const now = this.clock.now();
    const late = now - this.checked - INTERVAL;
    this.checked = now;
    // 电脑睡过、页面在后台被节流：计算程序的回复也没来得及处理，重新计时
    if (late > LATE) {
      this.since = now;
      return;
    }
    if (now - this.since >= this.ms) this.show(true);
  }

  private show(on: boolean) {
    if (this.shown === on) return;
    this.shown = on;
    this.on(on);
  }
}
