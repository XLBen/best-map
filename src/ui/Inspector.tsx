import type { GeoFeature } from '../../core/features';
import { activeConflicts } from '../../core/constraints';
import { BUILTIN_FIELDS, speciesColor } from '../../core/species';
import { effectsAt } from '../../core/effects';
import { type CellExplanation, explainCell } from '../../core/vegetation';
import { type World, longitudeOf, worldLatitude } from '../../core/world';
import { exec, hoverCell, hoverProvinceCell, options, world } from '../state';
import { category } from './defs/tools';
import { outsideRangeReason, outsideRangeText } from './biomeRange';

// 检查器：用人话说清楚“这里是什么、为什么”，数字放在第二层

const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fieldLabel = new Map(BUILTIN_FIELDS.map((f) => [f.id, f.label]));

// 整个星球：“北纬 12.3° · 东经 45.6°”
function lonLatText(w: World, cell: number): string {
  const lat = worldLatitude(w, w.mesh.y[cell]);
  const lon = longitudeOf(w.mesh.x[cell]);
  const la = Math.abs(lat) < 0.05 ? '赤道' : `${lat > 0 ? '北' : '南'}纬 ${fmt(Math.abs(lat), 1)}°`;
  return `${la} · ${lon >= 0 ? '东' : '西'}经 ${fmt(Math.abs(lon), 1)}°`;
}

// 整个星球的洋流：海上“洋流：向东北 · 暖流 +3.0 °C”，陆地上“洋流让这里暖 1.8 °C”；没有洋流时为 null
const COMPASS = ['东', '东北', '北', '西北', '西', '西南', '南', '东南'];
function currentText(w: World, cell: number): string | null {
  if (!w.settings.globe || w.small.planet.currents === 0) return null;
  const d = w.derived;
  const a = d.sstAnom[cell];
  if (w.causes.land[cell]) return Math.abs(a) >= 0.3 ? `洋流让这里${a > 0 ? '暖' : '凉'} ${fmt(Math.abs(a), 1)} °C` : null;
  const e = d.currentX[cell];
  const sth = d.currentY[cell];
  if (Math.hypot(e, sth) < 0.05) return '洋流：几乎不动';
  // y 朝南：向北是负的南分量
  const k = (((Math.round(Math.atan2(-sth, e) / (Math.PI / 4)) % 8) + 8) % 8) as number;
  const kind = a >= 0.5 ? ` · 暖流 +${fmt(a, 1)} °C` : a <= -0.5 ? ` · 寒流 −${fmt(-a, 1)} °C` : '';
  return `洋流：向${COMPASS[k]}${kind}`;
}

// 风从哪边吹来、多大：“西南风（中）”。风的分量是东、南（y 朝南）；风从 (−东, +北) 的方向来。
// 快慢分档与风向图层相同
function windText(x: number, y: number): string {
  const m = Math.hypot(x, y);
  if (m < 0.05) return '无风';
  const k = (((Math.round(Math.atan2(y, -x) / (Math.PI / 4)) % 8) + 8) % 8) as number;
  return `${COMPASS[k]}风（${m < 0.35 ? '弱' : m < 0.75 ? '中' : '强'}）`;
}

// 每格属于哪些地理要素，按世界缓存
const featureCache = new WeakMap<World, Map<number, GeoFeature[]>>();
function featuresAt(w: World, cell: number): GeoFeature[] {
  let m = featureCache.get(w);
  if (!m) {
    m = new Map();
    for (const f of w.derived.features) {
      for (const c of f.cells) {
        const l = m.get(c);
        if (l) l.push(f);
        else m.set(c, [f]);
      }
    }
    featureCache.set(w, m);
  }
  return m.get(cell) ?? [];
}

const WORDS: Record<string, [string, string]> = {
  tMean: ['太冷', '太热'],
  tWarm: ['夏天不够热', '夏天太热'],
  tCold: ['冬天太冷', '冬天太暖'],
  precip: ['雨太少', '雨太多'],
  moisture: ['太干', '太湿'],
  seasonality: ['这里不是夏季多雨', '这里不是冬季多雨'],
  elevation: ['地势太低', '地势太高'],
  slope: ['地面太平', '太陡'],
  discharge: ['离大河太远', '河水太大'],
  wetness: ['离水太远，不够潮湿', '太潮湿'],
  continentality: ['离海太近', '离海太远'],
  lat: ['纬度太低', '纬度太高'],
};

