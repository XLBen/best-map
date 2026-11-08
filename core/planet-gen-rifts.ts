// 星球上裂开的大陆块与地峡（第八十三轮从 core/planet-gen.ts 原样搬出）
import { type Block, type Rift, LAYOUT_R, type V3, type PlanetModel, type Isthmus, len, add, scale, tangentAt, unit, cross, dot, warp } from './planet-gen-model';
import { triWidth, WIGGLE, closeGap, shelfWidth, SHELF, eHard, ISTHMUS_PAD, isthmusC, isthmusW } from './outline';
import { type Noise3, fbm3, smoothstep } from './rng';
import type { WorldType } from './generate';

// ---------- 第三十五轮：裂开的大陆块与地峡（见 outline.ts；与 generate.ts 同一个做法，两半绕欧拉极转开） ----------

// 一个块的场（与以前的 blockField 里的式子相同）；三角形的半岛往外收窄
export function blockF(b: Block, qx: number, qy: number, qz: number): number {
  const dx = qx - b.c[0];
  const dy = qy - b.c[1];
  const dz = qz - b.c[2];
  const du = dx * b.u[0] + dy * b.u[1] + dz * b.u[2];
  let dv = dx * b.v[0] + dy * b.v[1] + dz * b.v[2];
  const dn = dx * b.n[0] + dy * b.n[1] + dz * b.n[2];
  if (b.tri) dv /= triWidth(du / (Math.sqrt(b.e) * b.r), b.tri);
  return 1 - Math.sqrt((du * du) / b.e + dv * dv * b.e + dn * dn) / b.r;
}

export const MAX_RIFTS = 8;
interface DriftState {
  inb: Uint8Array;
  sg: Float64Array;
  uq: Float64Array;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
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
  pz: new Float64Array(MAX_RIFTS),
  x: new Float64Array(MAX_RIFTS),
  disp: new Float64Array(MAX_RIFTS),
  ws: new Float64Array(MAX_RIFTS),
  wsl: new Float64Array(MAX_RIFTS),
});
// 采样用的一份、famField / blockField 用的一份
export const DS = driftState();
export const DF = driftState();

// 按方向量（先投回球面：扭曲有沿半径的分量，切口不随它挪）
function riftU(r: Rift, wig: Noise3 | null, px: number, py: number, pz: number): number {
  const L = LAYOUT_R / (Math.sqrt(px * px + py * py + pz * pz) || 1);
  const x = px * L;
  const y = py * L;
  const z = pz * L;
  const ax = x - r.c[0];
  const ay = y - r.c[1];
  const az = z - r.c[2];
  const along = ax * r.t[0] + ay * r.t[1] + az * r.t[2];
  let u = ax * r.n[0] + ay * r.n[1] + az * r.n[2] + r.kappa * along * along;
  if (wig) u += WIGGLE.amp * fbm3(wig, x, y, z, WIGGLE.freq, WIGGLE.oct, WIGGLE.gain);
  return u;
}

// 绕单位轴 a 转 ang（右手），结果写进 RV
const RV: V3 = [0, 0, 0];
function rotate(a: V3, ang: number, x: number, y: number, z: number) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = (a[0] * x + a[1] * y + a[2] * z) * (1 - c);
  RV[0] = x * c + (a[1] * z - a[2] * y) * s + a[0] * d;
  RV[1] = y * c + (a[2] * x - a[0] * z) * s + a[1] * d;
  RV[2] = z * c + (a[0] * y - a[1] * x) * s + a[2] * d;
}

// 转的角度：离极（沿 m 往块那边）不到 ramp 时渐渐不转，过了极不转
function riftAngle(r: Rift, x: number, y: number, z: number): number {
  const L = Math.sqrt(x * x + y * y + z * z) || 1;
  return r.phi * smoothstep(0, r.ramp, (x * r.m[0] + y * r.m[1] + z * r.m[2]) / L);
}

