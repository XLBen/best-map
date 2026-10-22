import { signal } from '@preact/signals';
import { type ResourcePack, packScripts, parsePack } from '../core/packs';
import { FANTASY_PACK, FANTASY_PACK_ID } from '../core/packs/fantasy';
import type { FoundScript } from '../core/script';
import { idbAll, idbTx } from './idb';

// 资源库：装好的资源包（IndexedDB 的 packs 表），和信任过的脚本（kv 的 trustedScripts）。
// 内置的示例包总在列表最前面、默认信任，不能删；“我的资源”是从自己的世界里导出、存进来的。
// 删掉资源库里的包不影响已经用过它的世界：世界自带用到的全部内容（都在命令里）。
// 浏览器不让存（隐私模式、存储被关）时照样能用，只是关掉页面就没了

export interface LibraryEntry {
  // 资源库里的键（一般就是资源包的 id）
  key: string;
  pack: ResourcePack;
  builtin: boolean;
  // 自己从世界里导出、存进来的
  mine: boolean;
  installedAt: number;
}

interface Stored {
  key: string;
  pack: ResourcePack;
  installedAt: number;
  mine?: boolean;
}

const BUILTIN: LibraryEntry = { key: FANTASY_PACK_ID, pack: FANTASY_PACK, builtin: true, mine: false, installedAt: 0 };

// 列表：内置的在前，之后是我的资源、导入的（各按装进来的先后）
export const library = signal<LibraryEntry[]>([BUILTIN]);

// 存不进浏览器时留在这里（这一次打开页面期间有效）
const memory = new Map<string, Stored>();

function order(list: Stored[]): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  for (const s of list) {
    // 存着的数据按现在的格式再查一遍：以前的版本存的、被改坏的不列出来
    const r = parsePack(s.pack);
    if (r.ok) entries.push({ key: s.key, pack: r.pack, builtin: false, mine: !!s.mine, installedAt: s.installedAt });
  }
  entries.sort((a, b) => Number(b.mine) - Number(a.mine) || a.installedAt - b.installedAt);
  return [BUILTIN, ...entries];
}

export async function refreshLibrary(): Promise<LibraryEntry[]> {
  let stored: Stored[] = [];
  try {
    stored = await idbAll<Stored>('packs');
  } catch {
    // 读不了：只有这一次装的
  }
  const byKey = new Map(stored.map((s) => [s.key, s]));
  for (const [k, s] of memory) if (!byKey.has(k)) byKey.set(k, s);
  library.value = order([...byKey.values()]);
  return library.value;
}

// 装进资源库时用的键：与内置的同 id 时另起一个，不盖住内置的
export function libraryKey(pack: ResourcePack): string {
  return pack.id === FANTASY_PACK_ID ? `${pack.id}-2` : pack.id;
}

// 资源库里已经有同一个键的包（再装是替换它）
export function inLibrary(pack: ResourcePack): LibraryEntry | undefined {
  const key = libraryKey(pack);
  return library.value.find((e) => !e.builtin && e.key === key);
}

// 装进资源库（同一个键的替换掉）；ok 为 false 时只存在这一次打开的页面里
export async function installPack(pack: ResourcePack, opts: { mine?: boolean } = {}): Promise<{ entry: LibraryEntry; ok: boolean }> {
  const key = libraryKey(pack);
  const rec: Stored = { key, pack: structuredClone(pack), installedAt: Date.now(), ...(opts.mine ? { mine: true } : {}) };
  let ok = true;
  try {
    await idbTx(['packs'], 'readwrite', (s) => s.put(rec, key));
    memory.delete(key);
  } catch {
    ok = false;
    memory.set(key, rec);
  }
  await refreshLibrary();
  return { entry: library.value.find((e) => e.key === key) ?? { key, pack, builtin: false, mine: !!opts.mine, installedAt: rec.installedAt }, ok };
}

// 从资源库里删掉（内置的删不了）。用过它的世界不受影响
export async function removePack(key: string): Promise<void> {
  if (key === BUILTIN.key) return;
  memory.delete(key);
  try {
    await idbTx(['packs'], 'readwrite', (s) => s.delete(key));
  } catch {
    // 本来就没存进去
  }
  await refreshLibrary();
}

// ---------- 信任的脚本 ----------
// kv 的 trustedScripts：信任过的脚本源码的哈希（16 位十六进制，见 core/script.ts 的 scriptHash），一个数组。
// 打开世界、读自动保存时的信任检查（另一支）也读写这里，格式不能变。最多留这么多条，满了丢掉最早的
export const TRUST_KEY = 'trustedScripts';
const TRUST_MAX = 5000;

// 内置示例包里的脚本总是信任的
const BUILTIN_HASHES = new Set(packScripts(FANTASY_PACK).map((s) => s.hash));
const trustedMemory = new Set<string>();

export async function trustedHashes(): Promise<Set<string>> {
  const out = new Set<string>([...BUILTIN_HASHES, ...trustedMemory]);
  try {
    let saved: unknown;
    await idbTx(['kv'], 'readonly', (kv) => {
      const req = kv.get(TRUST_KEY);
      req.onsuccess = () => (saved = req.result);
    });
    if (Array.isArray(saved)) for (const h of saved) if (typeof h === 'string') out.add(h);
  } catch {
    // 读不了：只有内置的和这一次信任过的
  }
  return out;
}

// 记下信任（在同一个事务里读出、合并、写回：两处同时记不会互相盖掉）
export async function trustScripts(hashes: readonly string[]): Promise<void> {
  const add = hashes.filter((h) => /^[0-9a-f]{16}$/.test(h) && !BUILTIN_HASHES.has(h));
  if (!add.length) return;
  for (const h of add) trustedMemory.add(h);
  try {
    await idbTx(['kv'], 'readwrite', (kv) => {
      const req = kv.get(TRUST_KEY);
      req.onsuccess = () => {
        const cur = Array.isArray(req.result) ? (req.result as unknown[]).filter((h): h is string => typeof h === 'string') : [];
        const next = [...cur.filter((h) => !add.includes(h)), ...add];
        kv.put(next.slice(Math.max(0, next.length - TRUST_MAX)), TRUST_KEY);
      };
    });
  } catch {
    // 存不了：这一次打开页面期间照样算信任过
  }
}

// 一个资源包（或任意 JSON）里还没信任过的脚本（同一段脚本只列一次）
export async function untrustedScripts(json: unknown): Promise<FoundScript[]> {
  const found = packScripts(json);
  if (!found.length) return [];
  const trusted = await trustedHashes();
  const seen = new Set<string>();
  return found.filter((s) => !trusted.has(s.hash) && !seen.has(s.hash) && (seen.add(s.hash), true));
}
