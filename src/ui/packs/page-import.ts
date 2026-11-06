import { signal } from '@preact/signals';
import type { ArrangeRelation } from '../../../core/content/arrange';
import type { ContentRef } from '../../../core/content/links';
import { itemId, itemName, kindOf } from '../../../core/content/registry';
import type { PopValue } from '../../../core/human/era';
import { PACK_MAX_CHARS, type PackNode, type PackRead, packItems, readPack } from '../../../core/packs';
import { type ImportAsk, type ImportGates, type ImportOnto, type ImportPreview, type ImportTarget, importCommand, importGates, importPreview } from '../../../core/packs/closure';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { askUser, showToast } from '../../state';
import { ADD_DIMENSION_NOTE } from '../copy';
import { queueWorld } from './page-actions';
import { soleText, soleValue } from './page-import-tree';
import { type PageCtx, type SourceRef, WORLD_SOURCE, entryOf, itemsOf, sourceKind, sourceTitle } from './page-source';
import { copyToMine, pageCtx } from './panel-store';
import { type AddDone, runAdd } from './pick-add';
import { type PickFor, type PickState, pickOff, pickOn, pickRemove, pickRows, pickWithNeeds } from './pick-store';
import type { RefOption } from './refs';
import type { ItemRow } from './rows';
import { fileLabel } from './store';

export { type PickRow, type PickSection, matchRow, pickSections } from './page-import-tree';

// 导入窗口的逻辑（第六十一轮，第六十五轮两栏）：从一个库勾几项，添加到面板正在看的本世界或我的库。闭包在 core/packs/closure.ts，这里是窗口的状态、
// 确认后写到哪里；勾和去掉时的连带在 pick-store.ts（第六十六轮搬过去，按库记的勾选也用），写入在 pick-add.ts；
// 要画的树和每行的状态在 page-import-tree.ts。组件（ImportDialog、ImportList、ImportBasket）只画。
// 添加是一步：世界里一个 batch，库里一次 setPack，撤销全撤。列表上的“添加”不开窗口，也走同一个闭包。
// 第六十六轮起给用户看的字叫“添加”，“导入”只留给读文件（第六十七轮这个窗口并进资源库面板）

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
  // 点灰的行时为它加的（第六十六轮，见 pick-store.ts）
  added: readonly PickFor[];
  // 一开始展开哪一种
  focus?: string;
  // 上级页面“加”的下拉选的：导入时放到这个上级下面（同一步）
  onto?: OntoRef;
}

export const importWindow = signal<ImportWindow | null>(null);
export const closeImport = () => (importWindow.value = null);

export { hasRef } from './pick-store';

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
  importWindow.value = { target: req.target, from, file: null, picks: req.pick ? [req.pick] : [], off: [], added: [], ...(req.pick ? { focus: req.pick.kind } : {}), ...(req.onto ? { onto: req.onto } : {}) };
}

// 右上角的“导入”：看本世界、我的库时添加到它；内置的、导入的库只读，先问：从它添加到本世界，或者复制成我的库
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
    text: ctx.world ? '可以从它添加到本世界。要往库里添加，先复制成我的库。' : '要往库里添加，先复制成我的库。',
    choices: [...(ctx.world ? [{ value: 'world', label: '添加到本世界', primary: true }] : []), { value: 'copy', label: '复制成我的库', ...(ctx.world ? {} : { primary: true }) }, { value: 'cancel', label: '取消' }],
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
  patch({ from: key, file: null, picks: [], off: [], added: [], onto: undefined, focus: undefined });
}

// 太大的文件不读进内存（readPack 按字数再查一遍；一个字可能占三个字节）
export async function chooseFile(file: File) {
  const read: PackRead = file.size > 3 * PACK_MAX_CHARS ? { ok: false, errors: [`文件太大（${Math.round(file.size / 1e6)} MB），不是资源包`] } : readPack(await file.text(), fileLabel(file.name));
  patch({ file: { name: file.name, read }, picks: [], off: [], added: [], onto: undefined, focus: undefined });
}

// 勾、取消、整段、×：连带的规则在 pick-store.ts（第六十六轮搬过去，资源库面板按库记的勾选也用它们），这里改的是窗口里的勾选
const editPicks = (ctx: PageCtx, f: (ask: ImportAsk | null, st: PickState) => PickState | null) => {
  const st = importWindow.value;
  if (!st) return;
  const next = f(askOf(st, ctx), st);
  if (next) patch({ picks: next.picks, off: next.off, added: next.added });
};

