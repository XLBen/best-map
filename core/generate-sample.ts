// 按位置取地壳的各个分量（第八十三轮从 core/generate.ts 原样搬出）：大陆场、板块边界、每格的取样
import { type GenModel, type Reroll, noiseSet, type NoiseSet, warp } from './generate-model';
import { prepRifts, DF, blockF, isthmiAt, IW, MAX_RIFTS, DS } from './generate-rifts';
import { eHard, eSoft, reliefNear, escNear, ridgeOpen, RIDGE_W } from './outline';
import { type Noise2, smoothstep, fbm, clamp } from './rng';
import { type TectonicRaster, cachedTectonics, buildTectonics, type TectonicSample, type ReliefInput, type ReliefOut, RIFT_W, sampleTectonics, reliefAt } from './relief';
import type { ScriptIssue } from './script';
import type { Mesh } from './mesh';

// 大陆场（不含噪声）：1 在块中心，0 在块边缘，负值在块外。
// 第三十五轮：裂开的块按漂移后的位置（漂移前的场按切口截；不加裂谷线的弯曲噪声：只给“哪边是大陆”这类判断用）、加上地峡
export function blockField(m: GenModel, x: number, y: number): number {
  const nr = m.rifts.length;
  if (nr) prepRifts(m, null, x, y, DF);
  let c = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam] : -1;
    let s: number;
    if (k < 0) s = blockF(b, x, y);
    else if (!DF.inb[k]) continue;
    else s = Math.min(blockF(b, DF.px[k], DF.py[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  if (m.isthmi.length) {
    isthmiAt(m, x, y);
    if (IW.c > c) c = IW.c;
  }
  return c;
}

// 大陆场与缝合线（第三十二轮）：最近的块（与 blockField 逐值相同）、不同的块里最近的那个（两者差不多时是两块相接的缝合线），
// 块内的缝合线：到最近的一条的距离（地图单位）与这块的场
// 第三十五轮：裂开的块在漂移前的位置上算（每处裂开先 prepRifts 到 DS），s1、s2 用按切口截过的（eSoft）；
// 另记没裂开的块的场的最大（oth）、每处裂开那一族块不截的场（fk）与 fk 最大的那一处（best，没有是 −1）
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
function blockPair(m: GenModel, wig: Noise2, x: number, y: number, out: BlockPair) {
  const nr = m.rifts.length;
  if (nr) {
    prepRifts(m, wig, x, y, DS);
    out.fk.fill(-1);
  }
  let s1 = -1;
  let f1 = -1;
  let s2 = -1;
  let oth = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam] : -1;
    let s: number;
    if (k < 0) {
      s = blockF(b, x, y);
      if (s > oth) oth = s;
    } else {
      if (!DS.inb[k]) continue;
      const f = blockF(b, DS.px[k], DS.py[k]);
      if (f > out.fk[k]) out.fk[k] = f;
      s = Math.min(f, eSoft(DS.x[k], DS.ws[k], DS.wsl[k]));
    }
    if (s > s1) {
      if (b.fam !== f1) s2 = s1;
      s1 = s;
      f1 = b.fam;
    } else if (b.fam !== f1 && s > s2) s2 = s;
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
    const k = nr ? m.famRift[b.fam] : -1;
    if (k >= 0 && !DS.inb[k]) continue;
    const cx = k < 0 ? x : DS.px[k];
    const cy = k < 0 ? y : DS.py[k];
    const dx = cx - b.x;
    const dy = cy - b.y;
    const d = Math.abs(dx * l.cos + dy * l.sin - l.off * b.r);
    if (d < out.inner) {
      out.inner = d;
      out.innerS = blockF(b, cx, cy);
    }
  }
}

