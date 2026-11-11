import type { Command } from '../../../core/commands';
import type { Arrange, ArrangeRelation, LinkEdit } from '../../../core/content/arrange';
import { ORIGIN_OPS } from '../../../core/content/origin';
import { type ContentKind, enableCommand, itemId, itemName, kindOf } from '../../../core/content/registry';
import { type PackWorld, canApply } from '../../../core/packs';
import { savedBackItem, usedSourceItem } from '../../../core/packs/source-diff';
import type { Species } from '../../../core/species';
import { type WaterEdit, type WaterKind, waterBlockEdit, waterCellEdit, waterEditCommand } from '../../../core/water-table';
import type { World } from '../../../core/world';
import { library } from '../../library';
import { copyLibrary, libEdits } from '../../library-edit';
import { askUser, noteAction, showToast, whenEditsIdle, world, worldEpoch } from '../../state';
import { type Obj, blankItem, copyItem, editorIssues } from './fields';
import { canArrange } from './page-arrange';
import { newChoiceOf } from './new-in';
import { type PageCtx, type Route, type SourceRef, kindReadonly, takenIn, waterLists } from './pages';
import { runTrusted } from './row-actions';
import { governmentsIn, replaceCommand, replaceLabel, replacePlan } from './title-help';

// 面板里改东西（第五十九轮）：改一项就存。本世界走命令和世界的撤销栈，我的库走 library-edit.ts（自己的撤销），只读的不动。
// 生态、河湖的一格走 core/water-table.ts 同一个函数，所以总表、生态页、河湖页改的是同一份

// ---------- 世界：排队按最新的样子做命令 ----------

// 大星球上一步要算一会儿：连着改几项时，后一步等前一步算完（和河湖类型的编辑同一个做法）
let tail: Promise<unknown> = Promise.resolve();
// note：做完后顶上那句话（make 之后才问，可以用 make 里算出来的数）
export function queueWorld(make: (w: World) => Command | null, busy = '正在计算…', note?: () => Parameters<typeof runTrusted>[2]): Promise<boolean> {
  const epoch = worldEpoch.value;
  const job = tail.then(async () => {
    await whenEditsIdle();
    const w = world.value;
    if (!w || worldEpoch.value !== epoch) return false;
    const cmd = make(w);
    return cmd ? runTrusted(cmd, busy, note?.()) : true;
  });
  tail = job.catch(() => false);
  return job;
}

// 生态的命令是按字段改的：写了的换掉，去掉的写 null（别的种类整项换掉）
export function speciesPatch(before: Species, next: Obj): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const b = before as unknown as Obj;
  for (const k of new Set([...Object.keys(b), ...Object.keys(next)])) {
    if (next[k] === undefined) {
      if (b[k] !== undefined) patch[k] = null;
    } else if (JSON.stringify(next[k]) !== JSON.stringify(b[k])) patch[k] = next[k];
  }
  return Object.keys(patch).length ? patch : null;
}

// 本世界里换掉一项的命令（一步，可以撤销）。什么都没变时 null
export function worldItemCommand(kind: ContentKind, id: string, next: Obj, w: PackWorld): Command | null {
  if (!canApply(kind)) return null;
  const label = `改${kind.label}“${itemName(kind, next)}”`;
  if (kind.id === 'biome') {
    const before = w.small.species.find((s) => s.id === id);
    if (!before) return null;
    const patch = speciesPatch(before, next);
    return patch && { op: 'batch', label, commands: [{ op: 'update_species', id, patch }] };
  }
  return { op: 'batch', label, commands: [enableCommand(kind, next, w)] };
}

// ---------- 存一项 ----------

// saved：改了（世界里还要算一会儿，所以是 Promise）；invalid：有错，留在页面上不存；readonly：只读的不动
export type CommitResult = 'saved' | 'same' | 'invalid' | 'readonly' | 'failed';

export function commitItem(src: SourceRef, kind: ContentKind, id: string, next: Obj, ctx: PageCtx): CommitResult | Promise<CommitResult> {
  if (kindReadonly(src, kind, ctx)) return 'readonly';
  if (editorIssues(kind, next, ctx.world).errors.length) return 'invalid';
  if (src.t === 'lib') {
    const r = libEdits.setItem(src.key, kind.id, id, next, `改${kind.label}“${itemName(kind, next)}”`);
    if (!r.ok) {
      showToast(r.error, true);
      return 'failed';
    }
    return r.noop ? 'same' : 'saved';
  }
  return queueWorld((w) => worldItemCommand(kind, id, next, w)).then((ok) => (ok ? 'saved' : 'failed'));
}

