// 星球上按位置取地壳的各个分量（第八十三轮从 core/planet-gen.ts 原样搬出）：大陆场、板块边界、每格的取样
import { type PlanetModel, LAYOUT_R, type Plate, type V3, len, unit, scale, add, dot, cross, type NoiseSet3, warp } from './planet-gen-model';
import { prepRifts, DF, blockF, isthmiAt, IW, MAX_RIFTS, DS } from './planet-gen-rifts';
import { eHard, eSoft, reliefNear, escNear, ridgeOpen, RIDGE_W } from './outline';
import { type Noise3, smoothstep, fbm3, clamp } from './rng';
import { type TectonicRaster, cachedTectonics, buildTectonics, type TectonicSample, type ReliefInput, type ReliefOut, RIFT_W, sampleTectonics, reliefAt } from './relief';
import { type BaseComponents, oceanFloor } from './generate';

// 大陆场：1 在块中心，0 在块边缘，负值在块外（加上法向分量，球的另一面不会“折回来”）。
// 第三十五轮：裂开的块按漂移后的位置（不加裂谷线的弯曲噪声）、加上地峡（见 generate.ts 的 blockField）
export function blockField(m: PlanetModel, qx: number, qy: number, qz: number): number {
  const nr = m.rifts.length;
  if (nr) prepRifts(m, null, qx, qy, qz, DF);
  let c = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam ?? -1] ?? -1 : -1;
    let s: number;
    if (k < 0) s = blockF(b, qx, qy, qz);
    else if (!DF.inb[k]) continue;
    else s = Math.min(blockF(b, DF.px[k], DF.py[k], DF.pz[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  if (m.isthmi.length) {
    isthmiAt(m, qx, qy, qz);
    if (IW.c > c) c = IW.c;
  }
  return c;
}

// 大陆场与缝合线（第三十二轮，与 generate.ts 的 blockPair 同一个意思）：s1 与 blockField 逐值相同
interface BlockPair {
  s1: number;
  s2: number;
  inner: number;
  innerS: number;
  oth: number;
  best: number;
  fk: Float64Array;
}
const BP: BlockPair = { s1: -1, s2: -1, inner: 1, innerS: -1, oth: -1, best: -1, fk: new Float64Array(MAX_RIFTS) };
function blockPair(m: PlanetModel, wig: Noise3, qx: number, qy: number, qz: number, out: BlockPair) {
  const nr = m.rifts.length;
  if (nr) {
    prepRifts(m, wig, qx, qy, qz, DS);
    out.fk.fill(-1);
  }
  let s1 = -1;
  let f1 = -1;
  let s2 = -1;
  let oth = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam ?? -1] ?? -1 : -1;
    let s: number;
    if (k < 0) {
      s = blockF(b, qx, qy, qz);
      if (s > oth) oth = s;
    } else {
      if (!DS.inb[k]) continue;
      const fv = blockF(b, DS.px[k], DS.py[k], DS.pz[k]);
      if (fv > out.fk[k]) out.fk[k] = fv;
      s = Math.min(fv, eSoft(DS.x[k], DS.ws[k], DS.wsl[k]));
    }
    const f = b.fam ?? -2;
    if (s > s1) {
      if (f !== f1) s2 = s1;
      s1 = s;
      f1 = f;
    } else if (f !== f1 && s > s2) s2 = s;
  }
  out.s1 = s1;
  out.s2 = s2;
  out.oth = oth;
  out.best = -1;
  for (let k = 0; k < nr; k++) if (DS.inb[k] && out.fk[k] > -1 && (out.best < 0 || out.fk[k] > out.fk[out.best])) out.best = k;
  out.inner = 1;
  out.innerS = -1;
  for (const l of m.sutures) {
    const b = m.blocks[l.block];
    const k = nr ? m.famRift[b.fam ?? -1] ?? -1 : -1;
    if (k >= 0 && !DS.inb[k]) continue;
    const cx = k < 0 ? qx : DS.px[k];
    const cy = k < 0 ? qy : DS.py[k];
    const cz = k < 0 ? qz : DS.pz[k];
    const dx = cx - b.c[0];
    const dy = cy - b.c[1];
    const dz = cz - b.c[2];
    const du = dx * b.u[0] + dy * b.u[1] + dz * b.u[2];
    const dv = dx * b.v[0] + dy * b.v[1] + dz * b.v[2];
    const d = Math.abs(du * l.cos + dv * l.sin - l.off * b.r);
    if (d < out.inner) {
      out.inner = d;
      out.innerS = blockF(b, cx, cy, cz);
    }
  }
}

