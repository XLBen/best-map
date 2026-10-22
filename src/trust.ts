import { FANTASY_BIOMES } from '../core/packs/fantasy-biomes';
import { type FoundScript, findScripts } from '../core/script';
import { kvDelete, kvGet, kvPut } from './idb';

// 信任的脚本（第三批）：按脚本源码的哈希记在这个浏览器里（kv 'trustedScripts'）。
// 打开世界文件、读自动保存（连同检查点）、新建都经过 state.ts 的 loadDoc / newWorld，在那里统一检查：
// 有没见过的脚本就先问。自己写的脚本提交时自动记为信任；内置的示例包（以后还有资源库里的）总是信任。
// 整理时当前世界里的都留着，别的只留最近用过的 100 个（脚本编辑器每次停顿都提交一次，中间的版本不会越积越多）

const KEY = 'trustedScripts';
const KEEP_OTHERS = 100;

interface Entry {
  hash: string;
  // 最近一次信任、用到的时间
  at: number;
}

// 读进来的信任列表（哈希 → 时间）；IndexedDB 用不了时只在这次打开里记
let cache: Map<string, number> | null = null;
let last = 0;
const stamp = () => (last = Math.max(last + 1, Date.now()));

// 总是信任的脚本：内置的示例生态；资源库（另一批）在这里登记自己的
const sources: (() => Iterable<string>)[] = [() => findScripts(FANTASY_BIOMES).map((s) => s.hash)];
export function addTrustedSource(f: () => Iterable<string>): void {
  sources.push(f);
}
function always(): Set<string> {
  const out = new Set<string>();
  for (const f of sources) for (const h of f()) out.add(h);
  return out;
}

async function load(): Promise<Map<string, number>> {
  if (cache) return cache;
  let list: Entry[] | undefined;
  try {
    list = await kvGet<Entry[]>(KEY);
  } catch {
    // 读不了：从空的开始
  }
  if (!cache) cache = new Map((Array.isArray(list) ? list : []).filter((e) => e && typeof e.hash === 'string').map((e) => [e.hash, Number(e.at) || 0]));
  return cache;
}

async function save() {
  if (!cache) return;
  try {
    await kvPut(
      KEY,
      [...cache].map(([hash, at]) => ({ hash, at })),
    );
  } catch {
    // 存不了就只在这次打开里有效
  }
}

// 忘掉读进来的列表（测试用）
export function forgetTrustCache(): void {
  cache = null;
}

// json（世界文件、一组命令、导入的生态……）里还没信任过的脚本；同一段只列一次
export async function untrustedScripts(json: unknown, found: FoundScript[] = findScripts(json)): Promise<FoundScript[]> {
  if (!found.length) return [];
  const t = await load();
  const ok = always();
  const seen = new Set<string>();
  return found.filter((s) => {
    if (t.has(s.hash) || ok.has(s.hash) || seen.has(s.hash)) return false;
    seen.add(s.hash);
    return true;
  });
}

export async function trustScripts(hashes: Iterable<string>): Promise<void> {
  const t = await load();
  let any = false;
  for (const h of hashes) {
    t.set(h, stamp());
    any = true;
  }
  if (any) await save();
}

// 整理：current（当前世界里的脚本）都留着、刷新时间；别的只留最近的 100 个
export async function tidyTrusted(current: Iterable<string>): Promise<void> {
  const t = await load();
  const keep = new Set(current);
  const now = stamp();
  for (const h of keep) if (t.has(h)) t.set(h, now);
  const others = [...t].filter(([h]) => !keep.has(h)).sort((a, b) => b[1] - a[1]);
  if (others.length <= KEEP_OTHERS && !keep.size) return;
  for (const [h] of others.slice(KEEP_OTHERS)) t.delete(h);
  await save();
}

// ---------- 打开带脚本的世界时的标记 ----------
// 正常打开带脚本的世界之前记下（脚本的哈希），打开完（成功或出错）去掉。下次启动时标记还在，说明上次打开时
// 整个页面停止了响应（比如脚本占满了内存，看门狗管不了）：先问要不要用安全模式打开

const LOADING = 'loadingScripts';

export interface LoadingMark {
  at: number;
  hashes: string[];
}

export async function markLoading(hashes: string[]): Promise<void> {
  try {
    await kvPut(LOADING, { at: Date.now(), hashes } satisfies LoadingMark);
  } catch {
    // 记不了就不记
  }
}

export async function clearLoading(): Promise<void> {
  try {
    await kvDelete(LOADING);
  } catch {
    // 同上
  }
}

export async function readLoading(): Promise<LoadingMark | null> {
  try {
    const v = await kvGet<LoadingMark>(LOADING);
    return v && Array.isArray(v.hashes) ? v : null;
  } catch {
    return null;
  }
}
