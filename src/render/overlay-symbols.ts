import { handLook, hasSymbols, styleRgba, type MapStyle } from '../../core/map-style';
import type { World } from '../../core/world';
import type { Frame, OverlayState } from './overlay-base';
import type { Camera } from './renderer';
import { Sym, type SymbolSet, symbolLevel, symbolSet, tilesIn } from './symbol-place';

// 手绘画风的符号（第八十七轮）：山、丘陵、森林画在叠加层最底下那一层（overlay.ts 的 drawBack，和河、标记一起缓存：
// 停稳时画进离屏画布，移动中挪用低分辨率的那一张），放在哪里见 symbol-place.ts。每个符号贴一张小图（按种类、大小的档、
// 样子的档、屏幕上的半径记住，同一帧里几十张就够），按块走一遍贴上：几千个符号每帧重描路径、在软件画的画布上光栅化要几百毫秒，
// 贴小图快得多。只画一块地区（整个星球、投影上不画）。
// 另有纸的暗角（drawVignette）：四周暗一点，画在叠加层最底下

// 这个画风在这个世界上画不画符号
export const symbolsOn = (world: World, st: Pick<OverlayState, 'style'>) => world.mesh.kind === 'plane' && hasSymbols(st.style);

// 底层的键里的一项：符号的那一份（世界的推导变了才变）
export const symbolsKey = (world: World, st: Pick<OverlayState, 'style'>): SymbolSet | null => (symbolsOn(world, st) ? symbolSet(world) : null);

// 一个（或几个）符号的路径：山的亮面、暗面、雪、墨线与暗面的排线，树冠（阔叶、针叶、雨林）与树的墨线
interface TilePaths {
  light: Path2D;
  shade: Path2D;
  snow: Path2D;
  ink: Path2D;
  hatch: Path2D;
  leaf: Path2D;
  pine: Path2D;
  jungle: Path2D;
  treeInk: Path2D;
}
const newPaths = (): TilePaths => ({ light: new Path2D(), shade: new Path2D(), snow: new Path2D(), ink: new Path2D(), hatch: new Path2D(), leaf: new Path2D(), pine: new Path2D(), jungle: new Path2D(), treeInk: new Path2D() });

// 山：一个尖顶（顶点略偏），左边亮、右边暗，墨线只描两条坡；大的山顶上一点雪、暗面几道排线。整个画在足迹的圆里
function mountain(p: TilePaths, x: number, y: number, r: number, size: number, u: number) {
  const ax = x + (u - 0.5) * 0.25 * r;
  const ay = y - 0.92 * r;
  const lx = x - 0.88 * r;
  const rx = x + 0.88 * r;
  const by = y + 0.42 * r;
  const mx = x + 0.1 * r + (u - 0.5) * 0.2 * r;
  p.light.moveTo(lx, by);
  p.light.lineTo(ax, ay);
  p.light.lineTo(mx, by);
  p.light.closePath();
  p.shade.moveTo(ax, ay);
  p.shade.lineTo(rx, by);
  p.shade.lineTo(mx, by);
  p.shade.closePath();
  p.ink.moveTo(lx, by);
  p.ink.lineTo(ax, ay);
  p.ink.lineTo(rx, by);
  // 山脊：从顶点往下一段
  p.hatch.moveTo(ax, ay);
  p.hatch.lineTo(ax + 0.55 * (mx - ax), ay + 0.55 * (by - ay));
  // 暗面的排线：与左坡平行的几小段
  const n = size > 0.5 ? 3 : 2;
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    const sx = ax + t * (rx - ax);
    const sy = ay + t * (by - ay);
    const f = 0.32 * (1 - t * 0.5);
    p.hatch.moveTo(sx, sy);
    p.hatch.lineTo(sx - f * (ax - lx) * 0.6, sy + f * (by - ay) * 0.6);
  }
  if (size > 0.45) {
    // 雪：顶点往下约四分之一，底边是一道折线
    const k = 0.26 + 0.08 * size;
    p.snow.moveTo(ax, ay);
    p.snow.lineTo(ax + k * (lx - ax), ay + k * (by - ay));
    p.snow.lineTo(ax + 0.45 * k * (lx - ax) + 0.05 * r, ay + 0.75 * k * (by - ay));
    p.snow.lineTo(ax + 0.5 * k * (mx - ax), ay + 1.1 * k * (by - ay));
    p.snow.lineTo(ax + k * (rx - ax), ay + k * (by - ay));
    p.snow.closePath();
  }
}