// 板块的栅格（第三十二轮，见 relief.ts）：等距圆柱 512 × 256，铺在球面的方向上（东西相接）
const TW = 512;
const TH = 256;
function tectonicsOf(m: PlanetModel): TectonicRaster {
  if (m.tect) return m.tect;
  const form = m.params.form;
  const key = `globe:${m.params.seed}:${m.params.type}:${form ? JSON.stringify(form) : ''}`;
  m.tect = cachedTectonics(key, () => {
    const pos = new Float64Array(TW * TH * 3);
    const plate = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++) {
      const lat = Math.PI / 2 - ((y + 0.5) / TH) * Math.PI;
      for (let x = 0; x < TW; x++) {
        const lon = ((x + 0.5) / TW) * 2 * Math.PI - Math.PI;
        const k = y * TW + x;
        const X = Math.cos(lat) * Math.cos(lon) * LAYOUT_R;
        const Y = Math.cos(lat) * Math.sin(lon) * LAYOUT_R;
        const Z = Math.sin(lat) * LAYOUT_R;
        pos[3 * k] = X;
        pos[3 * k + 1] = Y;
        pos[3 * k + 2] = Z;
        plate[k] = nearestPlate(m, X, Y, Z);
      }
    }
    return buildTectonics(TW, TH, true, 3, pos, plate, (k, a, b) => {
      const X = pos[3 * k];
      const Y = pos[3 * k + 1];
      const Z = pos[3 * k + 2];
      const pi = pairInfo(m, a, b, power(m.plates[a], X, Y, Z), power(m.plates[b], X, Y, Z), X, Y, Z);
      const n = pi.n;
      const ca = blockField(m, X - 0.04 * n[0], Y - 0.04 * n[1], Z - 0.04 * n[2]);
      const cb = blockField(m, X + 0.04 * n[0], Y + 0.04 * n[1], Z + 0.04 * n[2]);
      const upper = Math.abs(ca - cb) > 0.06 ? (ca > cb ? a : b) : m.plates[a].density < m.plates[b].density ? a : b;
      return { conv: pi.conv, upper, lower: upper === a ? b : a, coll: ca > 0.02 && cb > 0.02, cont: ca > 0.02 || cb > 0.02 };
    });
  });
  return m.tect;
}
const TS: TectonicSample = { dist: 0, up: 0, low: 0, conv: 0, coll: 0 };
const RI: ReliefInput = { c: 0, contW: 0, t: TS, widthMod: 1, nBase: 0, nPlat: 0, nPlatW: 0, nEsc: 0, nSag: 0, nRift: 0, swellR: 9, swellH: 0, riftAxis: 0, shoulder: 0, plates: true, esc: 0 };
const RO: ReliefOut = { T: 0, Tp: 0, pit: 0, rift: 0, erodMul: 1 };

export const power = (p: Plate, x: number, y: number, z: number) => (x - p.c[0]) ** 2 + (y - p.c[1]) ** 2 + (z - p.c[2]) ** 2 - p.weight;

function nearestPlate(m: PlanetModel, x: number, y: number, z: number): number {
  let a = 0;
  let da = Infinity;
  m.plates.forEach((p, k) => {
    const d = power(p, x, y, z);
    if (d < da) {
      da = d;
      a = k;
    }
  });
  return a;
}

