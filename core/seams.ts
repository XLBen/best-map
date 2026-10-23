import { wrapDelta, wrapX } from './geo';
import { findCell } from './mesh';
import { type CutResult, cutProvinces } from './select';
import type { World } from './world';

// 切线：剪刀切省时画的线，每个切开的省一条（只留线在那个省里的一段）。切线附近（两边各 1.25 格以内）的像素
// 按“在线的哪一边”决定属于哪个省，所以屏幕上、导出的 provinces.bmp 里切开的两块之间的边界就是画的那条线，
// 而不是格子的边再加自然弯曲。
// 着色器（src/render/renderer.ts 的 FS_SEAM 与 seamCell）与导出（applySeams）用同一条规则：
//   1. 像素按没扭曲的位置找最近的切线段，在带内（距离 < BAND）才管。同样近时段号小的优先（GPU 上按段号依次画、
//      深度测试 LESS）。过了切线真正的两端就不算（两端没有半圆形的帽子）；
//   2. 在线的哪一边：落在线段中间看叉积；落在线段端点外（转角处）用相邻两段法向之和（伪法向），转角两边不会错位；
//   3. 每段两边各是哪个省：两边各取 1.2 格以内、这条切线切开的那几块里的格投票（陆地省 p+1、海域省 −(p+1)；
//      哪一边按格中心最近的段算），取最多的；一边一格都没有时借用同一条切线上最近的段。两边相同（比如后来合并了）、
//      一边陆地一边海、一边的省在另一边也不少时这一段就不起作用。
//      所以切线只在切开的那几块之间换像素（切之前都是同一个省的），邻省的像素一个不动；
//   4. 像素原本按扭曲后的格取省（c）。这一段起作用、c 的数据与它的格中心所在那一侧相符（ok[c]）、
//      c 的省正好是另一边的省时，像素换成这一边的代表格（repL / repR）；否则还是 c。
//      所以后来用涂省改过的格、切的时候并回去的一格碎块，照它们的数据画出来。
// 用到的只是格的省份数组与切线，切线变了、省份变了都当场重算，不进推导。

export interface ProvinceSeam {
  id: string;
  // 画的折线（地图单位），只留在这个省里的那一段；整个星球上沿线展开经度（点可以超出 [0, 2)）
  line: [number, number][];
  // 切开的这个省分成的几块：原来的省在前，切出来的新省依次在后
  provinces: number[];
}

// 一刀记下的切线：切开几个省就记几条，每条只留线在那个省里的一段、只管那个省切出来的几块。
// 一条线连着穿过几个省时，每个省切开的地方都按线画，两省原来的交界不动。
// 新省的编号按命令里新建的顺序（从 nextProvince 起依次加一）；剪刀的预览与切线命令都用它，编号、切线都一样
export function cutSeams(world: World, line: [number, number][], cut: CutResult): Omit<ProvinceSeam, 'id'>[] {
  let next = world.small.nextProvince;
  const lines = seamTrim(world, line, cut.plans.map((pl) => pl.id));
  return cut.plans.map((pl, k) => ({ line: lines[k], provinces: [pl.id, ...pl.parts.slice(1).map(() => next++)] }));
}

// 切了一刀以后的全部切线：原有的切线里记着被切的省的，也管从它切出来的新省（它们原来都是这个省的，
// 再切一刀横过旧的线时，旧线两边的新块之间照样按旧线画）；再加上这一刀的几条。切线命令与剪刀的预览都用它
export function seamsAfterCut(
  existing: readonly ProvinceSeam[] | undefined,
  added: readonly Omit<ProvinceSeam, 'id'>[],
  newId: () => string,
): ProvinceSeam[] {
  let out = existing ?? [];
  for (const sm of added) out = inheritSeams(out, sm.provinces[0], sm.provinces.slice(1));
  return [...out, ...added.map((sm) => ({ id: newId(), ...sm }))];
}