// ---------- 把一个称号都换掉（第九十一轮，逻辑在 title-help.ts）----------

// 这一份（本世界或我的库）各政体里整个写着 from 的称号换成 to：一步，能撤销。本世界里按执行那一刻的世界再算一遍（前面排着的改动算完以后）。
// 返回改了几处（没有可改的、只读的、失败时 0）
export async function replaceTitles(src: SourceRef, from: string, to: string, ctx: PageCtx): Promise<number> {
  const gov = kindOf('government')!;
  if (kindReadonly(src, gov, ctx)) return 0;
  if (src.t === 'lib') {
    const plan = replacePlan(governmentsIn(src, ctx), from, to);
    if (!plan) return 0;
    const r = libEdits.setItems(src.key, gov.id, plan.items, replaceLabel(plan));
    if (!r.ok) {
      showToast(r.error, true);
      return 0;
    }
    noteAction(`已换 ${plan.hits} 处`, { label: '撤销', run: () => void libEdits.undo(src.key) });
    return plan.hits;
  }
  let hits = 0;
  const ok = await queueWorld((w) => {
    const plan = replacePlan(governmentsIn(src, { ...ctx, world: w }), from, to);
    hits = plan?.hits ?? 0;
    return plan && replaceCommand(plan, w);
  });
  return ok ? hits : 0;
}

// ---------- 和来源的库（第六十二轮）----------

const worldItemOf = (kind: ContentKind, id: string, w: PackWorld): unknown => kind.inWorld(w).find((x) => itemId(kind, x) === id);

// 用库里的版本：一步，能撤销。时代留着世界的变量，比重留世界的（core/packs/source-diff.ts）。和库里一样时 null
export function useSourceCommand(kind: ContentKind, id: string, w: PackWorld, lib: PageCtx['lib']): Command | null {
  const next = usedSourceItem(kind, id, worldItemOf(kind, id, w), w, lib);
  const cmd = next && worldItemCommand(kind, id, next, w);
  return cmd && cmd.op === 'batch' ? { ...cmd, label: `用库里的版本：${kind.label}“${itemName(kind, next)}”` } : null;
}

export function useSourceVersion(kind: ContentKind, id: string, ctx: PageCtx): Promise<boolean> {
  return queueWorld((w) => useSourceCommand(kind, id, w, ctx.lib));
}

// 世界里这一项的来源换到库的副本上：内容不变，只记来源
export function repointCommand(kind: ContentKind, id: string, item: unknown, from: readonly string[], w: PackWorld): Command | null {
  if (!canApply(kind)) return null;
  const cmd = kind.id === 'biome' ? ({ op: 'update_species', id, patch: {} } as Command) : enableCommand(kind, item, w);
  return ORIGIN_OPS.has(cmd.op) ? ({ ...cmd, from: [...from] } as Command) : null;
}

// 复制出来的库（同一个来源只复制一次，再存回就存进这一份）
const copies = new Map<string, string>();

