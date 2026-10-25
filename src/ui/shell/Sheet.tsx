import { X } from 'lucide-preact';
import { BLOC_NAMES, blocById } from '../../../core/human';
import { selectedBloc, selectedSettle, sheet, world } from '../../state';
import { BlocArchive } from '../BlocArchive';
import { SpeciesPanel } from '../ClimateChart';
import { CountryArchive } from '../CountryArchive';
import { SETTLE_TITLES, SettleArchive } from '../SettleArchive';

// 右边的抽屉：生态类型编辑、国家的档案（第二十三轮）、城市、地标、自定义点的档案（第二十四轮）、帝国、联邦、同盟的档案（第二十六轮）。
// 点地图不会关上，可以一边改一边看地图怎么变

const TITLES = { species: '生态类型', country: '国家档案' } as const;

export function Sheet() {
  const s = sheet.value;
  if (!s) return null;
  const bloc = s === 'bloc' && world.value && selectedBloc.value !== null ? blocById(world.value.small, selectedBloc.value) : undefined;
  const title = s === 'settle' ? SETTLE_TITLES[selectedSettle.value?.kind ?? 'city'] : s === 'bloc' ? `${BLOC_NAMES[bloc?.kind ?? 'alliance']}档案` : TITLES[s];
  return (
    <div class="sheet">
      <div class="popover-head">
        <b>{title}</b>
        <button class="icon-btn" onClick={() => (sheet.value = null)} title="关闭">
          <X />
        </button>
      </div>
      <div class="sheet-body">{s === 'species' ? <SpeciesPanel /> : s === 'country' ? <CountryArchive /> : s === 'bloc' ? <BlocArchive /> : <SettleArchive />}</div>
    </div>
  );
}
