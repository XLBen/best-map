import { ChevronRight } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ImportPreview, ImportRow, ImportTarget } from '../../../core/packs/closure';
import { importPreview } from '../../../core/packs/closure';
import { library } from '../../library';
import { showToast, world } from '../../state';
import { LibraryPick } from '../components/LibraryPick';
import { ModalHead } from '../common';
import { CHILD_SHOW } from './page-children';
import { type PickRow, type PickSection, askOf, chooseFile, chooseFrom, closeImport, hasRef, hereState, importWindow, matchRow, pickSections, regenLine, runImport, setPicks, sourceOf, targetOf, targetTitle, toggleDep, toggleOptional, togglePick } from './page-import';
import type { PageCtx } from './page-source';
import { openPackImport } from './store';

// 导入窗口（第六十一轮）：选一个库 → 按种类分组勾 → 下面列还会带上、已经有了、会改名 → 确认后写入（一步）。逻辑都在 page-import.ts

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

function PickLine({ r, target, picked, dep }: { r: PickRow; target: ImportTarget; picked: boolean; dep: ImportRow | undefined }) {
  const here = hereState(r, target);
  // 灰字：勾了以后会怎样（来自闭包），没勾时看目的地
  const state = dep?.state === 'rename' ? `会改名为 ${dep.to}` : dep?.state === 'have' || here === 'same' ? '已经有了' : here === 'differs' ? '同 id、内容不同' : null;
  return (
    <div class={`imp-row ${picked ? 'on' : ''}`}>
      <Check checked={picked} onChange={(on) => togglePick({ kind: r.kind, id: r.id }, on)}>
        {r.color && <span class="swatch" style={{ background: r.color }} />}
        <span class="ellipsis imp-name">{r.name}</span>
        {r.hint && <span class="hint ellipsis">{r.hint}</span>}
      </Check>
      {!picked && dep && dep.cls !== 'pick' && dep.state !== 'off' && dep.state !== 'have' && <span class="hint imp-state">还会带上</span>}
      {state && <span class="hint imp-state">{state}</span>}
    </div>
  );
}

