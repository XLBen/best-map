import { FileText, Trash2 } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { CityInfo } from '../../../core/human';
import type { World } from '../../../core/world';
import { CITY_ICONS, type CityIcon, iconOf } from '../../render/settle-draw';
import { type SettleRef, askUser, exec, openPanel, options, selectedSettle, setOptions, sheet, togglePanel, world } from '../../state';
import { focusOn } from '../camera';
import { Seg } from '../common';
import { Toggle } from '../components/Toggle';
import { TypePicker, TypePickerButton } from '../components/TypePicker';
import { hasCountries } from '../countries';
import { popText } from '../human';
import { openNewItem, openRepoKind } from '../packs/RepoPanel';
import {
  CATEGORY_NAMES,
  SETTLE_KIND_NAMES,
  type SettleKind,
  canGenerateCities,
  cityIconOf,
  cityRankCommand,
  generateSettleCommand,
  hasAnySettle,
  landmarkChoices,
  liveLandmarkType,
  livePointType,
  pointChoices,
  rankChoices,
  regenerateSettleCommand,
  removeSettleCommand,
  roadKindCommand,
  settleCounts,
  settleLists,
} from '../settlements';
import { hasHuman } from '../tools/culture';
import { deleteSelected, selectSettle } from '../tools/settlements';

// “城市”一类（第二十四轮）：底部条上的选择（选中的城市的等级、道路的种类、放哪一种地标与点）、“城市 ⋯”（生成、重新生成、删除、城市列表）

