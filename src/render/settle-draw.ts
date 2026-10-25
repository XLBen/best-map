import {
  Anchor,
  BrickWall,
  Castle,
  Church,
  Columns3,
  Dam,
  Flag,
  Flame,
  Gem,
  Globe,
  GraduationCap,
  Landmark,
  Lighthouse,
  type LucideIcon,
  MapPin,
  Mountain,
  Pickaxe,
  Pyramid,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Swords,
  Tent,
  Tombstone,
  TreePalm,
  Trophy,
  WandSparkles,
  WavesArrowDown,
  WavesVertical,
} from 'lucide-preact';

// 城市、道路、地标、自定义点在地图上的画法（第二十四轮）：图标（像 EU4 的胜利点——首都是星、大城市双圈、城市大圆、村镇一个点；
// 地标、自定义点是小圆牌上的图标）、名字的排版（与国名、地名一起避让），道路的折线。屏幕与导出整张地图共用；
// 哪些画、多大由界面给（ui/settlements.ts 的 settleMarks、roadDraw），这里只管画

// 一个要画的点：城市、地标或自定义点。x、y 是地图坐标；iconPx / namePx：一格在屏幕上至少这么多像素才画图标、写名字
export interface SettleMark {
  key: string;
  kind: 'city' | 'landmark' | 'point';
  x: number;
  y: number;
  // 城市：star / double-ring / circle / dot；地标、点：图标的名字（LANDMARK_ICONS、POINT_ICONS 里的键）
  icon: string;
  color?: string;
  // 点的类型上传的小图（data: 地址）
  image?: string;
  // 陪都：空心的星
  hollow?: boolean;
  // 名字（已按中文 / 原文 / 两者写好；空着不写名字）
  name: string;
  fontPx: number;
  bold?: boolean;
  textColor: string;
  iconPx: number;
  namePx: number;
  // 首都、陪都：和别的图标挤在一起时照样画
  always?: boolean;
}

// 道路：大道、小路各一组折线（地图坐标，已平滑；星球上沿路展开，x 可能超出 [0, 2)）。minorPx：一格至少这么多像素才画小路
// majorRaw / minorRaw：没平滑的格心折线（缩小时画它，点少四倍）。clear：“道路”工具开着时的清楚的样子（第二十五轮）
export interface RoadDraw {
  major: [number, number][][];
  minor: [number, number][][];
  majorRaw: [number, number][][];
  minorRaw: [number, number][][];
  minorPx: number;
  clear?: boolean;
}

// 清楚的样子（第二十四轮，现在只在“道路”工具里）：大道是浅色的衬边上一道深色的线，小路是深色的细虚线
export const ROAD_COLOR = { realistic: 'rgba(84, 38, 22, 0.92)', atlas: 'rgba(120, 36, 24, 0.92)' };
export const ROAD_CASING = 'rgba(255, 248, 230, 0.6)';
export const ROAD_MINOR_COLOR = { realistic: 'rgba(70, 36, 22, 0.8)', atlas: 'rgba(110, 34, 22, 0.8)' };
// 线宽、虚线（屏幕像素）
export const ROAD_WIDTH = { major: 1.6, casing: 3.4, minor: 1.1 };
export const ROAD_DASH: [number, number] = [3.2, 2.6];
// 平时（第二十五轮）：细、半透明、偏暗的中性色，没有衬边
export const QUIET_ROAD_COLOR = { realistic: 'rgba(52, 44, 38, 0.45)', atlas: 'rgba(84, 46, 34, 0.45)' };
export const QUIET_ROAD_MINOR_COLOR = { realistic: 'rgba(52, 44, 38, 0.3)', atlas: 'rgba(84, 46, 34, 0.3)' };
export const QUIET_ROAD_WIDTH = { major: 0.9, minor: 0.6 };
export const QUIET_ROAD_DASH: [number, number] = [2.4, 2.2];

