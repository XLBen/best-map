// 河口（第八十三轮从 core/rivers.ts 原样搬出）：沿法向进海、挪开挤在一起的河口、并成一个河口
import type { World } from './world';
import type { DisplayCoast } from './display';
import { type RiverLine, type Pt, lineLength, dirAt, hermite, maxTurn, before, TURN_CHORD, MOUTH_MAX_TURN, backAlong, snapOnto, segProject, segCross, markJoin } from './rivers-line';
import { shoreAlong, allLand, mouthShore, landAt, shoreCross, SHORE_STEPS, seawardNormal, shoreOnCircle } from './rivers-shore';

// ---------- 河口（第十三轮） ----------
// 河口那一段沿岸线的法向进海、进湖：原来最后一段对着它流进的那格水的格心，斜着碰到岸线（中位数约 22°，一成多超过 45°），
// 平头的末端就跨在岸线上。现在从河口往回约 0.9 格起，用一段三次 Hermite 曲线接到岸线上（起点顺着原来的方向，
// 终点沿岸线的法向），终点是从岸上沿法向走到岸线的那一点。只改画法（屏幕、导出），水文、流向都不变。
// 法向与原来的方向差得太多（超过 70°）时往原来的方向偏回来；接出来的一段在河口附近急转（超过 60°）时换长一点的一段，
// 还不行就照原来的样子画（河口附近从不画出钩子）

// 河口往回多长（格）换成沿法向进海的一段；急转时再试长一点的
const MOUTH_LEGS = [0.9, 1.4, 2];
// 进水的方向与原来的方向最多差多少（度）
const END_TURN = 70;

// 入海、入湖的线的最后一段接到岸线上的 p（那里岸线的法向 n）：从河口往回约 leg 格的那一点（第 k 个点，keep 与别的河汇进来的地方以前不动；
// keep 为负时汇进来的地方也可以动）
// 起一段曲线。返回接出来的点（不含第 k 个点）；有一点在水里、转得太急时为 null
function mouthLeg(world: World, f: DisplayCoast, line: RiverLine, keep: number, n: Pt, p: Pt, leg: number, cap = 0.4, checkTurn = true): { k: number; pts: Pt[] } | null {
  const sp = world.mesh.spacing;
  const P = line.points;
  const m = P.length;
  if (m < 2) return null;
  const hint = line.cells?.[m - 1] ?? 0;
  // keep 为负：别的河汇进来的地方也可以动（调用的一方之后把它们重新接上）
  let lim = Math.max(0, keep);
  if (keep >= 0) for (const pos of line.joins ?? []) lim = Math.max(lim, Math.ceil(pos));
  let k = m - 1;
  let s = 0;
  // 短的线（比如分出去的一小股）最多换掉后四成（cap），前面照原来的走向
  const len = Math.min(leg * sp, cap * lineLength(P));
  while (k > lim && k > 0 && s < len) {
    s += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    k--;
  }
  if (k >= m - 1) return null;
  const A = P[k];
  const t = dirAt(P, k);
  if (k === 0) {
    const l = Math.hypot(P[1][0] - A[0], P[1][1] - A[1]) || 1;
    t[0] = (P[1][0] - A[0]) / l;
    t[1] = (P[1][1] - A[1]) / l;
  }
  // 进水的方向：岸线的法向；与原来的方向差得超过 70° 时往原来的方向偏回来（贴着岸线走的不改）
  let d: Pt = n;
  let end: Pt = p;
  if (t[0] * n[0] + t[1] * n[1] < Math.cos((END_TURN * Math.PI) / 180)) {
    const a = ((t[0] * n[1] - t[1] * n[0] >= 0 ? 1 : -1) * END_TURN * Math.PI) / 180;
    d = [t[0] * Math.cos(a) - t[1] * Math.sin(a), t[0] * Math.sin(a) + t[1] * Math.cos(a)];
    if (d[0] * n[0] + d[1] * n[1] < 0.34) return null;
    const q = shoreAlong(world, f, p, d, hint);
    if (!q) return null;
    end = q;
  }
  const L = Math.hypot(end[0] - A[0], end[1] - A[1]);
  if (L < 0.15 * sp) return null;
  // 最后一小段（约 0.35 格）是沿进水方向的直线，之前用曲线从原来的方向弯过来
  const straight = Math.min(0.35 * sp, 0.4 * L);
  const Q: Pt = [end[0] - d[0] * straight, end[1] - d[1] * straight];
  const pts = hermite(A, t, Q, d, sp / 8);
  const ns = Math.max(1, Math.ceil(straight / (sp / 8)));
  for (let j = 1; j <= ns; j++) pts.push(j === ns ? [end[0], end[1]] : [Q[0] + (end[0] - Q[0]) * (j / ns), Q[1] + (end[1] - Q[1]) * (j / ns)]);
  if (!allLand(world, f, pts, pts.length - 1, hint)) return null;
  if (checkTurn && maxTurn([...before(P, k, sp), ...pts], TURN_CHORD * sp) > MOUTH_MAX_TURN) return null;
  return { k, pts };
}

