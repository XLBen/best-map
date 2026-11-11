// 哪个页面写自动保存（第九十四轮）。
// 同一个地址开着几个页面时只有一个写：拿到锁（navigator.locks 的 map2-autosave）的那一个。
// 拿不到的页面不写，界面上一直有一条“这个世界已在另一个页面打开，这个页面里的改动不会自动保存”；
// 点“在这里接着做”把锁抢过来（steal），并在 BroadcastChannel 上说一声，原来写的那一页变成不写的那一方。
// 写的那一页关了：等着的页面拿到锁，但只在存着的那一份就是它的世界的开头时才接着写（canPromote）——
// 不然会拿这一页的旧世界盖掉那一页后来做的；不能接时放开锁，等用户自己点。
// 第九十五轮：这时不再说“已在另一个页面打开”（那一页已经关了），而是另一种状态 stale——
// “另一个页面里保存了更新的世界，这个页面里的是旧的”，界面上主要的按钮是“重新载入”，次要的才是“在这里接着做”。
// 没有 navigator.locks 的环境（旧浏览器、测试）：lock 为 null，都当自己能写，靠头里的“谁写的”在事务里核对（autosave-io.ts）；
// 别的页面说它接过去了（频道上的 taken）时让出。
// 这里不碰界面、不碰存储：锁和频道经 LockIo，测试换成内存里的（memoryLocks）

export type RoleMessage = { type: 'taken'; by: string };

export interface LockIo {
  // 拿锁。try：没人占着才拿（拿不到 false）；wait：排队等（等到了 true，中途 release 了 false）；steal：抢过来。
  // 拿到以后一直占着，直到 release()、页面关掉，或者被别的页面抢走（那时调 lost）
  acquire(mode: 'try' | 'wait' | 'steal', lost: () => void): Promise<boolean>;
  // 放开占着的锁，不再排队
  release(): void;
  post(msg: RoleMessage): void;
  listen(fn: (msg: RoleMessage) => void): void;
}

// other：这个世界开在另一个页面里，那一页在写；stale（第九十五轮）：那一页关了，但它存下的比这个页面里的新（这一页不写）
export type Role = 'unknown' | 'writer' | 'other' | 'stale';

export interface RoleHooks {
  changed(role: Role): void;
  // 锁空出来了（写的那一页关了）：能不能不问就接着写
  canPromote(): Promise<boolean>;
}

// 一个页面是不是写的那一方
export class SaveRole {
  role: Role = 'unknown';
  // 每换一次加一：过时的回调（被抢走以前排的队……）不算数
  private turn = 0;
  private started: Promise<void> | null = null;

  constructor(
    private readonly lock: LockIo | null,
    private readonly id: string,
    private readonly hooks: RoleHooks,
    // 只有频道（没有锁）时也听“接过去了”
    private readonly channel: Pick<LockIo, 'post' | 'listen'> | null = lock,
  ) {}

  get lockless(): boolean {
    return this.lock === null;
  }

  private set(role: Role) {
    if (this.role === role) return;
    this.role = role;
    this.hooks.changed(role);
  }

  // 打开页面时：试着拿锁。只做一次
  start(): Promise<void> {
    this.started ??= (async () => {
      this.channel?.listen((m) => {
        if (m.type === 'taken' && m.by !== this.id) this.giveUp();
      });
      if (!this.lock) {
        this.set('writer');
        return;
      }
      const turn = ++this.turn;
      let ok = false;
      try {
        ok = await this.lock.acquire('try', () => this.yielded(turn));
      } catch {
        // 锁用不了：当没有锁，靠头里的核对
        ok = true;
      }
      if (turn !== this.turn) return;
      if (ok) this.set('writer');
      else {
        this.set('other');
        this.wait();
      }
    })();
    return this.started;
  }

  // 锁被抢走了。held：是哪一次拿的锁
  private yielded(held: number) {
    if (held !== this.turn || this.role === 'other') return;
    this.turn++;
    this.set('other');
    this.wait();
  }

  // 不再是写的那一方：别的页面说它接过去了；没有锁可用时，写的时候发现头成了别人的（autosave-io.ts 的 lost）。
  // 原来是 stale（那一页关了、这一页是旧的）时也回到 other：又有一个页面在写了，重新排队
  giveUp() {
    if (this.role === 'other') return;
    this.turn++;
    // 手上还占着锁的话放开（那一页是抢过去的，这里多半已经没有了）
    this.lock?.release();
    this.set('other');
    this.wait();
  }

  // 排队等锁：等到了（那一页关了、放开了）再看能不能接着写
  private wait() {
    if (!this.lock) return;
    const turn = ++this.turn;
    void this.lock
      .acquire('wait', () => this.yielded(turn))
      .then(async (ok) => {
        if (!ok || turn !== this.turn) return;
        let can = false;
        try {
          can = await this.hooks.canPromote();
        } catch {
          can = false;
        }
        if (turn !== this.turn) return;
        if (can) this.set('writer');
        else {
          // 不能接：放开锁（不占着不写），等用户点“重新载入”或“在这里接着做”。那一页已经关了：换一种说法（stale）
          this.lock!.release();
          this.set('stale');
        }
      })
      .catch(() => {});
  }

