import { ChevronDown, ChevronUp, Info, PinOff } from 'lucide-preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { hereOpen, hoverCell, openPanel, pinCell, pinnedCell, sheet, world } from '../../state';
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
  const open = hereOpen.value;
  const setOpen = (v: boolean) => {
    hereOpen.value = v;
    // 收起卡片：不再钉住
    if (!v) pinCell(-1);
  };
  const pinned = pinnedCell.value >= 0;
  const ref = useRef<HTMLElement>(null);
  void hoverCell.value;
  void openPanel.value;
  const right = useAvoidPopover(ref);
  if (!w || sheet.value) return null;
  const style = right !== null ? { right: `${right}px` } : undefined;
  const cell = lastHoverCell();
  const line = cell >= 0 && cell < w.mesh.n ? hereLine(w, cell) : '鼠标移到地图上';
  if (!open) {
    return (
      <button class="here" ref={ref as never} style={style} onClick={() => setOpen(true)} title="为什么是这种生态">
        <Info />
        <span class="here-line">{line}</span>
        <ChevronUp />
      </button>
    );
  }
  return (
    <div class="here open" ref={ref as never} style={style}>
      <div class="here-head">
        <b class="grow">{pinned ? `钉住的格 #${pinnedCell.value}` : '这里是什么'}</b>
        {pinned && (
          <button class="icon-btn" onClick={() => pinCell(-1)} title="取消钉住，跟着鼠标">
            <PinOff />
          </button>
        )}
        <button class="icon-btn" onClick={() => setOpen(false)} title="关闭">
          <ChevronDown />
        </button>
      </div>
      <div class="here-body">
        <Inspector />
      </div>
    </div>
  );
}
