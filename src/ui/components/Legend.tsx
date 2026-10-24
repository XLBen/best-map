import { ChevronDown, ChevronUp } from 'lucide-preact';

// 图例（第二十一轮）：色块 + 名字（+ 占多少），可以收起。按类着色的底图都用它（地形类别、资源、生态分区，以后的文化、国家）

export interface LegendItem {
  color: string;
  label: string;
  // 有几格：都写了时右边写占多少（百分比）
  count?: number;
}

const pct = (v: number) => (v >= 0.095 ? `${Math.round(v * 100)}%` : v >= 0.0005 ? `${(v * 100).toFixed(1)}%` : '<0.1%');

export function Legend({ title, items, open, onToggle, style }: { title: string; items: LegendItem[]; open: boolean; onToggle: () => void; style?: Record<string, string> }) {
  const total = items.every((it) => it.count !== undefined) ? items.reduce((a, it) => a + (it.count ?? 0), 0) : 0;
  return (
    <div class={`legend ${open ? 'open' : ''}`} style={style}>
      <button class="legend-head" onClick={onToggle} title={open ? '收起' : '展开'}>
        <span class="grow">{title}</span>
        {open ? <ChevronDown /> : <ChevronUp />}
      </button>
      {open && (
        <div class="legend-list">
          {items.map((it) => (
            <div class="legend-item" key={it.label}>
              <span class="swatch" style={{ background: it.color }} />
              <span class="grow">{it.label}</span>
              {total > 0 && <span class="hint">{pct((it.count ?? 0) / total)}</span>}
            </div>
          ))}
          {!items.length && <p class="hint">没有</p>}
        </div>
      )}
    </div>
  );
}
