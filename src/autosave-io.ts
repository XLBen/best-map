import type { DocTail, WorldDoc } from '../core/engine';
import { type AutosaveInfo, type BackupWhy, type RawAutosave, type WorldBackup, backupFor, browserBackupIo, splitHead, staleWhy } from './backups';
import { openDb } from './idb';

// 自动保存“写什么”（第九十四轮）。
// 以前每个页面各自记着“已经写了哪几步”，只把变了的命令按下标写进同一张表：两个页面各做各的世界时，
// 头是后写的那个页面的，命令是两边交错的——下次打开要么条数对不上（当作没有），要么是拼出来的怪世界（见 autosave-io.test.ts 的复现）。
// 现在：
//   头里记着谁写的（writer：这一次打开页面的随机 id）和第几代（gen：每写一次加一）；
//   每次写都在同一个事务里先读头——头是自己上一次写的那一代，才按下标只写变了的；不是的话，
//   有写的权利的页面（拿着锁，见 autosave-lock.ts）整份重写，没有的不写；
//   整份重写会盖掉别人写的那一份：盖之前先看它是不是自己打开的那一份、或者自己的世界就是接着它做的，
//   都不是就原样挪进“留着的旧世界”（backups.ts），不无声地盖掉。
// 这里是规则和存取：规则只经 AutosaveIo 碰存储，测试换成内存里的（memoryAutosaveIo，几个“页面”共用一个 MemoryDisk）

export type DocHead = Omit<WorldDoc, 'commands'>;
export type AutosaveHead = DocHead & AutosaveInfo;

// 一次要写的：先清空（整份重写）、从第几条起写哪些命令、删掉多出来的哪一段、新的头
export interface AutosaveBatch {
  clear: boolean;
  from: number;
  commands: readonly unknown[];
  drop: [number, number] | null;
  head: AutosaveHead;
}

export interface AutosaveIo {
  // 一个事务：读头 → plan(头) 给出要写的（null：不写）→ 照着写。提交了才算成功；存储用不了、满了时抛错
  write(plan: (head: AutosaveHead | undefined) => AutosaveBatch | null): Promise<void>;
  // 关页面的那一下：不读头，同步把这一批发出去（不等它提交）。发不出去时 false
  writeNow(batch: AutosaveBatch): boolean;
  // 存着的那一份，原样（没有时 null）
  raw(): Promise<RawAutosave | null>;
  // 一个事务：把存着的那一份放进“留着的旧世界”，位置空出来
  keep(b: WorldBackup): Promise<void>;
}

// 头的记号：整份重写之前认“盖掉的是不是我看过的那一份”
export interface HeadMark {
  writer: string | null;
  gen: number | null;
  savedAt: number;
  count: number;
}
export const markOf = (h: { writer?: string; gen?: number; savedAt: number; count?: number }): HeadMark => ({ writer: h.writer ?? null, gen: h.gen ?? null, savedAt: h.savedAt, count: h.count ?? -1 });
const sameMark = (a: HeadMark | null, b: HeadMark) => !!a && a.writer === b.writer && a.gen === b.gen && a.savedAt === b.savedAt && a.count === b.count;

// 头里除了世界文件、时间、条数、谁写的以外的几项
export type SaveExtra = Pick<AutosaveInfo, 'safe' | 'mapId' | 'mapSynced'>;

// 主线程手上的整份世界（sandbox.ts 的命令记录）：key 认是不是同一个引擎（换了 Worker、换了世界就不同）
export interface FullDoc extends DocHead {
  commands: readonly unknown[];
  ids: readonly number[];
  key: string;
}

export type WriteOutcome =
  // 写下了；kept：盖掉之前挪进“留着的旧世界”的那一份
  | { kind: 'saved'; head: AutosaveHead; kept: WorldBackup | null }
  // 这个页面不是写的那一方：没写
  | { kind: 'other' }
  // 要整份的命令才能写（已经忘掉“写过哪几步”）：调用方重新取整份再来一次
  | { kind: 'again' }
  // 原来那一份没能留下来（多半是存储满了）：没写，原来的还在
  | { kind: 'keep-failed'; error: unknown };

// 存着的那一份是不是我的世界的开头（我的世界是接着它做的，或者就是它）：是的话盖掉它什么都不丢
export function continues(stored: unknown, mine: { format: unknown; version: unknown; settings: unknown; commands: readonly unknown[] }): boolean {
  if (stored === null || typeof stored !== 'object') return true;
  const s = stored as { format?: unknown; version?: unknown; settings?: unknown; commands?: unknown };
  // 里面没有一步：没有什么可丢的
  if (!Array.isArray(s.commands) || !s.commands.length) return true;
  if (s.format !== mine.format || s.version !== mine.version || s.commands.length > mine.commands.length) return false;
  if (JSON.stringify(s.settings) !== JSON.stringify(mine.settings)) return false;
  for (let k = 0; k < s.commands.length; k++) if (JSON.stringify(s.commands[k]) !== JSON.stringify(mine.commands[k])) return false;
  return true;
}