// 省 from 分出了新省 born（剪刀、对半分开）：记着 from 的切线也管 born。不改原来的数组
export function inheritSeams(seams: readonly ProvinceSeam[], from: number, born: readonly number[]): ProvinceSeam[] {
  return seams.map((sm) => (born.length && sm.provinces.includes(from) ? { ...sm, provinces: [...sm.provinces, ...born] } : sm));
}

// 切线管多宽：两边各这么多格距
export const SEAM_BAND = 1.25;
// 每段两边各取这么远以内的格投票
const VOTE = 1.2;
// 段最长多少格（长的段等分，见 seamSegments）
const SEAM_PIECE = 1;
// 格的标记（ok）要看多远的格：带内的像素扭曲后落进的格，格中心离线不会超过这么远
const CELL_REACH = SEAM_BAND + 1.5;
// 化简切线的容差（格距的倍数）与最多几个点（命令的上限）
const SEAM_TOLERANCE = 0.02;
export const SEAM_MAX_POINTS = 2000;

export interface SeamSegments {
  count: number;
  // 端点（地图单位）；整个星球上沿线展开经度
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  // 前一段的起点、后一段的终点（转角处的伪法向用；没有前后段时就是自己的端点）
  px: Float64Array;
  py: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  // 前后还有没有段：没有的那一端是切线真正的端点
  hasPrev: Uint8Array;
  hasNext: Uint8Array;
  // 属于第几条切线
  seam: Int32Array;
}

// 所有切线拆成线段（按切线、再按线上的顺序编号）。几乎为 0 的段（不到万分之一格）去掉：着色器里按单精度算方向会出错。
// 长的段再等分成不超过一格的几段（方向不变，像素离线多远、在哪一边都不变）：每段两边的省是在这一小段附近投票选的，
// 一条直线化简后只剩一段时，线上不同地方两边的省（比如后来又切了一刀，旧线两边换成了新的几块）也各按各的
function seamSegments(world: World, seams: readonly ProvinceSeam[]): SeamSegments {
  const sphere = world.mesh.kind === 'sphere';
  const tiny = 1e-4 * world.mesh.spacing;
  const piece = SEAM_PIECE * world.mesh.spacing;
  const rows: number[][] = [];
  seams.forEach((s, k) => {
    const pts: [number, number][] = [];
    for (const [x, y] of s.line) {
      const prev = pts[pts.length - 1];
      const ux = sphere && prev ? prev[0] + wrapDelta(x - prev[0]) : x;
      const len = prev ? Math.hypot(ux - prev[0], y - prev[1]) : 0;
      if (prev && len < tiny) continue;
      const parts = Math.ceil(len / piece);
      for (let j = 1; j < parts; j++) pts.push([prev[0] + ((ux - prev[0]) * j) / parts, prev[1] + ((y - prev[1]) * j) / parts]);
      pts.push([ux, y]);
    }
    for (let j = 0; j + 1 < pts.length; j++) {
      const p = pts[Math.max(0, j - 1)];
      const q = pts[Math.min(pts.length - 1, j + 2)];
      rows.push([pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1], p[0], p[1], q[0], q[1], j > 0 ? 1 : 0, j + 2 < pts.length ? 1 : 0, k]);
    }
  });
  const m = rows.length;
  const col = (c: number) => Float64Array.from(rows, (r) => r[c]);
  return {
    count: m,
    ax: col(0),
    ay: col(1),
    bx: col(2),
    by: col(3),
    px: col(4),
    py: col(5),
    nx: col(6),
    ny: col(7),
    hasPrev: Uint8Array.from(rows, (r) => r[8]),
    hasNext: Uint8Array.from(rows, (r) => r[9]),
    seam: Int32Array.from(rows, (r) => r[10]),
  };
}

