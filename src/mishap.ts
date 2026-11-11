// 没接住的错怎么分（第九十六轮）：纯规则，不碰页面。接线在 crash-host.ts（window 的 error / unhandledrejection）、
// ui/shell/Guard.tsx（Preact 的错误边界），界面是 rescue.ts（整页的自救页）和 ui/shell/MishapBanner.tsx（顶上的一条）。
//
// 三种：
//   ignore —— 不是这个程序的错，或者无害：浏览器扩展、别的网站的脚本（只有一句“Script error.”）、ResizeObserver 的那句警告、
//             用户自己取消（AbortError）、计算程序自查隔离时的探针（isolation-probe.ts 的 data:text/plain,x）；
//   minor —— 某个面板、某次点击、某个没接住的 Promise：界面还在，顶上说一句“刚才那一步可能没做成”，不打断；
//   fatal —— 整个界面画不出来：错误边界接到的（根上的那一个）、界面还没画出来过就出的错、程序的文件没读到。整页的自救页

export type MishapSource =
  // window 的 error 事件（脚本里没接住的异常）
  | 'error'
  // window 的 unhandledrejection
  | 'rejection'
  // 根上的错误边界：整个界面画不出来
  | 'boundary'
  // 某一块的错误边界（面板、弹窗）：那一块已经关闭，别的照常
  | 'part'
  // 程序自己的文件（脚本、样式）没读到
  | 'resource';

export interface MishapInput {
  source: MishapSource;
  // 原话
  message: string;
  // 错误的名字（TypeError、AbortError……）
  name?: string;
  // 出错的文件（error 事件给的）
  filename?: string;
  stack?: string;
  // error 事件带没带错误对象（别的网站的脚本出的错不带）
  hasError?: boolean;
  // 界面画出来过没有
  rendered: boolean;
}

export type Severity = 'ignore' | 'minor' | 'fatal';

// 浏览器扩展的地址
const EXTENSION = /\b(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension|webkit-masked-url):\/\//;
const URLS = /\b(?:https?|file|chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension|webkit-masked-url):\/\/[^\s)'"]+/g;

// 一个地址是不是这个页面自己的（同源；blob:、data: 是自己开的 Worker、自己做的地址）
function ours(url: string, origin: string): boolean {
  if (!url) return true;
  if (EXTENSION.test(url)) return false;
  if (url.startsWith('blob:') || url.startsWith('data:')) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return true;
  // 页面是从文件直接打开的（来源是 null）：分不出同源不同源，不是扩展的都算自己的
  if (!origin || origin === 'null') return true;
  return url.startsWith(`${origin}/`) || url === origin;
}

// 调用栈里的地址全是别人的（至少有一个，而且没有一个是自己的）
function foreignStack(stack: string | undefined, origin: string): boolean {
  const urls = stack?.match(URLS);
  if (!urls?.length) return false;
  return urls.every((u) => !ours(u, origin));
}

// origin：这个页面的来源（location.origin）
export function classify(i: MishapInput, origin: string): Severity {
  // 错误边界接到的不用再看是谁的：界面的那一块已经没了
  if (i.source === 'boundary') return 'fatal';
  if (i.source === 'part') return 'minor';
  if (i.source === 'resource') return i.rendered ? 'ignore' : 'fatal';
  const msg = i.message;
  // 别的网站的脚本：浏览器只给这一句，没有文件、没有错误对象
  if (/^Script error\.?$/i.test(msg.trim()) && !i.filename && !i.hasError) return 'ignore';
  // 无害的警告（一帧里没来得及把大小的变化都通知完）
  if (/ResizeObserver loop/i.test(msg)) return 'ignore';
  // 隔离探针（计算 Worker 里故意试一次被拦的请求）
  if (msg.includes('data:text/plain,x')) return 'ignore';
  // 用户自己取消的（选文件的窗口点了取消……）
  if (i.name === 'AbortError' || /^AbortError\b/.test(msg)) return 'ignore';
  // 浏览器扩展、别的来源的脚本
  if (i.filename && !ours(i.filename, origin)) return 'ignore';
  if (foreignStack(i.stack, origin)) return 'ignore';
  // 界面还没画出来过：页面是白的，没有“接着用”可言
  if (!i.rendered) return 'fatal';
  return 'minor';
}

// 同一个错的记号：名字、原话、调用栈里的第一处
export function signatureOf(i: Pick<MishapInput, 'message' | 'name' | 'stack'>): string {
  const at = i.stack
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at ') || /@.*:\d+/.test(l));
  return `${i.name ?? ''}|${i.message}|${at ?? ''}`;
}

// 同一个错不反复刷屏：正显示着的再来只加一（不重新弹）；关掉、自己消失以后 quietMs 之内再来不说；过了才再说一次
export const MISHAP_QUIET_MS = 60_000;
export class MishapLog {
  private showing: string | null = null;
  private readonly last = new Map<string, number>();
  // 每个错出了几次（“原因”里写）
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly quietMs = MISHAP_QUIET_MS,
  ) {}

  note(sig: string): 'show' | 'bump' | 'quiet' {
    this.counts.set(sig, (this.counts.get(sig) ?? 0) + 1);
    if (this.showing === sig) return 'bump';
    const at = this.last.get(sig);
    if (at !== undefined && this.now() - at < this.quietMs) return 'quiet';
    // 正显示着的另一个被它顶掉：那一个从这时起算安静的时间
    if (this.showing !== null) this.last.set(this.showing, this.now());
    this.showing = sig;
    this.last.set(sig, this.now());
    return 'show';
  }

  count(sig: string): number {
    return this.counts.get(sig) ?? 0;
  }

  // 那一条不显示了（关掉、自己消失、被别的顶掉）：从这时起算安静的时间
  gone() {
    if (this.showing !== null) this.last.set(this.showing, this.now());
    this.showing = null;
  }
}

// 地图的一帧画不出来：偶尔一帧出错（某个预览的毛病）不算，连着几帧都画不出来才算“地图坏了”（盖一层说明，不再重画）
export const DRAW_FAILS = 3;
export class DrawHealth {
  private fails = 0;
  broken = false;
  constructor(private readonly limit = DRAW_FAILS) {}
  // 这一帧画成了
  ok() {
    this.fails = 0;
  }
  // 这一帧出错了；返回是不是该判定“坏了”
  fail(): boolean {
    if (++this.fails >= this.limit) this.broken = true;
    return this.broken;
  }
  reset() {
    this.fails = 0;
    this.broken = false;
  }
}