export const togglePick = (r: ContentRef, on: boolean, ctx: PageCtx = pageCtx()) => editPicks(ctx, (ask, st) => (on ? pickOn(ask, st, r) : pickOff(ask, st, r)));
export const setPicks = (rows: readonly ContentRef[], on: boolean, ctx: PageCtx = pageCtx()) => editPicks(ctx, (ask, st) => pickRows(ask, st, rows, on));
export const removeRow = (r: ContentRef, ctx: PageCtx = pageCtx()) => editPicks(ctx, (ask, st) => pickRemove(ask, st, r));
// 点灰的行：把要的一起勾上（几选一时 choice 是选的那一个）
export const pickNeeds = (r: ContentRef, choice?: ContentRef, ctx: PageCtx = pageCtx()) => editPicks(ctx, (ask, st) => (ask ? pickWithNeeds(ask, st, r, choice) : null));

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
  return source && target ? { source, target, picks: st.picks, off: st.off } : null;
}

export const targetTitle = (st: ImportWindow, ctx: PageCtx): string => (st.target.t === 'world' ? '本世界' : sourceTitle(st.target, ctx));

const VALUE_NOTE = '新加的取值已有人口不变，重新生成人文才分到人';

// 这次加的取值里有没有写到已有变量的（新变量的取值 add_dimension 会分给人）
function addsToOldDim(p: ImportPreview): boolean {
  const k = kindOf('popValue');
  const adding = new Set(p.rows.filter((r) => r.kind === 'popValue').map((r) => r.id));
  if (!k || !adding.size) return false;
  const fresh = new Set(p.dims.map((d) => d.id));
  return ((p.plan.finals.get(k) ?? []) as PopValue[]).some((v) => adding.has(v.id) && !fresh.has(v.dimension));
}