// 点 (x, y) 到第 s 段的距离；在线的哪一边写进 sideOut[0]（1 左、0 右）。点过了切线真正的端点时返回 −1。
// 与着色器 FS_SEAM 一步一步相同
const sideOut = new Uint8Array(1);
function segDist(S: SeamSegments, s: number, x: number, y: number): number {
  const ax = S.ax[s];
  const ay = S.ay[s];
  const ex = S.bx[s] - ax;
  const ey = S.by[s] - ay;
  const qx = x - ax;
  const qy = y - ay;
  const t = (qx * ex + qy * ey) / (ex * ex + ey * ey);
  if (t < 0 && !S.hasPrev[s]) return -1;
  if (t > 1 && !S.hasNext[s]) return -1;
  if (t > 0 && t < 1) {
    sideOut[0] = ex * qy - ey * qx > 0 ? 1 : 0;
    return Math.hypot(qx - ex * t, qy - ey * t);
  }
  // 端点外（转角处）：到端点的距离；哪一边按两段法向之和
  const start = t <= 0;
  const vx = start ? ax : S.bx[s];
  const vy = start ? ay : S.by[s];
  const [sx, sy] = normal(ex, ey);
  const [ox, oy] = start ? normal(ax - S.px[s], ay - S.py[s]) : normal(S.nx[s] - vx, S.ny[s] - vy);
  let nx = sx + ox;
  let ny = sy + oy;
  if (nx * nx + ny * ny < 1e-8) {
    nx = sx;
    ny = sy;
  }
  const rx = x - vx;
  const ry = y - vy;
  sideOut[0] = rx * nx + ry * ny > 0 ? 1 : 0;
  return Math.hypot(rx, ry);
}

// 左手边的单位法向（长度为 0 时为 0）
function normal(ex: number, ey: number): [number, number] {
  const l = Math.hypot(ex, ey);
  return l > 0 ? [-ey / l, ex / l] : [0, 0];
}

export interface SeamLayers {
  segs: SeamSegments;
  // 带宽（地图单位）
  band: number;
  // 每段两边的省（分组值，见 groupValue）与代表格；不起作用的段 gL = gR = 0、代表格 −1
  gL: Float64Array;
  gR: Float64Array;
  repL: Int32Array;
  repR: Int32Array;
  // 每格：格中心在离它最近的那段的哪一边，这一边的省就是它自己的省（切线规则可以换掉它）
  ok: Uint8Array;
  // 算的时候用的省份数组与陆海（像素规则要用格的分组值）
  province: Int32Array;
  land: Uint8Array;
  // 找附近线段用的网格与整个星球上要试的平移（x 加 2 的倍数）
  grid: SegGrid;
  shifts: number[];
}

// 分组值：陆地省份 = 编号 + 1，海域省份 = −(编号 + 1)，未划分 = 0（与着色器的省界编码相同）
function groupValue(province: Int32Array, land: Uint8Array, i: number): number {
  const p = province[i];
  return p < 0 ? 0 : land[i] ? p + 1 : -(p + 1);
}

// 附近线段的网格：每段放进它外接矩形外扩 size 盖住的所有格子，查一点时只看它所在的那个格子
interface SegGrid {
  size: number;
  lists: Map<number, number[]>;
}
const gridKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

function buildGrid(S: SeamSegments, size: number): SegGrid {
  const lists = new Map<number, number[]>();
  for (let s = 0; s < S.count; s++) {
    const x0 = Math.floor((Math.min(S.ax[s], S.bx[s]) - size) / size);
    const x1 = Math.floor((Math.max(S.ax[s], S.bx[s]) + size) / size);
    const y0 = Math.floor((Math.min(S.ay[s], S.by[s]) - size) / size);
    const y1 = Math.floor((Math.max(S.ay[s], S.by[s]) + size) / size);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = gridKey(cx, cy);
        let l = lists.get(k);
        if (!l) lists.set(k, (l = []));
        l.push(s);
      }
    }
  }
  return { size, lists };
}

// 整个星球：图上一点（x 在 [0, 2) 里）要和平移了 2 的几倍的线段比（线段展开后可能超出 [0, 2)）
function shiftsOf(world: World, S: SeamSegments, reach: number): number[] {
  if (world.mesh.kind !== 'sphere' || !S.count) return [0];
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let s = 0; s < S.count; s++) {
    x0 = Math.min(x0, S.ax[s], S.bx[s]);
    x1 = Math.max(x1, S.ax[s], S.bx[s]);
  }
  const out: number[] = [];
  for (let c = Math.ceil((-x1 - reach) / 2); c <= Math.floor((2 - x0 + reach) / 2); c++) out.push(2 * c);
  return out;
}

