import type { Command } from '../../core/commands';
import type { World } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import { type WorldPreview, cancelWorldPreview, exactDelay, previewWorld, redrawTick, slowHint, slowPreview, world } from '../state';

// 确切预览：手停下来一会儿后，在世界的副本上执行松手时会执行的同一条命令，地图上画出将来的样子
// （生态颜色、雪、河、地名、风、没涂成的格）。松手执行时 Worker 直接采用算好的结果：立刻出结果，颜色不跳。
// 新的结果到来之前一直显示上一个（画的过程中不会跳回原样）；世界换了（结果换上了）就不再显示。
// 同一时间只算一个（state.ts 里排队的只留最新的；接着画、新的一笔时正在算的在 Worker 里中途停下）；
// 上次这类命令算得太久（成本闸门）就不自动算，只说“松手后约 N 秒出结果”。
// 只要一份轻的预览（河的变化、地形、省份）的用下面的 Settle：同样是停一下再算、新的顶掉旧的

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

// 鼠标旁那句话的尾巴：太慢不自动预览时“，松手后约 N 秒出结果”，不慢时 fallback（还在算时“…”）
export const slowTail = (slow: number | null, fallback = '') => (slow !== null ? `，${slowHint(slow)}` : fallback);

// 图层里只留一部分格（确切预览之后新涂的格）
function onlyCells(l: HighlightLayer, keep: (c: number) => boolean): HighlightLayer {
  const cells: number[] = [];
  const values: number[] = [];
  l.cells.forEach((c, k) => {
    if (!keep(c)) return;
    cells.push(c);
    if (l.values) values.push(l.values[k]);
  });
  return { ...l, cells, values: l.values ? values : undefined };
}

// 每个确切预览算的时候已经涂到了哪些格（画笔、拖动扩张）：确切预览到了以后，变了的格描边（将来的颜色由地图画出来），
// 之后新涂的格另外淡淡地涂上估计的颜色
export class Covered {
  private map = new Map<string, Set<number>>();
  note(key: string, cells: Iterable<number>) {
    this.map.set(key, new Set(cells));
  }
  // 只留这些 key 的（排队中的笔画用得到的）
  keep(keys: Set<string | undefined>) {
    for (const k of [...this.map.keys()]) if (!keys.has(k)) this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  layers(v: ExactView, est: HighlightLayer[]): HighlightLayer[] {
    const cov = this.map.get(v.key);
    const added = (cov ? est.map((l) => onlyCells(l, (i) => !cov.has(i))) : est).filter((l) => l.cells.length);
    return [{ cells: v.result.changedCells, color: [255, 255, 255], pattern: 'outline' }, ...added];
  }
}

// 停一下再算一份轻的预览（底部条上改河、删河时河的变化，重画这一片的地形，重划的省份）：要 key 的预览，停 delay 毫秒后
// 算 run()（delay 为 0：现在就算，同一个还在等计时器时也提前）。同一个世界上同一个 key 只算一次；
// retry：没算成（排队时被新的预览顶掉了）时下次再要就重新算。新的 key 顶掉旧的：旧的回来了也不要
export class Settle<T> {
  private key = '';
  private at: World | null = null;
  private sent = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private got: { key: string; at: World | null; value: T } | null = null;
  constructor(private readonly retry = false) {}

  want(key: string, run: () => Promise<T | null>, delay: number) {
    const at = world.value;
    if (key === this.key && at === this.at && (this.sent || (this.timer && delay > 0))) return;
    this.key = key;
    this.at = at;
    this.sent = false;
    this.hold();
    if (delay <= 0) void this.run(key, at, run);
    else this.timer = setTimeout(() => void this.run(key, at, run), delay);
  }

  // 现在就算这一份，等它回来（点得快时先等预览再决定）
  now(key: string, run: () => Promise<T | null>): Promise<T | null> {
    this.key = key;
    this.at = world.value;
    this.hold();
    return this.run(key, this.at, run);
  }

  private async run(key: string, at: World | null, run: () => Promise<T | null>): Promise<T | null> {
    this.timer = null;
    this.sent = true;
    const value = await run();
    if (this.key !== key || this.at !== at) return value;
    if (value === null) {
      if (this.retry) this.sent = false;
      return value;
    }
    this.got = { key, at, value };
    redrawTick.value++;
    return value;
  }

  // 当前世界上 key 的结果（还没算好、世界换了时为 null）
  get(key: string): T | null {
    return this.got?.key === key && this.got.at === world.value ? this.got.value : null;
  }

  // 松手执行了：还在等计时器的不必再算（执行时自己会算；已经发出去的照样算完）
  hold() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // 不再要（鼠标移开了）：算好的留着，回来时再要一次
  stop() {
    this.hold();
    this.key = '';
  }

  reset() {
    this.stop();
    this.at = null;
    this.sent = false;
    this.got = null;
  }
}
