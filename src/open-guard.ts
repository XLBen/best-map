// 启动时打开上次的世界，连着几次没打开成（第九十六轮）：页面崩了、卡住被关掉、被用户停下——再照样自动打开只会再来一遍。
// 每次动手打开之前记一笔，打开成了（并且之后几秒界面没有坏）才擦掉；下次启动时看到连着记了 OPEN_GUARD_ASK 笔还没擦，
// 先问（再试一次 / 用安全模式打开 / 导出文件 / 新建），不直接打开。接在 state/open.ts 的 resumeLast 上，问话就是第九十四轮
// “上次的世界没能打开”的那一个。
// 记在 localStorage：同步写，页面随后就崩也已经记下了（IndexedDB 的写是异步的，来不及）。
// 认的是哪一份自动保存（它保存的时间）：换了一份（别的页面存了新的）就从头数

export const OPEN_GUARD_KEY = 'map2.opening';
// 连着几次没打开成就先问
export const OPEN_GUARD_ASK = 2;
// 打开以后多久没出事才算打开成了（世界一画出来界面就坏的，也算没打开成）
export const OPEN_SETTLE_MS = 5000;

export interface OpenMark {
  // 连着几次动手打开了、没擦掉
  n: number;
  // 那一份自动保存的保存时间
  saved: number;
  // 最近一次动手的时间
  at: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readOpenMark(store: Store | null, saved: number): OpenMark | null {
  try {
    const raw = store?.getItem(OPEN_GUARD_KEY);
    const m = raw ? (JSON.parse(raw) as Partial<OpenMark>) : null;
    if (!m || typeof m.n !== 'number' || !Number.isFinite(m.n) || m.n < 1 || m.saved !== saved) return null;
    return { n: Math.floor(m.n), saved, at: typeof m.at === 'number' ? m.at : 0 };
  } catch {
    return null;
  }
}

// 该不该先问
export function askBeforeOpen(mark: OpenMark | null): boolean {
  return mark !== null && mark.n >= OPEN_GUARD_ASK;
}

// 要动手打开了：记一笔（接着上一笔数）。写不了就不记
export function beginOpen(store: Store | null, saved: number, now: number): void {
  try {
    const n = (readOpenMark(store, saved)?.n ?? 0) + 1;
    store?.setItem(OPEN_GUARD_KEY, JSON.stringify({ n, saved, at: now } satisfies OpenMark));
  } catch {
    // 没有 localStorage、满了
  }
}

// 打开成了、明白地没打开（有原因、问过了；用户取消了）：擦掉
export function endOpen(store: Store | null): void {
  try {
    store?.removeItem(OPEN_GUARD_KEY);
  } catch {
    // 同上
  }
}