// 板块的栅格（第三十二轮，见 relief.ts）：板块坐标铺满地图外扩 0.3 的范围，每像素约 0.0068（宽 2 的地图 384 列）
const TECT_PAD = 0.3;
function tectonicsOf(m: GenModel): TectonicRaster {
  if (m.tect) return m.tect;
  const key = `flat:${m.params.seed}:${m.params.type}:${m.width}:${m.height}`;
  m.tect = cachedTectonics(key, () => {
    const px = (m.width + 2 * TECT_PAD) / 384;
    const W = 384;
    const H = Math.ceil((m.height + 2 * TECT_PAD) / px);
    const pos = new Float64Array(W * H * 2);
    const plate = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const X = -TECT_PAD + (x + 0.5) * px;
        const Y = -TECT_PAD + (y + 0.5) * px;
        pos[2 * k] = X;
        pos[2 * k + 1] = Y;
        plate[k] = nearestPlate(m, X, Y);
      }
    }
    return buildTectonics(W, H, false, 2, pos, plate, (k, a, b) => {
      const X = pos[2 * k];
      const Y = pos[2 * k + 1];
      const pa = m.plates[a];
      const pb = m.plates[b];
      const L = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1e-6;
      const nx = (pb.x - pa.x) / L;
      const ny = (pb.y - pa.y) / L;
      const conv = (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny;
      const ca = blockField(m, X - 0.04 * nx, Y - 0.04 * ny);
      const cb = blockField(m, X + 0.04 * nx, Y + 0.04 * ny);
      const upper = Math.abs(ca - cb) > 0.06 ? (ca > cb ? a : b) : pa.density < pb.density ? a : b;
      return { conv, upper, lower: upper === a ? b : a, coll: ca > 0.02 && cb > 0.02, cont: ca > 0.02 || cb > 0.02 };
    });
  });
  return m.tect;
}
const TS: TectonicSample = { dist: 0, up: 0, low: 0, conv: 0, coll: 0 };
const RI: ReliefInput = { c: 0, contW: 0, t: TS, widthMod: 1, nBase: 0, nPlat: 0, nPlatW: 0, nEsc: 0, nSag: 0, nRift: 0, swellR: 9, swellH: 0, riftAxis: 0, shoulder: 0, plates: true, esc: 0 };
const RO: ReliefOut = { T: 0, Tp: 0, pit: 0, rift: 0, erodMul: 1 };

function nearestPlate(m: GenModel, x: number, y: number): number {
  let a = 0;
  let da = Infinity;
  m.plates.forEach((p, k) => {
    const d = (x - p.x) ** 2 + (y - p.y) ** 2 - p.weight;
    if (d < da) {
      da = d;
      a = k;
    }
  });
  return a;
}

// 每格的生成结果分量；海平面与各滑块在 composeBase 里组合，滑块变化时不必重算这些
export interface BaseComponents {
  // 地壳高度（不含造山带与火山锥，m）
  b0: Float32Array;
  // 造山带对地壳高度与抬升的贡献（“山多高”= 1 时）
  mountB: Float32Array;
  mountU: Float32Array;
  hillU: Float32Array;
  erod: Float32Array;
  // 洋底的目标深度（m，与 b0 同一个基准，不含火山锥）：随离洋中脊变深（洋壳年龄）、海沟。
  // 只给海底的后处理用（见 elevation.ts 的 seafloor），不影响陆海与陆地
  sea: Float32Array;
  // 第三十二轮（见 relief.ts）：基准面 T（不含高原）、高原 Tp（“山多高”= 1 时）、洼地 pit，都是米，只在陆壳上
  T: Float32Array;
  Tp: Float32Array;
  pit: Float32Array;
  // 洼地里裂谷的那一部分（米；统计裂谷湖用）
  rift: Float32Array;
  // 不含重画的地壳高度（海平面按它定）：重画一片不挪海平面，只重算圈里的陆块。同一个模型的各份分量共用这一个数组（只读）
  seaB0: Float32Array;
  // 星球形态的地形脚本这次出的问题（出错的那一遍按没有脚本算，见 planet-gen.ts）。普通的 JSON，只给界面看；没有地形脚本时不存在
  issues?: ScriptIssue[];
}

// 局部重算：只重算 changed 这些重画圈里的格，其余格照抄 from。
// 圈外的格，覆盖它的重画都在新旧两组共同的前缀里（顺序也相同），所以值逐位不变
export interface Resample {
  from: BaseComponents;
  changed: Reroll[];
}

