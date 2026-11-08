// 星球每格的取样与星球形态的地形脚本（第八十三轮从 core/planet-gen.ts 原样搬出）
import { emptyBaseComponents, type Reroll, type BaseComponents, type Resample, copyComponents } from './generate';
import { type V3, type PlanetModel, LAYOUT_R, noiseSet3, DEG, type NoiseSet3 } from './planet-gen-model';
import { toUnit } from './sphere';
import { sampleInto, sampleRaw, S, mountBOf } from './planet-gen-sample';
import { smoothstep, clamp, mixSeed } from './rng';
import type { SphereMesh } from './mesh';
import { type ScriptIssue, arrayInputs, runScript } from './script';

export const emptyComponents = emptyBaseComponents;

type PlacedReroll = Reroll & { u: V3 };
export const placed = (rerolls: Reroll[]): PlacedReroll[] => rerolls.map((r) => ({ ...r, u: toUnit(r.x, r.y) }));

// 单位球上的点到重画圈中心的距离（地图单位，即弧长 / π）
export function rerollDist(r: PlacedReroll, px: number, py: number, pz: number): number {
  const cx = py * r.u[2] - pz * r.u[1];
  const cy = pz * r.u[0] - px * r.u[2];
  const cz = px * r.u[1] - py * r.u[0];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), px * r.u[0] + py * r.u[1] + pz * r.u[2]) / Math.PI;
}

