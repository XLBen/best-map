// 测试用的假 IndexedDB（第九十一轮写在 state/autosave-backups.test.ts 里，第九十四轮原样搬出来几个测试共用）：
// 表都在内存里（data），事务里的请求按微任务回调、都回完了事务才算提交。
// 第九十四轮加的：delete 认一段范围（IDBKeyRange.bound 的替身 {lo, hi}）；事务的 commit()（什么都不用做）、abort()；
// quota 为 true 时写的事务不提交、按“存储满了”失败（表里的东西不变）
//   vi.stubGlobal('indexedDB', idb); vi.stubGlobal('IDBKeyRange', { bound: (lo, hi) => ({ lo, hi }) });

export type Data = Map<string, Map<IDBValidKey, unknown>>;
class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}
type Range = { lo: number; hi: number };
const isRange = (k: unknown): k is Range => k !== null && typeof k === 'object' && 'lo' in k && 'hi' in k;
class FakeTx {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  private open = 0;
  private dead = false;
  // 这个事务写过东西；写之前各表的样子（失败、中止时退回）
  private wrote = false;
  private before: Data | null = null;
  constructor(
    private data: Data,
    private owner: { quota: boolean },
  ) {
    setTimeout(() => this.maybeDone(), 0);
  }
  private rollback(error: unknown) {
    if (this.dead) return;
    this.dead = true;
    if (this.before) for (const [name, rows] of this.before) this.data.set(name, rows);
    this.error = error;
    const f = this.onabort ?? this.onerror;
    this.oncomplete = null;
    f?.();
  }
  private maybeDone() {
    if (this.dead || this.open !== 0) return;
    // 存储满了：写的事务提交不了
    if (this.wrote && this.owner.quota) return this.rollback(Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }));
    // 提交了：之后再到的计时器不算（只读、没人等着提交的事务还能接着发请求）
    if (this.wrote || this.oncomplete) this.dead = true;
    if (this.oncomplete) {
      const f = this.oncomplete;
      this.oncomplete = null;
      f();
    }
  }
  private req(run: () => unknown): FakeRequest {
    const r = new FakeRequest();
    this.open++;
    queueMicrotask(() => {
      if (!this.dead) {
        r.result = run();
        r.onsuccess?.();
      }
      this.open--;
      setTimeout(() => this.maybeDone(), 0);
    });
    return r;
  }
  private write(run: () => void): FakeRequest {
    return this.req(() => {
      if (!this.before) this.before = new Map([...this.data].map(([name, rows]) => [name, new Map(rows)]));
      this.wrote = true;
      run();
    });
  }
  commit() {}
  abort() {
    this.rollback(null);
  }
  objectStore(name: string) {
    if (!this.data.has(name)) throw new Error(`没有表 ${name}`);
    // 每次现取：中止时整张表换回原来的那一份
    const s = () => this.data.get(name)!;
    const inRange = (k: IDBValidKey, range?: Range) => !range || (typeof k === 'number' && k >= range.lo && k <= range.hi);
    return {
      get: (k: IDBValidKey) => this.req(() => structuredClone(s().get(k))),
      put: (v: unknown, k: IDBValidKey) => this.write(() => void s().set(k, structuredClone(v))),
      delete: (k: IDBValidKey | Range) =>
        this.write(() => {
          if (isRange(k)) {
            for (const key of [...s().keys()]) if (inRange(key, k)) s().delete(key);
          } else s().delete(k);
        }),
      clear: () => this.write(() => void s().clear()),
      getAll: (range?: Range) =>
        this.req(() =>
          [...s().entries()]
            .filter(([k]) => inRange(k, range))
            .sort((a, b) => (typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : 0))
            .map(([, v]) => structuredClone(v)),
        ),
    };
  }
}
export class FakeIDB {
  data: Data = new Map();
  version = 0;
  created: string[] = [];
  // 存储满了：写的事务都失败
  quota = false;
  open(_name: string, version: number) {
    const r = new FakeRequest();
    setTimeout(() => {
      r.result = {
        objectStoreNames: { contains: (n: string) => this.data.has(n) },
        createObjectStore: (n: string) => {
          this.created.push(n);
          this.data.set(n, new Map());
        },
        transaction: () => new FakeTx(this.data, this),
        close: () => {},
      };
      if (version > this.version) {
        this.version = version;
        r.onupgradeneeded?.();
      }
      r.onsuccess?.();
    }, 0);
    return r;
  }
}