export interface PlateInfo {
  a: number;
  b: number;
  bd: number;
  conv: number;
  // 边界法向（点处的切向单位向量，指向另一块）
  n: V3;
}

// 一对板块在点 (x, y, z) 处：到边界的距离、汇聚速度（正为汇聚）、切向法向
export function pairInfo(m: PlanetModel, a: number, b: number, da: number, db: number, x: number, y: number, z: number): PlateInfo {
  const pa = m.plates[a];
  const pb = m.plates[b];
  const d: V3 = [pb.c[0] - pa.c[0], pb.c[1] - pa.c[1], pb.c[2] - pa.c[2]];
  const L = len(d) || 1e-6;
  const P: V3 = [x, y, z];
  const ph = unit(P);
  const raw = scale(d, 1 / L);
  const nt0 = add(raw, scale(ph, -dot(raw, ph)));
  const ntl = len(nt0);
  const n: V3 = ntl > 1e-9 ? scale(nt0, 1 / ntl) : [0, 0, 0];
  const rel = cross([pa.w[0] - pb.w[0], pa.w[1] - pb.w[1], pa.w[2] - pb.w[2]], P);
  return { a, b, bd: (db - da) / (2 * L), conv: dot(rel, n), n };
}

// 一格的生成结果（双精度，写进 Float32 数组之前）。地形脚本要用双精度的原值，所以先算到这里
interface CellSample {
  B: number;
  mountB: number;
  mountU: number;
  hillU: number;
  erod: number;
  // 大陆场（地形脚本的 continent）
  c: number;
  // 洋底的目标深度（见 generate.ts 的 oceanFloor）；地形脚本不改它
  sea: number;
  // 第三十二轮：基准面、高原、洼地（见 relief.ts）；地形脚本还不能改它们
  T: number;
  Tp: number;
  pit: number;
  rift: number;
}
export const S: CellSample = { B: 0, mountB: 0, mountU: 0, hillU: 0, erod: 0, c: 0, sea: 0, T: 0, Tp: 0, pit: 0, rift: 0 };

export function sampleInto(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, out: BaseComponents, i: number) {
  sampleRaw(m, ns, x, y, z, S, true);
  out.b0[i] = S.B;
  out.mountB[i] = S.mountB;
  out.mountU[i] = S.mountU;
  out.hillU[i] = S.hillU;
  out.erod[i] = S.erod;
  out.sea[i] = S.sea;
  out.T[i] = S.T;
  out.Tp[i] = S.Tp;
  out.pit[i] = S.pit;
  out.rift[i] = S.rift;
}

// 造山带对地壳高度的贡献（“山多高”= 1 时）。地形脚本改了山的强弱后按同一个式子重算
export const mountBOf = (mountU: number, c: number) => 1600 * mountU * smoothstep(-0.05, 0.05, c);

