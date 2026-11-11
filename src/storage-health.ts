// 浏览器的存储靠不靠得住（第九十四轮）。
// 作品只存在浏览器里：存储没有“持久”的许可时，浏览器空间紧了可以不问就清掉这个网站的全部数据。
// 第一次自动保存成功之后申请一次 navigator.storage.persist()（结果记下来，不每次都申请）；
// 用掉九成以上时提醒一次。这里是规则，不碰界面；浏览器的接口都可以没有（没有就跳过）

export const PERSIST_KEY = 'map2.persist';
// 没给许可的：过这么久再申请一次（Chrome 按用得多不多自己决定，不弹窗；以后可能就给了）
export const PERSIST_RETRY_MS = 30 * 24 * 3600 * 1000;
// 用掉多少算快满了
export const NEARLY_FULL = 0.9;

export interface PersistNote {
  granted: boolean;
  at: number;
}

export interface StorageLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}
type LocalLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readPersistNote(local: LocalLike | null): PersistNote | null {
  try {
    const n = JSON.parse(local?.getItem(PERSIST_KEY) ?? 'null') as PersistNote | null;
    return n && typeof n.granted === 'boolean' && typeof n.at === 'number' ? n : null;
  } catch {
    return null;
  }
}

// 要不要申请：没申请过；或者上次没给、已经过了很久
export function shouldAskPersist(note: PersistNote | null, now: number): boolean {
  if (!note) return true;
  return !note.granted && now - note.at >= PERSIST_RETRY_MS;
}

// 申请一次并记下结果。返回给没给；没有这个接口、这一次不用申请时 null
export async function askPersist(storage: StorageLike | undefined, local: LocalLike | null, now = Date.now()): Promise<boolean | null> {
  if (!storage?.persist || !shouldAskPersist(readPersistNote(local), now)) return null;
  let granted = false;
  try {
    granted = (await storage.persisted?.()) === true || (await storage.persist()) === true;
  } catch {
    return null;
  }
  try {
    local?.setItem(PERSIST_KEY, JSON.stringify({ granted, at: now } satisfies PersistNote));
  } catch {
    // 记不下来：下次打开页面再申请一次
  }
  return granted;
}

// 用掉九成以上
export function nearlyFull(est: { usage?: number; quota?: number } | null | undefined): boolean {
  if (!est || typeof est.usage !== 'number' || typeof est.quota !== 'number' || !(est.quota > 0)) return false;
  return est.usage / est.quota >= NEARLY_FULL;
}

export async function storageNearlyFull(storage: StorageLike | undefined): Promise<boolean> {
  if (!storage?.estimate) return false;
  try {
    return nearlyFull(await storage.estimate());
  } catch {
    return false;
  }
}
