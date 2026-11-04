import { signal } from '@preact/signals';
import type { ArrangeRelation } from '../../../core/content/arrange';
import { type ContentRef, linkKey } from '../../../core/content/links';
import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import { sameContent } from '../../../core/content/refs';
import type { Culture, Era } from '../../../core/human/era';
import { type PackNode, type PackRead, type ResourcePack, canApply, packItems, packSections, readPack } from '../../../core/packs';
import { type ImportAsk, type ImportOnto, type ImportPreview, type ImportTarget, importCommand, importPreview, importToPack, targetEra } from '../../../core/packs/closure';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { libEdits } from '../../library-edit';
import { askUser, showToast } from '../../state';
import { ADD_DIMENSION_NOTE } from '../copy';
import { queueWorld } from './page-actions';
import { type PageCtx, type SourceRef, WORLD_SOURCE, entryOf, itemsOf, kindTitle, sourceKind, sourceTitle } from './page-source';
import { HOME_LAYOUT, WATER_KINDS } from './page-layout';
import { copyToMine, lastPress, pageCtx } from './panel-store';
import type { RefOption } from './refs';
import type { RepoRow } from './repo';
import { fileLabel } from './store';

// 导入窗口的逻辑（第六十一轮）：从一个库勾几项，导入面板正在看的本世界或我的库。闭包在 core/packs/closure.ts，这里是窗口的状态、
// 要列哪些、确认后写到哪里。组件（ImportDialog.tsx）只画。
// 导入是一步：世界里一个 batch，库里一次 setPack，撤销全撤。

export interface ImportFile {
  name: string;
  read: PackRead;
}

export interface OntoRef {
  relation: ArrangeRelation;
  parent: string;
  child: ContentRef;
}

export interface ImportWindow {
  // 导入到哪里：本世界或我的库
  target: SourceRef;
  // 从哪个库（资源库里的键）；读了文件时看 file
  from: string | null;
  file: ImportFile | null;
  picks: readonly ContentRef[];
  off: readonly ContentRef[];
  on: readonly ContentRef[];
  // 一开始展开哪一种
  focus?: string;
  // 上级页面“加”的下拉选的：导入时放到这个上级下面（同一步）
  onto?: OntoRef;
}

export const importWindow = signal<ImportWindow | null>(null);
export const closeImport = () => (importWindow.value = null);

const sameRef = (a: ContentRef, b: ContentRef) => a.kind === b.kind && a.id === b.id;
export const hasRef = (list: readonly ContentRef[], r: ContentRef) => list.some((x) => sameRef(x, r));
const without = (list: readonly ContentRef[], r: ContentRef) => list.filter((x) => !sameRef(x, r));

// ---------- 打开 ----------

let lastFrom: string | null = null;

// 默认从哪个库：上次选的；没有时世界用的库以外第一个内置的
export function defaultFrom(target: SourceRef, ctx: PageCtx): string | null {
  const usable = ctx.lib.filter((e) => !(target.t === 'lib' && e.key === target.key));
  if (lastFrom && usable.some((e) => e.key === lastFrom)) return lastFrom;
  const here = target.t === 'world' && ctx.world ? worldLibrary(ctx.world.small) : target.t === 'lib' ? target.key : undefined;
  return (usable.find((e) => e.builtin && e.key !== here) ?? usable.find((e) => e.key === DEFAULT_LIBRARY) ?? usable[0])?.key ?? null;
}

export function openImport(req: { target: SourceRef; from?: string; pick?: ContentRef; onto?: OntoRef }, ctx: PageCtx) {
  const from = req.from ?? defaultFrom(req.target, ctx);
  importWindow.value = { target: req.target, from, file: null, picks: req.pick ? [req.pick] : [], off: [], on: [], ...(req.pick ? { focus: req.pick.kind } : {}), ...(req.onto ? { onto: req.onto } : {}) };
}

// 右上角的“导入”：看本世界、我的库时导入到它；内置的、导入的库只读，先问：从它导入本世界，或者复制成我的库
export async function pressImport(src: SourceRef, ctx: PageCtx): Promise<void> {
  const k = sourceKind(src, ctx);
  if (k === 'world' || k === 'mine') {
    openImport({ target: src }, ctx);
    return;
  }
  if (src.t !== 'lib') return;
  const name = sourceTitle(src, ctx);
  const v = await askUser({
    title: `${name}只读`,
    text: ctx.world ? '可以从它导入本世界。要往库里导入，先复制成我的库。' : '要往库里导入，先复制成我的库。',
    choices: [...(ctx.world ? [{ value: 'world', label: '导入本世界', primary: true }] : []), { value: 'copy', label: '复制成我的库', ...(ctx.world ? {} : { primary: true }) }, { value: 'cancel', label: '取消' }],
  });
  if (v === 'world') openImport({ target: WORLD_SOURCE, from: src.key }, ctx);
  if (v === 'copy') {
    const key = await copyToMine(src);
    if (key) openImport({ target: { t: 'lib', key } }, pageCtx());
  }
}

