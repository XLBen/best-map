import { useEffect, useState } from 'preact/hooks';
import { Slider, linear } from './Slider';

// 一段范围（第五十五轮，生态的高度范围）：“最低”“最高”两个滑块，到两头写“不限”。
// 拖动时先显示拖到的数，松手才提交；两个滑块不会交叉（拖过去时另一个跟着走）
export interface Range {
  low: number;
  high: number;
}

export function rangeText(v: number, lo: number, hi: number, unit: string): string {
  return v <= lo || v >= hi ? '不限' : `${v} ${unit}`;
}

// 拖“最低”（which 为 low）或“最高”到 v 之后的范围
export function moveRange(r: Range, which: keyof Range, v: number): Range {
  return which === 'low' ? { low: v, high: Math.max(r.high, v) } : { low: Math.min(r.low, v), high: v };
}

// scale：滑块的刻度（省略时等间距；范围很大的流量用对数）
export function RangeSliders(p: { lo: number; hi: number; step: number; unit: string; value: Range; onCommit: (r: Range) => void; scale?: { pos: (v: number) => number; at: (p: number) => number } }) {
  const scale = p.scale ?? linear(p.lo, p.hi, p.step);
  const [draft, setDraft] = useState<Range | null>(null);
  useEffect(() => setDraft(null), [p.value.low, p.value.high]);
  const now = draft ?? p.value;
  const one = (which: keyof Range, label: string) => (
    <Slider
      stacked
      label={label}
      pos={scale.pos(now[which])}
      text={rangeText(now[which], p.lo, p.hi, p.unit)}
      changed={draft !== null && draft[which] !== p.value[which]}
      onDraft={(pos) => setDraft(moveRange(p.value, which, scale.at(pos)))}
      onCommit={(pos) => {
        const next = moveRange(p.value, which, scale.at(pos));
        if (next.low === p.value.low && next.high === p.value.high) return setDraft(null);
        setDraft(next);
        p.onCommit(next);
      }}
      onCancel={() => setDraft(null)}
    />
  );
  return (
    <div class="range-sliders">
      {one('low', '最低')}
      {one('high', '最高')}
    </div>
  );
}
