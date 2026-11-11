import { Anchor, BookOpen, Castle, Church, Crown, Droplets, Ellipsis, Eraser, Gem, Globe, Grid3x3, Handshake, LandPlot, Landmark, Languages, Layers, MapPin, Mountain, Palette, Scale, Shapes, SlidersHorizontal, Sprout, Trees, Users, UsersRound, Variable, Waves } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Arrange } from '../../../core/content/arrange';
import { cleanableSet } from '../../../core/content/cleanable';
import { wizardOpen } from '../../state';
import type { Icon } from '../defs/types';
import { type ArrangeAction, arrangeFor, arrangeTitle, canArrange, cardActions, cardChild, dropVerdict, verdictArrange } from './page-arrange';
import { applyArrange } from './page-actions';
import { type Judged, dragView, startDrag } from './page-drag';
import { type Card, type PageCtx, type SourceRef, ecologyHub, homePage } from './pages';
import { Row } from './PageList';
import { searchSource } from './page-search';
import { openRoute } from './panel-store';
import { type PickView, cardPicks, shownPick } from './pick-view';
import { tidyWorld } from './tidy';
import { mergeIntoMine } from './save-mine-run';
import { GEN_CARD_NOTE, GEN_TITLE, MERGE_TO_MINE, MERGE_TO_MINE_TIP, SEARCH_LIB, SEARCH_TIP, SEARCH_WORLD, TIDY, TIDY_TIP } from './copy';
import { genPage, genSummary } from './gen-settings';

// 首页与“生态与水系”这一层（第五十九轮）：几段，每种内容一张带个数的卡片（数据见 pages.ts 的 homePage）。
// 第六十轮：我的库里能把一张卡拖到另一张上（融入），上级写的“含 X”能拖出来（拆出来）；卡片的“⋯”做同样的事，没有鼠标时用。
// 第六十七轮：库的首页顶上搜整个库；能勾时卡片上写这种勾了几项（“已勾 3”）

const ICONS: Record<string, Icon> = {
  cultureGroup: UsersRound,
  culture: Users,
  nameStyle: Languages,
  valueGroup: Shapes,
  dim: Church,
  variables: Variable,
  government: Crown,
  faction: Scale,
  countryTier: Layers,
  countryPattern: Handshake,
  cityRank: Castle,
  landmarkType: Landmark,
  pointType: MapPin,
  ecology: Droplets,
  islandType: Anchor,
  planetForm: Globe,
  terrainClass: Mountain,
  resource: Gem,
  mapStyle: Palette,
  provinceRules: LandPlot,
  biome: Trees,
  riverType: Waves,
  lakeType: Droplets,
  table: Grid3x3,
};

// 我的库里卡片能做的事。别的来源（内置的只读、世界用的是库的安排）是 null
interface Arranging {
  src: SourceRef;
  ctx: PageCtx;
  arrange: Arrange;
}

function run(a: Arranging, next: Arrange, label: string) {
  applyArrange(a.src, next, label, a.ctx);
}

// 拖 child（self：拖的是这张卡片；from：从这张卡片的“含”里拖出来的）：松手落在哪张卡片上
function judgeDrop(a: Arranging, child: string, self: string | null, from: string | null) {
  return (el: Element | null): Judged => {
    const hit = el?.closest('[data-card]')?.getAttribute('data-card') ?? null;
    // 还在它自己的上级上：什么都不做
    const v = dropVerdict(child, hit, a.arrange, self ?? from);
    const next = verdictArrange(v, a.arrange);
    return {
      over: hit,
      ok: !!next,
      text: v.text,
      refuse: v.t === 'no',
      ...(next ? { act: () => run(a, next, v.t === 'merge' ? `${arrangeTitle(child)}融入${arrangeTitle(v.parent!)}` : `拆出${arrangeTitle(child)}`) } : {}),
    };
  };
}

