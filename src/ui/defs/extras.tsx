import { TriangleAlert } from 'lucide-preact';
import { openPanel, options, world } from '../../state';
import { UnmetPanel } from '../panels';

// 注册表里引用的几个小部件：底部条上的当前生态、“没涂成”的提醒，工具列表下方的设置
export { NamesBar, NamesExtras } from '../panels/names';
export { RiverBar, RiverExtras, RiverPendingBar } from '../panels/rivers';
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

export function NatureExtras() {
  return <UnmetPanel />;
}
