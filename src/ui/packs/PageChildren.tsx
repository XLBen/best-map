import { ChevronRight, GripVertical, Plus } from 'lucide-preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { splitOut } from '../../../core/content/arrange';
import { itemId, itemName, kindOf } from '../../../core/content/registry';
import { type Era } from '../../../core/human';
import { addDimensionCommand, dimensionOptions } from '../../../core/packs/add-dimension';
import { ADD_DIMENSION_NOTE } from '../copy';
import { libRoots } from '../packChoice';
import { showToast } from '../../state';
import { arrangeFor } from './page-arrange';
import { applyArrange, linkChild, newChildIn, unlinkChild } from './page-actions';
import { type OtherOpen, hasOther, sameOther } from './other-view';
import { kindPickable, lookOf, pickView } from './pick-view';
import { PickBox } from './PickBox';
import { CHILD_SEARCH_FROM, CHILD_SHOW, type ChildRow, type ChildSection, type InsideRow, shownRows } from './page-children';
import { dragOutOf } from './page-drag';
import { PageItem } from './PageItem';
import { type PageCtx, type SourceRef, eraVariables, itemsOf } from './pages';
import { flashClass, goTo, libPanel, openRoute, openSegments, rememberSegments, toggleOther } from './panel-store';
import { RefPicker } from './RefPicker';
import { runTrusted, swatchOf } from './row-actions';

// 上级页面上“下面的”几段（第六十轮）：一行一项，点一下在这里展开改，› 单独打开（返回回到这一页）；能加、能移出。
// 我的库里抓住这一段的标题拖到外面（或点“拆出来”），这种内容回到首页单独成卡。内置的库、本世界不能换安排，内容还是能看、能改（本世界）

type Obj = Record<string, unknown>;

function ChildLine({ s, r, parent, src, ctx, open, onOpen }: { s: ChildSection; r: ChildRow; parent: Obj; src: SourceRef; ctx: PageCtx; open: boolean; onOpen: () => void }) {
  const [moving, setMoving] = useState(false);
  // 能勾的库里子项也有勾（第六十七轮）：勾上级时默认一起勾，可以单独去掉
  const v = pickView(src, ctx);
  const pick = v && kindPickable(v, s.kind.id) ? v : null;
  const ref = { kind: s.kind.id, id: r.id };
  const note = pick ? lookOf(pick, ref).note : null;
  const swatch = swatchOf({ kind: s.kind, item: r.item });
  const canOut = !s.readonly;
  const up = kindOf(s.relation.parent);
  const moveOptions = useMemo(() => {
    if (!moving || !up) return [];
    return (itemsOf(src, up, ctx) as readonly Obj[]).filter((g) => g.id !== parent.id).map((g) => ({ id: String(g.id), label: String(g.name ?? g.id), ...(typeof g.color === 'string' ? { color: g.color } : {}) }));
  }, [moving, up, src, ctx.lib, ctx.world]);
  return (
    <>
      <div
        class={`lp-row lp-child-row ${open ? 'open' : ''} ${r.mark?.faint ? 'faint' : ''} ${flashClass(s.kind.id, r.id)}`}
        title={r.mark?.faint ? '生成后没用到，清理时会清掉' : undefined}
        data-pick-row={v ? '' : undefined}
        tabIndex={v ? -1 : undefined}
      >
        {pick ? <PickBox v={pick} r={ref} ctx={ctx} /> : v && <span class="lp-pick" />}
        <button class="lp-row-main" onClick={onOpen} title="在这里改">
          {swatch ? <span class="swatch" style={{ background: swatch }} /> : null}
          <span class="lp-row-name ellipsis">{r.name}</span>
          {r.hint && <span class="hint ellipsis lp-row-hint">{r.hint}</span>}
          {r.mark?.changed && (
            <span class="lp-diff" title="和来源的库不同">
              和库不同
            </span>
          )}
        </button>
        {note && (
          <span class="hint ellipsis lp-row-why" title={note}>
            {note}
          </span>
        )}
        {canOut && r.out === 'ok' && (
          <button class="small" title={r.why} onClick={() => void unlinkChild(src, s.relation, parent, r.item, ctx)}>
            移出
          </button>
        )}
        {canOut && r.out === 'move' && (
          <button class={`small ${moving ? 'open' : ''}`} title={r.why} onClick={() => setMoving(!moving)}>
            移到
          </button>
        )}
        <button class="icon-btn lp-row-go" title="单独打开" onClick={() => openRoute({ p: 'item', kind: s.kind.id, id: r.id })}>
          <ChevronRight />
        </button>
      </div>
      {moving && (
        <div class="lp-child-move">
          <RefPicker
            options={moveOptions}
            placeholder="选一组"
            onPick={(id) => {
              const g = up && (itemsOf(src, up, ctx) as readonly Obj[]).find((x) => x.id === id);
              setMoving(false);
              if (g) void linkChild(src, s.relation, g, r.item, ctx);
            }}
          />
        </div>
      )}
      {open && (
        <div class="lp-child-edit">
          <PageItem key={r.key} route={{ p: 'item', kind: s.kind.id, id: r.id }} src={src} ctx={ctx} embedded />
        </div>
      )}
    </>
  );
}

