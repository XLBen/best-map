import { signal } from '@preact/signals';
import { DIMENSION } from '../../../core/content/link-rules';
import { type ContentRef, linkKey } from '../../../core/content/links';
import type { PackNode, ResourcePack } from '../../../core/packs';
import { FILE_KEY_PREFIX, addFileLibrary, dropFileLibrary, fileLibrary } from '../../library';
import { type ImportAsk, type ImportNeed, type ImportPreview, type ImportRow, type ImportTarget, importGates, importPreview } from '../../../core/packs/closure';
import { infoOf, keyRef } from '../../../core/packs/import-gates';
import { worldEpoch } from '../../state';
import { type PageCtx, entryOf } from './page-source';

// 资源库里“添加”的勾选（第六十六轮）：从第六十五轮的导入窗口里搬出来，按来源库记。
//
//   按库记      每个库（资源库里的键；读进来的文件是 file:名字）记自己的 picks、off 和“为谁加的”。切到别的库、本世界、关掉面板都还在，
//               点“添加”成功、“清空”、换世界（新建、打开了别的世界，不是同一个世界改了内容）时清掉。刷新页面本来就没了（只在内存里）
//   目的地      本世界或某个我的库（{ lib }），全部库共用一个；勾选不跟着目的地变，灰不灰按目的地重新算
//   连带        勾、取消、×、整段勾都先算出新的勾选，再把这一步新失效的项拿掉（settled），规则同第六十五轮
//   点灰的行    把它要的（import-gates.ts 的 needs）一起勾上，记下“为了 X 加的”（added）。几选一时调用方传进选的那一个。
//               去掉 X：为它加的、没有别人需要的一起去掉；去掉为它加的那一项：X 又灰了，也去掉（settled 拿掉），它别的要的照上一条
//
// 前半是纯函数（给定来源、目的地和勾选，算新的勾选）；后半是按库记的状态。资源库面板（第六十七轮）按 pick-view.ts 画。不碰界面，测试直接调

// 为了谁加的：need 是点灰的行 for 时一起勾上的
export interface PickFor {
  need: ContentRef;
  for: ContentRef;
}

export interface PickState {
  picks: readonly ContentRef[];
  // 去掉的子项（勾了上级、单独去掉这一项）
  off: readonly ContentRef[];
  added: readonly PickFor[];
}

export const NO_PICKS: PickState = { picks: [], off: [], added: [] };

export const sameRef = (a: ContentRef, b: ContentRef) => a.kind === b.kind && a.id === b.id;
export const hasRef = (list: readonly ContentRef[], r: ContentRef) => list.some((x) => sameRef(x, r));
const without = (list: readonly ContentRef[], r: ContentRef) => list.filter((x) => !sameRef(x, r));
const refOf = (r: ContentRef): ContentRef => ({ kind: r.kind, id: r.id });

// ---------- 连带（纯函数） ----------

type Picks = Pick<PickState, 'picks' | 'off'>;

const previewOf = (ask: ImportAsk, st: Picks) => importPreview({ ...ask, picks: st.picks, off: st.off });

// 改了勾选之后，这一步新失效的项（灰了、进不来了）勾的拿掉，子项记进 off，到不再变为止。
// 去掉变量后要它的政体、去掉文化组后要它的文化都在这里拿掉；原来就进不来的（放不下……）不动，写在清单底下
function settled(ask: ImportAsk, had: ImportPreview, next: Picks): Picks {
  const known = new Set(had.dropped.map((d) => linkKey(d.kind, d.id)));
  let { picks, off } = next;
  for (let round = 0; round < 16; round++) {
    const p = previewOf(ask, { picks, off });
    const fresh = p.dropped.filter((d) => !known.has(linkKey(d.kind, d.id)));
    if (!fresh.length) break;
    const gone = new Set(fresh.map((d) => linkKey(d.kind, d.id)));
    const wasPick = new Set(picks.map(keyRef));
    off = [...off, ...fresh.filter((d) => !wasPick.has(linkKey(d.kind, d.id)) && !off.some((x) => x.kind === d.kind && x.id === d.id)).map((d) => ({ kind: d.kind, id: d.id }))];
    picks = picks.filter((x) => !gone.has(keyRef(x)));
  }
  return { picks, off };
}

