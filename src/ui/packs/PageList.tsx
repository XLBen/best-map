import { ChevronRight, Eraser, GripVertical, Plus } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cleanableSet } from '../../../core/content/cleanable';
import { DIMENSION } from '../../../core/content/link-rules';
import { kindOf } from '../../../core/content/registry';
import { libEdits } from '../../library-edit';
import { showToast } from '../../state';
import { type ListPage, type ListRow, type PageCtx, type Route, type SourceRef, listPage, sourceKind } from './pages';
import { newItemIn } from './page-actions';
import { InsideRows } from './PageChildren';
import { PickBox } from './PickBox';
import { copyToMine, flashClass, goTo, libPanel, openRoute, toggleOther } from './panel-store';
import { allLook } from './pick-look';
import { type OtherOpen, hasOther, sameOther } from './other-view';
import { setPicksIn } from './pick-store';
import { type PickView, kindPickable, lookOf, pickView } from './pick-view';
import { swatchOf } from './row-actions';
import { tidyWorld } from './tidy';

// 列表（第五十九轮）：这一种内容的每一项，点进去是这一项的页面。我的库里能拖动换先后（同一个小包里，把手在右边）。
// 第六十七轮：看库就是添加。有地方加时库的每一行最左边一个勾（PickBox），列表头“全选”；点一行在右栏打开（openRoute）

let dragging: string | null = null;

const FAINT_NOTE = '生成后没用到，清理时会清掉';

export function Row({ r, src, ctx, movable, v }: { r: ListRow; src: SourceRef; ctx: PageCtx; movable: boolean; v: PickView | null }) {
  const swatch = swatchOf(r);
  const st = r.row.status;
  const [over, setOver] = useState(false);
  const ref = { kind: r.kind.id, id: r.id };
  const pick = v && kindPickable(v, r.kind.id) ? v : null;
  const note = pick ? lookOf(pick, ref).note : null;
  return (
    <div
      class={`lp-row ${over ? 'drop-before' : ''} ${r.mark?.faint ? 'faint' : ''} ${flashClass(r.kind.id, r.id)}`}
      title={r.mark?.faint ? FAINT_NOTE : undefined}
      data-pick-row={v ? '' : undefined}
      tabIndex={v ? -1 : undefined}
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
      {pick ? <PickBox v={pick} r={ref} ctx={ctx} /> : v && <span class="lp-pick" />}
      <button class="lp-row-main" onClick={() => openRoute({ p: 'item', kind: r.kind.id, id: r.id })}>
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
      {note && (
        <span class="hint ellipsis lp-row-why" title={note}>
          {note}
        </span>
      )}
      {movable && (
        <span class="lp-grip end" title="拖动换先后">
          <GripVertical />
        </span>
      )}
      <ChevronRight class="lp-chevron" />
    </div>
  );
}

// 别的库里有这一种时：在右栏打开“从别的库加”（第六十八轮，LibOther.tsx），再点一次收起
function FromOtherLib({ p, route, src, ctx }: { p: ListPage; route: Extract<Route, { p: 'list' }>; src: SourceRef; ctx: PageCtx }) {
  const o: OtherOpen = { kind: p.kind.id, ...(route.dim ? { dim: route.dim } : {}), label: p.title };
  const has = useMemo(() => hasOther(o, src, ctx), [o.kind, o.dim, src.t === 'lib' ? src.key : '', ctx.lib]);
  if (!has) return null;
  const on = sameOther(libPanel.value?.other, o);
  return (
    <button class={`small ${on ? 'open' : ''}`} aria-pressed={on} title={on ? '收起' : `从别的库挑几项${p.title}，可以多选`} onClick={() => toggleOther(o)}>
      <Plus /> 从别的库加
    </button>
  );
}

// 列表头的“全选”：这一页能勾的都勾上（灰的、已经有了的跳过）；变量的取值页勾的是这个变量
function AllBox({ v, p, route, ctx }: { v: PickView; p: ListPage; route: Extract<Route, { p: 'list' }>; ctx: PageCtx }) {
  const refs = useMemo(() => p.sections.flatMap((s) => s.rows.filter((r) => kindPickable(v, r.kind.id)).map((r) => ({ kind: r.kind.id, id: r.id }))), [p]);
  const head = route.dim ? { kind: DIMENSION, id: route.dim } : undefined;
  const a = allLook(refs, v.look, head);
  return (
    <label class="check lp-all" title="这一页能勾的都勾上（灰的、已经有了的跳过）">
      <input
        type="checkbox"
        checked={a.checked}
        disabled={a.disabled}
        ref={(el) => {
          if (el) el.indeterminate = a.mixed;
        }}
        onChange={(e) => {
          const on = (e.target as HTMLInputElement).checked;
          setPicksIn(v.key, on ? a.acts : a.clears, on, ctx);
        }}
      />
      全选
    </label>
  );
}

export function PageList({ route, src, ctx }: { route: Extract<Route, { p: 'list' }>; src: SourceRef; ctx: PageCtx }) {
  const [q, setQ] = useState('');
  const p = useMemo(() => listPage(src, route, ctx, q), [src.t === 'lib' ? src.key : '', route, ctx.world, ctx.lib, q]);
  const v = pickView(src, ctx);
  const search = useRef<HTMLInputElement>(null);
  // 进库的列表时光标在搜索框（第六十七轮）
  useEffect(() => {
    if (v) search.current?.focus({ preventScroll: true });
  }, [!!v]);
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
  const searchable = p.searchable || !!q || !!v;
  return (
    <>
      <div class="lp-tools">
        {v && <AllBox v={v} p={p} route={route} ctx={ctx} />}
        {searchable && <input ref={search} class="grow" type="search" placeholder="搜索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />}
        {!searchable && <span class="grow" />}
        {!p.readonly && <FromOtherLib p={p} route={route} src={src} ctx={ctx} />}
        {p.readonly && sourceKind(src, ctx) !== 'world' && sourceKind(src, ctx) !== 'file' && (
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
              <button class="lp-section-link" onClick={() => openRoute(s.link!)}>
                <h5>{s.label}</h5>
                <ChevronRight />
              </button>
            ) : (
              <h5>{s.label}</h5>
            ))}
          <div class="lp-rows">
            {s.rows.map((r) => (
              <Row key={r.key} r={r} src={src} ctx={ctx} v={v} movable={movable && r.kind.id === p.kind.id} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