const prefixLen = (a: readonly number[], b: readonly number[]): number => {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
};

type Verdict = 'inc' | 'full' | 'other' | 'lost' | 'vet' | 'again';

export interface WriterHooks {
  // 没有锁可用时：发现别的页面接过去写了（这个页面不再写）
  lost?(): void;
  // 盖掉之前把一份挪进了“留着的旧世界”
  kept?(b: WorldBackup): void;
}

// 一个页面的“写自动保存”的状态和规则
export class AutosaveWriter {
  // 有没有写的权利：拿着锁；没有锁可用（lockless）时，还没被别的页面接过去
  holder = true;
  // 上一次写下的那一代（还没写成过时 null）、写下的每一步的编号、那些编号是哪个引擎的、写下了几条
  gen: number | null = null;
  savedIds: readonly number[] = [];
  savedKey: string | null = null;
  count = 0;
  // 这个页面打开的就是这一份（盖掉它不用先留）
  opened: HeadMark | null = null;
  // 盖掉别人写的那一份之前留下来时，写的原因（上次的世界没能打开、没打开就新建了……）
  keepWhy: { why: BackupWhy; error?: string } = { why: 'replaced' };
  private vetted: HeadMark | null = null;

  constructor(
    readonly io: AutosaveIo,
    readonly id: string,
    readonly lockless: boolean,
    private readonly hooks: WriterHooks = {},
  ) {}

  // 忘掉“写过哪几步”（换了世界、换了 Worker）：下一次从头写
  forget() {
    // 换一个数组：正在路上的那一次写（按原来的 savedIds 取的命令）据此知道自己过时了
    this.savedIds = [];
    this.savedKey = null;
  }

  // 把写的权利拿过来（“在这里接着做”）：下一次整份重写，别的页面写的那一份和这里的不一样就先留着
  claim() {
    this.holder = true;
    this.gen = null;
    this.forget();
    this.keepWhy = { why: 'other-page' };
  }

  // 不再写（锁被别的页面拿走了、别的页面说它接过去了）。
  // 连“上一次写的那一代”也忘掉：以后再轮到这个页面写（那一页关了）时，头多半是那一页的——
  // 第一次要在事务里读头、整份重写，不能按原来的下标接着写，关页面的那一下也不能不读头就写
  yield() {
    this.holder = false;
    this.gen = null;
    this.forget();
  }

  // 别的页面关了、锁空出来了：存着的那一份是我的世界的开头（或者就是它）时才接着写——不然会拿旧的盖掉那个页面后来做的
  async canPromote(mine: FullDoc | null): Promise<boolean> {
    if (!mine) return true;
    try {
      const raw = await this.io.raw();
      return !raw || continues(raw.doc, mine);
    } catch {
      return false;
    }
  }

  private verdict(head: AutosaveHead | undefined, from: number): Verdict {
    if (!this.holder) return 'other';
    // 头是我上一次写的那一代：中间没有别人写过，按下标只写变了的
    if (head && this.gen !== null && head.writer === this.id && head.gen === this.gen) return 'inc';
    const foreign = !!head && head.writer !== this.id;
    // 没有锁可用：我写过以后头成了别人的——别的页面接过去了
    if (foreign && this.lockless && this.gen !== null) return 'lost';
    // 要盖掉别人写的：先看是不是我打开的那一份、我看过可以盖的那一份
    if (foreign && !sameMark(this.opened, markOf(head!)) && !sameMark(this.vetted, markOf(head!))) return 'vet';
    return from > 0 ? 'again' : 'full';
  }

  private headOf(doc: DocHead, count: number, gen: number, extra: SaveExtra, now: number): AutosaveHead {
    const { format, version, settings } = doc;
    return {
      format,
      version,
      settings,
      savedAt: now,
      count,
      ...(extra.safe !== undefined ? { safe: extra.safe } : {}),
      ...(extra.mapId !== undefined ? { mapId: extra.mapId, ...(extra.mapSynced ? { mapSynced: true } : {}) } : {}),
      writer: this.id,
      gen,
    };
  }

