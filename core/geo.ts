import { tangentBasis, toUnit } from './sphere';

// 整个星球的几何小工具（纯函数）：显示坐标 x = 1 + 经度/180（0–2，东西相接），y = (90 − 纬度)/180。
// 距离用“地图单位”：弧长 / π（与 mesh.dist 相同），×kmPerUnit 就是 km

export { tangentBasis, toUnit };

export type V3 = [number, number, number];

// 经度绕回 [0, 2)
export const wrapX = (x: number) => x - 2 * Math.floor(x / 2);
// 经度差取最短的那一边（−1 到 1）
export const wrapDelta = (d: number) => d - 2 * Math.round(d / 2);
// 把 x 平移若干个 2，使它离 ref 最近
export const unwrapNear = (x: number, ref: number) => ref + wrapDelta(x - ref);

// 单位向量 → 显示坐标（x 在 [0, 2)）
export function fromUnit(v: V3): [number, number] {
  let x = 1 + Math.atan2(v[1], v[0]) / Math.PI;
  if (x >= 2) x -= 2;
  const y = Math.atan2(Math.sqrt(v[0] * v[0] + v[1] * v[1]), v[2]) / Math.PI;
  return [x, y];
}

// 两个单位向量之间的弧长（弧度）
export function arc(a: V3, b: V3): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

// 两个显示坐标之间的球面距离（地图单位）
export function arcUnits(ax: number, ay: number, bx: number, by: number): number {
  return arc(toUnit(ax, ay), toUnit(bx, by)) / Math.PI;
}

// 沿大圆插值（t = 0 是 a，1 是 b）
export function slerp(a: V3, b: V3, t: number): V3 {
  const th = arc(a, b);
  if (th < 1e-12) return [a[0], a[1], a[2]];
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  const x = wa * a[0] + wb * b[0];
  const y = wa * a[1] + wb * b[1];
  const z = wa * a[2] + wb * b[2];
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

// p 在以 c 为中心的等距方位投影里的位置（东、南分量，地图单位）：方向是从 c 看 p 的方向，长度是弧长
export function localOffset(c: V3, p: V3): [number, number] {
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(c[0], c[1], c[2]);
  const d = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
  const wx = p[0] - d * c[0];
  const wy = p[1] - d * c[1];
  const wz = p[2] - d * c[2];
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (wl < 1e-15) return [0, 0];
  const th = Math.atan2(wl, d) / Math.PI;
  return [(th * (wx * ex + wy * ey + wz * ez)) / wl, (th * (wx * sx + wy * sy + wz * sz)) / wl];
}

// 从 c 出发，按局部的（东、南）位移（地图单位）沿大圆走到的点
export function destination(c: V3, de: number, ds: number): V3 {
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(c[0], c[1], c[2]);
  const len = Math.hypot(de, ds);
  if (len < 1e-15) return [c[0], c[1], c[2]];
  const ux = (de * ex + ds * sx) / len;
  const uy = (de * ey + ds * sy) / len;
  const uz = (de * ez + ds * sz) / len;
  const th = len * Math.PI;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  return [c[0] * ct + ux * st, c[1] * ct + uy * st, c[2] * ct + uz * st];
}

// 沿大圆把折线加密（每段大约每 step 地图单位一个点），x 保持连续：在平铺图上画出球面上最短的弧线
export function densify(pts: [number, number][], step: number): [number, number][] {
  if (pts.length < 2) return pts.slice();
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = toUnit(pts[k][0], pts[k][1]);
    const b = toUnit(pts[k + 1][0], pts[k + 1][1]);
    const n = Math.max(1, Math.ceil(arc(a, b) / Math.PI / step));
    for (let j = 1; j <= n; j++) {
      const [x, y] = fromUnit(slerp(a, b, j / n));
      const prev = out[out.length - 1][0];
      out.push([unwrapNear(x, prev), y]);
    }
  }
  return out;
}

// 球面上以 (cx, cy) 为中心、半径 r（地图单位）的圆，投影到平铺图上，x 在 cx 附近展开。
// pole：圆包住了北极（1）或南极（−1），这时它在平铺图上是一条横贯的曲线，不能闭合
export function circle(cx: number, cy: number, r: number, n = 72): { pts: [number, number][]; pole: number } {
  const c = toUnit(cx, cy);
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const [x, y] = fromUnit(destination(c, r * Math.cos(a), r * Math.sin(a)));
    pts.push([unwrapNear(x, k ? pts[k - 1][0] : cx), y]);
  }
  let total = 0;
  for (let k = 0; k < n; k++) total += wrapDelta(pts[(k + 1) % n][0] - pts[k][0]);
  const winding = Math.round(total / 2);
  return { pts, pole: winding === 0 ? 0 : cy < 0.5 ? 1 : -1 };
}