// 最近的线段（maxD 以内，不含）：返回段号（没有为 −1），哪一边写进 sideOut[0]。
// 先试的平移、编号小的段在同样近时优先（与 GPU 一致）
function nearest(L: SeamLayers, x: number, y: number, maxD: number): number {
  let best = -1;
  let bestD = maxD;
  let bestSide = 0;
  const g = L.grid;
  for (const shift of L.shifts) {
    const qx = x - shift;
    const list = g.lists.get(gridKey(Math.floor(qx / g.size), Math.floor(y / g.size)));
    if (!list) continue;
    for (const s of list) {
      const d = segDist(L.segs, s, qx, y);
      if (d >= 0 && d < bestD) {
        bestD = d;
        best = s;
        bestSide = sideOut[0];
      }
    }
  }
  sideOut[0] = bestSide;
  return best;
}

// 每段两边的省、代表格与每格的标记。没有切线时返回 null。
// province 可以是预览里改过的省份数组（剪刀拖动时：现有的切线加上正在画的这条）
export function seamLayers(world: World, province: Int32Array, seams: readonly ProvinceSeam[] | undefined): SeamLayers | null {
  if (!seams?.length) return null;
  const S = seamSegments(world, seams);
  if (!S.count) return null;
  const { mesh, causes } = world;
  const sp = mesh.spacing;
  const reach = CELL_REACH * sp;
  const vote = VOTE * sp;
  const sphere = mesh.kind === 'sphere';
  const m = S.count;
  const L: SeamLayers = {
    segs: S,
    band: SEAM_BAND * sp,
    gL: new Float64Array(m),
    gR: new Float64Array(m),
    repL: new Int32Array(m).fill(-1),
    repR: new Int32Array(m).fill(-1),
    ok: new Uint8Array(mesh.n),
    province,
    land: causes.land,
    grid: buildGrid(S, reach),
    shifts: shiftsOf(world, S, reach),
  };
  // 1. 线附近的格：沿每段每半格找一格，再往外扩到离这一段 reach 以内
  const seen = new Int32Array(mesh.n);
  const near: number[] = [];
  const inNear = new Uint8Array(mesh.n);
  let hint = 0;
  for (let s = 0; s < m; s++) {
    const ax = S.ax[s];
    const ay = S.ay[s];
    const ex = S.bx[s] - ax;
    const ey = S.by[s] - ay;
    const len2 = ex * ex + ey * ey;
    const mid = ax + ex / 2;
    const dist = (c: number) => {
      const x = sphere ? mesh.x[c] + 2 * Math.round((mid - mesh.x[c]) / 2) : mesh.x[c];
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (mesh.y[c] - ay) * ey) / len2));
      return Math.hypot(x - ax - ex * t, mesh.y[c] - ay - ey * t);
    };
    const queue: number[] = [];
    const steps = Math.max(1, Math.ceil(Math.sqrt(len2) / (0.5 * sp)));
    for (let j = 0; j <= steps; j++) {
      const y = ay + (ey * j) / steps;
      if (y < 0 || y > mesh.height || (!sphere && (ax + (ex * j) / steps < 0 || ax + (ex * j) / steps > mesh.width))) continue;
      hint = findCell(mesh, ax + (ex * j) / steps, y, hint);
      if (seen[hint] !== s + 1) {
        seen[hint] = s + 1;
        queue.push(hint);
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const c = queue[h];
      if (!inNear[c]) {
        inNear[c] = 1;
        near.push(c);
      }
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (seen[j] === s + 1) continue;
        seen[j] = s + 1;
        if (dist(j) <= reach) queue.push(j);
      }
    }
  }
  near.sort((a, b) => a - b);
  // 2. 每格离它最近的段与在哪一边；给 1.2 格以内的每一段投票。投的是“在最近那一段的哪一边”：
  //    转弯处，一格在前一段端点外看像在左边，其实在后一段的右边（像素规则也按最近的段算）。
  //    只有这条切线切开的几块里的格投票（切之前它们是同一个省）：线贴着邻省走时，那一边仍是切开的那一块，
  //    邻省的格再多也不算，邻省的像素一个不动
  const pieces = seams.map((sm) => new Set(sm.provinces));
  const votes: Map<number, number>[][] = Array.from({ length: m }, () => [new Map(), new Map()]);
  const voters: number[][][] = Array.from({ length: m }, () => [[], []]);
  const cellSeg = new Int32Array(near.length);
  const cellSide = new Uint8Array(near.length);
  near.forEach((c, k) => {
    const x = mesh.x[c];
    const y = mesh.y[c];
    cellSeg[k] = nearest(L, x, y, reach);
    const side = (cellSide[k] = sideOut[0]);
    if (cellSeg[k] < 0) return;
    const g = groupValue(province, causes.land, c);
    for (const shift of L.shifts) {
      const list = L.grid.lists.get(gridKey(Math.floor((x - shift) / L.grid.size), Math.floor(y / L.grid.size)));
      if (!list) continue;
      for (const s of list) {
        if (!pieces[S.seam[s]].has(province[c])) continue;
        const d = segDist(S, s, x - shift, y);
        if (d < 0 || d >= vote) continue;
        votes[s][side].set(g, (votes[s][side].get(g) ?? 0) + 1);
        voters[s][side].push(c);
      }
    }
  });
  // 3. 每段两边的省：票最多的（一样多时取分组值小的）；代表格取这个省里离段中点最近的投票格
  const has = [new Uint8Array(m), new Uint8Array(m)];
  const gs = [L.gR, L.gL];
  const reps = [L.repR, L.repL];
  for (let s = 0; s < m; s++) {
    for (const side of [0, 1]) {
      let best = 0;
      let bestN = 0;
      for (const [g, n] of votes[s][side]) {
        if (n > bestN || (n === bestN && g < best)) {
          best = g;
          bestN = n;
        }
      }
      if (!bestN) continue;
      has[side][s] = 1;
      gs[side][s] = best;
      const mx = (S.ax[s] + S.bx[s]) / 2;
      const my = (S.ay[s] + S.by[s]) / 2;
      let rep = -1;
      let rd = Infinity;
      for (const c of voters[s][side]) {
        if (groupValue(province, causes.land, c) !== best) continue;
        const x = sphere ? mesh.x[c] + 2 * Math.round((mx - mesh.x[c]) / 2) : mesh.x[c];
        const d = (x - mx) ** 2 + (mesh.y[c] - my) ** 2;
        if (d < rd || (d === rd && c < rep)) {
          rd = d;
          rep = c;
        }
      }
      reps[side][s] = rep;
    }
  }
  // 一边一格都没有的段：借同一条切线上最近的段（一样近时取前面的）
  for (const side of [0, 1]) {
    const own = has[side].slice();
    for (let s = 0; s < m; s++) {
      if (own[s]) continue;
      for (let k = 1; k < m; k++) {
        const from = [s - k, s + k].find((j) => j >= 0 && j < m && S.seam[j] === S.seam[s] && own[j]);
        if (from !== undefined) {
          has[side][s] = 1;
          gs[side][s] = gs[side][from];
          reps[side][s] = reps[side][from];
          break;
        }
        if ((s - k < 0 || S.seam[s - k] !== S.seam[s]) && (s + k >= m || S.seam[s + k] !== S.seam[s])) break;
      }
    }
  }
  // 这一段不起作用的几种情况：
  //   · 两边是同一个省（比如后来合并了）、有一边没有切开的那几块（比如后来并进了别的省）；
  //   · 一边陆地一边海（线穿过海岸的那几段）：只在两个陆地省或两个海域省之间换格，陆地像素不会换成海上的格；
  //   · 一边的省在另一边也占了不少（超过四分之一）：线在这里不是两块的边界
  const mixed = (s: number, side: number, g: number) => {
    let total = 0;
    for (const n of votes[s][side].values()) total += n;
    return (votes[s][side].get(g) ?? 0) > 0.25 * total;
  };
  for (let s = 0; s < m; s++) {
    if (has[0][s] && has[1][s] && L.gL[s] !== L.gR[s] && L.gL[s] * L.gR[s] > 0 && !mixed(s, 0, L.gL[s]) && !mixed(s, 1, L.gR[s])) continue;
    L.gL[s] = 0;
    L.gR[s] = 0;
    L.repL[s] = -1;
    L.repR[s] = -1;
  }
  // 4. 每格的标记：格中心所在那一边的省就是它自己的省
  near.forEach((c, k) => {
    const s = cellSeg[k];
    if (s < 0 || L.gL[s] === L.gR[s]) return;
    L.ok[c] = groupValue(province, causes.land, c) === (cellSide[k] ? L.gL[s] : L.gR[s]) ? 1 : 0;
  });
  return L;
}

