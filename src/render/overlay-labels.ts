import { type Anchor, frameOf, glyphs, glyphWidth, LABEL_STYLE, type LabelBox, MOTION_LAYER_MARGIN, MOTION_LAYER_ZOOM, type OverlayState, perf, type PlacedLabel } from './overlay-base';
import { BoxIndex, drawMark, iconScale, markRadius, nameSpots, type SettleMark } from './settle-draw';
import type { Camera } from './renderer';
import { FEATURE_INFO, type GeoFeature } from '../../core/features';
import { COUNTRY_KEY, type CountryLabelDraw, countryFitKey, placeCountries, REGION_KEY } from './overlay-country-labels';
import { type Proj, screenToWorld as projScreenToWorld, trueScale, worldToScreen as projWorldToScreen } from './projection';
import { nameText } from '../../core/name-display';
import { cellName, peakMarks } from '../../core/human';
import type { World } from '../../core/world';
import { arraysToken } from '../../core/world-token';
import { askGlyphs } from './label-font';

// 地名、山峰、城市与地标的排版与画法（第四十一轮从 overlay.ts 原样搬来）

// 有没有要排的字（地名、山峰、国名、城市与地标）
export const hasLabels = (st: OverlayState) => !!(st.features || st.peaks?.length || st.countries?.length || st.settlements?.length);

// ---------- 城市、地标、自定义点（第二十四轮） ----------

// 键的前缀：这些框不给点击命中（城市、地标的工具按地图上的距离认）
export const SETTLE_KEY = 'settle:';
export const SETTLE_FONT = 'system-ui, "PingFang SC", sans-serif';
// 地名、城市名的字体：画风写了字体时用它（第八十七轮，手绘的楷体），否则照旧
export const labelFamily = (style: { labelFont?: string } | undefined) => style?.labelFont ?? SETTLE_FONT;

// 排城市、地标、点（国名之后，按给的先后：首都、大城市在前）：一格在屏幕上够大才画；图标与已画的图标挤在一起时不画（首都、陪都照画），
// 名字在图标的右、左、上、下找一处不和别的字、图标重叠的地方，找不到时不写。放好的框别的地名避让
export function placeSettlements(
  ctx: CanvasRenderingContext2D,
  st: OverlayState,
  ks: number[],
  toScreen: (x: number, y: number) => [number, number] | null,
  zoomAt: (x: number, y: number) => number,
  view: { cw: number; ch: number; mx: number; my: number; exporting: boolean; anchors?: boolean },
  placed: PlacedLabel[],
  boxes: LabelBox[],
  index: BoxIndex,
) {
  const marks = st.settlements ?? [];
  const size = st.cellSize ?? 0;
  const icons = new BoxIndex();
  const names = st.settleNames !== false;
  const family = labelFamily(st.style);
  for (const m of marks) {
    const cellPx = size * zoomAt(m.x, m.y);
    if (cellPx < m.iconPx) continue;
    const full = iconScale(cellPx);
    // 第四十二轮：小一些的城市、首都（等级的 iconScale）
    const scale = m.scale === undefined ? full : full * m.scale;
    const r = markRadius(m, scale);
    for (const k of ks) {
      const at = toScreen(m.x + 2 * k, m.y);
      if (!at) continue;
      const [sx, sy] = at;
      if (sx < -view.mx || sy < -view.my || sx > view.cw + view.mx || sy > view.ch + view.my) continue;
      if (view.exporting && (sx < 0 || sx >= view.cw || sy < 0 || sy >= view.ch)) continue;
      const ib = { key: m.key, x0: sx - r - 1, y0: sy - r - 1, x1: sx + r + 1, y1: sy + r + 1 };
      if (!m.always && icons.hits(ib)) continue;
      icons.add(ib);
      index.add(ib);
      boxes.push(ib);
      const anchor: Anchor | undefined = view.anchors ? [m.x + 2 * k, m.y, sx, sy] : undefined;
      placed.push({ key: m.key, chars: [], widths: [], spacing: 0, total: 0, font: '', color: '', x: sx, y: sy, angle: 0, mark: m, markScale: scale, ...(m.scale !== undefined ? { fullScale: full } : {}), ...(anchor ? { anchor } : {}) });
      if (!names || !m.name || cellPx < m.namePx) continue;
      const font = `${m.bold ? 600 : 500} ${m.fontPx}px ${family}`;
      const chars = [...m.name];
      if (chars.some((c) => !glyphs.has(`${font}|${c}`))) ctx.font = font;
      const widths = chars.map((c) => glyphWidth(ctx, font, c));
      const total = widths.reduce((a, b) => a + b, 0);
      const h = m.fontPx;
      for (const [cx, cy] of nameSpots(sx, sy, r, total, h)) {
        const nb = { key: m.key, x0: cx - total / 2 - 2, y0: cy - h / 2 - 1, x1: cx + total / 2 + 2, y1: cy + h / 2 + 1 };
        if (view.exporting && (nb.x0 < 0 || nb.x1 > view.cw || nb.y0 < 0 || nb.y1 > view.ch)) continue;
        if (index.hits(nb)) continue;
        index.add(nb);
        boxes.push(nb);
        placed.push({ key: m.key, chars, widths, spacing: 0, total, font, color: m.textColor, x: cx, y: cy, angle: 0, ...(m.alpha !== undefined || m.labelAlpha !== undefined ? { of: m } : {}), ...(anchor ? { anchor } : {}) });
        break;
      }
    }
  }
}