export const copyComponents = (c: BaseComponents): BaseComponents => ({
  b0: c.b0.slice(),
  mountB: c.mountB.slice(),
  mountU: c.mountU.slice(),
  hillU: c.hillU.slice(),
  erod: c.erod.slice(),
  sea: c.sea.slice(),
  T: c.T.slice(),
  Tp: c.Tp.slice(),
  pit: c.pit.slice(),
  rift: c.rift.slice(),
  // 不随重画变：共用（重算圈里的格时写进去的是同一个值）
  seaB0: c.seaB0,
});

export function sampleComponents(m: GenModel, mesh: Mesh, re?: Resample): BaseComponents {
  const n = mesh.n;
  const out: BaseComponents = re ? copyComponents(re.from) : emptyBaseComponents(n);
  const rerolls = m.params.rerolls;
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i];
    const y = mesh.y[i];
    // 与 sampleCell 里同一个“在圈内”的判断
    if (re && re.changed.every((r) => Math.hypot(x - r.x, y - r.y) >= r.radius)) continue;
    sampleCell(m, rerolls, x, y, out, i);
  }
  return out;
}

// 空闲预热（第三十一轮，见 terrain.ts 的 warmTerrainSteps）：从头采样的一段格 [from, to)，写进 out（新建的空分量）。
// 每格与 sampleComponents 不带 re 时的那一格是同一个调用，分几段采完与一次采完逐值相同
export function sampleComponentRange(m: GenModel, mesh: Mesh, out: BaseComponents, from: number, to: number) {
  const rerolls = m.params.rerolls;
  for (let i = from; i < to; i++) sampleCell(m, rerolls, mesh.x[i], mesh.y[i], out, i);
}

export const emptyBaseComponents = (n: number): BaseComponents => ({
  b0: new Float32Array(n),
  mountB: new Float32Array(n),
  mountU: new Float32Array(n),
  hillU: new Float32Array(n),
  erod: new Float32Array(n),
  sea: new Float32Array(n),
  T: new Float32Array(n),
  Tp: new Float32Array(n),
  pit: new Float32Array(n),
  rift: new Float32Array(n),
  seaB0: new Float32Array(n),
});

// 一格：原来的噪声，再按顺序叠上覆盖它的各次重画
function sampleCell(m: GenModel, rerolls: Reroll[], x: number, y: number, out: BaseComponents, i: number) {
  sampleInto(m, m.noise, x, y, out, i);
  out.seaB0[i] = out.b0[i];
  // 重画这一片：区域内换一套噪声，边缘羽化
  for (const r of rerolls) {
    const d = Math.hypot(x - r.x, y - r.y);
    if (d >= r.radius) continue;
    let ns = m.variants.get(r.variant);
    if (!ns) {
      ns = noiseSet(m.params.seed, r.variant);
      m.variants.set(r.variant, ns);
    }
    const tmp = emptyBaseComponents(1);
    sampleInto(m, ns, x, y, tmp, 0);
    const w = 1 - smoothstep(0.6, 1, d / r.radius);
    out.b0[i] += (tmp.b0[0] - out.b0[i]) * w;
    out.mountB[i] += (tmp.mountB[0] - out.mountB[i]) * w;
    out.mountU[i] += (tmp.mountU[0] - out.mountU[i]) * w;
    out.hillU[i] += (tmp.hillU[0] - out.hillU[i]) * w;
    out.sea[i] += (tmp.sea[0] - out.sea[i]) * w;
    out.T[i] += (tmp.T[0] - out.T[i]) * w;
    out.Tp[i] += (tmp.Tp[0] - out.Tp[i]) * w;
    out.pit[i] += (tmp.pit[0] - out.pit[i]) * w;
    out.rift[i] += (tmp.rift[0] - out.rift[i]) * w;
  }
}

// 洋底的目标深度（第十二轮）：板块冷却——洋壳离洋中脊越远越老、越深（轴部约 −2600 m，远处约 −5300 m），
// age 是到最近的离散边界的距离（扩张快的洋中脊更宽：距离按扩张速度缩短）；海沟处往下拉到 −7000 到 −10000 m；
// 再加深海丘陵的起伏。ridgeH、trenchH 是洋中脊、海沟的强弱（星球形态可以调，地区地图是 1700、2600）
export function oceanFloor(age: number, trench: number, ridgeH: number, trenchH: number, lo: number, hi: number): number {
  let z = -5300 + 2700 * (ridgeH / 1700) * Math.exp(-age / 0.12);
  z += 200 * lo + 110 * hi;
  return z + trench * (trenchH / 2600) * 0.8 * (-10200 - z);
}

