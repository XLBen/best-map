import { ChevronDown, ChevronUp, Info } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { hoverCell, sheet, world } from '../../state';
import { Inspector, hereLine, lastHoverCell } from '../Inspector';

// 右下角“这里”：鼠标下的一行简介，点开是完整的“这里是什么、为什么”

export function HereCard() {
  const w = world.value;
  const [open, setOpen] = useState(false);
  void hoverCell.value;
  if (!w || sheet.value) return null;
  const cell = lastHoverCell();
  const line = cell >= 0 && cell < w.mesh.n ? hereLine(w, cell) : '把鼠标移到地图上看看那是什么地方';
  if (!open) {
    return (
      <button class="here" onClick={() => setOpen(true)} title="点开看详细：为什么是这种生态、为什么不是别的">
        <Info size={15} />
        <span class="here-line">{line}</span>
        <ChevronUp size={14} />
      </button>
    );
  }
  return (
    <div class="here open">
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