// 把线的第 k 个点以后换成 pts（流量从第 k 点的渐变到原来最后一点的；格、类型前一半按第 k 点、后一半按原来最后一点）
function applyLeg(line: RiverLine, k: number, pts: Pt[]): void {
  const P = line.points;
  const m = P.length;
  const count = pts.length;
  const f0 = line.flow[k];
  const f1 = line.flow[m - 1];
  const keepN = k + 1;
  const points = P.slice(0, keepN);
  for (const q of pts) points.push(q);
  line.points = points;
  const flow = line.flow.slice(0, keepN);
  for (let j = 0; j < count; j++) flow.push(f0 + ((f1 - f0) * (j + 1)) / count);
  line.flow = flow;
  const halves = <T>(arr: T[]) => {
    const out = arr.slice(0, keepN);
    for (let j = 0; j < count; j++) out.push((j + 1) / count < 0.5 ? arr[k] : arr[m - 1]);
    return out;
  };
  if (line.cells) line.cells = halves(line.cells);
  if (line.type) line.type = halves(line.type);
  if (line.mul) {
    const m0 = line.mul[k];
    const m1 = line.mul[m - 1];
    const mul = line.mul.slice(0, keepN);
    for (let j = 0; j < count; j++) mul.push(m0 + ((m1 - m0) * (j + 1)) / count);
    line.mul = mul;
  }
}

// 入海、入湖的线（最后一点在岸线上）：最后约 0.9 格换成沿岸线法向进水的一段（见上）。keep：这一点以前不能动
// （别的河在那里汇进来）。法向量不出来、接出来的一段有一点在水里、转得太急时不改
export function normalMouth(world: World, f: DisplayCoast, line: RiverLine, keep: number): void {
  const P = line.points;
  const m = P.length;
  if (m < 2) return;
  const ms = mouthShore(world, f, P[m - 1], line.cells?.[m - 1] ?? 0);
  const sp = world.mesh.spacing;
  // 接好以后最后 1.5 格里转得急不急（原来的线在接出来的一段之前就急转时，换长一点的一段把它也磨圆）
  // （接出来的一段与原来的线接上的地方也量：往前带上约 0.3 格）
  const smooth = (r: { k: number; pts: Pt[] }) => {
    const head = P.slice(backAlong(P.slice(0, r.k + 1), Math.max(0.3 * sp, 1.8 * sp - lineLength(r.pts))).k, r.k + 1);
    const Q = [...head, ...r.pts];
    return maxTurn(Q, TURN_CHORD * sp, Math.max(0, Math.min(lineLength(Q) - 1.5 * sp, lineLength(head) - 0.3 * sp))) <= MOUTH_MAX_TURN;
  };
  let first: { k: number; pts: Pt[] } | null = null;
  if (ms) {
    for (const leg of MOUTH_LEGS) {
      const r = mouthLeg(world, f, line, keep, ms.n, ms.p, leg, 0.4, false);
      if (!r) continue;
      if (smooth(r)) return applyLeg(line, r.k, r.pts);
      // 原来的线在更早的地方就急转：接出来的这一段本身不急转的话先留着
      if (!first && maxTurn([...before(P, r.k, sp), ...r.pts], TURN_CHORD * sp) <= MOUTH_MAX_TURN) first = r;
    }
  }
  if (!first) {
    const tail = P.slice(backAlong(P, 1.8 * sp).k);
    if (maxTurn(tail, TURN_CHORD * sp, lineLength(tail) - 1.5 * sp) <= MOUTH_MAX_TURN) return;
  }
  // 沿法向接过去还是（或者接不过去、原来的线）在河口附近急转：照原来的河口那一点，把急转磨圆（进水的方向按原来最后一段，偏得太多时偏回来）
  const e = P[m - 1];
  const t = dirAt(P, m - 1);
  for (const leg of MOUTH_LEGS.slice(1)) {
    const r = mouthLeg(world, f, line, keep, t, [e[0], e[1]], leg, 0.4, false);
    if (r && smooth(r)) return applyLeg(line, r.k, r.pts);
  }
  // 还不行（河顺着岸走到河口，水在身后）：从往回约一格的那一点顺着河的方向（左右各偏到 60°）往前找最近的岸线，在那里入海
  const hint = line.cells?.[m - 1] ?? 0;
  const A = backAlong(P, MOUTH_LEGS[0] * sp);
  const ta = dirAt(P, Math.min(m - 1, A.k + 1));
  if (landAt(world, f, A.p, hint)) {
    let best: Pt | null = null;
    let bd = Infinity;
    for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
      const a = (deg * Math.PI) / 180;
      const dir: Pt = [ta[0] * Math.cos(a) - ta[1] * Math.sin(a), ta[0] * Math.sin(a) + ta[1] * Math.cos(a)];
      const hit = shoreCross(world, f, A.p, [A.p[0] + dir[0] * 2 * sp, A.p[1] + dir[1] * 2 * sp], hint, SHORE_STEPS);
      if (hit && hit.t < bd) {
        bd = hit.t;
        best = hit.p;
      }
    }
    const n = best && seawardNormal(world, f, best, hint);
    if (best && n) {
      for (const leg of MOUTH_LEGS) {
        const r = mouthLeg(world, f, line, keep, n, best, leg, 0.4, false);
        if (r && smooth(r)) return applyLeg(line, r.k, r.pts);
      }
    }
  }
  if (first) applyLeg(line, first.k, first.pts);
}

