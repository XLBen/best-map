import { computed, signal } from '@preact/signals';
import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import { DIMENSION } from '../../../core/content/link-rules';
import type { ContentRef } from '../../../core/content/links';
import { kindOf } from '../../../core/content/registry';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { panelLibrary, refreshLibrary } from '../../library';
import { copyLibrary, libEdits } from '../../library-edit';
import { canRedo, canUndo, history, redo, showToast, undo, world } from '../../state';
import { HOME, type OpenRequest, type PageCtx, type Route, type SourceRef, type UndoTarget, WORLD_SOURCE, liveSource, liveStack, openTarget, popRoute, pushRoute, sameSource, undoTarget } from './pages';
import { type OtherOpen, sameOther } from './other-view';
import { canPick, pickCount, pickStore, setPickDest, togglePickIn } from './pick-store';
import { pickMode } from './pick-view';
import { defaultFrom } from './pick-other';
import { ESC_RANK, pushEscape } from '../shell/escape';

// 资源库面板的状态（第五十九轮）：看的是哪一份、点到了第几层。关上再打开回到原来的地方。
// 切换来源、关上时把我的库没写进存储的写进去（改的内容已经在日志里，这一步不影响“不丢”）。
// 第六十七轮：看库就是添加。能勾的库（pick-store.ts 的 canPick）里点一项不往下点，在右栏打开（side）；
// 勾了东西或右栏开着时面板变宽成两栏（libWide）。窄窗口里右栏盖在左栏上：只勾了东西时左栏底下一条“已勾 N 项”，点了才盖上（basket）
// 第六十八轮：列表、上级页面上的“从别的库加”也在右栏打开（other，LibOther.tsx），换来源、换页面时收起

export interface PanelState {
  source: SourceRef;
  stack: Route[];
  // 右栏上面打开的那一项（只在能勾的库里）
  side?: Route | null;
  // 窄窗口：清单盖在列表上
  basket?: boolean;
  // 右栏里的“从别的库加”（本世界、我的库的列表和上级页面）；at：打开时左栏是哪一页（换了页面就收起）
  other?: (OtherOpen & { at: string }) | null;
  // 第八十一轮：从别的库挑（一种模式，“从别的库添加…”进，“完成”出）。back：完成后回到哪里（加到的那一份）
  pick?: { back: { source: SourceRef; stack: Route[] } } | null;
}

export const libPanel = signal<PanelState | null>(null);

let last: PanelState | null = null;
let loaded = false;

export const pageCtx = (): PageCtx => ({ world: world.value, lib: panelLibrary.value });

// 现在的来源和这一层（库删了、这一项没了时已经退回去）
export function livePanel(st: PanelState, ctx: PageCtx = pageCtx()): PanelState {
  const source = liveSource(st.source, ctx);
  const same = sameSource(source, st.source);
  const stack = same ? liveStack(st.stack, source, ctx) : [HOME];
  // 右栏的那一项还在（撤销了新建、库删了时收起）
  const side = same && st.pick && st.side && source.t === 'lib' && canPick(source.key, ctx) && liveStack([st.side], source, ctx)[0] === st.side ? st.side : null;
  const other = same && st.other && st.other.at === routeKey(stack) ? st.other : null;
  // 挑选的模式只在库里（库删了、切回本世界时结束）
  const pick = st.pick && source.t === 'lib' ? st.pick : null;
  return { source, stack, ...(side ? { side } : {}), ...(st.basket && same ? { basket: true } : {}), ...(other ? { other } : {}), ...(pick ? { pick } : {}) };
}

const routeKey = (stack: readonly Route[]): string => JSON.stringify(stack[stack.length - 1]);

function set(next: PanelState) {
  // 换了页面：“从别的库加”收起（回到原来那一页也不再出来）
  const st = next.other && next.other.at !== routeKey(next.stack) ? { ...next, other: null } : next;
  libPanel.value = st;
  last = st;
  pickMode.value = !!st.pick;
}

// 打开：req 写了就开到那一页，没写时看本世界（第八十一轮：以前回到上次看的那一份，常常是只读的库）；
// 上次看的就是本世界时回到上次的那一页。没有世界时回到上次的地方（没开过时看默认的库）
export function openLibrary(req?: OpenRequest) {
  // 从存储读只要一次（一个带六个库的存储每读一次要在主线程上解开约 9 MB）：之后的改动都在内存里
  if (!loaded) {
    loaded = true;
    void refreshLibrary();
  }
  const ctx = pageCtx();
  if (req) {
    const small = world.value?.small;
    set(openTarget(req, ctx, small ? worldLibrary(small) : undefined, DEFAULT_LIBRARY));
    return;
  }
  set(livePanel(startOf(last, !!world.value), ctx));
}

