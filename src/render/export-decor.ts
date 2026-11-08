import { handLook, styleRgba, type MapStyle } from '../../core/map-style';
import { drawSymbolIcon } from './overlay-symbols';
import { Sym } from './symbol-place';

// 导出整张地图的装饰（第八十七轮）：罗盘、标题、边框、图例。只画在导出的图上（屏幕上不画），每一样可以单独开关；
// 手绘画风默认都开，别的画风默认都关（画风的 exportDecor，见 defaultDecor）。画在地图、叠加层都画好之后的整张图上

export interface DecorOptions {
  frame: boolean;
  compass: boolean;
  title: boolean;
  legend: boolean;
}
export const DECOR_KEYS = ['frame', 'compass', 'title', 'legend'] as const;
export const DECOR_LABELS: Record<keyof DecorOptions, string> = { frame: '边框', compass: '罗盘', title: '标题', legend: '图例' };
export const NO_DECOR: DecorOptions = { frame: false, compass: false, title: false, legend: false };

// 这个画风导出时默认加哪几样：手绘全开，别的全关
export function defaultDecor(style: MapStyle): DecorOptions {
  const on = handLook(style).exportDecor;
  return { frame: on, compass: on, title: on, legend: on };
}
export const anyDecor = (o: DecorOptions) => DECOR_KEYS.some((k) => o[k]);

// 图例的一行：色块（地图模式的颜色，比如国家），或一种符号
export type LegendRow = { color: string; label: string } | { symbol: 'mountain' | 'hill' | 'forest' | 'conifer' | 'city' | 'road'; label: string };

export interface DecorInfo {
  // 标题（世界的名字）
  title: string;
  style: MapStyle;
  // 图例的标题（地图模式的图例的标题，没有时“图例”）与几行
  legendTitle: string;
  legend: LegendRow[];
}

const rgbOf = (c: string, a = 1) => {
  const v = styleRgba(c) ?? [60, 48, 36, 1];
  return `rgba(${Math.round(v[0])}, ${Math.round(v[1])}, ${Math.round(v[2])}, ${a})`;
};

// 装饰的配色：墨色、纸色（画风写了手绘的颜色就用它，否则按 HAND_OFF 的）
function inks(style: MapStyle) {
  const h = handLook(style);
  return { ink: rgbOf(h.ink), inkSoft: rgbOf(h.ink, 0.55), paper: rgbOf(h.paperColor, 0.94), paperSolid: rgbOf(h.paperColor), accent: rgbOf(style.countryLine) };
}

// 字体：画风的地名字体，没写时用衬线体
const family = (style: MapStyle) => handLook(style).labelFont ?? '"Songti SC", "STSong", serif';

// 画在整张图上（W × H 像素；u 是一个“单位”多少像素，按图的短边定）
export function drawExportDecor(ctx: CanvasRenderingContext2D, W: number, H: number, o: DecorOptions, info: DecorInfo): void {
  if (!anyDecor(o)) return;
  const u = Math.max(1, Math.min(W, H) / 900);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const inset = o.frame ? 22 * u : 0;
  if (o.frame) drawFrame(ctx, W, H, u, info.style);
  if (o.compass) drawCompass(ctx, W - inset - 78 * u, inset + 78 * u, 58 * u, u, info.style);
  if (o.title && info.title) drawTitle(ctx, W / 2, inset + 40 * u, u, info.title, info.style);
  if (o.legend && info.legend.length) drawLegend(ctx, W - inset - 16 * u, H - inset - 16 * u, u, info);
  ctx.restore();
}

// 边框：外面一圈纸色的边、一道粗墨线、里面一道细线，四角各一个小方块
function drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, style: MapStyle) {
  const c = inks(style);
  const m = 12 * u;
  ctx.fillStyle = c.paperSolid;
  ctx.fillRect(0, 0, W, m);
  ctx.fillRect(0, H - m, W, m);
  ctx.fillRect(0, 0, m, H);
  ctx.fillRect(W - m, 0, m, H);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 3 * u;
  ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
  ctx.lineWidth = 1 * u;
  const n = m + 7 * u;
  ctx.strokeRect(n, n, W - 2 * n, H - 2 * n);
  const s = 9 * u;
  for (const [x, y] of [
    [m, m],
    [W - m, m],
    [m, H - m],
    [W - m, H - m],
  ]) {
    ctx.fillStyle = c.paperSolid;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.lineWidth = 1.4 * u;
    ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    ctx.fillStyle = c.ink;
    ctx.fillRect(x - s / 5, y - s / 5, (2 * s) / 5, (2 * s) / 5);
  }
}

