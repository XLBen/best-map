import { signal } from '@preact/signals';
import { DEFAULT_LIBRARY } from '../../../core/packs/builtin-tree';
import { worldLibrary } from '../../../core/packs/switch';
import { library, refreshLibrary } from '../../library';
import { copyLibrary, libEdits } from '../../library-edit';
import { showToast, world } from '../../state';
import { HOME, type OpenRequest, type PageCtx, type Route, type SourceRef, WORLD_SOURCE, liveSource, liveStack, openTarget, popRoute, pushRoute, sameSource } from './pages';

// 资源库面板的状态（第五十九轮）：看的是哪一份、点到了第几层。关上再打开回到原来的地方。
// 切换来源、关上时把我的库没写进存储的写进去（改的内容已经在日志里，这一步不影响“不丢”）

export interface PanelState {
  source: SourceRef;
  stack: Route[];
}

export const libPanel = signal<PanelState | null>(null);

let last: PanelState | null = null;

export const pageCtx = (): PageCtx => ({ world: world.value, lib: library.value });

// 现在的来源和这一层（库删了、这一项没了时已经退回去）
export function livePanel(st: PanelState, ctx: PageCtx = pageCtx()): PanelState {
  const source = liveSource(st.source, ctx);
  const stack = sameSource(source, st.source) ? liveStack(st.stack, source, ctx) : [HOME];
  return { source, stack };
}

function set(st: PanelState) {
  libPanel.value = st;
  last = st;
}

// 打开：req 写了就开到那一页，没写时回到上次的地方（没开过时看本世界；没有世界时看默认的库）
export function openLibrary(req?: OpenRequest) {
  void refreshLibrary();
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

// 复制成我的库之后：换到副本，还在同一页（内容一模一样）
export function moveToCopy(source: SourceRef) {
  const st = current();
  if (st) set({ source, stack: st.stack });
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