function riftAt(r: Rift, wig: Noise3 | null, qx: number, qy: number, qz: number, k: number, o: DriftState) {
  const dx = qx - r.cb[0];
  const dy = qy - r.cb[1];
  const dz = qz - r.cb[2];
  if (dx * dx + dy * dy + dz * dz >= r.R * r.R) {
    o.inb[k] = 0;
    return;
  }
  o.inb[k] = 1;
  const uq = riftU(r, wig, qx, qy, qz);
  const sg = uq >= 0 ? 1 : -1;
  // 转回漂移前（−角度）
  rotate(r.a, -sg * riftAngle(r, qx, qy, qz), qx, qy, qz);
  const Px = RV[0];
  const Py = RV[1];
  const Pz = RV[2];
  const disp = Math.sqrt((qx - Px) ** 2 + (qy - Py) ** 2 + (qz - Pz) ** 2);
  o.uq[k] = uq;
  o.sg[k] = sg;
  o.px[k] = Px;
  o.py[k] = Py;
  o.pz[k] = Pz;
  o.disp[k] = disp;
  o.x[k] = closeGap(sg * riftU(r, wig, Px, Py, Pz), disp);
  o.ws[k] = shelfWidth(disp, SHELF.wsMax, SHELF.wsK);
  o.wsl[k] = shelfWidth(disp, SHELF.wslMax, SHELF.wslK);
}

export function prepRifts(m: PlanetModel, wig: Noise3 | null, qx: number, qy: number, qz: number, o: DriftState) {
  const rifts = m.rifts;
  for (let k = 0; k < rifts.length; k++) riftAt(rifts[k], wig, qx, qy, qz, k, o);
}

// 漂移前的一点在 sg 那一半上漂移后的位置（建模型时用：转的角度按漂移前的位置取）
function driftForward(r: Rift, sg: number, p: V3): V3 {
  rotate(r.a, sg * riftAngle(r, p[0], p[1], p[2]), p[0], p[1], p[2]);
  return [RV[0], RV[1], RV[2]];
}

// 地峡：到折线（三维的点）的距离与沿线的位置（0–1）
const IS = { d: 0, t: 0 };
function isthmusDist(l: Isthmus, x: number, y: number, z: number) {
  const p = l.pts;
  let best = Infinity;
  let bt = 0;
  for (let s = 0; s + 5 < p.length; s += 3) {
    const ax = p[s];
    const ay = p[s + 1];
    const az = p[s + 2];
    const bx = p[s + 3] - ax;
    const by = p[s + 4] - ay;
    const bz = p[s + 5] - az;
    const L2 = bx * bx + by * by + bz * bz || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / L2));
    const dx = x - ax - t * bx;
    const dy = y - ay - t * by;
    const dz = z - az - t * bz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      const seg = s / 3;
      bt = (l.cum[seg] + t * (l.cum[seg + 1] - l.cum[seg])) / l.cum[l.cum.length - 1];
    }
  }
  IS.d = Math.sqrt(best);
  IS.t = bt;
}