// 罗盘：八个尖（四个长的、四个短的），每个尖一半深一半浅，中间一圈，上面写“北”
export function drawCompass(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, u: number, style: MapStyle) {
  const c = inks(style);
  ctx.save();
  ctx.fillStyle = c.paper;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.68, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1.1 * u;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
  ctx.lineWidth = 0.6 * u;
  ctx.stroke();
  // 刻度
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const r0 = R * (k % 4 === 0 ? 0.56 : 0.6);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * R * 0.68, cy + Math.sin(a) * R * 0.68);
    ctx.stroke();
  }
  const point = (a: number, len: number, w: number) => {
    const tip = [cx + Math.sin(a) * len, cy - Math.cos(a) * len];
    const l = [cx + Math.sin(a - Math.PI / 2) * w, cy - Math.cos(a - Math.PI / 2) * w];
    const r = [cx + Math.sin(a + Math.PI / 2) * w, cy - Math.cos(a + Math.PI / 2) * w];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(l[0], l[1]);
    ctx.closePath();
    ctx.fillStyle = c.ink;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(r[0], r[1]);
    ctx.closePath();
    ctx.fillStyle = c.paperSolid;
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 0.9 * u;
    ctx.beginPath();
    ctx.moveTo(l[0], l[1]);
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(r[0], r[1]);
    ctx.stroke();
  };
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, R * 0.55, R * 0.09);
  for (let k = 0; k < 4; k++) point((k * Math.PI) / 2, R, R * 0.13);
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.06, 0, Math.PI * 2);
  ctx.fillStyle = c.paperSolid;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = c.ink;
  ctx.font = `600 ${Math.round(R * 0.32)}px ${family(style)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('北', cx, cy - R * 1.02);
  ctx.restore();
}

// 标题：一条两头带燕尾的飘带，双线描边，里面写世界的名字
function drawTitle(ctx: CanvasRenderingContext2D, cx: number, cy: number, u: number, text: string, style: MapStyle) {
  const c = inks(style);
  const px = Math.round(30 * u);
  ctx.save();
  ctx.font = `600 ${px}px ${family(style)}`;
  const tw = ctx.measureText(text).width + px * 0.3 * Math.max(0, [...text].length - 1);
  const w = tw + 70 * u;
  const h = px * 1.7;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const tail = 24 * u;
  // 两头的燕尾（在后面、低一点）
  for (const side of [-1, 1]) {
    const ex = side < 0 ? x0 + 10 * u : x0 + w - 10 * u;
    const fx = ex + side * (tail + 16 * u);
    ctx.beginPath();
    ctx.moveTo(ex, y0 + 10 * u);
    ctx.lineTo(fx, y0 + 10 * u);
    ctx.lineTo(fx - side * tail * 0.6, y0 + h / 2 + 10 * u);
    ctx.lineTo(fx, y0 + h + 10 * u);
    ctx.lineTo(ex, y0 + h + 10 * u);
    ctx.closePath();
    ctx.fillStyle = c.paperSolid;
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.2 * u;
    ctx.stroke();
  }
  ctx.fillStyle = c.paperSolid;
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 2 * u;
  ctx.strokeRect(x0, y0, w, h);
  ctx.lineWidth = 0.8 * u;
  ctx.strokeRect(x0 + 5 * u, y0 + 5 * u, w - 10 * u, h - 10 * u);
  ctx.fillStyle = c.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // 字距拉开一点
  let x = cx - tw / 2;
  for (const ch of text) {
    ctx.fillText(ch, x, cy + px * 0.04);
    x += ctx.measureText(ch).width + px * 0.3;
  }
  ctx.restore();
}

// 图例：右下角一块纸，标题、几行色块与符号
function drawLegend(ctx: CanvasRenderingContext2D, right: number, bottom: number, u: number, info: DecorInfo) {
  const c = inks(info.style);
  const fam = family(info.style);
  const px = Math.round(13 * u);
  const rowH = px * 1.6;
  const sw = 26 * u;
  ctx.save();
  ctx.font = `500 ${px}px ${fam}`;
  const textW = Math.max(...info.legend.map((r) => ctx.measureText(r.label).width), 40 * u);
  const w = sw + 12 * u + textW + 28 * u;
  const h = 34 * u + rowH * info.legend.length + 10 * u;
  const x0 = right - w;
  const y0 = bottom - h;
  ctx.fillStyle = c.paper;
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1.6 * u;
  ctx.strokeRect(x0, y0, w, h);
  ctx.lineWidth = 0.6 * u;
  ctx.strokeRect(x0 + 4 * u, y0 + 4 * u, w - 8 * u, h - 8 * u);
  ctx.fillStyle = c.ink;
  ctx.font = `600 ${Math.round(px * 1.15)}px ${fam}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(info.legendTitle, x0 + w / 2, y0 + 19 * u);
  ctx.font = `500 ${px}px ${fam}`;
  ctx.textAlign = 'left';
  info.legend.forEach((r, k) => {
    const y = y0 + 34 * u + rowH * (k + 0.5);
    const sx = x0 + 14 * u;
    if ('color' in r) {
      ctx.fillStyle = r.color;
      ctx.fillRect(sx, y - px * 0.4, sw, px * 0.8);
      ctx.strokeStyle = c.inkSoft;
      ctx.lineWidth = 0.8 * u;
      ctx.strokeRect(sx, y - px * 0.4, sw, px * 0.8);
    } else legendSymbol(ctx, r.symbol, sx + sw / 2, y, px * 0.62, u, info.style);
    ctx.fillStyle = c.ink;
    ctx.fillText(r.label, sx + sw + 12 * u, y + px * 0.04);
  });
  ctx.restore();
}

function legendSymbol(ctx: CanvasRenderingContext2D, kind: Extract<LegendRow, { symbol: string }>['symbol'], x: number, y: number, r: number, u: number, style: MapStyle) {
  const c = inks(style);
  if (kind === 'road') {
    ctx.strokeStyle = style.quietRoad;
    ctx.lineWidth = 2.2 * u;
    ctx.beginPath();
    ctx.moveTo(x - r * 1.6, y + r * 0.2);
    ctx.quadraticCurveTo(x, y - r * 0.6, x + r * 1.6, y + r * 0.1);
    ctx.stroke();
    return;
  }
  if (kind === 'city') {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = c.paperSolid;
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4 * u;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = c.ink;
    ctx.fill();
    return;
  }
  const sym = kind === 'mountain' ? Sym.Mountain : kind === 'hill' ? Sym.Hill : kind === 'conifer' ? Sym.Conifer : Sym.Broadleaf;
  drawSymbolIcon(ctx, sym, x, y + r * 0.2, kind === 'forest' || kind === 'conifer' ? r * 1.25 : r * 1.1, style, u);
}