// 这一项下面的（用库的安排：政体的派系、变量的取值和组）
function descendants(source: PackNode, r: ContentRef): ContentRef[] {
  const info = infoOf(source);
  const seen = new Map<string, ContentRef>();
  const walk = (x: ContentRef) => {
    const kids: ContentRef[] = [...(info.children.get(keyRef(x)) ?? [])];
    if (x.kind === DIMENSION) {
      const d = info.dims.get(x.id);
      for (const id of d?.groups ?? []) kids.push({ kind: 'valueGroup', id });
      for (const id of d?.values ?? []) kids.push({ kind: 'popValue', id });
    }
    for (const k of kids) {
      if (seen.has(keyRef(k))) continue;
      seen.set(keyRef(k), k);
      walk(k);
    }
  };
  walk(r);
  return [...seen.values()];
}

const rowIn = (p: ImportPreview, r: ContentRef) => p.rows.find((x) => x.kind === r.kind && x.id === r.id);

// 为谁加的记录跟着勾选走：X 或要的那一项不在勾选里了，这一条就没了。为 X 加的那一项没有别的 X 了时去掉，
// 除非去掉它会让别的勾着的项（或子项）进不来（别人也要它：留着，算用户自己勾的）
function tidyAdded(ask: ImportAsk | null, st: PickState): PickState {
  let cur = st;
  for (let round = 0; round < 8; round++) {
    const keep = cur.added.filter((a) => hasRef(cur.picks, a.for) && hasRef(cur.picks, a.need));
    const orphans: ContentRef[] = [];
    for (const a of cur.added) if (hasRef(cur.picks, a.need) && !keep.some((k) => sameRef(k.need, a.need)) && !hasRef(orphans, a.need)) orphans.push(a.need);
    cur = { ...cur, added: keep };
    if (!orphans.length) break;
    for (const o of orphans) {
      const next: Picks = { picks: without(cur.picks, o), off: cur.off };
      if (!ask) {
        cur = { ...cur, ...next };
        continue;
      }
      const out = settled(ask, previewOf(ask, cur), next);
      // 别的项也跟着进不来了：有别人要它，留着
      if (out.picks.length === next.picks.length && out.off.length === next.off.length) cur = { ...cur, ...out };
    }
  }
  return cur;
}

// 勾上：它和它下面去掉过的都回来（勾上级时默认一起勾）。上级带着的子项去掉后又勾回来时不用另记一笔；跟着来的勾上才是勾整项（文化组勾整组）
export function pickOn(ask: ImportAsk | null, st: PickState, r: ContentRef): PickState {
  const under = ask ? new Set(descendants(ask.source, r).map(keyRef)) : new Set<string>();
  const off = without(st.off, r).filter((x) => !under.has(keyRef(x)));
  const already = hasRef(st.picks, r);
  const child = !already && ask && rowIn(previewOf(ask, { picks: st.picks, off }), r)?.role === 'child';
  return { ...st, picks: already || child ? st.picks : [...st.picks, refOf(r)], off };
}

// 取消：还作为子项在时记进 off；还有别的项要它时变回跟着来的（点清单上的 × 才连它们一起去掉）。
// 是为了别的项加的：那一项又灰了，一起去掉；为它加的、没别人要的也去掉
export function pickOff(ask: ImportAsk | null, st: PickState, r: ContentRef): PickState {
  const picks = without(st.picks, r);
  if (!ask) return tidyAdded(null, { ...st, picks });
  const off = rowIn(previewOf(ask, { picks, off: st.off }), r)?.role === 'child' ? [...without(st.off, r), refOf(r)] : st.off;
  return tidyAdded(ask, { ...st, ...settled(ask, previewOf(ask, st), { picks, off }) });
}

