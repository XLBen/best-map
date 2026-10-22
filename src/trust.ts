import { FANTASY_BIOMES } from '../core/packs/fantasy-biomes';
import { FANTASY_FORMS } from '../core/packs/fantasy-forms';
import { type FoundScript, findScripts } from '../core/script';
import { kvDelete, kvGet, kvPut } from './idb';

// 信任的脚本（第三批）：按脚本源码的 SHA-256 记在这个浏览器里（kv 'trustedScripts'）。
// 打开世界文件、读自动保存（连同检查点）、新建都经过 state.ts 的 loadDoc / newWorld，在那里统一检查：
// 有没见过的脚本就先问。自己写的脚本提交时自动记为信任；内置的示例（以后还有资源库里的）总是信任。
// 整理时当前世界里的都留着，别的只留最近用过的 100 个（脚本编辑器每次停顿都提交一次，中间的版本不会越积越多）。
//
// 不用 findScripts 给的 16 位短哈希（scriptHash）：它不是密码学哈希，每加一个字节的变化都能倒推，
// 别人可以专门凑出一段与内置示例短哈希相同的脚本，不问就运行了。同样，列给用户看的脚本按源码去重，不按短哈希。
// 浏览器不给 SHA-256 时（页面既不是 https 也不是本机打开的）直接用源码本身当键

const KEY = 'trustedScripts';
const KEEP_OTHERS = 100;

interface Entry {
  // 源码的键（见 keyOf）
  hash: string;
  // 最近一次信任、用到的时间
  at: number;
}

// 读进来的信任列表（键 → 时间）；IndexedDB 用不了时只在这次打开里记
let cache: Map<string, number> | null = null;
let last = 0;
const stamp = () => (last = Math.max(last + 1, Date.now()));

// 源码 → 键（算过的记下，最多 512 段）
const keys = new Map<string, string>();
async function keyOf(src: string): Promise<string> {
  const hit = keys.get(src);
  if (hit) return hit;
  const subtle = globalThis.crypto?.subtle;
  let key: string;
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(src)));
    key = 'sha256:' + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  } else key = `src:${src}`;
  keys.set(src, key);
  if (keys.size > 512) keys.delete(keys.keys().next().value!);
  return key;
}

// 同一段源码只算一次（列给用户看、记进信任列表时）
export function uniqueScripts(list: readonly FoundScript[]): FoundScript[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    if (seen.has(s.src)) return false;
    seen.add(s.src);
    return true;
  });
}

// 总是信任的脚本：内置的示例生态、星球形态；资源库（另一批）在这里登记自己的：f 返回任意 JSON
// （资源包、生态列表……），里面的脚本都算
const sources: (() => unknown)[] = [() => FANTASY_BIOMES, () => FANTASY_FORMS];
export function addTrustedSource(f: () => unknown): void {
  sources.push(f);
}
async function always(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of sources) for (const s of findScripts(f())) out.add(await keyOf(s.src));
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
export async function untrustedScripts(json: unknown, found: readonly FoundScript[] = findScripts(json)): Promise<FoundScript[]> {
  if (!found.length) return [];
  const t = await load();
  const ok = await always();
  const out: FoundScript[] = [];
  for (const s of uniqueScripts(found)) {
    const k = await keyOf(s.src);
    if (!t.has(k) && !ok.has(k)) out.push(s);
  }
  return out;
}

export async function trustScripts(scripts: Iterable<{ src: string }>): Promise<void> {
  const t = await load();
  let any = false;
  for (const s of scripts) {
    t.set(await keyOf(s.src), stamp());
    any = true;
  }
  if (any) await save();
}

// 整理：current（当前世界里的脚本）都留着、刷新时间；别的只留最近的 100 个
export async function tidyTrusted(current: Iterable<{ src: string }>): Promise<void> {
  const t = await load();
  const keep = new Set<string>();
  for (const s of current) keep.add(await keyOf(s.src));
  const now = stamp();
  for (const k of keep) if (t.has(k)) t.set(k, now);
  const others = [...t].filter(([k]) => !keep.has(k)).sort((a, b) => b[1] - a[1]);
  if (others.length <= KEEP_OTHERS && !keep.size) return;
  for (const [k] of others.slice(KEEP_OTHERS)) t.delete(k);
  await save();
}

// ---------- 打开带脚本的世界时的标记 ----------
// 正常打开带脚本的世界之前记下（脚本的短哈希：只用来认出是不是同一个世界，问错了也只是多问一句），
// 打开完（成功或出错）去掉。下次启动时标记还在，说明上次打开时整个页面停止了响应（比如脚本占满了内存，
// 看门狗管不了）：先问要不要用安全模式打开

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
