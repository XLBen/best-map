import { describe, expect, it } from 'vitest';
import { PERSIST_KEY, PERSIST_RETRY_MS, askPersist, nearlyFull, readPersistNote, shouldAskPersist, storageNearlyFull } from './storage-health';

// 第九十四轮：申请“持久”的存储只申请一次（结果记下来）；用掉九成以上才算快满了

function local() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('申请持久的存储', () => {
  it('没申请过才申请；给了就再也不申请；没给的过很久再申请一次', () => {
    expect(shouldAskPersist(null, 1000)).toBe(true);
    expect(shouldAskPersist({ granted: true, at: 0 }, PERSIST_RETRY_MS * 10)).toBe(false);
    expect(shouldAskPersist({ granted: false, at: 1000 }, 2000)).toBe(false);
    expect(shouldAskPersist({ granted: false, at: 1000 }, 1000 + PERSIST_RETRY_MS)).toBe(true);
  });

  it('申请一次、记下结果；下一次打开页面不再申请', async () => {
    const l = local();
    let asked = 0;
    const storage = { persist: async () => (asked++, true) };
    expect(await askPersist(storage, l, 5000)).toBe(true);
    expect(readPersistNote(l)).toEqual({ granted: true, at: 5000 });
    expect(await askPersist(storage, l, 6000)).toBeNull();
    expect(asked).toBe(1);
  });

  it('已经是持久的：不用再申请，记下', async () => {
    const l = local();
    let asked = 0;
    expect(await askPersist({ persisted: async () => true, persist: async () => (asked++, false) }, l, 1)).toBe(true);
    expect(asked).toBe(0);
    expect(readPersistNote(l)!.granted).toBe(true);
  });

  it('没给：记下，过很久才再申请', async () => {
    const l = local();
    let asked = 0;
    const storage = { persist: async () => (asked++, false) };
    expect(await askPersist(storage, l, 0)).toBe(false);
    expect(await askPersist(storage, l, 1000)).toBeNull();
    expect(await askPersist(storage, l, PERSIST_RETRY_MS + 1)).toBe(false);
    expect(asked).toBe(2);
  });

  it('没有这个接口、接口抛错、记不下来：都不报错', async () => {
    expect(await askPersist(undefined, local())).toBeNull();
    expect(await askPersist({}, local())).toBeNull();
    const l = local();
    expect(
      await askPersist(
        {
          persist: async () => {
            throw new Error('不让');
          },
        },
        l,
      ),
    ).toBeNull();
    expect(l.m.has(PERSIST_KEY)).toBe(false);
    expect(await askPersist({ persist: async () => true }, null)).toBe(true);
    l.m.set(PERSIST_KEY, '坏了');
    expect(readPersistNote(l)).toBeNull();
  });
});

describe('存储快满了', () => {
  it('用掉九成以上才算；不知道用了多少时不算', async () => {
    expect(nearlyFull({ usage: 89, quota: 100 })).toBe(false);
    expect(nearlyFull({ usage: 90, quota: 100 })).toBe(true);
    expect(nearlyFull({ usage: 100, quota: 100 })).toBe(true);
    expect(nearlyFull({ usage: 5 })).toBe(false);
    expect(nearlyFull({ usage: 5, quota: 0 })).toBe(false);
    expect(nearlyFull(null)).toBe(false);
    expect(await storageNearlyFull({ estimate: async () => ({ usage: 95, quota: 100 }) })).toBe(true);
    expect(await storageNearlyFull({ estimate: async () => ({ usage: 1, quota: 100 }) })).toBe(false);
    expect(await storageNearlyFull({})).toBe(false);
    expect(await storageNearlyFull(undefined)).toBe(false);
    expect(
      await storageNearlyFull({
        estimate: async () => {
          throw new Error('不让');
        },
      }),
    ).toBe(false);
  });
});
