import { speciesColor } from '../../core/species';
import { signal } from '@preact/signals';
import { activeConflicts } from '../../core/constraints';
import type { Conflict } from '../../core/world';
import { exec, focusSpecies, history, sheet, world } from '../state';
import { focusOn } from './camera';
import { outsideRangeReason } from './biomeRange';
import { reasonText } from './Inspector';

// 没涂成的地方（“自然”工具列表下方）、历史（“操作”里）

// 说了“就这样”的列表要不要展开（底部条上的“!”点开时展开）
export const showIgnored = signal(false);

const BUSY = '正在计算生态…';

export function UnmetPanel() {
  const w = world.value;
  if (!w) return null;
  const species = (id: string | null) => w.small.species.find((s) => s.id === id);
  const conflicts = activeConflicts(w);
  const ignored = w.small.constraints.filter((c) => c.ignored);
  const conflictOf = (id: string) => w.derived.conflicts.find((c) => c.constraintId === id);
  // 强制这些格：没长出来的格改成强制（一步）
  const force = (c: Conflict, radius: number) =>
    void exec({ op: 'add_constraint', constraint: { cells: c.failing, species: c.species, mode: 'override', ratio: 1, radius, label: '' } }, BUSY);
  const setIgnored = (id: string, on: boolean) => void exec({ op: 'update_constraint', id, patch: { ignored: on } }, '正在保存…');
  return (
    <div>
      <h4>没涂成的地方</h4>
      {conflicts.length === 0 && <p class="muted">{ignored.length ? '要提醒的都长出来了。' : '涂过的生态都长出来了。'}</p>}
      {conflicts.map((c) => {
        const con = w.small.constraints.find((x) => x.id === c.constraintId);
        const sp = species(c.species);
        // 大多在生态的范围外：只说这一条（怎么调冷暖干湿都长不出来，气候的原因不相干）
        const outside = outsideRangeReason(w, sp, c.failing);
        const why = outside ? [outside] : c.reasons.slice(0, 2).map((r) => reasonText({ field: r.field, value: r.value, factor: 0, range: [r.need[0], r.need[0], r.need[1], r.need[1]] }));
        const water = c.failing.length === 0;
        return (
          <div class="box conflict">
            <b>
              <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? c.species}：{water ? '涂到了水面上' : `${c.failing.length} 格没长出来`}
            </b>
            {why.length > 0 && <p class="small">原因：{why.join('；')}。</p>}
            {why.length === 0 && !water && <p class="small">原因：竞争不过当地的其他生态，或者它传不到这里。</p>}
            <div class="row wrap">
              {c.failing.length > 0 && <button class="small" onClick={() => focusOn(c.failing)}>在地图上看</button>}
              {c.failing.length > 0 && con && (
                <button class="small" onClick={() => force(c, con.radius)}>
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
              {con && (
                <button class="small" title="不再提醒（地图上的红斜线、计数都不算它），收进底部条的“!”里；随时能恢复" onClick={() => setIgnored(con.id, true)}>
                  就这样
                </button>
              )}
              <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: c.constraintId }, BUSY)}>
                不要这一笔了
              </button>
            </div>
          </div>
        );
      })}
      {ignored.length > 0 && (
        <details open={showIgnored.value} onToggle={(e) => (showIgnored.value = (e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            <b class="ignored-mark">!</b> 说了“就这样”的（{ignored.length}）
          </summary>
          <p class="muted small">没涂成也不再提醒。格数变了也照样不提醒，直到点“恢复提醒”。</p>
          {ignored.map((con) => {
            const sp = species(con.species);
            const c = conflictOf(con.id);
            const failing = c?.failing.length ?? 0;
            return (
              <div class="box ignored">
                <b>
                  <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? con.species}：{c ? (failing ? `${failing} 格没长出来` : '涂到了水面上') : '现在已经长出来了'}
                </b>
                <div class="row wrap">
                  <button class="small" onClick={() => focusOn(failing ? c!.failing : con.cells)}>
                    在地图上看
                  </button>
                  <button class="small" onClick={() => setIgnored(con.id, false)}>
                    恢复提醒
                  </button>
                  {c && failing > 0 && (
                    <button class="small" onClick={() => force(c, con.radius)}>
                      强制这些格
                    </button>
                  )}
                  <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: con.id }, BUSY)}>
                    删掉这一笔
                  </button>
                </div>
              </div>
            );
          })}
        </details>
      )}
      <h4>涂过的地方（{w.small.constraints.length}）</h4>
      {w.small.constraints.length === 0 && <p class="muted small">还没有涂过。用上面的“涂生态”或“拖动扩张”。</p>}
      {w.small.constraints.map((c) => {
        const sp = species(c.species);
        return (
          <div class="row between constraint-row">
            <span class="link" onClick={() => focusOn(c.cells)}>
              <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? c.species} · {c.cells.length} 格 · {c.mode === 'constraint' ? '自然融入' : '强制'}
              {c.ignored ? ' · !' : ''}
            </span>
            <span class="row">
              <button class="small" onClick={() => void exec({ op: 'update_constraint', id: c.id, patch: { mode: c.mode === 'constraint' ? 'override' : 'constraint' } }, BUSY)}>
                改成{c.mode === 'constraint' ? '强制' : '自然融入'}
              </button>
              <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: c.id }, BUSY)}>
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
