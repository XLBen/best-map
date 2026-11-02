import type { ComponentChildren } from 'preact';
import { ChevronDown, ChevronUp } from 'lucide-preact';

// 图例（第二十一轮）：色块 + 名字（+ 占多少），可以收起。按类着色的底图都用它（地形类别、资源、生态分区，以后的文化、国家）

export interface LegendItem {
  color: string;
  label: string;
  // 有几格：都写了时右边写占多少（百分比）
  count?: number;
  // 画成一小段线（第四十六轮，风与洋流的流线）：线宽（像素），色块是暗底上的这段线
  line?: number;
}

const pct = (v: number) => (v >= 0.095 ? `${Math.round(v * 100)}%` : v >= 0.0005 ? `${(v * 100).toFixed(1)}%` : '<0.1%');

// children：列表上面的控件（第四十八轮：风的季节）；hint：列表下面的一句话
export function Legend({ title, items, open, onToggle, style, children, hint, wide }: { title: string; items: LegendItem[]; open: boolean; onToggle: () => void; style?: Record<string, string>; children?: ComponentChildren; hint?: string; wide?: boolean }) {
  const total = items.every((it) => it.count !== undefined) ? items.reduce((a, it) => a + (it.count ?? 0), 0) : 0;
  return (
    <div class={`legend ${open ? 'open' : ''} ${wide ? 'wide' : ''}`} style={style}>
      <button class="legend-head" onClick={onToggle} title={open ? '收起' : '展开'}>
        <span class="grow">{title}</span>
        {open ? <ChevronDown /> : <ChevronUp />}
      </button>
      {open && (
        <div class="legend-list">
          {children}
          {items.map((it) => (
            <div class="legend-item" key={it.label}>
              {it.line ? (
                <span class="swatch line">
                  <span style={{ background: it.color, height: `${it.line}px` }} />
                </span>
              ) : (
                <span class="swatch" style={{ background: it.color }} />
              )}
              <span class="grow">{it.label}</span>
              {total > 0 && <span class="hint">{pct((it.count ?? 0) / total)}</span>}
            </div>
          ))}
          {!items.length && <p class="hint">没有</p>}
          {hint && <p class="hint">{hint}</p>}
        </div>
      )}
    </div>
  );
}