// 像素规则：c 是像素按扭曲后的位置取的格，seg / side 是像素（没扭曲的位置）最近的段与在哪一边。返回像素该取的格
function seamPixel(L: SeamLayers, c: number, seg: number, side: number): number {
  if (seg < 0 || c < 0) return c;
  const gl = L.gL[seg];
  const gr = L.gR[seg];
  if (gl === gr || !L.ok[c]) return c;
  if (groupValue(L.province, L.land, c) !== (side ? gr : gl)) return c;
  return side ? L.repL[seg] : L.repR[seg];
}

// 地图上一点（没扭曲的位置）该算哪一格：c 是这一点原本取的格（选省、涂省时鼠标下的格），切线附近按显示出来的那一边换
export function seamPick(L: SeamLayers | null, world: World, x: number, y: number, c: number): number {
  if (!L || c < 0) return c;
  const seg = nearest(L, world.mesh.kind === 'sphere' ? wrapX(x) : x, y, L.band);
  return seamPixel(L, c, seg, sideOut[0]);
}

// 导出：provinces.bmp 的每个像素取哪一格。cell 是 rasterizeWorld 按扭曲后的位置取的格；
// 带内的像素按同一条规则换格。逐行处理：每行只看带盖住这一行的那些段，按段号（再按平移）依次比，
// 严格更近才换（与 GPU 按段号依次画、深度测试 LESS 相同）。没有切线时原样返回 cell
export function applySeams(world: World, L: SeamLayers | null, cell: Int32Array, width: number, height: number): Int32Array {
  if (!L) return cell;
  const { mesh } = world;
  const S = L.segs;
  const kx = width / mesh.width;
  const ky = height / mesh.height;
  const band = L.band;
  const out = cell.slice();
  // 每段（每个平移）在图上盖住的像素范围，按行登记
  const rows: number[][] = Array.from({ length: height }, () => []);
  const boxes: { s: number; shift: number; x0: number; x1: number }[] = [];
  for (let s = 0; s < S.count; s++) {
    for (const shift of L.shifts) {
      const x0 = Math.max(0, Math.floor((Math.min(S.ax[s], S.bx[s]) + shift - band) * kx));
      const x1 = Math.min(width - 1, Math.ceil((Math.max(S.ax[s], S.bx[s]) + shift + band) * kx));
      const y0 = Math.max(0, Math.floor((Math.min(S.ay[s], S.by[s]) - band) * ky));
      const y1 = Math.min(height - 1, Math.ceil((Math.max(S.ay[s], S.by[s]) + band) * ky));
      if (x0 > x1 || y0 > y1) continue;
      const b = boxes.length;
      boxes.push({ s, shift, x0, x1 });
      for (let py = y0; py <= y1; py++) rows[py].push(b);
    }
  }
  const bestD = new Float64Array(width);
  const bestSeg = new Int32Array(width);
  const bestSide = new Uint8Array(width);
  for (let py = 0; py < height; py++) {
    const list = rows[py];
    if (!list.length) continue;
    let lo = width;
    let hi = -1;
    for (const b of list) {
      lo = Math.min(lo, boxes[b].x0);
      hi = Math.max(hi, boxes[b].x1);
    }
    bestD.fill(band, lo, hi + 1);
    bestSeg.fill(-1, lo, hi + 1);
    const y = (py + 0.5) / ky;
    for (const b of list) {
      const { s, shift, x0, x1 } = boxes[b];
      for (let px = x0; px <= x1; px++) {
        const d = segDist(S, s, (px + 0.5) / kx - shift, y);
        if (d >= 0 && d < bestD[px]) {
          bestD[px] = d;
          bestSeg[px] = s;
          bestSide[px] = sideOut[0];
        }
      }
    }
    for (let px = lo; px <= hi; px++) {
      if (bestSeg[px] < 0) continue;
      const p = py * width + px;
      out[p] = seamPixel(L, cell[p], bestSeg[px], bestSide[px]);
    }
  }
  return out;
}

