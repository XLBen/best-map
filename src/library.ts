import { computed, signal } from '@preact/signals';
import { PACK_FORMAT, PACK_VERSION, type PackItem, type ResourcePack, addToPack, packIdFor, packItems, parsePack, sameItem } from '../core/packs';
import type { PlanetForm } from '../core/planet-form';
import { builtinPacks, isBuiltinSame } from '../core/packs/builtin-tree';
import { allKinds, itemId, kindByPackKey, kindOf, registryVersion } from '../core/content/registry';
import { idbAll, idbTx } from './idb';
import { addTrustedSource } from './trust';

// 资源库：装好的资源包（IndexedDB 的 packs 表）。信任过的脚本在 trust.ts（kv 的 trustedScripts）。
// 内置的包总在列表最前面、默认信任，不能删；“我的资源”是从自己的世界里导出、存进来的。
// 第五十一轮：内置的是六个完整的库（core/packs/builtin-tree.ts）：每个时代一个（时代、取值、政体、派系、文化、基础、自然、地名……）；
// 以前的“奇幻生态示例”在“奇幻”这个库里，“地名风格示例”在每个库的“地名”里
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
  // 第六十七轮：读进来的文件（没装进资源库，只在内存里）：文件名
  file?: string;
}

export interface Stored {
  key: string;
  pack: ResourcePack;
  installedAt: number;
  mine?: boolean;
  // 第五十九轮：第几版（每写一次变大）。版本没变的不再按格式查一遍；另一边的改动（别的包、别的页面）靠它认出来
  rev?: number;
}

const BUILTINS: readonly LibraryEntry[] = builtinPacks().map((pack) => ({ key: pack.id, pack, builtin: true, mine: false, installedAt: 0 }));
const isBuiltinKey = (key: string) => BUILTINS.some((b) => b.key === key);

// 列表：内置的在前，之后是我的资源、导入的（各按装进来的先后）
export const library = signal<LibraryEntry[]>([...BUILTINS]);

// 读进来的文件（第六十七轮）：一个临时的库，资源库面板的标题下拉里列着，能看、能勾、能添加，“装进资源库”才进上面的 library。
// 只在内存里，关掉应用就没了。键是 file:文件名（同名的文件再读一次换掉）
export const FILE_KEY_PREFIX = 'file:';
export const fileLibrary = signal<LibraryEntry[]>([]);
export function addFileLibrary(file: string, pack: ResourcePack): string {
  const key = `${FILE_KEY_PREFIX}${file}`;
  fileLibrary.value = [...fileLibrary.value.filter((e) => e.key !== key), { key, pack, builtin: false, mine: false, installedAt: Date.now(), file }];
  return key;
}
export function dropFileLibrary(key: string): void {
  if (fileLibrary.value.some((e) => e.key === key)) fileLibrary.value = fileLibrary.value.filter((e) => e.key !== key);
}
// 资源库面板看得到的：资源库，加上读进来的文件
export const panelLibrary = computed<readonly LibraryEntry[]>(() => (fileLibrary.value.length ? [...library.value, ...fileLibrary.value] : library.value));

// 存不进浏览器时留在这里（这一次打开页面期间有效）
const memory = new Map<string, Stored>();

// 查过格式的（第五十九轮）：同一版不再查一遍。一个带六个库的存储每次读要查约 9 MB 的内容
const parsed = new Map<string, { rev: number; reg: number; pack: ResourcePack }>();
function parsedPack(s: Stored): ResourcePack | null {
  const hit = parsed.get(s.key);
  if (s.rev && hit?.rev === s.rev && hit.reg === registryVersion()) return hit.pack;
  const r = parsePack(s.pack);
  if (!r.ok) return null;
  if (s.rev) parsed.set(s.key, { rev: s.rev, reg: registryVersion(), pack: r.pack });
  return r.pack;
}

