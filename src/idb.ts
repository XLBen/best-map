// 浏览器里的存储（IndexedDB），主线程与 Worker 共用同一个库：
//   kv：参考图、自动保存的设置与条数；autosave：自动保存的每一条命令（按序号）；
//   checkpoint：引擎的检查点（打开上次的世界时直接恢复，不必重放）
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('map2', 3);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of ['kv', 'autosave', 'checkpoint']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
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
