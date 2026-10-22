// 浏览器里的存储（IndexedDB），主线程与 Worker 共用同一个库：
//   kv：参考图、自动保存的设置与条数、信任的脚本（trustedScripts）；autosave：自动保存的每一条命令（按序号）；
//   checkpoint：引擎的检查点（打开上次的世界时直接恢复，不必重放）；
//   packs：资源库里的资源包（第 4 版加的，按资源包的 id 存 {key, pack, installedAt, mine?}）
// 升级只补上没有的表，已有的表和里面的数据都不动（从第 3 版升上来，自动保存、检查点照旧在）
export const DB_VERSION = 4;
export const DB_STORES = ['kv', 'autosave', 'checkpoint', 'packs'] as const;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('map2', DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of DB_STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}

// 一个事务里做几件事，整个事务提交后才算成功
export function idbTx(stores: string[], mode: IDBTransactionMode, run: (...s: IDBObjectStore[]) => void): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        run(...stores.map((s) => tx.objectStore(s)));
        tx.oncomplete = () => {
          resolve();
          db.close();
        };
        tx.onerror = tx.onabort = () => {
          reject(tx.error);
          db.close();
        };
      }),
  );
}

// kv 表里的一项（信任的脚本、打开带脚本的世界时的标记……）。读不了、写不了时抛错，调用方自己决定怎么退
export function kvGet<T>(key: string): Promise<T | undefined> {
  return idbGet<T>('kv', key);
}

export function kvPut(key: string, value: unknown): Promise<void> {
  return idbTx(['kv'], 'readwrite', (s) => s.put(value, key));
}

export function kvDelete(key: string): Promise<void> {
  return idbTx(['kv'], 'readwrite', (s) => s.delete(key));
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => {
          resolve(req.result as T | undefined);
          db.close();
        };
        req.onerror = () => {
          reject(req.error);
          db.close();
        };
      }),
  );
}

// 一张表里的全部值
export function idbAll<T>(store: string): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => {
          resolve(req.result as T[]);
          db.close();
        };
        req.onerror = () => {
          reject(req.error);
          db.close();
        };
      }),
  );
}
