import { ChevronRight } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ImportGate, ImportGates, ImportPreview, ImportRow, ImportTarget } from '../../../core/packs/closure';
import { importPreview } from '../../../core/packs/closure';
import { library } from '../../library';
import { showToast, world } from '../../state';
import { LibraryPick } from '../components/LibraryPick';
import { ModalHead } from '../common';
import { CHILD_SHOW } from './page-children';
import { type PickRow, type PickSection, askOf, chooseFile, chooseFrom, closeImport, hasRef, importWindow, matchRow, pickSections, regenLine, runImport, setPicks, sourceOf, targetOf, targetTitle, toggleDep, togglePick } from './page-import';
import type { PageCtx } from './page-source';
import { openPackImport } from './store';

// 导入窗口（第六十一轮）：选一个库 → 按种类分组勾（灰的写原因） → 下面列会写入的 → 确认后写入（一步）。逻辑都在 page-import.ts。第六十五轮重写成两栏

// ---------- 上面：勾 ----------

function Check({ checked, disabled, onChange, children, title, indeterminate }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: unknown; title?: string; indeterminate?: boolean }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label class="check imp-check" title={title}>
      <input ref={box} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      {children as never}
    </label>
  );
}

// 灰的、已经有了的不能勾
function canPick(gates: ImportGates | null, r: PickRow): boolean {
  const t = gates?.of({ kind: r.kind, id: r.id }).t;
  return t !== 'gated' && t !== 'full' && t !== 'have';
}

function gateText(g: ImportGate): string | null {
  if (g.t === 'gated' || g.t === 'full') return g.reason;
  if (g.t === 'have') return '已经有了';
  if (g.t === 'fixable') return g.restores.length ? `补回：${g.restores.join('、')}` : '勾上才参与生成';
  return g.differs ? '有一份不同的，导入后并存' : null;
}

function PickLine({ r, gates, picked, row }: { r: PickRow; gates: ImportGates | null; picked: boolean; row: ImportRow | undefined }) {
  const gate = gates?.of({ kind: r.kind, id: r.id });
  const grey = !canPick(gates, r);
  const state = row?.state === 'rename' ? `会叫 ${row.to}` : gate ? gateText(gate) : null;
  return (
    <div class={`imp-row ${picked ? 'on' : ''}`}>
      <Check checked={picked || !!row} disabled={grey && !picked} onChange={(on) => (!on && !picked ? toggleDep({ kind: r.kind, id: r.id }, false) : togglePick({ kind: r.kind, id: r.id }, on))}>
        {r.color && <span class="swatch" style={{ background: r.color }} />}
        <span class="ellipsis imp-name">{r.name}</span>
        {r.hint && <span class="hint ellipsis">{r.hint}</span>}
      </Check>
      {!picked && row && <span class="hint imp-state">{row.because[0]}</span>}
      {state && <span class="hint imp-state">{state}</span>}
    </div>
  );
}

