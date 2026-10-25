import type { MapKind as Kind } from '../../state';
import { mapKind, world } from '../../state';
import { Seg } from '../common';
import { hasCountries, setMapKind } from '../countries';

// 右上角、顶栏下面（第二十三轮）：地理图 / 人文图。有国家时才有（没有国家的世界两种一样）

export const MAP_KINDS: [Kind, string][] = [
  ['geo', '地理'],
  ['political', '人文'],
];
export const MAP_KIND_TITLES: Record<Kind, string> = {
  geo: '地貌与自然的地名',
  political: '国界、国名、城市与地标',
};

export function MapKindSwitch() {
  const w = world.value;
  if (!w || !hasCountries(w)) return null;
  return (
    <div class="map-kind">
      <Seg value={mapKind.value} options={MAP_KINDS} titles={MAP_KIND_TITLES} onChange={setMapKind} />
    </div>
  );
}
