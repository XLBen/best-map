import { Check, ChevronRight, CircleDashed } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ContentRef } from '../../../core/content/links';
import { CHILD_SHOW } from './page-children';
import { setPicks, togglePick, removeRow } from './page-import';
import { type LookCtx, type PickRow, type PickSection, filterRows, initialOpen, rowLook, rowPath, sectionLook } from './page-import-tree';
import type { PageCtx } from './page-source';

// 导入窗口的左边（第六十五轮）：按首页的先后分段，每段能整段勾；段里是树。段默认收起、搜索时展开，收起的段和收起的行都不画（一个库有 400 多个文化）

const ref = (r: PickRow): ContentRef => ({ kind: r.kind, id: r.id });

function Box({ checked, mixed, disabled, title, onChange, children }: { checked: boolean; mixed?: boolean; disabled?: boolean; title?: string; onChange: (on: boolean) => void; children: unknown }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = !!mixed;
  });
  return (
    <label class="check imp-check" title={title}>
      <input
        ref={box}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          onChange(el.checked);
          // 跟着来的点了之后不一定变成勾（要看勾选算出来的）：显示跟着状态走
          el.checked = checked;
          el.indeterminate = !!mixed;
        }}
      />
      {children as never}
    </label>
  );
}

interface View {
  look: LookCtx;
  ctx: PageCtx;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
}

function PickLine({ r, up, depth, v }: { r: PickRow; up: string; depth: number; v: View }) {
  const look = rowLook(ref(r), v.look);
  const path = rowPath(up, r);
  const open = r.children.length > 0 && (r.opened || v.expanded.has(path));
  const text = (
    <>
      {r.color && <span class="swatch" style={{ background: r.color }} />}
      <span class="ellipsis imp-name">{r.name}</span>
      {r.hint && <span class="hint imp-count">{r.hint}</span>}
    </>
  );
  // 勾的、子项点了是去掉；没勾的、跟着来的点了是勾上（跟着来的去掉连要它的一起，在右边的 ×）
  const change = () => {
    if (look.mark === 'on' || (look.mark === 'grey' && look.picked)) togglePick(ref(r), false, v.ctx);
    else if (look.mark === 'child') removeRow(ref(r), v.ctx);
    else togglePick(ref(r), true, v.ctx);
  };
  const on = look.mark === 'on' || look.mark === 'child' || look.picked;
  return (
    <>
      <div class={`imp-row imp-${look.mark}`} style={{ paddingLeft: `${depth * 18}px` }}>
        {r.children.length > 0 ? (
          <button class={`icon-btn imp-twist ${open ? 'open' : ''}`} title={open ? '收起' : '展开'} onClick={() => v.toggle(path)}>
            <ChevronRight />
          </button>
        ) : (
          <span class="imp-twist-gap" />
        )}
        {look.mark === 'have' ? (
          <span class="imp-still" title="已经有了">
            <Check />
            {text}
          </span>
        ) : look.mark === 'grey' && !look.picked ? (
          <span class="imp-still" title={look.note ?? undefined}>
            <CircleDashed />
            {text}
          </span>
        ) : (
          <Box checked={on} mixed={look.mark === 'follow'} title={look.mark === 'follow' ? `${look.note ?? ''}。勾上带上整项` : undefined} onChange={change}>
            {text}
          </Box>
        )}
        {look.note && (
          <span class="hint ellipsis imp-note" title={look.note}>
            {look.note}
          </span>
        )}
      </div>
      {open && r.children.map((c) => <PickLine key={rowPath(path, c)} r={c} up={path} depth={depth + 1} v={v} />)}
    </>
  );
}

function PickGroup({ s, query, v, open, onToggle }: { s: PickSection; query: string; v: View; open: boolean; onToggle: () => void }) {
  const [limit, setLimit] = useState(CHILD_SHOW);
  const rows = useMemo(() => filterRows(s.rows, query), [s, query]);
  if (query && !rows.length) return null;
  const look = sectionLook(s, v.look);
  const shown = open || !!query;
  const hits = shown ? rows.slice(0, limit) : [];
  const change = (on: boolean) => {
    if (on) setPicks(look.acts, true, v.ctx);
    else setPicks(s.head ? [s.head, ...s.refs] : s.refs, false, v.ctx);
  };
  return (
    <section class={`imp-group ${shown ? 'open' : ''}`}>
      <div class="imp-group-head">
        <button class={`icon-btn imp-twist ${shown ? 'open' : ''}`} title={shown ? '收起' : '展开'} onClick={onToggle}>
          <ChevronRight />
        </button>
        <Box checked={look.checked} mixed={look.mixed} disabled={look.disabled} title="整段勾" onChange={change}>
          <b class="ellipsis">{s.title}</b>
        </Box>
        {look.note && <span class="hint ellipsis imp-note">{look.note}</span>}
        <span class="lp-count">{look.count ? `${look.count} / ${look.total}` : look.total}</span>
      </div>
      {shown && (
        <div class="imp-rows">
          {hits.map((r) => (
            <PickLine key={rowPath(s.key, r)} r={r} up={s.key} depth={0} v={v} />
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

export function ImportList({ sections, look, ctx, picks }: { sections: readonly PickSection[]; look: LookCtx; ctx: PageCtx; picks: readonly ContentRef[] }) {
  const [q, setQ] = useState('');
  const [start] = useState(() => initialOpen(sections, picks));
  const [opened, setOpened] = useState<ReadonlySet<string>>(start.sections);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(start.rows);
  const query = q.trim().toLowerCase();
  const flip = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const v: View = { look, ctx, expanded, toggle: (path) => setExpanded(flip(expanded, path)) };
  return (
    <>
      <div class="lp-tools imp-tools">
        <input class="grow" type="search" placeholder="搜索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="imp-list-box">
        {sections.map((s) => (
          <PickGroup key={s.key} s={s} query={query} v={v} open={opened.has(s.key)} onToggle={() => setOpened(flip(opened, s.key))} />
        ))}
        {!sections.length && <p class="hint">这个库是空的</p>}
      </div>
    </>
  );
}