// 海岸边的源头小河：从源头到入海不到这么长（格）的不画（画出来只是岸边一个尖尖的楔子）
export const STUB_LEN = 1.5;
// 两个入海的河口至少相隔这么远（格）：再近就挤在一起，两条河画成一个“V”
export const MOUTH_SEP = 0.6;
// 挤在一起时，小河的河口沿岸挪到离大河的河口这么远（格），从河口往回这么远（格）起改
const SHIFT_TRIES = [0.75, 1.1];
const SHIFT_LEGS = [1.2, 1.8, 2.4];
// 挪不开时并进大河（只在接得顺的时候）：接在大河河口往回这么远（离岸线不到 0.3 格），小河从河口往回这么远起改（格）；
// 并进去的角度（小河最后约 0.3 格的方向与大河的方向）最多多少（度）
const JOIN_BACK = [0.2, 0.3, 0.1];
// 并进去的那段曲线两头切向的倍数（见 hermite），依次试
const JOIN_SHAPES: [number, number][] = [
  [1, 1],
  [0.5, 1.5],
  [0, 0],
];
const JOIN_TRIM = [0.6, 0.9, 1.4, 2];
const JOIN_ANGLE = 35;

// 自然的河的河口收拾一下（第十三轮，只改画法）：去掉海岸边不到 1.5 格的源头小河；河口挤在一起（不到 0.6 格）的，
// 小的沿岸挪开、各自入海；挪不开时只在接得顺（并进去的角度不到 35°、接在离岸线 0.3 格以内、不往回拐）时画成在岸边汇入大的，
// 再不行把大的河口往另一侧挪开；都不行就照原样。返回留下的线，into 按新的下标。deferred：还没改成沿法向进水的源头小河（留下来的在这里补上）
export function tidyMouths(world: World, lines: RiverLine[], field: DisplayCoast, deferred: Set<RiverLine>, orig: Map<RiverLine, RiverLine>): RiverLine[] {
  const { mesh, causes, derived: d } = world;
  const sp = mesh.spacing;
  const sphere = mesh.kind === 'sphere';
  const seaOf = (l: RiverLine) => {
    if (!l.mouth || !l.cells?.length) return -1;
    const r = d.receiver[l.cells[l.cells.length - 1]];
    return r >= 0 && !causes.land[r] ? r : -1;
  };
  // 小河连同汇进它的（也都是不到 1.5 格的源头小河）一起不画；有别的河（比如画的河接出来的）汇进来的照画
  const kids: number[][] = lines.map(() => []);
  lines.forEach((l, i) => {
    if (l.into !== undefined && l.into !== i) kids[l.into]?.push(i);
  });
  const small = (i: number, depth: number): boolean => {
    const l = lines[i];
    if (l.head !== 'source' || lineLength(l.points) >= STUB_LEN * sp || depth > 8) return false;
    if ((l.joins?.length ?? 0) > kids[i].length) return false;
    return kids[i].every((j) => small(j, depth + 1));
  };
  const keep = lines.map(() => true);
  const drop = (i: number) => {
    keep[i] = false;
    for (const j of kids[i]) drop(j);
  };
  lines.forEach((l, i) => {
    if (seaOf(l) >= 0 && small(i, 0)) drop(i);
  });
  // 留下来的短河（流进湖的、有别的河汇进来的）补上沿法向进水
  lines.forEach((l, i) => {
    if (keep[i] && deferred.has(l)) normalMouth(world, field, l, 0);
  });
  const endFlow = (l: RiverLine) => l.flow[l.flow.length - 1];
  const mouths: number[] = [];
  lines.forEach((l, i) => {
    if (keep[i] && seaOf(l) >= 0) mouths.push(i);
  });
  mouths.sort((a, b) => endFlow(lines[b]) - endFlow(lines[a]) || a - b);
  const last = (l: RiverLine) => l.points[l.points.length - 1];
  // 按格距分桶找挨着的河口（大河先，小河挪开、并进去之后河口变了，桶里的位置按原来的就够：挪开的只会更远）
  const X = (x: number) => (sphere ? x - 2 * Math.floor(x / 2) : x);
  const cols = Math.ceil((sphere ? 2 : mesh.width) / sp) + 2;
  const bucket = new Map<number, number[]>();
  const key = (i: number, j: number) => j * (cols + 2) + (sphere ? ((i % cols) + cols) % cols : i);
  for (const i of mouths) {
    const e = last(lines[i]);
    const k = key(Math.floor(X(e[0]) / sp), Math.floor(e[1] / sp));
    const b = bucket.get(k);
    if (b) b.push(i);
    else bucket.set(k, [i]);
  }
  const rank = new Int32Array(lines.length);
  mouths.forEach((i, r) => (rank[i] = r));
  const moved = new Set<number>();
  // 有小河并进来的；并进来的小河
  const hosts = new Set<number>();
  const merged = new Set<RiverLine>();
  // 挨着的河口（5×5 个桶里；挪开的河口离原来的位置不到两格）：e 到比 si 大的、还在入海的河口最近多远（地图单位）
  const around = (e: readonly [number, number], f: (j: number) => boolean) => {
    const gx = Math.floor(X(e[0]) / sp);
    const gy = Math.floor(e[1] / sp);
    const out: number[] = [];
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const j of bucket.get(key(gx + a, gy + b)) ?? []) if (f(j)) out.push(j);
    return out;
  };
  const gap = (e: readonly [number, number], j: number) => {
    const q = last(lines[j]);
    const raw = e[0] - q[0];
    return Math.hypot(sphere ? raw - 2 * Math.round(raw / 2) : raw, e[1] - q[1]);
  };
  const clearance = (e: readonly [number, number], si: number) => {
    let m = Infinity;
    for (const j of around(e, (j) => rank[j] < rank[si] && !!lines[j].mouth)) m = Math.min(m, gap(e, j));
    return m;
  };
  // 线 xi 挪过河口以后（old 是挪之前的样子），在挪动的那一段里汇进来的线（into 是它的）的最后一点重新放到挪过的线上，
  // 记下新的汇合处。有汇合处对不上汇进来的线、离新的线太远（半格以上）时为 false（什么都没改）
  const retie = (xi: number, old: RiverLine): boolean => {
    const X = lines[xi];
    let same = 0;
    while (same < old.points.length && same < X.points.length && old.points[same] === X.points[same]) same++;
    const stay = (old.joins ?? []).filter((pos) => pos < same - 1);
    const moving = (old.joins ?? []).length - stay.length;
    if (!moving) return true;
    const ends: { l: RiverLine; p: [number, number]; pos: number }[] = [];
    for (let ti = 0; ti < lines.length; ti++) {
      const T = lines[ti];
      if (!keep[ti] || T.into !== xi || T.mouth || ti === xi) continue;
      const e = T.points[T.points.length - 1];
      const ho = snapOnto(old.points, e[0], e[1], 0, old.points.length - 1, sphere);
      if (!ho || ho.k + ho.t < same - 1) continue;
      const hn = snapOnto(X.points, e[0], e[1], Math.max(0, same - 2), X.points.length - 1, sphere);
      if (!hn || hn.d > 0.5 * sp) return false;
      // 在岸边并进来的小河（mergeMouth 并的）：挪过以后并进去的角度也不超过 JOIN_ANGLE（第三十三轮）
      if (merged.has(T) && !joinsSmoothly(T.points, hn.p, X.points, sp, sphere)) return false;
      ends.push({ l: T, p: hn.p, pos: hn.k + hn.t });
    }
    if (ends.length !== moving) return false;
    for (const x of ends) x.l.points = [...x.l.points.slice(0, -1), x.p];
    X.joins = [...stay, ...ends.map((x) => x.pos)];
    return true;
  };
  for (const si of mouths) {
    const S = lines[si];
    // 比它大、河口挨着它的河（最大的先）
    const bigger = around(last(S), (j) => rank[j] < rank[si] && !!lines[j].mouth && gap(last(S), j) < MOUTH_SEP * sp).sort((a, b) => rank[a] - rank[b]);
    for (const bi of bigger) {
      if (!S.mouth) break;
      const B = lines[bi];
      const be = last(B);
      const se = last(S);
      const raw = se[0] - be[0];
      const dx = sphere ? raw - 2 * Math.round(raw / 2) : raw;
      if (Math.hypot(dx, se[1] - be[1]) >= MOUTH_SEP * sp) continue;
      // 大河的点挪到小河那一份要加的（平面上为 0）
      const off = raw - dx;
      if (shiftMouth(world, field, B, S, off, (e) => clearance(e, si) >= MOUTH_SEP * sp)) {
        moved.add(si);
        continue;
      }
      if (mergeMouth(world, field, B, S, off)) {
        merged.add(S);
        delete S.mouth;
        S.into = bi;
        hosts.add(bi);
        break;
      }
      // 小河挪不开也接不顺（比如从窄海湾的湾头两边斜着流进来）：大河的河口往离开小河的那一侧挪（挪到的地方离别的河口也要够远）。
      // 在挪动的那一段里汇进大河的支流重新接到挪过的线上；接不上就照原样
      const old = { ...B };
      if (shiftMouth(world, field, S, B, -off, (e) => around(e, (j) => j !== bi && j !== si && !!lines[j].mouth).every((j) => gap(e, j) >= MOUTH_SEP * sp), -1)) {
        if (retie(bi, old)) {
          moved.add(bi);
          continue;
        }
        Object.assign(B, old);
      }
      // 都不行：小河退回原来的河口（对着它流进的那格海，常常离得远一点），离比它大的河口更远的话
      const o = orig.get(S);
      if (!o) continue;
      // 别的河汇进来的地方要在两样都一样的那一段里（normalMouth 只换后面的，前面的点是同一些）
      let same = 0;
      while (same < o.points.length && same < S.points.length && o.points[same] === S.points[same]) same++;
      if ((S.joins ?? []).some((pos) => pos > same - 1)) continue;
      if (clearance(last(o), si) <= clearance(se, si)) continue;
      S.points = o.points;
      S.flow = o.flow;
      if (o.cells) S.cells = o.cells;
      if (o.type) S.type = o.type;
      if (o.mul) S.mul = o.mul;
      moved.add(si);
    }
  }
  // 挪过河口的变成了不到 1.5 格的源头小河：也不画
  for (const i of moved) if (keep[i] && lines[i].mouth && !hosts.has(i) && small(i, 0)) drop(i);
  const index = new Int32Array(lines.length).fill(-1);
  let n = 0;
  lines.forEach((_, i) => {
    if (keep[i]) index[i] = n++;
  });
  // 汇入的那条按新的下标（去掉的小河连同汇进它的一起去掉了）
  for (const l of lines) if (l.into !== undefined) l.into = index[l.into] >= 0 ? index[l.into] : undefined;
  return lines.filter((_, i) => keep[i]);
}

