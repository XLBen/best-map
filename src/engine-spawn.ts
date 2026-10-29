import type { WorkerLike } from './sandbox';

// 开计算 Worker（隔离那一步）：先试 data: 地址的 module Worker —— 它的来源是不透明的（null），与页面不同源，
// 读不到这个浏览器里保存的世界；页面的 CSP（index.html）也管着它，不能联网。不行再退回普通的（同源的）Worker：
//   - 拿不到引擎的代码（取文件失败）、代码太大（data: 地址太长，浏览器不收）→ 直接用普通的；
//   - data: 的 Worker 报错（浏览器不支持）、5 秒内没有打招呼 → 停掉它，换普通的。
// 计算 Worker 自查完（isolation-probe.ts）先打招呼（hello），这里等到招呼才把请求发过去；
// 只有 data: 的 Worker 的第一条招呼算数（之后的、普通 Worker 的都不算：可能是脚本伪造的），退回普通 Worker 时就是“没隔离”。
// 这个页面里已经隔离运行过（信任的问话说过“隔离”）：之后开的不再悄悄退回普通的（脚本在那里能读存档、能联网），
// 多等一会儿，还不行就当作崩了，交给 EngineHost 处理（恢复、安全模式）。
// 对 EngineHost 来说它就是一个 Worker：发的请求先排着，换了 Worker 也照样送到

// data: 地址最长多少（字符）。Chrome 收的地址最长 2 MB（2,097,152 个字符），留些余地。
// 第二十九轮从 1,800,000 放宽到 1,900,000：压缩后的引擎已经到 1,816,132（第二十八轮是 1,789,928），余地还有约 19 万字符
export const DATA_URL_MAX = 1_900_000;
// 等 data: 的 Worker 打招呼最多多久（毫秒）
export const HELLO_MS = 5000;
// 这个页面里已经隔离运行过时多等一会儿（一时忙不过来，不是不支持）
export const HELLO_AGAIN_MS = 20000;

const PREFIX = 'data:text/javascript;base64,';

// 引擎的代码做成 data: 地址（UTF-8 再 base64）；太长时为 null
export function engineDataUrl(code: string): string | null {
  const bytes = new TextEncoder().encode(code);
  if (PREFIX.length + Math.ceil(bytes.length / 3) * 4 > DATA_URL_MAX) return null;
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return PREFIX + btoa(bin);
}

// 计算 Worker 的招呼：{kind:'hello', isolated}；isolated 只认 true（别的值都算没隔离）。不是招呼时为 null
export function readHello(data: unknown): { isolated: boolean } | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  if (m.kind !== 'hello') return null;
  return { isolated: m.isolated === true };
}

// 真的 Worker 用到的部分
export interface RawWorker {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface SpawnDeps {
  // 引擎的代码（一整个文件，不引用别的模块）；拿不到时为 null
  code(): Promise<string | null>;
  // 普通 Worker 的地址
  url: string;
  create(url: string, opts: WorkerOptions): RawWorker;
  // 这个 Worker 里的脚本是不是隔离运行的：收到 data: 的 Worker 的招呼时、退回普通 Worker 时各说一次
  isolated(on: boolean): void;
  // 计时（测试换成假的）
  setTimer?(f: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  // 同一个页面里开过的 Worker 共用的记忆：
  //   dataFailed：data: 的 Worker 报过错、超过时没打招呼，之后直接开普通的（不支持的浏览器里不必每次恢复、每开一个世界都白等 5 秒）；
  //   isolatedOnce：有过隔离的 Worker，之后不再退回普通的
  memory?: SpawnMemory;
}

export interface SpawnMemory {
  dataFailed?: boolean;
  isolatedOnce?: boolean;
}

// 同一段代码只做一次 data: 地址（每次恢复都要另开 Worker）
let urlCache: { code: string; url: string | null } | null = null;
function dataUrlFor(code: string): string | null {
  if (urlCache?.code !== code) urlCache = { code, url: engineDataUrl(code) };
  return urlCache.url;
}

export class EngineWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private w: RawWorker | null = null;
  // 可以把请求发过去了（data: 的 Worker 打过招呼，或者已经换成普通的）
  private ready = false;
  private dead = false;
  private timer: unknown = null;
  private readonly queue: [unknown, Transferable[] | undefined][] = [];
  // 现在用的是哪一种 Worker：还在试 data: 的、data: 的（打过招呼）、普通的
  mode: 'starting' | 'data' | 'plain' = 'starting';