function PickGroup({ s, query, target, picks, deps, open, onToggle }: { s: PickSection; query: string; target: ImportTarget; picks: readonly { kind: string; id: string }[]; deps: Map<string, ImportRow>; open: boolean; onToggle: () => void }) {
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
        <Check checked={all} indeterminate={pickedCount > 0 && !all} title="整组勾" onChange={(on) => setPicks(refs(s.rows), on)}>
          <b>{s.title}</b>
        </Check>
        <span class="lp-count">{pickedCount ? `${pickedCount} / ${s.rows.length}` : s.rows.length}</span>
      </div>
      {shown && (
        <div class="imp-rows">
          {hits.map((r) => (
            <PickLine key={`${r.kind}:${r.id}`} r={r} target={target} picked={hasRef(picks, r)} dep={deps.get(`${r.kind}:${r.id}`)} />
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

// ---------- 下面：还会带上 ----------

function whyText(r: ImportRow): string {
  return `${r.why.join('；')}${r.whyMore ? ` 等 ${r.why.length + r.whyMore} 处` : ''}`;
}

function DepLine({ r }: { r: ImportRow }) {
  const off = r.state === 'off';
  const ref = { kind: r.kind, id: r.id };
  return (
    <div class={`imp-dep ${off ? 'off' : ''}`}>
      <Check checked={!off} disabled={!!r.locked} title={r.locked ? `不能取消：${r.locked}` : r.offNote} onChange={(on) => toggleDep(ref, on)}>
        <span class="ellipsis imp-name">{r.name}</span>
        {r.count ? <span class="hint">{r.count} 种取值</span> : null}
        {r.state === 'rename' && <span class="hint">改名为 {r.to}</span>}
      </Check>
      <span class="hint imp-why">{r.locked ? `不能取消：${r.locked}` : off ? (r.offNote ?? whyText(r)) : whyText(r)}</span>
    </div>
  );
}

const DEP_SHOW = 8;
function DepKind({ title, rows }: { title: string; rows: ImportRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, DEP_SHOW);
  return (
    <div class="imp-dep-group">
      <h6>{title}</h6>
      {shown.map((r) => (
        <DepLine key={`${r.kind}:${r.id}`} r={r} />
      ))}
      {rows.length > shown.length && (
        <button class="small imp-more" onClick={() => setAll(true)}>
          还有 {rows.length - shown.length} 个
        </button>
      )}
    </div>
  );
}

function byKind(rows: readonly ImportRow[]): [string, ImportRow[]][] {
  const m = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const k = r.kind === 'dimension' ? '变量' : r.kindLabel;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m];
}

// 收着的一段（已经有了、会改名、去掉的引用）
function Fold({ title, count, children }: { title: string; count: number; children: unknown }) {
  if (!count) return null;
  return (
    <details class="imp-fold">
      <summary>
        {title} <span class="lp-count">{count}</span>
      </summary>
      <div class="imp-fold-body">{children as never}</div>
    </details>
  );
}

function Summary({ p, target }: { p: ImportPreview; target: ImportTarget }) {
  const line = regenLine(p, target);
  return (
    <div class="imp-summary">
      {p.bring.length > 0 && (
        <section class="imp-bring">
          <h5>还会带上</h5>
          {byKind(p.bring).map(([k, rows]) => (
            <DepKind key={k} title={k} rows={rows} />
          ))}
        </section>
      )}
      {p.optional.length > 0 && (
        <section class="imp-bring">
          <h5>可以带上</h5>
          {p.optional.map((r) => (
            <div class="imp-dep off" key={r.id}>
              <Check checked={false} title={r.offNote} onChange={(on) => toggleOptional({ kind: r.kind, id: r.id }, on)}>
                <span class="ellipsis imp-name">{r.name}</span>
                {r.count ? <span class="hint">{r.count} 种取值</span> : null}
              </Check>
              <span class="hint imp-why">{whyText(r)}。不带时这几条去掉</span>
            </div>
          ))}
        </section>
      )}
      <Fold title="已经有了" count={p.have.length}>
        <p class="hint">{p.have.map((r) => (r.to ? `${r.name}（${r.to}）` : r.name)).join('、')}</p>
      </Fold>
      <Fold title="会改名" count={p.renamed.length}>
        <p class="hint">目的地有同 id、内容不同的，原来的不动，写到它的引用跟着改</p>
        <ul class="small imp-list">
          {p.renamed.slice(0, 40).map((r) => (
            <li key={`${r.kind}:${r.id}`}>
              {r.kindLabel} {r.name}：{r.id} → {r.to}
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="去掉的引用" count={p.stripped.length}>
        <p class="hint">目的地没有目标的引用去掉，不把目标带来</p>
        <ul class="small imp-list">
          {p.stripped.slice(0, 40).map((s, k) => (
            <li key={k}>
              {s.fromName} · {s.label}：{s.target}
            </li>
          ))}
          {p.stripped.length > 40 && <li>还有 {p.stripped.length - 40} 处</li>}
        </ul>
      </Fold>
      {p.blocked.map((r) => (
        <p class="warn small" key={r.id}>
          {r.kindLabel}“{r.name}”带不了：{r.why[0]}
        </p>
      ))}
      {p.over.map((t) => (
        <p class="warn small" key={t}>
          放不下：{t}
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
  const preview = useMemo(() => (ask ? importPreview(ask) : null), [ask?.source, ask?.target.t === 'world' ? ask.target.world : ask?.target.pack, st.picks, st.off, st.on]);
  const deps = useMemo(() => {
    const m = new Map<string, ImportRow>();
    for (const r of [...(preview?.bring ?? []), ...(preview?.have ?? []), ...(preview?.renamed ?? [])]) m.set(`${r.kind}:${r.id}`, r);
    return m;
  }, [preview]);
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
                target={target}
                picks={st.picks}
                deps={deps}
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
        <button class="primary" disabled={!count || working || !!preview?.over.length} onClick={() => void confirm()}>
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
