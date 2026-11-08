// 点在哪个三角形里（第八十三轮从 core/subcell.ts 原样搬出）：平面与球面
import { type SphereView, viewOf } from './sphere';
import type { Delaunay } from 'd3-delaunay';
import type { PlaneMesh, Mesh } from './mesh';
import { sphereProvDel } from './fjords';

// 整个星球：点所在的显示三角形与重心坐标（三角网见 sphere.ts 的 viewOf）。
// 同一个三角形里对应同一格的角（极点那一行的影子点）权重合并，与着色器一致
export function locateSphere(view: SphereView, r2: Float64Array, x: number, y: number, hint: number, provDel: Int32Array | null = null): number {
  const xw = x - 2 * Math.floor(x / 2);
  const yc = Math.min(1, Math.max(0, y));
  const dl = view.delaunay;
  const start = hint >= 0 && hint < view.cellOf.length ? hint : 0;
  const nearV = within(dl, r2, xw, yc, start) ? start : dl.find(xw, yc, start);
  const near = view.cellOf[nearV];
  let found = around(dl, view.x, view.y, nearV, xw, yc, 64);
  // 退回：看最近点在 Delaunay 上的邻居
  if (!found) {
    for (const v of dl.neighbors(nearV)) {
      if (around(dl, view.x, view.y, v, xw, yc, 64)) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    li[0] = li[1] = li[2] = near;
    lw[0] = 1;
    lw[1] = lw[2] = 0;
    located.prov = near;
    return near;
  }
  located.prov = provDel ? provDel[lt] : view.cellOf[li[2]];
  const ca = view.cellOf[li[0]];
  let cb = view.cellOf[li[1]];
  let cc = view.cellOf[li[2]];
  let w0 = lw[0];
  let w1 = lw[1];
  let w2 = lw[2];
  if (cb === ca) {
    w0 = w0 + w1;
    w1 = 0;
  }
  if (cc === ca) {
    w0 = w0 + w2;
    w2 = 0;
  } else if (cc === cb && cb !== ca) {
    w1 = w1 + w2;
    w2 = 0;
  }
  if (w1 === 0) cb = ca;
  if (w2 === 0) cc = cb === ca && w1 === 0 ? ca : cb;
  li[0] = ca;
  li[1] = cb;
  li[2] = cc;
  lw[0] = w0;
  lw[1] = w1;
  lw[2] = w2;
  return near;
}

// ---------- 点所在的三角形 ----------
// 结果写进 li / lw（三个角与重心坐标），返回最近的格：逐像素调用时不新建对象和闭包
export const li = new Int32Array(3);
export const lw = new Float64Array(3);
// 找到的 Delaunay 三角形的编号（tryTri 记下）与它的“最后一个顶点的格”（第三十六轮：着色器按它取峡湾的表，见 core/fjords.ts 的 provOfTri）；
// 退回最近的格时是那一格
let lt = -1;
export const located = { prov: -1 };

// 三角形 t 是否含点 (x, y)：含则把三个角（点编号）与重心坐标写进 li / lw
function tryTri(triangles: Uint32Array, X: Float64Array, Y: Float64Array, t: number, x: number, y: number): boolean {
  const a = triangles[3 * t];
  const b = triangles[3 * t + 1];
  const c = triangles[3 * t + 2];
  const ax = X[a];
  const ay = Y[a];
  const v0x = X[b] - ax;
  const v0y = Y[b] - ay;
  const v1x = X[c] - ax;
  const v1y = Y[c] - ay;
  const v2x = x - ax;
  const v2y = y - ay;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-18) return false;
  // 任一个坐标为负就不含：先算出来的先判
  const wb = (v2x * v1y - v1x * v2y) / den;
  if (wb < -1e-9) return false;
  const wc = (v0x * v2y - v2x * v0y) / den;
  if (wc < -1e-9) return false;
  const wa = 1 - wb - wc;
  if (wa < -1e-9) return false;
  li[0] = a;
  li[1] = b;
  li[2] = c;
  lw[0] = wa;
  lw[1] = wb;
  lw[2] = wc;
  lt = t;
  return true;
}

