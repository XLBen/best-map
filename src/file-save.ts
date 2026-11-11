import { kvDelete, kvGet, kvPut } from './idb';
import { isQuotaError } from './maps';

// 存到电脑上的文件（第九十五轮）。
// 作品只存在浏览器里：清了浏览器数据、换了浏览器就没了。支持 File System Access API 的浏览器（Chrome、Edge）里，
// 选一次文件（showSaveFilePicker），之后 ⌘S 和自动保存都同时把整份世界文件写进它。
//   文件是跟着世界的（series，见 versions.ts：连着“我的地图”的一张，或者没存的世界的编号）：换了世界不会把别的世界写进这个文件。
//   句柄存在浏览器里（kv 的 file:<哪个世界>）；下次打开页面浏览器要重新给写的权限，得用户点一下——
//   没点之前是“没在写”（paused），界面上一直看得出来，点“接着存到 xxx.json”才接着写。
//   写用 createWritable()：写完 close 才换掉原文件，写到一半出错原文件不坏。
//   自动的写要节流（FILE_SAVE_MS）；写不成（文件被删、权限没了、磁盘满）原因一直留着，下一次写成了才清。
// 这里是规则和存取：规则（FileSaver）只经 FileIo 碰文件和存储，测试换成内存里的（memoryFileIo）。
// 信号、接到自动保存和 ⌘S 上在 state/file-save.ts

export type FilePermission = 'granted' | 'prompt' | 'denied';

// 电脑上的一个文件
export interface FileTarget {
  name: string;
  // 现在能不能写。ask：可以问用户（只能在用户点了以后调）
  permission(ask: boolean): Promise<FilePermission>;
  // 整个换成这段字（写完才换掉原来的内容）
  write(text: string): Promise<void>;
}

export interface FileIo {
  // 这个浏览器能不能存到电脑上的文件
  supported(): boolean;
  // 让用户选一个文件（取消时 null）
  pick(suggested: string): Promise<FileTarget | null>;
  // 记下、取回、忘掉“这个世界存到哪个文件”
  remember(series: string, target: FileTarget): Promise<void>;
  recall(series: string): Promise<FileTarget | null>;
  forget(series: string): Promise<void>;
}

// 自动写最密多久一次。整份世界文件的字每条命令只转一次（doc-text.ts），接起来一两毫秒；真的费事的是写盘（另一个线程里），
// 几 MB 的文件每 10 秒换一次不成问题。浏览器里的那一份（1.5 秒）才是随时的，文件是多一份保险
export const FILE_SAVE_MS = 10_000;

// 没写成的原因：文件不在了（被删、挪走）；不让写（权限没了）；磁盘满了；别的
export type FileFail = 'gone' | 'denied' | 'full' | 'failed';

export interface FileStatus {
  // off：这个世界没有存到电脑上的文件；on：在写；paused：有文件但没在写（要用户点一下“接着存到…”）
  mode: 'off' | 'on' | 'paused';
  name: string | null;
  // 上一次写成的时间
  savedAt: number | null;
  fail: FileFail | null;
}
export const FILE_OFF: FileStatus = { mode: 'off', name: null, savedAt: null, fail: null };

export function fileFailOf(e: unknown): FileFail {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'NotFoundError') return 'gone';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (isQuotaError(e)) return 'full';
  return 'failed';
}

export interface FileSaverHooks {
  // 现在的世界文件的字；mark 认“和上一次写的是不是同一个状态”（相同就不重写）。没有世界时 null
  text(): Promise<{ text: string; mark: string } | null>;
  changed(status: FileStatus): void;
  now?(): number;
  timer?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
}

// 一个页面的“存到电脑上的文件”
export class FileSaver {
  status: FileStatus = FILE_OFF;
  private series: string | null = null;
  private target: FileTarget | null = null;
  // 上一次写成的那个状态、写的时间（节流用）
  private mark: string | null = null;
  private wroteAt = -Infinity;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  // 每换一次世界、换一次文件加一：过时的回调不算数
  private turn = 0;