// ---------- 勾选 ----------

const patch = (p: Partial<ImportWindow>) => {
  if (importWindow.value) importWindow.value = { ...importWindow.value, ...p };
};

export function chooseFrom(key: string) {
  lastFrom = key;
  patch({ from: key, file: null, picks: [], off: [], on: [], onto: undefined, focus: undefined });
}

export async function chooseFile(file: File) {
  const text = await file.text();
  patch({ file: { name: file.name, read: readPack(text, fileLabel(file.name)) }, picks: [], off: [], on: [], onto: undefined, focus: undefined });
}

export function togglePick(r: ContentRef, on: boolean) {
  const st = importWindow.value;
  if (!st) return;
  patch({ picks: on ? (hasRef(st.picks, r) ? st.picks : [...st.picks, r]) : without(st.picks, r), off: on ? without(st.off, r) : st.off });
}

export function setPicks(rows: readonly ContentRef[], on: boolean) {
  const st = importWindow.value;
  if (!st) return;
  const set = new Set(rows.map((r) => linkKey(r.kind, r.id)));
  const rest = st.picks.filter((x) => !set.has(linkKey(x.kind, x.id)));
  patch({ picks: on ? [...rest, ...rows] : rest, off: on ? st.off.filter((x) => !set.has(linkKey(x.kind, x.id))) : st.off });
}

// 还会带上的一项：勾着是默认，去掉记进 off
export function toggleDep(r: ContentRef, keep: boolean) {
  const st = importWindow.value;
  if (st) patch({ off: keep ? without(st.off, r) : [...without(st.off, r), r] });
}

// 可选的变量：勾上记进 on
export function toggleOptional(r: ContentRef, keep: boolean) {
  const st = importWindow.value;
  if (st) patch({ on: keep ? [...without(st.on, r), r] : without(st.on, r), off: without(st.off, r) });
}

// ---------- 算 ----------

export function sourceOf(st: ImportWindow, ctx: PageCtx): PackNode | null {
  if (st.file) return st.file.read.ok ? st.file.read.pack : null;
  return ctx.lib.find((e) => e.key === st.from)?.pack ?? null;
}

export function targetOf(st: ImportWindow, ctx: PageCtx): ImportTarget | null {
  if (st.target.t === 'world') return ctx.world ? { t: 'world', world: ctx.world } : null;
  const e = entryOf(st.target, ctx);
  return e ? { t: 'pack', pack: e.pack } : null;
}

export function askOf(st: ImportWindow, ctx: PageCtx): ImportAsk | null {
  const source = sourceOf(st, ctx);
  const target = targetOf(st, ctx);
  return source && target ? { source, target, picks: st.picks, off: st.off, on: st.on } : null;
}

export const targetTitle = (st: ImportWindow, ctx: PageCtx): string => (st.target.t === 'world' ? '本世界' : sourceTitle(st.target, ctx));

// 导入后要重新生成才影响地图时写一句（重新生成的按钮在第六十二轮）
export function regenLine(p: ImportPreview, target: ImportTarget): string | null {
  if (target.t !== 'world') return null;
  const small = target.world.small;
  if (p.dims.length && small.human) return ADD_DIMENSION_NOTE;
  const adding = new Set([...p.picks, ...p.bring].filter((r) => r.state === 'new' || r.state === 'rename').map((r) => r.kind));
  const has = (...kinds: string[]) => kinds.some((k) => adding.has(k));
  const out: string[] = [];
  if (has('era', 'popValue', 'valueGroup', 'cultureGroup', 'culture') && small.human) out.push('重新生成人文后才用上');
  else if (has('government', 'faction', 'countryTier', 'countryLayout') && small.human?.countryRules) out.push('重新生成国家后才用上');
  if (has('cityRank', 'landmarkType', 'pointType') && small.settlementRules) out.push('重新生成城市后才放到地图上');
  return out.length ? out.join('；') : null;
}

// ---------- 列哪些 ----------

export interface PickRow {
  kind: string;
  id: string;
  name: string;
  color?: string;
  hint?: string;
  item?: unknown;
}
export interface PickSection {
  kind: string;
  title: string;
  rows: PickRow[];
}

