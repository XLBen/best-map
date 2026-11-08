import type { FeatureType } from '../../core/features';
import { type Anchor, glyphs, glyphWidth, type LabelBox, type PlacedLabel } from './overlay-base';
import { layoutAlong, offsetLine, smoothPath } from './overlay-country-labels';
import type { BoxIndex } from './settle-draw';

// 地名的排版（第八十九轮）：字号分档、候选位置、沿着水弯着写。overlay-labels.ts 的 placeLabels 按先后（等级高的先放）逐个调这里，
// 每个地名试几个候选位置，取第一个不压别的字、不压图标的；都不行时不写。全是确定的（同样的输入排出同样的结果）

// ---------- 字号分档 ----------

// base：屏幕上刚够标出来时的字号；max：最大的字号；minPx：屏幕上至少多大才标（像素：面积的平方根，河是长度）；
// weight：粗细；gap：沿线写时字距最多几倍字号（0 不沿线写）；rank：排的先后（小的先，见 placeLabels）
export interface LabelTier {
  base: number;
  max: number;
  minPx: number;
  weight: number;
  gap: number;
  rank: number;
}
const T = (base: number, max: number, minPx: number, rank: number, weight = 500, gap = 0): LabelTier => ({ base, max, minPx, weight, gap, rank });
export const FEATURE_TIER: Record<FeatureType, LabelTier> = {
  ocean: T(17, 32, 25, 2, 600, 1.6),
  continent: T(15, 30, 25, 2, 600),
  sea: T(13, 22, 45, 3, 600, 1),
  bay: T(11, 16, 45, 4, 500, 0.6),
  strait: T(10.5, 15, 45, 4, 500, 0.6),
  lake: T(11, 16, 45, 4, 500, 0.6),
  river: T(10, 13, 90, 4, 500, 0.15),
  island: T(11, 18, 45, 4),
  archipelago: T(11, 18, 45, 4),
  peninsula: T(11, 17, 45, 4),
  range: T(11, 18, 45, 4),
  peak: T(10.5, 10.5, 0, 4),
  plateau: T(11, 17, 45, 4),
  plain: T(11, 17, 45, 4),
  basin: T(11, 17, 45, 4),
  desert: T(11, 17, 45, 4),
  forest: T(11, 17, 45, 4),
  tundra: T(11, 17, 45, 4),
  icecap: T(11, 17, 45, 4),
  wetland: T(11, 17, 45, 4),
  biome: T(11, 17, 45, 4),
  region: T(11, 20, 45, 4),
  spot: T(11, 11, 0, 4),
};
// 字号：刚够标时 base，屏幕上每大一倍加 2.6，最多 max
export function tierFontPx(t: LabelTier, sizePx: number): number {
  const grow = t.minPx > 0 ? Math.max(0, Math.log2(Math.max(1, sizePx / t.minPx))) * 2.6 : 0;
  return Math.round(Math.min(t.max, t.base + grow));
}

// 排的先后（小的先）：用户自己的地名 0；首都、自定义点的名字 1；大洋、大陆 2；海、大城市 3；别的地名 4；城市 5；村镇、地标 6；山峰 7
export const RANK_MINE = 0;
export const RANK_PEAK = 7;
export const settleRank = (tier: number | undefined) => [1, 3, 5, 6][Math.max(0, Math.min(3, tier ?? 2))];

// ---------- 放一个地名 ----------

// 排一次地名共用的：投影、画面的大小（四周多排 mx、my）、导出（整个字在图里）、放好的框
export interface Placer {
  ctx: CanvasRenderingContext2D;
  toScreen: (x: number, y: number) => [number, number] | null;
  cw: number;
  ch: number;
  mx: number;
  my: number;
  exporting: boolean;
  // 投影时记下锚点（转球的手势里按它挪）
  proj: boolean;
  index: BoxIndex;
  boxes: LabelBox[];
  placed: PlacedLabel[];
}

// 一串字：每个字、字宽（按这个字号）、整串的宽（含字距）
export interface Text {
  chars: string[];
  widths: number[];
  spacing: number;
  total: number;
  font: string;
  fontPx: number;
  color: string;
}
export function measureText(ctx: CanvasRenderingContext2D, text: string, font: string, fontPx: number, spacing: number, color: string): Text {
  const chars = [...text];
  // 只在要量字（字宽缓存里没有）时设字体
  if (chars.some((c) => !glyphs.has(`${font}|${c}`))) ctx.font = font;
  const widths = chars.map((c) => glyphWidth(ctx, font, c));
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  return { chars, widths, spacing, total, font, fontPx, color };
}