  constructor(
    private readonly io: FileIo,
    private readonly hooks: FileSaverHooks,
  ) {}

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }
  private set(patch: Partial<FileStatus>) {
    this.status = { ...this.status, ...patch };
    this.hooks.changed(this.status);
  }
  private clearTimer() {
    if (this.timer === null) return;
    (this.hooks.timer?.clear ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  // 换了世界（新建、打开、连上“我的地图”的一张）：看这个世界有没有记着的文件。有而且现在就能写：接着写；
  // 有但要重新给权限：没在写（paused），等用户点
  async load(series: string | null): Promise<void> {
    if (series === this.series) return;
    const turn = ++this.turn;
    this.series = series;
    this.target = null;
    this.mark = null;
    this.clearTimer();
    this.set(FILE_OFF);
    if (!series || !this.io.supported()) return;
    let target: FileTarget | null = null;
    let perm: FilePermission = 'prompt';
    try {
      target = await this.io.recall(series);
      if (target) perm = await target.permission(false);
    } catch {
      target = null;
    }
    if (turn !== this.turn || !target) return;
    this.target = target;
    this.set({ mode: perm === 'granted' ? 'on' : 'paused', name: target.name, savedAt: null, fail: null });
  }

  // 一个世界的键换了（第一次存进“我的地图”）：文件跟着走
  async rekey(from: string, to: string): Promise<void> {
    if (from === to) return;
    try {
      const t = this.series === from ? this.target : await this.io.recall(from);
      if (t) await this.io.remember(to, t);
      await this.io.forget(from);
    } catch {
      // 记不下来：这次打开页面照样写，下次要重新选
    }
    if (this.series === from) this.series = to;
  }

  // “存到电脑上的文件…”：让用户选一个，马上写一次。取消了返回 false
  async attach(suggested: string): Promise<boolean> {
    if (!this.series || !this.io.supported()) return false;
    const series = this.series;
    const target = await this.io.pick(suggested);
    if (!target || series !== this.series) return false;
    this.turn++;
    this.target = target;
    this.mark = null;
    this.set({ mode: 'on', name: target.name, savedAt: null, fail: null });
    try {
      await this.io.remember(series, target);
    } catch {
      // 记不下来（浏览器存储不可用）：这次打开页面照样写，下次要重新选
    }
    await this.flush();
    return true;
  }

  // “接着存到 xxx.json”：用户点了，问浏览器要权限；给了就接着写
  async resume(): Promise<boolean> {
    const target = this.target;
    if (!target || this.status.mode === 'off') return false;
    const turn = this.turn;
    let perm: FilePermission;
    try {
      perm = await target.permission(true);
    } catch {
      perm = 'denied';
    }
    if (turn !== this.turn) return false;
    if (perm !== 'granted') {
      this.set({ mode: 'paused', fail: 'denied' });
      return false;
    }
    this.set({ mode: 'on', fail: null });
    await this.flush();
    return this.status.fail === null;
  }

  // “不再存到这个文件”：忘掉它（文件本身不动）
  async detach(): Promise<void> {
    const series = this.series;
    this.turn++;
    this.target = null;
    this.mark = null;
    this.clearTimer();
    this.set(FILE_OFF);
    if (series) {
      try {
        await this.io.forget(series);
      } catch {
        // 忘不掉：下次打开页面还会问“接着存到…”，再点一次“不再存到这个文件”
      }
    }
  }

  // 自动保存写成之后：到了时间就写，没到就定一个时
  noteSaved(): void {
    if (this.status.mode !== 'on' || this.timer !== null) return;
    const wait = this.wroteAt + FILE_SAVE_MS - this.now();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    this.timer = (this.hooks.timer?.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)))(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  // 马上写一次（⌘S、定的时到了、刚选好文件）。一次只写一份；世界没变就不重写
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.writeOnce());
    return this.chain;
  }

  private async writeOnce(): Promise<void> {
    const target = this.target;
    const turn = this.turn;
    if (!target || this.status.mode !== 'on') return;
    let got: { text: string; mark: string } | null = null;
    try {
      got = await this.hooks.text();
    } catch {
      got = null;
    }
    if (!got || turn !== this.turn) return;
    if (got.mark === this.mark && this.status.fail === null) return;
    this.wroteAt = this.now();
    try {
      await target.write(got.text);
    } catch (e) {
      if (turn !== this.turn) return;
      const fail = fileFailOf(e);
      // 权限没了：回到“没在写”，等用户再点一次
      this.set({ fail, ...(fail === 'denied' ? { mode: 'paused' as const } : {}) });
      return;
    }
    if (turn !== this.turn) return;
    this.mark = got.mark;
    this.set({ savedAt: this.now(), fail: null });
  }
}