// 整段勾、整段取消
export function pickRows(ask: ImportAsk | null, st: PickState, rows: readonly ContentRef[], on: boolean): PickState {
  const set = new Set(rows.map(keyRef));
  const rest = st.picks.filter((x) => !set.has(keyRef(x)));
  if (on) {
    const under = new Set(set);
    if (ask) for (const r of rows) for (const d of descendants(ask.source, r)) under.add(keyRef(d));
    return { ...st, picks: [...rest, ...rows.map(refOf)], off: st.off.filter((x) => !under.has(keyRef(x))) };
  }
  if (!ask) return tidyAdded(null, { ...st, picks: rest });
  return tidyAdded(ask, { ...st, ...settled(ask, previewOf(ask, st), { picks: rest, off: st.off }) });
}

// 从清单里去掉一项（×）：这一项和要它的都进不来。off 只在有上级还会带它时留着：别的时候留着的话，之后勾要它的项会灰
export function pickRemove(ask: ImportAsk | null, st: PickState, r: ContentRef): PickState {
  const picks = without(st.picks, r);
  const off = [...without(st.off, r), refOf(r)];
  if (!ask) return tidyAdded(null, { ...st, picks, off });
  const out = settled(ask, previewOf(ask, st), { picks, off });
  const free = without(out.off, r);
  const next = rowIn(previewOf(ask, { picks: out.picks, off: free }), r) ? out : { picks: out.picks, off: free };
  return tidyAdded(ask, { ...st, ...next });
}

// 点灰的行（第六十六轮）：把它要的一起勾上，记下为它加的。choice：几选一时选的那一个（只有一个能选时可以不传）。
// 要的东西自己也灰着时，再把它要的勾上（为的都是点的这一项）；里面的几选一用第一个能选的。
// 勾不上（不是灰的照常勾；灰的但这个来源里没有要的、几选一没选、勾上后还是灰的）时 null，勾选不动
export function pickWithNeeds(ask: ImportAsk, st: PickState, r: ContentRef, choice?: ContentRef): PickState | null {
  const first = importGates(ask.source, ask.target, st.picks, st.off).of(r);
  if (first.t !== 'gated') return first.t === 'full' ? null : pickOn(ask, st, r);
  if (!first.resolvable) return null;
  let cur = pickOn(ask, st, r);
  const added = [...cur.added];
  const pending: ContentRef[] = [refOf(r)];
  for (let round = 0; round < 8; round++) {
    const gates = importGates(ask.source, ask.target, cur.picks, cur.off);
    let grew = false;
    for (const x of [...pending]) {
      const g = gates.of(x);
      if (g.t !== 'gated') continue;
      if (!g.resolvable) return null;
      let want: ImportNeed[] = g.choices;
      if (g.any) {
        const top = sameRef(x, r);
        const one = top && choice ? g.choices.find((n) => sameRef(n, choice)) : !top || g.choices.length === 1 ? g.choices[0] : undefined;
        if (!one) return null;
        want = [one];
      }
      for (const n of want) {
        const need = refOf(n);
        // 用户自己勾过的不算为它加的（去掉 X 时不跟着去掉）
        const mine = hasRef(st.picks, need) && !st.added.some((a) => sameRef(a.need, need));
        if (!hasRef(cur.picks, need)) {
          cur = pickOn(ask, cur, need);
          pending.push(need);
          grew = true;
        }
        if (!mine && !added.some((a) => sameRef(a.need, need) && sameRef(a.for, r))) added.push({ need, for: refOf(r) });
      }
    }
    if (!grew) break;
  }
  if (importGates(ask.source, ask.target, cur.picks, cur.off).of(r).t === 'gated') return null;
  return { ...cur, added };
}

// 用户点的那一项（撤销条写它）：勾的项里第一个不是“为了别人加的”（第六十七轮）
export function pickLead(st: Pick<PickState, 'picks' | 'added'>): ContentRef | undefined {
  return st.picks.find((p) => !st.added.some((a) => sameRef(a.need, p))) ?? st.picks[0];
}

