import { Ellipsis, Ruler } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import { roundKm } from '../../../core/terrain';
import type { World } from '../../../core/world';
import { type PanelId, measure, openPanel, options, setOptions, sliderActive, togglePanel, tool, world } from '../../state';
import { CATEGORY_DEFS, TOOL_DEFS, category, setTool, toolsOf } from '../defs/tools';
import type { BarItem, SliderDef } from '../defs/types';
import { pathKm } from '../tools';
import { nudgeSlider, sliderPos, sliderValue } from './sliders';

// 底部条：上一行是这一类的全部工具（点一下就换，末尾“⋯”是这一类的设置），
// 下一行是当前工具的设置——带名字、数值一直显示的滑块，和模式选择。用不上的滑块不显示

function Item({ item }: { item: BarItem }) {
  if (item.kind === 'choice') {
    const cur = options.value[item.key];
    return (
      <div class="seg">
        {item.options.map((o) => (
          <button class={cur === o.value ? 'on' : ''} title={o.hint} onClick={() => setOptions({ [item.key]: o.value })}>
            {o.swatch && <span class="swatch" style={{ background: o.swatch }} />}
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (item.kind === 'action') {
    const I = item.icon;
    return (
      <button class="bar-btn" title={item.title} onClick={item.run}>
        {I && <I size={15} />} {item.label}
      </button>
    );
  }
  const R = item.render;
  return <R />;
}

// 横向滑块：左边是名字，右边一直显示数值；拖动时地图在鼠标最后停的地方预览
function HSlider({ def, w }: { def: SliderDef; w: World }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const value = options.value[def.key];
  const pos = sliderPos(def, w, value);
  const setFrom = (e: PointerEvent) => {
    if (!track.current) return;
    const r = track.current.getBoundingClientRect();
    setOptions({ [def.key]: sliderValue(def, w, (e.clientX - r.left) / r.width) });
  };
  const stop = () => {
    setDrag(false);
    sliderActive.value = false;
  };
  return (
    <div class={`hs ${drag ? 'drag' : ''}`}>
      <span class="hs-label">{def.label}</span>
      <div
        class="hs-track"
        ref={track}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDrag(true);
          sliderActive.value = true;
          setFrom(e);
        }}
        onPointerMove={(e) => drag && setFrom(e)}
        onPointerUp={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            nudgeSlider(def, e.key === 'ArrowRight' ? 1 : -1);
          }
        }}
      >
        <div class="hs-fill" style={{ width: `${pos * 100}%` }} />
        <div class="hs-thumb" style={{ left: `calc((100% - 12px) * ${pos})` }} />
      </div>
      <span class="hs-value">{def.format(value, w)}</span>
    </div>
  );
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
        <Ruler size={16} strokeWidth={1.8} />
        量距离
      </span>
      {pts.length < 2 ? (
        <span class="bar-note">{w.settings.globe ? '点几个点量出总长（沿最短的弧线）' : '点几个点量出总长'}</span>
      ) : (
        <span class="bar-value">
          共 {roundKm(total).toLocaleString()} km{straight ? `（直线 ${roundKm(straight).toLocaleString()} km）` : ''} · 步行{walk}
          <span class="muted">（每天 {WALK_KM_PER_DAY} km）</span>
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
              <I size={17} strokeWidth={1.8} />
              <span>{t.short}</span>
            </button>
          );
        })}
        {cat.extras && (
          <button class={`bb-tool more ${openPanel.value === more ? 'open' : ''}`} data-panel={more} onClick={() => togglePanel(more)} title={`${cat.label}的更多设置`}>
            <Ellipsis size={17} strokeWidth={1.8} />
          </button>
        )}
      </div>
      {measure.value ? (
        <MeasureRow w={w} pts={measure.value} />
      ) : (
        (sliders.length > 0 || items.length > 0) && (
          <div class="bb-row">
            {sliders.map((s) => (
              <HSlider def={s} w={w} />
            ))}
            {items.map((it) => (
              <Item item={it} />
            ))}
          </div>
        )
      )}
    </div>
  );
}
