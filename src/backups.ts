import { docAge, docVersionOf } from '../core/doc-version';
import { idbAll, idbTx, openDb } from './idb';

// 留着的旧世界（第九十一轮）。
// 自动保存只认这一版的世界文件。以前别的版本的自动保存“当作没有”：启动时直接进向导，用户新建以后旧的就被盖掉了——
// 程序每升一次世界格式，用户上次的世界就无声地没了。现在启动时（读自动保存之前）先看一眼：
// 不是这一版能打开的（旧版本的，或者更新的版本做的），原样挪进 backups 表（连命令一起，带时间和它自己的版本号），
// 自动保存的位置空出来，之后新世界怎么自动保存都碰不到它。它一直留着，直到用户自己删除；可以导出成世界文件（内容和原来的一字不差）。
// 这里是规则和存取：规则只经 BackupIo 碰存储，测试换成内存里的（memoryBackupIo）；浏览器里的那一层（browserBackupIo）只有几行。
// 界面在 ui/maps/backups.ts、BackupsDialog.tsx、shell/BackupBanner.tsx
//
// 第九十四轮：这一版的世界也会留在这里——自动保存没存完整（头里写的条数和读出来的对不上，why: 'damaged'）、
// 上次的世界没能打开或没打开就新建了（'failed' / 'cancelled'）、别的页面里保存的世界被这个页面接过去盖掉之前（'other-page'）、
// 别的原因被换掉之前（'replaced'）。后面几种是写自动保存的那一边（autosave-io.ts）在盖掉之前挪进来的

export const AUTOSAVE_KEY = 'map2.autosave';
// IndexedDB 用不了时留在 localStorage 里的：一份一个键
export const LOCAL_BACKUP_PREFIX = 'map2.backup.';

export interface WorldBackup {
  id: string;
  // 留下来的时间、它最后一次自动保存的时间
  keptAt: number;
  savedAt: number;
  // 文件里写着的版本号（没写时 null），比这一版旧还是新（current：就是这一版的，为什么留着见 why）
  version: number | null;
  age: 'older' | 'newer' | 'current';
  // 第九十四轮：这一版的世界为什么留在这里；error 是没能打开时的原因（原样的一行）
  why?: BackupWhy;
  error?: string;
  // 命令的条数
  steps: number;
  // 整个世界文件，和自动保存里的一字不差
  doc: unknown;
  // 自动保存里原样带着的：安全模式的原因、连着“我的地图”里的哪一张
  safe?: string;
  mapId?: string;
  // 提示条关过了（“世界”菜单里照样找得到）
  seen?: true;
}
export type BackupWhy = 'damaged' | 'failed' | 'cancelled' | 'other-page' | 'replaced';
export type BackupInfo = Omit<WorldBackup, 'doc'>;
export const infoOf = ({ doc: _, ...info }: WorldBackup): BackupInfo => info;

// 存着的一份自动保存（不看版本，原样）
export interface RawAutosave {
  savedAt: number;
  doc: unknown;
  safe?: string;
  mapId?: string;
  // 第九十四轮：头里写着的命令条数（和读出来的对不上就是没存完整）、谁写的、第几代（见 autosave-io.ts）
  count?: number;
  writer?: string;
  gen?: number;
}

// 自动保存的头（kv 的 autosave）里除了世界文件本身的那几项
export interface AutosaveInfo {
  savedAt: number;
  count: number;
  // 安全模式（脚本没有运行）的原因：下次打开时照样用安全模式
  safe?: string;
  // 连着“我的地图”里的哪一张；mapSynced：写这份自动保存时那一张已经与它相同
  mapId?: string;
  mapSynced?: boolean;
  // 第九十四轮：写它的页面（每次打开页面一个随机的 id）、第几代（每写一次加一）
  writer?: string;
  gen?: number;
}
// 把头拆成这几项和世界文件的头（format、version、settings……）：世界文件里不带上面这几项
export function splitHead<T extends AutosaveInfo>(meta: T): { info: AutosaveInfo; head: Omit<T, keyof AutosaveInfo> } {
  const { savedAt, count, safe, mapId, mapSynced, writer, gen, ...head } = meta;
  return {
    info: {
      savedAt,
      count,
      ...(typeof safe === 'string' ? { safe } : {}),
      ...(typeof mapId === 'string' ? { mapId, mapSynced: mapSynced === true } : {}),
      ...(typeof writer === 'string' ? { writer } : {}),
      ...(typeof gen === 'number' ? { gen } : {}),
    },
    head,
  };
}

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

