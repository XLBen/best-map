import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { World } from '../../../core/world';
import { options, setOptions, sliderActive } from '../../state';
import type { SliderDef } from '../defs/types';
import { nudgeSlider, sliderPos, sliderValue } from '../shell/sliders';

// 滑块：全界面只有这一种（底部条、弹出面板、抽屉、向导都用它）。左边名字、滑轨、右边一直显示的数值。
// 拖动时 onDraft（地图上先画出估计的样子、数值跟着变），松手 onCommit；拖着时被取消（指针丢了、
// 底部条收起来了：Esc 取消了选择、按数字键换了工具）onCancel，地图上不留着拖到一半的样子。
// 左右方向键走一小步：onStep，没有时按位置走 6% 并 onCommit。
// stacked：面板里的样子——名字和数值一行，滑轨占满下一行，note 写在下面

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface SliderProps {
  label: string;
  // 滑块的位置 0–1
  pos: number;
  // 右边的数值
  text: string;
  title?: string;
  // 最左边这一段是一个单独的选择（河的“顺其自然”）：滑轨上淡淡地标出来
  detent?: number;
  disabled?: boolean;
  // 数值和现在世界上的不一样（拖着、还没松手）：数值用强调色
  changed?: boolean;
  stacked?: boolean;
  note?: ComponentChildren;
  onDraft?: (p: number) => void;
  onCommit: (p: number) => void;
  onCancel?: () => void;
  onStep?: (dir: 1 | -1) => void;
}

export function Slider(p: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef(p.pos);
  const [drag, setDrag] = useState(false);
  // 收起来时用最新的 onCancel
  const cancel = useRef(p.onCancel);
  cancel.current = p.onCancel;
  const at = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    return clamp01((e.clientX - r.left) / r.width);
  };
  const stop = (commit: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    setDrag(false);
    if (commit) p.onCommit(last.current);
    else p.onCancel?.();
  };
  useEffect(
    () => () => {
      if (dragging.current) cancel.current?.();
    },
    [],
  );
  const pos = clamp01(p.pos);
  return (
    <div class={`slider ${p.stacked ? 'stacked' : ''} ${drag ? 'drag' : ''} ${p.disabled ? 'off' : ''}`} title={p.title}>
      <span class="slider-label">{p.label}</span>
      <div
        class="slider-track"
        ref={track}
        tabIndex={p.disabled ? -1 : 0}
        role="slider"
        aria-label={p.label}
        aria-valuetext={p.text}
        aria-valuenow={Math.round(pos * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-disabled={p.disabled}
        onPointerDown={(e) => {
          if (p.disabled) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
          setDrag(true);
          last.current = at(e);
          p.onDraft?.(last.current);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          last.current = at(e);
          p.onDraft?.(last.current);
        }}
        onPointerUp={() => stop(true)}
        onPointerCancel={() => stop(false)}
        onKeyDown={(e) => {
          if (p.disabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          if (p.onStep) p.onStep(dir);
          else p.onCommit(clamp01(pos + dir * 0.06));
        }}
      >
        {p.detent !== undefined && <div class="slider-detent" style={{ width: `${p.detent * 100}%` }} />}
        <div class="slider-fill" style={{ width: `${pos * 100}%` }} />
        <div class="slider-thumb" style={{ left: `calc((100% - var(--thumb)) * ${pos})` }} />
      </div>
      <span class={`slider-value ${p.changed ? 'changed' : ''}`}>{p.text}</span>
      {p.note && <span class="hint slider-note">{p.note}</span>}
    </div>
  );
}

// 等间距的滑块：值与位置互换，按步长取整（避免 0.30000000000000004 这样的数）
export function linear(lo: number, hi: number, step: number) {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return {
    pos: (v: number) => clamp01((v - lo) / (hi - lo)),
    at: (p: number) => Math.min(hi, Math.max(lo, Number((Math.round((lo + (hi - lo) * clamp01(p)) / step) * step).toFixed(digits)))),
  };
}

// 底部条上工具的滑块（直径、力度……）：值在 options 里；拖动时地图在鼠标最后停的地方预览（sliderActive）
export function OptionSlider({ def, w }: { def: SliderDef; w: World }) {
  const value = options.value[def.key];
  const done = () => (sliderActive.value = false);
  return (
    <Slider
      label={def.label}
      pos={sliderPos(def, w, value)}
      text={def.format(value, w)}
      onDraft={(p) => {
        sliderActive.value = true;
        setOptions({ [def.key]: sliderValue(def, w, p) });
      }}
      onCommit={done}
      onCancel={done}
      onStep={(dir) => nudgeSlider(def, dir)}
    />
  );
}
