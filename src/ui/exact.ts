import type { Command } from '../../core/commands';
import { type WorldPreview, cancelWorldPreview, exactDelay, previewWorld, redrawTick, slowPreview, world } from '../state';

// 确切预览：手停下来一会儿后，在世界的副本上执行松手时会执行的同一条命令，地图上画出将来的样子
// （生态颜色、雪、河、地名、风、没涂成的格）。松手执行时 Worker 直接采用算好的结果：立刻出结果，颜色不跳。
// 新的结果到来之前一直显示上一个（画的过程中不会跳回原样）；世界换了（结果换上了）就不再显示。
// 同一时间只算一个（state.ts 里排队的只留最新的）；上次这类命令算得太久（成本闸门）就不自动算，
// 只说“松手后约 N 秒出结果”

export interface ExactView extends WorldPreview {
  key: string;
}

export class Exact {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // 最近要的 key（停顿后会算它）
  private wanted = '';
  // 发出去了还没回来的 key
  private running = '';
  private shown: ExactView | null = null;
  // 清掉一次加一：清掉之前发出去的预览回来了也不要
  private gen = 0;
  // 太慢不自动预览：松手后大约几秒出结果
  slow: number | null = null;

  // 要 key 的确切预览：停顿 pause 毫秒（上次预览算得久时等得更久）后算 build() 给的命令。key 没变时不重新计时
  want(key: string, build: () => Command | null, pause = 250) {
    if (key === this.wanted) return;
    this.wanted = key;
    this.stopTimer();
    // 已经算好了（比如松开滑块又拖回同一处）
    if (this.view?.key === key) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const cmd = this.wanted === key ? build() : null;
      if (!cmd) return;
      this.slow = slowPreview(cmd);
      if (this.slow !== null) {
        redrawTick.value++;
        return;
      }
      this.running = key;
      const gen = this.gen;
      void previewWorld(cmd).then((r) => {
        if (gen !== this.gen) return;
        if (this.running === key) this.running = '';
        if (r) this.shown = { ...r, key };
        redrawTick.value++;
      });
    }, exactDelay(pause));
  }

  // 当前世界上能显示的确切预览（可能是前一个 key 的）；世界换了就没有
  get view(): ExactView | null {
    const v = this.shown;
    return v && v.base === world.value ? v : null;
  }

  // 正在算，或者停顿后马上要算（提示里加“…”）
  get computing(): boolean {
    return !!this.timer || !!this.running;
  }

  // 不再要新的（松手了、松开了滑块）：已经显示的留着，直到世界换掉；自己要的还没发出去的作废
  stop() {
    this.stopTimer();
    this.wanted = '';
    if (this.running) cancelWorldPreview();
  }

  // 全部清掉（新的一笔、取消、换工具）
  clear() {
    this.stop();
    this.gen++;
    this.shown = null;
    this.slow = null;
    this.running = '';
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