  // “在这里接着做”：把写的权利拿过来，告诉别的页面
  async take(): Promise<void> {
    await this.start();
    const turn = ++this.turn;
    if (this.lock) {
      this.lock.release();
      try {
        await this.lock.acquire('steal', () => this.yielded(turn));
      } catch {
        // 抢不了：照样接着做，靠头里的核对
      }
      if (turn !== this.turn) return;
    }
    this.set('writer');
    this.channel?.post({ type: 'taken', by: this.id });
  }
}

// ---------- 浏览器里的 ----------

export const LOCK_NAME = 'map2-autosave';

interface LocksLike {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

function browserChannel(name: string): Pick<LockIo, 'post' | 'listen'> | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  let ch: BroadcastChannel | null = null;
  const open = () => (ch ??= new BroadcastChannel(name));
  return {
    post: (msg) => {
      try {
        open().postMessage(msg);
      } catch {
        // 说不出去就算了：锁、头里的核对照样管用
      }
    },
    listen: (fn) => {
      try {
        open().addEventListener('message', (ev) => {
          const m = ev.data as RoleMessage | null;
          if (m && m.type === 'taken' && typeof m.by === 'string') fn(m);
        });
      } catch {
        // 同上
      }
    },
  };
}

// 浏览器的锁和频道。没有 navigator.locks 时 lock 为 null（频道有就照样用）
export function browserLockIo(name = LOCK_NAME): { lock: LockIo | null; channel: Pick<LockIo, 'post' | 'listen'> | null } {
  const channel = browserChannel(name);
  const locks = (globalThis.navigator as { locks?: LocksLike } | undefined)?.locks;
  if (!locks || typeof locks.request !== 'function') return { lock: null, channel };
  // 占着的锁：放开它；排着的队：取消它
  let free: (() => void) | null = null;
  let queued: AbortController | null = null;
  const lock: LockIo = {
    acquire(mode, lost) {
      return new Promise<boolean>((resolve) => {
        let granted = false;
        const abort = mode === 'wait' && typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (abort) queued = abort;
        const opts = mode === 'try' ? { ifAvailable: true } : mode === 'steal' ? { steal: true } : abort ? { signal: abort.signal } : {};
        locks
          .request(name, opts, (l) => {
            if (!l) {
              resolve(false);
              return;
            }
            granted = true;
            if (queued === abort) queued = null;
            resolve(true);
            // 一直占着：这个 Promise 不结束，锁就不放
            return new Promise<void>((r) => {
              free = r;
            });
          })
          .catch(() => {
            // 拿到以后被抢走；或者排队时自己取消了
            if (granted) lost();
            else resolve(false);
          });
      });
    },
    release() {
      queued?.abort();
      queued = null;
      free?.();
      free = null;
    },
    post: (msg) => channel?.post(msg),
    listen: (fn) => channel?.listen(fn),
  };
  return { lock, channel };
}

// ---------- 只在内存里的（测试用）：几个“页面”共用一把锁、一个频道 ----------

export interface MemoryLocks {
  // 一个页面的锁和频道
  page(): LockIo & { close(): void };
  // 现在谁占着（第几个页面，从 0 起；没人占着 -1）
  holder(): number;
}

export function memoryLocks(): MemoryLocks {
  interface P {
    n: number;
    lost: (() => void) | null;
    waiting: ((ok: boolean) => void) | null;
    waitLost: (() => void) | null;
    listeners: ((m: RoleMessage) => void)[];
  }
  const pages: P[] = [];
  let held: P | null = null;
  const grantNext = () => {
    if (held) return;
    const next = pages.find((p) => p.waiting);
    if (!next) return;
    held = next;
    next.lost = next.waitLost;
    const go = next.waiting!;
    next.waiting = null;
    next.waitLost = null;
    go(true);
  };
  return {
    holder: () => (held ? held.n : -1),
    page() {
      const me: P = { n: pages.length, lost: null, waiting: null, waitLost: null, listeners: [] };
      pages.push(me);
      const release = () => {
        if (me.waiting) {
          const w = me.waiting;
          me.waiting = null;
          me.waitLost = null;
          w(false);
        }
        if (held === me) {
          held = null;
          me.lost = null;
          queueMicrotask(grantNext);
        }
      };
      return {
        acquire: (mode, lost) =>
          new Promise<boolean>((resolve) => {
            if (mode === 'steal') {
              const was = held;
              held = me;
              me.lost = lost;
              resolve(true);
              if (was && was !== me) {
                const f = was.lost;
                was.lost = null;
                queueMicrotask(() => f?.());
              }
              return;
            }
            if (!held) {
              held = me;
              me.lost = lost;
              resolve(true);
              return;
            }
            if (mode === 'try') {
              resolve(false);
              return;
            }
            me.waiting = resolve;
            me.waitLost = lost;
          }),
        release,
        post: (msg) => {
          for (const p of pages) if (p !== me) for (const fn of [...p.listeners]) queueMicrotask(() => fn(structuredClone(msg)));
        },
        listen: (fn) => void me.listeners.push(fn),
        // 页面关了：锁放开，不再听
        close: () => {
          me.listeners.length = 0;
          release();
        },
      };
    },
  };
}
