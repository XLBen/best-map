// 裂开的大陆块与地峡（第八十三轮从 core/generate.ts 原样搬出；第三十五轮的设计见 outline.ts）
import { type Block, type Rift, type GenModel, type Isthmus, warp } from './generate-model';
import { triWidth, WIGGLE, closeGap, shelfWidth, SHELF, eHard, ISTHMUS_PAD, isthmusC, isthmusW } from './outline';
import { type Noise2, fbm, smoothstep } from './rng';
import type { WorldType } from './world-types';

// ---------- 第三十五轮：裂开的大陆块与地峡（见 outline.ts） ----------

// 一个块的场（1 在中心，0 在边上）；三角形的半岛往外收窄
export function blockF(b: Block, x: number, y: number): number {
  const dx = x - b.x;
  const dy = y - b.y;
  const se = Math.sqrt(b.e);
  const u = (dx * b.cos + dy * b.sin) / se;
  let v = (-dx * b.sin + dy * b.cos) * se;
  if (b.tri > 0) v /= triWidth(u / b.r, b.tri);
  return 1 - Math.hypot(u, v) / b.r;
}

// 一点相对一处裂开：在不在范围里、哪一半、漂移前的位置、往这一半里面量的离切口的距离、大陆架与陆坡的宽
export const MAX_RIFTS = 8;
interface DriftState {
  inb: Uint8Array;
  sg: Float64Array;
  uq: Float64Array;
  px: Float64Array;
  py: Float64Array;
  x: Float64Array;
  disp: Float64Array;
  ws: Float64Array;
  wsl: Float64Array;
}
const driftState = (): DriftState => ({
  inb: new Uint8Array(MAX_RIFTS),
  sg: new Float64Array(MAX_RIFTS),
  uq: new Float64Array(MAX_RIFTS),
  px: new Float64Array(MAX_RIFTS),
  py: new Float64Array(MAX_RIFTS),
  x: new Float64Array(MAX_RIFTS),
  disp: new Float64Array(MAX_RIFTS),
  ws: new Float64Array(MAX_RIFTS),
  wsl: new Float64Array(MAX_RIFTS),
});
// 采样用的一份、famField / blockField 用的一份（采样时 blockField 也要算，不能共用）
export const DS = driftState();
export const DF = driftState();

// 漂移前的坐标系里离裂谷线的 u（wig 为 null 时不加弯曲噪声：只给“哪边是大陆”这类粗略的判断用）
function riftU(r: Rift, wig: Noise2 | null, x: number, y: number): number {
  const ax = x - r.ox;
  const ay = y - r.oy;
  const along = ax * r.tx + ay * r.ty;
  let u = ax * r.nx + ay * r.ny + r.kappa * along * along;
  if (wig) u += WIGGLE.amp * fbm(wig, x, y, WIGGLE.freq, WIGGLE.oct, WIGGLE.gain);
  return u;
}

function riftAt(r: Rift, wig: Noise2 | null, qx: number, qy: number, k: number, o: DriftState) {
  const dx = qx - r.cx;
  const dy = qy - r.cy;
  if (dx * dx + dy * dy >= r.R * r.R) {
    o.inb[k] = 0;
    return;
  }
  o.inb[k] = 1;
  const uq = riftU(r, wig, qx, qy);
  const sg = uq >= 0 ? 1 : -1;
  const ex = qx - r.px;
  const ey = qy - r.py;
  const phi = sg * r.phi * smoothstep(0, r.ramp, ex * r.mx + ey * r.my);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // 转回漂移前（−phi）
  const Px = r.px + c * ex + s * ey;
  const Py = r.py - s * ex + c * ey;
  const disp = Math.hypot(qx - Px, qy - Py);
  o.uq[k] = uq;
  o.sg[k] = sg;
  o.px[k] = Px;
  o.py[k] = Py;
  o.disp[k] = disp;
  o.x[k] = closeGap(sg * riftU(r, wig, Px, Py), disp);
  o.ws[k] = shelfWidth(disp, SHELF.wsMax, SHELF.wsK);
  o.wsl[k] = shelfWidth(disp, SHELF.wslMax, SHELF.wslK);
}