// 存取。IndexedDB 的几个在用不了时抛错
export interface BackupIo {
  // IndexedDB 里的自动保存；没有时 null
  idbAutosave(): Promise<RawAutosave | null>;
  // 一个事务里：放进 backups，去掉自动保存（要么都做，要么都不做）
  idbMove(b: WorldBackup): Promise<void>;
  idbPut(b: WorldBackup): Promise<void>;
  idbList(): Promise<WorldBackup[]>;
  idbRemove(id: string): Promise<void>;
  local(): LocalStore;
}

// 这一版打不开的世界文件：旧版本的、更新的版本做的（不是世界文件的不管）
export function staleAge(doc: unknown): 'older' | 'newer' | null {
  const age = docAge(doc);
  return age === 'older' || age === 'newer' ? age : null;
}

// 这一版的自动保存没存完整（第九十四轮）：头里写的条数和读出来的对不上，或者有哪一条不是命令
export function damaged(a: RawAutosave): boolean {
  const commands = (a.doc as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(commands)) return true;
  if (typeof a.count === 'number' && commands.length !== a.count) return true;
  return commands.some((c) => c === null || typeof c !== 'object');
}

// 为什么这一份打不开：旧版本的、更新的版本做的，或者是这一版的但没存完整。能打开时 null
export function staleWhy(a: RawAutosave): Pick<WorldBackup, 'age' | 'why'> | null {
  const age = docAge(a.doc);
  if (age === 'older' || age === 'newer') return { age };
  return age === 'current' && damaged(a) ? { age, why: 'damaged' } : null;
}

// 一份自动保存做成留着的一条（编号不和 taken 里的重）
export function backupFor(a: RawAutosave, kind: Pick<WorldBackup, 'age' | 'why' | 'error'>, now: number, taken: ReadonlySet<string>): WorldBackup {
  const { age } = kind;
  const savedAt = typeof a.savedAt === 'number' ? a.savedAt : now;
  let id = `b${savedAt}`;
  for (let k = 2; taken.has(id); k++) id = `b${savedAt}-${k}`;
  const commands = (a.doc as { commands?: unknown }).commands;
  return {
    id,
    keptAt: now,
    savedAt,
    version: docVersionOf(a.doc),
    age,
    steps: Array.isArray(commands) ? commands.length : 0,
    doc: a.doc,
    ...(kind.why ? { why: kind.why } : {}),
    ...(kind.error ? { error: kind.error } : {}),
    ...(typeof a.safe === 'string' ? { safe: a.safe } : {}),
    ...(typeof a.mapId === 'string' ? { mapId: a.mapId } : {}),
  };
}

function localBackups(local: LocalStore): WorldBackup[] {
  const out: WorldBackup[] = [];
  for (let k = 0; k < local.length; k++) {
    const key = local.key(k);
    if (!key?.startsWith(LOCAL_BACKUP_PREFIX)) continue;
    try {
      const b = JSON.parse(local.getItem(key) ?? 'null') as WorldBackup | null;
      if (b && typeof b.id === 'string' && b.doc) out.push(b);
    } catch {
      // 坏了的一份读不出来：留在原处，不删
    }
  }
  return out;
}

