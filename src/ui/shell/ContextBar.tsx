import { Ellipsis, Eraser, Pipette, Ruler } from 'lucide-preact';
import { roundKm } from '../../../core/terrain';
import type { World } from '../../../core/world';
import { type PanelId, erasing, measure, openPanel, options, picking, setOptions, togglePanel, tool, world } from '../../state';
import { BRUSH, CATEGORY_DEFS, TOOL_DEFS, category, eraserModes, setTool, toolsOf } from '../defs/tools';
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

// 第二十七轮：第二行末尾的吸管与橡皮擦（所有笔刷共用）。吸管点一下，下一次点地图是吸取，吸完回到原来的笔刷；
// 橡皮擦开着时笔刷换成它（只剩直径），旁边选恢复自动还是清空（只有恢复自动时只写这几个字）
const ERASE_NAMES = { auto: '恢复自动', clear: '清空' } as const;
const CLEAR_HINTS: Partial<Record<string, string>> = { territory: '涂成无主地', pop: '这里没有人', culture: '这里没有人', resource: '这里没有资源' };

function PickEraseRow() {
  const id = tool.value;
  const def = TOOL_DEFS[id];
  const modes = eraserModes(id);
  const on = erasing.value;
  return (
    <>
      {def.pick && (
        <button
          class={`bar-btn icon ${picking.value ? 'on' : ''}`}
          onClick={() => {
            picking.value = !picking.value;
            if (picking.value) erasing.value = null;
          }}
          title="吸管：点地图上一处，用那里的接着画（I；也可以按住 Alt 点）"
        >
          <Pipette />
        </button>
      )}
      {modes.length > 0 && (
        <button
          class={`bar-btn icon ${on ? 'on' : ''}`}
          onClick={() => {
            erasing.value = on ? null : modes[0];
            picking.value = false;
          }}
          title="橡皮擦（E）"
        >
          <Eraser />
        </button>
      )}
      {on && modes.length > 1 && (
        <Seg<'auto' | 'clear'> value={on} options={modes.map((k) => [k, ERASE_NAMES[k]])} titles={{ auto: '去掉手改的，回到自动的样子', clear: CLEAR_HINTS[id] }} onChange={(v) => (erasing.value = v)} />
      )}
      {on && modes.length === 1 && <span class="bar-note">{ERASE_NAMES[on]}</span>}
    </>
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
        <Ruler />
        量距离
      </span>
      {pts.length < 2 ? (
        <span class="bar-note">{w.settings.globe ? '点几个点，沿最短的弧线量总长' : '点几个点量总长'}</span>
      ) : (
        <span class="bar-value">
          共 {roundKm(total).toLocaleString()} km{straight ? ` · 直线 ${roundKm(straight).toLocaleString()} km` : ''} · <span title={`每天 ${WALK_KM_PER_DAY} km`}>步行{walk}</span>
        </span>
      )}
      <button class="bar-btn" disabled={!pts.length} onClick={() => (measure.value = [])} title="Backspace 删除最后一点">
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
  // 橡皮擦开着：只剩直径，这个工具自己的选项先收起来
  const erase = erasing.value !== null && eraserModes(tool.value).includes(erasing.value);
  const sliders = erase ? [BRUSH] : [def.size, def.amount].filter((s): s is SliderDef => !!s && s.enabled?.(w) !== false);
  const items = erase ? [] : (def.bar?.(w) ?? []);
  const more: PanelId = `cat:${c}`;
  // 指针（第二十五轮）没有底部条（量距离时照旧显示量出来的数）
  if (c === 'inspect')
    return measure.value ? (
      <div class="bottombar">
        <MeasureRow w={w} pts={measure.value} />
      </div>
    ) : null;
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
          <button class={`bb-tool more ${openPanel.value === more ? 'open' : ''}`} data-panel={more} onClick={() => togglePanel(more)} title={`${cat.label}设置`}>
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
          <PickEraseRow />
        </div>
      )}
    </div>
  );
}