function ChildSeg({ s, parent, src, ctx, shut, onToggle }: { s: ChildSection; parent: Obj; src: SourceRef; ctx: PageCtx; shut: boolean; onToggle: () => void }) {
  const zone = useRef<HTMLElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(CHILD_SHOW);
  const shown = useMemo(() => shownRows(s.rows, q, limit), [s.rows, q, limit]);
  const split = () => {
    applyArrange(src, splitOut(arrangeFor(src, ctx), s.key), `拆出${s.title}`, ctx);
  };
  const brief = s.rows.slice(0, 3).map((r) => r.name).join('、');
  // 别的库里有这一种：“从别的库加”在右栏打开，勾的都放到这个上级下面（第六十八轮）
  const other = useMemo((): OtherOpen | null => {
    const up = kindOf(s.relation.parent);
    if (shut || !s.canLink || !up) return null;
    const o: OtherOpen = { kind: s.kind.id, label: s.title, onto: { relation: s.relation, parent: itemId(up, parent), title: itemName(up, parent) } };
    return hasOther(o, src, ctx) ? o : null;
  }, [shut, s.canLink, s.kind.id, s.relation, src.t === 'lib' ? src.key : '', ctx.lib, parent]);
  const otherOn = !!other && sameOther(libPanel.value?.other, other);
  return (
    <section class={`lp-seg lp-child ${shut ? '' : 'open'}`} ref={zone}>
      <div
        class={`lp-seg-head ${s.canSplit ? 'movable' : ''}`}
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onToggle()}
        onPointerDown={s.canSplit ? (e) => zone.current && dragOutOf(e, zone.current, { source: `kid:${s.key}`, label: s.title, text: `拆出${s.title}，单独成卡`, act: split }) : undefined}
      >
        <ChevronRight class="lp-seg-twist" />
        <b>{s.title}</b>
        <span class="lp-count">{s.rows.length}</span>
        {shut && brief ? <span class="lp-seg-brief ellipsis">{brief}</span> : <span class="grow" />}
        {s.canSplit && (
          <>
            <button
              class="small"
              title={`${s.title}单独成卡`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                split();
              }}
            >
              拆出来
            </button>
            <span class="lp-grip" title="拖到外面，单独成卡">
              <GripVertical />
            </span>
          </>
        )}
      </div>
      {!shut && (
        <div class="lp-seg-body">
          {!s.rows.length && <p class="hint">没有{s.title}</p>}
          {s.rows.length > CHILD_SEARCH_FROM && (
            <div class="lp-tools">
              <input class="grow" type="search" placeholder={`搜索${s.title}`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </div>
          )}
          <div class="lp-rows">
            {shown.rows.map((r) => (
              <ChildLine key={r.key} s={s} r={r} parent={parent} src={src} ctx={ctx} open={openId === r.id} onOpen={() => setOpenId(openId === r.id ? null : r.id)} />
            ))}
          </div>
          {shown.more > 0 && (
            <button class="small lp-child-more" onClick={() => setLimit(limit + CHILD_SHOW * 4)}>
              还有 {shown.more} 个
            </button>
          )}
          {s.note && <p class="hint">{s.note}</p>}
          {(s.canLink || s.canNew) && (
            <div class="row lp-child-foot">
              {s.canLink && s.options.length > 0 && (
                <RefPicker add options={s.options} onPick={(id) => {
                  const x = (itemsOf(src, s.kind, ctx) as readonly Obj[]).find((c) => c.id === id);
                  if (x) void linkChild(src, s.relation, parent, x, ctx);
                  else showToast('这一份里没有它', true);
                }}>
                  {s.addLabel}
                </RefPicker>
              )}
              {other && (
                <button class={`small ${otherOn ? 'open' : ''}`} aria-pressed={otherOn} title={otherOn ? '收起' : `从别的库挑几项${s.title}，放到这里`} onClick={() => toggleOther(other)}>
                  <Plus /> 从别的库加
                </button>
              )}
              {s.canNew && (
                <button
                  class="small"
                  onClick={() =>
                    void Promise.resolve(newChildIn(src, s.relation, parent, ctx)).then((id) => {
                      if (id) setOpenId(id);
                    })
                  }
                >
                  <Plus /> 新建
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// 一项的页面上融入到它下面的几段。展开、收起按种类记着（这次打开页面期间）
export function ChildSegments({ list, parent, parentKind, src, ctx }: { list: readonly ChildSection[]; parent: Obj; parentKind: string; src: SourceRef; ctx: PageCtx }) {
  const memoKey = `${parentKind}:children`;
  const [shut, setShut] = useState<ReadonlySet<string>>(() => openSegments(memoKey) ?? new Set());
  if (!list.length) return null;
  const toggle = (key: string) => {
    const next = new Set(shut);
    if (!next.delete(key)) next.add(key);
    setShut(next);
    rememberSegments(memoKey, next);
  };
  return (
    <div class="lp-fields lp-children">
      {list.map((s) => (
        <ChildSeg key={s.key} s={s} parent={parent} src={src} ctx={ctx} shut={shut.has(s.key)} onToggle={() => toggle(s.key)} />
      ))}
    </div>
  );
}

// 上级的列表最上面：含哪几种。点进去是这种内容的全部；我的库里拖到外面或点“拆出来”
export function InsideRows({ list, src, ctx }: { list: readonly InsideRow[]; src: SourceRef; ctx: PageCtx }) {
  const zone = useRef<HTMLDivElement>(null);
  if (!list.length) return null;
  const split = (r: InsideRow) => applyArrange(src, splitOut(arrangeFor(src, ctx), r.key), `拆出${r.title}`, ctx);
  return (
    <div class="lp-inside" ref={zone}>
      {list.map((r) => (
        <div
          class={`lp-row ${r.canSplit ? 'movable' : ''}`}
          key={r.key}
          onPointerDown={r.canSplit ? (e) => zone.current && dragOutOf(e, zone.current, { source: `kid:${r.key}`, label: r.title, text: `拆出${r.title}，单独成卡`, act: () => split(r) }) : undefined}
        >
          {r.canSplit && (
            <span class="lp-grip" title="拖到外面，单独成卡">
              <GripVertical />
            </span>
          )}
          <button class="lp-row-main" onClick={() => goTo(r.route)}>
            <span class="lp-row-name ellipsis">全部{r.title}</span>
            <span class="grow" />
            <span class="lp-count">{r.count}</span>
          </button>
          {r.canSplit && (
            <button class="small" title={`${r.title}单独成卡`} onPointerDown={(e) => e.stopPropagation()} onClick={() => split(r)}>
              拆出来
            </button>
          )}
          <ChevronRight class="lp-chevron" />
        </div>
      ))}
    </div>
  );
}

// 时代规则的“变量”一段，在世界里：只列，加变量走 add_dimension（只算新变量，文化、国家都不变）。
// 直接改这张表不会分人口，世界会对不上，所以世界里不给改；库里还是字段表
export function WorldVariables({ era, ctx }: { era: Era; ctx: PageCtx }) {
  const w = ctx.world;
  const lib = ctx.lib;
  const options = useMemo(() => (w ? dimensionOptions(libRoots(lib), w.small) : []), [lib, w?.small.content?.era, w?.small.human?.era]);
  const rows = eraVariables({ t: 'world' }, era, ctx);
  return (
    <>
      <div class="lp-rows">
        {rows.map((d) => (
          <div class="lp-row" key={d.id}>
            <button class="lp-row-main" onClick={() => goTo(d.route)}>
              <span class="lp-row-name ellipsis">{d.label}</span>
              <span class="grow" />
              <span class="lp-count">{d.count}</span>
            </button>
            <ChevronRight class="lp-chevron" />
          </div>
        ))}
      </div>
      {w && options.length > 0 && (
        <div class="row lp-child-foot">
          <RefPicker
            add
            options={options.map((o) => ({ id: o.id, label: o.label, hint: `${o.values.length} 种` }))}
            onPick={(id) => {
              const o = options.find((x) => x.id === id);
              const cmd = o ? addDimensionCommand(libRoots(lib), w, o.id, o.library) : null;
              if (cmd) void runTrusted(cmd, '正在计算…');
            }}
          >
            加变量
          </RefPicker>
        </div>
      )}
      <p class="hint">{ADD_DIMENSION_NOTE}</p>
    </>
  );
}
