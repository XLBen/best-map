// 描河时对画面上岸线的查询（第八十三轮从 core/rivers.ts 原样搬出）：走到岸线、法向、沿岸、圆上的岸点；跨几次描河记下来（core/coast-memo.ts）
import type { World } from './world';
import { type DisplayCoast, displayCoastAt, shoreCrossing } from './display';
import type { Pt } from './rivers-line';
import { memoActive, keyStart, keyAddPts, keyAdd, memoGet, MISS, memoPut, coastReads } from './coast-memo';
import { locate } from './subcell';
import { wrapX } from './geo';

const WALK_SHORE = { samples: 12, bisect: 9 };
// 量岸线法向的圈的半径（格）与取几个点：海岸细节的小弯不算，量的是约一格见方的岸线走向
const NORMAL_R = 0.4;
const NORMAL_N = 8;
// 沿法向找岸线（线只有一格多长）：等分 6 个点、二分 8 次
export const SHORE_STEPS = { samples: 6, bisect: 8 };
// 法向按海岸场 / 50 夹在 ±1 之间加权
const NORMAL_CLAMP = 50;

// 画面上的这一点是不是陆地（只要正负）
export const landAt = (world: World, f: DisplayCoast, q: readonly [number, number], hint: number) => displayCoastAt(world, f, q[0], q[1], hint, true).v > 0;

// ---- 跨几次描河记下来的查询（core/coast-memo.ts）：键是全部参数，结果复制一份。不在描河里（memoActive 为假）时照常算 ----
const Q_WALK = 1;
const Q_CIRCLE = 2;
const Q_NORMAL = 3;
const Q_LAND = 4;
const Q_MOUTH = 5;
const Q_ALONG = 6;
const Q_CROSS = 7;
const copyPt = (p: readonly [number, number] | null): Pt | null => (p ? [p[0], p[1]] : null);

// walk 里入海、入湖的那一点：从 a 往 b（水里）走到画面上的岸线（a、b 是相邻两格 c、r 的格心），找不到时退回两点的中点
export function walkShore(world: World, f: DisplayCoast, a: [number, number], b: [number, number], c: number, r: number): [number, number] {
  if (!memoActive()) return walkShoreRaw(world, a, b, c, r);
  keyStart(Q_WALK);
  keyAddPts([a, b], 0, 2);
  keyAdd(c);
  keyAdd(r);
  const m = memoGet(f);
  if (m !== MISS) return copyPt(m as Pt)!;
  const p = walkShoreRaw(world, a, b, c, r);
  memoPut(f, copyPt(p));
  return p;
}
const walkShoreRaw = (world: World, a: [number, number], b: [number, number], c: number, r: number): [number, number] => shoreCrossing(world, a, b, c, [c, r], WALK_SHORE)?.p ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// pts 的前 n 个点都在画面上的陆地上
export function allLand(world: World, f: DisplayCoast, pts: readonly (readonly [number, number])[], n: number, hint: number): boolean {
  if (!memoActive()) return allLandRaw(world, f, pts, n, hint);
  keyStart(Q_LAND);
  keyAdd(hint);
  keyAddPts(pts, 0, n);
  const m = memoGet(f);
  if (m !== MISS) return m as boolean;
  const v = allLandRaw(world, f, pts, n, hint);
  memoPut(f, v);
  return v;
}
function allLandRaw(world: World, f: DisplayCoast, pts: readonly (readonly [number, number])[], n: number, hint: number): boolean {
  for (let j = 0; j < n; j++) if (!landAt(world, f, pts[j], hint)) return false;
  return true;
}

// 从 a 往 b 走到画面上的岸线（shoreCrossing，不沿边）
export function shoreCross(world: World, f: DisplayCoast, a: readonly [number, number], b: readonly [number, number], hint: number, steps: { samples: number; bisect: number }): { p: Pt; t: number } | null {
  if (!memoActive()) return shoreCrossing(world, a, b, hint, undefined, steps);
  keyStart(Q_CROSS);
  keyAddPts([a, b], 0, 2);
  keyAdd(hint);
  keyAdd(steps.samples);
  keyAdd(steps.bisect);
  const m = memoGet(f);
  if (m !== MISS) {
    const v = m as { p: Pt; t: number } | null;
    return v && { p: [v.p[0], v.p[1]], t: v.t };
  }
  const v = shoreCrossing(world, a, b, hint, undefined, steps);
  memoPut(f, v && { p: [v.p[0], v.p[1]], t: v.t });
  return v;
}

