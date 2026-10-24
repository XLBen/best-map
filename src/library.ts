import { signal } from '@preact/signals';
import { PACK_FORMAT, PACK_VERSION, type PackItem, type ResourcePack, packIdFor, parsePack } from '../core/packs';
import type { PlanetForm } from '../core/planet-form';
import { FANTASY_PACK, FANTASY_PACK_ID } from '../core/packs/fantasy';
import { NAME_STYLES_PACK, NAME_STYLES_PACK_ID } from '../core/packs/names';
import { allKinds, itemId, kindByPackKey } from '../core/content/registry';
import { idbAll, idbTx } from './idb';
import { addTrustedSource } from './trust';

// 资源库：装好的资源包（IndexedDB 的 packs 表）。信任过的脚本在 trust.ts（kv 的 trustedScripts）。
// 内置的示例包（奇幻、地名风格示例）总在列表最前面、默认信任，不能删；“我的资源”是从自己的世界里导出、存进来的。
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

const BUILTINS: readonly LibraryEntry[] = [
  { key: FANTASY_PACK_ID, pack: FANTASY_PACK, builtin: true, mine: false, installedAt: 0 },
  { key: NAME_STYLES_PACK_ID, pack: NAME_STYLES_PACK, builtin: true, mine: false, installedAt: 0 },
];
const isBuiltinKey = (key: string) => BUILTINS.some((b) => b.key === key);

// 列表：内置的在前，之后是我的资源、导入的（各按装进来的先后）
export const library = signal<LibraryEntry[]>([...BUILTINS]);

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
  return [...BUILTINS, ...entries];
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
function libraryKey(pack: ResourcePack): string {
  return isBuiltinKey(pack.id) ? `${pack.id}-2` : pack.id;
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
  if (isBuiltinKey(key)) return;
  memory.delete(key);
  try {
    await idbTx(['packs'], 'readwrite', (s) => s.delete(key));
  } catch {
    // 本来就没存进去
  }
  await refreshLibrary();
}

// ---------- 信任 ----------
// 信任的脚本只有一处：trust.ts（按源码的 SHA-256 记在 kv 的 trustedScripts）。导入资源包时用户点了“信任并安装”，
// 包里的脚本在那里记为信任（见 PackDialog）；这里把资源库登记成总是信任的来源：内置的示例包，和导入时信任过、
// 装进来的包（整理信任列表时不会被挤掉，装着就一直信任）。“我的资源”不算：从世界里导出的脚本可能来自
// 没运行脚本打开的别人的世界，没信任过的以后用到世界时照样先问。
// 第一次查信任时先把存着的资源库读进来：刚打开页面、还没开过资源包对话框时（比如读自动保存），装着的包也算
// 给出的列表按资源库的样子记下：没装、没删时是同一个列表，trust.ts 不再重算里面每段脚本的 SHA-256
let loaded: Promise<unknown> | null = null;
let trustedPacks: { from: LibraryEntry[]; packs: ResourcePack[] } | null = null;
addTrustedSource(async () => {
  loaded ??= refreshLibrary();
  await loaded;
  const list = library.value;
  if (trustedPacks?.from !== list) trustedPacks = { from: list, packs: list.filter((e) => !e.mine).map((e) => e.pack) };
  return trustedPacks.packs;
});

// ---------- 自己做的内容：存进“我的资源” ----------

// 形态编辑器、仓库的编辑器的“存进仓库”：存进“我的资源”这个包（没有就新建；包里原来的别的内容都留着），
// 同一个 id 的换成新的。key 是资源包里的段名（planetForms、nameStyles……）。
// 里面的脚本由编辑器记为信任（是自己写的、或者打开编辑器时信任过的），这里不管
export const MY_PACK_NAME = '我的资源';
export type SaveForm = { ok: true; entry: LibraryEntry; stored: boolean } | { ok: false; error: string };
export async function saveItem(key: string, item: unknown): Promise<SaveForm> {
  const kind = kindByPackKey(key);
  if (!kind) return { ok: false, error: `不认识的内容：${key}` };
  const id = packIdFor(MY_PACK_NAME);
  const cur = (await refreshLibrary()).find((e) => !e.builtin && e.key === id);
  const pack: ResourcePack = cur ? structuredClone(cur.pack) : { format: PACK_FORMAT, version: PACK_VERSION, id, name: MY_PACK_NAME };
  const own = itemId(kind, item);
  const list = ((pack[kind.pack.key] as unknown[] | undefined) ?? []).filter((x) => itemId(kind, x) !== own);
  // 超过上限的包读不回来（整个“我的资源”就不见了）：先拦下
  if (list.length >= kind.pack.max) return { ok: false, error: `“${MY_PACK_NAME}”里的${kind.label}已满 ${kind.pack.max} 个，先在仓库里整理` };
  pack[kind.pack.key] = [...list, structuredClone(item)];
  const r = parsePack(pack);
  if (!r.ok) return { ok: false, error: r.errors[0] };
  const { entry, ok } = await installPack(r.pack, { mine: true });
  return { ok: true, entry, stored: ok };
}

export const saveForm = (form: PlanetForm): Promise<SaveForm> => saveItem('planetForms', form as unknown as PackItem);

// 编辑器存进“我的资源”的几段：星球形态和用通用编辑器的内容（放在 small.content 里的种类）
const savedKeys = () => ['planetForms', ...allKinds().filter((k) => k.store === 'content').map((k) => k.pack.key)];

// 从世界导出、存进资源库里已有的同名包（导出的名字默认就是“我的资源”）时，整包换掉会把编辑器存在里面的
// 星球形态、地名风格……弄丢（导出只带世界里有的）：这些留着，接在后面。同一个 id 的用导出的。超过上限的不留（存了整个包会读不回来）
export function keepSavedForms(pack: ResourcePack, old: LibraryEntry | undefined): ResourcePack {
  if (!old?.mine || old.builtin) return pack;
  let out = pack;
  for (const key of savedKeys()) {
    const kind = kindByPackKey(key);
    if (!kind) continue;
    const now = (pack[key] as unknown[] | undefined) ?? [];
    const have = new Set(now.map((x) => itemId(kind, x)));
    const kept = ((old.pack[key] as unknown[] | undefined) ?? []).filter((x) => !have.has(itemId(kind, x)));
    if (kept.length) out = { ...out, [key]: [...now, ...kept].slice(0, kind.pack.max) };
  }
  return out;
}
