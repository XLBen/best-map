import { computed, signal } from '@preact/signals';
import { DIMENSION } from '../../../core/content/link-rules';
import type { ContentRef } from '../../../core/content/links';
import { kindOf } from '../../../core/content/registry';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { panelLibrary, refreshLibrary } from '../../library';
import { copyLibrary, libEdits } from '../../library-edit';
import { showToast, world } from '../../state';
import { HOME, type OpenRequest, type PageCtx, type Route, type SourceRef, WORLD_SOURCE, liveSource, liveStack, openTarget, popRoute, pushRoute, sameSource } from './pages';
import { canPick, pickCount, pickStore } from './pick-store';

// 资源库面板的状态（第五十九轮）：看的是哪一份、点到了第几层。关上再打开回到原来的地方。
// 切换来源、关上时把我的库没写进存储的写进去（改的内容已经在日志里，这一步不影响“不丢”）。
// 第六十七轮：看库就是添加。能勾的库（pick-store.ts 的 canPick）里点一项不往下点，在右栏打开（side）；
// 勾了东西或右栏开着时面板变宽成两栏（libWide）。窄窗口里右栏盖在左栏上：只勾了东西时左栏底下一条“已勾 N 项”，点了才盖上（basket）

export interface PanelState {
  source: SourceRef;
  stack: Route[];
  // 右栏上面打开的那一项（只在能勾的库里）
  side?: Route | null;
  // 窄窗口：清单盖在列表上
  basket?: boolean;
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
  const side = same && st.side && source.t === 'lib' && canPick(source.key, ctx) && liveStack([st.side], source, ctx)[0] === st.side ? st.side : null;
  return { source, stack, ...(side ? { side } : {}), ...(st.basket && same ? { basket: true } : {}) };
}

function set(st: PanelState) {
  libPanel.value = st;
  last = st;
}

// 打开：req 写了就开到那一页，没写时回到上次的地方（没开过时看本世界；没有世界时看默认的库）
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
  const start: PanelState = last ?? (world.value ? { source: WORLD_SOURCE, stack: [HOME] } : { source: { t: 'lib', key: DEFAULT_LIBRARY }, stack: [HOME] });
  set(livePanel(start, ctx));
}

export function closeLibrary() {
  if (libPanel.value) last = libPanel.value;
  libPanel.value = null;
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

// 换一份看：回到首页
export function setSource(source: SourceRef) {
  const st = current();
  if (st && sameSource(st.source, source)) {
    set({ source, stack: [HOME] });
    return;
  }
  void libEdits.flushAll();
  set({ source, stack: [HOME] });
}

// ---------- 两栏（第六十七轮） ----------

// 这一份能不能勾（看的是库，并且有地方加）
export const pickingIn = (src: SourceRef, ctx: PageCtx = pageCtx()): src is { t: 'lib'; key: string } => src.t === 'lib' && canPick(src.key, ctx);

// 打开一项：能勾的库里在右栏打开，左栏留在原来的列表（勾选不丢）；别的照旧点进去
export function openRoute(r: Route) {
  const st = current();
  if (st && r.p === 'item' && pickingIn(st.source)) set({ ...st, side: r, basket: false });
  else goTo(r);
}

export function closeSide() {
  const st = current();
  if (st && (st.side || st.basket)) set({ source: st.source, stack: st.stack });
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
  return pickingIn(live.source, ctx) && (!!live.side || pickCount(live.source.key) > 0);
});

// ---------- 刚加的行（第六十七轮） ----------

// 刚加的行闪一下（库里的列表），“去看看”时新加的高亮几秒（本世界的列表）。键是 种类:id
export const rowFlash = signal<{ keys: ReadonlySet<string>; kind: 'flash' | 'hl' } | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
export function flashRows(rows: readonly ContentRef[], kind: 'flash' | 'hl', ms = kind === 'flash' ? 1200 : 4000) {
  rowFlash.value = rows.length ? { keys: new Set(rows.map((r) => `${r.kind}:${r.id}`)), kind } : null;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (rowFlash.value = null), ms);
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
  flashRows(rows, 'hl');
  // 列表长时高亮的行可能在下面：画好后滚过去
  setTimeout(() => document.querySelector('.lp-hl')?.scrollIntoView({ block: 'center' }), 60);
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

export function goDepth(depth: number) {
  const st = current();
  if (st) set({ ...st, stack: st.stack.slice(0, depth + 1) });
}

// 新建的一项：换掉列表上面这一层（返回回到列表）
export const replaceTop = (r: Route) => {
  const st = current();
  if (st) set({ ...st, stack: [...st.stack.slice(0, -1), r] });
};

// 上一次点的是不是面板里（⌘Z 撤销哪一边，见 pages.ts 的 undoTarget）
export const lastPress = { inPanel: false };

// 哪几段展开着（按种类记，这次打开页面期间）
const segOpen = new Map<string, Set<string>>();
export const openSegments = (kind: string): Set<string> | undefined => segOpen.get(kind);
export const rememberSegments = (kind: string, open: ReadonlySet<string>) => void segOpen.set(kind, new Set(open));
