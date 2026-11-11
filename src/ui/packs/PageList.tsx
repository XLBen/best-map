import { ChevronRight, Eraser, GripVertical, Plus } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cleanableSet } from '../../../core/content/cleanable';
import { DIMENSION } from '../../../core/content/link-rules';
import { kindOf } from '../../../core/content/registry';
import { libEdits } from '../../library-edit';
import { showToast } from '../../state';
import { type ListPage, type ListRow, type PageCtx, type Route, type SourceRef, listPage } from './pages';
import { newItemIn } from './page-actions';
import { InsideRows } from './PageChildren';
import { PickBox } from './PickBox';
import { flashClass, goTo, libPanel, openRoute, startPicking, useFlashScroll } from './panel-store';
import { allLook } from './pick-look';
import { type OtherOpen, hasOther } from './other-view';
import { setPicksIn } from './pick-store';
import { type PickView, kindPickable, lookOf, shownPick } from './pick-view';
import { swatchOf } from './row-actions';
import { oneMark } from './page-marks';
import { NEW_IN_WORLD_NOTE, PICK_ENTER, PICK_ENTER_TIP, TIDY, TIDY_TIP } from './copy';
import { type NewChoice, newChoiceOf } from './new-in';
import { otherLibs, pickFrom } from './other-view';
import { tidyWorld } from './tidy';
import { unpickableNote } from './pick-help';

// 列表（第五十九轮）：这一种内容的每一项，点进去是这一项的页面。我的库里能拖动换先后（同一个小包里，把手在右边）。
// 第六十七轮：看库就是添加。有地方加时库的每一行最左边一个勾（PickBox），列表头“全选”；点一行在右栏打开（openRoute）

let dragging: string | null = null;

const FAINT_NOTE = '生成后没用到，可以删除';

export function Row({ r, src, ctx, movable, v }: { r: ListRow; src: SourceRef; ctx: PageCtx; movable: boolean; v: PickView | null }) {
  const swatch = swatchOf(r);
  const st = r.row.status;
  const [over, setOver] = useState(false);
  const ref = { kind: r.kind.id, id: r.id };
  const pick = v && kindPickable(v, r.kind.id) ? v : null;
  // 第九十二轮：这一种加不了的行也写明为什么（以前只是没有勾）
  const note = pick ? lookOf(pick, ref).note : v ? unpickableNote(v.look.here) : null;
  const rowRef = useRef<HTMLDivElement>(null);
  useFlashScroll(rowRef, r.kind.id, r.id);
  const mark = oneMark({ isDefault: st.isDefault, inUse: r.kind.id === 'mapStyle', changed: r.mark?.changed, modified: src.t === 'lib' && st.modified });
  return (
    <div
      ref={rowRef}
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
        {mark && <span class={mark.diff ? 'lp-diff' : 'hint'}>{mark.text}</span>}
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

// 别的库里有这一种时：从别的库添加（第八十一轮：进入挑选，开到那个库的这一种的列表；以前在右栏开一栏）
function FromOtherLib({ p, route, src, ctx }: { p: ListPage; route: Extract<Route, { p: 'list' }>; src: SourceRef; ctx: PageCtx }) {
  const o: OtherOpen = { kind: p.kind.id, ...(route.dim ? { dim: route.dim } : {}), label: p.title };
  const has = useMemo(() => hasOther(o, src, ctx), [o.kind, o.dim, src.t === 'lib' ? src.key : '', ctx.lib]);
  if (!has) return null;
  return (
    <button
      class="small"
      title={PICK_ENTER_TIP}
      onClick={() => {
        const from = pickFrom(otherLibs(o, src, ctx), src, ctx);
        startPicking({ p: 'list', kind: o.kind, ...(o.dim ? { dim: o.dim } : {}) }, from ?? undefined);
      }}
    >
      <Plus /> {PICK_ENTER}
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
  const v = shownPick(src, ctx);
  const search = useRef<HTMLInputElement>(null);
  // 进库的列表时光标在搜索框（第六十七轮）
  useEffect(() => {
    if (v) search.current?.focus({ preventScroll: true });
  }, [!!v]);
  // 第九十轮：要先选放进哪里的（从“全部文化”新建：选文化组）先在列表上面列出来选
  const [choosing, setChoosing] = useState<NewChoice | null>(null);
  if (!p) return null;
  const create = async (kindId: string, defaults: Record<string, unknown>) => {
    const kind = kindOf(kindId);
    if (!kind) return;
    const choice = newChoiceOf(kindId, defaults, src, ctx);
    if (choice) {
      setChoosing(choosing ? null : choice);
      return;
    }
    setChoosing(null);
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
      {choosing && (
        <section class="box lp-new-in">
          <b class="small">{choosing.title}</b>
          {choosing.options.length === 0 && <p class="hint">{choosing.empty}</p>}
          <div class="list">
            {choosing.options.map((o) => (
              <button class="item" key={o.id} onClick={() => void create(p.kind.id, { ...p.defaults, [choosing.field]: o.id })}>
                <span class="grow ellipsis">{o.name}</span>
              </button>
            ))}
          </div>
          {src.t === 'world' && choosing.options.length > 0 && <p class="hint">{NEW_IN_WORLD_NOTE}</p>}
        </section>
      )}
      {faint > 0 && (
        <button class="lp-clean" title={TIDY_TIP} onClick={() => void tidyWorld()}>
          <Eraser />
          <span class="grow">{TIDY}</span>
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
