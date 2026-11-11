// WebGL 的上下文丢了怎么办（第九十六轮）：纯规则，计时可换（见 gl-recover.test.ts）；接在 ui/MapView.tsx 上。
// 显卡驱动重置、电脑睡过、页面放久了，浏览器会收走画布的 WebGL 上下文（webglcontextlost）：GPU 上的纹理、程序、缓冲全没了，
// 地图是黑的。在那个事件里 preventDefault，浏览器之后会还一个新的（webglcontextrestored），这时把渲染器的 GPU 资源全部重建、
// 把该传的重新传一遍、重画——和丢之前逐像素相同（冒烟里用 WEBGL_lose_context 丢一次、恢复、截图比）。
// 叠加层是另一块 2D 画布，不受影响。
//
// 四种状态（界面盖在地图上的一层照它写，文字在 crash-text.ts 的 GL_TEXT）：
//   ok 正常；lost 丢了、等着恢复（“画面暂时不可用，正在恢复…”）；
//   stuck 等了 GL_RESTORE_MS 还没恢复（请重新载入；之后浏览器还了上下文照样恢复，回到 ok）；
//   broken 重建时出错，或者连着几帧画不出来（请重新载入）
export type GlState = 'ok' | 'lost' | 'stuck' | 'broken';

// 等多久算恢复不了。Chrome 里显卡进程重启后一两秒内就还上下文；8 秒还没有，多半是这一次不会有了
// （显卡被停用、上下文丢得太频繁被浏览器拒绝）。说早了没有坏处：之后恢复了那一层自己消失
export const GL_RESTORE_MS = 8000;

export interface GlRecoverIo {
  // 把渲染器的 GPU 资源全部重建、重传、重画。出错就抛
  rebuild(): void;
  // 上下文现在是不是（又）丢着（刚说恢复又丢了：接着等，不去重建）
  isLost?(): boolean;
  // 状态变了；reason：broken 的原话
  changed(state: GlState, reason?: string): void;
  setTimer(f: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

export class GlRecovery {
  state: GlState = 'ok';
  private timer: unknown = null;

  constructor(
    private readonly io: GlRecoverIo,
    private readonly ms = GL_RESTORE_MS,
  ) {}

  // 现在能不能画（丢了的上下文上画什么都是空的；坏了的不再试）
  get drawable(): boolean {
    return this.state === 'ok';
  }

  // webglcontextlost
  lost() {
    if (this.state === 'lost' || this.state === 'stuck') return;
    this.set('lost');
    this.stopTimer();
    this.timer = this.io.setTimer(() => {
      this.timer = null;
      if (this.state === 'lost') this.set('stuck');
    }, this.ms);
  }

  // webglcontextrestored：重建。重建出错（又丢了、显卡不行了）算坏了
  restored() {
    if (this.io.isLost?.()) {
      // 又丢了：当作刚丢，接着等下一次恢复
      this.state = 'ok';
      this.lost();
      return;
    }
    this.stopTimer();
    try {
      this.io.rebuild();
    } catch (e) {
      this.set('broken', e instanceof Error ? e.message : String(e));
      return;
    }
    this.set('ok');
  }

  // 连着几帧画不出来（mishap.ts 的 DrawHealth）
  broke(reason: string) {
    this.stopTimer();
    this.set('broken', reason);
  }

  dispose() {
    this.stopTimer();
  }

  private stopTimer() {
    if (this.timer !== null) this.io.clearTimer(this.timer);
    this.timer = null;
  }

  private set(state: GlState, reason?: string) {
    if (this.state === state) return;
    this.state = state;
    this.io.changed(state, reason);
  }
}
