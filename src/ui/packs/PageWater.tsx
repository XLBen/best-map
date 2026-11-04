import { useEffect, useState } from 'preact/hooks';
import type { Species } from '../../../core/species';
import { speciesColor } from '../../../core/species';
import type { WaterType } from '../../../core/water-types';
import { type WaterKind, waterAllowed } from '../../../core/water-table';
import { SpeciesWaterForm } from '../panels/speciesWater';
import { TypeSwatch } from '../panels/waterTypes';
import { commitWaterBlock, commitWaterCell } from './page-actions';
import { type PageCtx, type SourceRef, kindReadonly, readonlyWhy, waterLists, waterTable } from './pages';
import { goTo } from './panel-store';
import { kindOf } from '../../../core/content/registry';
import { SCRIPT_RIVER_NOTE, WATER_MANUAL_NOTE } from '../copy';

// 生态与水系（第五十九轮）：总表（纵列生态，横行水系，普通河、普通湖也是一行），和生态页的“水系”、河湖页的“出现在哪些地形”。
// 三处读写同一份（core/water-table.ts，经 page-actions.ts），改一边另一边跟着变。世界里点了要算一会儿，勾先变，算完换成真的

// 点了还没算完的格：先显示点到的样子（世界换了就去掉）
function useOptimistic(ctx: PageCtx) {
  const [over, setOver] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => setOver(new Map()), [ctx.world, ctx.lib]);
  return {
    get: (key: string, real: boolean) => over.get(key) ?? real,
    set: (key: string, v: boolean) => setOver((m) => new Map(m).set(key, v)),
  };
}

export function WaterTablePage({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const t = waterTable(src, ctx);
  const ro = readonlyWhy(src, ctx);
  const opt = useOptimistic(ctx);
  if (!t.biomes.length) return <p class="hint lp-note">没有生态</p>;
  const click = (spId: string, kind: WaterKind, typeId: string, on: boolean) => {
    if (ro) return;
    opt.set(`${spId}|${kind}|${typeId}`, on);
    void commitWaterCell(src, spId, kind, typeId, on, ctx);
  };
  return (
    <div class="lp-table-page">
      {ro && <p class="hint">{ro}</p>}
      <p class="hint">纵列是生态，横行是水系。不允许时按这种生态的设置换类型或断流</p>
      <div class="lp-table-wrap">
        <table class="lp-table">
          <thead>
            <tr>
              <th class="lp-table-corner" />
              {t.biomes.map((b) => (
                <th key={b.id} class="lp-table-col" title={b.name}>
                  <button onClick={() => goTo(b.route)}>
                    <span class="swatch" style={{ background: b.color }} />
                    <span class="lp-table-col-name">{b.name}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, k) => (
              <tr key={`${r.kind}|${r.id}`} class={k === t.lakesFrom ? 'lp-table-split' : ''}>
                <th class="lp-table-row" title={r.script ? SCRIPT_RIVER_NOTE : r.manual ? WATER_MANUAL_NOTE : r.name}>
                  {r.route ? (
                    <button onClick={() => goTo(r.route!)}>
                      <TypeSwatch kind={r.kind} t={r.type} />
                      <span class="ellipsis">{r.name}</span>
                      {r.script && <span class="hint">规则</span>}
                      {r.manual && <span class="hint">不自然</span>}
                    </button>
                  ) : (
                    <span class="lp-table-plain">
                      <TypeSwatch kind={r.kind} t={null} />
                      <span class="ellipsis">{r.name}</span>
                    </span>
                  )}
                </th>
                {t.biomes.map((b, j) => {
                  const on = opt.get(`${b.id}|${r.kind}|${r.id}`, r.cells[j]);
                  return (
                    <td key={b.id} class={on ? 'on' : ''}>
                      <input type="checkbox" checked={on} disabled={!!ro} title={`${r.name} · ${b.name}`} onChange={() => click(b.id, r.kind, r.id, !on)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.anyScript && <p class="hint">{SCRIPT_RIVER_NOTE}</p>}
    </div>
  );
}

// 生态页的“水系”这一段：允许的水系、不允许时怎么办（和生态抽屉同一个表单）
export function BiomeWaterSegment({ src, ctx, sp }: { src: SourceRef; ctx: PageCtx; sp: Species }) {
  const lists = waterLists(src, ctx);
  return (
    <SpeciesWaterForm
      lists={lists}
      sp={sp}
      disabled={!!readonlyWhy(src, ctx)}
      onCell={(kind, id, on) => void commitWaterCell(src, sp.id, kind, id, on, ctx)}
      onBlock={(mode) => void commitWaterBlock(src, sp.id, mode, ctx)}
    />
  );
}

// 河湖页的“出现在哪些地形”这一段：列一行总表
export function WaterBiomesSegment({ src, ctx, kindId, type }: { src: SourceRef; ctx: PageCtx; kindId: string; type: WaterType }) {
  const kind: WaterKind = kindId === 'riverType' ? 'river' : 'lake';
  const lists = waterLists(src, ctx);
  const opt = useOptimistic(ctx);
  const ro = !!kindReadonly(src, kindOf(kindId)!, ctx);
  const script = !!type.scripts?.match?.src;
  return (
    <>
      {script && <p class="hint">{SCRIPT_RIVER_NOTE}</p>}
      <div class="biome-picks">
        {lists.species.map((sp) => {
          const on = opt.get(sp.id, waterAllowed(lists, sp, kind, type.id));
          return (
            <label class="check" key={sp.id}>
              <input
                type="checkbox"
                checked={on}
                disabled={ro}
                onChange={() => {
                  opt.set(sp.id, !on);
                  void commitWaterCell(src, sp.id, kind, type.id, !on, ctx);
                }}
              />
              <span class="swatch" style={{ background: speciesColor(sp) }} /> {sp.name || sp.id}
            </label>
          );
        })}
      </div>
    </>
  );
}
