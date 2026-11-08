import { ChevronDown, Plus, Trash2, X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { type TimelineRow, countryTimeline, countryList } from '../../../core/human';
import type { CountryMeta, World } from '../../../core/world';
import { ARCHIVE_TEXT as T } from '../copy';
import { patch, run } from '../country-archive';
import { addEventCommand, eventLinkCommand, eventNoteCommand, eventTitleCommand, eventYearCommand, removeEventCommand, rulerYearsCommand } from '../domain/country-lore';
import { showCountry } from '../panels/countries';
import { CountrySelect, Line, LongText, TextField, YearBox } from './fields';

// 国家档案“历史”页的大事年表（第八十五轮）：一条竖线上按年份排，建国、每位统治者即位、大事（牵涉别国的在两国的年表里都有，存一份）。
// 建国、即位跟着建国的年份、统治者的名单（改年份就是改那里）；大事的标题点了就能改，展开后是备注、牵涉的国家、删除。最后是“加大事”

function EventEdit({ w, m, row }: { w: World; m: CountryMeta; row: Extract<TimelineRow, { kind: 'event' }> }) {
  const e = row.event;
  const metas = w.small.countries ?? {};
  const free = countryList(w.small).filter((x) => !e.countries.includes(x.id));
  return (
    <div class="lore-edit">
      <LongText id={`event:${e.id}`} value={e.note ?? ''} placeholder={T.note} rows={2} onCommit={(t) => void run(eventNoteCommand(w, e.id, t))} />
      <Line label={T.linked}>
        <span class="chips grow">
          {row.others.map((id) =>
            metas[id] ? (
              <span class="chip static">
                <span class="swatch" style={{ background: metas[id].color }} />
                <button class="link" onClick={() => showCountry(w, id)}>
                  {metas[id].name}
                </button>
                {e.countries[0] !== id && (
                  <button class="icon-btn" onClick={() => void run(eventLinkCommand(w, e.id, id, false))} title={T.remove}>
                    <X />
                  </button>
                )}
              </span>
            ) : null,
          )}
          {free.length > 0 && (
            <CountrySelect
              owner={m.id}
              list={free}
              value=""
              first={T.addLinked}
              class="chip-add"
              onChange={(ev) => {
                const v = Number((ev.target as HTMLSelectElement).value);
                if (v) void run(eventLinkCommand(w, e.id, v, true));
              }}
            />
          )}
        </span>
      </Line>
      <div class="row lore-actions">
        <span class="grow" />
        <button class="small" onClick={() => void run(removeEventCommand(e.id))}>
          <Trash2 /> {T.remove}
        </button>
      </div>
    </div>
  );
}

function Row({ w, m, row, open, onToggle }: { w: World; m: CountryMeta; row: TimelineRow; open: boolean; onToggle: () => void }) {
  const year = (y: number | null) => {
    if (y === null) return;
    if (row.kind === 'founded') void patch(m.id, y === m.founded ? null : { founded: y });
    else if (row.kind === 'accession') void run(rulerYearsCommand(w, m.id, row.ruler.id, y, row.ruler.to !== undefined && row.ruler.to < y ? y : (row.ruler.to ?? null)));
    else void run(eventYearCommand(w, row.event.id, y));
  };
  return (
    <li class={`lore-tl-row ${row.kind} ${open ? 'open' : ''}`}>
      <span class="lore-dot" />
      <div class="lore-line">
        <YearBox value={row.year} onCommit={year} title={row.kind === 'founded' ? T.fromFounded : row.kind === 'accession' ? T.fromRuler : undefined} />
        {row.kind === 'event' ? (
          <TextField class="lore-name grow" value={row.title} maxLength={80} onCommit={(v) => void run(eventTitleCommand(w, row.event.id, v))} />
        ) : (
          <span class="grow ellipsis lore-fixed" title={row.kind === 'founded' ? T.fromFounded : T.fromRuler}>
            {row.title}
          </span>
        )}
        {row.kind === 'event' && (
          <button class={`icon-btn lore-more ${open ? 'on' : ''}`} onClick={onToggle} title={T.more}>
            <ChevronDown />
          </button>
        )}
      </div>
      {row.kind === 'event' && !open && (row.event.note || row.others.length > 0) && (
        <div class="hint lore-sub ellipsis">{[row.others.map((id) => w.small.countries?.[id]?.name).filter(Boolean).join('、'), row.event.note?.split('\n')[0]].filter(Boolean).join(' · ')}</div>
      )}
      {row.kind === 'event' && open && <EventEdit w={w} m={m} row={row} />}
    </li>
  );
}

export function TimelineSection({ w, m }: { w: World; m: CountryMeta }) {
  const [open, setOpen] = useState<number | null>(null);
  const rows = countryTimeline(w, m.id);
  return (
    <section class="lore">
      <h5>{T.timeline}</h5>
      <ol class="lore-tl">
        {rows.map((row) => {
          const eid = row.kind === 'event' ? row.event.id : null;
          return <Row key={row.key} w={w} m={m} row={row} open={eid !== null && open === eid} onToggle={() => setOpen(open === eid ? null : eid)} />;
        })}
      </ol>
      <div class="row lore-actions">
        <button class="small" onClick={() => void run(addEventCommand(w, m.id))}>
          <Plus /> {T.addEvent}
        </button>
      </div>
    </section>
  );
}