// key：整个键；base：键里除了镜头的部分（移动中沿用排好的版面时比它）；cam：排的时候的镜头；
// epoch：移动中排的那一次渲染器的 motionEpoch（停稳时排的为 undefined）
// marks：没标名字的山峰的小三角（CSS 像素）
export let layout: {
  key: string;
  base: string;
  // 键里除了镜头、投影的朝向的部分（转球的手势里比它）
  baseNP: string;
  cam: Camera;
  features: GeoFeature[] | null;
  peaks: GeoFeature[] | null;
  countries: CountryLabelDraw[] | null;
  settlements: SettleMark[] | null;
  placed: PlacedLabel[];
  boxes: LabelBox[];
  marks: [number, number][];
  markAnchors: [number, number][] | null;
  epoch?: number;
  // 移动中排的：第几次手势（停稳的那一帧加一）；停稳时排的为 -1
  gesture: number;
} | null = null;
// 停稳画过一次地名加一：转球时同一次手势里沿用移动中排好的版面（见 drawLabels）
export let gesture = 0;

// 屏幕上一点落在地图上的哪里（投影；不在投影上时 null）
export function worldAt(cam: Camera, cw: number, ch: number, sx: number, sy: number): [number, number] | null {
  const w = projScreenToWorld(cam as Camera & { proj: Proj }, cw, ch, sx, sy);
  return w.inside ? [w.x, w.y] : null;
}


// 版面的键里除了镜头位置的部分（移动中沿用排好的版面时比它）：投影的朝向变了（转动球）要重排
// 第四十轮：悬停的地名只在排版用得上它时进键（layoutHover）；proj 为 false 时不带投影的朝向（转球的一次手势里沿用排好的版面时比它）
export function labelBase(cw: number, chh: number, st: OverlayState, cam: Camera, proj = true): string {
  const p = cam.proj;
  return `${cw}|${chh}|${st.kmPerUnit}|${st.labelTypes ? [...st.labelTypes].join(',') : '*'}|${layoutHover(st)}|${st.nameMode ?? 'zh'}|${st.settleNames === false ? 0 : 1}|${st.cellSize ?? 0}${st.countryFit ? `|${countryFitKey(st.countryFit)}` : ''}${p ? `|${p.kind}${proj ? `|${p.lon0}|${p.lat0}` : ''}` : ''}${st.style?.labelFont ? `|${st.style.labelFont}` : ''}`;
}