// 开到某一份的某一层（第七十二轮：“编辑生态类型…”、没涂成的“编辑生态”、脚本出错的“编辑”开到本世界的那种生态）。
// 栈里不在了的一层截掉（那种生态删了时停在列表）
export function openLibraryAt(source: SourceRef, stack: Route[]) {
  if (!loaded) {
    loaded = true;
    void refreshLibrary();
  }
  const st = libPanel.value;
  if (st && !sameSource(st.source, source)) void libEdits.flushAll();
  set(livePanel({ source, stack }, pageCtx()));
}

// 不带请求打开时从哪里开始（测试直接调）：有世界时总是本世界
export function startOf(prev: PanelState | null, hasWorld: boolean): PanelState {
  if (hasWorld) return prev?.source.t === 'world' ? { source: WORLD_SOURCE, stack: prev.stack } : { source: WORLD_SOURCE, stack: [HOME] };
  return prev ? { source: prev.source, stack: prev.stack } : { source: { t: 'lib', key: DEFAULT_LIBRARY }, stack: [HOME] };
}

export function closeLibrary() {
  if (libPanel.value) last = libPanel.value;
  libPanel.value = null;
  pickMode.value = false;
  void libEdits.flushAll();
}

export function toggleLibrary() {
  if (libPanel.value) closeLibrary();
  else openLibrary();
}

function current(): PanelState | null {
  const st = libPanel.value;
  return st && livePanel(st);
}

// 换一份看：回到首页。挑选时换的是从哪个库挑（还在挑选）；换到本世界、我的库自己时结束挑选
export function setSource(source: SourceRef) {
  const st = current();
  const pick = st?.pick && source.t === 'lib' && canPick(source.key, pageCtx()) ? st.pick : null;
  if (!(st && sameSource(st.source, source))) void libEdits.flushAll();
  set({ source, stack: [HOME], ...(pick ? { pick } : {}) });
}

// ---------- 从别的库挑（第八十一轮） ----------

// 进入：加到正在看的这一份（本世界、我的库），切到上次用的库（list：直接开到这一种的列表）
export function startPicking(list?: Extract<Route, { p: 'list' }>, from?: string) {
  const st = current();
  if (!st) return;
  const ctx = pageCtx();
  setPickDest(st.source.t === 'lib' ? { lib: st.source.key } : 'world');
  const key = from ?? defaultFrom(st.source, ctx);
  if (!key) return;
  void libEdits.flushAll();
  const src: SourceRef = { t: 'lib', key };
  set({ source: src, stack: list ? liveStack([HOME, list], src, ctx) : [HOME], pick: { back: { source: st.source, stack: st.stack } } });
}

// 只读的库里一项的“添加到本世界…”：进入挑选，这一项勾上，在右栏打开
export function pickThis(r: Extract<Route, { p: 'item' }>) {
  const st = current();
  if (!st || st.source.t !== 'lib') return;
  const ctx = pageCtx();
  setPickDest('world');
  if (!canPick(st.source.key, ctx)) return;
  togglePickIn(st.source.key, { kind: r.kind, id: r.id }, true, ctx);
  const back = { source: WORLD_SOURCE, stack: [HOME] };
  set({ source: st.source, stack: st.stack.length > 1 ? st.stack.slice(0, -1) : st.stack, side: r, pick: st.pick ?? { back } });
}

// 完成：回到加到的那一份（勾的还记着，下次挑选时还在）
export function finishPicking() {
  const st = current();
  if (!st?.pick) return;
  set(livePanel({ source: st.pick.back.source, stack: st.pick.back.stack }, pageCtx()));
}

// ---------- 两栏（第六十七轮） ----------

// 这一份能不能勾（在挑选、看的是库，并且有地方加）
export const pickingIn = (src: SourceRef, ctx: PageCtx = pageCtx()): src is { t: 'lib'; key: string } => pickMode.value && src.t === 'lib' && canPick(src.key, ctx);

// 打开一项：能勾的库里在右栏打开，左栏留在原来的列表（勾选不丢）；别的照旧点进去
export function openRoute(r: Route) {
  const st = current();
  if (st && r.p === 'item' && pickingIn(st.source)) set({ ...st, side: r, basket: false, other: null });
  else goTo(r);
}

// 收起右栏：“从别的库加”开着时先收它（底下的那一项还在）
export function closeSide() {
  const st = current();
  if (st?.other) set({ ...st, other: null });
  else if (st && (st.side || st.basket)) set({ source: st.source, stack: st.stack, ...(st.pick ? { pick: st.pick } : {}) });
}

