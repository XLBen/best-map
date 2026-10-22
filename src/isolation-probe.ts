// 计算 Worker 一开起来先自查：是不是真的在隔离的环境里。三项全部通过才算隔离，有一项说不准就不算
// （界面上“读不到你保存的其他世界，也不能联网”这句话要说得老实）：
//   1. 来源是 null：data: 地址开的 Worker 是不透明的来源，与页面不同源；
//   2. IndexedDB 打不开：读不到这个浏览器里保存的世界（同源的 Worker 能打开）；
//   3. fetch('data:…') 被拒：页面的 CSP 管到了这个 Worker（connect-src 只许同源，连 data: 都不许，更连不了别的网站）。
//      不联网也能查：data: 地址不走网络。
// 结果随第一条消息（hello）告诉主线程。脚本在自查完、招呼发出之后才可能运行，伪造不了这一条。
// 整个程序里只有这里碰 IndexedDB 的名字（隔离的 Worker 里不读写存档，检查点交给存储 Worker），见 isolation.test.ts

// 每一项最多等多久（毫秒）：到时还没有结果算“没证明”（不算隔离）
export const PROBE_MS = 1500;

const PROBE_DB = 'map2-isolation-probe';

const after = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));

// 读全局上的东西：有的浏览器在不允许的环境里一读就抛错，那也算“用不了”
function read(scope: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (scope as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

// IndexedDB 打不开（没有、一打开就抛错、报错）为 true；打开了（并删掉试的库）或等不到结果为 false
export function idbBlocked(scope: object, ms = PROBE_MS): Promise<boolean> {
  const got = read(scope, 'indexedDB');
  if (!got.ok || got.value === undefined || got.value === null) return Promise.resolve(true);
  const idb = got.value as IDBFactory;
  let req: IDBOpenDBRequest;
  try {
    req = idb.open(PROBE_DB);
  } catch {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    req.onerror = (ev) => {
      clearTimeout(timer);
      // 不让这个错误再报到控制台
      ev?.preventDefault?.();
      resolve(true);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      try {
        req.result.close();
        idb.deleteDatabase(PROBE_DB);
      } catch {
        // 删不掉也无妨：只是一个空库
      }
      resolve(false);
    };
  });
}

// fetch('data:…') 被拒（异步地失败）为 true。一调用就抛错、拿到了回复、等不到结果都不算（不能说明是 CSP 挡的）
export async function fetchBlocked(scope: object, ms = PROBE_MS): Promise<boolean> {
  const got = read(scope, 'fetch');
  if (!got.ok || typeof got.value !== 'function') return false;
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve((got.value as (url: string) => Promise<unknown>).call(scope, 'data:text/plain,x'));
  } catch {
    return false;
  }
  try {
    await Promise.race([pending, after(ms)]);
    return false;
  } catch {
    return true;
  }
}

export async function probeIsolation(scope: object, ms = PROBE_MS): Promise<boolean> {
  const origin = read(scope, 'origin');
  // 同源的 Worker（退回普通 Worker 时）不必再查后两项
  if (!origin.ok || origin.value !== 'null') return false;
  const [idb, net] = await Promise.all([idbBlocked(scope, ms), fetchBlocked(scope, ms)]);
  return idb && net;
}