// 一族块漂移后在 q 处的场（不含噪声；裂开的按切口截，不加弯曲噪声）
function famField(m: PlanetModel, fam: number, x: number, y: number, z: number): number {
  const k = m.famRift[fam] ?? -1;
  if (k >= 0) {
    riftAt(m.rifts[k], null, x, y, z, k, DF);
    if (!DF.inb[k]) return -1;
  }
  let c = -1;
  for (const b of m.blocks) {
    if (b.fam !== fam) continue;
    const s = k < 0 ? blockF(b, x, y, z) : Math.min(blockF(b, DF.px[k], DF.py[k], DF.pz[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  return c;
}

function famFieldPre(m: PlanetModel, fam: number, x: number, y: number, z: number): number {
  let c = -1;
  for (const b of m.blocks) if (b.fam === fam) c = Math.max(c, blockF(b, x, y, z));
  return c;
}

function famReach(m: PlanetModel, fam: number, o: V3): number {
  let reach = 0;
  for (const b of m.blocks) {
    if (b.fam !== fam) continue;
    const se = Math.sqrt(b.e);
    reach = Math.max(reach, len(add(b.c, scale(o, -1))) + 2.1 * b.r * Math.max(se, 1 / se) * (b.tri ? 1.3 : 1));
  }
  return reach;
}

// 一处裂开的候选（见 generate.ts 的 riftCandidate）
function riftCandidate(m: PlanetModel, fam: number, b: Block, draws: number[], red: boolean, tr: number, D: number): { r: Rift; reach: number } {
  const se = Math.sqrt(b.e);
  const t0 = tangentAt(b.c, (draws[3] + tr * 0.25) * Math.PI);
  const end = draws[7] < 0.5 ? 1 : -1;
  const t = scale(t0, end);
  const n = unit(cross(t, unit(b.c)));
  const c = scale(unit(add(b.c, scale(n, (draws[4] - 0.5) * 0.4 * b.r))), LAYOUT_R);
  const kappa = ((draws[5] - 0.5) * 1.6) / b.r;
  const delta = Math.min(Math.PI / 2, (red ? b.r * se * (0.8 + 0.5 * draws[6]) : b.r * (3 + 3 * draws[6])) / LAYOUT_R);
  const cu = unit(c);
  // 极：从 c 沿 t 走 delta（弧度）；+ 那一半绕极转 +phi 往 n 走（a × ĉ = sin δ · t × ĉ）
  const a: V3 = unit(add(scale(cu, Math.cos(delta)), scale(unit(add(t, scale(cu, -dot(t, cu)))), Math.sin(delta))));
  const nn = unit(cross(a, cu));
  const mm = unit(add(cu, scale(a, -dot(cu, a))));
  const reach = famReach(m, fam, c);
  const phi = D / 2 / (LAYOUT_R * Math.sin(delta));
  return { r: { fam, c, t: unit(cross(cu, nn)), n: nn, kappa, a, m: mm, phi, ramp: 0.4 * Math.sin(delta), D, red, cb: c, R: reach + phi * LAYOUT_R + 0.05 }, reach };
}

// 裂开（每个够大的块取固定的几个随机数，不管成不成；试法与 generate.ts 的 buildRifts 相同）。布局脚本加的块不裂（profileBlocks 里的才裂）
export function buildRifts(m: PlanetModel, parents: Block[], profileBlocks: Set<Block>, rand: () => number) {
  const { profile } = m;
  for (let fam = 0; fam < parents.length; fam++) {
    const b = parents[fam];
    const draws = Array.from({ length: 8 }, () => rand());
    if (b.r < 0.14 || draws[0] >= 0.5 || (profile.main && fam === 0) || !profileBlocks.has(b) || m.rifts.length >= MAX_RIFTS) continue;
    let made: Rift | null = null;
    for (const red of draws[1] < 0.5 ? [true] : [false, true]) {
      const want = red ? 0.02 + 0.03 * draws[2] : 0.15 + 0.25 * draws[2];
      const minD = red ? 0.02 : 0.06;
      for (let tr = 0; tr < 4 && !(made && made.D >= want); tr++) {
        for (let D = want; D >= minD - 1e-9; D = D > minD && D * 0.75 < minD ? minD : D * 0.75) {
          if (made && D <= made.D) break;
          const { r, reach } = riftCandidate(m, fam, b, draws, red, tr, D);
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
  for (const s of m.swells) {
    for (const r of m.rifts) {
      if (famFieldPre(m, r.fam, s.c[0], s.c[1], s.c[2]) < -0.2) continue;
      s.c = driftForward(r, riftU(r, null, s.c[0], s.c[1], s.c[2]) >= 0 ? 1 : -1, s.c);
      break;
    }
  }
}

// 漂移前这一族块的格点（在 c 的切平面上铺，投回球面；场 > −0.1），带上在哪一半
function famSamples(m: PlanetModel, r: Rift, reach: number): { p: V3; f: number; sg: number }[] {
  const out: { p: V3; f: number; sg: number }[] = [];
  const step = reach / 16;
  for (let i = -16; i <= 16; i++) {
    for (let j = -16; j <= 16; j++) {
      const p = scale(unit(add(r.c, add(scale(r.t, i * step), scale(r.n, j * step)))), LAYOUT_R);
      const f = famFieldPre(m, r.fam, p[0], p[1], p[2]);
      if (f > -0.1) out.push({ p, f, sg: riftU(r, null, p[0], p[1], p[2]) >= 0 ? 1 : -1 });
    }
  }
  return out;
}

// 漂移后不压到别的块上（见 generate.ts 的 riftClear）
function riftClear(m: PlanetModel, r: Rift, reach: number): boolean {
  const other = (p: V3) => {
    let o = -1;
    for (let f = 0; f < m.famRift.length; f++) if (f !== r.fam) o = Math.max(o, famField(m, f, p[0], p[1], p[2]));
    return o;
  };
  for (const s of famSamples(m, r, reach)) {
    const after = other(driftForward(r, s.sg, s.p));
    if (after > -0.3 && after > other(s.p) + 0.02) return false;
  }
  return true;
}

// 板块跟着碎块走（见 generate.ts）：落在碎块中间的板块去掉，两半的重心各放一个板块，绕同一个欧拉极往两边转（0.9–1.2）
function fragmentPlates(m: PlanetModel, rand: () => number) {
  const halves: { c: V3; w: V3 }[] = [];
  for (const r of m.rifts) {
    const pts = famSamples(m, r, famReach(m, r.fam, r.c));
    for (const sg of [1, -1]) {
      let sum: V3 = [0, 0, 0];
      let w = 0;
      for (const s of pts) {
        if (s.sg !== sg || s.f <= 0) continue;
        sum = add(sum, scale(s.p, s.f));
        w += s.f;
      }
      const pre = w ? scale(unit(sum), LAYOUT_R) : scale(unit(add(r.c, scale(r.n, sg * 0.1))), LAYOUT_R);
      const c = scale(unit(driftForward(r, sg, pre)), LAYOUT_R);
      const sinA = Math.sqrt(Math.max(1e-6, 1 - dot(r.a, unit(c)) ** 2));
      halves.push({ c, w: scale(r.a, sg / (LAYOUT_R * sinA)) });
    }
  }
  const inFragment = (p: V3) => m.rifts.some((r) => famField(m, r.fam, p[0], p[1], p[2]) > 0.4);
  const kept = m.plates.filter((p) => !inFragment(p.c));
  const base = kept.length;
  for (const h of halves) {
    const sp = 0.9 + 0.3 * rand();
    kept.push({ c: h.c, w: scale(h.w, sp), weight: 0.035, density: rand(), sib: -1 });
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

// 地峡（见 generate.ts 的 buildIsthmi）：沿两块之间的大圆走
const ISTHMUS_TYPES = new Set<WorldType>(['continents', 'continent', 'fragmented', 'inland_sea']);
export function buildIsthmi(m: PlanetModel, parents: Block[], rand: () => number) {
  const want = rand() < 0.5 ? 1 : 2;
  const bend = Array.from({ length: 6 }, () => rand());
  if (!ISTHMUS_TYPES.has(m.params.type)) return;
  const pieces: { p: V3; fam: number; area: number }[] = [];
  for (let fam = 0; fam < parents.length; fam++) {
    const b = parents[fam];
    const k = m.famRift[fam];
    if (k < 0) {
      pieces.push({ p: b.c, fam, area: famArea(m.blocks, fam) });
      continue;
    }
    const r = m.rifts[k];
    for (const sg of [1, -1]) pieces.push({ p: driftForward(r, sg, scale(unit(add(b.c, scale(r.n, sg * b.r * 0.45))), LAYOUT_R)), fam, area: famArea(m.blocks, fam) / 2 });
  }
  const at = (A: V3, B: V3, t: number): V3 => scale(unit(add(scale(A, 1 - t), scale(B, t))), LAYOUT_R);
  // 连在一起的块（并查集）
  const up = pieces.map((_, k) => k);
  const ta = (k: number): number => (up[k] === k ? k : (up[k] = ta(up[k])));
  const join = (a: number, b: number) => {
    up[ta(a)] = ta(b);
  };
  const cands: { a: number; b: number; pa: V3; pb: V3; L: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const A = pieces[i];
      const B = pieces[j];
      if (A.fam === B.fam) continue;
      const chord = len(add(B.p, scale(A.p, -1)));
      if (chord > 1.0) continue;
      const dist = 2 * LAYOUT_R * Math.asin(Math.min(1, chord / (2 * LAYOUT_R)));
      const N = Math.ceil(dist / 0.004);
      const fa: number[] = [];
      const fb: number[] = [];
      for (let s = 0; s <= N; s++) {
        const p = at(A.p, B.p, s / N);
        fa.push(famField(m, A.fam, p[0], p[1], p[2]));
        fb.push(famField(m, B.fam, p[0], p[1], p[2]));
      }
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
      const pa = at(A.p, B.p, sa / N);
      const pb = at(A.p, B.p, sb / N);
      const L = len(add(pb, scale(pa, -1)));
      if (L < 0.04 || L > 0.4) continue;
      cands.push({ a: i, b: j, pa, pb, L });
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
    const dir = scale(add(c.pb, scale(c.pa, -1)), 1 / c.L);
    const ea = scale(unit(add(c.pa, scale(dir, -0.06))), LAYOUT_R);
    const eb = scale(unit(add(c.pb, scale(dir, 0.06))), LAYOUT_R);
    const mid = scale(unit(add(ea, eb)), LAYOUT_R);
    const side = unit(cross(unit(mid), dir));
    const amt = c.L * (0.25 + 0.25 * bend[made * 3 + 1]) * (bend[made * 3] < 0.5 ? -1 : 1);
    const k = add(mid, scale(side, amt));
    const K = 16;
    const pts = new Float64Array(3 * (K + 1));
    const cum = new Float64Array(K + 1);
    for (let s = 0; s <= K; s++) {
      const t = s / K;
      const p = scale(unit(add(add(scale(ea, (1 - t) * (1 - t)), scale(k, 2 * t * (1 - t))), scale(eb, t * t))), LAYOUT_R);
      pts.set(p, 3 * s);
      if (s) cum[s] = cum[s - 1] + Math.hypot(pts[3 * s] - pts[3 * s - 3], pts[3 * s + 1] - pts[3 * s - 2], pts[3 * s + 2] - pts[3 * s - 1]);
    }
    const w = 0.015 + 0.007 * bend[made * 3 + 2];
    let R = 0;
    for (let s = 0; s <= K; s++) R = Math.max(R, Math.hypot(pts[3 * s] - mid[0], pts[3 * s + 1] - mid[1], pts[3 * s + 2] - mid[2]));
    m.isthmi.push({ pts, cum, w, cb: mid, R: R + w + ISTHMUS_PAD });
  }
}

// 扭曲有沿半径的分量：按方向量（先投回球面），地峡的宽窄不随扭曲变
export const IW = { c: -1, w: 0 };
export function isthmiAt(m: PlanetModel, qx: number, qy: number, qz: number) {
  IW.c = -1;
  IW.w = 0;
  const L = LAYOUT_R / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1);
  const x = qx * L;
  const y = qy * L;
  const z = qz * L;
  for (const l of m.isthmi) {
    const dx = x - l.cb[0];
    const dy = y - l.cb[1];
    const dz = z - l.cb[2];
    if (dx * dx + dy * dy + dz * dz >= l.R * l.R) continue;
    isthmusDist(l, x, y, z);
    IW.c = Math.max(IW.c, isthmusC(IS.d, l.w));
    IW.w = Math.max(IW.w, isthmusW(IS.d, l.w, IS.t));
  }
}

// 统计用（tools/realism.ts）：一点（单位球上的格心）扭曲后的位置（布局坐标）
export function warpedAtPlanet(m: PlanetModel, px: number, py: number, pz: number): V3 {
  return warp(m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R);
}

// 统计用：每条地峡到扭曲后的一点的距离 ÷ 半宽
export function isthmusNearPlanet(m: PlanetModel, q: V3): number[] {
  const L = LAYOUT_R / (Math.hypot(q[0], q[1], q[2]) || 1);
  return m.isthmi.map((l) => {
    isthmusDist(l, q[0] * L, q[1] * L, q[2] * L);
    return IS.d / l.w;
  });
}

// 统计用：单位球上的一点（格心）相对每处裂开：[第几处, 哪一半, 漂移前的位置（布局坐标）, 离切口的 x, 漂移前这一族块的场, 漂移后的 u]
export function riftFramesPlanet(m: PlanetModel, px: number, py: number, pz: number): [number, number, V3, number, number, number][] {
  const [qx, qy, qz] = warp(m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R);
  prepRifts(m, m.noise.rift, qx, qy, qz, DF);
  const out: [number, number, V3, number, number, number][] = [];
  for (let k = 0; k < m.rifts.length; k++) {
    if (!DF.inb[k]) continue;
    out.push([k, DF.sg[k], [DF.px[k], DF.py[k], DF.pz[k]], DF.x[k], famFieldPre(m, m.rifts[k].fam, DF.px[k], DF.py[k], DF.pz[k]), DF.uq[k]]);
  }
  return out;
}
