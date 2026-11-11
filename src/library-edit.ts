import { signal } from '@preact/signals';
import { type Arrange, arrangeOf, arrangeProblems, sameArrange, withArrange } from '../core/content/arrange';
import { type ContentKind, itemId, kindByPackKey, kindOf } from '../core/content/registry';
import { PACK_MAX_SUBPACKS, type PackNode, type ResourcePack, findPack, itemErrors, ownItems, packIdFor, packItems, parsePack, sameItem, subPacks, walkPacks } from '../core/packs';
import { type LibraryEntry, type Stored, library, nextRev, refreshLibrary, rememberParsed, removePack, useLibraryOverlay, writeStored } from './library';

// 改我的库（第五十九轮）：改一项不再整库校验、整库写盘，也有自己的撤销（和世界的撤销栈分开，切走不丢）。
//
//   校验：只查改的这一项（kind.schema），不再 parsePack 整个库（中世纪的库约 1.5 MB）。
//   内存：包是不改动的数据，改一项只换这一项到树根这条路上的几层，别的共用。撤销记的就是改之前、改之后两个树根，几乎不占地方。
//   存：  改一项写进日志（localStorage，同步，只有改过的那几项），刷新页面、关掉页面不丢，下次读库时补上（adopt）；
//         整个库晚一点才写进 IndexedDB（停手 FLUSH_MS 之后、关掉面板、切换库时），写完去掉日志。
//         换先后、加、删、改库名这几种不好记成“这一项换成这样”的，马上写整个库。
//
// 不碰界面，测试直接调（createLibEditor 可以换存储）

export interface WalOp {
  // 资源包里的段名、这一项的 id、新的样子
  section: string;
  id: string;
  item: unknown;
}
export interface Wal {
  // 日志最后一次改动时的版本：存着的包不比它旧就是已经写进去了（或者别处换掉了），不用补
  rev: number;
  ops: WalOp[];
}

export interface LibBackend {
  put(rec: Stored): Promise<boolean>;
  walRead(key: string): Wal | null;
  // 写不进去（没有 localStorage、满了）时 false：这时尽快写整个库
  walWrite(key: string, wal: Wal | null): boolean;
}

export type EditResult = { ok: true; noop?: boolean } | { ok: false; error: string };

// 一步里的一项：add 是新加，不写是换掉同 id 的
export interface ItemOp {
  kind: string;
  item: Record<string, unknown>;
  add?: boolean;
}

interface Step {
  label: string;
  before: ResourcePack;
  after: ResourcePack;
  // 只改了一项时：这一项撤销前后的样子（可以记进日志）
  one?: { section: string; id: string; before: unknown; after: unknown };
}

interface Head {
  pack: ResourcePack;
  rev: number;
  installedAt: number;
  // 还没写进存储
  dirty: boolean;
  ops: Map<string, WalOp>;
  undo: Step[];
  redo: Step[];
}

// 停手多久写整个库；日志写不进去时快一点；日志最多多大（放不下时写整个库）；撤销最多几步
export const FLUSH_MS = 4000;
export const FLUSH_SOON_MS = 200;
const WAL_MAX_CHARS = 1_000_000;
const UNDO_MAX = 200;

const WAL_PREFIX = 'map2.libWal.';