// 丘陵：一个圆的小土包，右边一点暗
function hill(p: TilePaths, x: number, y: number, r: number) {
  const b = y + 0.3 * r;
  p.shade.moveTo(x, y - 0.5 * r);
  p.shade.quadraticCurveTo(x + 0.425 * r, y - 0.5 * r, x + 0.85 * r, b);
  p.shade.lineTo(x + 0.2 * r, b);
  p.shade.closePath();
  p.ink.moveTo(x - 0.85 * r, b);
  p.ink.quadraticCurveTo(x, y - 1.3 * r, x + 0.85 * r, b);
}

// 森林：三棵一丛。阔叶、雨林是圆的树冠，针叶是三角
const TREE_AT: readonly [number, number][] = [
  [-0.42, 0.12],
  [0.4, 0.18],
  [0.0, -0.28],
];
function trees(p: TilePaths, x: number, y: number, r: number, kind: Sym, u: number) {
  const t = 0.4 * r;
  for (let k = 0; k < 3; k++) {
    const j = ((u * 7.31 * (k + 1)) % 1) - 0.5;
    const cx = x + (TREE_AT[k][0] + 0.06 * j) * r;
    const cy = y + (TREE_AT[k][1] - 0.04 * j) * r;
    if (kind === Sym.Conifer) {
      p.pine.moveTo(cx, cy - 0.95 * t);
      p.pine.lineTo(cx - 0.5 * t, cy + 0.55 * t);
      p.pine.lineTo(cx + 0.5 * t, cy + 0.55 * t);
      p.pine.closePath();
      p.treeInk.moveTo(cx, cy - 0.95 * t);
      p.treeInk.lineTo(cx - 0.5 * t, cy + 0.55 * t);
      p.treeInk.lineTo(cx + 0.5 * t, cy + 0.55 * t);
      p.treeInk.closePath();
      p.treeInk.moveTo(cx, cy + 0.55 * t);
      p.treeInk.lineTo(cx, cy + 0.82 * t);
    } else {
      const R = (kind === Sym.Jungle ? 0.7 : 0.6) * t;
      const fill = kind === Sym.Jungle ? p.jungle : p.leaf;
      fill.moveTo(cx + R, cy - 0.15 * t);
      fill.arc(cx, cy - 0.15 * t, R, 0, Math.PI * 2);
      p.treeInk.moveTo(cx + R, cy - 0.15 * t);
      p.treeInk.arc(cx, cy - 0.15 * t, R, 0, Math.PI * 2);
      p.treeInk.moveTo(cx, cy - 0.15 * t + R);
      p.treeInk.lineTo(cx, cy + 0.85 * t);
    }
  }
}

// 画风的颜色（按画风对象记住）
interface Pens {
  ink: string;
  shade: string;
  light: string;
  snow: string;
  leaf: string;
  pine: string;
  jungle: string;
  vignette: [string, string];
}
const pens = new WeakMap<object, Pens>();
function pensOf(style: MapStyle): Pens {
  let p = pens.get(style);
  if (p) return p;
  const h = handLook(style);
  const [ir, ig, ib] = styleRgba(h.ink) ?? [62, 48, 36, 1];
  const [pr, pg, pb] = styleRgba(h.paperColor) ?? [238, 226, 196, 1];
  const rgba = (r: number, g: number, b: number, a: number) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
  p = {
    ink: rgba(ir, ig, ib, 0.92),
    shade: rgba(ir, ig, ib, 0.3),
    light: rgba(pr, pg, pb, 0.3),
    snow: rgba(Math.min(255, pr + 14), Math.min(255, pg + 20), Math.min(255, pb + 34), 0.92),
    leaf: 'rgba(116, 138, 80, 0.62)',
    pine: 'rgba(72, 102, 74, 0.66)',
    jungle: 'rgba(82, 122, 64, 0.66)',
    vignette: [rgba(ir, ig, ib, 0), rgba(ir, ig, ib, 0.24 * h.paper)],
  };
  pens.set(style, p);
  return p;
}

// 一个符号画进 ctx：填色、墨线（lw 是一个 CSS 像素合几个像素）
function paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, p: TilePaths, pen: Pens, lw: number) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [fill, key] of [
    [pen.leaf, 'leaf'],
    [pen.pine, 'pine'],
    [pen.jungle, 'jungle'],
    [pen.light, 'light'],
    [pen.shade, 'shade'],
    [pen.snow, 'snow'],
  ] as const) {
    ctx.fillStyle = fill;
    ctx.fill(p[key]);
  }
  ctx.strokeStyle = pen.ink;
  ctx.lineWidth = 0.75 * lw;
  ctx.stroke(p.treeInk);
  ctx.lineWidth = 0.7 * lw;
  ctx.stroke(p.hatch);
  ctx.lineWidth = 1.15 * lw;
  ctx.stroke(p.ink);
}