// 悬停、选中的地名在排版里的作用（placeLabels：它算“用户自己的”，最先放、一定标，删掉的也标）：只有它是一个地名或山峰、
// 并且不是本来就“用户自己的”或是删掉的时才有作用；别的时候（悬停的是国名、城市，或圈的地区、放的地名……）排出来与没有悬停相同，
// 不进键（悬停的样子只是描边的颜色，由静态那一层按 hoverLabel 重画）
export let hoverMemo: { key: string; features: unknown; peaks: unknown; out: string } | null = null;
export function layoutHover(st: OverlayState): string {
  const h = st.hoverLabel;
  if (!h) return '';
  if (hoverMemo && hoverMemo.key === h && hoverMemo.features === st.features && hoverMemo.peaks === st.peaks) return hoverMemo.out;
  const hits = (list: readonly GeoFeature[] | null | undefined) => list?.some((f) => f.key === h && (f.hidden || !(f.region || f.custom))) ?? false;
  const out = hits(st.features) || hits(st.peaks) ? h : '';
  hoverMemo = { key: h, features: st.features, peaks: st.peaks, out };
  return out;
}

// 要写的字（地名、山峰、城市、国名）：载入网页字体用
export function* labelTexts(st: Pick<OverlayState, 'features' | 'peaks' | 'settlements' | 'countries'>): Generator<string> {
  for (const list of [st.features, st.peaks])
    for (const f of list ?? []) {
      if (f.name) yield f.name;
      if (f.orig) yield f.orig;
    }
  for (const m of st.settlements ?? []) if (m.name) yield m.name;
  for (const c of st.countries ?? []) yield* c.lines;
}