// 导出用的省份像素：带切线规则。哪个省因此一个像素都分不到（游戏不认没有像素的省），
// 就去掉碰到它的那几条切线（那里按格的边界画），并说一声
export function exportProvinceCells(world: World, cell: Int32Array, width: number, height: number): { cell: Int32Array; warnings: string[] } {
  const all = world.small.provinceSeams;
  if (!all?.length) return { cell, warnings: [] };
  const { causes, small } = world;
  // 哪些省有像素（按编号标记：大图有几千万个像素，不用集合）
  let top = 0;
  for (let i = 0; i < causes.province.length; i++) top = Math.max(top, causes.province[i]);
  const seenIn = (pix: Int32Array) => {
    const seen = new Uint8Array(top + 1);
    for (let p = 0; p < pix.length; p++) {
      const c = pix[p];
      if (c >= 0 && causes.province[c] >= 0) seen[causes.province[c]] = 1;
    }
    return seen;
  };
  const present = seenIn(cell);
  let seams = all;
  const warnings: string[] = [];
  for (;;) {
    const L = seamLayers(world, causes.province, seams);
    const out = applySeams(world, L, cell, width, height);
    if (!L) return { cell: out, warnings };
    const now = seenIn(out);
    const lost: number[] = [];
    for (let id = 0; id <= top; id++) if (present[id] && !now[id]) lost.push(id);
    if (!lost.length) return { cell: out, warnings };
    const groups = new Set(lost.map((id) => (small.provinces[id]?.land ? id + 1 : -(id + 1))));
    const drop = new Set<number>();
    for (let s = 0; s < L.segs.count; s++) if (groups.has(L.gL[s]) || groups.has(L.gR[s])) drop.add(L.segs.seam[s]);
    if (!drop.size) return { cell: out, warnings };
    for (const id of lost) warnings.push(`省份“${small.provinces[id]?.name || id}”太小，按剪刀画的线分不到像素：导出时它那里的边界按格子画`);
    seams = seams.filter((_, k) => !drop.has(k));
  }
}

