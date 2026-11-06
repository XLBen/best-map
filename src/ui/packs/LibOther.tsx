import { ChevronLeft, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type BasketFor, LibBasket, addNow } from './LibBasket';
import { type OtherOpen, type OtherRow, ontoOf, otherDetail, otherLibs, otherSections, pickFrom } from './other-view';
import type { PageCtx, SourceRef } from './pages';
import { closeOther } from './panel-store';
import { PickBox } from './PickBox';
import { rememberFrom } from './pick-other';
import { pickStore } from './pick-store';
import { type PickView, pickView } from './pick-view';

// “从别的库加”的右栏（第六十八轮）：列表、上级页面上的按钮打开。顶上标题和 ×；“来自”选别的库（写可加几项、已勾几项）；
// 搜索；那个库里这一种的项，按它自己的分段，每行一个勾（PickBox），灰的写原因，点名字展开说明和会一起加的；底下清单（LibBasket，加到哪里写死）。
// 逻辑在 other-view.ts；窄窗口里盖在左栏上，左上角返回

function Detail({ v, row }: { v: PickView; row: OtherRow }) {
  const d = useMemo(() => otherDetail(v, row), [v.ask.source, v.ask.target, row.ref.kind, row.ref.id]);
  return (
    <div class="lo-detail">
      {d.text && <p>{d.text}</p>}
      {d.along.length > 0 ? (
        <p class="hint">
          一起加：{d.along.slice(0, 6).join('、')}
          {d.along.length > 6 ? ` 等 ${d.along.length} 项` : ''}
        </p>
      ) : (
        !d.text && <p class="hint">{row.look?.mark === 'grey' ? row.look.note : '只加它自己'}</p>
      )}
    </div>
  );
}

function Line({ row, v, ctx, open, onOpen }: { row: OtherRow; v: PickView | null; ctx: PageCtx; open: boolean; onOpen: () => void }) {
  const note = row.look?.note;
  return (
    <>
      <div class={`lp-row lo-row ${row.look?.mark === 'grey' && !row.look.picked ? 'lo-grey' : ''}`} data-pick-row="" tabIndex={-1}>
        {v && row.look ? <PickBox v={v} r={row.ref} ctx={ctx} look={row.look} /> : <span class="lp-pick" />}
        <button class="lp-row-main" aria-expanded={open} title={open ? '收起' : '看说明、会一起加什么'} onClick={onOpen}>
          {row.color ? <span class="swatch" style={{ background: row.color }} /> : null}
          <span class="lo-text">
            <span class="lp-row-name ellipsis">{row.name}</span>
            {note && (
              <span class="hint ellipsis lo-note" title={note}>
                {note}
              </span>
            )}
          </span>
          {row.hint && <span class="hint ellipsis lp-row-hint">{row.hint}</span>}
        </button>
      </div>
      {open && v && <Detail v={v} row={row} />}
    </>
  );
}

export function LibOther({ src, o, ctx, over }: { src: SourceRef; o: OtherOpen; ctx: PageCtx; over: boolean }) {
  // 勾了、加了以后数要跟着变
  const store = pickStore.value;
  const libs = useMemo(() => otherLibs(o, src, ctx), [o.kind, o.dim, src.t === 'lib' ? src.key : '', ctx.lib, ctx.world, store]);
  const [chosen, setChosen] = useState<string | null>(null);
  const from = chosen && libs.some((l) => l.key === chosen) ? chosen : pickFrom(libs, src, ctx);
  const [q, setQ] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const sections = useMemo(() => (from ? otherSections(from, o, src, ctx, q) : []), [from, o, src.t === 'lib' ? src.key : '', ctx.lib, ctx.world, q, store]);
  const v = from ? pickView({ t: 'lib', key: from }, ctx) : null;
  const to = src.t === 'world' ? '本世界' : (ctx.lib.find((e) => e.key === src.key)?.pack.name ?? '这个库');
  const basketFor: BasketFor = useMemo(() => {
    const onto = v ? ontoOf(v, o, src, ctx) : undefined;
    return { to: o.onto ? `${to}的“${o.onto.title}”下面` : to, ...(onto ? { onto } : {}) };
  }, [v, o, to]);
  // 打开、换了一种时光标在搜索框
  useEffect(() => {
    setQ('');
    setOpenKey(null);
    search.current?.focus({ preventScroll: true });
  }, [o.kind, o.dim, o.onto?.parent]);
  const head = `从别的库加 · ${o.label}`;
  return (
    <aside
      class="lp-side lo-pane"
      onKeyDown={(e) => {
        // ⌘回车：添加这个库勾的（放到上级下面的照样放）
        if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        if (v?.preview.count) void addNow(v, ctx, false, basketFor);
      }}
    >
      {over && (
        <div class="lp-nav">
          <button class="lp-back" onClick={closeOther} title="返回（Esc）">
            <ChevronLeft />
            <span class="ellipsis">返回</span>
          </button>
        </div>
      )}
      <div class="lo-head">
        <b class="ellipsis" title={o.onto ? `${head}，加到“${o.onto.title}”下面` : head}>
          {head}
          {o.onto && <span class="hint"> → 加到“{o.onto.title}”下面</span>}
        </b>
        {!over && (
          <button class="icon-btn" onClick={closeOther} title="收起（Esc）">
            <X />
          </button>
        )}
      </div>
      {libs.length > 0 && (
        <label class="lo-from">
          <span class="hint">来自</span>
          <select
            value={from ?? ''}
            onChange={(e) => {
              const key = (e.target as HTMLSelectElement).value;
              setChosen(key);
              setOpenKey(null);
              if (!ctx.lib.find((x) => x.key === key)?.file) rememberFrom(key);
            }}
          >
            {libs.map((l) => (
              <option value={l.key} key={l.key}>
                {`${l.name} · 可加 ${l.can}${l.picked ? ` · 已勾 ${l.picked}` : ''}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {libs.length > 0 && (
        <div class="lo-tools">
          <input ref={search} type="search" placeholder="搜索" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
      )}
      <div class="lo-list">
        {!libs.length && <p class="hint">别的库里没有{o.label}</p>}
        {libs.length > 0 && !sections.length && <p class="hint">{q ? '没有找到' : `这个库里没有${o.label}`}</p>}
        {!v && libs.length > 0 && <p class="hint">没有地方加：先打开一个世界，或者新建一个库</p>}
        {sections.map((s, k) => (
          <section class="lp-section" key={`${from}:${k}`}>
            {s.label && <h5>{s.label}</h5>}
            <div class="lp-rows">
              {s.rows.map((r) => (
                <Line key={r.key} row={r} v={v} ctx={ctx} open={openKey === r.key} onOpen={() => setOpenKey(openKey === r.key ? null : r.key)} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {v && <LibBasket v={v} ctx={ctx} other={basketFor} />}
    </aside>
  );
}