// 留着的全部（最近留下的在前）。IndexedDB 用不了时只有 localStorage 里的
export async function listBackups(io: BackupIo): Promise<WorldBackup[]> {
  const out: WorldBackup[] = [];
  try {
    out.push(...(await io.idbList()));
  } catch {
    // 读不了就只看 localStorage
  }
  try {
    out.push(...localBackups(io.local()));
  } catch {
    // localStorage 也用不了
  }
  return out.sort((a, b) => b.keptAt - a.keptAt || (a.id < b.id ? 1 : -1));
}

// 启动时：自动保存（IndexedDB 的和 localStorage 后备的）不是这一版能打开的（第九十四轮：或者没存完整的），原样挪进 backups。返回这一次留下的。
// 先放进 backups、再去掉原来的：中途出错时原来的还在（下次启动再挪），不会两头都没有
export async function keepStaleAutosaves(io: BackupIo, now = Date.now()): Promise<WorldBackup[]> {
  const kept: WorldBackup[] = [];
  const taken = new Set((await listBackups(io)).map((b) => b.id));
  let idbOk = true;
  try {
    const a = await io.idbAutosave();
    // 第九十四轮：这一版的但没存完整的也算（两个页面混着写、写到一半）
    const kind = a && staleWhy(a);
    if (a && kind) {
      const b = backupFor(a, kind, now, taken);
      await io.idbMove(b);
      taken.add(b.id);
      kept.push(b);
    }
  } catch {
    idbOk = false;
  }
  try {
    const local = io.local();
    const raw = local.getItem(AUTOSAVE_KEY);
    const old = raw ? (JSON.parse(raw) as RawAutosave) : null;
    const age = old && staleAge(old.doc);
    if (raw && old && age) {
      const b = backupFor(old, { age }, now, taken);
      let moved = false;
      if (idbOk) {
        try {
          await io.idbPut(b);
          moved = true;
          local.removeItem(AUTOSAVE_KEY);
        } catch {
          // 放不进 IndexedDB：留在 localStorage 里换一个键
        }
      }
      if (!moved) {
        // localStorage 放不下两份：先拿掉原来的再写（同步的两句），写不进去就放回原处（autosave.ts 写后备之前会再看一眼，不盖它）
        local.removeItem(AUTOSAVE_KEY);
        try {
          local.setItem(LOCAL_BACKUP_PREFIX + b.id, JSON.stringify(b));
          moved = true;
        } catch {
          local.setItem(AUTOSAVE_KEY, raw);
        }
      }
      if (moved) kept.push(b);
    }
  } catch {
    // 坏了、用不了：当没有
  }
  return kept;
}

// localStorage 后备的位置上是不是还压着一份这一版打不开的世界（没能挪走）：写后备的自动保存之前查，不盖它
export function staleLocalAutosave(local: LocalStore): boolean {
  try {
    const raw = local.getItem(AUTOSAVE_KEY);
    return !!raw && staleAge((JSON.parse(raw) as RawAutosave).doc) !== null;
  } catch {
    return false;
  }
}

const inLocal = (io: BackupIo, id: string): boolean => {
  try {
    return io.local().getItem(LOCAL_BACKUP_PREFIX + id) !== null;
  } catch {
    return false;
  }
};

export async function removeBackup(io: BackupIo, id: string): Promise<void> {
  if (inLocal(io, id)) io.local().removeItem(LOCAL_BACKUP_PREFIX + id);
  else await io.idbRemove(id);
}

// 提示条关过了：记在那一份上（下次启动不再提示，“世界”菜单里还在）
export async function markSeen(io: BackupIo, ids: readonly string[]): Promise<void> {
  const want = new Set(ids);
  for (const b of await listBackups(io)) {
    if (!want.has(b.id) || b.seen) continue;
    const next: WorldBackup = { ...b, seen: true };
    try {
      if (inLocal(io, b.id)) io.local().setItem(LOCAL_BACKUP_PREFIX + b.id, JSON.stringify(next));
      else await io.idbPut(next);
    } catch {
      // 记不下来：下次启动再提示一次
    }
  }
}

