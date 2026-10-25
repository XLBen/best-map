import { CircleEllipsis, Globe, Layers, MousePointer, Redo2, Undo2, WandSparkles } from 'lucide-preact';
import type { PanelId } from '../../state';
import { canRedo, canUndo, openPanel, redo, togglePanel, undo, world } from '../../state';
import { CATEGORIES, category, setCategory, setTool } from '../defs/tools';
import type { CategoryDef, Icon } from '../defs/types';
import { mapStatus } from '../maps/store';
import { MapKindSwitch } from './MapKind';

// 顶栏：左边是整个世界的事（世界、更多、调整）和撤销、重做，右边是指针、各类工具、图层（生态的色板在“自然”里）

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

export function TopBar() {
  const w = world.value;
  return (
    <div class="topbar">
      <div class="tb-group">
        <PanelButton panel="world" icon={Globe} label="世界" title={`新建、保存、打开、资源库、导出\n${mapStatus()}`} />
        <PanelButton panel="more" icon={CircleEllipsis} label="更多" disabled={!w} title="历史、偏好、上手说明" />
        <PanelButton panel="adjust" icon={WandSparkles} label="调整" disabled={!w} title="冷暖干湿、四季、河流多少" />
        <span class="tb-sep" />
        <button class="tb-btn icon" disabled={!canUndo.value} onClick={() => void undo()} title="撤销（⌘Z / Ctrl+Z）">
          <Undo2 size={18} />
        </button>
        <button class="tb-btn icon" disabled={!canRedo.value} onClick={() => void redo()} title="重做（⇧⌘Z / Ctrl+Shift+Z）">
          <Redo2 size={18} />
        </button>
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
