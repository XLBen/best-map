import { Boxes, CircleEllipsis, Globe, Layers, MousePointer, Redo2, Undo2, WandSparkles } from 'lucide-preact';
import type { PanelId } from '../../state';
import { openPanel, togglePanel, world } from '../../state';
import { CATEGORIES, category, setCategory, setTool } from '../defs/tools';
import type { CategoryDef, Icon } from '../defs/types';
import { mapStatus } from '../maps/store';
import { LIBRARY_NOTE } from '../copy';
import { libPanel, redoHere, toggleLibrary, undoHere, undoState } from '../packs/panel-store';
import { redoTitle, undoTitle } from '../packs/copy';
import { MapKindSwitch } from './MapKind';

// 顶栏：左边是资源库（第四十五轮，最左边）、整个世界的事（世界、更多、调整）和撤销、重做，
// 右边是指针、各类工具、图层（生态的色板在“自然”里）

// 资源库：从左上角展开，再点一下关上
function LibraryButton() {
  return (
    <button
      class={`tb-btn ${libPanel.value ? 'open' : ''}`}
      onClick={() => {
        if (!libPanel.value) openPanel.value = null;
        toggleLibrary();
      }}
      title={`资源库：${LIBRARY_NOTE}`}
    >
      <Boxes size={18} />
      <span class="tb-label">资源库</span>
    </button>
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
      <button class="tb-btn icon" disabled={!u.canUndo} onClick={undoHere} title={undoTitle(u.undo, u.lib)} aria-label="撤销">
        <Undo2 size={18} />
      </button>
      <button class="tb-btn icon" disabled={!u.canRedo} onClick={redoHere} title={redoTitle(u.redo, u.lib)} aria-label="重做">
        <Redo2 size={18} />
      </button>
    </>
  );
}

export function TopBar() {
  const w = world.value;
  return (
    <div class="topbar">
      <div class="tb-group">
        <LibraryButton />
        <span class="tb-sep" />
        <PanelButton panel="world" icon={Globe} label="世界" title={`新建、保存、打开、资源库、导出\n${mapStatus()}`} />
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
      </div>
      <MapKindSwitch />
    </div>
  );
}