// 添加后要重新生成才影响地图时写一句（重新生成的按钮在第六十二轮；“添加并重新生成”在 pick-add.ts）
export function regenLine(p: ImportPreview, target: ImportTarget): string | null {
  if (target.t !== 'world') return null;
  const small = target.world.small;
  const values = !!small.human && addsToOldDim(p);
  if (p.dims.length && small.human) return values ? `${ADD_DIMENSION_NOTE}；${VALUE_NOTE}` : ADD_DIMENSION_NOTE;
  const adding = new Set(p.rows.map((r) => r.kind));
  const has = (...kinds: string[]) => kinds.some((k) => adding.has(k));
  const out: string[] = [];
  if (values) out.push(VALUE_NOTE);
  if (small.human && (has('era', 'cultureGroup', 'culture') || (has('popValue', 'valueGroup') && !values))) out.push('重新生成人文后才用上');
  else if (!out.length && has('government', 'faction', 'countryTier', 'countryLayout') && small.human?.countryRules) out.push('重新生成国家后才用上');
  if (has('cityRank', 'landmarkType', 'pointType') && small.settlementRules) out.push('重新生成城市后才放到地图上');
  return out.length ? out.join('；') : null;
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

// 这一份能不能接收别的库的内容（世界、库）
function targetFor(src: SourceRef, ctx: PageCtx): ImportTarget | null {
  if (src.t === 'world') return ctx.world ? { t: 'world', world: ctx.world } : null;
  const e = entryOf(src, ctx);
  return e ? { t: 'pack', pack: e.pack } : null;
}

// 别的库里有、这一份里没有的（同一个 id 列第一个库的）。fits：这个上级下面放得下。灰的、放不下的不列（第六十五轮）
export function otherLibOptions(kindId: string, src: SourceRef, ctx: PageCtx, fits?: (item: unknown) => boolean): (RefOption & { lib: string })[] {
  const k = kindOf(kindId);
  if (!k) return [];
  const here = new Set(itemsOf(src, k, ctx).map((x) => itemId(k, x)));
  const seen = new Set<string>();
  const out: (RefOption & { lib: string })[] = [];
  const target = targetFor(src, ctx);
  const gatesOfLib = new Map<string, ImportGates>();
  const grey = (lib: string, id: string): boolean => {
    const e = ctx.lib.find((x) => x.key === lib);
    if (!target || !e) return false;
    let g = gatesOfLib.get(lib);
    if (!g) gatesOfLib.set(lib, (g = importGates(e.pack, target)));
    const t = g.of({ kind: kindId, id }).t;
    return t === 'gated' || t === 'full';
  };
  for (const o of othersOf(kindId, ctx)) {
    if (src.t === 'lib' && o.lib === src.key) continue;
    if (here.has(o.id) || seen.has(o.id) || (fits && !fits(o.item)) || grey(o.lib, o.id)) continue;
    seen.add(o.id);
    out.push({ id: o.id, label: o.name, hint: o.libName, lib: o.lib, ...(o.color ? { color: o.color } : {}) });
  }
  return out;
}

// ---------- 确认 ----------

export type ImportDone = AddDone;

// 跳过的项写成一句：一个原因时“还有 3 项需要意识形态，没加”，别的“还有 3 项没加：政体最多 128 个”
export function skippedLine(dropped: ImportPreview['dropped']): string | null {
  if (!dropped.length) return null;
  const reasons = [...new Set(dropped.map((d) => d.reason))];
  if (reasons.length === 1 && reasons[0].startsWith('需要')) return `还有 ${dropped.length} 项${reasons[0]}，没加`;
  // 几种“需要”写不下：每一行上写着各自的原因
  if (reasons.every((x) => x.startsWith('需要'))) return `还有 ${dropped.length} 项缺别的内容，没加`;
  return `还有 ${dropped.length} 项没加：${reasons.slice(0, 2).join('；')}${reasons.length > 2 ? ' 等' : ''}`;
}

export function doneLine(r: ImportDone, regen: string | null): string {
  const skip = skippedLine(r.skipped ?? []);
  return [`已添加 ${r.count} 项`, skip, regen].filter(Boolean).join('。');
}

const pathOf = (st: ImportWindow): string[] | undefined => (st.file ? undefined : st.from ? [st.from] : undefined);

// 添加：世界里一个 batch（按最新的世界算），库里一步。runCtx 是点确认时的库和世界。regen：接着重新生成（同一步）
export async function runImport(st: ImportWindow, ctx: PageCtx, opts: { regen?: boolean } = {}): Promise<ImportDone> {
  const ask = askOf(st, ctx);
  if (!ask) return { ok: false, count: 0, error: '来源或目的地不在了' };
  const onto: ImportOnto | undefined = st.onto && { relation: st.onto.relation, parent: st.onto.parent, child: st.onto.child };
  const path = pathOf(st);
  return runAdd({ ask, target: st.target, ...(path ? { path } : {}), ...(onto ? { onto } : {}), regen: !!opts.regen }, ctx);
}

// ---------- 列表上的“添加”“全部添加” ----------

// 从这个库加进本世界，每一项能不能选（组件按世界、库记着）。不是库、没有世界时 null
export function addGates(src: SourceRef, ctx: PageCtx): ImportGates | null {
  const e = entryOf(src, ctx);
  return e && ctx.world ? importGates(e.pack, { t: 'world', world: ctx.world }) : null;
}

// 灰的、放不下的：原因（行上写，不能加）
export function addBlock(gates: ImportGates | null, r: { kind: { id: string }; id: string }): string | null {
  const g = gates?.of({ kind: r.kind.id, id: r.id });
  return g?.t === 'gated' || g?.t === 'full' ? g.reason : null;
}

// 加完的提示：几项、带上了什么、加了只有一种取值的变量时所有人都是它、跳过了几项
export function addedLine(p: ImportPreview, source: PackNode, target: ImportTarget): string {
  const extra = p.rows.filter((r) => r.role !== 'pick');
  const parts = [`已添加 ${p.count} 项${extra.length ? `，带上了${extra.slice(0, 3).map((r) => r.name).join('、')}${extra.length > 3 ? ` 等 ${extra.length} 项` : ''}` : ''}`];
  for (const r of p.rows) {
    const sole = soleValue(p, source, r);
    if (sole) parts.push(`${r.name}${soleText(sole)}`);
  }
  const skip = skippedLine(p.dropped);
  if (skip) parts.push(skip);
  const regen = regenLine(p, target);
  if (regen) parts.push(regen);
  return parts.join('。');
}

// 走同一个闭包，不开窗口：能加的加，灰的跳过，提示写清带上了什么、有几项（第六十五轮）
export function addRows(rows: readonly ItemRow[], src: SourceRef, ctx: PageCtx, label: string): void {
  const e = entryOf(src, ctx);
  const world = ctx.world;
  if (!e || !world) return;
  const picks = rows.map((r) => ({ kind: r.kind.id, id: r.id }));
  const ask: ImportAsk = { source: e.pack, target: { t: 'world', world }, picks };
  const p = importPreview(ask);
  if (!p.count) {
    const skip = skippedLine(p.dropped);
    if (skip) showToast(skip, true);
    return;
  }
  void queueWorld((w) => {
    const c = importCommand({ ...ask, target: { t: 'world', world: w } }, { path: [e.key] }).command;
    return c && { ...c, label };
  }, '正在添加…').then((ok) => {
    if (ok) showToast(addedLine(p, e.pack, ask.target));
  });
}
