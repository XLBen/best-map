import { ChevronDown, ChevronUp, Info } from 'lucide-preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { hoverCell, openPanel, sheet, world } from '../../state';
import { Inspector, hereLine, lastHoverCell } from '../Inspector';

// 右下角“这里”：鼠标下的一行简介，点开是完整的“这里是什么、为什么”

// 弹出面板（图层等）打开着、和卡片叠在一起时，卡片挪到面板左边（第十三轮修：以前叠在一起，看着像卡片压在面板上）
function useAvoidPopover(ref: { current: HTMLElement | null }): number | null {
  const [right, setRight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      const pop = document.querySelector('.popover');
      let next: number | null = null;
      if (el && pop) {
        const a = el.getBoundingClientRect();
        const b = pop.getBoundingClientRect();
        // 按没挪时的位置比（right: 12px）
        const vw = window.innerWidth;
        const overlap = vw - 12 - a.width < b.right && b.left < vw - 12 && a.top < b.bottom && b.top < a.bottom;
        if (overlap) next = Math.max(12, vw - b.left + 8);
      }
      setRight((r) => (r === next ? r : next));
    };
    measure();
    // 面板的位置在它自己的 effect 里才定下来：下一帧再看一次
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  });
  return right;
}

export function HereCard() {
  const w = world.value;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  void hoverCell.value;
  void openPanel.value;
  const right = useAvoidPopover(ref);
  if (!w || sheet.value) return null;
  const style = right !== null ? { right: `${right}px` } : undefined;
  const cell = lastHoverCell();
  const line = cell >= 0 && cell < w.mesh.n ? hereLine(w, cell) : '把鼠标移到地图上看看那是什么地方';
  if (!open) {
    return (
      <button class="here" ref={ref as never} style={style} onClick={() => setOpen(true)} title="点开看详细：为什么是这种生态、为什么不是别的">
        <Info size={15} />
        <span class="here-line">{line}</span>
        <ChevronUp size={14} />
      </button>
    );
  }
  return (
    <div class="here open" ref={ref as never} style={style}>
      <div class="here-head">
        <b>这里是什么</b>
        <button class="icon-btn" onClick={() => setOpen(false)} title="收起">
          <ChevronDown size={16} />
        </button>
      </div>
      <div class="here-body">
        <Inspector />
      </div>
    </div>
  );
}
