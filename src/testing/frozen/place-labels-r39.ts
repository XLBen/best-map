// 第四十轮的冻结的参照：第三十九轮（7b4dfea）的地名排版（逐个比的避让、每个地名都设字体），照抄、只去掉缓存。
// overlay-static.test.ts 拿它与现在的 placeLabels 逐项比（排出来的位置、字、框、山峰的三角都相同）。不要改它
/* eslint-disable */
import { FEATURE_INFO, type GeoFeature } from '../../../core/features';
import { nameText } from '../../../core/name-display';
import type { Camera } from '../../render/renderer';
import { type LabelBox, type OverlayState, PEAK_KEY, SETTLE_KEY } from '../../render/overlay';
import { type SettleMark, iconScale, markRadius, nameSpots } from '../../render/settle-draw';
import { trueScale, worldToScreen as projWorldToScreen } from '../../render/projection';

const MOTION_LAYER_MARGIN = 0.35;
type Box = LabelBox;
function frameOf(ctx: { canvas: { clientWidth: number; clientHeight: number } }, st?: { frame?: { cw: number; ch: number; dpr: number } }) {
  if (st?.frame) return st.frame;
  return { cw: ctx.canvas.clientWidth, ch: ctx.canvas.clientHeight, dpr: 1 };
}

const LABEL_STYLE: Record<'land' | 'water' | 'relief' | 'nature', { color: string; italic: boolean; spacing: number }> = {
  land: { color: '#1e2226', italic: false, spacing: 0 },
  water: { color: '#1f4f7a', italic: true, spacing: 0.15 },
  relief: { color: '#5a3b1e', italic: false, spacing: 0.35 },
  nature: { color: '#3d4f22', italic: true, spacing: 0.2 },
};

// 地名：按重要度从高到低放，和已放的重叠就跳过；字号随屏幕上的大小。
// 排版（逐字测宽、避让）按镜头缓存：鼠标移动时不重排，只重画
interface PlacedLabel {
  key: string;
  chars: string[];
  widths: number[];
  spacing: number;
  total: number;
  font: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  // 国名：每个字自己的位置与方向（CSS 像素、弧度），沿弯的中线排；有它时不看 x、y、angle
  glyphs?: { x: number; y: number; a: number }[];
  // 描边的颜色、粗细（国名淡一些）
  halo?: string;
  haloWidth?: number;
  // 城市、地标、点的图标（第二十四轮）：画在 x、y（CSS 像素），没有字；markScale：缩得很小时小一些
  mark?: SettleMark;
  markScale?: number;
}


const SETTLE_FONT = 'system-ui, "PingFang SC", sans-serif';

// 排城市、地标、点（国名之后，按给的先后：首都、大城市在前）：一格在屏幕上够大才画；图标与已画的图标挤在一起时不画（首都、陪都照画），
// 名字在图标的右、左、上、下找一处不和别的字、图标重叠的地方，找不到时不写。放好的框别的地名避让
function placeSettlements(
  ctx: CanvasRenderingContext2D,
  st: OverlayState,
  ks: number[],
  toScreen: (x: number, y: number) => [number, number] | null,
  zoomAt: (x: number, y: number) => number,
  view: { cw: number; ch: number; mx: number; my: number; exporting: boolean },
  placed: PlacedLabel[],
  boxes: LabelBox[],
) {
  const marks = st.settlements ?? [];
  const size = st.cellSize ?? 0;
  const index = new BoxIndex();
  for (const b of boxes) index.add(b);
  const icons = new BoxIndex();
  const names = st.settleNames !== false;
  for (const m of marks) {
    const cellPx = size * zoomAt(m.x, m.y);
    if (cellPx < m.iconPx) continue;
    const scale = iconScale(cellPx);
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
      placed.push({ key: m.key, chars: [], widths: [], spacing: 0, total: 0, font: '', color: '', x: sx, y: sy, angle: 0, mark: m, markScale: scale });
      if (!names || !m.name || cellPx < m.namePx) continue;
      const font = `${m.bold ? 600 : 500} ${m.fontPx}px ${SETTLE_FONT}`;
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
        placed.push({ key: m.key, chars, widths, spacing: 0, total, font, color: m.textColor, x: cx, y: cy, angle: 0 });
        break;
      }
    }
  }
}


// ---------- 国名（第二十三轮） ----------

// 一个国名：key（'country:编号'）、一两行字（两者时中文一行、原文一行）、中线（5 个点，地图坐标，从左到右；
// 星球上首尾的 x 可能跨过接缝）、主体的大小（地图单位²，按屏幕上的面积：平铺图上已除以纬度的余弦）
interface CountryLabelDraw {
  key: string;
  lines: string[];
  path: [number, number][];
  area: number;
}