// 清单那一行写的：“为了社会主义共和国加的”。names：清单里的名字（X 是勾着的，清单里有它）
export function forNote(st: PickState, r: ContentRef, names: (r: ContentRef) => string | undefined): string | null {
  const whom = st.added.filter((a) => sameRef(a.need, r)).map((a) => names(a.for) ?? a.for.id);
  if (!whom.length) return null;
  return `为了${[...new Set(whom)].slice(0, 2).join('、')}${whom.length > 2 ? ` 等 ${whom.length} 项` : ''}加的`;
}

// 清单：为别的项加的那几行，because 写“为了 X 加的”（给出新的对象，原来的不动）
export function withForNotes(p: ImportPreview, st: PickState): ImportPreview {
  if (!st.added.length) return p;
  const names = new Map(p.rows.map((r) => [keyRef(r), r.name]));
  const copies = new Map<ImportRow, ImportRow>();
  const copy = (r: ImportRow): ImportRow => {
    const note = forNote(st, r, (x) => names.get(keyRef(x)));
    const out: ImportRow = { ...r, ...(note ? { because: [note] } : {}), children: r.children.map(copy) };
    copies.set(r, out);
    return out;
  };
  const list = p.list.map(copy);
  return { ...p, list, rows: p.rows.map((r) => copies.get(r) ?? r) };
}

// ---------- 按库记 ----------

// 加到哪里：本世界或我的库
export type PickDest = 'world' | { lib: string };

interface Store {
  // 记的时候的世界（worldEpoch）：换了世界就是空的
  epoch: number;
  bySource: Readonly<Record<string, PickState>>;
  dest: PickDest | null;
}

export const pickStore = signal<Store>({ epoch: 0, bySource: {}, dest: null });

// 读进来的文件（临时的库，第六十七轮放在 library.ts 的 fileLibrary，资源库面板的标题下拉里列着）：键是 file:名字
export const fileSourceKey = (name: string): string => `${FILE_KEY_PREFIX}${name}`;
export const isFileSource = (key: string): boolean => key.startsWith(FILE_KEY_PREFIX);
export function setFileSource(name: string, pack: PackNode): string {
  return addFileLibrary(name, pack as ResourcePack);
}
export function dropFileSource(key: string): void {
  dropFileLibrary(key);
  clearPicks(key);
}

const live = (): Store => {
  const st = pickStore.value;
  return st.epoch === worldEpoch.value ? st : { epoch: worldEpoch.value, bySource: {}, dest: st.dest };
};

export const picksOf = (key: string): PickState => live().bySource[key] ?? NO_PICKS;

// 这个库勾了几项（标题下拉、首页卡片的“已勾 N”）
export const pickCount = (key: string): number => picksOf(key).picks.length;

// 勾过的库（标题下拉）
export const pickedSources = (): { key: string; count: number }[] =>
  Object.entries(live().bySource)
    .filter(([, s]) => s.picks.length > 0)
    .map(([key, s]) => ({ key, count: s.picks.length }));

export function setPicksOf(key: string, st: PickState): void {
  const cur = live();
  const bySource = { ...cur.bySource };
  if (st.picks.length || st.off.length) bySource[key] = st;
  else delete bySource[key];
  pickStore.value = { ...cur, bySource };
}

// 清空：一个库的，没写时全部
export function clearPicks(key?: string): void {
  const cur = live();
  if (key === undefined) {
    pickStore.value = { ...cur, bySource: {} };
    return;
  }
  if (!(key in cur.bySource)) {
    if (cur !== pickStore.value) pickStore.value = cur;
    return;
  }
  const { [key]: _, ...rest } = cur.bySource;
  pickStore.value = { ...cur, bySource: rest };
}