// 按首页的先后：时代规则、人文、政治、城市与地标、地理、外观
function kindOrder(): string[] {
  const out = ['era'];
  for (const s of HOME_LAYOUT) {
    for (const c of s.cards) {
      if (c === 'water') out.push(...WATER_KINDS);
      else if (c === 'dims') out.push('popValue');
      else if (c === 'variables') out.push('dimension');
      else out.push(c);
    }
  }
  return out;
}

const sectionMemo = new WeakMap<object, Map<string, PickSection[]>>();

// 来源里每种内容一段；世界里放不进去的种类（星球形态）不列。变量一段：来源的时代写的、目的地的时代还没有的
export function pickSections(source: PackNode, target: ImportTarget): PickSection[] {
  const here = new Set(targetEra(target)?.dimensions.map((d) => d.id));
  const memoKey = `${target.t}|${[...here].join(',')}`;
  let m = sectionMemo.get(source);
  if (!m) sectionMemo.set(source, (m = new Map()));
  const hit = m.get(memoKey);
  if (hit) return hit;
  const groupNames = new Map(packItems<{ id: string; name: string }>(source, 'cultureGroups').map((g) => [g.id, g.name]));
  const dimNames = new Map(packItems<Era>(source, 'eras').flatMap((e) => e.dimensions.map((d) => [d.id, d.label] as const)));
  const hintOf = (k: ContentKind, x: unknown): string | undefined => {
    if (k.id === 'culture') return groupNames.get((x as Culture).group);
    if (k.id === 'popValue' || k.id === 'valueGroup') return dimNames.get((x as { dimension: string }).dimension);
    if (k.id === 'government') {
      const n = (x as { factions?: string[] }).factions?.length;
      return n ? `${n} 个派系` : undefined;
    }
    return undefined;
  };
  const byKind = new Map<string, PickSection>();
  for (const k of packSections()) {
    if (target.t === 'world' && !canApply(k)) continue;
    const items = packItems(source, k.pack.key);
    if (!items.length) continue;
    byKind.set(k.id, {
      kind: k.id,
      title: kindTitle(k),
      rows: items.map((x) => {
        const c = (x as { color?: unknown }).color;
        const hint = hintOf(k, x);
        return { kind: k.id, id: itemId(k, x), name: itemName(k, x), item: x, ...(typeof c === 'string' && c.startsWith('#') ? { color: c } : {}), ...(hint ? { hint } : {}) };
      }),
    });
  }
  const values = packItems<{ dimension: string }>(source, 'popValues');
  const dimRows: PickRow[] = [...dimNames].filter(([id]) => !here.has(id) && values.some((v) => v.dimension === id)).map(([id, label]) => ({ kind: 'dimension', id, name: label, hint: `${values.filter((v) => v.dimension === id).length} 种取值` }));
  if (dimRows.length) byKind.set('dimension', { kind: 'dimension', title: '变量', rows: dimRows });
  const out = [...new Set([...kindOrder(), ...byKind.keys()])].flatMap((k) => byKind.get(k) ?? []);
  m.set(memoKey, out);
  return out;
}

// 这一行在目的地是什么样：same 已经有了，differs 有同 id、内容不同（导入时改名）。按目的地、这一项记着
const hereMemo = new WeakMap<object, Map<unknown, 'same' | 'differs' | null>>();
export function hereState(r: PickRow, target: ImportTarget): 'same' | 'differs' | null {
  const k = kindOf(r.kind);
  if (!k || r.item === undefined) return null;
  const holder = target.t === 'world' ? target.world.small : target.pack;
  let m = hereMemo.get(holder);
  if (!m) hereMemo.set(holder, (m = new Map()));
  const hit = m.get(r.item);
  if (hit !== undefined) return hit;
  const list = target.t === 'world' ? k.inWorld(target.world) : packItems(target.pack, k.pack.key);
  const there = list.find((x) => itemId(k, x) === r.id);
  const v = there === undefined ? null : sameContent(k, there, k.pack.finalize && target.t === 'world' ? k.pack.finalize(r.item) : r.item) ? 'same' : 'differs';
  m.set(r.item, v);
  return v;
}

export function matchRow(r: PickRow, q: string): boolean {
  return r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || !!r.hint?.toLowerCase().includes(q);
}

// ---------- 别的库里的（列表和上级页面“加”的下拉） ----------

interface Other {
  id: string;
  name: string;
  color?: string;
  lib: string;
  libName: string;
  item: unknown;
}
const otherMemo = new WeakMap<object, Map<string, Other[]>>();

