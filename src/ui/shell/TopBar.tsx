import { Boxes, CircleEllipsis, Globe, Layers, MousePointer, Redo2, Undo2, WandSparkles } from 'lucide-preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { PanelId } from '../../state';
import { fileStatus, openPanel, saveProblem, togglePanel, world } from '../../state';
import { CATEGORIES, category, setCategory, setTool } from '../defs/tools';
import type { CategoryDef, Icon } from '../defs/types';
import { mapStatus } from '../maps/store';
import { panelLibrary } from '../../library';
import { libPanel, pendingBadge, redoHere, showWorldLibrary, toggleLibrary, undoHere, undoState } from '../packs/panel-store';
import { PENDING_TIP, redoTitle, regenCountText, undoTitle } from '../packs/copy';
import { UNDO_LIMIT_TEXT } from '../copy';
import { MapKindButton } from './MapKind';
import { saveNote } from './save-note';

// 顶栏：左边是资源库（第四十五轮，最左边）、整个世界的事（世界、更多、调整）和撤销、重做，
// 右边是指针、各类工具、图层与地图模式（生态的色板在“自然”里）。
// 第八十二轮：最多两行——宽的窗口两组在同一行，放不下时右边那组换到第二行、靠右；地图模式不再单独占一行（MapKindButton）

// 资源库：从左上角展开，再点一下关上。
// 第九十轮：内容改了、地图还没用上（要重新生成）时，按钮旁边一个“改了 N 项”的小标记——面板关着、看的是别的库时才有
// （看本世界时那一条就在面板底下）；点它回到本世界，底下就是“改了 N 项 · 重新生成”
function LibraryButton() {
  const st = libPanel.value;
  const w = world.value;
  const pending = pendingBadge(st, w, panelLibrary.value);
  return (
    <>
      <button
        class={`tb-btn ${st ? 'open' : ''}`}
        onClick={() => {
          if (!libPanel.value) openPanel.value = null;
          toggleLibrary();
        }}
        title="资源库：文化、政体、生态、河湖、地名风格"
      >
        <Boxes size={18} />
        <span class="tb-label">资源库</span>
      </button>
      {pending > 0 && (
        <button
          class="tb-badge"
          title={PENDING_TIP}
          aria-label={regenCountText(pending)}
          onClick={() => {
            openPanel.value = null;
            showWorldLibrary();
          }}
        >
          <span class="tb-label">{regenCountText(pending)}</span>
          <span class="tb-badge-n">{pending}</span>
        </button>
      )}
    </>
  );
}

function PanelButton({ panel, icon: I, label, disabled = false, title }: { panel: PanelId; icon: Icon; label: string; disabled?: boolean; title?: string }) {
  return (
    <button class={`tb-btn ${openPanel.value === panel ? 'open' : ''}`} data-panel={panel} disabled={disabled} onClick={() => togglePanel(panel)} title={title ?? label}>
      <I size={18} />
      <span class="tb-label">{label}</span>
    </button>
  );
}

// 第九十四轮：自动保存没存成（存储满了、不可用、世界太大、这个世界开在另一个页面里）期间，“世界”旁边一直有一个“没保存”的小标记；
// 点它打开“世界”菜单，第一行写原因和“导出文件”。下一次存成了它自己消失
function SaveBadge() {
  const n = saveNote(saveProblem.value, fileStatus.value);
  if (!n) return null;
  return (
    <button class="tb-badge warn" title={n.tip} aria-label={n.tip} onClick={() => (openPanel.value = 'world')}>
      <span class="tb-label">{n.badge}</span>
      <span class="tb-badge-n">!</span>
    </button>
  );
}

// 点一类：换到这类上次用的工具；这一类的工具都在底部条上
function CategoryButton({ c }: { c: CategoryDef }) {
  const I = c.icon;
  return (
    <button class={`tb-btn ${category.value === c.id ? 'on' : ''}`} disabled={!world.value} onClick={() => setCategory(c.id)} title={c.label}>
      <I size={18} />
      <span class="tb-label">{c.label}</span>
    </button>
  );
}

// 指针（第二十五轮）：各类工具前面单独一个按钮，只看不改
function PointerButton() {
  return (
    <button class={`tb-btn ${category.value === 'inspect' ? 'on' : ''}`} disabled={!world.value} onClick={() => setTool('pointer')} title="指针（V）：点击查看档案，不改地图">
      <MousePointer size={18} />
      <span class="tb-label">指针</span>
    </button>
  );
}

// 撤销、重做（第八十一轮）：资源库面板看我的库时是这个库的，看别的库时不能点，别的都是世界的；悬停写撤销的是哪一步
function UndoRedo() {
  const u = undoState();
  return (
    <>
      {/* 第九十五轮：撤销到头了（更早的步骤的撤销记录为了省内存丢掉了）：灰着，悬停说为什么 */}
      <button class="tb-btn icon" disabled={!u.canUndo} onClick={undoHere} title={u.limited ? UNDO_LIMIT_TEXT.tip : undoTitle(u.undo, u.lib)} aria-label="撤销">
        <Undo2 size={18} />
      </button>
      <button class="tb-btn icon" disabled={!u.canRedo} onClick={redoHere} title={redoTitle(u.redo, u.lib)} aria-label="重做">
        <Redo2 size={18} />
      </button>
    </>
  );
}

// 顶栏有多高（一行或两行）：写进 .app 的 --top-clear，资源库面板、右边的抽屉、提示条从它下面开始，不盖住第二行
function useTopClear(bar: { current: HTMLDivElement | null }) {
  useLayoutEffect(() => {
    const el = bar.current;
    const app = el?.parentElement;
    if (!el || !app || typeof ResizeObserver === 'undefined') return;
    const set = () => app.style.setProperty('--top-clear', `${Math.round(el.offsetTop + el.offsetHeight + 10)}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      app.style.removeProperty('--top-clear');
    };
  }, []);
}

export function TopBar() {
  const w = world.value;
  const bar = useRef<HTMLDivElement>(null);
  useTopClear(bar);
  return (
    <div class="topbar" ref={bar}>
      <div class="tb-group">
        <LibraryButton />
        <span class="tb-sep" />
        <PanelButton panel="world" icon={Globe} label="世界" title={`新建、保存、打开、资源库、导出\n${mapStatus()}`} />
        <SaveBadge />
        <PanelButton panel="more" icon={CircleEllipsis} label="更多" disabled={!w} title="历史、偏好、上手说明" />
        <PanelButton panel="adjust" icon={WandSparkles} label="调整" disabled={!w} title="冷暖干湿、四季、河流多少" />
        <span class="tb-sep" />
        <UndoRedo />
      </div>
      <div class="tb-group">
        <PointerButton />
        <span class="tb-sep" />
        {CATEGORIES.filter((c) => c.id !== 'inspect').map((c) => (
          <CategoryButton c={c} />
        ))}
        <span class="tb-sep" />
        <PanelButton panel="layers" icon={Layers} label="图层" disabled={!w} title="底图、地名、河流、边界、比例尺、参考图" />
        <MapKindButton />
      </div>
    </div>
  );
}