// 存回我的库：写回来源的库，一步，在这个库的撤销里（顶上的提示有“撤销”）。
// 来源是内置的、导入的库时只读：先问，复制成我的库再存，世界里这一项的来源换到副本上（这一步在世界的撤销里）
export async function saveBackToLibrary(kind: ContentKind, id: string, ctx: PageCtx): Promise<boolean> {
  const w = ctx.world;
  if (!w) return false;
  const back = savedBackItem(kind, id, worldItemOf(kind, id, w), w, ctx.lib);
  if (!back) return false;
  let key = back.lib;
  let repoint: string[] | null = null;
  if (!libEdits.canEdit(key)) {
    const from = ctx.lib.find((e) => e.key === key);
    const had = copies.get(key);
    const copy = had ? library.value.find((e) => e.key === had && e.mine && !e.builtin) : undefined;
    const v = await askUser({
      title: `${from?.pack.name ?? key}只读`,
      text: copy ? `存进副本“${copy.pack.name}”。` : '先复制成我的库，再存回。',
      choices: [
        { value: 'ok', label: copy ? `存进“${copy.pack.name}”` : '复制成我的库并存回', primary: true },
        { value: 'cancel', label: '取消' },
      ],
    });
    if (v !== 'ok') return false;
    const target = copy?.key ?? (await copyLibrary(key))?.key;
    if (!target) return false;
    copies.set(key, target);
    repoint = [target, ...(w.small.origin?.[kind.id]?.[id] ?? [key]).slice(1)];
    key = target;
  }
  const r = libEdits.setItem(key, kind.id, back.id, back.item, `存回${kind.label}“${itemName(kind, back.item)}”`);
  if (!r.ok) {
    showToast(r.error, true);
    return false;
  }
  if (repoint) {
    const path = repoint;
    await queueWorld((now) => repointCommand(kind, id, worldItemOf(kind, id, now), path, now));
  }
  const lost = back.missing.length ? `；这个库里没有：${back.missing.slice(0, 3).join('、')}` : '';
  const name = library.value.find((e) => e.key === key)?.pack.name ?? '我的库';
  noteAction(`已存回“${name}”${lost}`, { label: '撤销', run: () => void libEdits.undo(key) });
  return true;
}

// ---------- 新建、复制、删除 ----------

// 新建一项：有默认值（只看一维、一组时带上）。返回它的页面。
// 第九十轮：要先选放进哪里的（文化的文化组，new-in.ts）没选时不建——不再悄悄放进登记表里写的那个组
export function newItemIn(src: SourceRef, kind: ContentKind, ctx: PageCtx, defaults: Obj = {}): Route | null | Promise<Route | null> {
  if (kindReadonly(src, kind, ctx)) return null;
  if (newChoiceOf(kind.id, defaults, src, ctx)) return null;
  const blank = blankItem(kind, takenIn(src, kind, ctx));
  if (!blank) return null;
  return addItemIn(src, kind, { ...blank, ...defaults });
}

export function copyItemIn(src: SourceRef, kind: ContentKind, item: unknown, ctx: PageCtx): Route | null | Promise<Route | null> {
  if (kindReadonly(src, kind, ctx)) return null;
  return addItemIn(src, kind, copyItem(kind, item, takenIn(src, kind, ctx)));
}

function addItemIn(src: SourceRef, kind: ContentKind, item: Obj): Route | null | Promise<Route | null> {
  const id = itemId(kind, item);
  const route: Route = { p: 'item', kind: kind.id, id };
  const label = `新建${kind.label}“${itemName(kind, item)}”`;
  if (src.t === 'lib') {
    const r = libEdits.addItem(src.key, kind.id, item, label);
    if (!r.ok) showToast(r.error, true);
    return r.ok ? route : null;
  }
  return queueWorld((w) => ({ op: 'batch', label, commands: [enableCommand(kind, item, w)] })).then((ok) => (ok ? route : null));
}

// 从我的库里删一项（撤销得回来）
export function deleteFromLibrary(src: SourceRef, kind: ContentKind, id: string, name: string): boolean {
  if (src.t !== 'lib') return false;
  const r = libEdits.removeItem(src.key, kind.id, id, `删除${kind.label}“${name}”`);
  if (!r.ok) showToast(r.error, true);
  return r.ok;
}

// ---------- 融入（第六十轮）----------

// 换一个库的安排：只有我的库能换，走这个库的撤销
export function applyArrange(src: SourceRef, next: Arrange, label: string, ctx: PageCtx): boolean {
  if (src.t !== 'lib' || !canArrange(src, ctx)) return false;
  const r = libEdits.setArrange(src.key, next, label);
  if (!r.ok) showToast(r.error, true);
  return r.ok;
}

// 加、移出是改内容本身（文化的 group、政体的 factions……）：和页面上改字段同一条路
type Item = Record<string, unknown>;
function commitSide(src: SourceRef, rel: ArrangeRelation, parent: Item, child: Item, edit: LinkEdit, ctx: PageCtx): CommitResult | Promise<CommitResult> {
  const kind = kindOf(edit.side === 'parent' ? rel.parent : rel.child);
  if (!kind) return 'failed';
  const r = commitItem(src, kind, itemId(kind, edit.side === 'parent' ? parent : child), edit.next, ctx);
  if (r === 'invalid') showToast('这样改不了：格式不对', true);
  return r;
}

