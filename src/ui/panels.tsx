import { exec, focusSpecies, history, sheet, world } from '../state';
import { focusOn } from './camera';
import { reasonText } from './Inspector';

// 没涂成的地方（“自然”工具列表下方）、历史（“操作”里）

export function UnmetPanel() {
  const w = world.value;
  if (!w) return null;
  const species = (id: string | null) => w.small.species.find((s) => s.id === id);
  const conflicts = w.derived.conflicts;
  return (
    <div>
      <h4>没涂成的地方</h4>
      {conflicts.length === 0 && <p class="muted">涂过的生态都长出来了。</p>}
      {conflicts.map((c) => {
        const con = w.small.constraints.find((x) => x.id === c.constraintId);
        const sp = species(c.species);
        const why = c.reasons.slice(0, 2).map((r) => reasonText({ field: r.field, value: r.value, factor: 0, range: [r.need[0], r.need[0], r.need[1], r.need[1]] }));
        const water = c.failing.length === 0;
        return (
          <div class="box conflict">
            <b>
              <span class="swatch" style={{ background: sp?.color }} /> {sp?.name ?? c.species}：{water ? '涂到了水面上' : `${c.failing.length} 格没长出来`}
            </b>
            {why.length > 0 && <p class="small">原因：{why.join('；')}。</p>}
            {why.length === 0 && !water && <p class="small">原因：竞争不过当地的其他生态，或者它传不到这里。</p>}
            <div class="row wrap">
              {c.failing.length > 0 && <button class="small" onClick={() => focusOn(c.failing)}>在地图上看</button>}
              {c.failing.length > 0 && con && (
                <button
                  class="small"
                  onClick={() => void exec({ op: 'add_constraint', constraint: { cells: c.failing, species: c.species, mode: 'override', ratio: 1, radius: con.radius, label: '' } }, '正在计算生态…')}
                >
                  强制这些格
                </button>
              )}
              <button
                class="small"
                onClick={() => {
                  focusSpecies.value = c.species;
                  sheet.value = 'species';
                }}
              >
                调整这种生态
              </button>
              <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: c.constraintId }, '正在计算生态…')}>
                不要这一笔了
              </button>
            </div>
          </div>
        );
      })}
      <h4>涂过的地方（{w.small.constraints.length}）</h4>
      {w.small.constraints.length === 0 && <p class="muted small">还没有涂过。用上面的“涂生态”或“拖动扩张”。</p>}
      {w.small.constraints.map((c) => {
        const sp = species(c.species);
        return (
          <div class="row between constraint-row">
            <span class="link" onClick={() => focusOn(c.cells)}>
              <span class="swatch" style={{ background: sp?.color }} /> {sp?.name ?? c.species} · {c.cells.length} 格 · {c.mode === 'constraint' ? '自然融入' : '强制'}
            </span>
            <span class="row">
              <button class="small" onClick={() => void exec({ op: 'update_constraint', id: c.id, patch: { mode: c.mode === 'constraint' ? 'override' : 'constraint' } }, '正在计算生态…')}>
                改成{c.mode === 'constraint' ? '强制' : '自然融入'}
              </button>
              <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: c.id }, '正在计算生态…')}>
                ✕
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function HistoryPanel() {
  const list = history.value;
  if (!list.length) return <p class="muted small">还没有做过修改。</p>;
  return (
    <ol class="history">
      {list.map((h) => (
        <li class={h.done ? '' : 'undone'}>{h.summary}</li>
      ))}
    </ol>
  );
}
