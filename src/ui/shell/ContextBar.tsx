import { Ellipsis, Ruler } from 'lucide-preact';
import { roundKm } from '../../../core/terrain';
import type { World } from '../../../core/world';
import { type PanelId, measure, openPanel, options, setOptions, togglePanel, tool, world } from '../../state';
import { CATEGORY_DEFS, TOOL_DEFS, category, setTool, toolsOf } from '../defs/tools';
import type { BarItem, SliderDef } from '../defs/types';
import { pathKm } from '../tools';
import { Seg } from '../common';
import { OptionSlider } from '../components/Slider';

// 底部条：上一行是这一类的全部工具（点一下就换，末尾“⋯”是这一类的设置；工具做什么写在工具按钮的悬停里），
// 下一行是当前工具的设置——带名字、数值一直显示的滑块，和模式选择。用不上的滑块不显示

function Item({ item }: { item: BarItem }) {
  if (item.kind === 'choice') {
    const seg = (
      <Seg<string>
        value={options.value[item.key] as string}
        options={item.options.map((o) => [o.value, o.label])}
        titles={Object.fromEntries(item.options.filter((o) => o.hint).map((o) => [o.value, o.hint]))}
        swatches={Object.fromEntries(item.options.filter((o) => o.swatch).map((o) => [o.value, o.swatch]))}
        onChange={(v) => setOptions({ [item.key]: v })}
      />
    );
    return item.label ? (
      <span class="bar-choice">
        <span class="bar-label">{item.label}</span>
        {seg}
      </span>
    ) : (
      seg
    );
  }
  if (item.kind === 'action') {
    const I = item.icon;
    return (
      <button class="bar-btn" title={item.title} onClick={item.run}>
        {I && <I />} {item.label}
      </button>
    );
  }
  const R = item.render;
  return <R />;
}

// 步行：每天约 30 km
const WALK_KM_PER_DAY = 30;

function MeasureRow({ w, pts }: { w: World; pts: [number, number][] }) {
  const total = pathKm(w, pts);
  const straight = pts.length > 2 ? pathKm(w, [pts[0], pts[pts.length - 1]]) : 0;
  const days = total / WALK_KM_PER_DAY;
  const walk = days < 1 ? '不到 1 天' : `约 ${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)} 天`;
  return (
    <div class="bb-row">
      <span class="bar-tool">
        <Ruler />
        量距离
      </span>
      {pts.length < 2 ? (
        <span class="bar-note">{w.settings.globe ? '点几个点量出总长（沿最短的弧线）' : '点几个点量出总长'}</span>
      ) : (
        <span class="bar-value">
          共 {roundKm(total).toLocaleString()} km{straight ? `（直线 ${roundKm(straight).toLocaleString()} km）` : ''} · 步行{walk}
          <span class="hint">（每天 {WALK_KM_PER_DAY} km）</span>
        </span>
      )}
      <button class="bar-btn" disabled={!pts.length} onClick={() => (measure.value = [])} title="Backspace 删掉最后一点">
        清空
      </button>
      <button class="bar-btn" onClick={() => (measure.value = null)} title="M 或 Esc">
        完成
      </button>
    </div>
  );
}

export function ContextBar() {
  const w = world.value;
  if (!w) return null;
  const c = category.value;
  const cat = CATEGORY_DEFS[c];
  const def = TOOL_DEFS[tool.value];
  const sliders = [def.size, def.amount].filter((s): s is SliderDef => !!s && s.enabled?.(w) !== false);
  const items = def.bar?.(w) ?? [];
  const more: PanelId = `cat:${c}`;
  return (
    <div class="bottombar">
      <div class="bb-row bb-tools">
        {toolsOf(c, w).map((id, k) => {
          const t = TOOL_DEFS[id];
          const I = t.icon;
          return (
            <button class={`bb-tool ${tool.value === id ? 'on' : ''}`} onClick={() => setTool(id)} title={`${t.name}：${t.how}（${k + 1}）`}>
              <I />
              <span>{t.short}</span>
            </button>
          );
        })}
        {cat.extras && (
          <button class={`bb-tool more ${openPanel.value === more ? 'open' : ''}`} data-panel={more} onClick={() => togglePanel(more)} title={`${cat.label}的更多设置`}>
            <Ellipsis />
          </button>
        )}
      </div>
      {measure.value ? (
        <MeasureRow w={w} pts={measure.value} />
      ) : (
        <div class="bb-row">
          {sliders.map((s) => (
            <OptionSlider def={s} w={w} />
          ))}
          {items.map((it) => (
            <Item item={it} />
          ))}
        </div>
      )}
    </div>
  );
}
