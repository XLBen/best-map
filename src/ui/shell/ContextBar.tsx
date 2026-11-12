import { ChevronsLeft, ChevronsRight, Ellipsis, Eraser, Pipette, Ruler } from 'lucide-preact';
import { roundKm } from '../../../core/terrain';
import type { World } from '../../../core/world';
import { type PanelId, erasing, measure, openPanel, options, picking, setOptions, togglePanel, tool, world } from '../../state';
import { panelOf } from '../defs/panel-registry';
import { CATEGORY_DEFS, TOOL_DEFS, barTools, category, eraserModes, setTool, toolKey, toolsPlace } from '../defs/tools';
import { BRUSH } from '../defs/tool-sliders';
import type { BarItem, SliderDef } from '../defs/types';
import { pathKm } from '../tools';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import { SIMPLE_TEXT, TOUCH_TEXT } from '../copy';
import { held, howForTouch, setHeld, touchUi } from '../touch-ui';
import { setRestOpen } from '../ui-prefs';
import { OptionSlider } from './OptionSlider';
import { useLayoutEffect } from 'preact/hooks';
import { bottomBarRef, dropBarClear, trackBarClear } from './bottom-bar';

// 底部条：上一行是这一类的工具（点一下就换，末尾“⋯”是这一类的设置；工具做什么写在工具按钮的悬停里；
// 第九十九轮：简单界面里只露常用的，末尾“还有 N 个”，见 defs/simple-ui.ts），
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
  const R = panelOf(item.panel);
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
          title="吸管（I）：照点到的那处接着画"
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
        <Seg<'auto' | 'clear'> value={on} options={modes.map((k) => [k, ERASE_NAMES[k]])} titles={{ auto: '擦除手改的，恢复自动', clear: CLEAR_HINTS[id] }} onChange={(v) => (erasing.value = v)} />
      )}
      {on && modes.length === 1 && <span class="bar-note">{ERASE_NAMES[on]}</span>}
    </>
  );
}

// 第一百轮：没有键盘的人按不了 Shift、Alt。这个工具用得上它们时（工具表的 mods：多选、汇入……），触摸设备上这里各一个开关，
// 开着时地图上的每一下都当作按着那个键；换工具就关上。鼠标下不露（那里有键盘）
function HeldToggles() {
  const mods = TOOL_DEFS[tool.value].mods;
  if (!mods || !touchUi()) return null;
  const h = held.value;
  return (
    <>
      {(['shift', 'alt'] as const).map((k) => {
        const m = mods[k];
        return m ? (
          <Toggle on={h[k]} onChange={(on) => setHeld(k, on)} title={m.title}>
            {m.label}
          </Toggle>
        ) : null;
      })}
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
      {/* 第一百轮：Backspace 的那一下（删除最后一点）触摸设备上有按钮 */}
      {touchUi() && (
        <button class="bar-btn" disabled={!pts.length} onClick={() => (measure.value = pts.slice(0, -1))} title={TOUCH_TEXT.measureBackTip}>
          {TOUCH_TEXT.measureBack}
        </button>
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
  // 第一百轮：底部条有多高记在 .app 上（--bar-clear），触摸设备上别的东西据此让出它
  useLayoutEffect(trackBarClear);
  useLayoutEffect(() => dropBarClear, []);
  if (!w) return null;
  const c = category.value;
  const cat = CATEGORY_DEFS[c];
  const def = TOOL_DEFS[tool.value];
  // 橡皮擦开着：只剩直径，这个工具自己的选项先收起来
  const erase = erasing.value !== null && eraserModes(tool.value).includes(erasing.value);
  const sliders = erase ? [BRUSH] : [def.size, def.amount].filter((s): s is SliderDef => !!s && s.enabled?.(w) !== false);
  const items = erase ? [] : (def.bar?.(w) ?? []);
  const more: PanelId = `cat:${c}`;
  const bar = barTools(c, w);
  // 指针（第二十五轮）没有底部条（量距离时照旧显示量出来的数）
  if (c === 'inspect')
    return measure.value ? (
      <div class="bottombar" ref={bottomBarRef}>
        <MeasureRow w={w} pts={measure.value} />
      </div>
    ) : null;
  return (
    <div class="bottombar" ref={bottomBarRef}>
      <div class="bb-row bb-tools">
        {bar.shown.map((id) => {
          const t = TOOL_DEFS[id];
          const I = t.icon;
          // 括号里是它的数字键：按完整的那一排数，简单界面里藏了几个也不换位
          const k = toolKey(id, w);
          return (
            <button class={`bb-tool ${tool.value === id ? 'on' : ''}`} data-tool={id} onClick={() => setTool(id)} title={`${t.name}：${t.how}${k ? `（${k}）` : ''}`}>
              <I />
              <span>{t.short}</span>
            </button>
          );
        })}
        {/* 第九十九轮：简单界面里这一类还有几个工具没露着。点了只在这一排展开；展开着时换成“只留常用的” */}
        {bar.hidden.length > 0 && (
          <button class="bb-tool bb-rest" data-rest={bar.hidden.length} onClick={() => setRestOpen(toolsPlace(c), true)} title={SIMPLE_TEXT.restTip(bar.hidden.map((id) => TOOL_DEFS[id].name))}>
            <ChevronsRight />
            <span>{SIMPLE_TEXT.restShort(bar.hidden.length)}</span>
          </button>
        )}
        {bar.foldable > 0 && (
          <button class="bb-tool bb-rest open" onClick={() => setRestOpen(toolsPlace(c), false)} title={SIMPLE_TEXT.always}>
            <ChevronsLeft />
            <span>{SIMPLE_TEXT.fold}</span>
          </button>
        )}
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
          {!erase && <HeldToggles />}
          <PickEraseRow />
        </div>
      )}
      {/* 第一百轮：工具做什么平时在按钮的悬停里；手指没有悬停，触摸设备上写在这里 */}
      {touchUi() && !measure.value && <p class="hint bb-how">{howForTouch(def.how)}</p>}
    </div>
  );
}