function CardMenu({ actions, a }: { actions: ArrangeAction[]; a: Arranging }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!at) return;
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setAt(null);
    };
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [at]);
  return (
    <span class="lp-card-more" ref={box} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <button
        class={`icon-btn ${at ? 'open' : ''}`}
        title="融入、拆出来"
        aria-label="融入、拆出来"
        onClick={(e) => {
          if (at) return setAt(null);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
        }}
      >
        <Ellipsis />
      </button>
      {/* 面板是可以滚的，菜单不能被它裁掉 */}
      {at && (
        <div class="lp-source-menu lp-card-menu" style={{ top: at.top, right: at.right }}>
          {actions.map((x) => (
            <button
              class="item"
              onClick={() => {
                setAt(null);
                run(a, x.next, x.label);
              }}
            >
              <span class="grow">{x.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// 卡片上“含 X、Y”：我的库里每一种能单独拖出来
function Contains({ c, a, cardId }: { c: Pick<Card, 'contains' | 'kids'>; a: Arranging | null; cardId: string }) {
  if (!c.contains) return null;
  if (!a || !c.kids) return <span class="hint lp-contains">{c.contains}</span>;
  return (
    <span class="hint lp-contains">
      含
      {c.kids.map((k) => (
        <span key={k.key} class="lp-chip" title={`拖出来，${k.title}单独成卡`} onPointerDown={(e) => {
          e.stopPropagation();
          startDrag(e, { source: `kid:${k.key}`, label: k.title, judge: judgeDrop(a, k.key, null, cardId) });
        }}>
          {k.title}
        </span>
      ))}
    </span>
  );
}

// 卡片上“已勾 3”
function Picked({ n }: { n: number }) {
  return n > 0 ? <span class="lp-picked">已勾 {n}</span> : null;
}

function CardButton({ c, a, v }: { c: Card; a: Arranging | null; v?: PickView | null }) {
  const I = (c.icon && ICONS[c.icon]) || Sprout;
  const d = dragView.value;
  const actions = a ? cardActions(c.id, a.arrange, c.kids) : [];
  const state = d ? (d.source === c.id ? 'lifted' : d.over === c.id ? (d.ok ? 'drop-ok' : d.refuse ? 'drop-no' : '') : '') : '';
  return (
    <div
      class={`lp-card ${c.empty ? 'empty' : ''} ${a ? 'movable' : ''} ${(c.kids?.length ?? 0) > 1 ? 'wide' : ''} ${state}`}
      role="button"
      tabIndex={0}
      data-card={c.id}
      onClick={() => openRoute(c.route)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && openRoute(c.route)}
      onPointerDown={a ? (e) => startDrag(e, { source: c.id, label: c.title, judge: judgeDrop(a, cardChild(c.id), c.id, null) }) : undefined}
    >
      <span class="lp-card-icon">
        <I />
      </span>
      <span class="lp-card-text">
        <span class="lp-card-title ellipsis">{c.title}</span>
        <Contains c={c} a={a} cardId={c.id} />
      </span>
      <Picked n={cardPicks(c, v ?? null)} />
      <span class="lp-count">{c.count}</span>
      {a && actions.length > 0 && <CardMenu actions={actions} a={a} />}
    </div>
  );
}

function EraCard({ era, a, v }: { era: NonNullable<ReturnType<typeof homePage>['era']>; a: Arranging | null; v: PickView | null }) {
  const d = dragView.value;
  const actions = a ? cardActions('era', a.arrange, era.kids) : [];
  const state = d && d.over === 'era' ? (d.ok ? 'drop-ok' : d.refuse ? 'drop-no' : '') : '';
  return (
    <div class={`lp-era ${era.empty ? 'empty' : ''} ${state}`} role="button" tabIndex={0} data-card="era" onClick={() => openRoute(era.route)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && openRoute(era.route)}>
      <span class="lp-card-icon">
        <BookOpen />
      </span>
      <span class="lp-card-text">
        <span class="lp-card-title">
          {era.title}
          {era.contains && ' · '}
          {era.contains && <Contains c={era} a={a} cardId="era" />}
        </span>
        <span class="hint ellipsis">{era.summary}</span>
      </span>
      <Picked n={cardPicks({ id: 'era', kids: era.kids }, v)} />
      {a && actions.length > 0 && <CardMenu actions={actions} a={a} />}
    </div>
  );
}

// 搜整个库：每种一段，行和列表上的一样（能勾、点了在右栏打开）
function SearchHits({ src, ctx, q, v }: { src: SourceRef; ctx: PageCtx; q: string; v: PickView | null }) {
  const hits = useMemo(() => searchSource(src, ctx, q), [src.t, src.t === 'lib' ? src.key : '', ctx.lib, ctx.world, q]);
  if (!hits.length) return <p class="hint lp-note">没有找到</p>;
  return (
    <>
      {hits.map((s) => (
        <section class="lp-section" key={s.label}>
          <h5>{s.label}</h5>
          <div class="lp-rows">
            {s.rows.map((r) => (
              <Row key={r.key} r={r} src={src} ctx={ctx} v={v} movable={false} />
            ))}
          </div>
          {s.more > 0 && <p class="hint lp-note">还有 {s.more} 个，多写几个字</p>}
        </section>
      ))}
    </>
  );
}

// 本世界的首页最上面（第八十一轮）：生成设置，最常调的几项在一页上
function GenCard({ ctx }: { ctx: PageCtx }) {
  const g = useMemo(() => genPage(ctx), [ctx.world]);
  if (!g || (!g.era && !g.provinces)) return null;
  const go = () => openRoute({ p: 'gen' });
  return (
    <div class="lp-era lp-gen-card" role="button" tabIndex={0} onClick={go} onKeyDown={(e) => e.key === 'Enter' && go()}>
      <span class="lp-card-icon">
        <SlidersHorizontal />
      </span>
      <span class="lp-card-text">
        <span class="lp-card-title">{GEN_TITLE}</span>
        <span class="hint ellipsis">{genSummary(g) || GEN_CARD_NOTE}</span>
      </span>
    </div>
  );
}

export function PageHome({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const [q, setQ] = useState('');
  const arrange = arrangeFor(src, ctx);
  const p = homePage(src, ctx, arrange);
  const v = shownPick(src, ctx);
  if (p.noWorld) {
    return (
      <div class="lp-empty">
        <p class="hint">没有世界</p>
        <button class="small" onClick={() => (wizardOpen.value = true)}>
          新建世界…
        </button>
      </div>
    );
  }
  const a: Arranging | null = canArrange(src, ctx) ? { src, ctx, arrange } : null;
  const clean = src.t === 'world' && ctx.world ? cleanableSet(ctx.world).size : 0;
  // 第九十二轮：这张地图的首页也能搜（以前只有库的首页有）
  const search = (
    <div class="lp-tools lp-home-search">
      <input class="grow" type="search" placeholder={src.t === 'world' ? SEARCH_WORLD : SEARCH_LIB} title={SEARCH_TIP} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
    </div>
  );
  if (q.trim()) {
    return (
      <>
        {search}
        <SearchHits src={src} ctx={ctx} q={q} v={v} />
      </>
    );
  }
  return (
    <>
      {search}
      {src.t === 'world' && <GenCard ctx={ctx} />}
      {p.era && <EraCard era={p.era} a={a} v={v} />}
      {p.note && (
        <div class="lp-merge">
          <span class="hint grow">{p.note}</span>
          {p.mergeKey && (
            <button class="small primary" title={MERGE_TO_MINE_TIP} onClick={() => void mergeIntoMine(p.mergeKey!, ctx)}>
              {MERGE_TO_MINE}
            </button>
          )}
        </div>
      )}
      {clean > 0 && (
        <button class="lp-clean" title={TIDY_TIP} onClick={() => void tidyWorld()}>
          <Eraser />
          <span class="grow">{TIDY}</span>
          <span class="lp-count">{clean}</span>
        </button>
      )}
      {p.sections.map((s) => (
        <section class="lp-section" key={s.id}>
          <h5>{s.title}</h5>
          <div class="lp-cards">
            {s.cards.map((c) => (
              <CardButton key={c.id} c={c} a={a} v={v} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function EcologyHubPage({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const hub = ecologyHub(src, ctx);
  const v = shownPick(src, ctx);
  return (
    <>
      <div class="lp-cards">
        {hub.cards.map((c) => (
          <CardButton key={c.id} c={c} a={null} v={v} />
        ))}
      </div>
      <p class="hint lp-note">总表上打勾，和生态页、河湖页改的是同一份</p>
    </>
  );
}