// 我的库正在改的那一份（library-edit.ts，第五十九轮）：没写进存储的改动在内存里，读存储时换上它
type Adopt = (rec: Stored, pack: ResourcePack) => ResourcePack;
let adopt: Adopt = (_, pack) => pack;
let forget: (key: string) => void = () => {};
export function useLibraryOverlay(fn: Adopt, onRemoved: (key: string) => void) {
  adopt = fn;
  forget = onRemoved;
}

// 我的库写进存储的那一份：每一项改的时候查过了，读回来时不用再查（第五十九轮）
export function rememberParsed(rec: Stored) {
  if (rec.rev) parsed.set(rec.key, { rev: rec.rev, reg: registryVersion(), pack: rec.pack });
}

// 写一个包：写不进去时留在内存里（这一次打开的页面里有效）
let lastRev = 0;
export const nextRev = () => (lastRev = Math.max(lastRev + 1, Date.now()));
export async function writeStored(rec: Stored): Promise<boolean> {
  if (!rec.rev) rec.rev = nextRev();
  try {
    await idbTx(['packs'], 'readwrite', (s) => s.put(rec, rec.key));
    memory.delete(rec.key);
    return true;
  } catch {
    memory.set(rec.key, rec);
    return false;
  }
}

function order(list: Stored[]): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  for (const s of list) {
    // 存着的数据按现在的格式再查一遍：以前的版本存的、被改坏的不列出来
    const pack = parsedPack(s);
    if (pack) entries.push({ key: s.key, pack: adopt(s, shownPack(s.key, pack)), builtin: false, mine: !!s.mine, installedAt: s.installedAt });
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
  for (const [k, s] of memory) if ((s.rev ?? 0) >= (byKey.get(k)?.rev ?? 0)) byKey.set(k, s);
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
  const ok = await writeStored(rec);
  await refreshLibrary();
  return { entry: library.value.find((e) => e.key === key) ?? { key, pack, builtin: false, mine: !!opts.mine, installedAt: rec.installedAt }, ok };
}

