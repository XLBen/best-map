import { Check, ChevronRight, Eraser, GripVertical, Plus } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { cleanableSet } from '../../../core/content/cleanable';
import type { ImportGates } from '../../../core/packs/closure';
import { kindOf } from '../../../core/content/registry';
import { libEdits } from '../../library-edit';
import { showToast } from '../../state';
import { type ListPage, type ListRow, type PageCtx, type Route, type SourceRef, entryOf, listPage, rowsOf, sourceKind } from './pages';
import { newItemIn } from './page-actions';
import { addBlock, addGates, addRows, openImport, otherLibOptions } from './page-import';
import { InsideRows } from './PageChildren';
import { RefPicker } from './RefPicker';
import { copyToMine, goTo, libPanel } from './panel-store';
import { swatchOf } from './row-actions';
import { tidyWorld } from './tidy';

// 列表（第五十九轮）：这一种内容的每一项，点进去是这一项的页面。库里的每一行右边写在不在本世界（能添加）。
// 我的库里能拖动换先后（同一个小包里）

let dragging: string | null = null;

const FAINT_NOTE = '生成后没用到，清理时会清掉';

function Row({ r, src, ctx, movable, gates }: { r: ListRow; src: SourceRef; ctx: PageCtx; movable: boolean; gates: ImportGates | null }) {
  const swatch = swatchOf(r);
  const st = r.row.status;
  const [over, setOver] = useState(false);
  const inLib = src.t === 'lib' && !!ctx.world;
  // 走导入的闭包（第六十一轮）：一个政体也带上派系，不留下找不到的引用。灰的写原因，不能加（第六十五轮）
  const blocked = inLib && !st.on && !st.locked ? addBlock(gates, r.row) : null;
  const add = () => addRows([r.row], src, ctx, `添加到本世界：${r.kind.label}“${r.name}”`);
  return (
    <div
      class={`lp-row ${over ? 'drop-before' : ''} ${r.mark?.faint ? 'faint' : ''}`}
      title={r.mark?.faint ? FAINT_NOTE : undefined}
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
        <span class="lp-grip" title="拖动换先后">
          <GripVertical />
        </span>
      )}
      <button class="lp-row-main" onClick={() => goTo({ p: 'item', kind: r.kind.id, id: r.id })}>
        {swatch ? <span class="swatch" style={{ background: swatch }} /> : null}
        <span class="lp-row-name ellipsis">{r.name}</span>
        {r.hint && <span class="hint ellipsis lp-row-hint">{r.hint}</span>}
        {src.t === 'lib' && st.modified && <span class="hint">本世界改过</span>}
        {r.mark?.changed && (
          <span class="lp-diff" title="和来源的库不同">
            和库不同
          </span>
        )}
        {st.isDefault && <span class="hint">{r.kind.id === 'mapStyle' ? '在用' : '默认'}</span>}
      </button>
      {inLib &&
        (st.on ? (
          <span class="lp-on" title="已在本世界">
            <Check />
          </span>
        ) : blocked ? (
          <span class="hint ellipsis lp-row-why" title={blocked}>
            {blocked}
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

// 别的库里有、这一份里没有的：选一项打开导入窗口，勾好它
function FromOtherLib({ p, src, ctx }: { p: ListPage; src: SourceRef; ctx: PageCtx }) {
  const options = useMemo(() => otherLibOptions(p.kind.id, src, ctx), [p.kind.id, src.t === 'lib' ? src.key : '', ctx.lib, ctx.world]);
  if (!options.length) return null;
  return (
    <RefPicker add title="从别的库加" options={options} onPick={(id) => {
      const o = options.find((x) => x.id === id);
      if (o) openImport({ target: src, from: o.lib, pick: { kind: p.kind.id, id } }, ctx);
    }}>
      从别的库加
    </RefPicker>
  );
}

// 这一份里还不在本世界的全部添加：灰的跳过，提示写着（第六十五轮）
function AddAll({ p, src, ctx, gates }: { p: ListPage; src: SourceRef; ctx: PageCtx; gates: ImportGates | null }) {
  const e = entryOf(src, ctx);
  const left = p.sections.some((s) => s.rows.some((r) => !r.row.status.on && !r.row.status.locked && !addBlock(gates, r.row)));
  if (!e || !ctx.world || !left) return null;
  const run = () => addRows(rowsOf(src, p.kind, ctx).filter((r) => !r.status.on && !r.status.locked), src, ctx, `添加到本世界：${p.title}`);
  return (
    <button class="small" title="这一种还不在本世界的都添加" onClick={run}>
      全部添加
    </button>
  );
}

export function PageList({ route, src, ctx }: { route: Extract<Route, { p: 'list' }>; src: SourceRef; ctx: PageCtx }) {
  const [q, setQ] = useState('');
  const p = useMemo(() => listPage(src, route, ctx, q), [src.t === 'lib' ? src.key : '', route, ctx.world, ctx.lib, q]);
  const gates = useMemo(() => addGates(src, ctx), [src.t === 'lib' ? src.key : '', ctx.world, ctx.lib]);
  if (!p) return null;
  const create = async (kindId: string, defaults: Record<string, unknown>) => {
    const kind = kindOf(kindId);
    if (!kind) return;
    const r = await newItemIn(src, kind, ctx, defaults);
    if (r && libPanel.value) goTo(r);
  };
  const movable = p.canMove && !route.dim && !route.group;
  // 这一页上有变淡的才写；数是全世界的（点了清的是全世界的，和首页一样）
  const faint = ctx.world && p.sections.some((s) => s.rows.some((r) => r.mark?.faint)) ? cleanableSet(ctx.world).size : 0;
  return (
    <>
      <div class="lp-tools">
        {(p.searchable || q) && <input class="grow" type="search" placeholder="搜索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />}
        {!(p.searchable || q) && <span class="grow" />}
        <AddAll p={p} src={src} ctx={ctx} gates={gates} />
        {!p.readonly && <FromOtherLib p={p} src={src} ctx={ctx} />}
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
      {faint > 0 && (
        <button class="lp-clean" title={FAINT_NOTE} onClick={() => void tidyWorld()}>
          <Eraser />
          <span class="grow">清理没用到的</span>
          <span class="lp-count">{faint}</span>
        </button>
      )}
      {p.note && <p class="hint lp-note">{p.note}</p>}
      {!q && <InsideRows list={p.inside} src={src} ctx={ctx} />}
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
              <Row key={r.key} r={r} src={src} ctx={ctx} gates={gates} movable={movable && r.kind.id === p.kind.id} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