// 从 A（方向 t）到 J（到 J 时顺着 md）、一路沿 md 往前的曲线：沿 md 的位置 s 从 A 的（在 J 之后为负）均匀走到 0，
// 横向的偏移是 s 的三次 Hermite（A 处的斜率按 t，最多 ±3；J 处为 0，顺着 md 接上）。每一小段在 md 上都往前。
// A 不在 J 后面至少 0.2 个 step 时为 null
function forwardJoin(A: readonly [number, number], t: readonly [number, number], J: readonly [number, number], md: readonly [number, number], step: number): Pt[] | null {
  const nx = -md[1];
  const ny = md[0];
  const s0 = (A[0] - J[0]) * md[0] + (A[1] - J[1]) * md[1];
  const y0 = (A[0] - J[0]) * nx + (A[1] - J[1]) * ny;
  if (s0 > -0.2 * step) return null;
  const tm = t[0] * md[0] + t[1] * md[1];
  const tn = t[0] * nx + t[1] * ny;
  const slope = tm > 1e-6 ? Math.max(-3, Math.min(3, tn / tm)) : Math.sign(tn) * 3;
  const L = -s0;
  const count = Math.max(2, Math.ceil(Math.hypot(L, y0) / step));
  const out: Pt[] = [];
  for (let j = 1; j <= count; j++) {
    const u = j / count;
    const u2 = u * u;
    const u3 = u2 * u;
    // y(u)：y(0) = y0、y'(0) = slope·L、y(1) = 0、y'(1) = 0
    const y = (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * slope * L;
    const sx = s0 + L * u;
    out.push(j === count ? [J[0], J[1]] : [J[0] + md[0] * sx + nx * y, J[1] + md[1] * sx + ny * y]);
  }
  return out;
}

// 两个河口挤在一起：小河 S 的河口沿岸线往离开大河 B 的那一侧挪，挪到离 B 的河口 0.75（不行就 1.1）格的岸线上，
// 从河口往回约 1.2（1.8、2.4）格起接过去。接出来的一段要在陆地上、不急转、不与 B 相交，最后 0.6 格离 B 的线至少 0.25 格。
// off：B 的点挪到 S 那一份要加的；keep：S 上这一点以前不动（为负时别的河汇进 S 的地方也可以动，调用的一方再把它们接上，见 tidyMouths 的 retie）
function shiftMouth(world: World, f: DisplayCoast, B: RiverLine, S: RiverLine, off: number, clear: (e: readonly [number, number]) => boolean, keep = 0): boolean {
  const sp = world.mesh.spacing;
  const BP = B.points.slice(backAlong(B.points, 3 * sp).k).map((p) => [p[0] + off, p[1]] as Pt);
  const be = BP[BP.length - 1];
  const se = S.points[S.points.length - 1];
  const hb = B.cells?.[B.cells.length - 1] ?? 0;
  const hs = S.cells?.[S.cells.length - 1] ?? 0;
  const nB = seawardNormal(world, f, be, hb);
  if (!nB) return false;
  const tB: Pt = [-nB[1], nB[0]];
  let side = (se[0] - be[0]) * tB[0] + (se[1] - be[1]) * tB[1];
  if (Math.abs(side) < 0.05 * sp) {
    const up = backAlong(S.points, sp).p;
    side = (up[0] - be[0]) * tB[0] + (up[1] - be[1]) * tB[1];
  }
  const sg = side < 0 ? -1 : 1;
  const prefer: Pt = [tB[0] * sg, tB[1] * sg];
  const near = (q: readonly [number, number]) => {
    for (let k = 0; k + 1 < BP.length; k++) if (segProject(q[0], q[1], BP[k][0], BP[k][1], BP[k + 1][0], BP[k + 1][1]).d < 0.25 * sp) return true;
    return false;
  };
  // 接出来的一段（从第 k 个点起）能不能用：河口离 B 的河口够远、离别的大河口也够远，最后 0.6 格离 B 远一点（前面原来就挨着 B 的不算），
  // 不与 B 相交（B 的线段先按外接框筛掉）
  const ok = (r: { k: number; pts: Pt[] }) => {
    const e = r.pts[r.pts.length - 1];
    if (Math.hypot(e[0] - be[0], e[1] - be[1]) < MOUTH_SEP * sp || !clear(e)) return false;
    const all = [S.points[r.k], ...r.pts];
    let s = 0;
    for (let j = all.length - 1; j > 0 && s < 0.6 * sp; j--) {
      if (near(all[j])) return false;
      s += Math.hypot(all[j][0] - all[j - 1][0], all[j][1] - all[j - 1][1]);
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of all) {
      x0 = Math.min(x0, q[0]);
      y0 = Math.min(y0, q[1]);
      x1 = Math.max(x1, q[0]);
      y1 = Math.max(y1, q[1]);
    }
    for (let k = 0; k + 1 < BP.length; k++) {
      const [a, b] = [BP[k], BP[k + 1]];
      if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1 || Math.max(a[1], b[1]) < y0 || Math.min(a[1], b[1]) > y1) continue;
      for (let j = 0; j + 1 < all.length; j++) if (segCross(all[j], all[j + 1], a, b)) return false;
    }
    return true;
  };
  const tryAt = (n: Pt, p: Pt) => {
    for (const leg of SHIFT_LEGS) {
      const r = mouthLeg(world, f, S, keep, n, p, leg, 0.95);
      if (r && ok(r)) {
        applyLeg(S, r.k, r.pts);
        return true;
      }
    }
    return false;
  };
  for (const dist of SHIFT_TRIES) {
    for (const p of shoreOnCircle(world, f, be, dist * sp, prefer, hs)) {
      const n = seawardNormal(world, f, p, hs);
      if (n && tryAt(n, p)) return true;
    }
  }
  // 挪不开（比如从窄海湾的两岸迎面流进湾头）：从 S 河口往回约一格的那一点顺着 S 的方向（左右各偏到 60°）往前找岸线，
  // 顺着那个方向直直地入海
  const A = backAlong(S.points, sp);
  const ta = dirAt(S.points, Math.min(S.points.length - 1, A.k + 1));
  if (!landAt(world, f, A.p, hs)) return false;
  for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
    const a = (deg * Math.PI) / 180;
    const dir: Pt = [ta[0] * Math.cos(a) - ta[1] * Math.sin(a), ta[0] * Math.sin(a) + ta[1] * Math.cos(a)];
    const hit = shoreCross(world, f, A.p, [A.p[0] + dir[0] * 2 * sp, A.p[1] + dir[1] * 2 * sp], hs, SHORE_STEPS);
    if (hit && tryAt(dir, hit.p)) return true;
  }
  return false;
}