// 从资源库里删掉（内置的删不了）。用过它的世界不受影响
export async function removePack(key: string): Promise<void> {
  if (isBuiltinKey(key)) return;
  forget(key);
  memory.delete(key);
  parsed.delete(key);
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

// 形态编辑器、资源库的编辑器的“存进资源库”：存进“我的资源”这个包（没有就新建；包里原来的别的内容都留着），
// 同一个 id 的换成新的。key 是资源包里的段名（planetForms、nameStyles……）。
// 里面的脚本由编辑器记为信任（是自己写的、或者打开编辑器时信任过的），这里不管
// 第九十二轮：界面上不再有“我的资源”这个词。这个包的键没变（以前存的照旧读得到、形态编辑器照旧存进它），
// 新建它时叫“我的星球形态”；以前存下的、还叫旧名字的那一个读出来时显示成“以前存的内容”（shownPack）。
// 世界里的内容不再往它里面存（没有时代，新建地图时选不到）：存到我的库见 ui/packs/save-mine.ts
const LEGACY_PACK_NAME = '我的资源';
export const MY_PACK_KEY = packIdFor(LEGACY_PACK_NAME);
export const MY_PACK_NAME = '我的星球形态';
export const LEGACY_SHOWN_NAME = '以前存的内容';
const shown = new WeakMap<ResourcePack, ResourcePack>();
// 以前存下的那个包还叫旧名字时换个名字显示（内容一样；同一个包给同一个对象，按引用记着的不用重算）
export function shownPack(key: string, pack: ResourcePack): ResourcePack {
  if (key !== MY_PACK_KEY || pack.name !== LEGACY_PACK_NAME) return pack;
  let p = shown.get(pack);
  if (!p) shown.set(pack, (p = { ...pack, name: LEGACY_SHOWN_NAME }));
  return p;
}
export type SaveForm = { ok: true; entry: LibraryEntry; stored: boolean } | { ok: false; error: string };
export async function saveItem(key: string, item: unknown): Promise<SaveForm> {
  const kind = kindByPackKey(key);
  if (!kind) return { ok: false, error: `不认识的内容：${key}` };
  const id = MY_PACK_KEY;
  const cur = (await refreshLibrary()).find((e) => !e.builtin && e.key === id);
  const pack: ResourcePack = cur ? structuredClone(cur.pack) : { format: PACK_FORMAT, version: PACK_VERSION, id, name: MY_PACK_NAME };
  const own = itemId(kind, item);
  const list = ((pack[kind.pack.key] as unknown[] | undefined) ?? []).filter((x) => itemId(kind, x) !== own);
  // 超过上限的包读不回来（整个“我的资源”就不见了）：先拦下
  if (list.length >= kind.pack.max) return { ok: false, error: `“${pack.name}”里的${kind.label}已满 ${kind.pack.max} 个，先在资源库里整理` };
  pack[kind.pack.key] = [...list, structuredClone(item)];
  const r = parsePack(pack);
  if (!r.ok) return { ok: false, error: r.errors[0] };
  const { entry, ok } = await installPack(r.pack, { mine: true });
  return { ok: true, entry, stored: ok };
}

// ---------- 拿掉的不丢（第二十九轮）：移出世界的、打开的世界文件里自己做的，存进“来自《世界名》” ----------

// 这个世界的包的名字
export const worldPackName = (world: string) => `来自《${world.trim() || '新世界'}》`;

// 资源库里已经有一模一样的（任何一个包里，内置的也算）
export function inLibraryAlready(kind: string, item: unknown, list: readonly LibraryEntry[] = library.value): boolean {
  const k = kindOf(kind);
  if (!k) return false;
  const put = k.pack.exportItem ? k.pack.exportItem(structuredClone(item)) : item;
  const id = itemId(k, put);
  return list.some((e) => packItems(e.pack, k.pack.key).some((x) => itemId(k, x) === id && sameItem(x, put)));
}

// 要存的：资源库能放的种类里，不是内置原样（用完整的树再看一遍：计算 Worker 里认不出奇幻的那几样）、资源库里也还没有一模一样的
export function worthKeeping(items: readonly { kind: string; item: unknown; builtinSame?: boolean }[], list: readonly LibraryEntry[] = library.value): { kind: string; item: unknown }[] {
  const out: { kind: string; item: unknown }[] = [];
  for (const x of items) {
    const k = kindOf(x.kind);
    if (!k?.pack.listed || x.item === undefined || x.builtinSame || isBuiltinSame(x.kind, x.item)) continue;
    if (inLibraryAlready(x.kind, x.item, list)) continue;
    if (out.some((y) => y.kind === x.kind && itemId(k, y.item) === itemId(k, x.item))) continue;
    out.push({ kind: x.kind, item: x.item });
  }
  return out;
}

// 存进“来自《世界名》”（按种类分小包；一模一样的不重复存，同 id 内容不同的换成新的）。返回新存进去的项数
export async function keepInLibrary(world: string, items: readonly { kind: string; item: unknown; builtinSame?: boolean }[]): Promise<{ saved: number; stored: boolean; full: string[] }> {
  // 先按手上的资源库筛一遍（多数时候移出的都是内置原样的，不必读存储）
  if (!worthKeeping(items).length) return { saved: 0, stored: true, full: [] };
  const list = await refreshLibrary();
  const want = worthKeeping(items, list);
  if (!want.length) return { saved: 0, stored: true, full: [] };
  const name = worldPackName(world);
  const id = packIdFor(name);
  const cur = list.find((e) => !e.builtin && e.key === id);
  const base: ResourcePack = cur ? cur.pack : { format: PACK_FORMAT, version: PACK_VERSION, id, name };
  const r = addToPack(base, want);
  if (!r.added && !r.replaced) return { saved: 0, stored: true, full: r.full };
  const parsed = parsePack(r.pack);
  if (!parsed.ok) return { saved: 0, stored: false, full: r.full };
  const { ok } = await installPack(parsed.pack, { mine: true });
  return { saved: r.added + r.replaced, stored: ok, full: r.full };
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