  constructor(private readonly deps: SpawnDeps) {
    void this.start();
  }

  postMessage(msg: unknown, transfer?: Transferable[]): void {
    if (this.dead) return;
    if (this.ready && this.w) this.w.postMessage(msg, transfer);
    else this.queue.push([msg, transfer]);
  }

  terminate(): void {
    this.dead = true;
    this.stopTimer();
    this.queue.length = 0;
    this.drop();
  }

  private async start() {
    let url: string | null = null;
    try {
      const code = await this.deps.code();
      url = code === null ? null : dataUrlFor(code);
    } catch {
      url = null;
    }
    if (this.dead) return;
    const memory = this.deps.memory;
    // 不行过一次就直接开普通的；但隔离运行过的页面照样试 data: 的（两个 Worker 同时开、一个超时一个成功时也是这样）
    if (url === null || (memory?.dataFailed && !memory.isolatedOnce)) {
      this.fallback();
      return;
    }
    let w: RawWorker;
    try {
      w = this.deps.create(url, { type: 'module' });
    } catch {
      this.giveUp();
      return;
    }
    this.w = w;
    w.onmessage = (ev) => {
      const hello = readHello(ev.data);
      if (!this.ready) {
        // 招呼之前不该有别的消息
        if (!hello) return;
        this.stopTimer();
        this.ready = true;
        this.mode = 'data';
        // data: 的 Worker 开得起来：之后照样试它
        if (memory) {
          memory.dataFailed = false;
          if (hello.isolated) memory.isolatedOnce = true;
        }
        this.deps.isolated(hello.isolated);
        this.flush();
        return;
      }
      if (hello) return;
      this.onmessage?.(ev);
    };
    w.onerror = (ev) => {
      if (this.ready) this.onerror?.(ev);
      else this.giveUp();
    };
    this.timer = (this.deps.setTimer ?? ((f, ms) => setTimeout(f, ms)))(
      () => {
        this.timer = null;
        if (!this.ready) this.giveUp();
      },
      memory?.isolatedOnce ? HELLO_AGAIN_MS : HELLO_MS,
    );
  }

  // data: 的 Worker 不行：停掉，换普通的（这个页面里隔离运行过时不换，见 fallback）
  private giveUp() {
    if (this.dead || this.ready) return;
    const memory = this.deps.memory;
    if (memory && !memory.isolatedOnce) memory.dataFailed = true;
    this.stopTimer();
    this.drop();
    this.fallback();
  }

  // 隔离不了：换普通的；这个页面里已经隔离运行过，就不悄悄换成没隔离的，当作崩了（EngineHost 恢复，再不行用安全模式）
  private fallback() {
    if (!this.deps.memory?.isolatedOnce) {
      this.plain();
      return;
    }
    this.dead = true;
    this.queue.length = 0;
    queueMicrotask(() => this.onerror?.(new Error('计算程序没能启动')));
  }

  private plain() {
    if (this.dead) return;
    this.mode = 'plain';
    this.deps.isolated(false);
    let w: RawWorker;
    try {
      w = this.deps.create(this.deps.url, { type: 'module' });
    } catch (e) {
      // 普通的也开不了：当作崩了（EngineHost 会处理），稍后再说，不在开 Worker 的调用里套着处理
      this.dead = true;
      queueMicrotask(() => this.onerror?.(e));
      return;
    }
    this.w = w;
    w.onmessage = (ev) => {
      if (readHello(ev.data)) return;
      this.onmessage?.(ev);
    };
    w.onerror = (ev) => this.onerror?.(ev);
    this.ready = true;
    this.flush();
  }

  private flush() {
    for (const [msg, transfer] of this.queue.splice(0)) this.w!.postMessage(msg, transfer);
  }

  private stopTimer() {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private drop() {
    const w = this.w;
    this.w = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
  }
}
