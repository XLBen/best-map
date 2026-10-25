import { Mountain, Plus, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { CATEGORY_LABEL, type CellArchive, cellArchive, classAt, resourceAt, typicalTuple, worldCultureGroups, worldCultures, worldResources, worldTerrainClasses } from '../../core/human';
import type { World } from '../../core/world';
import { exec } from '../state';
import { SelectionActions } from './components/SelectionActions';
import { type PopRow, addGroupCommand, autoNameCommand, cellClassCommand, cellResourceCommand, cellTotalCommand, groupShareCommand, noteCommand, popRows, removeGroupCommand, renameCommand, rerollCommand } from './archive';
import { densityText, popText, shareText } from './human';
import { countryAt, countryOf, hasCountries } from './countries';
import { selectCountry } from './tools/countries';

// “这里”卡片里的档案（第二十一轮）：小地名、是山峰时的“xx峰 · 高度”、地形类别、资源、备注。
// 钉住一格（右键点地图）时可以改；没钉住时只读，跟着鼠标

const run = (cmd: Command | null, busy = '正在保存…') => {
  if (cmd) void exec(cmd, busy);
};

// 自动的那一种叫什么（画过的格也写出自动会是什么）
function autoClassName(w: World, cell: number): string {
  return classAt(w.small, w.derived.terrainClassAuto[cell])?.name ?? '—';
}
function autoResourceName(w: World, cell: number): string {
  const r = resourceAt(w.small, w.derived.resourceAuto[cell]);
  if (r) return r.name;
  return classAt(w.small, w.derived.terrainClass[cell])?.ore ? '无矿' : '无';
}

// 一行：左边灰色的两个字，右边是值
function Line({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="arch-line">
      <span class="arch-label">{label}</span>
      {children}
    </div>
  );
}

// ---------- 国家（第二十三轮） ----------

// 这一格是哪国：点国名打开它的档案；海上写领海
function CountryLine({ w, cell }: { w: World; cell: number }) {
  if (!hasCountries(w)) return null;
  const m = countryOf(w, countryAt(w, cell));
  const land = !!w.causes.land[cell];
  if (!m && !land) return null;
  return (
    <Line label="国家">
      {m && <span class="swatch" style={{ background: m.color }} />}
      <span class="grow">
        {m ? (
          <button class="link" onClick={() => selectCountry(m.id)} title="打开档案">
            {m.name}
          </button>
        ) : (
          '无主地'
        )}
        {m && !land && <span class="hint"> · 领海</span>}
        {m && m.capitalCell === cell && <span class="hint"> · 首都</span>}
      </span>
    </Line>
  );
}

// ---------- 人口（第二十二轮） ----------

type Pop = NonNullable<CellArchive['population']>;

// 一个群体：色块（文化的颜色）、“大和 · 祖灵信仰”、占比的条、百分比
function ShareRow({ color, label, share, title, children }: { color: string; label: string; share: number; title?: string; children?: ComponentChildren }) {
  return (
    <div class="share-row" title={title}>
      <span class="swatch" style={{ background: color }} />
      <span class="share-name">{label}</span>
      <span class="share-bar">
        <span style={{ width: `${Math.round(share * 100)}%`, background: color }} />
      </span>
      {children ?? <span class="hint">{shareText(share)}</span>}
    </div>
  );
}

function PopReadOnly({ p, a }: { p: Pop; a: CellArchive }) {
  return (
    <>
      <Line label="人口">
        <span class="grow">
          {p.total > 0 ? `${popText(p.total)} 人 · ${densityText(p.density)}` : '无人'}
          {p.manual && <span class="tag">手改</span>}
        </span>
        <span class="hint" title="宜居度">
          宜居 {Math.round(a.habitability * 100)}%
        </span>
      </Line>
      {p.groups.map((g) => (
        <ShareRow color={g.culture?.color ?? 'transparent'} label={g.label} share={g.share} title={`${popText(g.people)} 人${g.group ? ` · ${g.group.name}` : ''}`} />
      ))}
      {p.other > 0.005 && <ShareRow color="transparent" label="其他" share={p.other} />}
    </>
  );
}

// 钉住时：总人数可以改；群体可以去掉、加上，占比可以改（写百分比）
function PopEditable({ p, a, w }: { p: Pop; a: CellArchive; w: World }) {
  const [total, setTotal] = useState(popText(p.total));
  const [adding, setAdding] = useState('');
  useEffect(() => setTotal(popText(p.total)), [a.cell, p.total]);
  const rows: PopRow[] = popRows(p);
  const groups = new Map(worldCultureGroups(w.small).map((g) => [g.id, g.name]));
  const commitTotal = () => {
    const cmd = cellTotalCommand(a.cell, total, p.total);
    if (cmd) run(cmd, '正在计算…');
    else setTotal(popText(p.total));
  };
  return (
    <>
      <Line label="人口">
        <input
          class="grow"
          value={total}
          title="可以写 5000、3.2万、1.5亿"
          onInput={(e) => setTotal((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setTotal(popText(p.total));
            }
          }}
          onBlur={commitTotal}
        />
        <span class="hint">{densityText(p.density)}</span>
        {p.manual && <span class="tag">手改</span>}
      </Line>
      {p.total > 0 &&
        p.groups.map((g, k) => (
          <ShareRow color={g.culture?.color ?? 'transparent'} label={g.label} share={g.share} title={`${popText(g.people)} 人`}>
            <input
              class="share-input"
              type="number"
              min={0}
              max={100}
              value={Math.round(g.share * 100)}
              title="占比（%）"
              onChange={(e) => run(groupShareCommand(a.cell, rows, k, Number((e.target as HTMLInputElement).value) / 100), '正在计算…')}
            />
            <button class="icon-btn" title="删除" onClick={() => run(removeGroupCommand(a.cell, rows, k), '正在计算…')}>
              <X />
            </button>
          </ShareRow>
        ))}
      {p.total > 0 && p.other > 0.005 && <ShareRow color="transparent" label="其他" share={p.other} />}
      {p.total > 0 && (
        <Line label="加上">
          <select class="grow" value={adding} onChange={(e) => setAdding((e.target as HTMLSelectElement).value)}>
            <option value="">选文化</option>
            {[...groups.entries()].map(([gid, gname]) => (
              <optgroup label={gname}>
                {worldCultures(w.small)
                  .filter((c) => c.group === gid)
                  .map((c) => (
                    <option value={c.id}>{c.name}</option>
                  ))}
              </optgroup>
            ))}
          </select>
          <button
            class="icon-btn"
            title="加上这个文化最常见的一群人，占 25%"
            disabled={!adding}
            onClick={() => {
              run(addGroupCommand(a.cell, rows, typicalTuple(w, adding)), '正在计算…');
              setAdding('');
            }}
          >
            <Plus />
          </button>
        </Line>
      )}
    </>
  );
}

function ReadOnly({ a, w }: { a: CellArchive; w: World }) {
  const resName = a.resource ? a.resource.name : a.resourceNone;
  return (
    <>
      <CountryLine w={w} cell={a.cell} />
      <Line label="名字">
        <span class="grow">
          {a.name}
          {a.orig && <span class="hint"> {a.orig}</span>}
        </span>
      </Line>
      {a.peak && (
        <Line label="山峰">
          <span class="grow">
            ▲ {a.peak.name} · {a.peak.elevation} m
          </span>
        </Line>
      )}
      {a.terrainClass && (
        <Line label="地形">
          <span class="swatch" style={{ background: a.terrainClass.color }} />
          <span class="grow">
            {a.terrainClass.name}
            {a.terrainClass.auto && <span class="hint">（自动）</span>}
          </span>
        </Line>
      )}
      {a.surface === 'land' && (
        <Line label="资源">
          {a.resource && <span class="swatch" style={{ background: a.resource.color }} />}
          <span class="grow">
            {resName}
            {a.resource && <span class="hint"> · {a.resource.categoryLabel}</span>}
            {a.resourceAuto && <span class="hint">（自动）</span>}
          </span>
        </Line>
      )}
      {a.population && <PopReadOnly p={a.population} a={a} />}
      {a.note && <p class="arch-note">{a.note}</p>}
      <p class="hint">右键点地图上的一格，钉住后可改</p>
    </>
  );
}

function Editable({ a, w }: { a: CellArchive; w: World }) {
  const [name, setName] = useState(a.name);
  const [orig, setOrig] = useState(a.orig ?? '');
  const [note, setNote] = useState(a.note ?? '');
  useEffect(() => {
    setName(a.name);
    setOrig(a.orig ?? '');
  }, [a.cell, a.name, a.orig]);
  useEffect(() => setNote(a.note ?? ''), [a.cell, a.note]);
  // 换了一格（钉到别处、取消钉住）之前没离开备注框：写进原来那一格。sent：已经发出的（结果还没回来）
  const pendingNote = useRef<{ cell: number; text: string; before?: string } | null>(null);
  const sent = useRef<string | null>(null);
  pendingNote.current = { cell: a.cell, text: note, before: a.note };
  useEffect(
    () => () => {
      const p = pendingNote.current;
      if (p && sent.current !== `${p.cell}:${p.text.trim()}`) run(noteCommand(p.cell, p.text, p.before));
      sent.current = null;
    },
    [a.cell],
  );
  const saveNote = () => {
    const cmd = noteCommand(a.cell, note, a.note);
    if (!cmd || sent.current === `${a.cell}:${note.trim()}`) return;
    sent.current = `${a.cell}:${note.trim()}`;
    run(cmd);
  };
  const commitName = () => {
    if (!name.trim()) {
      setName(a.name);
      return;
    }
    run(renameCommand(a, name, orig), '正在改名…');
  };
  const keys = (reset: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      e.stopPropagation();
      reset();
    }
  };
  const salt = w.small.cells?.[a.cell]?.salt ?? 0;
  const auto = autoNameCommand(a, salt);
  const classes = worldTerrainClasses(w.small);
  const resources = worldResources(w.small);
  const tc = a.terrainClass;
  const resId = a.resourceAuto ? '' : a.resource ? a.resource.id : 'none';
  const resColor = a.resource?.color;
  return (
    <>
      <Line label="名字">
        <input
          class="grow"
          value={name}
          maxLength={40}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={keys(() => setName(a.name))}
          onBlur={commitName}
          title={a.feature ? '山脉的主峰：改的是地图上的名字' : undefined}
        />
        <input
          class="arch-orig"
          value={orig}
          maxLength={80}
          placeholder="原文"
          onInput={(e) => setOrig((e.target as HTMLInputElement).value)}
          onKeyDown={keys(() => setOrig(a.orig ?? ''))}
          onBlur={() => (orig.trim() !== (a.orig ?? '') ? commitName() : undefined)}
        />
      </Line>
      <div class="arch-actions">
        <SelectionActions reroll={() => run(rerollCommand(a), '正在起名…')} unlock={auto ? () => run(auto, '正在起名…') : undefined} />
      </div>
      <CountryLine w={w} cell={a.cell} />
      {a.peak && (
        <Line label="山峰">
          <Mountain />
          <span class="grow">
            {a.peak.name} · {a.peak.elevation} m
          </span>
        </Line>
      )}
      {tc && (
        <Line label="地形">
          <span class="swatch" style={{ background: tc.color }} />
          <select class="grow" value={tc.auto ? '' : tc.id} onChange={(e) => run(cellClassCommand(a.cell, (e.target as HTMLSelectElement).value || null), '正在计算…')}>
            <option value="">自动：{autoClassName(w, a.cell)}</option>
            {classes.map((c) => (
              <option value={c.id}>{c.name}</option>
            ))}
          </select>
        </Line>
      )}
      {a.surface === 'land' && (
        <Line label="资源">
          <span class="swatch" style={{ background: resColor ?? 'transparent' }} />
          <select class="grow" value={resId} onChange={(e) => run(cellResourceCommand(a.cell, (e.target as HTMLSelectElement).value || null), '正在计算…')}>
            <option value="">自动：{autoResourceName(w, a.cell)}</option>
            <option value="none">{tc && classAt(w.small, w.derived.terrainClass[a.cell])?.ore ? '无矿' : '无'}</option>
            {resources.map((r) => (
              <option value={r.id}>
                {r.name} · {CATEGORY_LABEL[r.category]}
              </option>
            ))}
          </select>
        </Line>
      )}
      {a.population && a.surface === 'land' && <PopEditable p={a.population} a={a} w={w} />}
      <textarea
        class="arch-note-input"
        rows={2}
        maxLength={2000}
        placeholder="备注"
        value={note}
        onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
        onBlur={saveNote}
      />
    </>
  );
}

export function ArchiveBox({ w, cell, pinned }: { w: World; cell: number; pinned: boolean }) {
  const a = cellArchive(w, cell);
  return (
    <section class="archive">
      <h5>档案</h5>
      {pinned ? <Editable a={a} w={w} /> : <ReadOnly a={a} w={w} />}
    </section>
  );
}
