import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { clampNote, entryText, parseEntry, posForNumber } from './slider-entry';

// 滑块：全界面只有这一种（底部条、弹出面板、抽屉、向导都用它）。左边名字、滑轨、右边一直显示的数值。
// 拖动时 onDraft（地图上先画出估计的样子、数值跟着变），松手 onCommit；拖着时被取消（指针丢了、
// 底部条收起来了：Esc 取消了选择、按数字键换了工具）onCancel，地图上不留着拖到一半的样子。
// 左右方向键走一小步：onStep，没有时按位置走 6% 并 onCommit。
// stacked：面板里的样子——名字和数值一行，滑轨占满下一行，note 写在下面
// 第九十三轮：给了 textAt 的滑块点右边的数就能打字（回车、离开框生效，Esc 取消，超出范围停在那一头并说一句）。
// 打的数换成位置后和在滑轨上点一下一样：onDraft 一次、onCommit 一次（slider-entry.ts）；拖动的路上不调 textAt

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
  // 滑块在位置 p（0–1）写的字。给了它，右边的数就能点开打字：在每个位置写的数里找最接近的那一个（没有数的位置不算）
  textAt?: (pos: number) => string;
  // 点开时框里先写的字（省略时是 text 里的第一个数）：写出来的数带“万”“亿”、分东西经时给它确切的数
  entry?: string;
}

// 超出范围的那一句留多久
const NOTE_MS = 2600;

export function Slider(p: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef(p.pos);
  const [drag, setDrag] = useState(false);
  // 正在框里打的字（null：没在打）；打的数超出范围时说的一句
  const [typing, setTyping] = useState<string | null>(null);
  const [entryNote, setEntryNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string | null) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = null;
    setEntryNote(text);
    if (text) noteTimer.current = setTimeout(() => setEntryNote(null), NOTE_MS);
  };
  const canType = !!p.textAt && !p.disabled;
  // 框开着（回车之后框拿掉时还会来一次失去焦点：只算一次）
  const entering = useRef(false);
  const startTyping = () => {
    entering.current = true;
    setTyping(p.entry ?? entryText(p.text));
  };
  const enter = (raw: string) => {
    if (!entering.current) return;
    entering.current = false;
    setTyping(null);
    const x = parseEntry(raw);
    if (x === null || !p.textAt) return;
    const hit = posForNumber(p.textAt, x);
    if (!hit) return;
    p.onDraft?.(hit.pos);
    p.onCommit(hit.pos);
    say(clampNote(hit));
  };
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
      if (noteTimer.current) clearTimeout(noteTimer.current);
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
      {typing !== null ? (
        <input
          class="slider-value slider-entry"
          type="text"
          inputMode="decimal"
          aria-label={`${p.label}的数`}
          value={typing}
          ref={(el) => {
            // 刚点开时选中全部，直接打字就是换掉
            if (el && document.activeElement !== el) {
              el.focus();
              el.select();
            }
          }}
          onInput={(e) => setTyping((e.target as HTMLInputElement).value)}
          onBlur={(e) => enter((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              enter((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              // 只取消这个框：不往外传（面板、选中的东西不跟着关）
              e.preventDefault();
              e.stopPropagation();
              entering.current = false;
              setTyping(null);
            }
          }}
        />
      ) : canType ? (
        <span
          class={`slider-value can-type ${p.changed ? 'changed' : ''}`}
          role="button"
          tabIndex={0}
          title="点一下输入确切的数"
          onClick={startTyping}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            startTyping();
          }}
        >
          {p.text}
        </span>
      ) : (
        <span class={`slider-value ${p.changed ? 'changed' : ''}`}>{p.text}</span>
      )}
      {entryNote && (
        <span class="slider-entry-note" role="status">
          {entryNote}
        </span>
      )}
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