// 哪些地名标出来、放在哪里（按布局缓存；导出给测试用）
export function placeLabels(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): { placed: PlacedLabel[]; boxes: LabelBox[]; marks: [number, number][] } {
  const { cw, ch: chh } = frameOf(ctx, st);
  const exporting = !!st.frame;
  const base = labelBase(cw, chh, st, cam);
  const key = `${cam.x}|${cam.y}|${cam.zoom}|${ks.join(',')}|${base}|${st.motion ? 'm' : ''}`;
  const peaks = st.peaks ?? null;
  if (!exporting && layout && layout.key === key && layout.features === st.features && layout.peaks === peaks && layout.countries === (st.countries ?? null) && layout.settlements === (st.settlements ?? null)) return layout;
  const t0 = perf ? performance.now() : 0;
  // 画风写了网页字体（第八十七轮，手绘的楷体）：请浏览器载入要写的字（载入好了静态那一层重画）
  if (st.style?.labelFont && !exporting) askGlyphs(st.style.labelFont, labelTexts(st));
  // 等面积、球形投影：地名的中心按投影算（球的背面不标），大小按那里的比例
  const proj = cam.proj;
  const toScreen = proj
    ? (x: number, y: number): [number, number] | null => projWorldToScreen(cam, cw, chh, x, y)
    : (x: number, y: number): [number, number] | null => [(x - cam.x) * cam.zoom + cw / 2, (y - cam.y) * cam.zoom + chh / 2];
  // 移动中：画面四周再多排一圈（与渲染器移动中的场景一样宽），挪到下一次重排之前露出来的地方也有地名
  const mx = 100 + (st.motion && !exporting ? MOTION_LAYER_MARGIN * cw : 0);
  const my = 40 + (st.motion && !exporting ? MOTION_LAYER_MARGIN * chh : 0);
  const placed: PlacedLabel[] = [];
  const boxes: LabelBox[] = [];
  // 放好的框按格子记下（第四十轮：避让按格子查，与逐个比相同；boxes 与 index 里始终是同一批框）
  const index = new BoxIndex();
  // 国名最先排（第二十三轮）
  if (st.countries?.length) placeCountries(ctx, st, ks, toScreen, { cw, ch: chh, mx, my, exporting }, placed, boxes, index);
  // 城市、地标、自定义点（第二十四轮）：国名之后
  if (st.settlements?.length) placeSettlements(ctx, st, ks, toScreen, (x, y) => (proj ? cam.zoom * trueScale(proj, x, y) : cam.zoom), { cw, ch: chh, mx, my, exporting, anchors: !!proj }, placed, boxes, index);
  // 用户自己的地名（圈的地区、放的地名、改过的名字）和悬停、选中的那个：总是标出来，最先放（避让时别的让它）
  const mine = (f: GeoFeature) => !!f.region || f.custom || f.key === st.hoverLabel;
  const features = [...(st.features ?? [])].sort((a, b) => Number(mine(b)) - Number(mine(a)) || b.importance - a.importance);
  // 全部山峰：排在别的地名之后（按海拔从高到低）；地名里已有的主峰不再标一遍
  const pseudo = new Set<GeoFeature>();
  if (peaks?.length) {
    const shown = new Set(features.filter((f) => f.type === 'peak' && (!st.labelTypes || st.labelTypes.has('peak'))).map((f) => f.anchor));
    for (const f of peaks) if (!shown.has(f.anchor)) pseudo.add(f);
    features.push(...pseudo);
  }
  const named = new Set<GeoFeature>();
  const family = labelFamily(st.style);
  for (const f of features) {
    const isPeak = pseudo.has(f);
    if (!f.name || (!isPeak && st.labelTypes && !st.labelTypes.has(f.type))) continue;
    // 删掉的地名不标（选中、悬停着的那个照样标出来，看得到在改哪一个；导出的图里不标）
    if (f.hidden && (exporting || f.key !== st.hoverLabel)) continue;
    // 在屏幕上有多大；山峰、用户放的点状地名没有大小（山峰放大到一定程度才标，地点总是标）
    const point = f.type === 'peak' || f.type === 'spot';
    // 投影时按地名那里的比例（球形的边上小）
    const zl = proj ? cam.zoom * trueScale(proj, f.x, f.y) : cam.zoom;
    const sizePx = f.type === 'river' ? f.span * zl : point ? 0 : (Math.sqrt(f.areaKm2) / st.kmPerUnit) * zl;
    const minPx = f.type === 'continent' || f.type === 'ocean' ? 25 : f.type === 'river' ? 90 : point ? 0 : 45;
    if (!mine(f) && (f.type === 'peak' ? rz < (isPeak ? PEAK_NAME_ZOOM : 1600) : sizePx < minPx)) continue;
    // 整个星球：每份副本上都可能看得见（相隔一整圈，彼此不会挤在一起）
    const spots: [number, number][] = [];
    for (const k of ks) {
      const at = toScreen(f.x + 2 * k, f.y);
      if (!at) continue;
      const [x, y] = at;
      if (x < -mx || y < -my || x > cw + mx || y > chh + my) continue;
      // 导出整张地图：只要中心落在图里的那一份（整个星球的图是一整圈，分界线两边的副本不标两遍）
      if (exporting && (x < 0 || x >= cw)) continue;
      spots.push([x, y]);
    }
    if (!spots.length) continue;
    const group = FEATURE_INFO[f.type].group;
    const style = LABEL_STYLE[group];
    const base = f.type === 'continent' || f.type === 'ocean' ? 15 : f.type === 'river' || f.type === 'peak' ? 10.5 : 11;
    const grow = minPx > 0 ? Math.max(0, Math.log2(Math.max(1, sizePx / minPx))) * 2.6 : 0;
    const fontPx = Math.round(Math.min(f.type === 'continent' || f.type === 'ocean' ? 30 : 20, base + grow));
    const font = `${style.italic ? 'italic ' : ''}${f.type === 'continent' || f.type === 'ocean' ? 600 : 500} ${fontPx}px ${family}`;
    const label = nameText(f.name, f.orig, st.nameMode);
    const text = f.type === 'peak' ? `▲ ${label}` : f.type === 'spot' ? `• ${label}` : label;
    const chars = [...text];
    // 第四十轮：只在要量字（字宽缓存里没有）时设字体（设一次要解析一遍字体名；画的时候每个地名自己设）
    if (chars.some((c) => !glyphs.has(`${font}|${c}`))) ctx.font = font;
    const wide = f.type === 'range' || f.type === 'continent' || f.type === 'ocean' || f.type === 'region';
    const spacing = (f.type === 'region' ? 0.3 : style.spacing) * fontPx * (wide ? 2 : 1);
    const widths = chars.map((c) => glyphWidth(ctx, font, c));
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    // 地点：圆点落在放的位置上，字在右边
    const shift = f.type === 'spot' ? total / 2 - widths[0] / 2 : 0;
    // 狭长的地物沿主轴写，其余横写（用户圈的区块只在明显狭长时才斜着写，见 regionFeatures）
    let angle = 0;
    if (f.type === 'river' && f.line && f.line.length > 2) {
      const mid = Math.floor(f.line.length / 2);
      const a = f.line[Math.max(0, mid - 2)];
      const b = f.line[Math.min(f.line.length - 1, mid + 2)];
      const dxl = b[0] - a[0];
      angle = Math.atan2(b[1] - a[1], dxl - 2 * Math.round(dxl / 2));
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
    } else if (f.region ? f.angle !== 0 && f.span * zl > total * 1.4 : (f.type === 'range' || f.type === 'peninsula' || f.type === 'strait') && f.span * zl > total * 1.4) {
      angle = f.angle;
    }
    // 投影：地图上的方向换成屏幕上的方向（顺着地物的走向）
    if (proj && angle !== 0) {
      const e = 1e-4;
      const a0 = toScreen(f.x, f.y);
      const a1 = toScreen(f.x + e * Math.cos(angle), f.y + e * Math.sin(angle));
      if (a0 && a1) {
        angle = Math.atan2(a1[1] - a0[1], a1[0] - a0[0]);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
      }
    }
    const hw = (Math.abs(Math.cos(angle)) * total + Math.abs(Math.sin(angle)) * fontPx) / 2 + 3;
    const hh = (Math.abs(Math.sin(angle)) * total + Math.abs(Math.cos(angle)) * fontPx) / 2 + 2;
    for (const [x0, y0] of spots) {
      let sx = x0 + shift;
      let sy = y0;
      // 导出整张地图：整个字在图里（伸出边的往里挪；比图还大的不标）
      if (exporting) {
        if (2 * hw > cw || 2 * hh > chh) continue;
        sx = Math.max(hw, Math.min(cw - hw, sx));
        sy = Math.max(hh, Math.min(chh - hh, sy));
      }
      const box = { key: f.key, x0: sx - hw, y0: sy - hh, x1: sx + hw, y1: sy + hh };
      if (index.hits(box)) continue;
      boxes.push(box);
      index.add(box);
      placed.push({ key: f.key, chars, widths, spacing, total, font, color: f.custom && !isPeak ? '#7a1f5c' : style.color, x: sx, y: sy, angle, ...(proj ? { anchor: [f.x, f.y, x0, y0] as Anchor } : {}) });
      if (isPeak) named.add(f);
    }
  }
  // 没标名字的山峰：画一个小三角（与已标的地名、别的三角隔开 PEAK_GAP 像素以上才画，高的先画）
  const marks: [number, number][] = [];
  // 投影时每个三角的地图坐标（转球的一次手势里按它重新投影，见 drawLabels）
  const markAnchors: [number, number][] = [];
  // 按 PEAK_GAP 分格记下画了的三角：只看相邻的九格
  const grid = new Map<string, [number, number][]>();
  const near = (x: number, y: number) => {
    const gx = Math.floor(x / PEAK_GAP);
    const gy = Math.floor(y / PEAK_GAP);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [px0, py0] of grid.get(`${gx + i},${gy + j}`) ?? []) if (Math.abs(px0 - x) < PEAK_GAP && Math.abs(py0 - y) < PEAK_GAP) return true;
    return false;
  };
  for (const f of pseudo) {
    if (named.has(f)) continue;
    for (const k of ks) {
      const at = toScreen(f.x + 2 * k, f.y);
      if (!at) continue;
      const [x, y] = at;
      if (x < -mx || y < -my || x > cw + mx || y > chh + my || (exporting && (x < 0 || x >= cw))) continue;
      if (near(x, y) || index.hits({ key: '', x0: x - 4, y0: y - 4, x1: x + 4, y1: y + 4 })) continue;
      marks.push([x, y]);
      if (proj) markAnchors.push([f.x + 2 * k, f.y]);
      const g = `${Math.floor(x / PEAK_GAP)},${Math.floor(y / PEAK_GAP)}`;
      const cell = grid.get(g);
      if (cell) cell.push([x, y]);
      else grid.set(g, [[x, y]]);
    }
  }
  // 点击命中只给真的地名（山峰不是地物，点了没有可改的名字；国名也不是地物）
  const hits = pseudo.size || st.countries?.length || st.settlements?.length ? boxes.filter((b) => !b.key.startsWith(PEAK_KEY) && !b.key.startsWith(COUNTRY_KEY) && !b.key.startsWith(REGION_KEY) && !b.key.startsWith(SETTLE_KEY)) : boxes;
  // 投影：国名的每个字记下它落在地图上的哪一点（转球时按它重新投影）
  if (proj) for (const l of placed) if (l.glyphs) l.glyphAnchors = l.glyphs.map((g) => worldAt(cam, cw, chh, g.x, g.y));
  const out = {
    key,
    base,
    baseNP: labelBase(cw, chh, st, cam, false),
    cam: { ...cam },
    features: st.features,
    peaks,
    countries: st.countries ?? null,
    settlements: st.settlements ?? null,
    placed,
    boxes: hits,
    marks,
    markAnchors: proj ? markAnchors : null,
    epoch: st.motion ? st.motionEpoch : undefined,
    gesture: st.motion ? gesture : -1,
  };
  if (!exporting) layout = out;
  if (perf) perf.cpu('layout', performance.now() - t0);
  return out;
}