// 导出的世界文件：就是那份世界文件（里面写着它自己的版本号）
export const backupFileText = (b: Pick<WorldBackup, 'doc'>): string => JSON.stringify(b.doc);
// 文件名：“旧世界 2026-11-10 第21版”
export function backupFileName(b: Pick<WorldBackup, 'savedAt' | 'version'>): string {
  const d = new Date(b.savedAt);
  const two = (n: number) => String(n).padStart(2, '0');
  return `旧世界 ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}${b.version !== null ? ` 第${b.version}版` : ''}.json`;
}

// ---------- 只在内存里的（测试用） ----------

export interface MemoryBackupIo extends BackupIo {
  // IndexedDB 里的自动保存、backups 表、localStorage
  autosave: RawAutosave | null;
  table: Map<string, WorldBackup>;
  storage: Map<string, string>;
  // IndexedDB 用不了（隐私模式）；localStorage 最多放多少个字
  idbDown: boolean;
  quota: number;
}

export function memoryBackupIo(): MemoryBackupIo {
  const table = new Map<string, WorldBackup>();
  const storage = new Map<string, string>();
  const io: MemoryBackupIo = {
    autosave: null,
    table,
    storage,
    idbDown: false,
    quota: Infinity,
    idbAutosave: async () => {
      if (io.idbDown) throw new Error('down');
      return io.autosave ? structuredClone(io.autosave) : null;
    },
    idbMove: async (b) => {
      if (io.idbDown) throw new Error('down');
      table.set(b.id, structuredClone(b));
      io.autosave = null;
    },
    idbPut: async (b) => {
      if (io.idbDown) throw new Error('down');
      table.set(b.id, structuredClone(b));
    },
    idbList: async () => {
      if (io.idbDown) throw new Error('down');
      return [...table.values()].map((b) => structuredClone(b));
    },
    idbRemove: async (id) => {
      if (io.idbDown) throw new Error('down');
      table.delete(id);
    },
    local: () => ({
      get length() {
        return storage.size;
      },
      key: (k: number) => [...storage.keys()][k] ?? null,
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        let used = v.length;
        for (const [key, val] of storage) if (key !== k) used += val.length;
        if (used > io.quota) throw new Error('QuotaExceededError');
        storage.set(k, v);
      },
      removeItem: (k: string) => void storage.delete(k),
    }),
  };
  return io;
}

// ---------- 浏览器里的 ----------

interface AutosaveMeta extends AutosaveInfo {
  [k: string]: unknown;
}

export const browserBackupIo: BackupIo = {
  async idbAutosave() {
    const db = await openDb();
    try {
      const tx = db.transaction(['kv', 'autosave'], 'readonly');
      const get = <T>(req: IDBRequest) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result as T)), (req.onerror = () => reject(req.error))));
      const meta = await get<AutosaveMeta | undefined>(tx.objectStore('kv').get('autosave'));
      if (!meta || !(meta.count > 0)) return null;
      const commands = await get<unknown[]>(tx.objectStore('autosave').getAll(IDBKeyRange.bound(0, meta.count - 1)));
      const { info, head } = splitHead(meta);
      const { mapSynced: _, ...rest } = info;
      return { ...rest, doc: { ...head, commands } };
    } finally {
      db.close();
    }
  },
  idbMove: (b) =>
    idbTx(['backups', 'kv', 'autosave'], 'readwrite', (backups, kv, autosave) => {
      backups.put(b, b.id);
      kv.delete('autosave');
      autosave.clear();
    }),
  idbPut: (b) => idbTx(['backups'], 'readwrite', (s) => s.put(b, b.id)),
  idbList: () => idbAll<WorldBackup>('backups'),
  idbRemove: (id) => idbTx(['backups'], 'readwrite', (s) => s.delete(id)),
  local: () => localStorage,
};