  // 写一次。tail：引擎给的“从第 from 条起的命令”（engine.docTail(base)）；base：取 tail 时的 savedIds（就是那个数组）；key：这是哪个引擎的。
  // 取 tail 之后、写之前 savedIds 变了（关页面的那一下先写了一次）：这份 tail 的下标已经不对，不写，再取一次
  async write(tail: DocTail, extra: SaveExtra, at: { base: readonly number[]; key?: string | null; now?: number }): Promise<WriteOutcome> {
    const now = at.now ?? Date.now();
    const n = tail.ids.length;
    const stale = () => at.base !== this.savedIds;
    let kept: WorldBackup | null = null;
    for (let round = 0; round < 4; round++) {
      const got: { verdict: Verdict; written: AutosaveHead | null } = { verdict: 'other', written: null };
      await this.io.write((head) => {
        got.verdict = this.verdict(head, tail.from);
        // 取命令之后 savedIds 变过：下标不对了，不写
        if ((got.verdict === 'inc' || got.verdict === 'full') && stale()) got.verdict = 'again';
        if (got.verdict === 'inc') {
          got.written = this.headOf(tail, n, head!.gen! + 1, extra, now);
          return { clear: false, from: tail.from, commands: tail.commands, drop: head!.count > n ? [n, head!.count - 1] : null, head: got.written };
        }
        if (got.verdict === 'full') {
          got.written = this.headOf(tail, n, (head?.gen ?? 0) + 1, extra, now);
          return { clear: true, from: 0, commands: tail.commands, drop: null, head: got.written };
        }
        return null;
      });
      const { verdict, written: head } = got;
      if (head) {
        if (stale()) {
          // 这一次的事务开了以后、提交之前又同步写了一次：存着的是哪一次的说不准，下一次从头写
          this.forget();
          return { kind: 'again' };
        }
        this.gen = head.gen!;
        this.savedIds = tail.ids;
        this.savedKey = at.key ?? null;
        this.count = n;
        this.vetted = null;
        this.keepWhy = { why: 'replaced' };
        return { kind: 'saved', head, kept };
      }
      if (verdict === 'other') return { kind: 'other' };
      if (verdict === 'lost') {
        this.yield();
        this.hooks.lost?.();
        return { kind: 'other' };
      }
      if (verdict === 'again' || tail.from > 0) {
        // 要盖掉别人写的、要整份重写：都得有整份的命令
        if (!stale()) this.forget();
        return { kind: 'again' };
      }
      // vet：别人写的那一份。就是我的世界的开头时盖掉它什么都不丢；不是就先原样留着
      const raw = await this.io.raw();
      if (!raw) continue;
      if (continues(raw.doc, tail)) {
        this.vetted = markOf(raw);
        continue;
      }
      try {
        // 别的版本做的照版本说；这一版的写上为什么留着
        const b = backupFor(raw, staleWhy(raw) ?? { age: 'current', ...this.keepWhy }, now, new Set());
        // 编号后面带几个随机的字：不和已经留着的重
        kept = { ...b, id: `${b.id}-${Math.random().toString(36).slice(2, 7)}` };
        await this.io.keep(kept);
        this.hooks.kept?.(kept);
      } catch (error) {
        return { kind: 'keep-failed', error };
      }
    }
    // 几轮都没写成：别的页面一直在写（不该发生）。这一次不写，下一次再来
    return { kind: 'other' };
  }

  // 关页面的那一下：不读头、同步发出去（等不到事务里读头的回调）。只有拿着锁、而且头确实是自己写的那一代时才行。
  // sent：发出去了；nothing：没有没写的；cannot：这样写不了（调用方走平常那条路，能写成多少算多少）
  blind(doc: FullDoc, extra: SaveExtra, now = Date.now()): 'sent' | 'nothing' | 'cannot' {
    if (this.lockless || !this.holder || this.gen === null) return 'cannot';
    const from = doc.key === this.savedKey ? prefixLen(this.savedIds, doc.ids) : 0;
    const n = doc.ids.length;
    if (from === n && n === this.savedIds.length) return 'nothing';
    const head = this.headOf(doc, n, this.gen + 1, extra, now);
    if (!this.io.writeNow({ clear: false, from, commands: doc.commands.slice(from), drop: this.count > n ? [n, this.count - 1] : null, head })) return 'cannot';
    // 当它写成了：万一没提交，下一次写时头不是这一代，会整份重写
    this.gen = head.gen!;
    this.savedIds = doc.ids;
    this.savedKey = doc.key;
    this.count = n;
    return 'sent';
  }
}

// 读出来的一份能不能当这一版的世界打开：条数对得上、每一条都是命令（版本另查）
export function wholeDoc(head: AutosaveHead, commands: readonly unknown[]): boolean {
  return commands.length === head.count && commands.every((c) => c !== null && typeof c === 'object');
}