export function linkChild(src: SourceRef, rel: ArrangeRelation, parent: Item, child: Item, ctx: PageCtx): CommitResult | Promise<CommitResult> {
  return rel.link ? commitSide(src, rel, parent, child, rel.link(parent, child), ctx) : 'failed';
}

export function unlinkChild(src: SourceRef, rel: ArrangeRelation, parent: Item, child: Item, ctx: PageCtx): CommitResult | Promise<CommitResult> {
  const edit = rel.unlink?.(parent, child);
  return edit ? commitSide(src, rel, parent, child, edit, ctx) : 'failed';
}

// 新建一项并放到这个上级下面（一步撤销）。返回新的 id
export function newChildIn(src: SourceRef, rel: ArrangeRelation, parent: Item, ctx: PageCtx): string | null | Promise<string | null> {
  const kind = kindOf(rel.child);
  const up = kindOf(rel.parent);
  if (!kind || !up || !rel.link || kindReadonly(src, kind, ctx)) return null;
  const blank = blankItem(kind, takenIn(src, kind, ctx));
  if (!blank) return null;
  const edit = rel.link(parent, blank);
  const item = rel.fresh ? rel.fresh(parent, blank) : edit.side === 'child' ? edit.next : blank;
  const upNext = edit.side === 'parent' ? edit.next : null;
  const id = itemId(kind, item);
  const label = `新建${kind.label}“${itemName(kind, item)}”`;
  if (src.t === 'lib') {
    const r = libEdits.applyItems(src.key, [{ kind: kind.id, item, add: true }, ...(upNext ? [{ kind: up.id, item: upNext }] : [])], label);
    if (!r.ok) showToast(r.error, true);
    return r.ok ? id : null;
  }
  return queueWorld((w) => ({ op: 'batch', label, commands: [enableCommand(kind, item, w), ...(upNext ? [enableCommand(up, upNext, w)] : [])] })).then((ok) => (ok ? id : null));
}

// ---------- 水系的一格 ----------

// 库里：一格的改动落到那一项上（值为 null 的字段去掉，和 update_species 一样）
function applyToLibrary(key: string, e: WaterEdit, label: string, species: readonly Species[]): boolean {
  if (e.target === 'type') {
    const r = libEdits.setItem(key, e.kind === 'river' ? 'riverType' : 'lakeType', e.type.id, e.type, label);
    if (!r.ok) showToast(r.error, true);
    return r.ok;
  }
  const sp = species.find((s) => s.id === e.id);
  if (!sp) return false;
  const next: Obj = { ...(sp as unknown as Obj), ...e.patch };
  for (const [k, v] of Object.entries(e.patch)) if (v === null) delete next[k];
  const r = libEdits.setItem(key, 'biome', e.id, next, label);
  if (!r.ok) showToast(r.error, true);
  return r.ok;
}

export function commitWaterCell(src: SourceRef, spId: string, kind: WaterKind, typeId: string, on: boolean, ctx: PageCtx): boolean | Promise<boolean> {
  const label = on ? '允许水系' : '不允许水系';
  if (src.t === 'lib') {
    if (!libEdits.canEdit(src.key)) return false;
    const lists = waterLists(src, ctx);
    const e = waterCellEdit(lists, spId, kind, typeId, on);
    return e ? applyToLibrary(src.key, e, label, lists.species) : true;
  }
  return queueWorld((w) => {
    const e = waterCellEdit(w.small, spId, kind, typeId, on);
    return e && waterEditCommand(e);
  });
}

export function commitWaterBlock(src: SourceRef, spId: string, mode: 'swap' | 'stop', ctx: PageCtx): boolean | Promise<boolean> {
  if (src.t === 'lib') {
    if (!libEdits.canEdit(src.key)) return false;
    const lists = waterLists(src, ctx);
    const e = waterBlockEdit(lists, spId, mode);
    return e ? applyToLibrary(src.key, e, mode === 'stop' ? '断流' : '换类型', lists.species) : true;
  }
  return queueWorld((w) => {
    const e = waterBlockEdit(w.small, spId, mode);
    return e && waterEditCommand(e);
  });
}