// 一组道路的画法：颜色、线宽、衬边（null 没有）、虚线（屏幕像素）
export interface RoadStyle {
  major: { color: string; width: number; casing: { color: string; width: number } | null };
  minor: { color: string; width: number; dash: [number, number] };
}
export function roadStyle(r: Pick<RoadDraw, 'clear'>, style: 'realistic' | 'atlas'): RoadStyle {
  if (r.clear)
    return {
      major: { color: ROAD_COLOR[style], width: ROAD_WIDTH.major, casing: { color: ROAD_CASING, width: ROAD_WIDTH.casing } },
      minor: { color: ROAD_MINOR_COLOR[style], width: ROAD_WIDTH.minor, dash: ROAD_DASH },
    };
  return {
    major: { color: QUIET_ROAD_COLOR[style], width: QUIET_ROAD_WIDTH.major, casing: null },
    minor: { color: QUIET_ROAD_MINOR_COLOR[style], width: QUIET_ROAD_WIDTH.minor, dash: QUIET_ROAD_DASH },
  };
}

// ---------- 图标 ----------

// 地标类型的图标（landmarkType 的 icon）→ lucide 的图标
export const LANDMARK_ICONS: Record<string, LucideIcon> = {
  peak: Mountain,
  volcano: Flame,
  waterfall: WavesVertical,
  canyon: WavesArrowDown,
  oasis: TreePalm,
  temple: Landmark,
  pyramid: Pyramid,
  wall: BrickWall,
  tomb: Tombstone,
  castle: Castle,
  monastery: Church,
  lighthouse: Lighthouse,
  shrine: Sparkles,
  university: GraduationCap,
  monument: Trophy,
  dam: Dam,
  tower: WandSparkles,
  spaceport: Rocket,
  dome: Globe,
  ruins: Columns3,
};
// 自定义点的类型的图标（pointType 的 icon）
export const POINT_ICONS: Record<string, LucideIcon> = {
  pin: MapPin,
  'star-outline': Star,
  fort: Shield,
  swords: Swords,
  anchor: Anchor,
  pick: Pickaxe,
  shrine: Sparkles,
  tent: Tent,
  chest: Gem,
  flag: Flag,
};
// 城市等级的图标（cityRank 的 icon）
export const CITY_ICONS = ['star', 'double-ring', 'circle', 'dot'] as const;
export type CityIcon = (typeof CITY_ICONS)[number];
// 城市图标的半径（屏幕像素）
export const CITY_ICON_R: Record<CityIcon, number> = { star: 7.5, 'double-ring': 5.6, circle: 4.3, dot: 2.3 };
// 地标、点的小圆牌的半径
export const BADGE_R = 7.5;

export const iconOf = (key: string): LucideIcon | undefined => LANDMARK_ICONS[key] ?? POINT_ICONS[key];

// lucide 图标的图形（24 × 24，描边）：组件的 props 里带着
type IconNode = [string, Record<string, string | number>][];
function iconNode(C: LucideIcon): IconNode {
  const v = (C as unknown as (p: object) => { props: { icon?: { node?: IconNode } } })({});
  return v?.props?.icon?.node ?? [];
}