// 投影的手势里沿用的版面按现在的镜头重新投影（见 drawLabels）：地名、图标挪到锚点现在的位置，国名的字逐个投影，
// 转到背面（或出了投影）的不画；点击用的框跟着它的地名挪
export function reprojected(L: NonNullable<typeof layout>, cam: Camera, cw: number, ch: number): { placed: PlacedLabel[]; boxes: LabelBox[]; marks: [number, number][] } {
  const at = (x: number, y: number) => projWorldToScreen(cam, cw, ch, x, y);
  const placed: PlacedLabel[] = [];
  const shift = new Map<string, [number, number]>();
  for (const l of L.placed) {
    if (l.glyphs) {
      const ga = l.glyphAnchors;
      if (!ga) continue;
      const glyphs: { x: number; y: number; a: number }[] = [];
      for (let k = 0; k < l.glyphs.length; k++) {
        const a = ga[k];
        const p = a && at(a[0], a[1]);
        if (!p) break;
        glyphs.push({ x: p[0], y: p[1], a: l.glyphs[k].a });
      }
      if (glyphs.length === l.glyphs.length) placed.push({ ...l, glyphs });
      continue;
    }
    if (!l.anchor) continue;
    const p = at(l.anchor[0], l.anchor[1]);
    if (!p) continue;
    const dx = p[0] - l.anchor[2];
    const dy = p[1] - l.anchor[3];
    placed.push({ ...l, x: l.x + dx, y: l.y + dy });
    if (!shift.has(l.key)) shift.set(l.key, [dx, dy]);
  }
  const boxes: LabelBox[] = [];
  for (const b of L.boxes) {
    const d = shift.get(b.key);
    if (d) boxes.push({ key: b.key, x0: b.x0 + d[0], y0: b.y0 + d[1], x1: b.x1 + d[0], y1: b.y1 + d[1] });
  }
  const marks: [number, number][] = [];
  for (const [x, y] of L.markAnchors ?? []) {
    const p = at(x, y);
    if (p) marks.push(p);
  }
  return { placed, boxes, marks };
}

