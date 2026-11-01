import type { World } from '../../core/world';
import type { Shape } from './overlay-base';
import type { MapStyle } from '../../core/map-style';
import { circle as geoCircle } from '../../core/geo';
import { riverDraw, type RiverDraw } from '../../core/river-pack';
import { addRiverPaint, newPaint, riverTypeColor, strokeRiverPaint } from './overlay-rivers';
import type { RiverLine } from '../../core/rivers';
import type { RiverStyle } from '../../core/river-types';

// 工具预览的矢量图形（第四十一轮从 overlay.ts 原样搬来）

// unit：一个屏幕像素合多少地图单位；river：地图上的河现在的宽度系数与颜色（river 图形照它画）
export function drawShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, unit: number, river: { scale: number; color: string }, style: MapStyle) {
  if (sh.kind === 'river') {
    drawRiverShape(ctx, world, sh, unit, river, style);
    return;
  }
  const color = sh.color ?? 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = (sh.width ?? 1.5) * unit;
  ctx.setLineDash(sh.dashed ? [6 * unit, 4 * unit] : []);
  const { mesh } = world;
  if (sh.kind === 'circle' && sh.geodesic && mesh.kind === 'sphere' && sh.x !== undefined && sh.y !== undefined && sh.r !== undefined) {
    const { pts, pole } = geoCircle(sh.x, sh.y, sh.r);
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    // 包住极点的圆在平铺图上是一条横贯的曲线：不闭合
    if (!pole) ctx.closePath();
    if (sh.fill && !pole) ctx.fill();
    ctx.stroke();
  } else if (sh.kind === 'circle' && sh.x !== undefined && sh.y !== undefined && sh.r !== undefined) {
    ctx.beginPath();
    ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
    if (sh.fill) ctx.fill();
    ctx.stroke();
  } else if ((sh.kind === 'line' || sh.kind === 'arrow') && sh.points && sh.points.length > 1) {
    ctx.beginPath();
    sh.points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    if (sh.kind === 'arrow') {
      const [x1, y1] = sh.points[sh.points.length - 1];
      const [x0, y0] = sh.points[sh.points.length - 2];
      const a = Math.atan2(y1 - y0, x1 - x0);
      const hs = 12 * unit;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - hs * Math.cos(a - 0.4), y1 - hs * Math.sin(a - 0.4));
      ctx.lineTo(x1 - hs * Math.cos(a + 0.4), y1 - hs * Math.sin(a + 0.4));
      ctx.fill();
    }
  } else if (sh.kind === 'cells' && sh.cells && sh.cells.length > 1) {
    ctx.beginPath();
    // 整个星球：沿线展开经度
    let px = 0;
    sh.cells.forEach((c, k) => {
      const x = mesh.kind === 'sphere' && k > 0 ? px + (mesh.x[c] - px - 2 * Math.round((mesh.x[c] - px) / 2)) : mesh.x[c];
      px = x;
      if (k === 0) ctx.moveTo(x, mesh.y[c]);
      else ctx.lineTo(x, mesh.y[c]);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// 预览的河：与地图上的河同一套画法（带子、宽度、颜色，见 riverDraw）。带子按图形的点数组缓存（光、预览的图形沿用同一个数组时不重算）
export const shapeDraws = new WeakMap<object, { key: string; d: RiverDraw }>();
export function drawRiverShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, unit: number, river: { scale: number; color: string }, style: MapStyle) {
  const pts = sh.points;
  const flow = sh.flow;
  if (!pts || !flow || pts.length < 2) return;
  ctx.setLineDash([]);
  const rt = sh.riverType;
  const color = sh.color ?? (rt ? riverTypeColor(rt, style) : river.color);
  const thr = world.small.planet.riverThreshold;
  const key = `${thr}|${world.mesh.spacing}|${rt?.width ?? 1}|${sh.head ?? ''}|${sh.mouth ? 1 : 0}`;
  let hit = shapeDraws.get(pts);
  if (!hit || hit.key !== key || hit.d.rb.x.length === 0) {
    const line: RiverLine = { points: pts, flow, ...(sh.mul ? { mul: sh.mul } : {}), ...(sh.head ? { head: sh.head } : {}), ...(sh.mouth ? { mouth: true } : {}) };
    hit = { key, d: riverDraw(line, thr, world.mesh.spacing, rt ? [rt] : null, 1) };
    if (rt) hit.d = { rb: hit.d.rb, type: new Uint8Array(pts.length).fill(1) };
    shapeDraws.set(pts, hit);
  }
  const d = hit.d;
  // 整个星球：按起点挪到 [0, 2) 里那一份（调用方按每份副本挪好了变换）
  const shift = world.mesh.kind === 'sphere' ? 2 * Math.floor(pts[0][0] / 2) : 0;
  const paint = newPaint();
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const colorOf = (t: number) => (t > 0 && rt ? { color, style: rt.style ?? 'solid' } : { color, style: 'solid' as RiverStyle });
  ctx.save();
  if (shift) ctx.transform(1, 0, 0, 1, -shift, 0);
  addRiverPaint(paint, d, river.scale * unit, unit, river.scale, null, false, colorOf);
  strokeRiverPaint(ctx, paint, unit, style, dpr);
  ctx.restore();
  if (!sh.arrow) return;
  // 河口的小箭头：比河稍宽，顺着最后一段
  const rb = d.rb;
  const n = rb.x.length;
  const [x1, y1] = [rb.x[n - 1] - shift, rb.y[n - 1]];
  const back = Math.max(0, n - 4);
  const [x0, y0] = [rb.x[back] - shift, rb.y[back]];
  const w = 2 * rb.hw[n - 1] * river.scale;
  const hs = Math.max(8, w * 2.4) * unit;
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 + Math.cos(a) * hs * 0.5, y1 + Math.sin(a) * hs * 0.5);
  ctx.lineTo(x1 - hs * Math.cos(a - 0.45), y1 - hs * Math.sin(a - 0.45));
  ctx.lineTo(x1 - hs * Math.cos(a + 0.45), y1 - hs * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