function localBackend(): LibBackend {
  const store = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    put: (rec) => {
      rememberParsed(rec);
      return writeStored(rec);
    },
    walRead(key) {
      try {
        const raw = store()?.getItem(WAL_PREFIX + key);
        return raw ? (JSON.parse(raw) as Wal) : null;
      } catch {
        return null;
      }
    },
    walWrite(key, wal) {
      try {
        const s = store();
        if (!s) return false;
        if (!wal) {
          s.removeItem(WAL_PREFIX + key);
          return true;
        }
        const text = JSON.stringify(wal);
        if (text.length > WAL_MAX_CHARS) {
          s.removeItem(WAL_PREFIX + key);
          return false;
        }
        s.setItem(WAL_PREFIX + key, text);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------- 树上的一项 ----------

// 树里每一层这一段都走一遍（同一项可以在几个小包里）。fn 返回 null 是这一层不变；没变的层给回原来的对象
function mapNode(node: PackNode, section: string, fn: (list: unknown[]) => unknown[] | null): PackNode {
  let out = node;
  const list = node[section];
  if (Array.isArray(list)) {
    const next = fn(list as unknown[]);
    if (next) out = { ...out, [section]: next };
  }
  const kids = subPacks(node);
  if (kids.length) {
    const nk = kids.map((c) => mapNode(c, section, fn));
    if (nk.some((c, k) => c !== kids[k])) out = { ...out, packs: nk };
  }
  return out;
}

export function replaceItem(pack: ResourcePack, kind: ContentKind, id: string, item: unknown): ResourcePack {
  return mapNode(pack, kind.pack.key, (list) => (list.some((x) => itemId(kind, x) === id) ? list.map((x) => (itemId(kind, x) === id ? item : x)) : null)) as ResourcePack;
}

export function dropItem(pack: ResourcePack, kind: ContentKind, id: string): ResourcePack {
  return mapNode(pack, kind.pack.key, (list) => {
    const rest = list.filter((x) => itemId(kind, x) !== id);
    return rest.length === list.length ? null : rest;
  }) as ResourcePack;
}

function setAt(node: PackNode, path: readonly string[], fn: (n: PackNode) => PackNode): PackNode {
  if (!path.length) return fn(node);
  return { ...node, packs: subPacks(node).map((c) => (c.id === path[0] ? setAt(c, path.slice(1), fn) : c)) };
}

// 新的一项放在树的哪一层：文化放进它的组所在的小包；取值放进同一维的小包；别的放进第一个有这一段的小包，都没有时放最外层
function placeFor(pack: ResourcePack, kind: ContentKind, item: Record<string, unknown>): string[] {
  const key = kind.pack.key;
  const first = (test: (n: PackNode) => boolean): string[] | null => {
    let at: string[] | null = null;
    walkPacks(pack, (n, path) => {
      if (!at && test(n)) at = path;
    });
    return at;
  };
  let hit: string[] | null = null;
  if (kind.id === 'culture') hit = first((n) => ownItems<{ id: string }>(n, 'cultureGroups').some((g) => g.id === item.group));
  if (kind.id === 'popValue' || kind.id === 'valueGroup') hit = first((n) => ownItems<{ dimension?: string }>(n, key).some((v) => v.dimension === item.dimension));
  return hit ?? first((n) => ownItems(n, key).length > 0) ?? [];
}

// ---------- 编辑 ----------

export interface LibEditorOptions {
  publish?: (key: string, pack: ResourcePack) => void;
  entries?: () => readonly LibraryEntry[];
}

export function createLibEditor(backend: LibBackend = localBackend(), opts: LibEditorOptions = {}) {
  const heads = new Map<string, Head>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // 撤销的按钮跟着它变
  const tick = signal(0);
  const entries = opts.entries ?? (() => library.value);
  const publish = opts.publish ?? ((key: string, pack: ResourcePack) => void (library.value = library.value.map((e) => (e.key === key ? { ...e, pack } : e))));

  const editable = (key: string): LibraryEntry | undefined => entries().find((e) => e.key === key && e.mine && !e.builtin);

  function headOf(key: string): Head | null {
    let h = heads.get(key);
    if (h) return h;
    const e = editable(key);
    if (!e) return null;
    h = { pack: e.pack, rev: nextRev(), installedAt: e.installedAt, dirty: false, ops: new Map(), undo: [], redo: [] };
    heads.set(key, h);
    return h;
  }

  const clearTimer = (key: string) => {
    const t = timers.get(key);
    if (t !== undefined) clearTimeout(t);
    timers.delete(key);
  };

  // 写整个库
  async function flush(key: string): Promise<void> {
    clearTimer(key);
    const h = heads.get(key);
    if (!h?.dirty) return;
    h.dirty = false;
    const rev = h.rev;
    await backend.put({ key, pack: h.pack, installedAt: h.installedAt, mine: true, rev });
    // 写的时候又改了：日志留着，等下一次
    if (h.rev === rev) {
      h.ops.clear();
      backend.walWrite(key, null);
    }
  }

  const schedule = (key: string, ms: number) => {
    clearTimer(key);
    timers.set(
      key,
      setTimeout(() => void flush(key), ms),
    );
  };

  function commit(key: string, h: Head, pack: ResourcePack, step: Step | null, one: WalOp | null) {
    h.pack = pack;
    h.rev = nextRev();
    h.dirty = true;
    if (step) {
      h.undo.push(step);
      if (h.undo.length > UNDO_MAX) h.undo.shift();
      h.redo.length = 0;
    }
    publish(key, pack);
    tick.value++;
    if (one) {
      h.ops.set(`${one.section}\u0000${one.id}`, one);
      const logged = backend.walWrite(key, { rev: h.rev, ops: [...h.ops.values()] });
      schedule(key, logged ? FLUSH_MS : FLUSH_SOON_MS);
    } else {
      // 记不成“这一项换成这样”的：马上写
      backend.walWrite(key, null);
      h.ops.clear();
      void flush(key);
    }
  }

  const replay = (key: string, h: Head, target: ResourcePack, step: Step) => {
    const one = step.one ? { section: step.one.section, id: step.one.id, item: target === step.after ? step.one.after : step.one.before } : null;
    commit(key, h, target, null, one);
  };

  return {
    tick,
    canEdit: (key: string) => !!editable(key),
    canUndo: (key: string) => (heads.get(key)?.undo.length ?? 0) > 0,
    canRedo: (key: string) => (heads.get(key)?.redo.length ?? 0) > 0,
    // 撤销、重做的是哪一步（顶栏按钮的悬停写它，第八十一轮）
    undoLabel: (key: string): string | null => heads.get(key)?.undo.at(-1)?.label ?? null,
    redoLabel: (key: string): string | null => heads.get(key)?.redo.at(-1)?.label ?? null,
    // 还有没写进存储的（测试、关页面前）
    isDirty: (key: string) => !!heads.get(key)?.dirty,

    // 改一项（只查这一项）
    setItem(key: string, kindId: string, id: string, next: unknown, label?: string): EditResult {
      const kind = kindOf(kindId);
      const h = headOf(key);
      if (!kind || !h) return { ok: false, error: '这个库不能改' };
      const errs = itemErrors(kind, next);
      if (errs.length) return { ok: false, error: errs[0].message };
      const cur = packItems(h.pack, kind.pack.key).find((x) => itemId(kind, x) === id);
      if (cur === undefined) return { ok: false, error: '这个库里没有这一项' };
      const parsed = kind.schema.parse(next);
      if (sameItem(cur, parsed)) return { ok: true, noop: true };
      const pack = replaceItem(h.pack, kind, id, parsed);
      commit(key, h, pack, { label: label ?? '改一项', before: h.pack, after: pack, one: { section: kind.pack.key, id, before: cur, after: parsed } }, { section: kind.pack.key, id, item: parsed });
      return { ok: true };
    },

    // 一次改几项（第九十一轮：把各政体里的一个称号换成另一个）：一步，撤销一次全回去；有一项不合格就都不改
    setItems(key: string, kindId: string, items: readonly { id: string; next: unknown }[], label?: string): EditResult {
      const kind = kindOf(kindId);
      const h = headOf(key);
      if (!kind || !h) return { ok: false, error: '这个库不能改' };
      let pack = h.pack;
      for (const { id, next } of items) {
        const errs = itemErrors(kind, next);
        if (errs.length) return { ok: false, error: errs[0].message };
        const cur = packItems(pack, kind.pack.key).find((x) => itemId(kind, x) === id);
        if (cur === undefined) return { ok: false, error: '这个库里没有这一项' };
        const parsed = kind.schema.parse(next);
        if (!sameItem(cur, parsed)) pack = replaceItem(pack, kind, id, parsed);
      }
      if (pack === h.pack) return { ok: true, noop: true };
      commit(key, h, pack, { label: label ?? '改几项', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    // 加一项（id 不能重复）。文化组放进“文化”下面自己的小包：新世界才带得上
    addItem(key: string, kindId: string, item: Record<string, unknown>, label?: string): EditResult {
      const kind = kindOf(kindId);
      const h = headOf(key);
      if (!kind || !h) return { ok: false, error: '这个库不能改' };
      const errs = itemErrors(kind, item);
      if (errs.length) return { ok: false, error: errs[0].message };
      const id = itemId(kind, item);
      if (packItems(h.pack, kind.pack.key).some((x) => itemId(kind, x) === id)) return { ok: false, error: '已有同样 id 的一项' };
      const parsed = kind.schema.parse(item);
      let pack: ResourcePack;
      const cultures = findPack(h.pack, ['cultures']);
      if (kind.id === 'cultureGroup' && cultures && !subPacks(cultures).some((c) => c.id === id) && subPacks(cultures).length < PACK_MAX_SUBPACKS) {
        const sub: PackNode = { id, name: String(item.name ?? id).slice(0, 60), weight: item.weight === 0 ? 0 : 1, cultureGroups: [parsed] };
        pack = setAt(h.pack, ['cultures'], (n) => ({ ...n, packs: [...subPacks(n), sub] })) as ResourcePack;
      } else {
        const at = placeFor(h.pack, kind, item);
        const list = ownItems(findPack(h.pack, at) ?? h.pack, kind.pack.key);
        // 一层超过上限的包读不回来（整个库就不见了）：先拦下
        if (list.length >= kind.pack.max) return { ok: false, error: `${kind.label}已满 ${kind.pack.max} 个` };
        pack = setAt(h.pack, at, (n) => ({ ...n, [kind.pack.key]: [...list, parsed] })) as ResourcePack;
      }
      commit(key, h, pack, { label: label ?? '新建', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    removeItem(key: string, kindId: string, id: string, label?: string): EditResult {
      const kind = kindOf(kindId);
      const h = headOf(key);
      if (!kind || !h) return { ok: false, error: '这个库不能改' };
      const pack = dropItem(h.pack, kind, id);
      if (pack === h.pack) return { ok: true, noop: true };
      commit(key, h, pack, { label: label ?? '删除', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    // 换先后：只在同一个小包里（第一个同时有这两项的小包）
    moveItem(key: string, kindId: string, from: string, to: string): EditResult {
      const kind = kindOf(kindId);
      const h = headOf(key);
      if (!kind || !h) return { ok: false, error: '这个库不能改' };
      let done = false;
      const pack = mapNode(h.pack, kind.pack.key, (list) => {
        if (done) return null;
        const a = list.findIndex((x) => itemId(kind, x) === from);
        const b = list.findIndex((x) => itemId(kind, x) === to);
        if (a < 0 || b < 0 || a === b) return null;
        done = true;
        const out = [...list];
        const [x] = out.splice(a, 1);
        out.splice(b, 0, x);
        return out;
      }) as ResourcePack;
      if (!done) return { ok: false, error: '不在同一个小包里' };
      commit(key, h, pack, { label: '换先后', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    rename(key: string, name: string): EditResult {
      const h = headOf(key);
      const n = name.trim();
      if (!h) return { ok: false, error: '这个库不能改' };
      if (!n) return { ok: false, error: '名字不能空着' };
      if (n.length > 60) return { ok: false, error: '名字太长，最多 60 个字' };
      if (n === h.pack.name) return { ok: true, noop: true };
      const pack = { ...h.pack, name: n };
      commit(key, h, pack, { label: `改名为“${n}”`, before: h.pack, after: pack }, null);
      return { ok: true };
    },

    // 换融入的安排（第六十轮）：只改显示，别的内容是同一份。撤销和改内容在同一个栈里
    setArrange(key: string, arrange: Arrange, label?: string): EditResult {
      const h = headOf(key);
      if (!h) return { ok: false, error: '这个库不能改' };
      if (arrangeProblems(arrange).length) return { ok: false, error: '不能这样融入' };
      if (sameArrange(arrangeOf(h.pack), arrange)) return { ok: true, noop: true };
      const pack = withArrange(h.pack, arrange);
      commit(key, h, pack, { label: label ?? '改融入', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    // 整个包换掉（导入，第六十一轮：core/packs/closure.ts 算好的）：一步撤销，马上写。写下去的要读得回来，不然刷新就没了
    setPack(key: string, pack: ResourcePack, label?: string): EditResult {
      const h = headOf(key);
      if (!h) return { ok: false, error: '这个库不能改' };
      if (pack === h.pack) return { ok: true, noop: true };
      const parsed = parsePack(pack);
      if (!parsed.ok) return { ok: false, error: parsed.errors[0] };
      commit(key, h, pack, { label: label ?? '导入', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    // 几项一步改完（新建一个派系并加到政体上）：一步撤销
    applyItems(key: string, ops: readonly ItemOp[], label?: string): EditResult {
      const h = headOf(key);
      if (!h) return { ok: false, error: '这个库不能改' };
      let pack = h.pack;
      for (const op of ops) {
        const kind = kindOf(op.kind);
        if (!kind) return { ok: false, error: '这个库不能改' };
        const errs = itemErrors(kind, op.item);
        if (errs.length) return { ok: false, error: errs[0].message };
        const parsed = kind.schema.parse(op.item);
        if (op.add) {
          const id = itemId(kind, op.item);
          if (packItems(pack, kind.pack.key).some((x) => itemId(kind, x) === id)) return { ok: false, error: '已有同样 id 的一项' };
          const at = placeFor(pack, kind, op.item);
          const list = ownItems(findPack(pack, at) ?? pack, kind.pack.key);
          if (list.length >= kind.pack.max) return { ok: false, error: `${kind.label}已满 ${kind.pack.max} 个` };
          pack = setAt(pack, at, (n) => ({ ...n, [kind.pack.key]: [...list, parsed] })) as ResourcePack;
        } else {
          pack = replaceItem(pack, kind, itemId(kind, op.item), parsed);
        }
      }
      if (pack === h.pack) return { ok: true, noop: true };
      commit(key, h, pack, { label: label ?? '改', before: h.pack, after: pack }, null);
      return { ok: true };
    },

    undo(key: string): string | null {
      const h = heads.get(key);
      const s = h?.undo.pop();
      if (!h || !s) return null;
      h.redo.push(s);
      replay(key, h, s.before, s);
      return s.label;
    },

    redo(key: string): string | null {
      const h = heads.get(key);
      const s = h?.redo.pop();
      if (!h || !s) return null;
      h.undo.push(s);
      replay(key, h, s.after, s);
      return s.label;
    },

    flush,
    async flushAll(): Promise<void> {
      await Promise.all([...heads.keys()].map((k) => flush(k)));
    },

    // 库不在了（删除）：撤销和日志一起去掉
    forget(key: string) {
      clearTimer(key);
      heads.delete(key);
      backend.walWrite(key, null);
      tick.value++;
    },

    // 读存储时：内存里的新就用内存里的；存着的更新（别处换掉了这个包）就放弃内存里的；没有内存里的时补上日志（上次没写完就关了页面）
    adopt(rec: Stored, parsed: ResourcePack): ResourcePack {
      const h = heads.get(rec.key);
      if (h) {
        if ((rec.rev ?? 0) <= h.rev) return h.pack;
        clearTimer(rec.key);
        heads.delete(rec.key);
        backend.walWrite(rec.key, null);
        tick.value++;
        return parsed;
      }
      const wal = backend.walRead(rec.key);
      if (!wal) return parsed;
      if ((rec.rev ?? 0) >= wal.rev) {
        backend.walWrite(rec.key, null);
        return parsed;
      }
      let pack = parsed;
      for (const op of wal.ops) {
        const kind = kindByPackKey(op.section);
        if (!kind || itemErrors(kind, op.item).length) continue;
        pack = replaceItem(pack, kind, op.id, kind.schema.parse(op.item));
      }
      if (pack === parsed) {
        backend.walWrite(rec.key, null);
        return parsed;
      }
      const rev = nextRev();
      heads.set(rec.key, { pack, rev, installedAt: rec.installedAt, dirty: true, ops: new Map(wal.ops.map((o) => [`${o.section}\u0000${o.id}`, o])), undo: [], redo: [] });
      backend.walWrite(rec.key, { rev, ops: wal.ops });
      schedule(rec.key, FLUSH_SOON_MS);
      return pack;
    },
  };
}

export type LibEditor = ReturnType<typeof createLibEditor>;

// 应用里只有一份：读存储时接上；关页面时写一次（日志已经在，这一次写得成就不用补）
export const libEdits = createLibEditor();
useLibraryOverlay(
  (rec, pack) => libEdits.adopt(rec, pack),
  (key) => libEdits.forget(key),
);
globalThis.addEventListener?.('pagehide', () => void libEdits.flushAll());

// ---------- 库：新建、复制、删除 ----------

export function freeLibraryKey(name: string, list: readonly LibraryEntry[] = library.value): string {
  const base = packIdFor(name).slice(0, 56);
  const taken = new Set(list.map((e) => e.key));
  if (!taken.has(base)) return base;
  let k = 2;
  while (taken.has(`${base}-${k}`)) k++;
  return `${base}-${k}`;
}

function insert(entry: LibraryEntry) {
  const list = library.value;
  library.value = [...list.filter((e) => e.builtin), ...list.filter((e) => !e.builtin && e.mine), entry, ...list.filter((e) => !e.builtin && !e.mine)];
}

// 整个库写进存储（新建、复制的），写完再读一遍
async function installNew(entry: LibraryEntry): Promise<boolean> {
  insert(entry);
  const ok = await writeStored({ key: entry.key, pack: entry.pack, installedAt: entry.installedAt, mine: true });
  await refreshLibrary();
  return ok;
}

// 新建一个空的库
export async function createLibrary(name: string): Promise<{ key: string; stored: boolean }> {
  const n = name.trim().slice(0, 60) || '我的库';
  const key = freeLibraryKey(n);
  const pack: ResourcePack = { format: 'map2-pack', version: 1, id: key, name: n };
  const stored = await installNew({ key, pack, builtin: false, mine: true, installedAt: Date.now() });
  return { key, stored };
}

// 库的副本：一模一样的内容，新的键、名字（内容和原来的库共用同一份对象，改的时候才换）
export function copiedPack(from: ResourcePack, key: string, name: string): ResourcePack {
  const { author: _, ...rest } = from;
  return { ...rest, id: key, name } as ResourcePack;
}

// 复制成我的库（内置的、导入的都可以）。名字默认“X的副本”
export async function copyLibrary(fromKey: string, name?: string): Promise<{ key: string; stored: boolean } | null> {
  const from = library.value.find((e) => e.key === fromKey);
  if (!from) return null;
  const n = (name ?? `${from.pack.name}的副本`).trim().slice(0, 60);
  const key = freeLibraryKey(n);
  const stored = await installNew({ key, pack: copiedPack(from.pack, key, n), builtin: false, mine: true, installedAt: Date.now() });
  return { key, stored };
}

export const deleteLibrary = (key: string): Promise<void> => removePack(key);
