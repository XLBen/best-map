import { findCell } from '../../core/mesh';
import { mixSeed, mulberry32 } from '../../core/rng';
import type { World } from '../../core/world';
import type { Camera } from './renderer';

// 风向流线：在风场上按“均匀间距流线”的办法撒线（Jobard–Lefer 的简化版）——
// 起点放在抖动网格上，沿插值后的风用 RK2 往前、往后积分；靠近别的线、出了地图、风太弱就停。
// 地图分成方块，每块各算各的，按 世界 × 季节 × 疏密档 × 方块 缓存：平移时只算新露出来的方块，
// 缩放时换一档疏密，屏幕上的线距始终约 44 像素

export type WindSeason = 'annual' | 'summer' | 'winter';

interface Line {
  pts: [number, number][];
  // 平均风速（无量纲，约 0–1.3）
  speed: number;
}

const TILE = 12;
// 按风场数组缓存（只改了名字、省份的轻快照沿用同一个数组）
const cache = new WeakMap<Float32Array, Map<string, Line[]>>();

// 一点的风：所在格与相邻格按距离加权，平滑地插值；“全年”取冬夏平均
function windAt(world: World, season: WindSeason, x: number, y: number, hint: number): [number, number, number] {
  const { mesh, derived: d } = world;
  const c = findCell(mesh, x, y, hint);
  let u = 0;
  let v = 0;
  let wsum = 0;
  const add = (i: number) => {
    const dist2 = (mesh.x[i] - x) ** 2 + (mesh.y[i] - y) ** 2;
    const w = 1 / (dist2 + mesh.spacing * mesh.spacing * 0.05);
    const wu = season === 'summer' ? d.windSX[i] : season === 'winter' ? d.windWX[i] : (d.windSX[i] + d.windWX[i]) / 2;
    const wv = season === 'summer' ? d.windSY[i] : season === 'winter' ? d.windWY[i] : (d.windSY[i] + d.windWY[i]) / 2;
    u += w * wu;
    v += w * wv;
    wsum += w;
  };
  add(c);
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) add(mesh.adj[e]);
  return [u / wsum, v / wsum, c];
}