type Factor = CellExplanation['factors'][number];

// “靠近某种河”的条件（河岸场 river:<id>）：说出是哪一种河（世界里没有这种河时说“那种河”）
function riverWords(id: string): [string, string] {
  const name = world.value?.small.riverTypes?.find((t) => t.id === id)?.name ?? '那种河';
  return [`离${name}太远`, `离${name}太近`];
}

// “靠近某种湖”（湖岸场 lake:<id>，第九轮）
function lakeWords(id: string): [string, string] {
  const name = world.value?.small.lakeTypes?.find((t) => t.id === id)?.name ?? '那种湖';
  return [`离${name}太远`, `离${name}太近`];
}

// 卡住一种生态的那一项，用人话说
export function reasonText(f: Factor): string {
  const low = f.value < f.range[1];
  const words = WORDS[f.field] ?? (f.field.startsWith('river:') ? riverWords(f.field.slice(6)) : f.field.startsWith('lake:') ? lakeWords(f.field.slice(5)) : [`${fieldLabel.get(f.field) ?? f.field}太低`, `${fieldLabel.get(f.field) ?? f.field}太高`]);
  const need = low ? f.range[1] : f.range[2];
  switch (f.field) {
    case 'tMean':
      return `${low ? words[0] : words[1]}（这里年均 ${fmt(f.value)} °C，它要 ${fmt(need)} °C ${low ? '以上' : '以下'}）`;
    case 'moisture':
      return `${low ? words[0] : words[1]}（湿润程度 ${fmt(f.value, 2)}，它要 ${fmt(need, 2)} ${low ? '以上' : '以下'}）`;
    case 'precip':
      return `${low ? words[0] : words[1]}（一年 ${fmt(f.value)} mm，它要 ${fmt(need)} mm ${low ? '以上' : '以下'}）`;
    case 'elevation':
      return `${low ? words[0] : words[1]}（海拔 ${fmt(f.value)} m，它要 ${fmt(need)} m ${low ? '以上' : '以下'}）`;
    default:
      return low ? words[0] : words[1];
  }
}

function whyNot(w: World, e: CellExplanation, winner: string | null): string {
  if (!e.reachable) {
    if (e.why === 'range') return outsideRangeText(w, w.small.species.find((s) => s.id === e.species) ?? {}) ?? '它只长在设定的岛上或圈的范围里，这里在外面';
    if (e.why === 'natural') return '它不自然生成：只长在涂了它的地方';
    return '它传不到这里（不能跨海，或离起源地太远）';
  }
  const limiting = [...e.factors].sort((a, b) => a.factor - b.factor)[0];
  // 长在哪里的脚本：比最卡的那条耐受条件还卡时先说它
  const place = e.placement;
  if (place !== undefined && place < 0.6 && !(limiting && limiting.factor < place)) {
    return place === 0 ? '它的脚本条件不让它长在这里' : place < 0.005 ? '它的脚本条件在这里几乎是 0' : `它的脚本条件在这里只有 ×${fmt(place, 2)}`;
  }
  if (limiting && limiting.factor < 0.6) return reasonText(limiting);
  return winner ? `这里也能长，但竞争不过“${winner}”` : '这里也能长，但不占上风';
}

function Sentence({ w, cell }: { w: World; cell: number }) {
  const d = w.derived;
  return (
    <p>
      年均 {fmt(d.tMean[cell])} °C（暖季 {fmt(d.tWarm[cell])}，冷季 {fmt(d.tCold[cell])}），一年下雨约 {fmt(d.precip[cell])} mm，海拔约 {fmt(Math.max(0, d.elevation[cell]))} m。
    </p>
  );
}

