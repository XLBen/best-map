import type { Clock } from './sandbox';

// 计算程序多久没动静算“卡住了”（第九十六轮）：纯规则，时钟可换（见 stall.test.ts）。
// 第九十七轮起它不再管按钮出不出现（久的一步 1 秒后就有进度条和“取消”，见 src/progress.ts），管的是“取消”用哪一种：
//   - 还有动静（回复、或者“走到哪一步了”的消息——那也是它活着、在往下算的证据）：请它在阶段之间自己停下，世界原样退回；
//   - 已经连着 STOP_AFTER_MS 没有任何消息（卡在一个阶段里，听不到“请停下”）：结束它，用命令记录恢复（第九十六轮的路）。
//     点了“取消”以后才沉默满这么久的，到时候也一样结束它。
// 下面是第九十六轮写的规则，没有变：
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
  private every = INTERVAL;

  // ms 可以是函数（测试里把它改短，不用真的等五秒）
  constructor(
    private readonly clock: Clock,
    private readonly on: (stalled: boolean) => void,
    private readonly ms: number | (() => number) = STOP_AFTER_MS,
  ) {}

  private get after(): number {
    return typeof this.ms === 'function' ? this.ms() : this.ms;
  }

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
      // 平常每半秒看一次；要等的时间很短时（测试）看得勤一些
      this.every = Math.min(INTERVAL, Math.max(10, this.after / 4));
      this.cancel = this.clock.every(this.every, () => this.check());
    }
  }

  // 计算程序回了一条（哪一条都算：它还活着、在往下算；第九十七轮：“走到哪一步了”的消息也算）
  progress() {
    this.since = this.clock.now();
    this.show(false);
  }

  private check() {
    if (this.waiting === 0) return;
    const now = this.clock.now();
    const late = now - this.checked - this.every;
    this.checked = now;
    // 电脑睡过、页面在后台被节流：计算程序的回复也没来得及处理，重新计时
    if (late > LATE) {
      this.since = now;
      return;
    }
    if (now - this.since >= this.after) this.show(true);
  }

  private show(on: boolean) {
    if (this.shown === on) return;
    this.shown = on;
    this.on(on);
  }
}