function tileLines(world: World, season: WindSeason, level: number, tx: number, ty: number): Line[] {
  const key = `${season}|${level}|${tx}|${ty}`;
  let m = cache.get(world.derived.windSX);
  if (!m) cache.set(world.derived.windSX, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const { mesh } = world;
  const sep = mesh.width / 2 ** level;
  const x0 = tx * TILE * sep;
  const y0 = ty * TILE * sep;
  const span = TILE * sep;
  // 占用网格：落在别的线半个线距以内就停
  const cellSize = sep / 2;
  const margin = 2 * sep;
  const gw = Math.ceil((span + 2 * margin) / cellSize);
  const grid = new Map<number, [number, number, number][]>();
  const gkey = (x: number, y: number) => Math.floor((x - x0 + margin) / cellSize) * 100003 + Math.floor((y - y0 + margin) / cellSize);
  const near = (x: number, y: number, line: number, r: number) => {
    const cx = Math.floor((x - x0 + margin) / cellSize);
    const cy = Math.floor((y - y0 + margin) / cellSize);
    const reach = Math.ceil(r / cellSize);
    for (let i = cx - reach; i <= cx + reach; i++) {
      if (i < 0 || i > gw) continue;
      for (let j = cy - reach; j <= cy + reach; j++) {
        for (const [px, py, id] of grid.get(i * 100003 + j) ?? []) if (id !== line && (px - x) ** 2 + (py - y) ** 2 < r * r) return true;
      }
    }
    return false;
  };
  const inside = (x: number, y: number) =>
    x >= Math.max(0, x0 - margin) && y >= Math.max(0, y0 - margin) && x <= Math.min(mesh.width, x0 + span + margin) && y <= Math.min(mesh.height, y0 + span + margin);
  const rand = mulberry32(mixSeed(level, tx * 7919 + ty, season.length));
  const lines: Line[] = [];
  const step = sep * 0.32;
  const maxSteps = 16;
  let hint = 0;
  for (let i = 0; i < TILE; i++) {
    for (let j = 0; j < TILE; j++) {
      const sx = x0 + (i + 0.5 + (rand() - 0.5) * 0.6) * sep;
      const sy = y0 + (j + 0.5 + (rand() - 0.5) * 0.6) * sep;
      if (sx > mesh.width || sy > mesh.height || near(sx, sy, -1, sep)) continue;
      const id = lines.length;
      let speedSum = 0;
      let count = 0;
      // dir = 1 往下风走，-1 往上风走
      const trace = (dir: 1 | -1): [number, number][] => {
        const out: [number, number][] = [];
        let x = sx;
        let y = sy;
        for (let k = 0; k < maxSteps; k++) {
          const [u0, v0, c0] = windAt(world, season, x, y, hint);
          hint = c0;
          const s0 = Math.hypot(u0, v0);
          if (s0 < 0.05) break;
          const mx = x + ((dir * u0) / s0) * step * 0.5;
          const my = y + ((dir * v0) / s0) * step * 0.5;
          const [u1, v1] = windAt(world, season, mx, my, hint);
          const s1 = Math.hypot(u1, v1);
          if (s1 < 0.05) break;
          const nx = x + ((dir * u1) / s1) * step;
          const ny = y + ((dir * v1) / s1) * step;
          if (!inside(nx, ny) || near(nx, ny, id, sep * 0.45)) break;
          out.push([nx, ny]);
          speedSum += s1;
          count++;
          x = nx;
          y = ny;
        }
        return out;
      };
      const ahead = trace(1);
      const behind = trace(-1);
      const pts: [number, number][] = [...behind.reverse(), [sx, sy], ...ahead];
      if (pts.length < 5 || !count) continue;
      for (const [px, py] of pts) {
        const k = gkey(px, py);
        const list = grid.get(k);
        if (list) list.push([px, py, id]);
        else grid.set(k, [[px, py, id]]);
      }
      lines.push({ pts, speed: speedSum / count });
    }
  }
  m.set(key, lines);
  return lines;
}

// 画流线：先整体描一道深色的边，再按风速分三档画白线，线尾细、线头粗，末端带小箭头。unitPx：一个设备像素合多少地图单位
// size：画布的 CSS 大小（导出整张地图时是虚拟窗口；不给就按画布）
type Size = { cw: number; ch: number };
const sizeOf = (ctx: CanvasRenderingContext2D, size?: Size): Size => size ?? { cw: ctx.canvas.clientWidth, ch: ctx.canvas.clientHeight };

export function drawWind(ctx: CanvasRenderingContext2D, world: World, cam: Camera, season: WindSeason, unitPx: number, size?: Size) {
  if (world.mesh.kind === 'sphere') {
    drawWindSphere(ctx, world, cam, season, unitPx, size);
    return;
  }
  const { mesh } = world;
  const level = Math.max(3, Math.min(12, Math.round(Math.log2((mesh.width * cam.zoom) / 44))));
  const sep = mesh.width / 2 ** level;
  const span = TILE * sep;
  const { cw, ch } = sizeOf(ctx, size);
  const halfW = cw / 2 / cam.zoom;
  const halfH = ch / 2 / cam.zoom;
  const tx0 = Math.max(0, Math.floor((cam.x - halfW) / span));
  const tx1 = Math.min(Math.ceil(mesh.width / span) - 1, Math.floor((cam.x + halfW) / span));
  const ty0 = Math.max(0, Math.floor((cam.y - halfH) / span));
  const ty1 = Math.min(Math.ceil(mesh.height / span) - 1, Math.floor((cam.y + halfH) / span));
  const lines: Line[] = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) lines.push(...tileLines(world, season, level, tx, ty));
  if (!lines.length) return;
  const halo = new Path2D();
  // 三档风速 × 三段（尾、中、头）
  const body: Path2D[][] = [0, 1, 2].map(() => [new Path2D(), new Path2D(), new Path2D()]);
  const heads: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
  for (const l of lines) {
    const p = l.pts;
    const band = l.speed < 0.35 ? 0 : l.speed < 0.75 ? 1 : 2;
    halo.moveTo(p[0][0], p[0][1]);
    for (let k = 1; k < p.length; k++) halo.lineTo(p[k][0], p[k][1]);
    for (let part = 0; part < 3; part++) {
      const a = Math.floor(((p.length - 1) * part) / 3);
      const b = Math.floor(((p.length - 1) * (part + 1)) / 3);
      const path = body[band][part];
      path.moveTo(p[a][0], p[a][1]);
      for (let k = a + 1; k <= b; k++) path.lineTo(p[k][0], p[k][1]);
    }
    // 箭头：沿最后一段的方向，两边各张 0.5 弧度
    const [x1, y1] = p[p.length - 1];
    const [xa, ya] = p[p.length - 2];
    const ang = Math.atan2(y1 - ya, x1 - xa);
    const hs = 5.5 * unitPx;
    heads[band].moveTo(x1 - hs * Math.cos(ang - 0.5), y1 - hs * Math.sin(ang - 0.5));
    heads[band].lineTo(x1, y1);
    heads[band].lineTo(x1 - hs * Math.cos(ang + 0.5), y1 - hs * Math.sin(ang + 0.5));
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(10, 16, 24, 0.28)';
  ctx.lineWidth = 3 * unitPx;
  ctx.stroke(halo);
  const alpha = [0.45, 0.65, 0.85];
  const widths = [0.7, 1.15, 1.6];
  for (let band = 0; band < 3; band++) {
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha[band]})`;
    for (let part = 0; part < 3; part++) {
      ctx.lineWidth = widths[part] * unitPx;
      ctx.stroke(body[band][part]);
    }
    ctx.lineWidth = 1.5 * unitPx;
    ctx.stroke(heads[band]);
  }
  ctx.restore();
}

// ---------- 整个星球：风与洋流的流线 ----------
// 经度方向的瓦片以 2（一整圈）为周期：每块瓦片只算一次，平铺的每份副本照着画；
// 场是每格切平面上的（东、南）分量，画到平铺图上时东西方向除以 cos 纬度；纬度超过 80° 不画（越近极点越变形）

interface Field {
  // 缓存的身份：场的数组换了就重算
  key: Float32Array;
  vec: (c: number) => [number, number];
  // 流线走到这一格就停（洋流遇到陆地）
  stop?: (c: number) => boolean;
}

const sphereCache = new WeakMap<Float32Array, Map<string, Line[]>>();
const MAX_LAT = 80;

function fieldAt(world: World, field: Field, x: number, y: number, hint: number): [number, number, number] {
  const { mesh } = world;
  const c = findCell(mesh, x, y, hint);
  let u = 0;
  let v = 0;
  let wsum = 0;
  const add = (i: number) => {
    let dx = mesh.x[i] - x;
    dx -= 2 * Math.round(dx / 2);
    const dist2 = dx * dx + (mesh.y[i] - y) ** 2;
    const w = 1 / (dist2 + mesh.spacing * mesh.spacing * 0.05);
    const [fu, fv] = field.vec(i);
    u += w * fu;
    v += w * fv;
    wsum += w;
  };
  add(c);
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) add(mesh.adj[e]);
  return [u / wsum, v / wsum, c];
}

function tileLinesSphere(world: World, field: Field, tag: string, level: number, txm: number, ty: number, nT: number): Line[] {
  const key = `${tag}|${level}|${txm}|${ty}`;
  let m = sphereCache.get(field.key);
  if (!m) sphereCache.set(field.key, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const span = 2 / nT;
  const sep = span / TILE;
  const x0 = txm * span;
  const y0 = ty * span;
  const cellSize = sep / 2;
  const margin = 2 * sep;
  const grid = new Map<number, [number, number, number][]>();
  const gk = (x: number, y: number) => Math.floor((x - x0 + margin) / cellSize) * 100003 + Math.floor((y - y0 + margin) / cellSize);
  const near = (x: number, y: number, line: number, r: number) => {
    const cx = Math.floor((x - x0 + margin) / cellSize);
    const cy = Math.floor((y - y0 + margin) / cellSize);
    const reach = Math.ceil(r / cellSize);
    for (let i = cx - reach; i <= cx + reach; i++) {
      for (let j = cy - reach; j <= cy + reach; j++) {
        for (const [px, py, id] of grid.get(i * 100003 + j) ?? []) if (id !== line && (px - x) ** 2 + (py - y) ** 2 < r * r) return true;
      }
    }
    return false;
  };
  const latOf = (y: number) => 90 - 180 * y;
  const inside = (x: number, y: number) => x >= x0 - margin && x <= x0 + span + margin && y >= Math.max(0, y0 - margin) && y <= Math.min(1, y0 + span + margin) && Math.abs(latOf(y)) <= MAX_LAT;
  const rand = mulberry32(mixSeed(level, txm * 7919 + ty, tag.length));
  const lines: Line[] = [];
  const step = sep * 0.32;
  let hint = 0;
  for (let i = 0; i < TILE; i++) {
    for (let j = 0; j < TILE; j++) {
      const sx = x0 + (i + 0.5 + (rand() - 0.5) * 0.6) * sep;
      const sy = y0 + (j + 0.5 + (rand() - 0.5) * 0.6) * sep;
      if (sy > 1 || Math.abs(latOf(sy)) > MAX_LAT || near(sx, sy, -1, sep)) continue;
      const id = lines.length;
      let speedSum = 0;
      let count = 0;
      const trace = (dir: 1 | -1): [number, number][] => {
        const out: [number, number][] = [];
        let x = sx;
        let y = sy;
        // 一步的方向：东西分量除以 cos 纬度，换到平铺图上
        const step1 = (px: number, py: number): [number, number, number] | null => {
          const [u, v, c] = fieldAt(world, field, px, py, hint);
          hint = c;
          if (field.stop?.(c)) return null;
          const cl = Math.max(Math.cos((latOf(py) * Math.PI) / 180), 0.17);
          const mx = u / cl;
          const s = Math.hypot(mx, v);
          if (Math.hypot(u, v) < 0.05 || s < 1e-9) return null;
          return [(dir * mx) / s, (dir * v) / s, Math.hypot(u, v)];
        };
        for (let k = 0; k < 16; k++) {
          const a = step1(x, y);
          if (!a) break;
          const b = step1(x + a[0] * step * 0.5, y + a[1] * step * 0.5);
          if (!b) break;
          const nx = x + b[0] * step;
          const ny = y + b[1] * step;
          if (!inside(nx, ny) || near(nx, ny, id, sep * 0.45)) break;
          out.push([nx, ny]);
          speedSum += b[2];
          count++;
          x = nx;
          y = ny;
        }
        return out;
      };
      const ahead = trace(1);
      const behind = trace(-1);
      const pts: [number, number][] = [...behind.reverse(), [sx, sy], ...ahead];
      if (pts.length < 5 || !count) continue;
      for (const [px, py] of pts) {
        const k = gk(px, py);
        const list = grid.get(k);
        if (list) list.push([px, py, id]);
        else grid.set(k, [[px, py, id]]);
      }
      lines.push({ pts, speed: speedSum / count });
    }
  }
  m.set(key, lines);
  return lines;
}

// 星球上看得见的瓦片（经度方向不截断，按一整圈取模），每条线连同它所在副本的平移量
function visibleLines(world: World, field: Field, tag: string, cam: Camera, ctx: CanvasRenderingContext2D, size?: Size): { line: Line; dx: number }[] {
  const level = Math.max(4, Math.min(12, Math.round(Math.log2((2 * cam.zoom) / 44))));
  const nT = Math.max(1, Math.round(2 ** level / TILE));
  const span = 2 / nT;
  const { cw, ch } = sizeOf(ctx, size);
  const halfW = cw / 2 / cam.zoom;
  const halfH = ch / 2 / cam.zoom;
  const tx0 = Math.floor((cam.x - halfW) / span);
  const tx1 = Math.floor((cam.x + halfW) / span);
  const ty0 = Math.max(0, Math.floor((cam.y - halfH) / span));
  const ty1 = Math.min(Math.ceil(1 / span) - 1, Math.floor((cam.y + halfH) / span));
  const out: { line: Line; dx: number }[] = [];
  for (let tx = tx0; tx <= tx1 && tx - tx0 < 4 * nT; tx++) {
    const txm = ((tx % nT) + nT) % nT;
    const dx = 2 * Math.floor(tx / nT);
    for (let ty = ty0; ty <= ty1; ty++) for (const line of tileLinesSphere(world, field, tag, level, txm, ty, nT)) out.push({ line, dx });
  }
  return out;
}

// 按样式分组描线：尾细头粗，末端小箭头（与平面世界的风相同的画法）
function strokeLines(ctx: CanvasRenderingContext2D, lines: { line: Line; dx: number; band: number; color: number }[], colors: string[][], unitPx: number, halo: string) {
  if (!lines.length) return;
  const haloPath = new Path2D();
  const body = colors.map(() => [0, 1, 2].map(() => [new Path2D(), new Path2D(), new Path2D()]));
  const heads = colors.map(() => [new Path2D(), new Path2D(), new Path2D()]);
  for (const { line, dx, band, color } of lines) {
    const p = line.pts;
    haloPath.moveTo(p[0][0] + dx, p[0][1]);
    for (let k = 1; k < p.length; k++) haloPath.lineTo(p[k][0] + dx, p[k][1]);
    for (let part = 0; part < 3; part++) {
      const a = Math.floor(((p.length - 1) * part) / 3);
      const b = Math.floor(((p.length - 1) * (part + 1)) / 3);
      const path = body[color][band][part];
      path.moveTo(p[a][0] + dx, p[a][1]);
      for (let k = a + 1; k <= b; k++) path.lineTo(p[k][0] + dx, p[k][1]);
    }
    const [x1, y1] = p[p.length - 1];
    const [xa, ya] = p[p.length - 2];
    const ang = Math.atan2(y1 - ya, x1 - xa);
    const hs = 5.5 * unitPx;
    heads[color][band].moveTo(x1 + dx - hs * Math.cos(ang - 0.5), y1 - hs * Math.sin(ang - 0.5));
    heads[color][band].lineTo(x1 + dx, y1);
    heads[color][band].lineTo(x1 + dx - hs * Math.cos(ang + 0.5), y1 - hs * Math.sin(ang + 0.5));
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = halo;
  ctx.lineWidth = 3 * unitPx;
  ctx.stroke(haloPath);
  const widths = [0.7, 1.15, 1.6];
  colors.forEach((bandColors, ci) => {
    for (let band = 0; band < 3; band++) {
      ctx.strokeStyle = bandColors[band];
      for (let part = 0; part < 3; part++) {
        ctx.lineWidth = widths[part] * unitPx;
        ctx.stroke(body[ci][band][part]);
      }
      ctx.lineWidth = 1.5 * unitPx;
      ctx.stroke(heads[ci][band]);
    }
  });
  ctx.restore();
}

function drawWindSphere(ctx: CanvasRenderingContext2D, world: World, cam: Camera, season: WindSeason, unitPx: number, size?: Size) {
  const d = world.derived;
  const field: Field = {
    key: d.windSX,
    vec: (i) =>
      season === 'summer' ? [d.windSX[i], d.windSY[i]] : season === 'winter' ? [d.windWX[i], d.windWY[i]] : [(d.windSX[i] + d.windWX[i]) / 2, (d.windSY[i] + d.windWY[i]) / 2],
  };
  const lines = visibleLines(world, field, season, cam, ctx, size).map(({ line, dx }) => ({ line, dx, band: line.speed < 0.35 ? 0 : line.speed < 0.75 ? 1 : 2, color: 0 }));
  strokeLines(ctx, lines, [['rgba(255, 255, 255, 0.45)', 'rgba(255, 255, 255, 0.65)', 'rgba(255, 255, 255, 0.85)']], unitPx, 'rgba(10, 16, 24, 0.28)');
}

// 洋流：只在海上，暖流（海温偏高）偏橙、寒流（偏低）偏蓝，其余白色；流得越快越不透明
export function drawCurrents(ctx: CanvasRenderingContext2D, world: World, cam: Camera, unitPx: number, size?: Size) {
  const d = world.derived;
  const land = world.causes.land;
  const field: Field = { key: d.currentX, vec: (i) => [d.currentX[i], d.currentY[i]], stop: (i) => land[i] === 1 };
  const { mesh } = world;
  const lines = visibleLines(world, field, 'currents', cam, ctx, size).map(({ line, dx }) => {
    const [mx, my] = line.pts[Math.floor(line.pts.length / 2)];
    const c = findCell(mesh, mx, my);
    const a = d.sstAnom[c];
    return { line, dx, band: line.speed < 0.3 ? 0 : line.speed < 1 ? 1 : 2, color: a > 0.7 ? 1 : a < -0.7 ? 2 : 0 };
  });
  strokeLines(
    ctx,
    lines,
    [
      ['rgba(235, 240, 245, 0.4)', 'rgba(235, 240, 245, 0.6)', 'rgba(235, 240, 245, 0.8)'],
      ['rgba(255, 160, 110, 0.5)', 'rgba(255, 150, 100, 0.7)', 'rgba(255, 140, 90, 0.9)'],
      ['rgba(140, 200, 255, 0.5)', 'rgba(130, 195, 255, 0.7)', 'rgba(120, 190, 255, 0.9)'],
    ],
    unitPx,
    'rgba(8, 20, 36, 0.3)',
  );
}
