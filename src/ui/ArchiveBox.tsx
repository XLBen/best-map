import { Mountain } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Command } from '../../core/commands';
import { CATEGORY_LABEL, type CellArchive, cellArchive, classAt, resourceAt, worldResources, worldTerrainClasses } from '../../core/human';
import type { World } from '../../core/world';
import { exec } from '../state';
import { SelectionActions } from './components/SelectionActions';
import { autoNameCommand, cellClassCommand, cellResourceCommand, noteCommand, renameCommand, rerollCommand } from './archive';

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

function ReadOnly({ a }: { a: CellArchive }) {
  const resName = a.resource ? a.resource.name : a.resourceNone;
  return (
    <>
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
      {pinned ? <Editable a={a} w={w} /> : <ReadOnly a={a} />}
    </section>
  );
}