function sampleInto(m: GenModel, ns: NoiseSet, x: number, y: number, out: BaseComponents, i: number) {
  const prof = m.profile;
  const [qx, qy] = warp(ns, x, y);
  // c：定海陆的大陆场；cs：“形状”场（造山、基准面、丘陵用；第三十五轮：裂开的海岸上与 c 不同，见 outline.ts）。
  // (nqx, nqy)：大陆的噪声在哪里取——裂开的那一族块占上风时是漂移前的位置（两岸的海岸、起伏对得上），离开时渐渐回到 (qx, qy)
  let c = -1;
  let cs = -1;
  let nqx = qx;
  let nqy = qy;
  let reliefW = 1;
  let esc = 0;
  let isW = 0;
  let ridgeR = 0;
  let ageR = 1;
  if (m.blocks.length) {
    // 大陆场，顺带缝合线（第三十二轮）
    blockPair(m, ns.rift, qx, qy, BP);
    const nr = m.rifts.length;
    const kb = nr ? BP.best : -1;
    if (kb >= 0) {
      // 这一族占上风、又离它不远（范围的边上场 < −1，渐渐不用漂移前的位置，不出接缝）
      const wN = smoothstep(-0.15, 0.15, BP.fk[kb] - BP.oth) * smoothstep(-0.6, -0.35, BP.fk[kb]);
      nqx = qx + wN * (DS.px[kb] - qx);
      nqy = qy + wN * (DS.py[kb] - qy);
      reliefW = 1 - wN * (1 - reliefNear(DS.x[kb]));
      esc = wN * escNear(DS.x[kb]);
    }
    // 低频造大半岛、大海湾，中频让海岸参差
    const f = 1 / Math.max(0.1, m.meanR);
    const N = 0.42 * fbm(ns.block, nqx, nqy, 1.5 * f, 4, 0.55) + 0.18 * fbm(ns.hills, nqx + 9.1, nqy - 4.3, 6 * f, 4, 0.62);
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
        // 缝里的洋中脊：按漂移后的位置离原来的裂谷线（两半对称地转开，中线就是原来的线），两侧海底的年龄对称
        const r = m.rifts[k];
        const open = ridgeOpen(DS.disp[k]) * (1 - smoothstep(0.75, 1, Math.hypot(qx - r.cx, qy - r.cy) / r.R));
        if (open > 0) {
          const uq = DS.uq[k];
          ridgeR = Math.max(ridgeR, open * Math.exp(-((uq / RIDGE_W) ** 2)));
          ageR = Math.min(ageR, Math.abs(uq) + 0.5 * (1 - open));
        }
      }
    }
    // 地峡只在原来的噪声里有：重新生成一片（另一套噪声）圈到地峡上时它跟着重新生成（可能断开）
    if (m.isthmi.length && ns === m.noise) {
      isthmiAt(m, qx, qy);
      if (IW.c > c) c = IW.c;
      if (IW.c > cs) cs = IW.c;
      isW = IW.w;
      reliefW *= 1 - 0.7 * isW;
    }
  }

  // 地壳：大陆架 → 陆坡 → 深海
  const slopeW = 0.08;
  let B: number;
  // 海岸带（大陆架外缘到沿海平原）坡度平缓，海平面附近的起伏因此能塑造出曲折的海岸和近岸小岛；再往内陆才抬升
  if (c >= 0) B = -140 + 650 * Math.min(c, 0.16) + prof.rise * Math.max(0, c - 0.16);
  else if (c >= -slopeW) B = -140 - 3800 * smoothstep(0, 1, -c / slopeW);
  else B = -3940;
  const rw = smoothstep(-slopeW, 0.06, c);
  // 分形起伏（H≈0.7）：低频造出半岛海湾，高频一直细到格尺度，海岸因此是分形的
  B += prof.relief * rw * reliefW * fbm(ns.relief, nqx, nqy, 2.6, 9, 0.62);
  B += 230 * (1 - rw) * fbm(ns.ocean, qx, qy, 5, 4);

  // 板块边界：在更弯曲的坐标里求，边界因此蜿蜒而不是直线
  const px = qx + 0.07 * fbm(ns.seg, qx + 11.3, qy, 1.7, 3) + 0.022 * fbm(ns.ridge, qx, qy + 4.4, 5.5, 2);
  const py = qy + 0.07 * fbm(ns.seg, qx, qy - 7.9, 1.7, 3) + 0.022 * fbm(ns.ridge, qx - 2.2, qy, 5.5, 2);
  const oceanW = 1 - smoothstep(-0.12, 0, cs);
  const contW = smoothstep(-0.02, 0.1, cs);
  // 宽度、高度沿走向变化；分段（有缺口）；脊状噪声造出支脉
  const widthMod = 0.65 + 0.7 * (0.5 + 0.5 * fbm(ns.hills, px * 0.7, py * 0.7, 2.5, 2));
  const seg = smoothstep(-0.35, 0.3, fbm(ns.seg, qx, qy, 3.5, 3));
  const ridged = 1 - Math.abs(fbm(ns.ridge, qx, qy, 10, 4));
  const wc = 0.055 * widthMod;
  const wm = 0.032 * widthMod;
  const belt = (bd: number, w: number) => Math.exp(-((bd / w) ** 2)) + 0.5 * Math.exp(-(((bd - 2.4 * w) / (0.6 * w)) ** 2));
  // 对周围每条边界分别求贡献再取最大：离边界远时“第二近的板块”会突变，只看一条边界会把山带齐刷刷切断
  const a = nearestPlate(m, px, py);
  const pa = m.plates[a];
  const da = (px - pa.x) ** 2 + (py - pa.y) ** 2 - pa.weight;
  let ridge = 0;
  let rift = 0;
  let trench = 0;
  let mm = 0;
  // 到最近的离散边界的距离（按扩张速度缩放）：洋壳的年龄
  let age = 1;
  // 裂谷轴（窄）、裂谷肩（两侧）：离交界很近，按 bd
  let riftAxis = 0;
  let shoulder = 0;
  for (let b = 0; b < m.plates.length; b++) {
    if (b === a) continue;
    const pb = m.plates[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const L = Math.hypot(dx, dy) || 1e-6;
    const db = (px - pb.x) ** 2 + (py - pb.y) ** 2 - pb.weight;
    const bd = (db - da) / (2 * L);
    if (bd > 0.3) continue;
    const nx = dx / L;
    const ny = dy / L;
    const conv = (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny;
    if (conv < 0) {
      // 裂开的两半之间：洋中脊、裂谷按裂谷线画（上面的 ridgeR、ageR），不按板块的平分线
      if (pb.sib === a) continue;
      const div = Math.min(1, -conv);
      ridge = Math.max(ridge, div * Math.exp(-((bd / 0.04) ** 2)));
      rift = Math.max(rift, div * Math.exp(-((bd / 0.025) ** 2)));
      riftAxis = Math.max(riftAxis, div * Math.exp(-((bd / RIFT_W) ** 2)));
      shoulder = Math.max(shoulder, div * Math.exp(-(((bd - 0.042) / 0.018) ** 2)));
      age = Math.min(age, bd / (0.45 + 0.55 * div));
      continue;
    }
    // 两侧的大陆程度连续混合：碰撞带（两侧都是大陆）、大陆边缘山脉（本侧大陆、对侧大洋）、海沟（本侧大洋）
    const cOther = blockField(m, qx + 2 * bd * nx, qy + 2 * bd * ny);
    const wb = smoothstep(-0.02, 0.1, cOther);
    const cv = Math.min(1.3, conv);
    const subducts = (1 - contW) * Math.max(wb, pa.density > pb.density ? 1 : 0);
    trench = Math.max(trench, Math.min(1, cv) * Math.exp(-(((bd - 0.012) / 0.012) ** 2)) * subducts);
    const collision = contW * wb;
    const margin = contW * (1 - wb);
    const shape = collision * (belt(bd, wc) + 0.45 * Math.exp(-((bd / (3 * wc)) ** 2))) + margin * belt(bd, wm);
    mm = Math.max(mm, cv * shape);
  }
  ridge = Math.max(ridge, ridgeR);
  age = Math.min(age, ageR);
  B += 1700 * ridge * oceanW - 900 * rift * contW * (1 - isW) - 2600 * trench * oceanW;
  const mountU0 = mm * (0.3 + 0.7 * seg) * (0.55 + 0.6 * ridged);
  const mountB = 1600 * mountU0 * smoothstep(-0.05, 0.05, cs);
  // 老山（第三十二轮）：两块相接处与块内的缝合线上低矮的抬升（不改地壳高度、不改海陆）；沿缝合线的岩性条纹 → 格子状水系
  let suture = 0;
  let stripe = 0;
  if (m.blocks.length) {
    const gap = BP.s1 - BP.s2;
    const pair = smoothstep(0.0, 0.08, BP.s2);
    const inner = smoothstep(0.1, 0.3, BP.innerS);
    suture = Math.max(pair * Math.exp(-((gap / 0.035) ** 2)), inner * Math.exp(-((BP.inner / 0.025) ** 2)));
    const zone = Math.max(pair * Math.exp(-((gap / 0.07) ** 2)), inner * Math.exp(-((BP.inner / 0.05) ** 2)));
    const across = pair * Math.exp(-((gap / 0.07) ** 2)) >= inner * Math.exp(-((BP.inner / 0.05) ** 2)) ? gap : BP.inner;
    stripe = zone * Math.sin((across / 0.022) * Math.PI * 2);
  }
  // 老山的抬升放在丘陵里（不改造山带、不改地壳高度）
  const oldU = 0.22 * suture * ridged * contW;
  // 大格局：基准面、高原、洼地、岩性的倍数
  const t = tectonicsOf(m);
  const pxSize = (m.width + 2 * TECT_PAD) / t.W;
  sampleTectonics(t, (px + TECT_PAD) / pxSize - 0.5, (py + TECT_PAD) / pxSize - 0.5, TS);
  let swellR = 9;
  let swellH = 0;
  if (m.swells.length) {
    const wob = 1 + 0.25 * fbm(ns.plat, qx - 3.3, qy + 8.8, 6, 2);
    for (const s of m.swells) {
      const r = (Math.hypot(qx - s.x, qy - s.y) * wob) / s.r;
      if (r < swellR) {
        swellR = r;
        swellH = s.h;
      }
    }
  }
  RI.c = cs;
  RI.contW = contW;
  RI.widthMod = widthMod;
  // 大陆的低频噪声（隆起与盆地、陡崖分段、凹陷）在漂移前的位置上取；高原分段、裂谷分段跟着板块（漂移后）
  RI.nBase = fbm(ns.big, nqx, nqy, 2.2, 3);
  RI.nPlat = fbm(ns.plat, qx, qy, 3, 2);
  RI.nPlatW = fbm(ns.plat, qx + 5.3, qy - 2.1, 2, 2);
  RI.nEsc = fbm(ns.big, nqx - 7.7, nqy + 3.3, 3, 2);
  RI.nSag = fbm(ns.sag, nqx, nqy, 2.6, 3);
  RI.nRift = fbm(ns.sag, qx + 4.4, qy - 6.6, 3.5, 2);
  RI.swellR = swellR;
  RI.swellH = swellH;
  RI.riftAxis = riftAxis * contW;
  RI.shoulder = shoulder;
  RI.plates = true;
  RI.esc = esc;
  reliefAt(RI, RO);
  out.b0[i] = B;
  out.mountB[i] = mountB;
  out.mountU[i] = mountU0;
  out.hillU[i] = 0.12 * Math.max(0, fbm(ns.hills, nqx, nqy, 6, 4)) * contW + oldU;
  out.erod[i] = clamp((1 + 0.45 * fbm(ns.erod, x + 7.7, y - 3.1, 6, 3)) * RO.erodMul * (1 + 0.45 * stripe), 0.4, 1.8);
  out.sea[i] = oceanFloor(age, trench, 1700, 2600, fbm(ns.ocean, qx - 4.1, qy + 2.3, 3, 4), fbm(ns.ocean, qx + 6.2, qy - 8.4, 24, 3));
  out.T[i] = RO.T;
  out.Tp[i] = RO.Tp;
  out.pit[i] = RO.pit;
  out.rift[i] = RO.rift;
}
