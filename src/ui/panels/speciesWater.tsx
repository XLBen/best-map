import type { Species } from '../../../core/species';
import { PLAIN_TYPE } from '../../../core/water-types';
import { type WaterKind, setWaterAllowed, setWaterBlock, waterAllowed } from '../../../core/water-table';
import type { World } from '../../../core/world';
import { exec } from '../../state';
import { Seg } from '../common';
import { TypeSwatch } from './waterTypes';

// 生态抽屉里的水系（第五十六轮）：这种生态允许哪些河湖，不允许时换类型还是断流。
// 和河湖类型编辑里的“出现在这些生态”是同一份数据（core/water-table.ts）

function Row({ w, sp, kind, id, label, t }: { w: World; sp: Species; kind: WaterKind; id: string; label: string; t: Parameters<typeof TypeSwatch>[0]['t'] }) {
  const on = waterAllowed(w.small, sp, kind, id);
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={on}
        onChange={() => {
          const cmd = setWaterAllowed(w.small, sp.id, kind, id, !on);
          if (cmd) void exec(cmd, '正在计算…');
        }}
      />
      <TypeSwatch kind={kind} t={t} /> {label}
    </label>
  );
}

export function SpeciesWater({ w, sp }: { w: World; sp: Species }) {
  const mode = sp.waterBlock ?? 'swap';
  return (
    <>
      <h5>允许的水系</h5>
      <div class="biome-picks">
        <Row w={w} sp={sp} kind="river" id={PLAIN_TYPE} label="普通河" t={null} />
        {(w.small.riverTypes ?? []).map((t) => (
          <Row key={t.id} w={w} sp={sp} kind="river" id={t.id} label={t.name} t={t} />
        ))}
        <Row w={w} sp={sp} kind="lake" id={PLAIN_TYPE} label="普通湖" t={null} />
        {(w.small.lakeTypes ?? []).map((t) => (
          <Row key={t.id} w={w} sp={sp} kind="lake" id={t.id} label={t.name} t={t} />
        ))}
      </div>
      <h5>河不允许时</h5>
      <Seg<'swap' | 'stop'>
        value={mode}
        options={[
          ['swap', '换类型'],
          ['stop', '断流'],
        ]}
        onChange={(v) => {
          const cmd = setWaterBlock(w.small, sp.id, v);
          if (cmd) void exec(cmd, '正在计算…');
        }}
        wide
      />
      <p class="hint">{mode === 'stop' ? '河到这里消失，下游的河可能变小或消失' : '河道和水量不变，这一段换成允许的类型'}</p>
      {mode === 'stop' && sp.plainRiver !== false && <p class="hint warn">普通河允许时不断流</p>}
    </>
  );
}