// 生态、河对周围的影响（第三批）：“受「神圣之地」影响：这里暖了 1.8 °C”。数是引擎算好的（d.effT、d.effP），
// 是谁的影响按现在的生态、河认；很小时不说
function effectText(w: World, cell: number): string | null {
  const d = w.derived;
  if (!d.effT || !d.effP || !w.causes.land[cell]) return null;
  const t = d.effT[cell];
  const p = Math.exp(d.effP[cell]) - 1;
  const parts: string[] = [];
  if (Math.abs(t) >= 0.1) parts.push(`${t > 0 ? '暖' : '冷'}了 ${fmt(Math.abs(t), 1)} °C`);
  if (Math.abs(p) >= 0.01) parts.push(`雨水${p > 0 ? '多' : '少'}了 ${fmt(Math.abs(p) * 100)}%`);
  if (!parts.length) return null;
  const who = effectsAt(w, d, cell).slice(0, 2).map((e) => `「${e.name}」`);
  return `${who.length ? `受${who.join('、')}影响` : '受附近生态、河的影响'}：这里${parts.join('，')}`;
}

function LandInfo({ w, cell }: { w: World; cell: number }) {
  const d = w.derived;
  const S = w.small.species;
  const dom = d.dominant[cell];
  const sp = dom >= 0 ? S[dom] : null;
  const explain = explainCell(w, d, cell);
  const winner = sp ? explain.find((e) => e.species === sp.id) : null;
  const runnerUp = explain.find((e) => e.species !== sp?.id && e.suitability > 0.02) ?? explain.find((e) => e.species !== sp?.id);
  const painted = w.small.constraints.filter((c) => c.cells.includes(cell));
  const failing = activeConflicts(w).find((c) => c.failing.includes(cell));
  // 说了“就这样”的：只轻轻提一句
  const settled = !failing && w.derived.conflicts.some((c) => c.failing.includes(cell));
  // 没涂成的这一格在涂的生态的范围外：先说这一条（排在气候的原因前面）
  const failSp = failing ? S.find((s) => s.id === failing.species) : undefined;
  const failWhy = failSp ? outsideRangeReason(w, failSp, [cell]) : null;
  const brush = category.value === 'nature' ? options.value.biome : null;
  const brushEx = brush && brush !== sp?.id ? explain.find((e) => e.species === brush) : null;
  const corrT = d.corrT[cell];
  const corrP = Math.exp(d.corrP[cell]);
  const effect = effectText(w, cell);
  return (
    <>
      <h3>
        {sp ? (
          <>
            <span class="swatch big" style={{ background: speciesColor(sp) }} /> {sp.name}
          </>
        ) : (
          '什么都长不了'
        )}
        {d.overridden[cell] ? <span class="tag">强制</span> : null}
      </h3>
      <Sentence w={w} cell={cell} />
      {painted.length > 0 && (
        <p class="note">
          这是你涂的“{S.find((s) => s.id === painted[painted.length - 1].species)?.name}”（{painted[painted.length - 1].mode === 'constraint' ? '自然融入' : '强制'}）。
          {failing && <span class="warn"> 这一格没涂成{failWhy ? `：${failWhy}` : ''}。</span>}
          {settled && <span class="muted"> 这一格没涂成（说过“就这样”）。</span>}
        </p>
      )}
      {effect && <p class="muted small">{effect}</p>}
      {(Math.abs(corrT) > 0.3 || Math.abs(corrP - 1) > 0.05) && (
        <p class="muted small">
          为了让涂的生态长出来，这里被调{corrT > 0 ? '暖' : '冷'}了约 {fmt(Math.abs(corrT), 1)} °C，雨水{corrP >= 1 ? '多' : '少'}了约 {fmt(Math.abs(corrP - 1) * 100)}%。
        </p>
      )}
      {sp && winner && (
        <p>
          <b>为什么是{sp.name}：</b>
          {winner.factors.every((f) => f.factor > 0.95) ? '这里的冷暖干湿正合适。' : '这里不算最适合它，但别的生态更不适合。'}
        </p>
      )}
      {explain
        .filter((e) => e.boost !== undefined && e.boost >= 1.05 && e.share >= 0.05)
        .map((e) => (
          <p key={e.species} class="muted small">
            「{e.name}」在侵占这里（×{fmt(e.boost!, 1)}）
          </p>
        ))}
      {!sp && runnerUp && (
        <p>
          <b>为什么什么都不长：</b>最接近的“{runnerUp.name}”也{whyNot(w, runnerUp, null)}。
        </p>
      )}
      {sp && runnerUp && (
        <p>
          <b>为什么不是{runnerUp.name}：</b>
          {whyNot(w, runnerUp, sp.name)}。
        </p>
      )}
      {brushEx && brushEx.species !== runnerUp?.species && (
        <p>
          <b>为什么不是{brushEx.name}：</b>
          {whyNot(w, brushEx, sp?.name ?? null)}。{options.value.biomeMode === 'natural' ? '用“自然融入”涂上去，系统会调这里的气候。' : ''}
        </p>
      )}
      {painted.length > 0 && category.value === 'nature' && (
        <button class="small" onClick={() => void exec({ op: 'erase_constraints', cells: [cell] }, '正在计算生态…')}>
          擦掉这一格的涂色
        </button>
      )}
    </>
  );
}