// 移动中：沿用排好的版面，整体挪一挪、缩一缩；渲染器重画移动中的场景时（motionEpoch 变了）在同一帧重排。
// 没有 motionEpoch 时（测试、开发用的测速）照旧：挪了不到这么多（CSS 像素）、缩放变了不到这么多倍时沿用
export const MOTION_LABEL_SHIFT = 160;
export const MOTION_LABEL_ZOOM = 1.15;

export function drawLabels(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): LabelBox[] {
  const { cw, ch: chh, dpr } = frameOf(ctx, st);
  // 版面上的位置（CSS 像素）→ 现在的位置：x · r + ox
  let r = 1;
  let ox = 0;
  let oy = 0;
  let placed: PlacedLabel[];
  let boxes: LabelBox[];
  let marks: [number, number][];
  const L = layout;
  const base = labelBase(cw, chh, st, cam);
  const zr = L ? cam.zoom / L.cam.zoom : 0;
  if (
    st.motion &&
    !st.frame &&
    L &&
    L.base === base &&
    L.features === st.features &&
    L.peaks === (st.peaks ?? null) &&
    L.countries === (st.countries ?? null) &&
    L.settlements === (st.settlements ?? null) &&
    (st.motionEpoch !== undefined
      ? // 同一次场景（开始动的第一帧场景就重画了：地名也在这一帧按带边距的范围重排）
        L.epoch === st.motionEpoch &&
        zr < MOTION_LAYER_ZOOM &&
        zr > 1 / MOTION_LAYER_ZOOM
      : zr < MOTION_LABEL_ZOOM && zr > 1 / MOTION_LABEL_ZOOM && Math.abs(L.cam.x - cam.x) * cam.zoom < MOTION_LABEL_SHIFT && Math.abs(L.cam.y - cam.y) * cam.zoom < MOTION_LABEL_SHIFT)
  ) {
    r = zr;
    ox = cw / 2 - (cw / 2) * r + (L.cam.x - cam.x) * cam.zoom;
    oy = chh / 2 - (chh / 2) * r + (L.cam.y - cam.y) * cam.zoom;
    placed = L.placed;
    marks = L.marks;
    boxes = L.boxes.map((b) => ({ key: b.key, x0: b.x0 * r + ox, y0: b.y0 * r + oy, x1: b.x1 * r + ox, y1: b.y1 * r + oy }));
  } else if (
    // 第四十轮：等面积、球形投影转动、缩放的一次手势里（移动中，还没停稳过）沿用这次手势第一帧排好的版面，每个地名、图标、
    // 国名的每个字按记下的地图上的点重新投影（转到背面的不画）；停稳的那一帧照原样重排
    st.motion &&
    !st.frame &&
    cam.proj &&
    L &&
    L.markAnchors &&
    L.gesture === gesture &&
    L.baseNP === labelBase(cw, chh, st, cam, false) &&
    L.features === st.features &&
    L.peaks === (st.peaks ?? null) &&
    L.countries === (st.countries ?? null) &&
    L.settlements === (st.settlements ?? null) &&
    zr < MOTION_LAYER_ZOOM &&
    zr > 1 / MOTION_LAYER_ZOOM
  ) {
    ({ placed, boxes, marks } = reprojected(L, cam, cw, chh));
  } else ({ placed, boxes, marks } = placeLabels(ctx, cam, st, ks, rz));
  // 停稳画了一次：之后的移动是新的一次手势
  if (!st.motion && !st.frame) gesture++;
  if (r === 1 && ox === 0 && oy === 0) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.setTransform(dpr * r, 0, 0, dpr * r, dpr * ox, dpr * oy);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  for (const l of placed) {
    if (l.glyphs) {
      drawGlyphs(ctx, l, st.hoverLabel === l.key);
      continue;
    }
    if (l.mark) {
      const m = l.mark;
      // 第四十二轮：淡一些、小一些的点（鼠标停着、选中的照原样）
      if (m.alpha === undefined && m.scale === undefined) drawMark(ctx, m, l.x, l.y, l.markScale, !!st.frame);
      else {
        const strong = isStrong(st, m);
        if (!strong && m.alpha !== undefined) ctx.globalAlpha = m.alpha;
        drawMark(ctx, m, l.x, l.y, strong && l.fullScale !== undefined ? l.fullScale : l.markScale, !!st.frame);
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      continue;
    }
    ctx.save();
    if (l.of && !isStrong(st, l.of)) ctx.globalAlpha = l.of.labelAlpha ?? l.of.alpha ?? 1;
    ctx.translate(l.x, l.y);
    ctx.rotate(l.angle);
    ctx.font = l.font;
    // 先给整串字描边，再统一填字：后一个字的描边不会啃掉前一个字
    ctx.strokeStyle = st.hoverLabel === l.key ? 'rgba(255, 236, 140, 0.95)' : 'rgba(255, 255, 255, 0.72)';
    let x = -l.total / 2;
    l.chars.forEach((c, k) => {
      ctx.strokeText(c, x, 0);
      x += l.widths[k] + l.spacing;
    });
    ctx.fillStyle = l.color;
    x = -l.total / 2;
    l.chars.forEach((c, k) => {
      ctx.fillText(c, x, 0);
      x += l.widths[k] + l.spacing;
    });
    ctx.restore();
  }
  if (marks.length) {
    // 山峰的小三角：白边、山脉地名的颜色
    ctx.beginPath();
    for (const [mx0, my0] of marks) {
      ctx.moveTo(mx0, my0 - 4.5);
      ctx.lineTo(mx0 + 4, my0 + 3);
      ctx.lineTo(mx0 - 4, my0 + 3);
      ctx.closePath();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.stroke();
    ctx.fillStyle = LABEL_STYLE.relief.color;
    ctx.fill();
  }
  return boxes;
}

// 照最醒目的画（第四十二轮）：鼠标停着、选中的点，选中、钉住、鼠标停着的国家的首都
const isStrong = (st: OverlayState, m: SettleMark): boolean => !!st.settleStrong && (st.settleStrong.includes(m.key) || (m.country !== undefined && st.settleStrong.includes(`country:${m.country}`)));

// 国名：每个字按自己的位置、方向画；先描边、再填字（同地名）
export function drawGlyphs(ctx: CanvasRenderingContext2D, l: PlacedLabel, hover: boolean) {
  const g = l.glyphs!;
  ctx.font = l.font;
  ctx.lineWidth = l.haloWidth ?? 3;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 0) ctx.strokeStyle = hover ? 'rgba(255, 236, 140, 0.95)' : (l.halo ?? 'rgba(255, 255, 255, 0.72)');
    else ctx.fillStyle = l.color;
    l.chars.forEach((c, k) => {
      ctx.save();
      ctx.translate(g[k].x, g[k].y);
      ctx.rotate(g[k].a);
      if (pass === 0) ctx.strokeText(c, -l.widths[k] / 2, 0);
      else ctx.fillText(c, -l.widths[k] / 2, 0);
      ctx.restore();
    });
  }
  ctx.lineWidth = 3;
}

