import { X } from 'lucide-preact';
import { sheet } from '../../state';
import { SpeciesPanel } from '../ClimateChart';
import { CountryArchive } from '../CountryArchive';

// 右边的抽屉：生态类型编辑、国家的档案（第二十三轮）。点地图不会关上，可以一边改一边看地图怎么变

const TITLES = { species: '生态类型', country: '国家档案' } as const;

export function Sheet() {
  const s = sheet.value;
  if (!s) return null;
  return (
    <div class="sheet">
      <div class="popover-head">
        <b>{TITLES[s]}</b>
        <button class="icon-btn" onClick={() => (sheet.value = null)} title="关闭">
          <X />
        </button>
      </div>
      <div class="sheet-body">{s === 'species' ? <SpeciesPanel /> : <CountryArchive />}</div>
    </div>
  );
}