// 这一次打开页面的随机 id
export function newPageId(): string {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 只在内存里的（测试用）：几个“页面”共用一个 MemoryDisk ----------

export interface MemoryDisk {
  head: AutosaveHead | undefined;
  rows: Map<number, unknown>;
  backups: Map<string, WorldBackup>;
  // 存储用不了；满了（写不进去）；关页面时那一下发不出去（没有开着的连接）
  down: boolean;
  full: boolean;
  noNow: boolean;
  // 提交了几次
  commits: number;
}
export const memoryDisk = (): MemoryDisk => ({ head: undefined, rows: new Map(), backups: new Map(), down: false, full: false, noNow: false, commits: 0 });

const quotaError = () => Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });

function applyBatch(disk: MemoryDisk, b: AutosaveBatch) {
  if (b.clear) disk.rows.clear();
  b.commands.forEach((c, k) => disk.rows.set(b.from + k, structuredClone(c)));
  if (b.drop) for (let k = b.drop[0]; k <= b.drop[1]; k++) disk.rows.delete(k);
  disk.head = structuredClone(b.head);
  disk.commits++;
}

// 存着的那一份，照 readAutosave 的读法：头里写的条数那一段
export function diskRaw(disk: MemoryDisk): RawAutosave | null {
  const meta = disk.head;
  if (!meta || !(meta.count > 0)) return null;
  const commands: unknown[] = [];
  for (let k = 0; k < meta.count; k++) if (disk.rows.has(k)) commands.push(structuredClone(disk.rows.get(k)));
  const { info, head } = splitHead(meta);
  const { mapSynced: _, ...rest } = info;
  return { ...rest, doc: { ...structuredClone(head), commands } };
}

export function memoryAutosaveIo(disk: MemoryDisk): AutosaveIo {
  return {
    write: async (plan) => {
      if (disk.down) throw new Error('down');
      const batch = plan(disk.head ? structuredClone(disk.head) : undefined);
      if (!batch) return;
      if (disk.full) throw quotaError();
      applyBatch(disk, batch);
    },
    writeNow: (batch) => {
      if (disk.down || disk.noNow) return false;
      if (!disk.full) applyBatch(disk, batch);
      return true;
    },
    raw: async () => {
      if (disk.down) throw new Error('down');
      return diskRaw(disk);
    },
    keep: async (b) => {
      if (disk.down) throw new Error('down');
      if (disk.full) throw quotaError();
      disk.backups.set(b.id, structuredClone(b));
      disk.head = undefined;
      disk.rows.clear();
    },
  };
}

// ---------- 浏览器里的 ----------

const put = (kv: IDBObjectStore, store: IDBObjectStore, b: AutosaveBatch) => {
  if (b.clear) store.clear();
  b.commands.forEach((c, k) => store.put(c, b.from + k));
  if (b.drop) store.delete(IDBKeyRange.bound(b.drop[0], b.drop[1]));
  kv.put(b.head, 'autosave');
};

// 一直开着的一个连接：关页面的那一下要同步开事务，等不到 open 的回调。第一次写成之后开；别的页面要升级库时它自己关掉
let kept: IDBDatabase | null = null;
let opening = false;
function keepOpen() {
  if (kept || opening) return;
  opening = true;
  openDb().then(
    (db) => {
      opening = false;
      kept = db;
      const drop = () => {
        if (kept === db) kept = null;
      };
      db.addEventListener?.('versionchange', drop);
      db.addEventListener?.('close', drop);
    },
    () => {
      opening = false;
    },
  );
}
// 测试换掉假的 IndexedDB 时：不留着上一个的连接
export function dropKeptDb() {
  kept = null;
}

export const browserAutosaveIo: AutosaveIo = {
  async write(plan) {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['kv', 'autosave'], 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('自动保存没写成'));
        const kv = tx.objectStore('kv');
        const req = kv.get('autosave');
        req.onsuccess = () => {
          try {
            const batch = plan(req.result as AutosaveHead | undefined);
            if (batch) put(kv, tx.objectStore('autosave'), batch);
          } catch (e) {
            reject(e);
            tx.abort();
          }
        };
      });
    } finally {
      db.close();
    }
    keepOpen();
  },
  writeNow(batch) {
    if (!kept) return false;
    try {
      const tx = kept.transaction(['kv', 'autosave'], 'readwrite');
      put(tx.objectStore('kv'), tx.objectStore('autosave'), batch);
      // 不等回调就提交：页面马上要没了
      tx.commit?.();
      return true;
    } catch {
      kept = null;
      return false;
    }
  },
  raw: () => browserBackupIo.idbAutosave(),
  keep: (b) => browserBackupIo.idbMove(b),
};