// 加到哪里：选过的（世界还在、库还在）；没选过时有世界是本世界，没有时第一个我的库，都没有时 null
export function pickDest(ctx: PageCtx): PickDest | null {
  const d = pickStore.value.dest;
  if (d === 'world' && ctx.world) return d;
  if (d && d !== 'world' && ctx.lib.some((e) => e.mine && e.key === d.lib)) return d;
  if (ctx.world) return 'world';
  const mine = ctx.lib.find((e) => e.mine);
  return mine ? { lib: mine.key } : null;
}

// 这个库加到哪里：选的目的地是它自己时（我的库不能加到自己）换成本世界，没有世界时换成别的我的库，都没有时 null
export function destFor(key: string, ctx: PageCtx): PickDest | null {
  const d = pickDest(ctx);
  if (!d || d === 'world' || d.lib !== key) return d;
  if (ctx.world) return 'world';
  const other = ctx.lib.find((e) => e.mine && e.key !== key);
  return other ? { lib: other.key } : null;
}

// 这个库里能不能勾（看库就是添加，第六十七轮）：有地方加、不是加到它自己
export const canPick = (key: string, ctx: PageCtx): boolean => destFor(key, ctx) !== null && pickSource(key, ctx) !== null;

export function setPickDest(d: PickDest): void {
  pickStore.value = { ...live(), dest: d };
}

export const destRef = (d: PickDest): { t: 'world' } | { t: 'lib'; key: string } => (d === 'world' ? { t: 'world' } : { t: 'lib', key: d.lib });

// 来源：资源库里的库，或读进来的文件
export function pickSource(key: string, ctx: PageCtx): PackNode | null {
  const e = ctx.lib.find((x) => x.key === key) ?? (isFileSource(key) ? fileLibrary.value.find((x) => x.key === key) : undefined);
  return e?.pack ?? null;
}

export function destTarget(d: PickDest | null, ctx: PageCtx): ImportTarget | null {
  if (!d) return null;
  if (d === 'world') return ctx.world ? { t: 'world', world: ctx.world } : null;
  const e = entryOf({ t: 'lib', key: d.lib }, ctx);
  return e ? { t: 'pack', pack: e.pack } : null;
}

// 这个库的勾选按现在的目的地算（目的地是来源自己时 null：不能从一个库加到它自己）
export function pickAsk(key: string, ctx: PageCtx, dest: PickDest | null = destFor(key, ctx)): ImportAsk | null {
  if (dest && dest !== 'world' && dest.lib === key) return null;
  const source = pickSource(key, ctx);
  const target = destTarget(dest, ctx);
  const st = picksOf(key);
  return source && target ? { source, target, picks: st.picks, off: st.off } : null;
}

// 这个库的清单（because 写上“为了 X 加的”）。来源或目的地不在时 null
export function pickPreview(key: string, ctx: PageCtx, dest: PickDest | null = destFor(key, ctx)): ImportPreview | null {
  const ask = pickAsk(key, ctx, dest);
  return ask ? withForNotes(importPreview(ask), picksOf(key)) : null;
}

const edit = (key: string, ctx: PageCtx, f: (ask: ImportAsk | null, st: PickState) => PickState | null): boolean => {
  const next = f(pickAsk(key, ctx), picksOf(key));
  if (!next) return false;
  setPicksOf(key, next);
  return true;
};

export const togglePickIn = (key: string, r: ContentRef, on: boolean, ctx: PageCtx): void => void edit(key, ctx, (ask, st) => (on ? pickOn(ask, st, r) : pickOff(ask, st, r)));
export const setPicksIn = (key: string, rows: readonly ContentRef[], on: boolean, ctx: PageCtx): void => void edit(key, ctx, (ask, st) => pickRows(ask, st, rows, on));
export const removePickIn = (key: string, r: ContentRef, ctx: PageCtx): void => void edit(key, ctx, (ask, st) => pickRemove(ask, st, r));
// 点灰的行：勾上了 true；勾不上时 false，勾选不动
export const pickNeedsIn = (key: string, r: ContentRef, ctx: PageCtx, choice?: ContentRef): boolean => edit(key, ctx, (ask, st) => (ask ? pickWithNeeds(ask, st, r, choice) : null));