export function prepRifts(m: GenModel, wig: Noise2 | null, qx: number, qy: number, o: DriftState) {
  const rifts = m.rifts;
  for (let k = 0; k < rifts.length; k++) riftAt(rifts[k], wig, qx, qy, k, o);
}

// 漂移前的一点 (x, y) 在 sg 那一半上漂移后的位置（建模型时用：转的角度按漂移前的位置取，与逐点的逆映射差一点点）
function driftForward(r: Rift, sg: number, x: number, y: number): [number, number] {
  const ex = x - r.px;
  const ey = y - r.py;
  const phi = sg * r.phi * smoothstep(0, r.ramp, ex * r.mx + ey * r.my);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return [r.px + c * ex - s * ey, r.py + s * ex + c * ey];
}

// 地峡：到折线的距离与沿线的位置（0–1）
const IS = { d: 0, t: 0 };
function isthmusDist(l: Isthmus, x: number, y: number) {
  const p = l.pts;
  let best = Infinity;
  let bt = 0;
  for (let s = 0; s + 3 < p.length; s += 2) {
    const ax = p[s];
    const ay = p[s + 1];
    const bx = p[s + 2] - ax;
    const by = p[s + 3] - ay;
    const L2 = bx * bx + by * by || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / L2));
    const dx = x - ax - t * bx;
    const dy = y - ay - t * by;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      const seg = s >> 1;
      bt = (l.cum[seg] + t * (l.cum[seg + 1] - l.cum[seg])) / l.cum[l.cum.length - 1];
    }
  }
  IS.d = Math.sqrt(best);
  IS.t = bt;
}