const COUNTRY_KEY = 'country:';
// 片区名（第二十五轮：文化、文化组、每一维的取值）与国名同样排、同样不给点击命中
const REGION_KEY = 'region:';
// 国名的颜色：画风的 countryLabel（第三十八轮）
const COUNTRY_HALO = 'rgba(255, 255, 255, 0.42)';
const COUNTRY_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif';
// 国名的字号：不到这么大不标，最大这么大（CSS 像素）
const COUNTRY_MIN_PX = 10;
const COUNTRY_MAX_PX = 64;
// 原文（拉丁字母）写成大写
const LATIN = /^[\x00-ɏ\s'’.-]+$/;

// 过 5 个点的平滑曲线（Catmull-Rom）上每段取 4 个点
function smoothPath(pts: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const P = (k: number) => pts[Math.max(0, Math.min(pts.length - 1, k))];
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = P(k - 1);
    const p1 = P(k);
    const p2 = P(k + 1);
    const p3 = P(k + 2);
    for (let j = 0; j < 4; j++) {
      const t = j / 4;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// 沿折线走到 s 处：位置与方向
function along(pts: readonly [number, number][], cum: readonly number[], s: number): { x: number; y: number; a: number } {
  let k = 1;
  while (k < pts.length - 1 && cum[k] < s) k++;
  const [ax, ay] = pts[k - 1];
  const [bx, by] = pts[k];
  const seg = cum[k] - cum[k - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[k - 1]) / seg));
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, a: Math.atan2(by - ay, bx - ax) };
}

// 一行字排在屏幕上的一条折线上（像 EU4：字距拉开，铺满中线的八成；字距最多 maxGap）。
// widths1：每个字在 1 像素字号时的宽。放不下时 null
function layoutAlong(
  chars: readonly string[],
  widths1: readonly number[],
  pts: readonly [number, number][],
  fontPx: number,
  maxGap: number,
): { glyphs: { x: number; y: number; a: number }[]; gap: number; total: number } | null {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const L = cum[cum.length - 1];
  const W = widths1.reduce((a, b) => a + b, 0) * fontPx;
  const n = chars.length;
  const avail = L * 0.8;
  if (!(L > 0) || W > avail * 1.05) return null;
  const gap = n > 1 ? Math.max(0, Math.min(maxGap, (avail - W) / (n - 1))) : 0;
  const total = W + gap * (n - 1);
  let s = (L - total) / 2;
  const glyphs = chars.map((_, k) => {
    const w = widths1[k] * fontPx;
    const g = along(pts, cum, s + w / 2);
    s += w + gap;
    return g;
  });
  return { glyphs, gap, total };
}

// 一条折线往法线方向挪 d 像素（屏幕上 y 向下：正的往下）
function offsetLine(pts: readonly [number, number][], d: number): [number, number][] {
  if (d === 0) return [...pts];
  return pts.map((p, q) => {
    const a = pts[Math.max(0, q - 1)];
    const b = pts[Math.min(pts.length - 1, q + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] - ((b[1] - a[1]) / len) * d, p[1] + ((b[0] - a[0]) / len) * d];
  });
}

// 国名的字：两者时第二行（原文）、写原文时的那一行拉丁字母写成大写
const countryLineText = (lines: readonly string[]) => lines.map((t, q) => (q > 0 || LATIN.test(t) ? t.toUpperCase() : t));

// 一个国名的中线（展开跨接缝的、平滑过的）与每个字在 1 像素字号时的宽：按国名对象缓存（排版时不再设字体、量字，
// 设一次字体要解析一遍字体名，一百多个国名每次重排都设会慢几十毫秒）
interface CountryMetrics {
  curve: [number, number][];
  lenU: number;
  first: string[];
  w1: number[];
  second: string[] | null;
  w2: number[];
}
const metricsCache = new WeakMap<CountryLabelDraw, CountryMetrics>();
function countryMetrics(ctx: CanvasRenderingContext2D, c: CountryLabelDraw): CountryMetrics {
  let m = metricsCache.get(c);
  if (m) return m;
  // 展开跨接缝的中线（星球：相邻两点的 x 差不超过 1）
  const base: [number, number][] = [];
  for (const [x, y] of c.path) {
    const prev = base[base.length - 1];
    base.push([prev ? x + 2 * Math.round((prev[0] - x) / 2) : x, y]);
  }
  let lenU = 0;
  for (let k = 1; k < base.length; k++) lenU += Math.hypot(base[k][0] - base[k - 1][0], base[k][1] - base[k - 1][1]);
  const lines = countryLineText(c.lines);
  const measure = (text: string, weight: number) => {
    const font = `${weight} 100px ${COUNTRY_FONT}`;
    const chars = [...text];
    if (chars.some((ch) => !glyphs.has(`${font}|${ch}`))) ctx.font = font;
    return { chars, w: chars.map((ch) => glyphWidth(ctx, font, ch) / 100) };
  };
  const a = measure(lines[0], 600);
  const b = lines[1] ? measure(lines[1], 500) : null;
  m = { curve: smoothPath(base), lenU, first: a.chars, w1: a.w, second: b?.chars ?? null, w2: b?.w ?? [] };
  metricsCache.set(c, m);
  return m;
}

