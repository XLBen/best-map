import { TriangleAlert } from 'lucide-preact';
import { focusSpecies, openPanel, options, sheet, world } from '../../state';
import { UnmetPanel } from '../panels';
import { endemicPicked, removePickedEndemic } from '../tools';

// 注册表里引用的几个小部件：底部条上的当前生态、“没涂成”的提醒，工具列表下方的设置
export { NamesBar, NamesExtras } from '../panels/names';
export { RiverBar, RiverExtras, RiverPendingBar } from '../panels/rivers';
export { NewRiverTypePick } from '../panels/riverTypes';
export { LakeBar, NewLakeTypePick } from '../panels/lakes';
export { ProvinceBar, ProvinceColorToggle, ProvinceExtras } from '../provincePanel';

// 当前要涂的生态：点开是色板（与顶栏“生态”是同一个面板）
export function BiomeChip() {
  const w = world.value;
  const sp = w?.small.species.find((s) => s.id === options.value.biome);
  return (
    <button class={`bar-btn biome-chip ${sp ? '' : 'warn'}`} onClick={() => (openPanel.value = 'biome')} title="换一种生态">
      <span class="swatch" style={{ background: sp?.color ?? 'transparent' }} />
      {sp ? sp.name || sp.id : '选一种生态'}
    </button>
  );
}

// 有没涂成的格时出现；点开就是“自然”工具列表下方的那一栏
export function UnmetChip() {
  const n = world.value?.derived.conflicts.length ?? 0;
  if (!n) return null;
  return (
    <button class="bar-btn warn" onClick={() => (openPanel.value = 'cat:nature')}>
      <TriangleAlert size={15} /> {n} 处没涂成
    </button>
  );
}

// 岛上特有：点了一个已有特有生态的岛，底部条写出它是哪一种，给“去掉它”（删掉这种生态，可撤销）
export function EndemicBar() {
  const pick = endemicPicked.value;
  const sp = pick ? world.value?.small.species.find((s) => s.id === pick.id) : null;
  if (!sp) return null;
  return (
    <>
      <span class="bar-value">
        <span class="swatch" style={{ background: sp.color }} /> 已有：{sp.name}
      </span>
      <button class="bar-btn" onClick={() => void removePickedEndemic()} title="删掉这种生态，岛上换回原来的；可以撤销">
        去掉它
      </button>
      <button
        class="bar-btn"
        onClick={() => {
          focusSpecies.value = sp.id;
          sheet.value = 'species';
        }}
      >
        编辑
      </button>
    </>
  );
}

export function NatureExtras() {
  return <UnmetPanel />;
}