// “从别的库加”（第六十八轮）：在右栏打开；再点一次同一个按钮收起。加到的是左栏这一份
export function toggleOther(o: OtherOpen) {
  const st = current();
  if (!st) return;
  if (sameOther(st.other, o)) {
    set({ ...st, other: null });
    return;
  }
  setPickDest(st.source.t === 'lib' ? { lib: st.source.key } : 'world');
  set({ ...st, other: { ...o, at: routeKey(st.stack) }, basket: false });
}

export function closeOther() {
  const st = current();
  if (st?.other) set({ ...st, other: null });
}

// 窄窗口：清单盖在列表上
export function openBasket() {
  const st = current();
  if (st) set({ ...st, basket: true });
}

// 面板现在是不是两栏（勾了东西或右栏开着）。App 按它挪提示条、底部条
export const libWide = computed(() => {
  const st = libPanel.value;
  void pickStore.value;
  if (!st) return false;
  const ctx = pageCtx();
  const live = livePanel(st, ctx);
  return !!live.other || (!!live.pick && pickingIn(live.source, ctx) && (!!live.side || pickCount(live.source.key) > 0));
});

// ---------- 刚加的行（第六十七轮） ----------

// 刚加的行闪一下（库里的列表），“去看看”时新加的高亮几秒（本世界的列表）。键是 种类:id
export const rowFlash = signal<{ keys: ReadonlySet<string>; kind: 'flash' | 'hl' } | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
// scroll：高亮的行在长列表的下面时滚过去（smooth：慢慢滚；main：只看左栏的）。滚由列表里的行自己做（useFlashScroll）
export function flashRows(rows: readonly ContentRef[], kind: 'flash' | 'hl', scroll?: { smooth?: boolean; main?: boolean }) {
  const f = rows.length ? { keys: new Set(rows.map((r) => `${r.kind}:${r.id}`)), kind } : null;
  rowFlash.value = f;
  scrollWant = f && kind === 'hl' && scroll ? { flash: f, smooth: !!scroll.smooth, main: !!scroll.main, until: performance.now() + SCROLL_WAIT_MS } : null;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (rowFlash.value = null), kind === 'flash' ? 1200 : 4000);
}

// 滚到高亮的第一行（第六十九轮：以前 60 ms 后在整个页面里找 .lp-hl）。高亮的行画好后在 effect 里报上来，
// 同一次画的都报完后（微任务）按页面上的先后取第一行，滚到中间，只滚一次。等不到（列表没画出这一行）就算了
const SCROLL_WAIT_MS = 300;
let scrollWant: { flash: object; smooth: boolean; main: boolean; until: number } | null = null;
let offered: HTMLElement[] = [];

function offerFlashRow(el: HTMLElement | null, kind: string, id: string) {
  const w = scrollWant;
  const f = rowFlash.peek();
  if (!el || !w || w.flash !== f || !f.keys.has(`${kind}:${id}`)) return;
  if (performance.now() > w.until) {
    scrollWant = null;
    return;
  }
  if (w.main && !el.closest('.lp-main')) return;
  if (!offered.length) queueMicrotask(scrollToFirst);
  offered.push(el);
}

function scrollToFirst() {
  const w = scrollWant;
  const rows = offered.filter((el) => el.isConnected);
  offered = [];
  if (!w || !rows.length) return;
  scrollWant = null;
  rows.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  rows[0].scrollIntoView(w.smooth ? { block: 'center', behavior: 'smooth' } : { block: 'center' });
}

// 列表的一行：高亮着、有要滚的时报上来（ref 是这一行）
export function useFlashScroll(ref: RefObject<HTMLElement | null>, kind: string, id: string) {
  const f = rowFlash.value;
  useEffect(() => offerFlashRow(ref.current, kind, id), [f, kind, id]);
}

// 刚加的行闪一下（lp-flash）、“去看看”高亮（lp-hl）
export function flashClass(kind: string, id: string): string {
  const f = rowFlash.value;
  return f && f.keys.has(`${kind}:${id}`) ? (f.kind === 'flash' ? 'lp-flash' : 'lp-hl') : '';
}

// 新加的一项在本世界的哪一页：变量、取值是那个变量的取值页，别的是这一种的列表
export function listOf(r: ContentRef, ctx: PageCtx = pageCtx()): Route | null {
  if (r.kind === DIMENSION) return { p: 'list', kind: 'popValue', dim: r.id };
  const k = kindOf(r.kind);
  if (!k) return null;
  if ((r.kind === 'popValue' || r.kind === 'valueGroup') && ctx.world) {
    const dim = (k.inWorld(ctx.world).find((x) => (x as { id?: string }).id === r.id) as { dimension?: string } | undefined)?.dimension;
    if (dim) return { p: 'list', kind: 'popValue', dim };
  }
  return { p: 'list', kind: r.kind };
}