// 排国名（最先排，大的先排）：放不下、和已排的国名重叠的不标。放好的字一个字一个框，别的地名按它们避让
function placeCountries(
  ctx: CanvasRenderingContext2D,
  st: OverlayState,
  ks: number[],
  toScreen: (x: number, y: number) => [number, number] | null,
  view: { cw: number; ch: number; mx: number; my: number; exporting: boolean },
  placed: PlacedLabel[],
  boxes: LabelBox[],
) {
  const list = [...(st.countries ?? [])].sort((a, b) => b.area - a.area);
  const color = st.style.countryLabel;
  for (const c of list) {
    const { curve, lenU, first, w1, second, w2 } = countryMetrics(ctx, c);
    if (!(lenU > 0)) continue;
    for (const k of ks) {
      const pts: [number, number][] = [];
      let ok = true;
      for (const [x, y] of curve) {
        const p = toScreen(x + 2 * k, y);
        if (!p) {
          ok = false;
          break;
        }
        pts.push(p);
      }
      if (!ok) continue;
      let L = 0;
      for (let q = 1; q < pts.length; q++) L += Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
      const mid = pts[Math.floor(pts.length / 2)];
      if (L < 30 || mid[0] < -view.mx - L / 2 || mid[0] > view.cw + view.mx + L / 2 || mid[1] < -view.my - L / 2 || mid[1] > view.ch + view.my + L / 2) continue;
      if (view.exporting && (mid[0] < 0 || mid[0] >= view.cw)) continue;
      // 领土在屏幕上有多粗：面积 ÷ 中线的长度
      const thick = (c.area / lenU) * (L / lenU);
      const sum1 = w1.reduce((a, b) => a + b, 0);
      const fit = Math.min(COUNTRY_MAX_PX, thick * 0.36, (L * 0.8) / Math.max(sum1, 0.5));
      if (fit < COUNTRY_MIN_PX) continue;
      const fontPx = Math.floor(fit);
      const px2 = second ? Math.max(COUNTRY_MIN_PX - 1, Math.round(fontPx * 0.45)) : 0;
      // 两行时第一行往上挪半行
      const l1 = layoutAlong(first, w1, offsetLine(pts, second ? -(px2 * 0.55 + 1) : 0), fontPx, fontPx * 1.8);
      if (!l1) continue;
      const font1 = `600 ${fontPx}px ${COUNTRY_FONT}`;
      const items: PlacedLabel[] = [
        { key: c.key, chars: first, widths: w1.map((x) => x * fontPx), spacing: 0, total: l1.total, font: font1, color, x: 0, y: 0, angle: 0, glyphs: l1.glyphs, halo: COUNTRY_HALO, haloWidth: Math.max(2, fontPx * 0.12) },
      ];
      const marks = l1.glyphs.map((g) => ({ x: g.x, y: g.y, r: fontPx * 0.55 }));
      if (second) {
        const font2 = `500 ${px2}px ${COUNTRY_FONT}`;
        const l2 = layoutAlong(second, w2, offsetLine(pts, fontPx * 0.55 + 1), px2, px2 * 1.2);
        if (l2) {
          items.push({ key: c.key, chars: second, widths: w2.map((x) => x * px2), spacing: 0, total: l2.total, font: font2, color, x: 0, y: 0, angle: 0, glyphs: l2.glyphs, halo: COUNTRY_HALO, haloWidth: 2 });
          for (const g of l2.glyphs) marks.push({ x: g.x, y: g.y, r: px2 * 0.55 });
        }
      }
      const own = marks.map((g) => ({ key: c.key, x0: g.x - g.r, y0: g.y - g.r, x1: g.x + g.r, y1: g.y + g.r }));
      if (own.some((b) => boxes.some((o) => o.x0 < b.x1 && o.x1 > b.x0 && o.y0 < b.y1 && o.y1 > b.y0))) continue;
      boxes.push(...own);
      placed.push(...items);
    }
  }
}


// 版面的键里除了镜头位置的部分（移动中沿用排好的版面时比它）：投影的朝向变了（转动球）要重排
function labelBase(cw: number, chh: number, st: OverlayState, cam: Camera): string {
  const p = cam.proj;
  return `${cw}|${chh}|${st.kmPerUnit}|${st.labelTypes ? [...st.labelTypes].join(',') : '*'}|${st.hoverLabel ?? ''}|${st.nameMode ?? 'zh'}|${st.settleNames === false ? 0 : 1}|${st.cellSize ?? 0}${p ? `|${p.kind}|${p.lon0}|${p.lat0}` : ''}`;
}