// ---------- 只在内存里的（测试用） ----------

export interface MemoryFile extends FileTarget {
  // 文件里现在的内容（还没写过时 null）；写了几次
  content: string | null;
  writes: number;
  // 权限；问的时候给不给
  perm: FilePermission;
  grant: boolean;
  // 下一次写出什么错（名字，比如 'NotFoundError'）；写到一半出错时原来的内容不变
  failWith: string | null;
  // 问过几次权限
  asked: number;
}

export function memoryFile(name: string): MemoryFile {
  const f: MemoryFile = {
    name,
    content: null,
    writes: 0,
    perm: 'granted',
    grant: true,
    failWith: null,
    asked: 0,
    permission: async (ask) => {
      if (f.perm === 'granted' || !ask) return f.perm;
      f.asked++;
      f.perm = f.grant ? 'granted' : 'denied';
      return f.perm;
    },
    write: async (text) => {
      if (f.perm !== 'granted') throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
      if (f.failWith) throw Object.assign(new Error(f.failWith), { name: f.failWith });
      f.content = text;
      f.writes++;
    },
  };
  return f;
}

export interface MemoryFileIo extends FileIo {
  // 浏览器支不支持；下一次选文件选中哪个（null：用户取消了）
  support: boolean;
  next: MemoryFile | null;
  remembered: Map<string, MemoryFile>;
  // 记不下来（浏览器存储不可用）
  down: boolean;
}

export function memoryFileIo(): MemoryFileIo {
  const io: MemoryFileIo = {
    support: true,
    next: null,
    remembered: new Map(),
    down: false,
    supported: () => io.support,
    pick: async () => io.next,
    remember: async (series, target) => {
      if (io.down) throw new Error('down');
      io.remembered.set(series, target as MemoryFile);
    },
    recall: async (series) => {
      if (io.down) throw new Error('down');
      return io.remembered.get(series) ?? null;
    },
    forget: async (series) => {
      if (io.down) throw new Error('down');
      io.remembered.delete(series);
    },
  };
  return io;
}

// ---------- 浏览器里的 ----------

interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface HandleLike {
  name: string;
  createWritable(): Promise<WritableLike>;
  queryPermission?(d: { mode: 'readwrite' }): Promise<FilePermission>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<FilePermission>;
}
type Picker = (opts: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<HandleLike>;
const picker = (): Picker | null => {
  const f = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  return typeof f === 'function' ? (f as Picker) : null;
};

const handles = new WeakMap<FileTarget, HandleLike>();
// 一个句柄做成的文件
export function handleTarget(h: HandleLike): FileTarget {
  const t: FileTarget = {
    name: h.name,
    async permission(ask) {
      // 没有这两个方法的句柄（浏览器自己管的那种）：一直能写
      if (!h.queryPermission) return 'granted';
      const q = await h.queryPermission({ mode: 'readwrite' });
      if (q === 'granted' || !ask || !h.requestPermission) return q;
      return h.requestPermission({ mode: 'readwrite' });
    },
    async write(text) {
      const w = await h.createWritable();
      try {
        await w.write(text);
        // close 了才换掉原文件
        await w.close();
      } catch (e) {
        try {
          await w.abort?.();
        } catch {
          // 已经关了
        }
        throw e;
      }
    },
  };
  handles.set(t, h);
  return t;
}

const fileKey = (series: string) => `file:${series}`;

export const browserFileIo: FileIo = {
  supported: () => picker() !== null,
  async pick(suggested) {
    const pick = picker();
    if (!pick) return null;
    try {
      return handleTarget(await pick({ suggestedName: suggested, types: [{ description: '世界文件', accept: { 'application/json': ['.json'] } }] }));
    } catch (e) {
      // 用户关掉了选择框
      if ((e as { name?: unknown } | null)?.name === 'AbortError') return null;
      throw e;
    }
  },
  async remember(series, target) {
    const h = handles.get(target);
    if (h) await kvPut(fileKey(series), { name: target.name, handle: h });
  },
  async recall(series) {
    const rec = await kvGet<{ name: string; handle: HandleLike }>(fileKey(series));
    return rec && rec.handle && typeof rec.handle.createWritable === 'function' ? handleTarget(rec.handle) : null;
  },
  forget: (series) => kvDelete(fileKey(series)),
};