// 一格：原来的噪声，再按顺序叠上覆盖它的各次重画
export function sampleCell(m: PlanetModel, rerolls: PlacedReroll[], px: number, py: number, pz: number, out: BaseComponents, i: number, tmp: BaseComponents) {
  sampleInto(m, m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, out, i);
  out.seaB0[i] = out.b0[i];
  // 重画这一片：球面上的圆（半径是地图单位，即弧长 / π）里换一套噪声，边缘羽化
  for (const r of rerolls) {
    const d = rerollDist(r, px, py, pz);
    if (d >= r.radius) continue;
    let ns = m.variants.get(r.variant);
    if (!ns) {
      ns = noiseSet3(m.params.seed, r.variant);
      m.variants.set(r.variant, ns);
    }
    sampleInto(m, ns, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, tmp, 0);
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

// ---------- 星球形态的地形脚本 ----------

// 每格在单位球面上的位置与经纬度（地形脚本的 px、py、pz、lat、lon），按网格缓存
type CellPositions = Record<'px' | 'py' | 'pz' | 'lat' | 'lon', Float64Array>;
const positionCache = new WeakMap<SphereMesh, CellPositions>();
function cellPositions(mesh: SphereMesh): CellPositions {
  let pos = positionCache.get(mesh);
  if (!pos) {
    const n = mesh.n;
    pos = { px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n), lat: new Float64Array(n), lon: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const x = mesh.p[3 * i];
      const y = mesh.p[3 * i + 1];
      const z = mesh.p[3 * i + 2];
      pos.px[i] = x;
      pos.py[i] = y;
      pos.pz[i] = z;
      pos.lat[i] = Math.asin(clamp(z, -1, 1)) / DEG;
      pos.lon[i] = Math.atan2(y, x) / DEG;
    }
    positionCache.set(mesh, pos);
  }
  return pos;
}

// 一遍（原来的噪声，或某次重画的噪声）算出的双精度分量，按格编号存
interface RawPass {
  B: Float64Array;
  mountB: Float64Array;
  mountU: Float64Array;
  hillU: Float64Array;
  erod: Float64Array;
  c: Float64Array;
  sea: Float64Array;
  T: Float64Array;
  Tp: Float64Array;
  pit: Float64Array;
  rift: Float64Array;
}

// 界面看的问题最多留几条（同一句话只留一条）
const MAX_ISSUES = 8;
function addIssue(issues: ScriptIssue[], issue: ScriptIssue) {
  if (issues.length < MAX_ISSUES && !issues.some((x) => x.message === issue.message)) issues.push(issue);
}

// 地形脚本每一遍的结果：pass[0] 是原来的噪声那一遍，pass[k + 1] 是 rerolls[k] 那一遍；null 为正常，否则是这一遍出的问题。
// 一遍的结果只取决于模型（种子、类型、形态）与这一遍自己的重画，与别的重画无关：局部重算时没变的那几遍照用
interface CrustPasses {
  rerolls: Reroll[];
  pass: (ScriptIssue | null)[];
}
const crustPasses = new WeakMap<BaseComponents, CrustPasses>();

// 一批格用某一套噪声算出的原值，写进 raw（按格编号）。plates 见 sampleRaw
function sampleCells(m: PlanetModel, ns: NoiseSet3, mesh: SphereMesh, cells: Int32Array, raw: RawPass, plates: boolean) {
  const p = mesh.p;
  for (let j = 0; j < cells.length; j++) {
    const i = cells[j];
    sampleRaw(m, ns, p[3 * i] * LAYOUT_R, p[3 * i + 1] * LAYOUT_R, p[3 * i + 2] * LAYOUT_R, S, plates);
    raw.B[i] = S.B;
    raw.mountB[i] = S.mountB;
    raw.mountU[i] = S.mountU;
    raw.hillU[i] = S.hillU;
    raw.erod[i] = S.erod;
    raw.c[i] = S.c;
    raw.sea[i] = S.sea;
    raw.T[i] = S.T;
    raw.Tp[i] = S.Tp;
    raw.pit[i] = S.pit;
    raw.rift[i] = S.rift;
  }
}

// 用某一套噪声（variant 0 是原来的，其余是重画）算一批格，再整批交给地形脚本，结果写回 raw（按格编号）。
// 脚本在任何一格出错（运行时出错、NaN、返回值不对），这一遍整遍按没有脚本算（raw 里是没有脚本时的原值：
// crustMode 'replace' 时板块边界也照算），返回出的问题。
// known：局部重算时这一遍上一次的结果（undefined 为新的一遍）。上一次出了错的不再运行，直接按没有脚本算；
// 上一次正常、这次却出错（脚本不纯）时返回 'redo'，由调用方从头算
function crustPass(m: PlanetModel, ns: NoiseSet3, variant: number, mesh: SphereMesh, cells: Int32Array, raw: RawPass, src: string, known: ScriptIssue | null | undefined): ScriptIssue | null | 'redo' {
  if (known) {
    sampleCells(m, ns, mesh, cells, raw, true);
    return known;
  }
  sampleCells(m, ns, mesh, cells, raw, !m.replace);
  const form = m.params.form!;
  const pos = cellPositions(mesh);
  const inputs = arrayInputs(
    mesh.n,
    { height: raw.B, mountains: raw.mountU, hills: raw.hillU, rock: raw.erod, continent: raw.c, lat: pos.lat, lon: pos.lon, px: pos.px, py: pos.py, pz: pos.pz, seed: m.params.seed, globe: true },
    { globe: true },
  );
  // 重画一片换一套噪声，脚本的 rand()、fbmAt() 也跟着换（种子里加上 variant）
  const seed = variant ? mixSeed(m.params.seed, variant, 0x3d) : m.params.seed;
  const r = runScript({ kind: 'crust', src }, { owner: form.name, id: form.id, seedKey: form.seedKey, seed, inputs, cells });
  if (!r.ok) {
    if (known === null) return 'redo';
    if (m.replace) sampleCells(m, ns, mesh, cells, raw, true);
    return r.issue;
  }
  const res = r.output;
  for (let j = 0; j < cells.length; j++) {
    const i = cells[j];
    raw.B[i] = res.height[j];
    raw.mountU[i] = res.mountains[j];
    raw.hillU[i] = res.hills[j];
    raw.erod[i] = res.rock[j];
    // 山的强弱没改时，与原来的值逐位相同
    raw.mountB[i] = mountBOf(res.mountains[j], raw.c[i]);
  }
  return null;
}

// 有地形脚本时的采样：与 samplePlanetComponents 的逐格写法同样的结果（脚本按没有处理时逐位相同），
// 只是先把一遍的格都算出来，整批交给脚本，再按原来的顺序叠上各次重画。重画的那一遍不叠岩性（与没有脚本时相同）。
//
// “一遍”是：原来的噪声对整个星球的每一格；每次重画的噪声对它圈里的每一格。出错按整遍算，所以结果只取决于
// 世界参数本身。重画一片时局部重算：只算变了的那些圈里的格；新的重画那一遍的格全在里面，整遍都算；
// 没变的那几遍（原来的噪声那一遍、共同前缀里的重画）照用上一次的结果——出过错的仍按没有脚本算，正常的
// 只对这些格运行（脚本对每格单独地算，局部算的与从头算的逐值相同）。所以撤销、重做、重放、检查点恢复的结果都一致
export function sampleWithCrust(m: PlanetModel, mesh: SphereMesh, src: string, re?: Resample): BaseComponents {
  const prev = re ? crustPasses.get(re.from) : undefined;
  if (re && !prev) return sampleWithCrust(m, mesh, src);
  const n = mesh.n;
  const p = mesh.p;
  const out = re ? copyComponents(re.from) : emptyComponents(n);
  const rerolls = placed(m.params.rerolls);
  // 上一次的前几次重画与这次的相同：那几遍的结果照用
  let keep = 0;
  if (prev) while (keep < prev.rerolls.length && keep < rerolls.length && sameReroll(prev.rerolls[keep], rerolls[keep])) keep++;
  const changed = re ? placed(re.changed) : [];
  const todo: number[] = [];
  for (let i = 0; i < n; i++) {
    // 与 samplePlanetComponents 同一个“在圈内”的判断
    if (re && changed.every((r) => rerollDist(r, p[3 * i], p[3 * i + 1], p[3 * i + 2]) >= r.radius)) continue;
    todo.push(i);
  }
  const cells = Int32Array.from(todo);
  const raw: RawPass = {
    B: new Float64Array(n),
    mountB: new Float64Array(n),
    mountU: new Float64Array(n),
    hillU: new Float64Array(n),
    erod: new Float64Array(n),
    c: new Float64Array(n),
    sea: new Float64Array(n),
    T: new Float64Array(n),
    Tp: new Float64Array(n),
    pit: new Float64Array(n),
    rift: new Float64Array(n),
  };
  const pass: (ScriptIssue | null)[] = [];
  const first = crustPass(m, m.noise, 0, mesh, cells, raw, src, prev?.pass[0]);
  if (first === 'redo') return sampleWithCrust(m, mesh, src);
  pass.push(first);
  for (const i of todo) {
    out.b0[i] = raw.B[i];
    out.mountB[i] = raw.mountB[i];
    out.mountU[i] = raw.mountU[i];
    out.hillU[i] = raw.hillU[i];
    out.erod[i] = raw.erod[i];
    out.sea[i] = raw.sea[i];
    out.T[i] = raw.T[i];
    out.Tp[i] = raw.Tp[i];
    out.pit[i] = raw.pit[i];
    out.rift[i] = raw.rift[i];
    out.seaB0[i] = out.b0[i];
  }
  // 重画这一片：一次一次地叠（每格叠的顺序与逐格写法相同），圈边羽化
  for (let k = 0; k < rerolls.length; k++) {
    const r = rerolls[k];
    const known = k < keep ? prev!.pass[k + 1] : undefined;
    const inside: number[] = [];
    const dist: number[] = [];
    for (const i of todo) {
      const d = rerollDist(r, p[3 * i], p[3 * i + 1], p[3 * i + 2]);
      if (d >= r.radius) continue;
      inside.push(i);
      dist.push(d);
    }
    if (!inside.length) {
      // 新的重画圈里一格也没有：从头算也是什么都不做
      pass.push(known ?? null);
      continue;
    }
    let ns = m.variants.get(r.variant);
    if (!ns) {
      ns = noiseSet3(m.params.seed, r.variant);
      m.variants.set(r.variant, ns);
    }
    const got = crustPass(m, ns, r.variant, mesh, Int32Array.from(inside), raw, src, known);
    if (got === 'redo') return sampleWithCrust(m, mesh, src);
    pass.push(got);
    for (let j = 0; j < inside.length; j++) {
      const i = inside[j];
      const w = 1 - smoothstep(0.6, 1, dist[j] / r.radius);
      // 逐格写法里重画的值先存进 Float32 的临时数组：这里同样先取整到单精度
      out.b0[i] += (Math.fround(raw.B[i]) - out.b0[i]) * w;
      out.mountB[i] += (Math.fround(raw.mountB[i]) - out.mountB[i]) * w;
      out.mountU[i] += (Math.fround(raw.mountU[i]) - out.mountU[i]) * w;
      out.hillU[i] += (Math.fround(raw.hillU[i]) - out.hillU[i]) * w;
      out.sea[i] += (Math.fround(raw.sea[i]) - out.sea[i]) * w;
      out.T[i] += (Math.fround(raw.T[i]) - out.T[i]) * w;
      out.Tp[i] += (Math.fround(raw.Tp[i]) - out.Tp[i]) * w;
      out.pit[i] += (Math.fround(raw.pit[i]) - out.pit[i]) * w;
      out.rift[i] += (Math.fround(raw.rift[i]) - out.rift[i]) * w;
    }
  }
  // 给界面看的问题：按遍的顺序，同一句话只留一条
  const issues: ScriptIssue[] = [];
  for (const x of pass) if (x) addIssue(issues, x);
  out.issues = issues;
  crustPasses.set(out, { rerolls: m.params.rerolls.map((r) => ({ ...r })), pass });
  return out;
}

// 同一次重画：逐字段比（与 terrain.ts 里的相同）
const sameReroll = (a: Reroll, b: Reroll) => Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.radius, b.radius) && Object.is(a.variant, b.variant);