// 每个字的宽度按字体缓存：平移、缩放的每一帧不必再量（字体加载完成后清空重量）
const glyphs = new Map<string, number>();

function glyphWidth(ctx: CanvasRenderingContext2D, font: string, c: string): number {
  const key = `${font}|${c}`;
  let w = glyphs.get(key);
  if (w === undefined) {
    w = ctx.measureText(c).width;
    glyphs.set(key, w);
  }
  return w;
}


// 哪些地名标出来、放在哪里（按布局缓存；导出给测试用）
export function placeLabelsRef(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): { placed: PlacedLabel[]; boxes: LabelBox[]; marks: [number, number][] } {
  const { cw, ch: chh } = frameOf(ctx, st);
  const exporting = !!st.frame;
  const base = labelBase(cw, chh, st, cam);
  const key = `${cam.x}|${cam.y}|${cam.zoom}|${ks.join(',')}|${base}|${st.motion ? 'm' : ''}`;
  const peaks = st.peaks ?? null;
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
  // 国名最先排（第二十三轮）
  if (st.countries?.length) placeCountries(ctx, st, ks, toScreen, { cw, ch: chh, mx, my, exporting }, placed, boxes);
  // 城市、地标、自定义点（第二十四轮）：国名之后
  if (st.settlements?.length) placeSettlements(ctx, st, ks, toScreen, (x, y) => (proj ? cam.zoom * trueScale(proj, x, y) : cam.zoom), { cw, ch: chh, mx, my, exporting }, placed, boxes);
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
    const font = `${style.italic ? 'italic ' : ''}${f.type === 'continent' || f.type === 'ocean' ? 600 : 500} ${fontPx}px system-ui, "PingFang SC", sans-serif`;
    ctx.font = font;
    const label = nameText(f.name, f.orig, st.nameMode);
    const text = f.type === 'peak' ? `▲ ${label}` : f.type === 'spot' ? `• ${label}` : label;
    const chars = [...text];
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
      if (boxes.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
      boxes.push(box);
      placed.push({ key: f.key, chars, widths, spacing, total, font, color: f.custom && !isPeak ? '#7a1f5c' : style.color, x: sx, y: sy, angle });
      if (isPeak) named.add(f);
    }
  }
  // 没标名字的山峰：画一个小三角（与已标的地名、别的三角隔开 PEAK_GAP 像素以上才画，高的先画）
  const marks: [number, number][] = [];
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
      if (near(x, y) || boxes.some((b) => b.x0 < x + 4 && b.x1 > x - 4 && b.y0 < y + 4 && b.y1 > y - 4)) continue;
      marks.push([x, y]);
      const g = `${Math.floor(x / PEAK_GAP)},${Math.floor(y / PEAK_GAP)}`;
      grid.set(g, [...(grid.get(g) ?? []), [x, y]]);
    }
  }
  // 点击命中只给真的地名（山峰不是地物，点了没有可改的名字；国名也不是地物）
  const hits = pseudo.size || st.countries?.length || st.settlements?.length ? boxes.filter((b) => !b.key.startsWith(PEAK_KEY) && !b.key.startsWith(COUNTRY_KEY) && !b.key.startsWith(REGION_KEY) && !b.key.startsWith(SETTLE_KEY)) : boxes;
  const out = { key, base, cam: { ...cam }, features: st.features, peaks, countries: st.countries ?? null, settlements: st.settlements ?? null, placed, boxes: hits, marks, epoch: st.motion ? st.motionEpoch : undefined };
  return out;
}


const PEAK_NAME_ZOOM = 1600;
const PEAK_GAP = 14;

// 按格子分的框：只查附近的几格
class BoxIndex {
  private cells = new Map<number, Box[]>();
  constructor(private size = 48) {}
  private *keys(b: Box) {
    const s = this.size;
    for (let gx = Math.floor(b.x0 / s); gx <= Math.floor(b.x1 / s); gx++) for (let gy = Math.floor(b.y0 / s); gy <= Math.floor(b.y1 / s); gy++) yield gx * 100003 + gy;
  }
  add(b: Box) {
    for (const k of this.keys(b)) {
      const l = this.cells.get(k);
      if (l) l.push(b);
      else this.cells.set(k, [b]);
    }
  }
  hits(b: Box): boolean {
    for (const k of this.keys(b)) for (const o of this.cells.get(k) ?? []) if (o.x0 < b.x1 && o.x1 > b.x0 && o.y0 < b.y1 && o.y1 > b.y0) return true;
    return false;
  }
}