// 符号的小图：种类、大小的档（山 5 档）、样子的档（3 档）、屏幕上的半径（按对数取整，每档约 3%）、每个 CSS 像素几个像素
interface Sprite {
  c: HTMLCanvasElement | OffscreenCanvas;
  half: number;
}
const SPRITE_MAX = 800;
const sprites = new WeakMap<object, Map<string, Sprite>>();
function spriteOf(style: MapStyle, kind: Sym, sizeQ: number, uQ: number, rq: number, lw: number): Sprite {
  let m = sprites.get(style);
  if (!m) sprites.set(style, (m = new Map()));
  const key = `${kind}|${sizeQ}|${uQ}|${rq}|${lw}`;
  let sp = m.get(key);
  if (sp) return sp;
  const half = Math.ceil(rq + 2 * lw + 1);
  const n = 2 * half;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const p = newPaths();
  if (kind === Sym.Mountain) mountain(p, half, half, rq, sizeQ, uQ);
  else if (kind === Sym.Hill) hill(p, half, half, rq);
  else trees(p, half, half, rq, kind, uQ);
  paint(ctx, p, pensOf(style), lw);
  sp = { c, half };
  if (m.size >= SPRITE_MAX) m.delete(m.keys().next().value!);
  m.set(key, sp);
  return sp;
}

// 画进 ctx：画布是 cw × ch 个 CSS 像素、每个 CSS 像素 dev 个像素，镜头在画布中间（同 drawBack）
export function drawSymbols(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, cam: Camera, style: MapStyle, cw: number, ch: number, dev: number) {
  const sp = world.mesh.spacing;
  const cellPx = sp * cam.zoom;
  const level = symbolLevel(cellPx);
  if (level < 0) return;
  const h = handLook(style);
  // 树冠太小（足迹的半径不到 3 个像素）时不画森林
  const forests = h.forests && (0.7 * cellPx) / (1 << level) >= 3;
  const mountains = h.mountains;
  if (!forests && !mountains) return;
  const hw = cw / 2 / cam.zoom;
  const hh = ch / 2 / cam.zoom;
  const m = (2.1 * sp) / (1 << level);
  const tiles = tilesIn(symbolSet(world), level, cam.x - hw - m, cam.y - hh - m, cam.x + hw + m, cam.y + hh + m);
  const z = cam.zoom * dev;
  const ox = (cw / 2 - cam.x * cam.zoom) * dev;
  const oy = (ch / 2 - cam.y * cam.zoom) * dev;
  const W = cw * dev;
  const H = ch * dev;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const t of tiles) {
    const s = t.syms;
    for (let q = 0; q < t.count; q++) {
      const kind = s[q * 5 + 3] as Sym;
      const tree = kind >= Sym.Broadleaf;
      if (tree ? !forests : !mountains) continue;
      const X = s[q * 5] * z + ox;
      const Y = s[q * 5 + 1] * z + oy;
      const r = s[q * 5 + 2] * z;
      if (X < -r - 4 || Y < -r - 4 || X > W + r + 4 || Y > H + r + 4) continue;
      const v = s[q * 5 + 4];
      const sizeQ = kind === Sym.Mountain ? Math.round((Math.floor(v / 1000) / 100) * 4) / 4 : 0;
      const uQ = (Math.floor((v % 1) * 3) + 0.5) / 3;
      const rq = Math.round(2 ** (Math.round(Math.log2(Math.max(r, 0.5)) * 24) / 24) * 8) / 8;
      const spr = spriteOf(style, kind, sizeQ, uQ, rq, dev);
      ctx.drawImage(spr.c, X - spr.half, Y - spr.half);
    }
  }
}

// 纸的暗角：画面（导出时是整张图）四周暗一点
export function drawVignette(ctx: CanvasRenderingContext2D, style: MapStyle, f: Frame) {
  if (!(handLook(style).paper > 0)) return;
  const W = f.cw * f.dpr;
  const H = f.ch * f.dpr;
  const R = Math.hypot(W, H) / 2;
  const [c0, c1] = pensOf(style).vignette;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(W / 2, H / 2, R * 0.5, W / 2, H / 2, R);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// 一个符号画在 (x, y)（画布的像素、单位矩阵）：导出的图例用（export-decor.ts）。lw：一个“单位”多少像素
export function drawSymbolIcon(ctx: CanvasRenderingContext2D, kind: Sym, x: number, y: number, r: number, style: MapStyle, lw: number) {
  const p = newPaths();
  if (kind === Sym.Mountain) mountain(p, x, y, r, 0.75, 0.5);
  else if (kind === Sym.Hill) hill(p, x, y, r);
  else trees(p, x, y, r, kind, 0.5);
  ctx.save();
  paint(ctx, p, pensOf(style), lw);
  ctx.restore();
}