// plates：算不算板块边界。只有地形脚本真的算了的那一遍（crustMode 'replace'）才不算
export function sampleRaw(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, s: CellSample, plates: boolean) {
  const prof = m.profile;
  const t = m.tuning;
  const [qx, qy, qz] = warp(ns, x, y, z);
  // c：定海陆的大陆场；cs：“形状”场；(nqx, nqy, nqz)：大陆的噪声在哪里取（见 generate.ts 的 sampleInto）
  let c = -1;
  let cs = -1;
  let nqx = qx;
  let nqy = qy;
  let nqz = qz;
  let reliefW = 1;
  let esc = 0;
  let isW = 0;
  let ridgeR = 0;
  let ageR = 1;
  if (m.blocks.length) {
    // 大陆场，顺带缝合线（第三十二轮）
    blockPair(m, ns.rift, qx, qy, qz, BP);
    const nr = m.rifts.length;
    const kb = nr ? BP.best : -1;
    if (kb >= 0) {
      // 这一族占上风、又离它不远（范围的边上场 < −1，渐渐不用漂移前的位置，不出接缝）
      const wN = smoothstep(-0.15, 0.15, BP.fk[kb] - BP.oth) * smoothstep(-0.6, -0.35, BP.fk[kb]);
      nqx = qx + wN * (DS.px[kb] - qx);
      nqy = qy + wN * (DS.py[kb] - qy);
      nqz = qz + wN * (DS.pz[kb] - qz);
      reliefW = 1 - wN * (1 - reliefNear(DS.x[kb]));
      esc = wN * escNear(DS.x[kb]);
    }
    const f = 1 / Math.max(0.1, m.meanR);
    const N = 0.42 * fbm3(ns.block, nqx, nqy, nqz, 1.5 * f, 4, 0.55) + 0.18 * fbm3(ns.hills, nqx + 9.1, nqy - 4.3, nqz, 6 * f, 4, 0.62);
    if (!nr) {
      c = BP.s1 + N;
      cs = c;
    } else {
      c = BP.oth + N;
      cs = c;
      for (let k = 0; k < nr; k++) {
        if (!DS.inb[k]) continue;
        const v = BP.fk[k] + N;
        c = Math.max(c, Math.min(v, eHard(DS.x[k], DS.ws[k], DS.wsl[k])));
        cs = Math.max(cs, Math.min(v, eSoft(DS.x[k], DS.ws[k], DS.wsl[k])));
        // 缝里的洋中脊（两侧海底的年龄对称）
        const r = m.rifts[k];
        const open = ridgeOpen(DS.disp[k]) * (1 - smoothstep(0.75, 1, Math.hypot(qx - r.cb[0], qy - r.cb[1], qz - r.cb[2]) / r.R));
        if (open > 0) {
          const uq = DS.uq[k];
          ridgeR = Math.max(ridgeR, open * Math.exp(-((uq / RIDGE_W) ** 2)));
          ageR = Math.min(ageR, Math.abs(uq) + 0.5 * (1 - open));
        }
      }
    }
    // 地峡只在原来的噪声里有：重新生成一片（另一套噪声）圈到地峡上时它跟着重新生成（可能断开）
    if (m.isthmi.length && ns === m.noise) {
      isthmiAt(m, qx, qy, qz);
      if (IW.c > c) c = IW.c;
      if (IW.c > cs) cs = IW.c;
      isW = IW.w;
      reliefW *= 1 - 0.7 * isW;
    }
  }

  // 地壳：大陆架 → 陆坡 → 深海（与 generate.ts 相同）
  const slopeW = 0.08;
  let B: number;
  if (c >= 0) B = -140 + 650 * Math.min(c, 0.16) + prof.rise * Math.max(0, c - 0.16);
  else if (c >= -slopeW) B = -140 - 3800 * smoothstep(0, 1, -c / slopeW);
  else B = -3940;
  const rw = smoothstep(-slopeW, 0.06, c);
  B += prof.relief * rw * reliefW * fbm3(ns.relief, nqx, nqy, nqz, 2.6, 9, 0.62);
  B += 230 * (1 - rw) * fbm3(ns.ocean, qx, qy, qz, 5, 4);

  // 板块边界：在更弯曲的坐标里求
  const px = qx + 0.07 * fbm3(ns.seg, qx + 11.3, qy, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy + 4.4, qz, 5.5, 2);
  const py = qy + 0.07 * fbm3(ns.seg, qx, qy - 7.9, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx - 2.2, qy, qz, 5.5, 2);
  const pz = qz + 0.07 * fbm3(ns.seg, qx, qy, qz + 6.1, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy, qz - 3.3, 5.5, 2);
  const oceanW = 1 - smoothstep(-0.12, 0, cs);
  const contW = smoothstep(-0.02, 0.1, cs);
  const widthMod = 0.65 + 0.7 * (0.5 + 0.5 * fbm3(ns.hills, px * 0.7, py * 0.7, pz * 0.7, 2.5, 2));
  const seg = smoothstep(-0.35, 0.3, fbm3(ns.seg, qx, qy, qz, 3.5, 3));
  const ridged = 1 - Math.abs(fbm3(ns.ridge, qx, qy, qz, 10, 4));
  const wc = t.wc * widthMod;
  const wm = t.wm * widthMod;
  const belt = (bd: number, w: number) => Math.exp(-((bd / w) ** 2)) + 0.5 * Math.exp(-(((bd - 2.4 * w) / (0.6 * w)) ** 2));
  let ridge = 0;
  let rift = 0;
  let trench = 0;
  let mm = 0;
  // 到最近的离散边界的距离（按扩张速度缩放）：洋壳的年龄
  let age = 1;
  // 裂谷轴（窄）、裂谷肩（两侧）：离交界很近，按 bd
  let riftAxis = 0;
  let shoulder = 0;
  // 星球形态的 crustMode 'replace'：不算板块边界（山带、洋中脊、海沟、裂谷都没有）
  if (plates) {
    const a = nearestPlate(m, px, py, pz);
    const da = power(m.plates[a], px, py, pz);
    for (let b = 0; b < m.plates.length; b++) {
      if (b === a) continue;
      const db = power(m.plates[b], px, py, pz);
      const pa = m.plates[a];
      const pb = m.plates[b];
      const L = Math.sqrt((pb.c[0] - pa.c[0]) ** 2 + (pb.c[1] - pa.c[1]) ** 2 + (pb.c[2] - pa.c[2]) ** 2) || 1e-6;
      const bd = (db - da) / (2 * L);
      if (bd > t.reach) continue;
      const pi = pairInfo(m, a, b, da, db, px, py, pz);
      const conv = pi.conv;
      if (conv < 0) {
        // 裂开的两半之间：洋中脊、裂谷按裂谷线画（ridgeR、ageR），不按板块的平分线
        if (pb.sib === a) continue;
        const div = Math.min(1, -conv);
        ridge = Math.max(ridge, div * Math.exp(-((bd / 0.04) ** 2)));
        rift = Math.max(rift, div * Math.exp(-((bd / 0.025) ** 2)));
        riftAxis = Math.max(riftAxis, div * Math.exp(-((bd / RIFT_W) ** 2)));
        shoulder = Math.max(shoulder, div * Math.exp(-(((bd - 0.042) / 0.018) ** 2)));
        age = Math.min(age, bd / (0.45 + 0.55 * div));
        continue;
      }
      const cOther = blockField(m, qx + 2 * bd * pi.n[0], qy + 2 * bd * pi.n[1], qz + 2 * bd * pi.n[2]);
      const wb = smoothstep(-0.02, 0.1, cOther);
      const cv = Math.min(1.3, conv);
      const subducts = (1 - contW) * Math.max(wb, pa.density > pb.density ? 1 : 0);
      trench = Math.max(trench, Math.min(1, cv) * Math.exp(-(((bd - 0.012) / 0.012) ** 2)) * subducts);
      const collision = contW * wb;
      const margin = contW * (1 - wb);
      const shape = collision * (belt(bd, wc) + 0.45 * Math.exp(-((bd / (3 * wc)) ** 2))) + margin * belt(bd, wm);
      mm = Math.max(mm, cv * shape);
    }
  }
  ridge = Math.max(ridge, ridgeR);
  age = Math.min(age, ageR);
  B += t.ridgeH * ridge * oceanW - t.riftH * rift * contW * (1 - isW) - t.trenchH * trench * oceanW;
  const mountU0 = mm * (0.3 + 0.7 * seg) * (0.55 + 0.6 * ridged);
  // 老山（第三十二轮）：两块相接处与块内的缝合线上低矮的抬升（放在丘陵里：不改地壳高度、不改海陆）；沿缝合线的岩性条纹。
  // 算板块时才有（crustMode 'replace' 的地形完全由脚本决定）
  let suture = 0;
  let stripe = 0;
  if (plates && m.blocks.length) {
    const gap = BP.s1 - BP.s2;
    const pair = smoothstep(0.0, 0.08, BP.s2);
    const inner = smoothstep(0.1, 0.3, BP.innerS);
    const pz2 = pair * Math.exp(-((gap / 0.07) ** 2));
    const iz2 = inner * Math.exp(-((BP.inner / 0.05) ** 2));
    suture = Math.max(pair * Math.exp(-((gap / 0.035) ** 2)), inner * Math.exp(-((BP.inner / 0.025) ** 2)));
    stripe = Math.max(pz2, iz2) * Math.sin(((pz2 >= iz2 ? gap : BP.inner) / 0.022) * Math.PI * 2);
  }
  // 老山的抬升放在丘陵里（不改造山带、不改地壳高度，地形脚本照原样返回时与没有脚本逐位相同）
  const oldU = 0.22 * suture * ridged * contW;
  // 大格局：基准面、高原、洼地、岩性的倍数（板块来的几项在 replace 时是 0）
  if (plates) {
    const pl = Math.hypot(px, py, pz) || 1;
    const lat = Math.asin(Math.max(-1, Math.min(1, pz / pl)));
    const lon = Math.atan2(py, px);
    sampleTectonics(tectonicsOf(m), ((lon + Math.PI) / (2 * Math.PI)) * TW - 0.5, ((Math.PI / 2 - lat) / Math.PI) * TH - 0.5, TS);
  }
  let swellR = 9;
  let swellH = 0;
  if (m.swells.length) {
    const wob = 1 + 0.25 * fbm3(ns.plat, qx - 3.3, qy + 8.8, qz, 6, 2);
    for (const sp of m.swells) {
      const r = (Math.hypot(qx - sp.c[0], qy - sp.c[1], qz - sp.c[2]) * wob) / sp.r;
      if (r < swellR) {
        swellR = r;
        swellH = sp.h;
      }
    }
  }
  RI.c = cs;
  RI.contW = contW;
  RI.widthMod = widthMod;
  // 大陆的低频噪声在漂移前的位置上取；高原分段、裂谷分段跟着板块
  RI.nBase = fbm3(ns.big, nqx, nqy, nqz, 2.2, 3);
  RI.nPlat = fbm3(ns.plat, qx, qy, qz, 3, 2);
  RI.nPlatW = fbm3(ns.plat, qx + 5.3, qy - 2.1, qz, 2, 2);
  RI.nEsc = fbm3(ns.big, nqx - 7.7, nqy + 3.3, nqz, 3, 2);
  RI.nSag = fbm3(ns.sag, nqx, nqy, nqz, 2.6, 3);
  RI.nRift = fbm3(ns.sag, qx + 4.4, qy - 6.6, qz, 3.5, 2);
  RI.swellR = swellR;
  RI.swellH = swellH;
  RI.riftAxis = riftAxis * contW;
  RI.shoulder = shoulder;
  RI.plates = plates;
  RI.esc = esc;
  reliefAt(RI, RO);
  s.B = B;
  s.mountB = mountBOf(mountU0, cs);
  s.mountU = mountU0;
  s.hillU = t.hills * Math.max(0, fbm3(ns.hills, nqx, nqy, nqz, 6, 4)) * contW + oldU;
  s.erod = clamp((1 + 0.45 * fbm3(ns.erod, x + 7.7, y - 3.1, z + 1.9, 6, 3)) * RO.erodMul * (1 + 0.45 * stripe), 0.4, 1.8);
  s.T = RO.T;
  s.Tp = RO.Tp;
  s.pit = RO.pit;
  s.rift = RO.rift;
  s.c = cs;
  s.sea = oceanFloor(age, trench, t.ridgeH, t.trenchH, fbm3(ns.ocean, qx - 4.1, qy + 2.3, qz + 1.1, 3, 4), fbm3(ns.ocean, qx + 6.2, qy - 8.4, qz - 0.7, 24, 3));
}
