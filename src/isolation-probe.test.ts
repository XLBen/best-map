import { describe, expect, it } from 'vitest';
import { fetchBlocked, idbBlocked, probeIsolation } from './isolation-probe';

// 计算 Worker 的自查：来源为 null、IndexedDB 打不开、fetch('data:…') 被拒，三项全部通过才算隔离；
// 说不准（等不到结果、一调用就抛错、拿到了回复）都不算。这里的全局对象是假的

type Outcome = 'throw' | 'error' | 'success' | 'hang';

// 假的 IndexedDB：open 的结果按 outcome；记下打开、删掉了哪些库
function fakeIdb(outcome: Outcome) {
  const log: string[] = [];
  return {
    log,
    open(name: string) {
      log.push(`open ${name}`);
      if (outcome === 'throw') throw new DOMException('access to the Indexed Database API is denied', 'SecurityError');
      const req: { onerror: ((ev: Event) => void) | null; onsuccess: (() => void) | null; result: { close(): void } } = {
        onerror: null,
        onsuccess: null,
        result: { close: () => log.push('close') },
      };
      if (outcome === 'error') setTimeout(() => req.onerror?.(new Event('error')), 0);
      if (outcome === 'success') setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
    deleteDatabase(name: string) {
      log.push(`delete ${name}`);
    },
  };
}

const rejecting = () => Promise.reject(new TypeError('Failed to fetch'));
const resolving = () => Promise.resolve({ ok: true });

function scope(o: { origin?: string; idb?: Outcome | 'none'; fetch?: 'reject' | 'resolve' | 'throw' | 'hang' | 'none' } = {}) {
  const idb = o.idb === 'none' ? undefined : fakeIdb(o.idb ?? 'throw');
  const fetches: string[] = [];
  const f = o.fetch ?? 'reject';
  const s: Record<string, unknown> = {
    origin: o.origin ?? 'null',
    indexedDB: idb,
    fetch:
      f === 'none'
        ? undefined
        : function (this: unknown, url: string) {
            // 要以全局对象为 this 调用（浏览器里脱离了全局对象调用会抛错）
            if (this !== s) throw new TypeError('Illegal invocation');
            fetches.push(url);
            if (f === 'throw') throw new TypeError('同步抛错');
            if (f === 'hang') return new Promise(() => undefined);
            return f === 'reject' ? rejecting() : resolving();
          },
  };
  return { s, idb, fetches };
}

describe('隔离的自查', () => {
  it('三项全部通过才算隔离', async () => {
    const t = scope();
    expect(await probeIsolation(t.s, 50)).toBe(true);
    expect(t.fetches).toEqual(['data:text/plain,x']);
    // IndexedDB 一打开就报错也算打不开
    expect(await probeIsolation(scope({ idb: 'error' }).s, 50)).toBe(true);
    // 根本没有 IndexedDB
    expect(await probeIsolation(scope({ idb: 'none' }).s, 50)).toBe(true);
  });

  it('来源不是 null（同源的普通 Worker）：不算，也不去碰 IndexedDB 和 fetch', async () => {
    const t = scope({ origin: 'http://localhost:5191', idb: 'success', fetch: 'resolve' });
    expect(await probeIsolation(t.s, 50)).toBe(false);
    expect(t.idb!.log).toEqual([]);
    expect(t.fetches).toEqual([]);
  });

  it('IndexedDB 打开了：不算（试的库关掉、删掉）；等不到结果也不算', async () => {
    const opened = scope({ idb: 'success' });
    expect(await probeIsolation(opened.s, 50)).toBe(false);
    expect(opened.idb!.log).toEqual(['open map2-isolation-probe', 'close', 'delete map2-isolation-probe']);
    expect(await idbBlocked(scope({ idb: 'hang' }).s, 20)).toBe(false);
    expect(await idbBlocked(scope({ idb: 'throw' }).s, 20)).toBe(true);
  });

  it('fetch(data:) 拿到了回复、一调用就抛错、等不到结果、没有 fetch：都不算（不能说明是 CSP 挡的）', async () => {
    for (const fetch of ['resolve', 'throw', 'hang', 'none'] as const) {
      expect(await fetchBlocked(scope({ fetch }).s, 20), fetch).toBe(false);
      expect(await probeIsolation(scope({ fetch }).s, 20), fetch).toBe(false);
    }
    expect(await fetchBlocked(scope({ fetch: 'reject' }).s, 20)).toBe(true);
  });

  it('一读就抛错的全局（不允许的环境）：来源读不了不算隔离；IndexedDB 读不了算打不开', async () => {
    const t = scope();
    Object.defineProperty(t.s, 'indexedDB', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(await probeIsolation(t.s, 50)).toBe(true);
    Object.defineProperty(t.s, 'origin', {
      get() {
        throw new Error('x');
      },
    });
    expect(await probeIsolation(t.s, 50)).toBe(false);
  });
});