// 剪刀：界面上画的线 → 命令里的线（两端按需延长、再化简）与切出来的块。拖动时的预览与松手后的命令用同一条线、
// 同一个算法（命令里不再延长），所以预览就是结果：ext 是延长后的线（画虚线用），cut 是命令会切出来的块，
// seams 是命令会记下的切线（cutSeams：每个切开的省一条，与切出来的新省的编号）
export function scissors(
  world: World,
  raw: [number, number][],
): { ext: CutResult; line: [number, number][]; cut: CutResult; seams: Omit<ProvinceSeam, 'id'>[] } {
  const ext = cutProvinces(world, raw);
  const line = seamLine(world, ext.line);
  const cut = cutProvinces(world, line, { extend: false });
  return { ext, line, cut, seams: cutSeams(world, line, cut) };
}

// 记下的切线只留真正切开省的那一段：从线第一次进入这个省（切之前的省份）到最后一次离开。
// 线头伸进邻省、线穿过别的省的那几段不要，那里的边界照旧按格画。沿线每 0.1 格看一次，
// ids 里的每个省各给一段（线只走一遍：一条长线切开几十个省时也不慢）
function seamTrim(world: World, line: [number, number][], ids: readonly number[]): [number, number][][] {
  const { mesh, causes } = world;
  const sphere = mesh.kind === 'sphere';
  const step = 0.1 * mesh.spacing;
  const want = new Set(ids);
  const span = new Map<number, { first: { k: number; p: [number, number] }; last: { k: number; p: [number, number] } }>();
  let hint = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const [x0, y0] = line[k];
    const [x1, y1] = line[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = k === 0 ? 0 : 1; j <= steps; j++) {
      const p: [number, number] = j === steps ? [x1, y1] : [x0 + ((x1 - x0) * j) / steps, y0 + ((y1 - y0) * j) / steps];
      if (p[1] < 0 || p[1] > mesh.height || (!sphere && (p[0] < 0 || p[0] > mesh.width))) continue;
      hint = findCell(mesh, p[0], p[1], hint);
      const id = causes.province[hint];
      if (!want.has(id)) continue;
      const e = span.get(id);
      if (e) e.last = { k, p };
      else span.set(id, { first: { k, p }, last: { k, p } });
    }
  }
  return ids.map((id) => {
    const e = span.get(id);
    if (!e) return line;
    const { first, last } = e;
    // 线只碰到这个省一点：留下碰到的那一段
    if (first === last) return [line[first.k], line[first.k + 1]];
    const out: [number, number][] = [first.p];
    for (const q of [...line.slice(first.k + 1, last.k + 1), last.p]) {
      const prev = out[out.length - 1];
      if (q[0] !== prev[0] || q[1] !== prev[1]) out.push(q);
    }
    return out.length >= 2 ? out : [line[first.k], line[first.k + 1]];
  });
}

