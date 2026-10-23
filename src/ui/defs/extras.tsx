import { speciesColor } from '../../../core/species';
import { TriangleAlert } from 'lucide-preact';
import { activeConflicts } from '../../../core/constraints';
import { openPanel, options, world } from '../../state';
import { Seg } from '../common';
import { UnmetPanel, showIgnored } from '../panels';
import { cancelRangePick, rangePick } from '../tools';

// 注册表里引用的几个小部件：底部条上的当前生态、“没涂成”的提醒，工具列表下方的设置
export { NamesBar, NamesExtras } from '../panels/names';
export { RiverBar, RiverExtras } from '../panels/rivers';
export { NewRiverTypePick } from '../panels/riverTypes';
export { LakeBar, NewLakeTypePick } from '../panels/lakes';
export { ProvinceBar, ProvinceColorToggle, ProvinceExtras } from '../provincePanel';

// 当前要涂的生态：点开是色板（与顶栏“生态”是同一个面板）
export function BiomeChip() {
  const w = world.value;
  const sp = w?.small.species.find((s) => s.id === options.value.biome);
  return (
    <button class={`bar-btn biome-chip ${sp ? '' : 'warn'}`} onClick={() => (openPanel.value = 'biome')} title="换一种生态">
      <span class="swatch" style={{ background: sp ? speciesColor(sp) : 'transparent' }} />
      {sp ? sp.name || sp.id : '选一种生态'}
    </button>
  );
}

// 有没涂成的格时出现（说了“就这样”的不算）；点开就是“自然”工具列表下方的那一栏
export function UnmetChip() {
  const w = world.value;
  const n = w ? activeConflicts(w).length : 0;
  if (!n) return null;
  return (
    <button class="bar-btn warn" onClick={() => (openPanel.value = 'cat:nature')}>
      <TriangleAlert size={15} /> {n} 处没涂成
    </button>
  );
}

// 说了“就这样”的没涂成的地方（第十二轮）：收在一个“!”里，点开看列表（恢复提醒、强制、删掉）
export function IgnoredChip() {
  const n = world.value?.small.constraints.filter((c) => c.ignored).length ?? 0;
  if (!n) return null;
  return (
    <button
      class="bar-btn ignored-chip"
      title={`${n} 处没涂成的地方说了“就这样”：点开看`}
      onClick={() => {
        showIgnored.value = true;
        openPanel.value = 'cat:nature';
      }}
    >
      <b>!</b> {n}
    </button>
  );
}

// 选生态的范围时底部条：给哪种生态选、点岛 / 圈一片、取消
export function RangeBar() {
  const pick = rangePick.value;
  const sp = pick ? world.value?.small.species.find((s) => s.id === pick.species) : null;
  if (!pick) {
    return <span class="muted small">在生态编辑器里点“选岛”或“圈一下”</span>;
  }
  return (
    <>
      <span class="bar-value">
        <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? pick.species}
      </span>
      <Seg<'island' | 'cells'>
        value={pick.kind}
        options={[
          ['island', '点一个岛'],
          ['cells', '圈一片'],
        ]}
        onChange={(v) => (rangePick.value = { ...pick, kind: v })}
      />
      <button class="bar-btn" onClick={() => cancelRangePick()}>
        取消
      </button>
    </>
  );
}

export function NatureExtras() {
  return <UnmetPanel />;
}
