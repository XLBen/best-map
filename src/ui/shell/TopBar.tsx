import { speciesColor } from '../../../core/species';
import { Globe, Layers, Redo2, Undo2, WandSparkles, Wrench } from 'lucide-preact';
import type { PanelId } from '../../state';
import { canRedo, canUndo, openPanel, options, redo, togglePanel, undo, world } from '../../state';
import { CATEGORIES, category, setCategory } from '../defs/tools';
import type { CategoryDef, Icon } from '../defs/types';
import { mapStatus } from '../maps/store';

// 顶栏：左边是整个世界的事（世界、操作、调整）和撤销、重做，右边是各类工具、图层、生态色

function PanelButton({ panel, icon: I, label, disabled = false, title }: { panel: PanelId; icon: Icon; label: string; disabled?: boolean; title?: string }) {
  return (
    <button class={`tb-btn ${openPanel.value === panel ? 'open' : ''}`} data-panel={panel} disabled={disabled} onClick={() => togglePanel(panel)} title={title ?? label}>
      <I size={18} strokeWidth={1.8} />
      <span class="tb-label">{label}</span>
    </button>
  );
}

// 点一类：换到这类上次用的工具；这一类的工具都在底部条上
function CategoryButton({ c }: { c: CategoryDef }) {
  const I = c.icon;
  return (
    <button class={`tb-btn cat ${category.value === c.id ? 'on' : ''}`} disabled={!world.value} onClick={() => setCategory(c.id)} title={c.label}>
      <I size={18} strokeWidth={1.8} />
      <span class="tb-label">{c.label}</span>
    </button>
  );
}

export function TopBar() {
  const w = world.value;
  const sp = w?.small.species.find((s) => s.id === options.value.biome);
  return (
    <div class="topbar">
      <div class="tb-group">
        <PanelButton panel="world" icon={Globe} label="世界" title={`新世界、我的地图、保存（⌘S）、打开、导出\n${mapStatus()}`} />
        <PanelButton panel="actions" icon={Wrench} label="操作" disabled={!w} title="导出、历史、上手说明、偏好" />
        <PanelButton panel="adjust" icon={WandSparkles} label="调整" disabled={!w} title="整个世界：陆地多少、岛多少、山多高、冷暖干湿……" />
        <span class="tb-sep" />
        <button class="tb-btn icon" disabled={!canUndo.value} onClick={() => void undo()} title="撤销（⌘Z / Ctrl+Z）">
          <Undo2 size={18} strokeWidth={1.8} />
        </button>
        <button class="tb-btn icon" disabled={!canRedo.value} onClick={() => void redo()} title="重做（⇧⌘Z / Ctrl+Shift+Z）">
          <Redo2 size={18} strokeWidth={1.8} />
        </button>
      </div>
      <div class="tb-group">
        {CATEGORIES.map((c) => (
          <CategoryButton c={c} />
        ))}
        <span class="tb-sep" />
        <PanelButton panel="layers" icon={Layers} label="图层" disabled={!w} title="底图、地名、河流、边界、比例尺、参考图" />
        <button class={`tb-btn ${openPanel.value === 'biome' ? 'open' : ''}`} data-panel="biome" disabled={!w} onClick={() => togglePanel('biome')} title="要涂的生态：色板与生态类型">
          <span class="biome-dot" style={{ background: sp ? speciesColor(sp) : 'transparent' }} />
          <span class="tb-label">生态</span>
        </button>
      </div>
    </div>
  );
}
