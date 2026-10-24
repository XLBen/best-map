import { speciesColor } from '../../../core/species';
import { BellOff, TriangleAlert } from 'lucide-preact';
import { activeConflicts } from '../../../core/constraints';
import { openPanel, options, togglePanel, world } from '../../state';
import { Seg } from '../common';
import { UnmetPanel, showIgnored } from '../panels';
import { BiomePalette } from '../panels/BiomePanel';
import { cancelRangePick, rangePick } from '../tools';

// 注册表里引用的几个小部件：底部条上的当前生态、“没涂成”的入口，工具列表下方的设置
export { NamesBar, NamesExtras } from '../panels/names';
export { RiverBar, RiverExtras } from '../panels/rivers';
export { NewRiverTypePick } from '../panels/riverTypes';
export { LakeBar, NewLakeTypePick } from '../panels/lakes';
export { ProvinceBar, ProvinceColorToggle, ProvinceExtras } from '../provincePanel';

// 当前要涂的生态：点开是“自然 ⋯”（生态的色板只在那里）
export function BiomeChip() {
  const w = world.value;
  const sp = w?.small.species.find((s) => s.id === options.value.biome);
  return (
    <button
      class={`bar-btn biome-chip ${sp ? '' : 'warn'} ${openPanel.value === 'cat:nature' ? 'open' : ''}`}
      onClick={() => togglePanel('cat:nature')}
      title="换一种生态，或编辑生态类型"
    >
      <span class="swatch" style={{ background: sp ? speciesColor(sp) : 'transparent' }} />
      {sp ? sp.name || sp.id : '选一种生态'}
    </button>
  );
}

// 没涂成的地方：底部条上只有这一个入口。有还要提醒的写“N 处没涂成”，只剩说了“就这样”的写个数；
// 点开是“自然 ⋯”里的列表（那里一处一处看、恢复提醒、强制、删掉）
export function UnmetChip() {
  const w = world.value;
  const n = w ? activeConflicts(w).length : 0;
  const ignored = w?.small.constraints.filter((c) => c.ignored).length ?? 0;
  if (!n && !ignored) return null;
  return (
    <button
      class={`bar-btn ${n ? 'warn' : ''}`}
      title={n ? '点开看哪里没涂成、为什么' : `${ignored} 处没涂成的地方说了“就这样”：点开看`}
      onClick={() => {
        if (!n) showIgnored.value = true;
        togglePanel('cat:nature');
      }}
    >
      {n ? <TriangleAlert /> : <BellOff />} {n ? `${n} 处没涂成` : ignored}
    </button>
  );
}

// 选生态的范围时底部条：给哪种生态选、点岛 / 圈一片、取消
export function RangeBar() {
  const pick = rangePick.value;
  const sp = pick ? world.value?.small.species.find((s) => s.id === pick.species) : null;
  if (!pick) {
    return <span class="hint">在生态编辑器里点“选岛”或“圈一下”</span>;
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

// “自然 ⋯”：生态类型（色板、编辑生态类型…），然后是没涂成的地方
export function NatureExtras() {
  return (
    <>
      <section>
        <h5>生态类型</h5>
        <BiomePalette />
      </section>
      <section>
        <UnmetPanel />
      </section>
    </>
  );
}