// 绕点 v 一圈的三角形里找含点 (x, y) 的
function around(dl: { triangles: Uint32Array; halfedges: Int32Array; inedges: Int32Array }, X: Float64Array, Y: Float64Array, v: number, x: number, y: number, guards: number): boolean {
  const e0 = dl.inedges[v];
  if (e0 < 0) return false;
  let e = e0;
  for (let guard = 0; guard < guards; guard++) {
    if (tryTri(dl.triangles, X, Y, Math.floor(e / 3), x, y)) return true;
    const next = e % 3 === 2 ? e - 2 : e + 1;
    e = dl.halfedges[next];
    if (e < 0 || e === e0) break;
  }
  return false;
}

// 最近点查找（Delaunay.find）的捷径：点到起点 i 的距离不到 i 与最近邻点距离的一半时，没有别的点比 i 更近，
// find 从 i 出发第一步就停在 i，所以直接返回 i，结果与 find 完全相同。
// r2[i] 是这个半径（略缩一点，留出舍入误差）的平方；按三角网缓存（三角网建好后不再变）
const findRadii = new WeakMap<Delaunay<number>, Float64Array>();
export function findRadius2(dl: Delaunay<number>): Float64Array {
  let r2 = findRadii.get(dl);
  if (r2) return r2;
  const P = dl.points;
  r2 = new Float64Array(P.length / 2);
  // 点共线时 d3 走另一套逻辑，不用捷径
  if (!(dl as Delaunay<number> & { collinear?: Int32Array }).collinear) {
    for (let i = 0; i < r2.length; i++) {
      if (dl.inedges[i] === -1) continue;
      let m = Infinity;
      for (const j of dl.neighbors(i)) m = Math.min(m, Math.hypot(P[2 * j] - P[2 * i], P[2 * j + 1] - P[2 * i + 1]));
      if (m < Infinity) r2[i] = (0.5 * m * (1 - 1e-7)) ** 2;
    }
  }
  findRadii.set(dl, r2);
  return r2;
}

// 点 (x, y) 离点 i 是否近到 dl.find(x, y, i) 必定返回 i
export function within(dl: Delaunay<number>, r2: Float64Array, x: number, y: number, i: number): boolean {
  const dx = x - dl.points[2 * i];
  const dy = y - dl.points[2 * i + 1];
  return dx * dx + dy * dy < r2[i];
}

export function locatePlane(mesh: PlaneMesh, r2: Float64Array, x: number, y: number, hint: number): number {
  const dl = mesh.delaunay;
  const near = within(dl, r2, x, y, hint) ? hint : dl.find(x, y, hint);
  // 先看与最近格相邻的三角形，再看邻居的
  if (around(dl, mesh.x, mesh.y, near, x, y, 32)) {
    located.prov = li[2];
    return near;
  }
  for (let e = mesh.off[near]; e < mesh.off[near + 1]; e++) {
    if (around(dl, mesh.x, mesh.y, mesh.adj[e], x, y, 32)) {
      located.prov = li[2];
      return near;
    }
  }
  li[0] = li[1] = li[2] = near;
  lw[0] = 1;
  lw[1] = lw[2] = 0;
  located.prov = near;
  return near;
}

// 点所在的 Delaunay 三角形与重心坐标；找不到（地图边缘外）时退回最近的格
// prov：这个三角形的“最后一个顶点的格”（峡湾的表按它取，第三十六轮）
export function locate(mesh: Mesh, x: number, y: number, hint: number): { i: [number, number, number]; w: [number, number, number]; nearest: number; prov: number } {
  let nearest: number;
  if (mesh.kind === 'sphere') {
    const view = viewOf(mesh);
    nearest = locateSphere(view, findRadius2(view.delaunay), x, y, hint, sphereProvDel(mesh));
  } else nearest = locatePlane(mesh, findRadius2(mesh.delaunay), x, y, hint);
  return { i: [li[0], li[1], li[2]], w: [lw[0], lw[1], lw[2]], nearest, prov: located.prov };
}