// 图标的每一部分写成 SVG 的 path（circle、rect、line、polyline、polygon、ellipse 换成 path）
export function iconPathData(C: LucideIcon): string[] {
  const n = (v: unknown) => Number(v ?? 0);
  const out: string[] = [];
  for (const [tag, a] of iconNode(C)) {
    if (tag === 'path') out.push(String(a.d));
    else if (tag === 'circle' || tag === 'ellipse') {
      const cx = n(a.cx);
      const cy = n(a.cy);
      const rx = tag === 'circle' ? n(a.r) : n(a.rx);
      const ry = tag === 'circle' ? n(a.r) : n(a.ry);
      out.push(`M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`);
    } else if (tag === 'rect') {
      const x = n(a.x);
      const y = n(a.y);
      const w = n(a.width);
      const h = n(a.height);
      const r = Math.min(n(a.rx ?? a.ry), w / 2, h / 2);
      out.push(
        r > 0
          ? `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`
          : `M${x} ${y}h${w}v${h}h${-w}z`,
      );
    } else if (tag === 'line') out.push(`M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`);
    else if (tag === 'polyline' || tag === 'polygon') {
      const pts = String(a.points ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      let d = '';
      for (let k = 0; k + 1 < pts.length; k += 2) d += `${k ? 'L' : 'M'}${pts[k]} ${pts[k + 1]}`;
      if (tag === 'polygon') d += 'z';
      if (d) out.push(d);
    }
  }
  return out;
}

const pathCache = new Map<string, Path2D[]>();
function iconPaths(key: string): Path2D[] | null {
  let p = pathCache.get(key);
  if (p) return p;
  const C = iconOf(key);
  if (!C || typeof Path2D === 'undefined') return null;
  p = iconPathData(C).map((d) => new Path2D(d));
  pathCache.set(key, p);
  return p;
}

// 上传的小图：解码好了才画（解码完通知地图重画）
const images = new Map<string, HTMLImageElement>();
let onImage: (() => void) | null = null;
export function onSettleImageLoad(f: (() => void) | null) {
  onImage = f;
}
function imageOf(src: string): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onImage?.();
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

const STAR = Array.from({ length: 10 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / 5;
  const r = k % 2 ? 0.46 : 1;
  return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
});
const INK = 'rgba(28, 24, 22, 0.92)';
const HALO = 'rgba(255, 255, 255, 0.85)';
const GOLD = '#f2c94c';
const PAPER = '#fbf8f1';

// 缩得很小时图标也小一些（一格在屏幕上的像素数）
export const iconScale = (cellPx: number) => (cellPx < 2 ? 0.7 : cellPx < 4 ? 0.85 : 1);

// 图标在屏幕上的半径（避让、命中用）
export function markRadius(m: Pick<SettleMark, 'kind' | 'icon'>, scale = 1): number {
  if (m.kind === 'city') return CITY_ICON_R[(CITY_ICONS as readonly string[]).includes(m.icon) ? (m.icon as CityIcon) : 'circle'] * scale;
  return BADGE_R * scale;
}

// 图标画好一次存成小图（按样子、大小缓存），每帧只贴图：几百个图标每帧重画圆、星、图标的线要好几毫秒
const SPRITE_RES = 2;
const sprites = new Map<string, HTMLCanvasElement | null>();
function spriteOf(m: SettleMark, scale: number): { c: HTMLCanvasElement; half: number } | null {
  if (typeof document === 'undefined') return null;
  // 上传的小图还没解码好：先不缓存
  if (m.image && !imageOf(m.image)) return null;
  const key = `${m.kind}|${m.icon}|${m.color ?? ''}|${m.image ?? ''}|${m.hollow ? 1 : 0}|${scale}`;
  const half = Math.ceil(markRadius(m, scale) + 3);
  let c = sprites.get(key);
  if (c === undefined) {
    c = document.createElement('canvas');
    c.width = c.height = half * 2 * SPRITE_RES;
    const g = c.getContext('2d');
    if (g) {
      g.scale(SPRITE_RES, SPRITE_RES);
      drawMarkVector(g, m, half, half, scale);
    } else c = null;
    sprites.set(key, c);
  }
  return c ? { c, half } : null;
}

// 在屏幕上（CSS 像素的坐标系里）画一个点的图标；scale：缩得很小时小一些。exact：直接画（导出的大图，按它的分辨率）
export function drawMark(ctx: CanvasRenderingContext2D, m: SettleMark, sx: number, sy: number, scale = 1, exact = false) {
  const sp = exact ? null : spriteOf(m, scale);
  if (sp) {
    ctx.drawImage(sp.c, sx - sp.half, sy - sp.half, sp.half * 2, sp.half * 2);
    return;
  }
  drawMarkVector(ctx, m, sx, sy, scale);
}

function drawMarkVector(ctx: CanvasRenderingContext2D, m: SettleMark, sx: number, sy: number, scale = 1) {
  ctx.save();
  if (scale !== 1) {
    ctx.translate(sx, sy);
    ctx.scale(scale, scale);
    sx = 0;
    sy = 0;
  }
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (m.kind === 'city') drawCityIcon(ctx, (CITY_ICONS as readonly string[]).includes(m.icon) ? (m.icon as CityIcon) : 'circle', sx, sy, !!m.hollow);
  else drawBadge(ctx, m, sx, sy);
  ctx.restore();
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string, lw: number, halo = true) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (halo) {
    ctx.strokeStyle = HALO;
    ctx.lineWidth = lw + 2.4;
    ctx.stroke();
  }
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

function drawCityIcon(ctx: CanvasRenderingContext2D, icon: CityIcon, x: number, y: number, hollow: boolean) {
  const r = CITY_ICON_R[icon];
  if (icon === 'star') {
    ctx.beginPath();
    STAR.forEach(([a, b], k) => (k === 0 ? ctx.moveTo(x + a * r, y + b * r) : ctx.lineTo(x + a * r, y + b * r)));
    ctx.closePath();
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 3.6;
    ctx.stroke();
    ctx.fillStyle = hollow ? PAPER : GOLD;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    return;
  }
  if (icon === 'double-ring') {
    disc(ctx, x, y, r, PAPER, INK, 1.4);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    return;
  }
  if (icon === 'circle') {
    disc(ctx, x, y, r, PAPER, INK, 1.35);
    return;
  }
  disc(ctx, x, y, r, INK, HALO, 1, false);
}

// 地标、自定义点：小圆牌上画图标（地标白底、点用类型的颜色）；有上传的小图时画小图
function drawBadge(ctx: CanvasRenderingContext2D, m: SettleMark, x: number, y: number) {
  const r = BADGE_R;
  const img = m.image ? imageOf(m.image) : null;
  if (img) {
    const s = r * 2.3;
    ctx.beginPath();
    ctx.arc(x, y, s / 2 + 1, 0, Math.PI * 2);
    ctx.fillStyle = HALO;
    ctx.fill();
    ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
    return;
  }
  const point = m.kind === 'point';
  const tone = m.color ?? (point ? '#d94a3d' : '#5b4636');
  disc(ctx, x, y, r, point ? tone : PAPER, point ? INK : tone, point ? 1 : 1.3);
  const paths = iconPaths(m.icon) ?? iconPaths(point ? 'pin' : 'peak');
  if (!paths) return;
  const s = (r * 1.45) / 24;
  ctx.translate(x - 12 * s, y - 12 * s);
  ctx.scale(s, s);
  ctx.strokeStyle = point ? '#ffffff' : tone;
  ctx.lineWidth = 2.3;
  for (const p of paths) ctx.stroke(p);
}

// ---------- 道路 ----------

// 道路按所在的一块分组连成 Path2D（地图坐标）：只画看得见的几块（几万段折线每帧整个描一遍要好几毫秒）
interface RoadChunk {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  path: Path2D;
}
const CHUNK_COLS = 48;
const CHUNK_ROWS = 24;
function chunksOf(lines: [number, number][][]): RoadChunk[] {
  if (!lines.length) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const l of lines) for (const [x, y] of l) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bins = new Map<number, { x0: number; y0: number; x1: number; y1: number; lines: [number, number][][] }>();
  for (const l of lines) {
    let a = Infinity;
    let b = -Infinity;
    let c = Infinity;
    let d = -Infinity;
    for (const [x, y] of l) {
      if (x < a) a = x;
      if (x > b) b = x;
      if (y < c) c = y;
      if (y > d) d = y;
    }
    const gx = Math.min(CHUNK_COLS - 1, Math.floor((((a + b) / 2 - minX) / Math.max(1e-9, maxX - minX)) * CHUNK_COLS));
    const gy = Math.min(CHUNK_ROWS - 1, Math.floor((((c + d) / 2 - minY) / Math.max(1e-9, maxY - minY)) * CHUNK_ROWS));
    const k = gy * CHUNK_COLS + gx;
    const bin = bins.get(k);
    if (bin) {
      bin.x0 = Math.min(bin.x0, a);
      bin.x1 = Math.max(bin.x1, b);
      bin.y0 = Math.min(bin.y0, c);
      bin.y1 = Math.max(bin.y1, d);
      bin.lines.push(l);
    } else bins.set(k, { x0: a, x1: b, y0: c, y1: d, lines: [l] });
  }
  return [...bins.values()].map((b) => {
    const path = new Path2D();
    for (const l of b.lines) l.forEach(([x, y], k) => (k === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
    return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, path };
  });
}
const chunkCache = new WeakMap<object, RoadChunk[]>();
function chunks(lines: [number, number][][]): RoadChunk[] | null {
  if (typeof Path2D === 'undefined') return null;
  let c = chunkCache.get(lines);
  if (!c) chunkCache.set(lines, (c = chunksOf(lines)));
  return c;
}

// 缩小时（一格不到这么多像素）画没平滑的折线、大道不画衬边
export const ROAD_SMOOTH_PX = 3;

// 在等距圆柱的叠加层上画道路：setT(k) 换到第 k 份副本（地图单位 → 设备像素），unit 是一个 CSS 像素在地图单位里多长 × dpr。
// cellPx：一格在屏幕上多少像素（小路放大到 minorPx 才画）；view：画面在地图上的范围（第 0 份），只画碰到它的几块
export function drawRoads(
  ctx: CanvasRenderingContext2D,
  r: RoadDraw,
  ks: number[],
  setT: (k: number) => void,
  unit: number,
  cellPx: number,
  style: 'realistic' | 'atlas',
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const smooth = cellPx >= ROAD_SMOOTH_PX;
  const major = chunks(smooth ? r.major : r.majorRaw);
  const minor = cellPx >= r.minorPx && r.minor.length > 0 ? chunks(r.minor) : null;
  if (!major) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pad = 4 * unit;
  const each = (list: RoadChunk[], k: number, f: (p: Path2D) => void) => {
    for (const c of list) if (c.x1 + 2 * k >= view.x0 - pad && c.x0 + 2 * k <= view.x1 + pad && c.y1 >= view.y0 - pad && c.y0 <= view.y1 + pad) f(c.path);
  };
  const rs = roadStyle(r, style);
  for (const k of ks) {
    setT(k);
    if (minor) {
      ctx.strokeStyle = rs.minor.color;
      ctx.lineWidth = rs.minor.width * unit;
      ctx.setLineDash([rs.minor.dash[0] * unit, rs.minor.dash[1] * unit]);
      each(minor, k, (p) => ctx.stroke(p));
    }
    ctx.setLineDash([]);
    if (smooth && rs.major.casing) {
      ctx.strokeStyle = rs.major.casing.color;
      ctx.lineWidth = rs.major.casing.width * unit;
      each(major, k, (p) => ctx.stroke(p));
    }
    ctx.strokeStyle = rs.major.color;
    ctx.lineWidth = rs.major.width * unit;
    each(major, k, (p) => ctx.stroke(p));
  }
  ctx.restore();
}

// ---------- 排版（与国名、地名一起避让） ----------

// 屏幕上的框（CSS 像素）
export interface Box {
  key: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// 按格子分的框：只查附近的几格
export class BoxIndex {
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

// 名字放在图标的右、左、上、下（先右边）
export function nameSpots(sx: number, sy: number, r: number, w: number, h: number): [number, number][] {
  const gap = 3;
  return [
    [sx + r + gap + w / 2, sy],
    [sx - r - gap - w / 2, sy],
    [sx, sy - r - gap - h / 2],
    [sx, sy + r + gap + h / 2],
  ];
}
