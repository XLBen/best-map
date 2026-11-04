import { Anchor, BookOpen, Castle, Church, Crown, Droplets, Gem, Globe, Grid3x3, Landmark, Languages, Layers, MapPin, Mountain, Palette, Scale, Shapes, Sprout, Trees, Users, UsersRound, Variable, Waves } from 'lucide-preact';
import { wizardOpen } from '../../state';
import type { Icon } from '../defs/types';
import { type Card, type PageCtx, type SourceRef, homePage, waterHub } from './pages';
import { goTo } from './panel-store';

// 首页与“生态与水系”这一层（第五十九轮）：几段，每种内容一张带个数的卡片（数据见 pages.ts 的 homePage）

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
  countryLayout: Grid3x3,
  cityRank: Castle,
  landmarkType: Landmark,
  pointType: MapPin,
  water: Droplets,
  islandType: Anchor,
  planetForm: Globe,
  terrainClass: Mountain,
  resource: Gem,
  mapStyle: Palette,
  biome: Trees,
  riverType: Waves,
  lakeType: Droplets,
  table: Grid3x3,
};

function CardButton({ c }: { c: Card }) {
  const I = (c.icon && ICONS[c.icon]) || Sprout;
  return (
    <button class={`lp-card ${c.empty ? 'empty' : ''}`} onClick={() => goTo(c.route)}>
      <span class="lp-card-icon">
        <I />
      </span>
      <span class="lp-card-text">
        <span class="lp-card-title ellipsis">{c.title}</span>
        {c.contains && <span class="hint ellipsis">{c.contains}</span>}
      </span>
      <span class="lp-count">{c.count}</span>
    </button>
  );
}

export function PageHome({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const p = homePage(src, ctx);
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
  return (
    <>
      {p.era && (
        <button class={`lp-era ${p.era.empty ? 'empty' : ''}`} onClick={() => goTo(p.era!.route)}>
          <span class="lp-card-icon">
            <BookOpen />
          </span>
          <span class="lp-card-text">
            <span class="lp-card-title">{p.era.title}</span>
            <span class="hint ellipsis">{p.era.summary}</span>
          </span>
        </button>
      )}
      {p.note && <p class="hint">{p.note}</p>}
      {p.sections.map((s) => (
        <section class="lp-section" key={s.id}>
          <h5>{s.title}</h5>
          <div class="lp-cards">
            {s.cards.map((c) => (
              <CardButton key={c.id} c={c} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function WaterHubPage({ src, ctx }: { src: SourceRef; ctx: PageCtx }) {
  const hub = waterHub(src, ctx);
  return (
    <>
      <div class="lp-cards">
        {hub.cards.map((c) => (
          <CardButton key={c.id} c={c} />
        ))}
      </div>
      <p class="hint lp-note">总表上打勾，和生态页、河湖页改的是同一份</p>
    </>
  );
}
