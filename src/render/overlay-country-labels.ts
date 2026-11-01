import { glyphs, glyphWidth, type LabelBox, type OverlayState, type PlacedLabel } from './overlay-base';
import { BoxIndex } from './settle-draw';

// 国名、片区名：沿中线弯着写（第四十一轮从 overlay.ts 原样搬来）

// ---------- 国名（第二十三轮） ----------

// 一个国名：key（'country:编号'）、一两行字（两者时中文一行、原文一行）、中线（5 个点，地图坐标，从左到右；
// 星球上首尾的 x 可能跨过接缝）、主体的大小（地图单位²，按屏幕上的面积：平铺图上已除以纬度的余弦）
export interface CountryLabelDraw {
  key: string;
  lines: string[];
  path: [number, number][];
  area: number;
}

export const COUNTRY_KEY = 'country:';
// 片区名（第二十五轮：文化、文化组、每一维的取值）与国名同样排、同样不给点击命中
export const REGION_KEY = 'region:';
// 国名的颜色：画风的 countryLabel（第三十八轮）
export const COUNTRY_HALO = 'rgba(255, 255, 255, 0.42)';
export const COUNTRY_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif';
// 国名的字号：不到这么大不标，最大这么大（CSS 像素）
export const COUNTRY_MIN_PX = 10;
export const COUNTRY_MAX_PX = 64;
// 原文（拉丁字母）写成大写
export const LATIN = /^[\x00-ɏ\s'’.-]+$/;

// 过 5 个点的平滑曲线（Catmull-Rom）上每段取 4 个点
export function smoothPath(pts: readonly [number, number][]): [number, number][] {
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
export function along(pts: readonly [number, number][], cum: readonly number[], s: number): { x: number; y: number; a: number } {
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
export function layoutAlong(
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
export function offsetLine(pts: readonly [number, number][], d: number): [number, number][] {
  if (d === 0) return [...pts];
  return pts.map((p, q) => {
    const a = pts[Math.max(0, q - 1)];
    const b = pts[Math.min(pts.length - 1, q + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] - ((b[1] - a[1]) / len) * d, p[1] + ((b[0] - a[0]) / len) * d];
  });
}

// 国名的字：两者时第二行（原文）、写原文时的那一行拉丁字母写成大写
export const countryLineText = (lines: readonly string[]) => lines.map((t, q) => (q > 0 || LATIN.test(t) ? t.toUpperCase() : t));

// 一个国名的中线（展开跨接缝的、平滑过的）与每个字在 1 像素字号时的宽：按国名对象缓存（排版时不再设字体、量字，
// 设一次字体要解析一遍字体名，一百多个国名每次重排都设会慢几十毫秒）
export interface CountryMetrics {
  curve: [number, number][];
  lenU: number;
  first: string[];
  w1: number[];
  second: string[] | null;
  w2: number[];
}
export const metricsCache = new WeakMap<CountryLabelDraw, CountryMetrics>();
export function countryMetrics(ctx: CanvasRenderingContext2D, c: CountryLabelDraw): CountryMetrics {
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
export function placeCountries(
  ctx: CanvasRenderingContext2D,
  st: OverlayState,
  ks: number[],
  toScreen: (x: number, y: number) => [number, number] | null,
  view: { cw: number; ch: number; mx: number; my: number; exporting: boolean },
  placed: PlacedLabel[],
  boxes: LabelBox[],
  index: BoxIndex,
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
      // 第四十轮：按格子查（BoxIndex，与逐个比相同）
      if (own.some((b) => index.hits(b))) continue;
      boxes.push(...own);
      for (const b of own) index.add(b);
      placed.push(...items);
    }
  }
}

