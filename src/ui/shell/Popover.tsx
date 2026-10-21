import { X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';
import { type PanelId, openPanel } from '../../state';

// 挂在按钮旁边的弹出面板：顶栏的按钮往下开，底部条的按钮往上开。
// 同一时间只开一个；再点按钮、Esc、点地图或面板外面都会关上

interface Place {
  left: number;
  // 往下开时是 top，往上开时是 bottom（离窗口底边）
  top?: number;
  bottom?: number;
  arrow: number;
  width: number;
}

export function Popover({ id, title, width = 340, children }: { id: PanelId; title: string; width?: number; children: ComponentChildren }) {
  const [pos, setPos] = useState<Place | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      const anchor = document.querySelector(`[data-panel="${id}"]`);
      if (!anchor) {
        setPos({ left: (vw - w) / 2, top: 64, arrow: w / 2, width: w });
        return;
      }
      const r = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
      const arrow = Math.max(16, Math.min(w - 16, r.left + r.width / 2 - left));
      setPos(r.top > vh / 2 ? { left, bottom: vh - r.top + 10, arrow, width: w } : { left, top: r.bottom + 10, arrow, width: w });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [id, width]);
  if (!pos) return null;
  const up = pos.bottom !== undefined;
  return (
    <div
      class={`popover ${up ? 'up' : ''}`}
      style={{ left: `${pos.left}px`, width: `${pos.width}px`, ...(up ? { bottom: `${pos.bottom}px` } : { top: `${pos.top}px` }) }}
    >
      <span class="popover-arrow" style={{ left: `${pos.arrow}px` }} />
      <div class="popover-head">
        <b>{title}</b>
        <button class="icon-btn" onClick={() => (openPanel.value = null)} title="关上（Esc）">
          <X size={16} />
        </button>
      </div>
      <div class="popover-body">{children}</div>
    </div>
  );
}
