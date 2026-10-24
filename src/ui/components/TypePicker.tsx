import { ChevronDown, Plus } from 'lucide-preact';
import { type PanelId, openPanel, togglePanel } from '../../state';

// 选“哪一种”：底部条上的按钮（“新画的河：血河 ▾”“岛：珊瑚岛 ▾”）和点开的列表（最后一项“新建…”）。
// 河、湖、岛（放岛、岛链）六个弹出的列表都是它，只是种类表不一样

export interface TypeChoice {
  label: string;
  // 色块的颜色（没有时不画：地名风格）
  swatch?: string;
  on: boolean;
  hint?: string;
  // 右边灰色的一小段（画法、形状）
  meta?: string;
  // 分组（第二十二轮：文化按文化组列）：与上一行不同时先写一行小标题
  group?: string;
  onPick: () => void;
}

// 弹出的列表：几行选择，最后一项新建（新建一种、用上它，并打开它的设置）
export function TypePicker({ items, onNew, newLabel, newTitle, note }: { items: TypeChoice[]; onNew: () => void; newLabel: string; newTitle: string; note?: string }) {
  return (
    <div class="menu">
      {items.map((it, k) => (
        <>
          {it.group !== undefined && it.group !== items[k - 1]?.group && <h5 class="menu-group">{it.group}</h5>}
          <button key={`${it.group ?? ''}:${it.label}`} class={`item ${it.on ? 'on' : ''}`} title={it.hint} onClick={it.onPick}>
            {it.swatch !== undefined && <span class="swatch" style={{ background: it.swatch }} />}
            <span class="grow">{it.label}</span>
            {it.meta && <span class="hint">{it.meta}</span>}
          </button>
        </>
      ))}
      <button class="item" onClick={onNew} title={newTitle}>
        <Plus />
        <span class="grow">{newLabel}</span>
      </button>
      {note && <p class="hint">{note}</p>}
    </div>
  );
}

// 底部条上的按钮：“前缀：色块 名字 ▾”。auto：现在是按规则判断出来的
export function TypePickerButton({ panel, prefix, swatch, name, auto, title }: { panel: PanelId; prefix: string; swatch?: string; name: string; auto?: boolean; title: string }) {
  return (
    <button class={`bar-btn ${openPanel.value === panel ? 'open' : ''}`} data-panel={panel} onClick={() => togglePanel(panel)} title={title}>
      <span class="muted">{prefix}：</span>
      {swatch !== undefined && <span class="swatch" style={{ background: swatch }} />} {name}
      {auto ? <span class="hint">（自动）</span> : null}
      <ChevronDown />
    </button>
  );
}
