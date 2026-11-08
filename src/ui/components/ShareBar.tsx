import { useEffect, useRef, useState } from 'preact/hooks';
import { percentText, shareDrag, sharesOf, dividersOf } from './share-bar';

// 一条分成几段的色条（第八十一轮）：几样各占多少（国家等级的比例……）。拖两段之间的分界改这两段，总数不变；
// 拖的时候数跟着变，松手才 onCommit 一次（交出去的是百分之几，和是 100）。左右方向键挪 1%。不认识世界
export interface SharePart {
  key: string;
  label: string;
}

export function ShareBar({ parts, values, onCommit, disabled }: { parts: readonly SharePart[]; values: readonly number[]; onCommit: (values: number[]) => void; disabled?: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<ReturnType<typeof shareDrag> | null>(null);
  const [draft, setDraft] = useState<number[] | null>(null);
  useEffect(() => setDraft(null), [values.join(',')]);
  const shares = draft ?? sharesOf(values);
  const dividers = dividersOf(shares);
  const at = (e: PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  };
  const finish = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const next = commit ? d.end() : null;
    if (next) onCommit(next);
    else setDraft(null);
  };
  const step = (k: number, dir: 1 | -1) => {
    const d = shareDrag(values, k);
    d.move(dividers[k] + dir * 0.01);
    const next = d.end();
    if (next) onCommit(next);
  };
  return (
    <div class={`ratio-bar ${disabled ? 'off' : ''}`}>
      <div class="ratio-track" ref={bar}>
        {parts.map((p, k) => (
          <span class={`ratio-seg c${k % 6}`} style={{ width: `${shares[k] * 100}%` }} title={`${p.label} ${percentText(shares[k])}`}>
            {shares[k] >= 0.1 && <span class="ratio-pct">{percentText(shares[k])}</span>}
          </span>
        ))}
        {dividers.map((x, k) => (
          <span
            class="ratio-divider"
            style={{ left: `${x * 100}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={`${parts[k].label} 与 ${parts[k + 1].label} 的分界`}
            aria-valuetext={`${percentText(shares[k])} / ${percentText(shares[k + 1])}`}
            onPointerDown={(e) => {
              if (disabled) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = shareDrag(values, k);
              setDraft(drag.current.move(at(e)));
            }}
            onPointerMove={(e) => {
              if (drag.current) setDraft(drag.current.move(at(e)));
            }}
            onPointerUp={() => finish(true)}
            onPointerCancel={() => finish(false)}
            onKeyDown={(e) => {
              if (disabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
              e.preventDefault();
              step(k, e.key === 'ArrowRight' ? 1 : -1);
            }}
          />
        ))}
      </div>
      <div class="ratio-legend">
        {parts.map((p, k) => (
          <span class="ratio-key">
            <span class={`swatch ratio-dot c${k % 6}`} />
            {p.label} <span class="hint">{percentText(shares[k])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
