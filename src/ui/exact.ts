import type { Command } from '../../core/commands';
import type { World } from '../../core/world';
import { type WorldPreview, cancelWorldPreview, exactDelay, previewWorld, redrawTick, slowPreview, world } from '../state';

// 确切预览：手停下来一会儿后，在世界的副本上执行松手时会执行的同一条命令，地图上画出将来的样子
// （生态颜色、雪、河、地名、风、没涂成的格）。松手执行时 Worker 直接采用算好的结果：立刻出结果，颜色不跳。
// 新的结果到来之前一直显示上一个（画的过程中不会跳回原样）；世界换了（结果换上了）就不再显示。
// 同一时间只算一个（state.ts 里排队的只留最新的；接着画、新的一笔时正在算的在 Worker 里中途停下）；
// 上次这类命令算得太久（成本闸门）就不自动算，只说“松手后约 N 秒出结果”

export interface ExactView extends WorldPreview {
  key: string;
}

export class Exact {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // 最近要的 key（停顿后会算它）
  private wanted = '';
  // 发出去了还没回来的 key
  private running = '';
  // 停顿到了、要预览时的当前世界：同一个 key 在同一个世界上只要一次（没算成也不再要；世界换了再要）
  private asked: World | null = null;
  private shown: ExactView | null = null;
  // 发出去还没回来的那一个（见 late）
  private flight: { key: string; done: Promise<ExactView | null> } | null = null;
  // 清掉一次加一：清掉之前发出去的预览回来了也不要
  private gen = 0;
  // 太慢不自动预览：松手后大约几秒出结果
  slow: number | null = null;

  // 要 key 的确切预览：停顿 pause 毫秒（上次预览算得久时等得更久）后算 build() 给的命令。key 没变时不重新计时。
  // key 不必带上世界：预览按 Worker 里最新的状态算（排在前面的编辑之后），回来时当前世界就是它的 base
  want(key: string, build: () => Command | null, pause = 250) {
    if (key === this.wanted && (this.timer || this.running === key || this.asked === world.value)) return;
    this.wanted = key;
    this.stopTimer();
    // 接着画了（要的不是正在算的那个）：正在算的停下（Worker 在下一个阶段之间停，星球上不必等它算完几秒）
    if (this.running && this.running !== key) {
      cancelWorldPreview(true);
      this.running = '';
    }
    // 已经算好了（比如松开滑块又拖回同一处；前面排队的笔画算完后才回来的预览也对得上）
    if (this.view?.key === key) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted !== key) return;
      this.asked = world.value;
      const cmd = build();
      if (!cmd) return;
      this.slow = slowPreview(cmd);
      if (this.slow !== null) {
        redrawTick.value++;
        return;
      }
      this.running = key;
      const gen = this.gen;
      const done = previewWorld(cmd).then((r): ExactView | null => (r ? { ...r, key } : null));
      this.flight = { key, done };
      void done.then((v) => {
        if (this.flight?.done === done) this.flight = null;
        if (gen !== this.gen) return;
        if (this.running === key) this.running = '';
        if (v) {
          this.shown = v;
          this.asked = v.base;
        }
        redrawTick.value++;
      });
    }, exactDelay(pause));
  }

  // key 的预览已经发出去、还没回来：回来时的结果（之后 clear 了也照样给）。画笔松手时用它把这一笔的确切预览
  // 交给排队中的那一笔：接着画下一笔、换了工具（ex 清掉了）也不丢，回来就画出将来的世界。没有在算的为 null
  late(key: string): Promise<ExactView | null> | null {
    return this.flight?.key === key ? this.flight.done : null;
  }

  // 当前世界上能显示的确切预览（可能是前一个 key 的）；世界换了就没有
  get view(): ExactView | null {
    const v = this.shown;
    if (!v || v.base === world.value) return v;
    // 过期的不会再对得上（世界只往前换）：放掉它和它的旧世界（星球上几十 MB），不留到下一笔
    this.shown = null;
    return null;
  }

  // 不再要新的（松手了、松开了滑块）：已经显示的留着，直到世界换掉；自己要的还没发出去的作废
  stop() {
    this.stopTimer();
    this.wanted = '';
    if (this.running) cancelWorldPreview();
  }

  // 全部清掉（新的一笔、取消、换工具）
  clear() {
    this.stopTimer();
    this.wanted = '';
    // 新的一笔、取消、换工具：正在算的也停下（已经发了同一条命令的执行时 Worker 不停，见 worker.ts）
    if (this.running) cancelWorldPreview(true);
    this.gen++;
    this.shown = null;
    this.slow = null;
    this.running = '';
    this.flight = null;
    this.asked = null;
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
