import { type SwInfo, type ToSw, canRegister, pageIsFrom, readInfo } from './sw-core';

// 离线（第一百零一轮）：页面这一头——登记 service worker、看有没有新版本、什么时候启用它。
// 规则（设计见 docs/dev/history/第101轮.md）：
//   - 只在打包好的程序、http(s) 下登记；登记不了（浏览器不支持、被拦了）什么都不说，程序照常用；
//   - 新版本在后台装好以后等着，不顶掉正在用的这一版。这个页面本来就是新的一版（联网时刷新拿到的）→ 马上启用，不用说；
//     这个页面是旧的 → 告诉界面（“有新版本，重新载入后用上”），用户点了才启用、重新载入；
//   - 开发服务器上：这个地址以前登记过的（同一个地址开过打包好的程序）取消登记，开发时的行为和以前一样。
// 浏览器的那几样都从外面给（OfflineDeps），测试里换成假的

// 等新的一版启用最多多久（毫秒）：到点还没有就照样重新载入
export const APPLY_WAIT_MS = 4000;
// 问 service worker 是哪一版最多等多久
export const ASK_WAIT_MS = 3000;
// 可以离线了以后过多久开始在后台补字体（让第一次打开、生成世界先做完）
export const FILL_AFTER_MS = 20000;

export interface SwLike {
  state: string;
  postMessage(msg: ToSw, transfer?: Transferable[]): void;
  addEventListener(type: 'statechange', f: () => void): void;
}
export interface RegLike {
  scope: string;
  installing: SwLike | null;
  waiting: SwLike | null;
  active: SwLike | null;
  addEventListener(type: 'updatefound', f: () => void): void;
  unregister(): Promise<boolean>;
}
export interface ContainerLike {
  controller: SwLike | null;
  register(url: string): Promise<RegLike>;
  getRegistration(): Promise<RegLike | undefined>;
  addEventListener(type: 'controllerchange', f: () => void): void;
}

export interface OfflineDeps {
  prod: boolean;
  // location.protocol
  protocol: string;
  // navigator.serviceWorker；浏览器没有时 null
  container: ContainerLike | null;
  // sw.js 的地址（相对这个页面）
  url: string;
  // 页面上程序的脚本的完整地址（index.html 里写着的那几个）
  scripts(): string[];
  // 问一个 service worker 它是哪一版；等不到、它不认得这句话时 null
  ask(sw: SwLike): Promise<SwInfo | null>;
  // 可以离线用了（壳存好了）
  onReady(): void;
  // 有新版本等着，这个页面要重新载入才用上
  onUpdate(): void;
  setTimer(f: () => void, ms: number): unknown;
}

export class OfflineWatch {
  private reg: RegLike | null = null;
  // 装好了、等着启用的那一版
  private waiting: SwLike | null = null;
  private ready = false;
  private told = false;

  constructor(private readonly deps: OfflineDeps) {}

  // 登记；不该登记的地方（开发服务器、file://……）不登记。从不抛错
  async start(): Promise<void> {
    const d = this.deps;
    try {
      if (!canRegister({ prod: d.prod, protocol: d.protocol, hasSw: !!d.container })) {
        // 开发服务器：这个地址上以前登记过的取消掉
        if (!d.prod && d.container) await (await d.container.getRegistration())?.unregister();
        return;
      }
      const reg = await d.container!.register(d.url);
      this.reg = reg;
      reg.addEventListener('updatefound', () => this.track(reg.installing));
      if (reg.active) this.nowReady();
      if (reg.waiting) void this.found(reg.waiting);
      this.track(reg.installing);
    } catch {
      // 登记不了：没有离线，别的照常
    }
  }

  // 用户点了“重新载入”：让等着的那一版启用，再重新载入（之后联网、断网打开的都是新的一版）
  apply(reload: () => void): void {
    const w = this.waiting;
    const c = this.deps.container;
    // 没有等着的（别的页面已经让它启用了）：直接重新载入
    if (!w || !c || w.state !== 'installed') {
      reload();
      return;
    }
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      reload();
    };
    c.addEventListener('controllerchange', go);
    this.deps.setTimer(go, APPLY_WAIT_MS);
    w.postMessage({ type: 'skip-waiting' });
  }

  private track(sw: SwLike | null): void {
    if (!sw) return;
    const look = () => {
      if (sw.state === 'installed') void this.found(sw);
      if (sw.state === 'activated') this.nowReady();
    };
    sw.addEventListener('statechange', look);
    look();
  }

  // 一版装好了
  private async found(sw: SwLike): Promise<void> {
    const reg = this.reg;
    // 第一次装（之前没有别的版本）：它自己就启用，没有“新版本”可说
    if (!reg || !reg.active || reg.active === sw) return;
    let info: SwInfo | null = null;
    try {
      info = await this.deps.ask(sw);
    } catch {
      info = null;
    }
    if (sw.state !== 'installed') return;
    if (info && pageIsFrom(this.deps.scripts(), reg.scope, info.shell)) {
      // 这个页面已经是新的一版：启用它不会换掉这个页面上的任何东西
      sw.postMessage({ type: 'skip-waiting' });
      return;
    }
    this.waiting = sw;
    if (this.told) return;
    this.told = true;
    this.deps.onUpdate();
  }

  private nowReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.deps.onReady();
    // 过一阵在后台把字体补齐（每次打开页面说一次：上次没补完的接着补）
    this.deps.setTimer(() => {
      try {
        (this.deps.container?.controller ?? this.reg?.active)?.postMessage({ type: 'fill' });
      } catch {
        // 它不在了：下次再补
      }
    }, FILL_AFTER_MS);
  }
}

// 真的浏览器里的那几样
export function browserDeps(prod: boolean, onReady: () => void, onUpdate: () => void): OfflineDeps {
  const container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? (navigator.serviceWorker as unknown as ContainerLike) : null;
  return {
    prod,
    protocol: typeof location !== 'undefined' ? location.protocol : '',
    container,
    url: './sw.js',
    scripts: () => Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'), (s) => s.src),
    ask: (sw) =>
      new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), ASK_WAIT_MS);
        ch.port1.onmessage = (ev) => {
          clearTimeout(timer);
          resolve(readInfo(ev.data));
        };
        sw.postMessage({ type: 'info' }, [ch.port2]);
      }),
    onReady,
    onUpdate,
    setTimer: (f, ms) => setTimeout(f, ms),
  };
}
