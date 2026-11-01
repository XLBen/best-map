// 资源库记着的样子（第四十五轮）：上次看的种类、展开的包、收起的两段（本世界、资源库），关上再打开、刷新页面后照旧。
// 只是方便，存在浏览器的 localStorage：隐私模式、存储被关时读写会抛错或读回空的，这时照默认的样子用，不报错

export interface RepoPrefs {
  // 种类（登记表里的 id，或 'all'）
  kind: string;
  // 展开着的包（树的节点的键）
  open: string[];
  // 收起的段：'world'、'library'
  collapsed: string[];
}

export const PREFS_KEY = 'map2.repo';
// 展开的包最多记这么多（太多了没用，也占地方）
const MAX_OPEN = 300;

export const DEFAULT_PREFS: RepoPrefs = { kind: 'all', open: [], collapsed: [] };

// 浏览器的 localStorage（拿不到时 null：有的浏览器连读这个属性都会抛错）
function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);

export function loadRepoPrefs(storage: Storage | null = store()): RepoPrefs {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const v = JSON.parse(raw) as Partial<RepoPrefs>;
    return {
      kind: typeof v.kind === 'string' && v.kind ? v.kind : 'all',
      open: strings(v.open, MAX_OPEN),
      collapsed: strings(v.collapsed, 4),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// 记下改了的几项（别的照旧）。存不进去时 false
export function saveRepoPrefs(patch: Partial<RepoPrefs>, storage: Storage | null = store()): boolean {
  try {
    if (!storage) return false;
    const next = { ...loadRepoPrefs(storage), ...patch };
    next.open = next.open.slice(-MAX_OPEN);
    storage.setItem(PREFS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