// 挪不开时小河 S 在岸边并进大河 B：从 S 河口往回约 0.9（1.4、2）格起，接到 B 河口往回 0.2（0.3）格的那一点，到那里顺着 B 的方向。
// 只在接得顺时并：并进去的角度（最后约 0.3 格的方向与 B 的方向）不到 35°、一路不往回拐（每一小段都顺着 B 往前）、不急转，
// 接出来的一段在陆地上。
// off：B 的点挪到 S 那一份要加的
// 小河 P 的最后一点换成 e（在大河 M 上）以后，最后一段弦（从末尾往回走到累计 0.3 格以外的那个点）与 M 在那里的方向
// （离 e 最近的点往下的一段）差不到 JOIN_ANGLE。sphere：整个星球（M 的点与 e 可以差整圈）
function joinsSmoothly(P: readonly (readonly [number, number])[], e: readonly [number, number], M: readonly (readonly [number, number])[], sp: number, sphere: boolean): boolean {
  const Q = [...P.slice(0, -1), e];
  let k = Q.length - 1;
  for (let s = 0; k > 0 && s < 0.3 * sp; k--) s += Math.hypot(Q[k][0] - Q[k - 1][0], Q[k][1] - Q[k - 1][1]);
  const cx = e[0] - Q[k][0];
  const cy = e[1] - Q[k][1];
  const zl = Math.hypot(cx, cy);
  if (zl < 1e-9) return false;
  const md = nearestDir(M, e, sphere);
  return (cx * md[0] + cy * md[1]) / zl >= Math.cos((JOIN_ANGLE * Math.PI) / 180);
}

