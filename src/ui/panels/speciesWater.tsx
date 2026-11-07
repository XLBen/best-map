import type { Species } from '../../../core/species';
import { PLAIN_TYPE, type WaterType } from '../../../core/water-types';
import { type WaterKind, setWaterAllowed, setWaterBlock, waterAllowed } from '../../../core/water-table';
import type { World } from '../../../core/world';
import { exec } from '../../state';
import { Seg } from '../common';
import { TypeSwatch } from './waterTypes';

// 生态编辑器里的水系（第五十六轮；第七十二轮起只有资源库里生态的页面这一处）：这种生态允许哪些河湖，不允许时换类型还是断流。
// 和河湖类型编辑里的“出现在这些生态”、资源库的总表是同一份数据（core/water-table.ts）

interface Lists {
  riverTypes?: readonly WaterType[];
  lakeTypes?: readonly WaterType[];
}

function Row({ lists, sp, kind, id, label, t, disabled, onCell }: { lists: Lists; sp: Species; kind: WaterKind; id: string; label: string; t: WaterType | null; disabled?: boolean; onCell: (kind: WaterKind, id: string, on: boolean) => void }) {
  const on = waterAllowed(lists, sp, kind, id);
  return (
    <label class="check">
      <input type="checkbox" checked={on} disabled={disabled} onChange={() => onCell(kind, id, !on)} />
      <TypeSwatch kind={kind} t={t} /> {label}
    </label>
  );
}

export function SpeciesWaterForm({ lists, sp, disabled, onCell, onBlock }: { lists: Lists; sp: Species; disabled?: boolean; onCell: (kind: WaterKind, id: string, on: boolean) => void; onBlock: (mode: 'swap' | 'stop') => void }) {
  const mode = sp.waterBlock ?? 'swap';
  const common = { lists, sp, disabled, onCell };
  return (
    <>
      <h5>允许的水系</h5>
      <div class="biome-picks">
        <Row {...common} kind="river" id={PLAIN_TYPE} label="普通河" t={null} />
        {(lists.riverTypes ?? []).map((t) => (
          <Row key={t.id} {...common} kind="river" id={t.id} label={t.name} t={t} />
        ))}
        <Row {...common} kind="lake" id={PLAIN_TYPE} label="普通湖" t={null} />
        {(lists.lakeTypes ?? []).map((t) => (
          <Row key={t.id} {...common} kind="lake" id={t.id} label={t.name} t={t} />
        ))}
      </div>
      <h5>河不允许时</h5>
      <Seg<'swap' | 'stop'>
        value={mode}
        options={[
          ['swap', '换类型'],
          ['stop', '断流'],
        ]}
        onChange={onBlock}
        wide
      />
      <p class="hint">{mode === 'stop' ? '河到这里消失，下游的河可能变小或消失' : '河道和水量不变，这一段换成允许的类型'}</p>
      {mode === 'stop' && sp.plainRiver !== false && <p class="hint warn">普通河允许时不断流</p>}
    </>
  );
}

export function SpeciesWater({ w, sp }: { w: World; sp: Species }) {
  return (
    <SpeciesWaterForm
      lists={w.small}
      sp={sp}
      onCell={(kind, id, on) => {
        const cmd = setWaterAllowed(w.small, sp.id, kind, id, on);
        if (cmd) void exec(cmd, '正在计算…');
      }}
      onBlock={(mode) => {
        const cmd = setWaterBlock(w.small, sp.id, mode);
        if (cmd) void exec(cmd, '正在计算…');
      }}
    />
  );
}
