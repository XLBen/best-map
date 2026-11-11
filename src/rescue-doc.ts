// 自救页的“导出文件”从哪里拿世界（第九十六轮）。页面出了问题时不能指望出问题的那部分：这里不用计算 Worker、不用资源库、
// 不用界面的状态，也不引用 autosave-io.ts / backups.ts（它们连着信号、锁），只认存储里那几样东西的形状——
// 自己从 IndexedDB 的自动保存（kv 的 'autosave' 是头，autosave 表里按序号是每一条命令）和 localStorage 的后备里读，拼成世界文件的字。
// 形状变了这里要跟着改：rescue-doc.test.ts 拿真的写入（AutosaveWriter）写下的东西来读，对不上就不过。
//
// 两个来源：
//   live  —— 页面里现在的世界（主线程手上的命令记录，main.tsx 接上；最新，连没来得及自动保存的最后几步都在）；
//   saved —— 浏览器里存着的那一份（页面的程序没起来、还没打开世界时只有它）

export interface SavedWorld {
  // 世界文件的字（和“导出文件”得到的是同一种 JSON）
  text: string;
  savedAt: number;
  steps: number;
  // 头里写的条数和读出来的对得上（对不上：没存完整，导出的是存下的那一部分）
  whole: boolean;
}

const DB = 'map2';
const LOCAL_KEY = 'map2.autosave';

interface Head {
  savedAt?: unknown;
  count?: unknown;
  format?: unknown;
  version?: unknown;
  settings?: unknown;
}

const once = <T>(req: IDBRequest): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('读不了'));
  });

// 打开已有的库，不升级、不新建（没有这个库时不留下一个空的：中止那一次“新建”）
function openExisting(idb: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let fresh = false;
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      fresh = true;
      try {
        req.transaction?.abort();
      } catch {
        // 中止不了也无妨：下面照样当没有
      }
    };
    req.onerror = (ev) => {
      (ev as Event | undefined)?.preventDefault?.();
      resolve(null);
    };
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (fresh) {
        db.close();
        resolve(null);
      } else resolve(db);
    };
  });
}

async function fromIdb(idb: IDBFactory | undefined): Promise<SavedWorld | null> {
  if (!idb) return null;
  const db = await openExisting(idb);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains('kv') || !db.objectStoreNames.contains('autosave')) return null;
    const tx = db.transaction(['kv', 'autosave'], 'readonly');
    const head = await once<Head | undefined>(tx.objectStore('kv').get('autosave'));
    if (!head || typeof head.count !== 'number' || head.count <= 0 || head.format !== 'map2-world') return null;
    // 条数以内的那几条（表里更后面的是以前的世界剩下的，不算）
    const all = await once<unknown[]>(tx.objectStore('autosave').getAll(IDBKeyRange.bound(0, head.count - 1)));
    const commands = all.filter((c) => c !== null && typeof c === 'object');
    const doc = { format: head.format, version: head.version, settings: head.settings, commands };
    return { text: JSON.stringify(doc), savedAt: typeof head.savedAt === 'number' ? head.savedAt : 0, steps: commands.length, whole: commands.length === head.count && all.length === head.count };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // 关不了就算了
    }
  }
}

function fromLocal(local: Pick<Storage, 'getItem'> | null): SavedWorld | null {
  try {
    const raw = local?.getItem(LOCAL_KEY);
    const old = raw ? (JSON.parse(raw) as { savedAt?: unknown; doc?: { format?: unknown; commands?: unknown } }) : null;
    const doc = old?.doc;
    if (!doc || doc.format !== 'map2-world' || !Array.isArray(doc.commands)) return null;
    return { text: JSON.stringify(doc), savedAt: typeof old.savedAt === 'number' ? old.savedAt : 0, steps: doc.commands.length, whole: true };
  } catch {
    return null;
  }
}

// 浏览器里存着的那一份：IndexedDB 和 localStorage（IndexedDB 用不了时的后备）里较新的。都没有、读不了时 null
export async function readSavedWorld(idb: IDBFactory | undefined, local: Pick<Storage, 'getItem'> | null): Promise<SavedWorld | null> {
  let a: SavedWorld | null = null;
  try {
    a = await fromIdb(idb);
  } catch {
    a = null;
  }
  const b = fromLocal(local);
  if (a && b) return b.savedAt > a.savedAt ? b : a;
  return a ?? b;
}

// ---------- 导出 ----------

export interface RescueIo {
  // 页面里现在的世界（没有、拿不到时 null）
  live?: (() => string | null) | null;
  saved(): Promise<SavedWorld | null>;
  download(name: string, text: string): void;
  now(): number;
}

// 文件名：“世界 2026-11-11 1405.json”
export function rescueFileName(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `世界 ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}.json`;
}

// 是世界文件的字（拿到的东西出了问题时不把半截的字当文件给出去）
function looksLikeWorld(text: string | null | undefined): text is string {
  return typeof text === 'string' && text.length > 20 && text.startsWith('{') && text.includes('"map2-world"');
}

export type RescueExport = { ok: true; from: 'live' | 'saved'; name: string; whole: boolean; savedAt: number } | { ok: false };

// 导出：先用页面里现在的（最新），拿不到用浏览器里存着的。哪一步出错都不抛（这是出了问题以后的最后一条路）
export async function rescueExport(io: RescueIo): Promise<RescueExport> {
  let live: string | null = null;
  try {
    live = io.live?.() ?? null;
  } catch {
    live = null;
  }
  const now = io.now();
  if (looksLikeWorld(live)) {
    const name = rescueFileName(now);
    try {
      io.download(name, live);
      return { ok: true, from: 'live', name, whole: true, savedAt: now };
    } catch {
      // 下面试存着的那一份
    }
  }
  let saved: SavedWorld | null = null;
  try {
    saved = await io.saved();
  } catch {
    saved = null;
  }
  if (!saved || !looksLikeWorld(saved.text)) return { ok: false };
  const name = rescueFileName(saved.savedAt || now);
  try {
    io.download(name, saved.text);
  } catch {
    return { ok: false };
  }
  return { ok: true, from: 'saved', name, whole: saved.whole, savedAt: saved.savedAt };
}