// 横着（或斜着）写的候选：按字的方向，cands 里每一项是 [沿字的方向挪几倍字宽, 往法线方向挪几倍字高]
export const AREA_CANDS: readonly [number, number][] = [
  [0, 0],
  [0, -1.15],
  [0, 1.15],
  [-0.3, 0],
  [0.3, 0],
  [0, -2.3],
  [0, 2.3],
];
export const POINT_CANDS: readonly [number, number][] = [[0, 0]];

// 横着（或斜着）写：中心 (x0, y0)（屏幕），按候选依次试；放下了返回 true。anchor：投影时的锚点（地图坐标与那时它在屏幕上的位置）
export function placeStraight(p: Placer, key: string, t: Text, x0: number, y0: number, angle: number, cands: readonly [number, number][], anchor?: Anchor): boolean {
  const { cw, ch } = p;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hw = (Math.abs(c) * t.total + Math.abs(s) * t.fontPx) / 2 + 3;
  const hh = (Math.abs(s) * t.total + Math.abs(c) * t.fontPx) / 2 + 2;
  // 导出整张地图：比图还大的不标
  if (p.exporting && (2 * hw > cw || 2 * hh > ch)) return false;
  for (const [u, v] of cands) {
    let sx = x0 + u * t.total * c - v * t.fontPx * s;
    let sy = y0 + u * t.total * s + v * t.fontPx * c;
    // 导出整张地图：伸出边的往里挪
    if (p.exporting) {
      sx = Math.max(hw, Math.min(cw - hw, sx));
      sy = Math.max(hh, Math.min(ch - hh, sy));
    }
    const box = { key, x0: sx - hw, y0: sy - hh, x1: sx + hw, y1: sy + hh };
    if (p.index.hits(box)) continue;
    p.boxes.push(box);
    p.index.add(box);
    p.placed.push({ key, chars: t.chars, widths: t.widths, spacing: t.spacing, total: t.total, font: t.font, color: t.color, x: sx, y: sy, angle, ...(p.proj && anchor ? { anchor } : {}) });
    return true;
  }
  return false;
}

// 城市、地标的名字放在图标的右、左、上、下，再试四个斜角（先右边）
export function nameSpots8(sx: number, sy: number, r: number, w: number, h: number): [number, number][] {
  const g = 3;
  const dx = r + g + w / 2;
  const dy = r + g + h / 2;
  const kx = (r * 0.7 + g) + w / 2;
  const ky = (r * 0.7 + g) + h / 2;
  return [
    [sx + dx, sy],
    [sx - dx, sy],
    [sx, sy - dy],
    [sx, sy + dy],
    [sx + kx, sy - ky],
    [sx + kx, sy + ky],
    [sx - kx, sy - ky],
    [sx - kx, sy + ky],
  ];
}

// ---------- 沿着线写 ----------

const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// 一串字沿屏幕上的折线 pts 排（居中，字距最多 maxGap，占线长的 span）：字不倒着（|方向| ≤ maxTilt）、相邻两个字转的角不超过 maxTurn、
// 不压别的字和图标时放下，返回 true
function tryAlong(p: Placer, key: string, t: Text, pts: readonly [number, number][], maxGap: number, span: number, maxTilt: number, maxTurn: number): boolean {
  const w1 = t.widths.map((w) => w / t.fontPx);
  const lay = layoutAlong(t.chars, w1, pts, t.fontPx, maxGap, span);
  if (!lay) return false;
  const g = lay.glyphs;
  for (let k = 0; k < g.length; k++) {
    if (Math.abs(g[k].a) > maxTilt) return false;
    if (k && Math.abs(wrapPi(g[k].a - g[k - 1].a)) > maxTurn) return false;
  }
  // 中间那个字要在画面里（四周多排的一圈也算）；导出整张地图时整个字都在图里
  const m = g[Math.floor(g.length / 2)];
  if (m.x < -p.mx || m.y < -p.my || m.x > p.cw + p.mx || m.y > p.ch + p.my) return false;
  const r = t.fontPx * 0.55;
  if (p.exporting && g.some((q) => q.x - r < 0 || q.y - r < 0 || q.x + r > p.cw || q.y + r > p.ch)) return false;
  const own = g.map((q) => ({ key, x0: q.x - r, y0: q.y - r, x1: q.x + r, y1: q.y + r }));
  if (own.some((b) => p.index.hits(b))) return false;
  for (const b of own) {
    p.boxes.push(b);
    p.index.add(b);
  }
  p.placed.push({ key, chars: t.chars, widths: t.widths, spacing: 0, total: lay.total, font: t.font, color: t.color, x: 0, y: 0, angle: 0, glyphs: g });
  return true;
}