function PickGroup({ s, query, gates, picks, rows: planned, open, onToggle }: { s: PickSection; query: string; gates: ImportGates | null; picks: readonly { kind: string; id: string }[]; rows: Map<string, ImportRow>; open: boolean; onToggle: () => void }) {
  const [limit, setLimit] = useState(CHILD_SHOW);
  const rows = useMemo(() => (query ? s.rows.filter((r) => matchRow(r, query)) : s.rows), [s, query]);
  if (query && !rows.length) return null;
  const pickedCount = s.rows.filter((r) => hasRef(picks, r)).length;
  const refs = (list: readonly PickRow[]) => list.map((r) => ({ kind: r.kind, id: r.id }));
  const shown = open || !!query;
  const all = pickedCount === s.rows.length && s.rows.length > 0;
  const hits = shown ? rows.slice(0, limit) : [];
  return (
    <section class={`imp-group ${shown ? 'open' : ''}`}>
      <div class="imp-group-head">
        <button class="icon-btn imp-twist" title={shown ? '收起' : '展开'} onClick={onToggle}>
          <ChevronRight />
        </button>
        <Check checked={all} indeterminate={pickedCount > 0 && !all} title="整组勾" onChange={(on) => setPicks(refs(s.rows.filter((r) => !on || hasRef(picks, r) || canPick(gates, r))), on)}>
          <b>{s.title}</b>
        </Check>
        <span class="lp-count">{pickedCount ? `${pickedCount} / ${s.rows.length}` : s.rows.length}</span>
      </div>
      {shown && (
        <div class="imp-rows">
          {hits.map((r) => (
            <PickLine key={`${r.kind}:${r.id}`} r={r} gates={gates} picked={hasRef(picks, r)} row={planned.get(`${r.kind}:${r.id}`)} />
          ))}
          {rows.length > hits.length && (
            <button class="small imp-more" onClick={() => setLimit(limit + CHILD_SHOW * 4)}>
              还有 {rows.length - hits.length} 个
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- 下面：会写入的 ----------

const SHOW_ROWS = 40;

function PlanLine({ r, depth }: { r: ImportRow; depth: number }) {
  const ref = { kind: r.kind, id: r.id };
  // 勾的去掉勾，别的记进 off（跟着来的去掉时，要它的也进不来）
  const remove = () => (r.role === 'pick' ? togglePick(ref, false) : toggleDep(ref, false));
  return (
    <>
      <div class="imp-dep" style={{ paddingLeft: `${depth * 12}px` }}>
        <span class="ellipsis imp-name">{r.name}</span>
        <span class="hint">{r.kindLabel}</span>
        {r.state === 'rename' && <span class="hint">会叫 {r.to}</span>}
        {r.state === 'fix' && <span class="hint">补回引用</span>}
        {r.because[0] && <span class="hint imp-why">{r.because[0]}</span>}
        {r.kind !== 'field' && (
          <button class="small" title={r.role === 'follow' ? '去掉后要它的那一项也进不来' : '不导入这一项'} onClick={remove}>
            ×
          </button>
        )}
      </div>
      {r.children.slice(0, SHOW_ROWS).map((x) => (
        <PlanLine key={`${x.kind}:${x.id}`} r={x} depth={depth + 1} />
      ))}
      {r.children.length > SHOW_ROWS && <p class="hint">还有 {r.children.length - SHOW_ROWS} 项</p>}
    </>
  );
}

function Summary({ p, target }: { p: ImportPreview; target: ImportTarget }) {
  const line = regenLine(p, target);
  return (
    <div class="imp-summary">
      {p.list.length > 0 && (
        <section class="imp-bring">
          <h5>将导入 {p.count} 项</h5>
          {p.list.slice(0, SHOW_ROWS).map((r) => (
            <PlanLine key={`${r.kind}:${r.id}`} r={r} depth={0} />
          ))}
          {p.list.length > SHOW_ROWS && <p class="hint">还有 {p.list.length - SHOW_ROWS} 项</p>}
        </section>
      )}
      {p.stripCount > 0 && <p class="hint">自动去掉 {p.stripCount} 条写到这里没有的内容</p>}
      {p.dropped.map((d) => (
        <p class="warn small" key={`${d.kind}:${d.id}`}>
          {d.kindLabel}“{d.name}”进不来：{d.reason}
        </p>
      ))}
      {line && <p class="hint imp-regen">{line}</p>}
    </div>
  );
}

// ---------- 窗口 ----------

function Body() {
  const st = importWindow.value!;
  const ctx: PageCtx = { world: world.value, lib: library.value };
  const target = targetOf(st, ctx);
  const source = sourceOf(st, ctx);
  const [q, setQ] = useState('');
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(st.focus ? [st.focus] : []));
  const [working, setWorking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sections = useMemo(() => (source && target ? pickSections(source, target) : []), [source, target?.t === 'world' ? target.world.small.content?.era : target?.pack]);
  const ask = askOf(st, ctx);
  const preview = useMemo(() => (ask ? importPreview(ask) : null), [ask?.source, ask?.target.t === 'world' ? ask.target.world : ask?.target.pack, st.picks, st.off]);
  const planned = useMemo(() => new Map((preview?.rows ?? []).map((r) => [`${r.kind}:${r.id}`, r])), [preview]);
  const query = q.trim().toLowerCase();
  const count = preview?.count ?? 0;
  const confirm = async () => {
    setWorking(true);
    try {
      const r = await runImport(st, ctx);
      if (r.error) showToast(r.error, true);
      if (r.ok) {
        const line = preview && target ? regenLine(preview, target) : null;
        showToast(`已导入 ${r.count} 项${line ? `。${line}` : ''}`);
        closeImport();
      }
    } finally {
      setWorking(false);
    }
  };
  const read = st.file?.read;
  return (
    <>
      <ModalHead title={`导入到${targetTitle(st, ctx)}`} onClose={closeImport} closeTitle="取消" />
      <div class="imp-source">
        <span class="hint">从</span>
        {st.file ? (
          <b class="ellipsis grow" title={st.file.name}>
            {read?.ok ? read.pack.name : st.file.name}
          </b>
        ) : (
          <span class="grow imp-pick">
            <LibraryPick compact any exclude={st.target.t === 'lib' ? st.target.key : undefined} value={st.from} lib={ctx.lib} onChange={chooseFrom} />
          </span>
        )}
        {st.file && (
          <button class="small" onClick={() => chooseFrom(st.from ?? '')}>
            选库
          </button>
        )}
        <button class="small" title="读资源包文件，不运行脚本" onClick={() => fileInput.current?.click()}>
          读文件…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(ev) => {
            const f = (ev.target as HTMLInputElement).files?.[0];
            if (f) void chooseFile(f);
            (ev.target as HTMLInputElement).value = '';
          }}
        />
      </div>
      {read && !read.ok && (
        <>
          <p class="warn">读不了“{st.file!.name}”：</p>
          <ul class="small">
            {read.errors.slice(0, 8).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
      {read?.ok && (
        <p class="hint imp-file">
          只导入勾的。
          <button class="small" onClick={() => openPackImport(read, st.file!.name)}>
            装进资源库…
          </button>
        </p>
      )}
      {source && target && (
        <>
          <div class="lp-tools imp-tools">
            <input class="grow" type="search" placeholder="搜索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
          <div class="imp-list-box">
            {sections.map((s) => (
              <PickGroup
                key={s.kind}
                s={s}
                query={query}
                gates={preview?.gates ?? null}
                picks={st.picks}
                rows={planned}
                open={opened.has(s.kind)}
                onToggle={() => {
                  const next = new Set(opened);
                  if (!next.delete(s.kind)) next.add(s.kind);
                  setOpened(next);
                }}
              />
            ))}
            {!sections.length && <p class="hint">这个库是空的</p>}
          </div>
          {preview && st.picks.length > 0 && <Summary p={preview} target={target} />}
        </>
      )}
      <div class="modal-foot">
        <button onClick={closeImport}>取消</button>
        <button class="primary" disabled={!count || working} onClick={() => void confirm()}>
          {st.picks.length && !count ? '都已经有了' : `导入${count ? ` ${count} 项` : ''}`}
        </button>
      </div>
    </>
  );
}

export function ImportDialog() {
  if (!importWindow.value) return null;
  return (
    <div class="modal-backdrop" onClick={closeImport}>
      <div class="modal import" onClick={(e) => e.stopPropagation()}>
        <Body />
      </div>
    </div>
  );
}
