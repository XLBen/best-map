import { world } from '../../state';
import { Seg } from '../common';
import { type MapKind, mapKind, mapModes, setMapKind } from '../map/modes';

// 右上角、顶栏下面（第二十五轮）：地图模式，一排小按钮——地理、国家、文化、文化组、时代的每一维、人口。
// 生成过人文才有（没有国家时没有“国家”）。放在顶栏里单独一行、靠右（顶栏换行时跟着往下）；窄屏时横着滚
export function MapKindSwitch() {
  const modes = mapModes(world.value);
  if (!modes.length) return null;
  return (
    <div class="map-kind">
      <Seg<MapKind>
        value={mapKind.value}
        options={modes.map((m): [MapKind, string] => [m.id, m.label])}
        titles={Object.fromEntries(modes.map((m) => [m.id, m.title]))}
        onChange={setMapKind}
      />
    </div>
  );
}
