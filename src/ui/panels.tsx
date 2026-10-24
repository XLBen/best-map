import { speciesColor } from '../../core/species';
import { signal } from '@preact/signals';
import { BellOff, ScanSearch, X } from 'lucide-preact';
import { activeConflicts } from '../../core/constraints';
import type { Conflict } from '../../core/world';
import { exec, focusSpecies, history, sheet, world } from '../state';
import { focusOn } from './camera';
import { outsideRangeReason } from './biomeRange';
import { reasonText } from './Inspector';
import { locateNextUnmet, locateTitle, unmetLooked, unmetSpots } from './unmetLocate';

// 没涂成的地方（“自然 ⋯”里）、历史（“更多”里）

// 说了“就这样”的列表要不要展开（只剩说了“就这样”的时，底部条上的入口点开时展开）
export const showIgnored = signal(false);

const BUSY = '正在计算…';

export function UnmetPanel() {
  const w = world.value;
  if (!w) return null;
  const species = (id: string | null) => w.small.species.find((s) => s.id === id);
  const conflicts = activeConflicts(w);
  const ignored = w.small.constraints.filter((c) => c.ignored);
  const conflictOf = (id: string) => w.derived.conflicts.find((c) => c.constraintId === id);
  // 强制：没长出来的格改成强制（一步）
  const force = (c: Conflict, radius: number) =>
    void exec({ op: 'add_constraint', constraint: { cells: c.failing, species: c.species, mode: 'override', ratio: 1, radius, label: '' } }, BUSY);
  const setIgnored = (id: string, on: boolean) => void exec({ op: 'update_constraint', id, patch: { ignored: on } }, '正在保存…');
  // 没涂成的地方（还要提醒的和说了“就这样”的）一处一处看：按一下看下一处，看过之后写着第几处
  const spots = unmetSpots(w).length;
  const k = unmetLooked.value;
  return (
    <div>
      <div class="row between">
        <h5>没涂成的地方</h5>
        {spots > 0 && (
          <button class="bar-btn" onClick={() => locateNextUnmet(w)} title={locateTitle(k, spots)}>
            <ScanSearch />
            {k >= 0 && k < spots && spots > 1 ? ` ${k + 1}/${spots}` : ' 逐个定位'}
          </button>
        )}
      </div>
      {conflicts.length === 0 && <p class="hint">{ignored.length ? '没有要提醒的' : '涂过的生态都长出来了'}</p>}
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
              <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? c.species}：{water ? '涂到了水面上' : `${c.failing.length} 格没涂成`}
            </b>
            {why.length > 0 && <p class="small">原因：{why.join('；')}。</p>}
            {why.length === 0 && !water && <p class="small">原因：竞争不过当地生态，或传不到这里。</p>}
            <div class="row wrap">
              {c.failing.length > 0 && <button class="small" onClick={() => focusOn(c.failing)}>定位</button>}
              {c.failing.length > 0 && con && (
                <button class="small" onClick={() => force(c, con.radius)}>
                  强制
                </button>
              )}
              <button
                class="small"
                onClick={() => {
                  focusSpecies.value = c.species;
                  sheet.value = 'species';
                }}
              >
                编辑生态
              </button>
              {con && (
                <button class="small" title="不再提醒，可随时恢复" onClick={() => setIgnored(con.id, true)}>
                  忽略
                </button>
              )}
              <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: c.constraintId }, BUSY)}>
                删除
              </button>
            </div>
          </div>
        );
      })}
      {ignored.length > 0 && (
        <details open={showIgnored.value} onToggle={(e) => (showIgnored.value = (e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            <BellOff /> 已忽略（{ignored.length}）
          </summary>
          <p class="hint">不再提醒，直到恢复提醒</p>
          {ignored.map((con) => {
            const sp = species(con.species);
            const c = conflictOf(con.id);
            const failing = c?.failing.length ?? 0;
            return (
              <div class="box ignored">
                <b>
                  <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? con.species}：{c ? (failing ? `${failing} 格没涂成` : '涂到了水面上') : '已经长出来了'}
                </b>
                <div class="row wrap">
                  <button class="small" onClick={() => focusOn(failing ? c!.failing : con.cells)}>
                    定位
                  </button>
                  <button class="small" onClick={() => setIgnored(con.id, false)}>
                    恢复提醒
                  </button>
                  {c && failing > 0 && (
                    <button class="small" onClick={() => force(c, con.radius)}>
                      强制
                    </button>
                  )}
                  <button class="small danger" onClick={() => void exec({ op: 'remove_constraint', id: con.id }, BUSY)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </details>
      )}
      <h5>涂过的地方（{w.small.constraints.length}）</h5>
      {w.small.constraints.length === 0 && <p class="hint">没有涂过的地方</p>}
      {w.small.constraints.map((c) => {
        const sp = species(c.species);
        return (
          <div class="item">
            <span class="grow ellipsis" onClick={() => focusOn(c.cells)} title="定位">
              <span class="swatch" style={{ background: sp ? speciesColor(sp) : undefined }} /> {sp?.name ?? c.species} · {c.cells.length} 格 · {c.mode === 'constraint' ? '自然融入' : '强制'}
              {c.ignored ? <BellOff /> : null}
            </span>
            <span class="row">
              <button class="small" onClick={() => void exec({ op: 'update_constraint', id: c.id, patch: { mode: c.mode === 'constraint' ? 'override' : 'constraint' } }, BUSY)}>
                改成{c.mode === 'constraint' ? '强制' : '自然融入'}
              </button>
              <button class="small icon danger" onClick={() => void exec({ op: 'remove_constraint', id: c.id }, BUSY)} title="删除">
                <X />
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
  if (!list.length) return <p class="hint">没有修改</p>;
  return (
    <ol class="history">
      {list.map((h) => (
        <li class={h.done ? '' : 'undone'}>{h.summary}</li>
      ))}
    </ol>
  );
}