// “去看看”：切到加到的那一份，打开第一个新加项所在的列表，新加的行高亮几秒
export function lookAt(to: SourceRef, rows: readonly ContentRef[]) {
  if (!libPanel.value) openLibrary();
  setSource(to);
  const ctx = pageCtx();
  const first = rows.map((r) => listOf(r, to.t === 'world' ? ctx : { ...ctx, world: null })).find(Boolean);
  if (first) goTo(first);
  // 列表长时高亮的行可能在下面：画好后滚过去
  flashRows(rows, 'hl', {});
}

// 复制成我的库之后：换到副本，还在同一页（内容一模一样；右栏开着的那一项也还开着）
export function moveToCopy(source: SourceRef) {
  const st = current();
  if (st) set({ ...st, source });
}

// 复制成我的库（内置的、导入的），换到副本上接着看
export async function copyToMine(src: SourceRef): Promise<string | null> {
  if (src.t !== 'lib') return null;
  const made = await copyLibrary(src.key);
  if (!made) return null;
  moveToCopy({ t: 'lib', key: made.key });
  showToast(made.stored ? '已复制成我的库' : '存不进浏览器：只在这次打开的页面里', !made.stored);
  return made.key;
}

export function goTo(r: Route) {
  const st = current();
  if (st) set({ ...st, stack: pushRoute(st.stack, r) });
}

export function goBack() {
  const st = current();
  if (st) set({ ...st, stack: popRoute(st.stack) });
}

// Esc：先收起右栏（第六十七轮；“从别的库加”开着时先收它，第六十八轮），再一层层返回，首页再按一次关上（挑选时是完成）
pushEscape(ESC_RANK.library, () => {
  const st = libPanel.value;
  if (!st) return false;
  if (st.other || st.side || st.basket) closeSide();
  else if (st.stack.length > 1) goBack();
  else if (st.pick) finishPicking();
  else closeLibrary();
  return true;
});

export function goDepth(depth: number) {
  const st = current();
  if (st) set({ ...st, stack: st.stack.slice(0, depth + 1) });
}

// 新建的一项：换掉列表上面这一层（返回回到列表）
export const replaceTop = (r: Route) => {
  const st = current();
  if (st) set({ ...st, stack: [...st.stack.slice(0, -1), r] });
};

// 上一次点的是不是面板里（添加之后记一下；第八十一轮起 ⌘Z 撤销哪一边只看面板看的是哪一份，见 pages.ts 的 undoTarget）
export const lastPress = { inPanel: false };

// 顶栏的撤销、⌘Z 撤销哪一边（第八十一轮）：面板开着、看的是我的库时是这个库的，看别的库时没有可撤销的，别的都是世界
export function undoNow(): { target: UndoTarget; lib: string | null } {
  const st = libPanel.value;
  const ctx = pageCtx();
  const src = st ? livePanel(st, ctx).source : null;
  const target = undoTarget(src, ctx);
  return { target, lib: target === 'library' && src?.t === 'lib' ? src.key : null };
}

export function undoHere(): void {
  const u = undoNow();
  if (u.lib) libEdits.undo(u.lib);
  else if (u.target === 'world') void undo();
}
export function redoHere(): void {
  const u = undoNow();
  if (u.lib) libEdits.redo(u.lib);
  else if (u.target === 'world') void redo();
}

// 顶栏的撤销、重做：能不能点、悬停写哪一步（世界的看历史，我的库的看它自己的）
export function undoState(): { canUndo: boolean; canRedo: boolean; undo: string | null; redo: string | null; lib: boolean } {
  void libEdits.tick.value;
  const u = undoNow();
  if (u.lib) return { canUndo: libEdits.canUndo(u.lib), canRedo: libEdits.canRedo(u.lib), undo: libEdits.undoLabel(u.lib), redo: libEdits.redoLabel(u.lib), lib: true };
  if (u.target === 'none') return { canUndo: false, canRedo: false, undo: null, redo: null, lib: false };
  const h = history.value;
  const done = h.filter((x) => x.done);
  return { canUndo: canUndo.value, canRedo: canRedo.value, undo: done.at(-1)?.summary ?? null, redo: h.find((x) => !x.done)?.summary ?? null, lib: false };
}

// 哪几段展开着（按种类记，这次打开页面期间）
const segOpen = new Map<string, Set<string>>();
export const openSegments = (kind: string): Set<string> | undefined => segOpen.get(kind);
export const rememberSegments = (kind: string, open: ReadonlySet<string>) => void segOpen.set(kind, new Set(open));