// 一族块（母块 fam 与它的半岛）漂移后在 (x, y) 处的场（不含噪声；裂开的按切口截，不加弯曲噪声）
function famField(m: GenModel, fam: number, x: number, y: number): number {
  const k = m.famRift[fam];
  const F = famsOf(m);
  if (k >= 0) {
    riftAt(m.rifts[k], null, x, y, k, DF);
    if (!DF.inb[k]) return -1;
  } else {
    // 离这一族的范围以外场 < −1（不改最大值）：不算
    const dx = x - F.cx[fam];
    const dy = y - F.cy[fam];
    if (dx * dx + dy * dy > F.reach[fam] * F.reach[fam]) return -1;
  }
  let c = -1;
  for (const b of F.blocks[fam]) {
    const s = k < 0 ? blockF(b, x, y) : Math.min(blockF(b, DF.px[k], DF.py[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  return c;
}

// 漂移前一族块的场（不截）
function famFieldPre(m: GenModel, fam: number, x: number, y: number): number {
  let c = -1;
  for (const b of famsOf(m).blocks[fam]) c = Math.max(c, blockF(b, x, y));
  return c;
}

// 每一族的块（按原来的先后）与漂移前的范围（母块中心起；范围外场 < −1），建模型时按块的数组缓存
interface Fams {
  blocks: Block[][];
  cx: number[];
  cy: number[];
  reach: number[];
}
const famCache = new WeakMap<Block[], Fams>();
function famsOf(m: GenModel): Fams {
  let F = famCache.get(m.blocks);
  if (!F) {
    const n = m.famRift.length;
    F = { blocks: Array.from({ length: n }, () => []), cx: [], cy: [], reach: [] };
    for (const b of m.blocks) F.blocks[b.fam].push(b);
    for (let f = 0; f < n; f++) {
      F.cx.push(m.blocks[f].x);
      F.cy.push(m.blocks[f].y);
      F.reach.push(famReach(m, f, m.blocks[f].x, m.blocks[f].y));
    }
    famCache.set(m.blocks, F);
  }
  return F;
}

// 这一族块漂移前的范围（离裂谷线原点；场 > −1.1 的地方都在里面：范围外加上噪声也是深海）
function famReach(m: GenModel, fam: number, ox: number, oy: number): number {
  let reach = 0;
  for (const o of m.blocks) {
    if (o.fam !== fam) continue;
    const se = Math.sqrt(o.e);
    reach = Math.max(reach, Math.hypot(o.x - ox, o.y - oy) + 2.1 * o.r * Math.max(se, 1 / se) * (o.tri ? 1.3 : 1));
  }
  return reach;
}

// 一处裂开的候选：块 b 的第 t 个方向、红海一类（red）或大西洋一类、块中心处分开 D（draws：这个块的几个随机数）
function riftCandidate(m: GenModel, fam: number, b: Block, draws: number[], red: boolean, t: number, D: number): { r: Rift; reach: number } {
  const se = Math.sqrt(b.e);
  const ang = (draws[3] + t * 0.25) * Math.PI;
  const tx = Math.cos(ang);
  const ty = Math.sin(ang);
  const nx = -ty;
  const ny = tx;
  const off = (draws[4] - 0.5) * 0.4 * b.r;
  const ox = b.x + nx * off;
  const oy = b.y + ny * off;
  const kappa = ((draws[5] - 0.5) * 1.6) / b.r;
  const delta = red ? b.r * se * (0.8 + 0.5 * draws[6]) : b.r * (3 + 3 * draws[6]);
  const end = draws[7] < 0.5 ? 1 : -1;
  const px = ox + tx * delta * end;
  const py = oy + ty * delta * end;
  const mx = -tx * end;
  const my = -ty * end;
  // + 那一半转 +phi 要往 +n 走：(o − 极) 逆时针转 90° 与 n 同向时 phi 为正
  const sgn = Math.sign(-(oy - py) * nx + (ox - px) * ny) || 1;
  const reach = famReach(m, fam, ox, oy);
  const phi = sgn * (D / (2 * delta));
  return { r: { fam, ox, oy, tx, ty, nx, ny, kappa, px, py, mx, my, phi, ramp: 0.4 * delta, D, red, cx: ox, cy: oy, R: reach + Math.abs(phi) * (delta + reach) + 0.05 }, reach };
}

// 裂开（随机数每个够大的块取固定的几个，不管成不成：后面的块的格局不随前面的成败变）。
// 先按抽到的一类试四个方向，取开得最大的（开不到想要的就小一些，红海一类最小 0.02、大西洋一类最小 0.06）；
// 大西洋一类哪个方向都开不了时（会压到别的块上）改成红海一类再试；还不行就不裂（不压过去：几块大陆连成一块时最大的陆块
// 占到陆地的九成以上；最窄的红海一类在星球上只有两格宽，两岸对不准）
export function buildRifts(m: GenModel, parentCount: number, rand: () => number) {
  const { blocks, profile } = m;
  for (let fam = 0; fam < parentCount; fam++) {
    const b = blocks[fam];
    const draws = Array.from({ length: 8 }, () => rand());
    if (b.r < 0.14 || draws[0] >= 0.5 || (profile.main && fam === 0) || m.rifts.length >= MAX_RIFTS) continue;
    let made: Rift | null = null;
    for (const red of draws[1] < 0.5 ? [true] : [false, true]) {
      const want = red ? 0.02 + 0.03 * draws[2] : 0.15 + 0.25 * draws[2];
      const minD = red ? 0.02 : 0.06;
      for (let t = 0; t < 4 && !(made && made.D >= want); t++) {
        for (let D = want; D >= minD - 1e-9; D = D > minD && D * 0.75 < minD ? minD : D * 0.75) {
          if (made && D <= made.D) break;
          const { r, reach } = riftCandidate(m, fam, b, draws, red, t, D);
          if (riftClear(m, r, reach)) {
            made = r;
            break;
          }
          if (D === minD) break;
        }
      }
      if (made) break;
    }
    if (!made) continue;
    m.famRift[fam] = m.rifts.length;
    m.rifts.push(made);
  }
  if (m.rifts.length) fragmentPlates(m, rand);
  // 穹隆跟着它所在的那一半走
  for (const s of m.swells) {
    for (const r of m.rifts) {
      if (famFieldPre(m, r.fam, s.x, s.y) < -0.2) continue;
      [s.x, s.y] = driftForward(r, riftU(r, null, s.x, s.y) >= 0 ? 1 : -1, s.x, s.y);
      break;
    }
  }
}

// 漂移前这一族块的格点（场 > −0.1），带上在哪一半
function famSamples(m: GenModel, r: Rift, reach: number): { x: number; y: number; f: number; sg: number }[] {
  const out: { x: number; y: number; f: number; sg: number }[] = [];
  const step = reach / 16;
  for (let i = -16; i <= 16; i++) {
    for (let j = -16; j <= 16; j++) {
      const x = r.ox + i * step;
      const y = r.oy + j * step;
      const f = famFieldPre(m, r.fam, x, y);
      if (f > -0.1) out.push({ x, y, f, sg: riftU(r, null, x, y) >= 0 ? 1 : -1 });
    }
  }
  return out;
}

// 漂移后不压到别的块上：每个格点移过去以后，别的块（已经裂开的按漂移后）的场 < −0.3（加上噪声也多半是海），或者不比没移时大 0.02 以上
// （本来就挨着别的块的地方照样能裂）
// 格点与没移时别的块的场只取决于方向（裂谷线的原点、弯曲），按方向记下（同一个方向试几个 D 时不重算）
let clearMemo: { key: string; pts: { x: number; y: number; f: number; sg: number }[]; pre: Float64Array } | null = null;
function otherField(m: GenModel, fam: number, x: number, y: number): number {
  let o = -1;
  for (let f = 0; f < m.famRift.length; f++) if (f !== fam) o = Math.max(o, famField(m, f, x, y));
  return o;
}
function riftClear(m: GenModel, r: Rift, reach: number): boolean {
  const key = `${r.fam}:${r.ox}:${r.oy}:${r.tx}:${r.ty}:${r.kappa}:${reach}:${m.rifts.length}`;
  if (!clearMemo || clearMemo.key !== key) {
    const pts = famSamples(m, r, reach);
    clearMemo = { key, pts, pre: new Float64Array(pts.length).fill(Number.NaN) };
  }
  const { pts, pre } = clearMemo;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const [x, y] = driftForward(r, p.sg, p.x, p.y);
    const after = otherField(m, r.fam, x, y);
    if (after <= -0.3) continue;
    if (Number.isNaN(pre[k])) pre[k] = otherField(m, r.fam, p.x, p.y);
    if (after > pre[k] + 0.02) return false;
  }
  return true;
}

// 板块跟着碎块走：落在碎块中间（场 > 0.4）的板块去掉，两半的重心各放一个板块，速度是漂移的方向、比一般的板块快
// （0.9–1.2：前缘因此是汇聚的安第斯式大陆边缘），两半的板块互为 sib。碎块边上的板块留着（与以前一样有块内的交界、山带；
// 全去掉时碎块上没有了山带与高原，区域 2000 m 以上 11% → 9%、高原指数 1.1% → 0.85%）
function fragmentPlates(m: GenModel, rand: () => number) {
  const halves: { x: number; y: number; vx: number; vy: number }[] = [];
  for (const r of m.rifts) {
    const pts = famSamples(m, r, famReach(m, r.fam, r.ox, r.oy));
    for (const sg of [1, -1]) {
      let sx = 0;
      let sy = 0;
      let w = 0;
      for (const p of pts) {
        if (p.sg !== sg || p.f <= 0) continue;
        sx += p.x * p.f;
        sy += p.y * p.f;
        w += p.f;
      }
      if (!w) {
        sx = r.ox + sg * r.nx * 0.1;
        sy = r.oy + sg * r.ny * 0.1;
        w = 1;
      }
      const [x, y] = driftForward(r, sg, sx / w, sy / w);
      // 漂移的方向：绕极转的速度方向
      const ex = x - r.px;
      const ey = y - r.py;
      const s = Math.sign(r.phi) * sg;
      const L = Math.hypot(ex, ey) || 1;
      halves.push({ x, y, vx: (-ey / L) * s, vy: (ex / L) * s });
    }
  }
  const inFragment = (x: number, y: number) => m.rifts.some((r) => famField(m, r.fam, x, y) > 0.4);
  const kept = m.plates.filter((p) => !inFragment(p.x, p.y));
  const base = kept.length;
  for (const f of halves) {
    const sp = 0.9 + 0.3 * rand();
    kept.push({ x: f.x, y: f.y, vx: f.vx * sp, vy: f.vy * sp, weight: 0.035, density: rand(), sib: -1 });
  }
  for (let h = 0; h < halves.length; h += 2) {
    kept[base + h].sib = base + h + 1;
    kept[base + h + 1].sib = base + h;
  }
  m.plates.splice(0, m.plates.length, ...kept);
}

// 一族块的大致面积（π r²，母块加上半岛）：地峡不把太多块连成一块
function famArea(blocks: Block[], fam: number): number {
  let a = 0;
  for (const b of blocks) if (b.fam === fam) a += Math.PI * b.r * b.r;
  return a;
}

// 地峡：每张图 1–2 处，连在两块不同的大陆之间（从两块场 ≥ 0.2 的地方起、中间隔着海、长 0.04–0.4，两端再往块里伸 0.06）
const ISTHMUS_TYPES = new Set<WorldType>(['continents', 'continent', 'fragmented', 'inland_sea']);
export function buildIsthmi(m: GenModel, parentCount: number, rand: () => number) {
  const want = rand() < 0.5 ? 1 : 2;
  const bend = Array.from({ length: 6 }, () => rand());
  if (!ISTHMUS_TYPES.has(m.params.type)) return;
  // 候选的块：没裂开的母块中心、裂开的两半（漂移后）
  const pieces: { x: number; y: number; fam: number; area: number }[] = [];
  for (let fam = 0; fam < parentCount; fam++) {
    const b = m.blocks[fam];
    const k = m.famRift[fam];
    if (k < 0) {
      pieces.push({ x: b.x, y: b.y, fam, area: famArea(m.blocks, fam) });
      continue;
    }
    const r = m.rifts[k];
    for (const sg of [1, -1]) {
      const [x, y] = driftForward(r, sg, b.x + sg * r.nx * b.r * 0.45, b.y + sg * r.ny * b.r * 0.45);
      pieces.push({ x, y, fam, area: famArea(m.blocks, fam) / 2 });
    }
  }
  // 连在一起的块（并查集）
  const up = pieces.map((_, k) => k);
  const ta = (k: number): number => (up[k] === k ? k : (up[k] = ta(up[k])));
  const join = (a: number, b: number) => {
    up[ta(a)] = ta(b);
  };
  const cands: { a: number; b: number; ax: number; ay: number; bx: number; by: number; L: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const A = pieces[i];
      const B = pieces[j];
      if (A.fam === B.fam) continue;
      const dist = Math.hypot(B.x - A.x, B.y - A.y);
      if (dist > 1.4) continue;
      const N = Math.ceil(dist / 0.004);
      const fa: number[] = [];
      const fb: number[] = [];
      for (let s = 0; s <= N; s++) {
        const x = A.x + ((B.x - A.x) * s) / N;
        const y = A.y + ((B.y - A.y) * s) / N;
        fa.push(famField(m, A.fam, x, y));
        fb.push(famField(m, B.fam, x, y));
      }
      // 从 A 往 B 走出 A（场 < 0.2）的前一点、从 B 往 A 走出 B 的前一点；中间要有海
      if (fa[0] < 0.2 || fb[N] < 0.2) continue;
      let sa = 0;
      while (sa < N && fa[sa + 1] >= 0.2) sa++;
      let sb = N;
      while (sb > 0 && fb[sb - 1] >= 0.2) sb--;
      // 两块的场重叠（本来就连着）：算一块
      if (sb <= sa) {
        join(i, j);
        continue;
      }
      let sea = false;
      for (let s = sa; s <= sb && !sea; s++) if (Math.max(fa[s], fb[s]) < 0) sea = true;
      if (!sea) {
        // 中间没有海（本来就挨着）：算一块
        join(i, j);
        continue;
      }
      const L = ((sb - sa) / N) * dist;
      if (L < 0.04 || L > 0.4) continue;
      cands.push({ a: i, b: j, ax: A.x + ((B.x - A.x) * sa) / N, ay: A.y + ((B.y - A.y) * sa) / N, bx: A.x + ((B.x - A.x) * sb) / N, by: A.y + ((B.y - A.y) * sb) / N, L });
    }
  }
  cands.sort((p, q) => p.L - q.L);
  const used = new Set<number>();
  let total = 0;
  for (const q of pieces) total += q.area;
  for (const c of cands) {
    const made = m.isthmi.length;
    if (made >= want) break;
    // 不连成太大的一块（连起来的块加起来不过所有块的四成：地球上最大的亚非欧约占陆地 57%，块之外还有噪声长出来的陆地），也不连已经连着的
    if (used.has(c.a) || used.has(c.b) || ta(c.a) === ta(c.b)) continue;
    let sum = 0;
    for (let k = 0; k < pieces.length; k++) if (ta(k) === ta(c.a) || ta(k) === ta(c.b)) sum += pieces[k].area;
    if (sum > 0.4 * total) continue;
    used.add(c.a);
    used.add(c.b);
    join(c.a, c.b);
    const dx = (c.bx - c.ax) / c.L;
    const dy = (c.by - c.ay) / c.L;
    // 两端再往块里伸 0.06；中点往一侧弯（长度的 0.25–0.5）
    const ax = c.ax - dx * 0.06;
    const ay = c.ay - dy * 0.06;
    const bx = c.bx + dx * 0.06;
    const by = c.by + dy * 0.06;
    const amt = c.L * (0.25 + 0.25 * bend[made * 3 + 1]) * (bend[made * 3] < 0.5 ? -1 : 1);
    const kx = (ax + bx) / 2 - dy * amt;
    const ky = (ay + by) / 2 + dx * amt;
    const K = 16;
    const pts = new Float64Array(2 * (K + 1));
    const cum = new Float64Array(K + 1);
    for (let s = 0; s <= K; s++) {
      const t = s / K;
      pts[2 * s] = (1 - t) * (1 - t) * ax + 2 * t * (1 - t) * kx + t * t * bx;
      pts[2 * s + 1] = (1 - t) * (1 - t) * ay + 2 * t * (1 - t) * ky + t * t * by;
      if (s) cum[s] = cum[s - 1] + Math.hypot(pts[2 * s] - pts[2 * s - 2], pts[2 * s + 1] - pts[2 * s - 1]);
    }
    const w = 0.012 + 0.006 * bend[made * 3 + 2];
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    let R = 0;
    for (let s = 0; s <= K; s++) R = Math.max(R, Math.hypot(pts[2 * s] - cx, pts[2 * s + 1] - cy));
    m.isthmi.push({ pts, cum, w, cx, cy, R: R + w + ISTHMUS_PAD });
  }
}

// 地峡的大陆场（不加噪声）与压低起伏的权重（写进 IW）
export const IW = { c: -1, w: 0 };
export function isthmiAt(m: GenModel, x: number, y: number) {
  IW.c = -1;
  IW.w = 0;
  for (const l of m.isthmi) {
    const dx = x - l.cx;
    const dy = y - l.cy;
    if (dx * dx + dy * dy >= l.R * l.R) continue;
    isthmusDist(l, x, y);
    IW.c = Math.max(IW.c, isthmusC(IS.d, l.w));
    IW.w = Math.max(IW.w, isthmusW(IS.d, l.w, IS.t));
  }
}

// 统计用（tools/realism.ts）：每条地峡到扭曲后的一点的距离 ÷ 半宽
export function isthmusNear(m: GenModel, qx: number, qy: number): number[] {
  return m.isthmi.map((l) => {
    isthmusDist(l, qx, qy);
    return IS.d / l.w;
  });
}

// 统计用：地图上一点（未扭曲）扭曲后的位置
export function warpedAt(m: GenModel, x: number, y: number): [number, number] {
  return warp(m.noise, x, y);
}

// 统计用：地图上一点（未扭曲）相对每处裂开：[第几处, 哪一半, 漂移前 x, y, 离切口的 x, 漂移前这一族块的场, 漂移后离原来的裂谷线的 u]，
// 不在范围里的不列
export function riftFrames(m: GenModel, x: number, y: number): [number, number, number, number, number, number, number][] {
  const [qx, qy] = warp(m.noise, x, y);
  prepRifts(m, m.noise.rift, qx, qy, DF);
  const out: [number, number, number, number, number, number, number][] = [];
  for (let k = 0; k < m.rifts.length; k++) {
    if (!DF.inb[k]) continue;
    out.push([k, DF.sg[k], DF.px[k], DF.py[k], DF.x[k], famFieldPre(m, m.rifts[k].fam, DF.px[k], DF.py[k]), DF.uq[k]]);
  }
  return out;
}
