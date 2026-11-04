import { Check, ChevronRight, GripVertical, Plus } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { kindOf } from '../../../core/content/registry';
import { libEdits } from '../../library-edit';
import { showToast } from '../../state';
import { type ListPage, type ListRow, type PageCtx, type Route, type SourceRef, entryOf, listPage, sourceKind } from './pages';
import { newItemIn } from './page-actions';
import { copyToMine, goTo, libPanel } from './panel-store';
import { addCommand, packAddCommand, packTree } from './repo';
import { runTrusted, swatchOf } from './repo-actions';

// 列表（第五十九轮）：这一种内容的每一项，点进去是这一项的页面。库里的每一行右边写在不在本世界（能添加）。
// 我的库里能拖动换先后（同一个小包里）

const SEARCH_FROM = 12;

let dragging: string | null = null;

function Row({ r, src, ctx, movable }: { r: ListRow; src: SourceRef; ctx: PageCtx; movable: boolean }) {
  const swatch = swatchOf(r);
  const st = r.row.status;
  const [over, setOver] = useState(false);
  const inLib = src.t === 'lib' && !!ctx.world;
  const add = () => {
    const cmd = ctx.world ? addCommand(r.row, ctx.world) : null;
    if (cmd) void runTrusted(cmd, '正在添加…');
  };
  return (
    <div
      class={`lp-row ${over ? 'drop-before' : ''}`}
      draggable={movable}
      onDragStart={(e) => {
        dragging = r.id;
        e.dataTransfer?.setData('text/plain', r.id);
      }}
      onDragEnd={() => {
        dragging = null;
        setOver(false);
      }}
      onDragOver={(e) => {
        if (!dragging || dragging === r.id) return;
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const from = dragging;
        dragging = null;
        if (!from || from === r.id || src.t !== 'lib') return;
        e.preventDefault();
        const done = libEdits.moveItem(src.key, r.kind.id, from, r.id);
        if (!done.ok) showToast(done.error, true);
      }}
    >
      {movable && (
        <span class="repo-grip" title="拖动换先后">
          <GripVertical />
        </span>
      )}
      <button class="lp-row-main" onClick={() => goTo({ p: 'item', kind: r.kind.id, id: r.id })}>
        {swatch ? <span class="swatch" style={{ background: swatch }} /> : null}
        <span class="lp-row-name ellipsis">{r.name}</span>
        {r.hint && <span class="hint ellipsis lp-row-hint">{r.hint}</span>}
        {st.modified && <span class="hint">改过</span>}
        {st.isDefault && <span class="hint">{r.kind.id === 'mapStyle' ? '在用' : '默认'}</span>}
      </button>
      {inLib &&
        (st.on ? (
          <span class="lp-on" title="已在本世界">
            <Check />
          </span>
        ) : (
          <button class="small" disabled={!!st.locked} title={st.locked ?? '添加到本世界'} onClick={add}>
            添加
          </button>
        ))}
      <ChevronRight class="lp-chevron" />
    </div>
  );
}

// 这一份里还不在本世界的全部添加
function AddAll({ p, src, ctx }: { p: ListPage; src: SourceRef; ctx: PageCtx }) {
  const e = entryOf(src, ctx);
  const left = p.sections.some((s) => s.rows.some((r) => !r.row.status.on && !r.row.status.locked));
  if (!e || !ctx.world || !left) return null;
  const run = () => {
    const top = packTree(ctx.world, [e], p.kind.id).library[0];
    const cmd = top && ctx.world ? packAddCommand(top, ctx.world) : null;
    if (cmd) void runTrusted(cmd, '正在添加…');
  };
  return (
    <button class="small" title="这一种还不在本世界的都添加" onClick={run}>
      全部添加
    </button>
  );
}

export function PageList({ route, src, ctx }: { route: Extract<Route, { p: 'list' }>; src: SourceRef; ctx: PageCtx }) {
  const [q, setQ] = useState('');
  const p = useMemo(() => listPage(src, route, ctx, q), [src.t === 'lib' ? src.key : '', route, ctx.world, ctx.lib, q]);
  if (!p) return null;
  const create = async (kindId: string, defaults: Record<string, unknown>) => {
    const kind = kindOf(kindId);
    if (!kind) return;
    const r = await newItemIn(src, kind, ctx, defaults);
    if (r && libPanel.value) goTo(r);
  };
  const movable = p.canMove && !route.dim && !route.group;
  return (
    <>
      <div class="lp-tools">
        {(p.total > SEARCH_FROM || q) && <input class="grow" type="search" placeholder="搜索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />}
        {!(p.total > SEARCH_FROM || q) && <span class="grow" />}
        <AddAll p={p} src={src} ctx={ctx} />
        {p.readonly && sourceKind(src, ctx) !== 'world' && (
          <button class="small" title={p.readonly} onClick={() => void copyToMine(src)}>
            复制成我的库
          </button>
        )}
        {p.alsoNew && (
          <button class="small" onClick={() => void create(p.alsoNew!, p.defaults)}>
            <Plus /> 新建组
          </button>
        )}
        {p.canNew && (
          <button class="small" onClick={() => void create(p.kind.id, p.defaults)}>
            <Plus /> 新建
          </button>
        )}
      </div>
      {p.note && <p class="hint lp-note">{p.note}</p>}
      {p.total === 0 && !p.sections.length && <p class="hint lp-note">{p.empty}</p>}
      {p.sections.map((s, k) => (
        <section class="lp-section" key={k}>
          {s.label &&
            (s.link ? (
              <button class="lp-section-link" onClick={() => goTo(s.link!)}>
                <h5>{s.label}</h5>
                <ChevronRight />
              </button>
            ) : (
              <h5>{s.label}</h5>
            ))}
          <div class="lp-rows">
            {s.rows.map((r) => (
              <Row key={r.key} r={r} src={src} ctx={ctx} movable={movable} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
