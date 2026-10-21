import { X } from 'lucide-preact';
import { sheet } from '../../state';
import { SpeciesPanel } from '../ClimateChart';

// 右边的抽屉：生态类型编辑。点地图不会关上，可以一边拖色块一边看地图怎么变

export function Sheet() {
  if (sheet.value !== 'species') return null;
  return (
    <div class="sheet">
      <div class="popover-head">
        <b>生态类型</b>
        <button class="icon-btn" onClick={() => (sheet.value = null)} title="关上">
          <X size={16} />
        </button>
      </div>
      <div class="sheet-body">
        <SpeciesPanel />
      </div>
    </div>
  );
}