// 地图上的折线投到屏幕上（第 k 份副本）；有一点不在投影上时 null。方向改成从左往右（字不倒着）
function screenLine(p: Placer, line: readonly [number, number][], k: number): [number, number][] | null {
  const out: [number, number][] = [];
  for (const [x, y] of line) {
    const q = p.toScreen(x + 2 * k, y);
    if (!q) return null;
    out.push(q);
  }
  if (out[out.length - 1][0] < out[0][0]) out.reverse();
  return out;
}

const lengths = (pts: readonly [number, number][]) => {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  return cum;
};

// 海、洋、湾、海峡、湖的名字沿着水的中线（label-lines.ts 的 waterLine）弯着写，字距拉开：中线上、往两边挪一两行字高各试一次
export function placeWaterCurve(p: Placer, key: string, t: Text, line: readonly [number, number][], k: number, gap: number): boolean {
  const pts = screenLine(p, line, k);
  if (!pts) return false;
  const dense = smoothPath(pts);
  const cum = lengths(dense);
  const L = cum[cum.length - 1];
  if (!(L * 0.8 >= t.total * 1.05)) return false;
  for (const v of [0, -1.25, 1.25, -2.5, 2.5]) {
    if (tryAlong(p, key, t, v ? offsetLine(dense, v * t.fontPx) : dense, gap * t.fontPx, 0.8, 1.25, 0.35)) return true;
  }
  return false;
}

// 一段折线：从 s0 走到 s1
function subLine(pts: readonly [number, number][], cum: readonly number[], s0: number, s1: number): [number, number][] {
  const at = (s: number): [number, number] => {
    let k = 1;
    while (k < pts.length - 1 && cum[k] < s) k++;
    const seg = cum[k] - cum[k - 1] || 1;
    const u = Math.max(0, Math.min(1, (s - cum[k - 1]) / seg));
    return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * u, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * u];
  };
  const out: [number, number][] = [at(s0)];
  for (let k = 0; k < pts.length; k++) if (cum[k] > s0 && cum[k] < s1) out.push(pts[k]);
  out.push(at(s1));
  return out;
}

// 河名沿河道的一段（平滑过的折线，label-lines.ts 的 smoothRiver）写在河的一边：从中段起往两头找几段，每段先试上边再试下边；
// 太弯（相邻两个字转 25° 以上）的段不要
const RIVER_AT = [0.5, 0.38, 0.62, 0.26, 0.74, 0.14, 0.86];
export function placeRiverCurve(p: Placer, key: string, t: Text, line: readonly [number, number][], k: number): boolean {
  const raw: [number, number][] = [];
  for (const [x, y] of line) {
    const q = p.toScreen(x + 2 * k, y);
    if (!q) return false;
    raw.push(q);
  }
  const cum = lengths(raw);
  const L = cum[cum.length - 1];
  const need = t.total * 1.12 + 4;
  if (!(L >= need)) return false;
  const tried = new Set<number>();
  for (const f of RIVER_AT) {
    const c = Math.max(need / 2, Math.min(L - need / 2, f * L));
    const q = Math.round(c / 8);
    if (tried.has(q)) continue;
    tried.add(q);
    const seg = subLine(raw, cum, c - need / 2, c + need / 2);
    if (seg[seg.length - 1][0] < seg[0][0]) seg.reverse();
    for (const side of [-1, 1]) {
      if (tryAlong(p, key, t, offsetLine(seg, side * (t.fontPx * 0.6 + 2)), t.spacing, 1 / 1.12, 1.45, 0.44)) return true;
    }
  }
  return false;
}
