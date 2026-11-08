import { ChevronDown, Map as MapIcon } from 'lucide-preact';
import { openPanel, togglePanel, world } from '../../state';
import { Seg } from '../common';
import { type MapKind, mapKind, mapModes, modeButtonOf, setMapKind } from '../map/modes';

// 地图模式（第二十五轮）：地理、国家、同盟、文化、文化组、时代的每一维、人口。生成过人文才有（没有国家时没有“国家”）。
// 第八十二轮：不再是顶栏下面单独的一排——分类那一组最后一个按钮写着现在的模式，点开一个小菜单（MapKindMenu）；
// “图层”面板最上面一段也能换（MapKindSwitch）

// 分类那一组最后：写着现在的模式（“国家模式”：和旁边的“国家”一类分得开），点开菜单
export function MapKindButton() {
  const b = modeButtonOf(world.value, mapKind.value);
  if (!b) return null;
  return (
    <button class={`tb-btn ${openPanel.value === 'mapkind' ? 'open' : ''}`} data-panel="mapkind" onClick={() => togglePanel('mapkind')} title={b.title}>
      <MapIcon size={18} />
      <span class="tb-label">{b.label}</span>
      <ChevronDown size={14} class="tb-chevron" />
    </button>
  );
}

// 点开的菜单：一行一种，名字下面一行说明；选了就关上
export function MapKindMenu() {
  const modes = mapModes(world.value);
  return (
    <div class="menu">
      {modes.map((m) => (
        <button
          key={m.id}
          class={`item ${mapKind.value === m.id ? 'on' : ''}`}
          onClick={() => {
            setMapKind(m.id);
            openPanel.value = null;
          }}
        >
          <span class="grow item-text">
            <b>{m.label}</b>
            <span class="hint">{m.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// “图层”面板最上面“地图模式”一段里：一排分段按钮（放不下时换行）
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
        wide
      />
    </div>
  );
}