// 线上离 p 最近的那个点往下的一段的方向（单位向量；最后一点取最后一段）。sphere：东西按整圈取最近的一份
function nearestDir(P: readonly (readonly [number, number])[], p: readonly [number, number], sphere: boolean): Pt {
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k + 1 < P.length; k++) {
    const raw = P[k][0] - p[0];
    const d = Math.hypot(sphere ? raw - 2 * Math.round(raw / 2) : raw, P[k][1] - p[1]);
    if (d < bd) [bd, best] = [d, k];
  }
  const l = Math.hypot(P[best + 1][0] - P[best][0], P[best + 1][1] - P[best][1]) || 1;
  return [(P[best + 1][0] - P[best][0]) / l, (P[best + 1][1] - P[best][1]) / l];
}

function mergeMouth(world: World, f: DisplayCoast, B: RiverLine, S: RiverLine, off: number): boolean {
  const sp = world.mesh.spacing;
  const M = B.points;
  const O = S.points;
  if (M.length < 2 || O.length < 2) return false;
  let olim = 0;
  for (const pos of S.joins ?? []) olim = Math.max(olim, Math.ceil(pos));
  const cosJoin = Math.cos((JOIN_ANGLE * Math.PI) / 180);
  for (const back of JOIN_BACK) {
    const J = backAlong(M, back * sp);
    const Jp: Pt = [J.p[0] + off, J.p[1]];
    const mk = Math.min(M.length - 2, J.k);
    const ml = Math.hypot(M[mk + 1][0] - M[mk][0], M[mk + 1][1] - M[mk][1]) || 1;
    const md: Pt = [(M[mk + 1][0] - M[mk][0]) / ml, (M[mk + 1][1] - M[mk][1]) / ml];
    for (const trim of JOIN_TRIM) {
      const A0 = backAlong(O, trim * sp, Math.min(olim, O.length - 2));
      const k = A0.k;
      const A = O[k];
      const t = dirAt(O, k);
      if (k === 0) {
        const l = Math.hypot(O[1][0] - A[0], O[1][1] - A[1]) || 1;
        t[0] = (O[1][0] - A[0]) / l;
        t[1] = (O[1][1] - A[1]) / l;
      }
      if (t[0] * md[0] + t[1] * md[1] <= 0) continue;
      const L = Math.hypot(Jp[0] - A[0], Jp[1] - A[1]);
      if (L < 1e-9 || ((Jp[0] - A[0]) * md[0] + (Jp[1] - A[1]) * md[1]) / L < 0) continue;
      const hint = S.cells?.[k] ?? 0;
      // 曲线的样子：先按两点的距离；小河斜着过来时起点的切向短一点（不往外鼓）、终点的长一点（早一点顺着 B），
      // 再不行用一路往前的曲线
      let pts: Pt[] | null = null;
      for (const [sa, sb] of JOIN_SHAPES) {
        // sa 为 0：按 B 的方向一路往前的曲线（见 forwardJoin），几乎横着过来的小河也不先往后退一点再拐
        const q = sa > 0 ? hermite(A, t, Jp, md, sp / 8, sa, sb) : forwardJoin(A, t, Jp, md, sp / 8);
        if (!q) continue;
        // 并进去的角度：最后约 0.3 格的弦与 B 的方向
        const Z = backAlong([A, ...q], 0.3 * sp).p;
        const zl = Math.hypot(Jp[0] - Z[0], Jp[1] - Z[1]);
        if (zl < 1e-9 || ((Jp[0] - Z[0]) * md[0] + (Jp[1] - Z[1]) * md[1]) / zl < cosJoin) continue;
        // 第三十三轮：也按接好以后的整条线量（往回走到离汇合处 0.3 格以外的那个点，接出来的一段不到 0.3 格时含原来的线），
        // 与 B 上离汇合处最近的那个点往下的一段比（汇合处在 B 的弯点附近时两段的方向差得多）
        if (!joinsSmoothly([...O.slice(0, k + 1), ...q], Jp, M, sp, world.mesh.kind === 'sphere')) continue;
        let ok = true;
        for (let j = 0; j < q.length && ok; j++) {
          const a = j > 0 ? q[j - 1] : A;
          if ((q[j][0] - a[0]) * md[0] + (q[j][1] - a[1]) * md[1] <= 0) ok = false;
          else if (j + 1 < q.length && !landAt(world, f, q[j], hint)) ok = false;
        }
        if (!ok || maxTurn([...before(O, k, sp), ...q], TURN_CHORD * sp) > MOUTH_MAX_TURN) continue;
        pts = q;
        break;
      }
      if (!pts) continue;
      const count = pts.length;
      const keepN = k + 1;
      const q0 = S.flow[k];
      S.points = [...O.slice(0, keepN), ...pts];
      S.flow = [...S.flow.slice(0, keepN), ...pts.map(() => q0)];
      if (S.cells) {
        const own = S.cells[k];
        const at = B.cells?.[Math.min(B.cells.length - 1, J.t > 0.5 ? J.k + 1 : J.k)] ?? own;
        S.cells = [...S.cells.slice(0, keepN), ...pts.map((_, j) => (j === count - 1 ? at : own))];
      }
      if (S.type) {
        const ty = S.type[k];
        S.type = [...S.type.slice(0, keepN), ...pts.map(() => ty)];
      }
      if (S.mul) {
        const mm = S.mul[k];
        S.mul = [...S.mul.slice(0, keepN), ...pts.map(() => mm)];
      }
      markJoin(B, J.k + J.t);
      return true;
    }
  }
  return false;
}