// 海岸场三角形内插的那部分（不加格以下的海岸细节）：量岸线的法向用（量的是约一格见方的岸线走向，细节的小弯本来就不算）
function coastSmooth(world: World, f: DisplayCoast, x: number, y: number, hint: number): { v: number; nearest: number } {
  const { mesh } = world;
  const loc = locate(mesh, mesh.kind === 'sphere' ? wrapX(x) : x, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  if (coastReads.on) coastReads.cells.push(a, b, c);
  return { v: f.coast[a] * wa + f.coast[b] * wb + f.coast[c] * wc, nearest: loc.nearest };
}

// 一点处岸线朝水面的法向（单位向量）：一圈点的海岸场（三角形内插的那部分）加权求和（离岸线约半格以内的一圈，近似梯度的反方向）
export function seawardNormal(world: World, f: DisplayCoast, p: readonly [number, number], hint = 0): [number, number] | null {
  if (!memoActive()) return seawardNormalRaw(world, f, p, hint);
  keyStart(Q_NORMAL);
  keyAddPts([p], 0, 1);
  keyAdd(hint);
  const m = memoGet(f);
  if (m !== MISS) return copyPt(m as Pt | null);
  const v = seawardNormalRaw(world, f, p, hint);
  memoPut(f, copyPt(v));
  return v;
}
function seawardNormalRaw(world: World, f: DisplayCoast, p: readonly [number, number], hint: number): [number, number] | null {
  const r = NORMAL_R * world.mesh.spacing;
  let gx = 0;
  let gy = 0;
  let h = hint;
  for (let i = 0; i < NORMAL_N; i++) {
    const a = (2 * Math.PI * i) / NORMAL_N;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const v = coastSmooth(world, f, p[0] + r * c, p[1] + r * s, h);
    h = v.nearest;
    // 海岸场正的是陆地：按它加权的方向指向陆地
    const w = Math.max(-1, Math.min(1, v.v / NORMAL_CLAMP));
    gx += w * c;
    gy += w * s;
  }
  const l = Math.hypot(gx, gy);
  return l > 1e-9 ? [-gx / l, -gy / l] : null;
}

// 从 q 附近沿方向 dir 走到画面上的岸线：从岸上（往回 0.6 格，不在陆地上时 0.25 格）走到水面。找不到时为 null
export function shoreAlong(world: World, f: DisplayCoast, q: readonly [number, number], dir: readonly [number, number], hint: number): Pt | null {
  if (!memoActive()) return shoreAlongRaw(world, f, q, dir, hint);
  keyStart(Q_ALONG);
  keyAddPts([q, dir], 0, 2);
  keyAdd(hint);
  const m = memoGet(f);
  if (m !== MISS) return copyPt(m as Pt | null);
  const v = shoreAlongRaw(world, f, q, dir, hint);
  memoPut(f, copyPt(v));
  return v;
}
function shoreAlongRaw(world: World, f: DisplayCoast, q: readonly [number, number], dir: readonly [number, number], hint: number): Pt | null {
  const sp = world.mesh.spacing;
  let from: Pt = [q[0] - dir[0] * 0.6 * sp, q[1] - dir[1] * 0.6 * sp];
  if (!landAt(world, f, from, hint)) from = [q[0] - dir[0] * 0.25 * sp, q[1] - dir[1] * 0.25 * sp];
  if (!landAt(world, f, from, hint)) return null;
  return shoreCrossing(world, from, [q[0] + dir[0] * 0.6 * sp, q[1] + dir[1] * 0.6 * sp], hint, undefined, SHORE_STEPS)?.p ?? null;
}

// 河口那一点的岸线法向与岸线上的那一点（河口本来就在岸线上时就是它）。
// 按画面上的海岸场（同一个 DisplayCoast）记下来：同一个世界再画一遍河（预览、地图、导出）不再重算
interface MouthShore {
  n: Pt;
  p: Pt;
}
const shoreMemo = new WeakMap<DisplayCoast, Map<string, MouthShore | null>>();
export function mouthShore(world: World, f: DisplayCoast, end: readonly [number, number], hint: number): MouthShore | null {
  if (memoActive()) {
    keyStart(Q_MOUTH);
    keyAddPts([end], 0, 1);
    keyAdd(hint);
    const m = memoGet(f);
    if (m !== MISS) return copyShore(m as MouthShore | null);
    const v = mouthShoreRaw(world, f, end, hint);
    memoPut(f, copyShore(v));
    return v;
  }
  let memo = shoreMemo.get(f);
  if (!memo) shoreMemo.set(f, (memo = new Map()));
  const key = `${end[0]},${end[1]},${hint}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const res = mouthShoreRaw(world, f, end, hint);
  memo.set(key, res);
  return res;
}
const copyShore = (v: MouthShore | null): MouthShore | null => v && { n: [v.n[0], v.n[1]], p: [v.p[0], v.p[1]] };
function mouthShoreRaw(world: World, f: DisplayCoast, end: readonly [number, number], hint: number): MouthShore | null {
  const sp = world.mesh.spacing;
  let res: MouthShore | null = null;
  const n0 = seawardNormal(world, f, end, hint);
  // 河口那一点本来就在岸线上（walk、courseIndex 找岸线时走到的那一点，刚过岸线在水面一侧）：直接用它，不必再沿法向找一遍
  if (n0 && !landAt(world, f, end, hint) && landAt(world, f, [end[0] - n0[0] * 0.01 * sp, end[1] - n0[1] * 0.01 * sp], hint)) res = { n: n0, p: [end[0], end[1]] };
  else {
    // 不在岸线上（找岸线没找到、退回到两格中点的）：沿法向走到岸线，按那一点的法向再找一次（挪得不多时不必）
    let e: readonly [number, number] = end;
    for (let it = 0; it < 2; it++) {
      const n = it === 0 ? n0 : seawardNormal(world, f, e, hint);
      if (!n) break;
      const p = shoreAlong(world, f, e, n, hint);
      if (!p) break;
      res = { n, p };
      if (Math.hypot(p[0] - e[0], p[1] - e[1]) < 0.15 * sp) break;
      e = p;
    }
  }
  return res;
}

// 以 c 为圆心、半径 R 的圆与画面上的岸线相交的地方（在水面一侧），按方向离 prefer（单位向量）由近到远排，
// 只要相差不到 135° 的（窄海湾里大河的河口在湾头时，那一侧只有往湾里去的两岸）
export function shoreOnCircle(world: World, f: DisplayCoast, c: readonly [number, number], R: number, prefer: readonly [number, number], hint: number): Pt[] {
  return byPrefer(circleShores(world, f, c, R, hint), prefer);
}

// 圆与岸线的交点（在水面一侧，按取样的先后）：hi 是交点的角度
export function circleShores(world: World, f: DisplayCoast, c: readonly [number, number], R: number, hint: number): { hi: number; p: Pt }[] {
  if (!memoActive()) return circleShoresRaw(world, f, c, R, hint);
  keyStart(Q_CIRCLE);
  keyAddPts([c], 0, 1);
  keyAdd(R);
  keyAdd(hint);
  const m = memoGet(f);
  if (m !== MISS) return copyCircle(m as { hi: number; p: Pt }[]);
  const v = circleShoresRaw(world, f, c, R, hint);
  memoPut(f, copyCircle(v));
  return v;
}
const copyCircle = (v: readonly { hi: number; p: Pt }[]) => v.map((x) => ({ hi: x.hi, p: [x.p[0], x.p[1]] as Pt }));
function circleShoresRaw(world: World, f: DisplayCoast, c: readonly [number, number], R: number, hint: number): { hi: number; p: Pt }[] {
  const N = 32;
  const land: boolean[] = [];
  for (let i = 0; i < N; i++) land.push(landAt(world, f, onCircle(c, R, (2 * Math.PI * i) / N), hint));
  const out: { hi: number; p: Pt }[] = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    if (land[i] === land[j]) continue;
    // 二分到岸线：lo 在陆地一侧
    let lo = (2 * Math.PI * (land[i] ? i : i + 1)) / N;
    let hi = (2 * Math.PI * (land[i] ? i + 1 : i)) / N;
    for (let it = 0; it < 8; it++) {
      const m = (lo + hi) / 2;
      if (landAt(world, f, onCircle(c, R, m), hint)) lo = m;
      else hi = m;
    }
    out.push({ hi, p: onCircle(c, R, hi) });
  }
  return out;
}

const onCircle = (c: readonly [number, number], R: number, a: number): Pt => [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];

// 交点按方向离 prefer 由近到远排，只要相差不到 135° 的
export function byPrefer(list: { hi: number; p: Pt }[], prefer: readonly [number, number]): Pt[] {
  const a0 = Math.atan2(prefer[1], prefer[0]);
  const found: { p: Pt; da: number }[] = [];
  for (const x of list) {
    const da = Math.abs(Math.atan2(Math.sin(x.hi - a0), Math.cos(x.hi - a0)));
    if (da < (3 * Math.PI) / 4) found.push({ p: x.p, da });
  }
  return found.sort((a, b) => a.da - b.da).map((x) => x.p);
}