function othersOf(kindId: string, ctx: PageCtx): Other[] {
  let m = otherMemo.get(ctx.lib);
  if (!m) otherMemo.set(ctx.lib, (m = new Map()));
  const hit = m.get(kindId);
  if (hit) return hit;
  const k = kindOf(kindId);
  const out: Other[] = [];
  if (k) {
    for (const e of ctx.lib) {
      for (const x of packItems(e.pack, k.pack.key)) {
        const c = (x as { color?: unknown }).color;
        out.push({ id: itemId(k, x), name: itemName(k, x), lib: e.key, libName: e.pack.name, item: x, ...(typeof c === 'string' && c.startsWith('#') ? { color: c } : {}) });
      }
    }
  }
  m.set(kindId, out);
  return out;
}

// 别的库里有、这一份里没有的（同一个 id 列第一个库的）。fits：这个上级下面放得下
export function otherLibOptions(kindId: string, src: SourceRef, ctx: PageCtx, fits?: (item: unknown) => boolean): (RefOption & { lib: string })[] {
  const k = kindOf(kindId);
  if (!k) return [];
  const here = new Set(itemsOf(src, k, ctx).map((x) => itemId(k, x)));
  const seen = new Set<string>();
  const out: (RefOption & { lib: string })[] = [];
  for (const o of othersOf(kindId, ctx)) {
    if (src.t === 'lib' && o.lib === src.key) continue;
    if (here.has(o.id) || seen.has(o.id) || (fits && !fits(o.item))) continue;
    seen.add(o.id);
    out.push({ id: o.id, label: o.name, hint: o.libName, lib: o.lib, ...(o.color ? { color: o.color } : {}) });
  }
  return out;
}

// ---------- 确认 ----------

export interface ImportDone {
  ok: boolean;
  count: number;
  error?: string;
}

const pathOf = (st: ImportWindow): string[] | undefined => (st.file ? undefined : st.from ? [st.from] : undefined);

// 导入：世界里一个 batch（按最新的世界算），库里一步。runCtx 是点确认时的库和世界
export async function runImport(st: ImportWindow, ctx: PageCtx): Promise<ImportDone> {
  const ask = askOf(st, ctx);
  if (!ask) return { ok: false, count: 0, error: '来源或目的地不在了' };
  const onto: ImportOnto | undefined = st.onto && { relation: st.onto.relation, parent: st.onto.parent, child: st.onto.child };
  if (st.target.t === 'world') {
    const path = pathOf(st);
    let count = 0;
    const ok = await queueWorld((w) => {
      const r = importCommand({ ...ask, target: { t: 'world', world: w } }, { ...(path ? { path } : {}), ...(onto ? { onto } : {}) });
      count = r.preview.count;
      return r.command;
    }, '正在导入…');
    return { ok, count };
  }
  const key = st.target.key;
  const r = importToPack(ask, onto ? { onto } : {});
  if (r.pack === (ask.target as Extract<ImportTarget, { t: 'pack' }>).pack) return { ok: !r.preview.over.length, count: 0, ...(r.preview.over.length ? { error: r.preview.over[0] } : {}) };
  const done = libEdits.setPack(key, r.pack as ResourcePack, `导入 ${r.preview.count} 项`);
  if (!done.ok) return { ok: false, count: 0, error: done.error };
  lastPress.inPanel = true;
  return { ok: true, count: r.preview.count };
}

// ---------- 列表上的“添加”“全部添加” ----------

// 走同一个闭包。加一个变量的（会动人口）、改名的、带不了的先打开窗口看一眼；别的直接加，说一声还带上了什么
export function addRows(rows: readonly RepoRow[], src: SourceRef, ctx: PageCtx, label: string): void {
  const e = entryOf(src, ctx);
  const world = ctx.world;
  if (!e || !world) return;
  const picks = rows.map((r) => ({ kind: r.kind.id, id: r.id }));
  const ask: ImportAsk = { source: e.pack, target: { t: 'world', world }, picks };
  const p = importPreview(ask);
  if (p.dims.length || p.over.length || p.blocked.length) {
    importWindow.value = { target: WORLD_SOURCE, from: e.key, file: null, picks, off: [], on: [], focus: picks[0]?.kind };
    return;
  }
  const extra = p.bring.filter((r) => r.state !== 'off');
  void queueWorld((w) => {
    const c = importCommand({ ...ask, target: { t: 'world', world: w } }, { path: [e.key] }).command;
    return c && { ...c, label };
  }, '正在添加…').then((ok) => {
    if (ok && extra.length) showToast(`还带上了：${extra.slice(0, 3).map((r) => r.name).join('、')}${extra.length > 3 ? ` 等 ${extra.length} 项` : ''}`);
  });
}