// 界面上画好的线变成切线命令里的线：整个星球上把第一个点挪回 [0, 2)（整条线一起挪，线还是连着的），
// 再按 0.02 格的容差化简（Douglas–Peucker），点太多时放宽容差直到不超过上限。预览与命令用同一条线，所以切出来一样
function seamLine(world: World, line: [number, number][]): [number, number][] {
  if (line.length < 2) return line;
  const shift = world.mesh.kind === 'sphere' ? line[0][0] - wrapX(line[0][0]) : 0;
  let pts: [number, number][] = line.map(([x, y]) => [x - shift, y]);
  let tol = SEAM_TOLERANCE * world.mesh.spacing;
  for (;;) {
    const out = simplify(pts, tol);
    if (out.length <= SEAM_MAX_POINTS) return out;
    pts = out;
    tol *= 2;
  }
}

// Douglas–Peucker：保留两端，离弦超过 tol 的点留下
function simplify(pts: [number, number][], tol: number): [number, number][] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = pts[i];
    const ex = pts[j][0] - ax;
    const ey = pts[j][1] - ay;
    const len2 = ex * ex + ey * ey;
    let far = -1;
    let fd = tol;
    for (let k = i + 1; k < j; k++) {
      const qx = pts[k][0] - ax;
      const qy = pts[k][1] - ay;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (qx * ex + qy * ey) / len2)) : 0;
      const d = Math.hypot(qx - ex * t, qy - ey * t);
      if (d > fd) {
        fd = d;
        far = k;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([i, far], [far, j]);
  }
  return pts.filter((_, k) => keep[k]);
}

// 去掉有一个点落在这些省里、或者切开的省里有这些省的切线（重新划分了那一片）；全去掉了就删掉这一项
export function dropSeams(world: World, inside: (province: number) => boolean) {
  const { small, mesh, causes } = world;
  if (!small.provinceSeams) return;
  let hint = 0;
  const kept = small.provinceSeams.filter(
    (s) =>
      !s.provinces.some(inside) &&
      s.line.every(([x, y]) => {
        if (y < 0 || y > mesh.height || (mesh.kind !== 'sphere' && (x < 0 || x > mesh.width))) return true;
        hint = findCell(mesh, x, y, hint);
        return !inside(causes.province[hint]);
      }),
  );
  if (kept.length) small.provinceSeams = kept;
  else delete small.provinceSeams;
}
