// 测速（第三十九轮）：网址带 ?perf 时每帧记下 GPU 各遍（地形层、合成、描格那一遍……）与主线程几步（着色、叠加层……）的毫秒数，
// 挂在 window.__perf 上（最近 PERF_FRAMES 帧的环形缓冲，summary() 给中位数等）。不带 ?perf 时什么都不建，代码里只多一次判空。
// GPU 的时间用 EXT_disjoint_timer_query_webgl2（浏览器不给时只有主线程的；结果晚几帧才拿得到，拿到时补进那一帧的记录）

export const PERF_FRAMES = 300;

export interface PerfFrame {
  // 这一帧开始的时刻（performance.now）
  t: number;
  // 主线程：每一步的毫秒（同一步一帧里几次时加起来）
  cpu: Record<string, number>;
  // GPU：每一遍的毫秒（晚几帧补上；GPU 被打断过的那一次不记）
  gpu: Record<string, number>;
  // 这一帧做了什么（比如合成是整张、只重画描格那一块，还是没画）
  notes: string[];
}

export interface PerfStat {
  count: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export class Perf {
  readonly frames: PerfFrame[] = [];
  private cur: PerfFrame | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private open: { q: WebGLQuery; label: string; frame: PerfFrame } | null = null;
  private pending: { q: WebGLQuery; label: string; frame: PerfFrame }[] = [];

  // 渲染器把它的 GL 上下文交过来（没有计时扩展时只记主线程）
  attach(gl: WebGL2RenderingContext) {
    if (this.gl === gl) return;
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  get gpuTimers(): boolean {
    return !!this.ext;
  }

  // 新的一帧（MapView 的 draw 开头）；先收一下前几帧的 GPU 结果
  frame(): PerfFrame {
    this.poll();
    const f: PerfFrame = { t: performance.now(), cpu: {}, gpu: {}, notes: [] };
    this.frames.push(f);
    if (this.frames.length > PERF_FRAMES) this.frames.shift();
    this.cur = f;
    return f;
  }

  cpu(label: string, ms: number) {
    const f = this.cur ?? this.frame();
    f.cpu[label] = (f.cpu[label] ?? 0) + ms;
  }

  note(s: string) {
    (this.cur ?? this.frame()).notes.push(s);
  }

  // GPU 的一遍：begin 与 end 之间的绘制。同一时刻只能有一个在计时，嵌套的里面那一个不记
  gpuBegin(label: string) {
    const gl = this.gl;
    if (!gl || !this.ext || this.open) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { q, label, frame: this.cur ?? this.frame() };
  }
  gpuEnd(label: string) {
    const gl = this.gl;
    if (!gl || !this.ext || !this.open || this.open.label !== label) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }

  // 收已经有结果的计时（GPU 被打断过时整批不要）
  poll() {
    const gl = this.gl;
    if (!gl || !this.ext || !this.pending.length) return;
    const disjoint = !!gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    const left: typeof this.pending = [];
    for (const p of this.pending) {
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
        left.push(p);
        continue;
      }
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
      if (!disjoint) p.frame.gpu[p.label] = (p.frame.gpu[p.label] ?? 0) + ns / 1e6;
      gl.deleteQuery(p.q);
    }
    this.pending = left;
  }

  clear() {
    this.frames.length = 0;
  }

  // 最近 last 帧（省略时全部）里每一步的中位数、95 分位、最大、平均（只算记了这一步的帧）
  summary(last = PERF_FRAMES): { frames: number; gpuTimers: boolean; cpu: Record<string, PerfStat>; gpu: Record<string, PerfStat>; notes: Record<string, number> } {
    this.poll();
    const list = this.frames.slice(-last);
    const stats = (pick: (f: PerfFrame) => Record<string, number>) => {
      const all = new Map<string, number[]>();
      for (const f of list) for (const [k, v] of Object.entries(pick(f))) (all.get(k) ?? all.set(k, []).get(k)!).push(v);
      const out: Record<string, PerfStat> = {};
      for (const [k, v] of all) {
        v.sort((a, b) => a - b);
        const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
        out[k] = { count: v.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(v[v.length - 1]), mean: round(v.reduce((a, b) => a + b, 0) / v.length) };
      }
      return out;
    };
    const notes: Record<string, number> = {};
    for (const f of list) for (const n of f.notes) notes[n] = (notes[n] ?? 0) + 1;
    return { frames: list.length, gpuTimers: this.gpuTimers, cpu: stats((f) => f.cpu), gpu: stats((f) => f.gpu), notes };
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// 网址带 ?perf（或 &perf）时开
export function perfEnabled(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');
}