// 图层里的“山峰”（第二十一轮）：全部山峰（core/human 的 peakMarks）当作地名排，键是 PEAK_KEY + 格。
// 放大到 PEAK_NAME_ZOOM（同 refZoom）才标名字，之前只画小三角，彼此至少隔 PEAK_GAP 像素
export const PEAK_KEY = 'cellpeak:';
export const PEAK_NAME_ZOOM = 1600;
export const PEAK_GAP = 14;
// 第八十轮：主线程上没变的数组、小数据的段、地物沿用同一个对象（以前每份快照的地物都是新的，这里每次都重算）：
// 键里另加起名读的（数组按“这一批”、省份与名字的风格、内容、时代、河流门槛、种子）
export const peakCache = new WeakMap<Uint8Array, { key: unknown[]; list: GeoFeature[] }>();
export function peakLabels(world: World): GeoFeature[] {
  const d = world.derived;
  if (!d.peak) return [];
  const hit = peakCache.get(d.peak);
  const s = world.small;
  const key = [s.cells, d.features, arraysToken(world), s.provinces, s.content, s.nameStyle, s.featureNames, s.human, s.planet, s.terrain, world.settings.seed];
  if (hit && hit.key.every((k, i) => k === key[i])) return hit.list;
  const list: GeoFeature[] = peakMarks(world).map((m) => {
    const n = m.feature ? null : cellName(world, m.cell);
    const f = m.feature ? d.features.find((x) => x.key === m.feature) : undefined;
    const orig = n ? n.orig : f?.orig;
    return {
      key: `${PEAK_KEY}${m.cell}`,
      type: 'peak',
      anchor: m.cell,
      cells: new Int32Array(0),
      areaKm2: 0,
      x: m.x,
      y: m.y,
      angle: 0,
      span: 0,
      tags: [],
      importance: m.elevation,
      name: m.name,
      custom: false,
      ...(orig ? { orig } : {}),
    };
  });
  peakCache.set(d.peak, { key, list });
  return list;
}
