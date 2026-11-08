import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { loreOf, rulersByDynasty } from '../../../core/human';
import type { CountryMeta, RulerMeta, World } from '../../../core/world';
import { ARCHIVE_TEXT as T } from '../copy';
import { run } from '../country-archive';
import {
  addDynastyCommand,
  addRulerCommand,
  dynastyNameCommand,
  moveRulerCommand,
  removeDynastyCommand,
  removeRulerCommand,
  rulerLinkCommand,
  rulerNameCommand,
  rulerTextCommand,
  rulerYearsCommand,
} from '../domain/country-lore';
import { Line, LongText, TextField, YearBox } from './fields';

// 国家档案“历史”页的统治者（第八十五轮）：按家族一段一段（家族名点了就能改），家族里按先后、孩子比父母往里缩一格。
// 一行：名字（点了就能改）、在位的两个年份框（结束空着是至今）、展开；展开后是称号、原文、家族、父母、备注、往前往后、删除。
// 最后是“加统治者”“加家族”。每一下都是一条命令（domain/country-lore.ts），能撤销

function RulerLine({ w, m, r, depth, open, onToggle }: { w: World; m: CountryMeta; r: RulerMeta; depth: number; open: boolean; onToggle: () => void }) {
  const lore = loreOf(w.small, m.id);
  const idx = lore.rulers.findIndex((x) => x.id === r.id);
  return (
    <div class={`lore-ruler ${open ? 'open' : ''}`} style={depth ? { paddingLeft: `${depth * 12}px` } : undefined}>
      <div class="lore-line">
        {r.title && <span class="hint lore-title">{r.title}</span>}
        <TextField class="lore-name grow" value={r.name} maxLength={40} title={r.orig} onCommit={(v) => void run(rulerNameCommand(w, m.id, r.id, v))} />
        <YearBox value={r.from} onCommit={(y) => y !== null && void run(rulerYearsCommand(w, m.id, r.id, y, r.to ?? null))} />
        <span class="hint">–</span>
        <YearBox value={r.to ?? null} allowEmpty placeholder={T.now} title={T.reignHint} onCommit={(y) => void run(rulerYearsCommand(w, m.id, r.id, r.from, y))} />
        <button class={`icon-btn lore-more ${open ? 'on' : ''}`} onClick={onToggle} title={T.more}>
          <ChevronDown />
        </button>
      </div>
      {open && (
        <div class="lore-edit">
          <Line label={T.title}>
            <TextField value={r.title ?? ''} maxLength={16} placeholder={T.titlePlaceholder} onCommit={(v) => void run(rulerTextCommand(w, m.id, r.id, 'title', v))} />
          </Line>
          <Line label={T.orig}>
            <TextField value={r.orig ?? ''} maxLength={80} placeholder={T.orig} onCommit={(v) => void run(rulerTextCommand(w, m.id, r.id, 'orig', v))} />
          </Line>
          <Line label={T.dynasty}>
            <select
              class="grow"
              value={r.dynasty ?? ''}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                void run(rulerLinkCommand(w, m.id, r.id, 'dynasty', v ? Number(v) : null));
              }}
            >
              <option value="">{T.noDynasty}</option>
              {lore.dynasties.map((d) => (
                <option value={d.id}>{d.name}</option>
              ))}
            </select>
          </Line>
          <Line label={T.parent}>
            <select
              class="grow"
              value={r.parent ?? ''}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                void run(rulerLinkCommand(w, m.id, r.id, 'parent', v ? Number(v) : null));
              }}
            >
              <option value="">{T.noParent}</option>
              {lore.rulers
                .filter((x) => x.id !== r.id)
                .map((x) => (
                  <option value={x.id}>{x.name}</option>
                ))}
            </select>
          </Line>
          <LongText id={`ruler:${m.id}:${r.id}`} value={r.note ?? ''} placeholder={T.note} rows={2} onCommit={(t) => void run(rulerTextCommand(w, m.id, r.id, 'note', t))} />
          <div class="row lore-actions">
            <button class="small" disabled={idx <= 0} onClick={() => void run(moveRulerCommand(w, m.id, r.id, -1))}>
              <ArrowUp /> {T.earlier}
            </button>
            <button class="small" disabled={idx >= lore.rulers.length - 1} onClick={() => void run(moveRulerCommand(w, m.id, r.id, 1))}>
              <ArrowDown /> {T.later}
            </button>
            <span class="grow" />
            <button class="small" onClick={() => void run(removeRulerCommand(m.id, r.id))}>
              <Trash2 /> {T.remove}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RulersSection({ w, m }: { w: World; m: CountryMeta }) {
  const [open, setOpen] = useState<number | null>(null);
  const lore = loreOf(w.small, m.id);
  const groups = rulersByDynasty(lore);
  return (
    <section class="lore">
      <h5>
        {T.rulers} · {lore.rulers.length}
      </h5>
      <p class="hint">{T.rulersHint}</p>
      {groups.map((g) => (
        <div class="lore-dynasty">
          {g.dynasty ? (
            <div class="lore-line lore-dyn-head">
              <TextField class="lore-name grow" value={g.dynasty.name} maxLength={40} title={g.dynasty.orig} onCommit={(v) => void run(dynastyNameCommand(w, m.id, g.dynasty!.id, v))} />
              {!g.rows.length && (
                <button class="icon-btn" onClick={() => void run(removeDynastyCommand(m.id, g.dynasty!.id))} title={T.remove}>
                  <Trash2 />
                </button>
              )}
            </div>
          ) : (
            <div class="lore-line lore-dyn-head hint">{T.noDynasty}</div>
          )}
          {g.rows.map((row) => (
            <RulerLine w={w} m={m} r={row.ruler} depth={row.depth} open={open === row.ruler.id} onToggle={() => setOpen(open === row.ruler.id ? null : row.ruler.id)} />
          ))}
        </div>
      ))}
      <div class="row lore-actions">
        <button class="small" onClick={() => void run(addRulerCommand(w, m.id))}>
          <Plus /> {T.addRuler}
        </button>
        <button class="small" onClick={() => void run(addDynastyCommand(m.id))}>
          <Plus /> {T.addDynasty}
        </button>
      </div>
    </section>
  );
}