function Details({ w, cell }: { w: World; cell: number }) {
  const d = w.derived;
  const land = w.causes.land[cell] === 1;
  const rows: [string, string][] = [
    w.settings.globe ? ['经纬度', lonLatText(w, cell)] : ['纬度', `${fmt(worldLatitude(w, w.mesh.y[cell]), 1)}°`],
    [land ? '海拔' : '水深', `${fmt(Math.abs(d.elevation[cell]))} m`],
    ['夏 / 冬气温', `${fmt(d.tS[cell], 1)} / ${fmt(d.tW[cell], 1)} °C`],
    ['年降水', `${fmt(d.precip[cell])} mm`],
    ['夏 / 冬风向', `${windText(d.windSX[cell], d.windSY[cell])} / ${windText(d.windWX[cell], d.windWY[cell])}`],
  ];
  if (land) {
    rows.push(
      ['湿润程度', fmt(d.moisture[cell], 2)],
      ['降水季节性', fmt(d.seasonality[cell], 2)],
      ['坡度', `${fmt(d.slope[cell], 1)} m/km`],
      ['地形湿度', fmt(d.wetness[cell], 1)],
      ['流量', `${fmt(d.discharge[cell])} m³/s`],
      ['离海远近', fmt(d.continentality[cell], 2)],
      ['抬升 / 岩石软硬', `${fmt(w.causes.uplift[cell], 2)} / ${fmt(w.causes.erod[cell], 2)}`],
      ['气候修正', `${fmt(d.corrT[cell] + w.causes.tempOffset[cell], 1)} °C，降水 ×${fmt(Math.exp(d.corrP[cell] + w.causes.moistOffset[cell]), 2)}`],
    );
    if (d.effT && d.effP) rows.push(['周围的影响', `${fmt(d.effT[cell], 1)} °C，降水 ×${fmt(Math.exp(d.effP[cell]), 2)}`]);
    if (d.riverType?.[cell]) {
      const t = w.small.riverTypes?.[d.riverType[cell] - 1];
      if (t) rows.push(['河的类型', t.name]);
    }
    if (d.lakeType?.[cell]) {
      const t = w.small.lakeTypes?.[d.lakeType[cell] - 1];
      if (t) rows.push(['湖的类型', t.name]);
    }
  }
  for (const [k, v] of Object.entries(w.causes.fields)) rows.push([k, fmt(v[cell] + (d.corrF[k]?.[cell] ?? 0), 2)]);
  return (
    <details>
      <summary>详细数字（格 #{cell}）</summary>
      <table class="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

let lastCell = -1;
// 省份那一行按的格：地图上这一点画出来的省（剪刀切线旁按显示的那一边，可能不是 lastCell 的省）
let lastProvinceCell = -1;

export function Inspector() {
  const w = world.value;
  if (!w) return null;
  const cell = lastHoverCell();
  if (cell < 0 || cell >= w.mesh.n) return <p class="muted">把鼠标移到地图上，这里会告诉你那是什么地方。</p>;
  const d = w.derived;
  const land = w.causes.land[cell] === 1;
  const feats = featuresAt(w, cell);
  const named = (types: string[]) => feats.filter((f) => types.includes(f.type)).sort((a, b) => a.areaKm2 - b.areaKm2);
  const where = named(['island', 'continent', 'peninsula'])[0];
  const water = named(['bay', 'strait', 'sea', 'ocean', 'lake'])[0];
  const range = named(['range'])[0];
  const area = named(['plateau', 'plain', 'basin', 'desert', 'forest', 'tundra', 'icecap', 'wetland', 'biome'])[0];
  const river = d.discharge[cell] >= w.small.planet.riverThreshold ? named(['river'])[0] : undefined;
  // 用户圈的地区（最小的那个）
  const region = feats.filter((f) => f.region && f.type !== 'spot').sort((a, b) => a.areaKm2 - b.areaKm2)[0];
  const p = w.causes.province[lastProvinceCell >= 0 && lastProvinceCell < w.mesh.n ? lastProvinceCell : cell];
  const pmeta = p >= 0 ? w.small.provinces[p] : null;
  const place = [...new Set([where?.name, region?.name, range?.name, area?.name, river ? `${river.name}边` : null].filter(Boolean))].join(' · ');
  return (
    <div class="inspector">
      {place && <p class="place">{place}</p>}
      {!land ? (
        <>
          <h3>{water?.name ?? '海'}</h3>
          <p>
            {d.elevation[cell] > -200 ? '浅海' : d.elevation[cell] > -2000 ? '海' : '深海'}，水深约 {fmt(-d.elevation[cell])} m，海水年均 {fmt(d.tMean[cell])} °C。
          </p>
        </>
      ) : d.lake[cell] === 1 ? (
        <>
          <h3>{water?.name ?? '湖'}</h3>
          <p>湖面海拔约 {fmt(d.water[cell] || d.elevation[cell])} m；湖水从最低处流出成河。</p>
        </>
      ) : (
        <LandInfo w={w} cell={cell} />
      )}
      {pmeta && <p class="muted small">省份：{pmeta.name}</p>}
      {w.settings.globe && (
        <p class="muted small">
          {lonLatText(w, cell)}
          {currentText(w, cell) && (
            <>
              <br />
              {currentText(w, cell)}
            </>
          )}
        </p>
      )}
      <Details w={w} cell={cell} />
    </div>
  );
}

// 右下角“这里”的一行：地名 + 是什么 + 冷暖雨水
export function hereLine(w: World, cell: number): string {
  const d = w.derived;
  const feats = featuresAt(w, cell);
  const named = (types: string[]) => feats.filter((f) => types.includes(f.type)).sort((a, b) => a.areaKm2 - b.areaKm2)[0];
  if (!w.causes.land[cell]) {
    const water = named(['bay', 'strait', 'sea', 'ocean']);
    const kind = d.elevation[cell] > -200 ? '浅海' : d.elevation[cell] > -2000 ? '海' : '深海';
    return `${water?.name ? `${water.name} · ` : ''}${kind} · 水深约 ${fmt(-d.elevation[cell])} m`;
  }
  const where = named(['island', 'continent', 'peninsula']);
  const region = feats.filter((f) => f.region && f.type !== 'spot').sort((a, b) => a.areaKm2 - b.areaKm2)[0];
  const prefix = [where?.name, region?.name].filter(Boolean).map((s) => `${s} · `).join('');
  if (d.lake[cell] === 1) return `${prefix}${named(['lake'])?.name ?? '湖'}`;
  // 在河上：带上河名（只有大河有名字）
  const river = d.discharge[cell] >= w.small.planet.riverThreshold ? `${named(['river'])?.name || '河边'} · ` : '';
  const s = d.dominant[cell];
  const sp = s >= 0 ? w.small.species[s] : null;
  return `${prefix}${river}${sp?.name ?? '什么都长不了'} · 年均 ${fmt(d.tMean[cell])} °C · 年降水 ${fmt(d.precip[cell])} mm`;
}

// 最后一次停在地图上的格（鼠标移到面板上时还看得到）
export function lastHoverCell(): number {
  if (hoverCell.value >= 0) {
    lastCell = hoverCell.value;
    lastProvinceCell = hoverProvinceCell.value;
  }
  return lastCell;
}