// 城市的图标（列表、档案里的小图）：星、双圈、大圆、点
export function CityGlyph({ icon, hollow }: { icon: string; hollow?: boolean }) {
  const k: CityIcon = (CITY_ICONS as readonly string[]).includes(icon) ? (icon as CityIcon) : 'circle';
  const star = Array.from({ length: 10 }, (_, j) => {
    const a = -Math.PI / 2 + (j * Math.PI) / 5;
    const r = j % 2 ? 3.3 : 7;
    return `${(8 + Math.cos(a) * r).toFixed(2)},${(8 + Math.sin(a) * r).toFixed(2)}`;
  }).join(' ');
  return (
    <svg class={`city-glyph ${k}${hollow ? ' hollow' : ''}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {k === 'star' && <polygon points={star} />}
      {k === 'double-ring' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <circle class="core" cx="8" cy="8" r="2.4" />
        </>
      )}
      {k === 'circle' && <circle cx="8" cy="8" r="4.5" />}
      {k === 'dot' && <circle class="core" cx="8" cy="8" r="2.6" />}
    </svg>
  );
}

// 选中的一样（这个工具管的几种）：名字、档案、删除
function SelectedChip({ kinds }: { kinds: readonly SettleRef['kind'][] }) {
  const w = world.value;
  const r = selectedSettle.value;
  if (!w || !r || !kinds.includes(r.kind) || r.kind === 'road') return null;
  const lists = settleLists(w);
  const name =
    r.kind === 'city'
      ? lists.cities.find((c) => !c.point && c.id === r.id)?.name
      : r.kind === 'landmark'
        ? lists.landmarks.find((l) => l.id === r.id)?.name
        : lists.points.find((p) => p.id === r.id)?.name;
  if (!name) return null;
  return (
    <>
      <span class="bar-note">“{name}”</span>
      <button class={`bar-btn ${sheet.value === 'settle' ? 'open' : ''}`} onClick={() => (sheet.value = sheet.value === 'settle' ? null : 'settle')} title="名字、简介……">
        <FileText /> 档案
      </button>
      <button class="bar-btn icon" onClick={() => deleteSelected(kinds)} title="删除（Delete）">
        <Trash2 />
      </button>
    </>
  );
}

// 没有城市时底部条上的入口（打开“城市 ⋯”）
export function NoCityChip() {
  const w = world.value;
  if (!w || settleCounts(w).cities > 0 || !canGenerateCities(w)) return null;
  return (
    <button class="bar-btn warn" onClick={() => togglePanel('cat:settlements')} title="按国家的人口放城市">
      生成城市…
    </button>
  );
}

// ---------- 城市 ----------

// 选中的城市：等级（自动 / 每一级）
function selectedCity(w: World): CityInfo | undefined {
  const r = selectedSettle.value;
  if (!r || r.kind !== 'city') return undefined;
  return settleLists(w).cities.find((c) => !c.point && c.id === r.id);
}

export function CityBar() {
  const w = world.value;
  if (!w) return null;
  const c = selectedCity(w);
  if (!c) return <span class="bar-note">{selectedSettle.value?.kind === 'point' ? '' : '点空地新建城市'}</span>;
  return (
    <TypePickerButton panel="cityrank" prefix="等级" name={c.rank.name} auto={c.rankAuto} title="自动：按占本国人口的比例" />
  );
}
export function CityPointChip() {
  return <SelectedChip kinds={['city', 'point']} />;
}

export function RankMenu() {
  const w = world.value;
  if (!w) return null;
  const c = selectedCity(w);
  if (!c) return <p class="hint">没有选中城市</p>;
  const pick = (rank: string | null) => {
    openPanel.value = null;
    if (rank === null ? !c.rankAuto : rank !== c.rank.id || c.rankAuto) void exec(cityRankCommand(c.id, rank), '正在保存…');
  };
  return (
    <TypePicker
      items={[
        { label: `自动：${c.autoRank.name}`, on: c.rankAuto, hint: '按占本国人口的比例', onPick: () => pick(null) },
        ...rankChoices(w).map((r) => ({ label: r.name, on: !c.rankAuto && c.rank.id === r.id, hint: r.description, meta: r.capital ? '首都用' : undefined, onPick: () => pick(r.id) })),
      ]}
      onNew={() => {
        openPanel.value = null;
        openNewItem('cityRank');
      }}
      newLabel="新的等级…"
      newTitle="在资源库里新建一种城市等级"
      library="cityRank"
    />
  );
}

// ---------- 道路 ----------

const ROAD_KINDS: [string, string][] = [
  ['major', '大道'],
  ['minor', '小路'],
];

export function RoadBar() {
  const w = world.value;
  if (!w) return null;
  const r = selectedSettle.value;
  const road = r?.kind === 'road' ? w.small.roads?.[r.id] : undefined;
  if (!road)
    return (
      <>
        <span class="bar-label">新路</span>
        <Seg value={options.value.roadKind} options={ROAD_KINDS as [ 'major' | 'minor', string][]} onChange={(roadKind) => setOptions({ roadKind })} titles={{ major: '粗的实线，缩小时也画', minor: '细的虚线，放大后才画' }} />
      </>
    );
  return (
    <>
      <span class="bar-note">{road.name ? `“${road.name}”` : '选中的道路'}</span>
      <Seg value={road.kind === 'major' ? 'major' : 'minor'} options={ROAD_KINDS} onChange={(kind) => kind !== road.kind && void exec(roadKindCommand(road.id, kind), '正在保存…')} />
      <button class="bar-btn icon" onClick={() => deleteSelected(['road'])} title="删除（Delete）">
        <Trash2 />
      </button>
    </>
  );
}

// ---------- 地标 ----------

export function LandmarkPick() {
  const w = world.value;
  if (!w) return null;
  const t = liveLandmarkType(w, options.value.landmarkType);
  if (!t) return null;
  return <TypePickerButton panel="landmarkpick" prefix="地标" icon={iconOf(t.icon)} name={t.name} title="新放的地标是哪一种" />;
}
export function LandmarkChip() {
  return <SelectedChip kinds={['landmark']} />;
}

export function LandmarkMenu() {
  const w = world.value;
  if (!w) return null;
  const cur = liveLandmarkType(w, options.value.landmarkType);
  return (
    <TypePicker
      items={landmarkChoices(w).map((t) => ({
        label: t.name,
        icon: iconOf(t.icon),
        group: CATEGORY_NAMES[t.category],
        on: cur?.id === t.id,
        hint: t.description,
        onPick: () => {
          openPanel.value = null;
          setOptions({ landmarkType: t.id });
        },
      }))}
      onNew={() => {
        openPanel.value = null;
        openNewItem('landmarkType');
      }}
      newLabel="新类型…"
      newTitle="在资源库里新建一种地标类型"
      library="landmarkType"
    />
  );
}

// ---------- 自定义点 ----------

export function PointPick() {
  const w = world.value;
  if (!w) return null;
  const t = livePointType(w, options.value.pointType);
  if (!t) return null;
  return (
    <>
      <TypePickerButton panel="pointpick" prefix="点" icon={t.image ? undefined : iconOf(t.icon ?? 'pin')} swatch={t.color} name={t.name} title="新放的点是哪一种" />
      {t.actsAsCity && (
        <Toggle on={options.value.pointAttach} onChange={(pointAttach) => setOptions({ pointAttach })} title="开着时挂在附近的城市上；关着时这个点自己当一座城市">
          挂在城市上
        </Toggle>
      )}
    </>
  );
}
export function PointChip() {
  return <SelectedChip kinds={['point']} />;
}

export function PointMenu() {
  const w = world.value;
  if (!w) return null;
  const cur = livePointType(w, options.value.pointType);
  return (
    <TypePicker
      items={pointChoices(w).map((t) => ({
        label: t.name,
        swatch: t.color,
        ...(t.image ? { image: t.image } : { icon: iconOf(t.icon ?? 'pin') }),
        on: cur?.id === t.id,
        hint: t.description,
        meta: t.actsAsCity ? (t.actsAsCity.capital ? '算首都' : '当作城市') : undefined,
        onPick: () => {
          openPanel.value = null;
          setOptions({ pointType: t.id });
        },
      }))}
      onNew={() => {
        openPanel.value = null;
        openNewItem('pointType');
      }}
      newLabel="新类型…"
      newTitle="在资源库里新建一种点的类型，可以上传小图"
      library="pointType"
    />
  );
}

// ---------- 列表 ----------

export function CityRow({ c, onPick }: { c: CityInfo; onPick?: () => void }) {
  const w = world.value;
  const m = w && c.country !== null ? w.small.countries?.[c.country] : undefined;
  const sel = selectedSettle.value;
  const on = sel && sel.kind === (c.point ? 'point' : 'city') && sel.id === c.id;
  return (
    <button
      class={`item city-row ${on ? 'on' : ''}`}
      onClick={() => {
        selectSettle({ kind: c.point ? 'point' : 'city', id: c.id });
        focusOn([c.cell]);
        onPick?.();
      }}
      title={c.rank.name}
    >
      <CityGlyph icon={cityIconOf(c.rank)} hollow={c.secondCapital && !c.capital} />
      <span class="grow item-text">
        <span class="ellipsis">{c.name}</span>
        <span class="hint ellipsis">{[c.capital ? '首都' : c.secondCapital ? '陪都' : c.rank.name, m?.name].filter(Boolean).join(' · ')}</span>
      </span>
      <span class="hint">{c.population > 0 ? popText(c.population) : ''}</span>
    </button>
  );
}

// 城市列表（重要的在前，最多先列 limit 座）
export function CityList({ cities, limit = 40, onPick }: { cities: readonly CityInfo[]; limit?: number; onPick?: () => void }) {
  const [all, setAll] = useState(false);
  if (!cities.length) return <p class="hint">没有城市</p>;
  const shown = all ? cities : cities.slice(0, limit);
  return (
    <>
      <div class="list city-list">
        {shown.map((c) => (
          <CityRow c={c} onPick={onPick} />
        ))}
      </div>
      {cities.length > shown.length && (
        <button class="link-btn" onClick={() => setAll(true)}>
          全部 {cities.length} 座
        </button>
      )}
    </>
  );
}

// ---------- “城市 ⋯” ----------

function GenToggles({ roads, landmarks, onChange }: { roads: boolean; landmarks: boolean; onChange: (v: { roads: boolean; landmarks: boolean }) => void }) {
  return (
    <>
      <Toggle on={roads} onChange={(v) => onChange({ roads: v, landmarks })}>
        道路
      </Toggle>
      <Toggle on={landmarks} onChange={(v) => onChange({ roads, landmarks: v })}>
        地标
      </Toggle>
    </>
  );
}

function RemoveBox({ w }: { w: World }) {
  const counts = settleCounts(w);
  const kinds = (Object.keys(SETTLE_KIND_NAMES) as SettleKind[]).filter((k) => counts[k] > 0);
  const [pick, setPick] = useState<Set<SettleKind>>(new Set());
  if (!kinds.length) return null;
  const list = kinds.filter((k) => pick.has(k));
  return (
    <section>
      <h5>删除</h5>
      <div class="check-grid">
        {kinds.map((k) => (
          <label class="check">
            <input
              type="checkbox"
              checked={pick.has(k)}
              onChange={() => {
                const s = new Set(pick);
                if (s.has(k)) s.delete(k);
                else s.add(k);
                setPick(s);
              }}
            />
            {SETTLE_KIND_NAMES[k]} · {counts[k]}
          </label>
        ))}
      </div>
      {pick.has('cities') && counts.roads > 0 && !pick.has('roads') && <p class="hint">道路连着城市，一起删除</p>}
      <button
        disabled={!list.length}
        onClick={async () => {
          const names = [...new Set([...list, ...(pick.has('cities') && counts.roads ? (['roads'] as SettleKind[]) : [])])].map((k) => SETTLE_KIND_NAMES[k]);
          const v = await askUser({
            title: '删除',
            text: `${names.join('、')}都删除。可以撤销。`,
            choices: [
              { value: 'cancel', label: '取消' },
              { value: 'ok', label: '删除', primary: true },
            ],
          });
          const cmd = removeSettleCommand(list);
          if (v === 'ok' && cmd && (await exec(cmd, '正在计算…'))) {
            setPick(new Set());
            selectSettle(null);
          }
        }}
      >
        删除
      </button>
    </section>
  );
}

export function SettlementExtras() {
  const w = world.value;
  const [gen, setGen] = useState(() => ({ roads: w?.small.settlementRules?.roads ?? true, landmarks: w?.small.settlementRules?.landmarks ?? true }));
  if (!w) return null;
  const counts = settleCounts(w);
  // 已经有（生成过、或自己放过）时重新生成：锁定的、自己放的、画的留着
  const again = !!w.small.settlementRules || hasAnySettle(w);
  return (
    <>
      {hasAnySettle(w) && (
        <section>
          <h5>
            城市 {counts.cities} 座 · 道路 {counts.roads} 条 · 地标 {counts.landmarks} 个{counts.points ? ` · 点 ${counts.points} 个` : ''}
          </h5>
          <CityList cities={settleLists(w).cities} onPick={() => (openPanel.value = null)} />
        </section>
      )}
      {!again ? (
        <section>
          <h5>生成</h5>
          {!hasHuman(w) ? (
            <p class="hint">没有人文时只放自然的地标</p>
          ) : !hasCountries(w) ? (
            <p class="hint">城市按国家的人口放，没有国家时都算无主地</p>
          ) : null}
          <GenToggles roads={gen.roads} landmarks={gen.landmarks} onChange={setGen} />
          <button class="primary" onClick={() => void exec(generateSettleCommand(gen), '正在生成…')}>
            生成
          </button>
        </section>
      ) : (
        <section>
          <h5>重新生成</h5>
          <GenToggles roads={gen.roads} landmarks={gen.landmarks} onChange={setGen} />
          <button onClick={() => void exec(regenerateSettleCommand(w, gen), '正在生成…')} title="锁定的、自己放的、画的不动">
            重新生成
          </button>
        </section>
      )}
      <RemoveBox w={w} />
      <section class="row wrap">
        <button class="small" onClick={() => openRepoKind('cityRank')}>
          资源库…
        </button>
      </section>
    </>
  );
}
