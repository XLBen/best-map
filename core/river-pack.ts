import type { RiverType } from './river-types';
import { type RiverLine, type RiverRibbon, guidesSignature, riverRibbon, traceRivers } from './rivers';
import { coastSeed } from './terrain';
import type { World } from './world';

// ---------- 地图上的河在计算 Worker 里描好（第十三轮） ----------
// 河线（traceRivers）与画出来的带子（riverRibbon）以前在主线程上算：大星球改一笔要描一百多毫秒，地图卡一下。
// 现在 Worker 算完一步就描好，打包成几块连续的数组随快照（预览世界随预览的回复）转交过去，主线程拆开直接用。
// 主线程拆开的与在主线程上算的逐位相同（同一套代码、同样的输入）

// 一条要画的河：带子，与每个河线点是哪一种河（0 普通，k + 1 是第 k 种河流类型；没有河流类型时省略）
export interface RiverDraw {
  rb: RiverRibbon;
  type?: Uint8Array;
}

// 一条河线 → 要画的河。scale：再乘的粗细（拖“粗细”时）；types：河流类型（带类型的点再乘类型的粗细）；
// underShore：河口往水里多画多长（格）。只给合成时按陆地裁掉水面那部分的地图上的河用，河口正好停在画出来的岸线上
export function riverDraw(line: RiverLine, thr: number, spacing: number, types: readonly RiverType[] | null, scale = 1, underShore = 0): RiverDraw {
  const tags = types && line.type ? line.type : null;
  const typeMul = (k: number) => {
    const t = tags ? tags[k] : 0;
    return scale * (t > 0 ? (types![t - 1]?.width ?? 1) : 1);
  };
  const rb = riverRibbon(line, thr, spacing, typeMul, underShore ? { underShore } : undefined);
  if (!tags || !tags.some((t) => t > 0 && types![t - 1])) return { rb };
  return { rb, type: Uint8Array.from(tags) };
}

// 地图上的河画的时候用的河流类型（世界里有河流类型、推导里有每格的类型时才分开画）
export const drawTypes = (world: World): readonly RiverType[] | null => (world.small.riverTypes?.length && world.derived.riverType ? world.small.riverTypes : null);

// 地图上的河的带子：河口多画 0.3 格进水里（合成时按陆地裁掉，见 src/render/overlay.ts 的 buildPaths）
export const MAP_UNDER_SHORE = 0.3;

// 河流类型里影响带子的（粗细；没有河流类型时为 ''）：拆开的带子只在这一项、门槛、格距都一样时才用
export const drawTypesKey = (types: readonly RiverType[] | null) => (types ? types.map((t) => `${t.id}:${t.width ?? 1}`).join('|') : '');

// 打包好的河：每条线的几项（meta，每条 META 个整数）与所有线的点首尾相接的几块数组。带子（rb）也打包好时一并带上
export interface PackedRivers {
  meta: Int32Array;
  pts: Float64Array;
  flow: Float64Array;
  cells: Int32Array;
  mul: Float64Array;
  type: Int32Array;
  joins: Float64Array;
  // 画的河的河道 id（按出现的先后，meta 里记下标）
  guides: string[];
  rb?: PackedRibbons;
}

export interface PackedRibbons {
  // 门槛、格距、河流类型（drawTypesKey）：主线程按同样的三项画时才用
  thr: number;
  spacing: number;
  types: string;
  // 每条带子的点数
  count: Int32Array;
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
  nx: Float32Array;
  ny: Float32Array;
  hw: Float32Array;
  src: Uint32Array;
  // 每条 5 个：外接框与最宽处的半宽
  box: Float64Array;
  // 带类型的线：每个河线点的类型（与 pts 对齐；没有类型的线那几位是 0，meta 里另有标记）
  tag: Uint8Array;
}

// meta：点数、标记（见下）、汇入哪一条（−1 没有）、画的河道（guides 的下标，−1 自然的河）、别的河汇进来几处
const META = 5;
const HAS_CELLS = 1;
const HAS_MUL = 2;
const HAS_TYPE = 4;
const SOURCE = 8;
const LAKE = 16;
const MOUTH = 32;
const DRAW_TYPE = 64;

export function packRivers(lines: readonly RiverLine[], draws?: readonly RiverDraw[], drawKey?: { thr: number; spacing: number; types: string }): PackedRivers {
  let np = 0;
  let nj = 0;
  for (const l of lines) {
    np += l.points.length;
    nj += l.joins?.length ?? 0;
  }
  const meta = new Int32Array(lines.length * META);
  const pts = new Float64Array(np * 2);
  const flow = new Float64Array(np);
  const cells = new Int32Array(np);
  const mul = new Float64Array(np);
  const type = new Int32Array(np);
  const joins = new Float64Array(nj);
  const guides: string[] = [];
  const gi = new Map<string, number>();
  let o = 0;
  let oj = 0;
  lines.forEach((l, i) => {
    const m = l.points.length;
    let flags = 0;
    if (l.cells) flags |= HAS_CELLS;
    if (l.mul) flags |= HAS_MUL;
    if (l.type) flags |= HAS_TYPE;
    if (l.head === 'source') flags |= SOURCE;
    if (l.head === 'lake') flags |= LAKE;
    if (l.mouth) flags |= MOUTH;
    if (draws?.[i].type) flags |= DRAW_TYPE;
    let g = -1;
    if (l.guide !== undefined) {
      g = gi.get(l.guide) ?? -1;
      if (g < 0) {
        g = guides.length;
        gi.set(l.guide, g);
        guides.push(l.guide);
      }
    }
    meta.set([m, flags, l.into ?? -1, g, l.joins?.length ?? 0], i * META);
    for (let k = 0; k < m; k++) {
      pts[2 * (o + k)] = l.points[k][0];
      pts[2 * (o + k) + 1] = l.points[k][1];
      flow[o + k] = l.flow[k];
      if (l.cells) cells[o + k] = l.cells[k];
      if (l.mul) mul[o + k] = l.mul[k];
      if (l.type) type[o + k] = l.type[k];
    }
    for (const pos of l.joins ?? []) joins[oj++] = pos;
    o += m;
  });
  const out: PackedRivers = { meta, pts, flow, cells, mul, type, joins, guides };
  if (draws && drawKey) out.rb = packRibbons(draws, drawKey);
  return out;
}

function packRibbons(draws: readonly RiverDraw[], key: { thr: number; spacing: number; types: string }): PackedRibbons {
  let n = 0;
  let nt = 0;
  for (const d of draws) {
    n += d.rb.x.length;
    nt += d.type?.length ?? 0;
  }
  const out: PackedRibbons = {
    ...key,
    count: new Int32Array(draws.length),
    x: new Float64Array(n),
    y: new Float64Array(n),
    s: new Float64Array(n),
    nx: new Float32Array(n),
    ny: new Float32Array(n),
    hw: new Float32Array(n),
    src: new Uint32Array(n),
    box: new Float64Array(draws.length * 5),
    tag: new Uint8Array(nt),
  };
  let o = 0;
  let ot = 0;
  draws.forEach((d, i) => {
    const rb = d.rb;
    out.count[i] = rb.x.length;
    out.x.set(rb.x, o);
    out.y.set(rb.y, o);
    out.s.set(rb.s, o);
    out.nx.set(rb.nx, o);
    out.ny.set(rb.ny, o);
    out.hw.set(rb.hw, o);
    out.src.set(rb.src, o);
    out.box.set([rb.x0, rb.y0, rb.x1, rb.y1, rb.maxHw], i * 5);
    o += rb.x.length;
    if (d.type) {
      out.tag.set(d.type, ot);
      ot += d.type.length;
    }
  });
  return out;
}

// 转交时要交出去的数组
export function riverBuffers(p: PackedRivers): ArrayBuffer[] {
  const list: ArrayBufferView[] = [p.meta, p.pts, p.flow, p.cells, p.mul, p.type, p.joins];
  if (p.rb) list.push(p.rb.count, p.rb.x, p.rb.y, p.rb.s, p.rb.nx, p.rb.ny, p.rb.hw, p.rb.src, p.rb.box, p.rb.tag);
  return list.map((a) => a.buffer as ArrayBuffer);
}

// 拆开：河线（与打包前逐位相同）与带子（各条的数组是那几块数组上的视图，不复制）
export function unpackRivers(p: PackedRivers): { lines: RiverLine[]; draws: RiverDraw[] | null } {
  const lines: RiverLine[] = [];
  const n = p.meta.length / META;
  let o = 0;
  let oj = 0;
  for (let i = 0; i < n; i++) {
    const [m, flags, into, g, nj] = p.meta.subarray(i * META, i * META + META);
    const points: [number, number][] = new Array(m);
    const flow: number[] = new Array(m);
    for (let k = 0; k < m; k++) {
      points[k] = [p.pts[2 * (o + k)], p.pts[2 * (o + k) + 1]];
      flow[k] = p.flow[o + k];
    }
    const line: RiverLine = { points, flow };
    if (flags & HAS_CELLS) line.cells = Array.from(p.cells.subarray(o, o + m));
    if (flags & HAS_MUL) line.mul = Array.from(p.mul.subarray(o, o + m));
    if (g >= 0) line.guide = p.guides[g];
    if (flags & HAS_TYPE) line.type = Array.from(p.type.subarray(o, o + m));
    if (flags & SOURCE) line.head = 'source';
    if (flags & LAKE) line.head = 'lake';
    if (flags & MOUTH) line.mouth = true;
    if (into >= 0) line.into = into;
    if (nj > 0) line.joins = Array.from(p.joins.subarray(oj, oj + nj));
    lines.push(line);
    o += m;
    oj += nj;
  }
  if (!p.rb) return { lines, draws: null };
  const r = p.rb;
  const draws: RiverDraw[] = [];
  let q = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) {
    const c = r.count[i];
    const b = r.box.subarray(i * 5, i * 5 + 5);
    const rb: RiverRibbon = {
      x: r.x.subarray(q, q + c),
      y: r.y.subarray(q, q + c),
      s: r.s.subarray(q, q + c),
      nx: r.nx.subarray(q, q + c),
      ny: r.ny.subarray(q, q + c),
      hw: r.hw.subarray(q, q + c),
      src: r.src.subarray(q, q + c),
      x0: b[0],
      y0: b[1],
      x1: b[2],
      y1: b[3],
      maxHw: b[4],
    };
    q += c;
    const d: RiverDraw = { rb };
    if (p.meta[i * META + 1] & DRAW_TYPE) {
      const m = p.meta[i * META];
      d.type = r.tag.subarray(qt, qt + m);
      qt += m;
    }
    draws.push(d);
  }
  return { lines, draws };
}

// Worker 里：描这个世界的河并打包（带子按地图上的画法：河口多画 0.3 格进水里、按河流类型的粗细）。
// 高程数组换一份副本再描：Worker 里推导数组会就地改写，按数组认的海岸场缓存可能是旧的。
// 描河读的东西（与 src/render/overlay.ts 的 riverLinesKey 同样几项，按内容）都没变时（比如只涂了生态）用上一次描好的（复制一份，转交的会被拿走）
let last: { key: string; packed: PackedRivers } | null = null;
export function worldRivers(world: World): PackedRivers {
  const thr = world.small.planet.riverThreshold;
  const spacing = world.mesh.spacing;
  const types = drawTypes(world);
  const key = riversKey(world, drawTypesKey(types));
  if (last?.key !== key) {
    const w: World = { ...world, derived: { ...world.derived, elevation: world.derived.elevation.slice() } };
    const lines = traceRivers(w);
    const draws = lines.map((l) => riverDraw(l, thr, spacing, types, 1, MAP_UNDER_SHORE));
    last = { key, packed: packRivers(lines, draws, { thr, spacing, types: drawTypesKey(types) }) };
  }
  return copyPacked(last.packed);
}

function copyPacked(p: PackedRivers): PackedRivers {
  const out: PackedRivers = { meta: p.meta.slice(), pts: p.pts.slice(), flow: p.flow.slice(), cells: p.cells.slice(), mul: p.mul.slice(), type: p.type.slice(), joins: p.joins.slice(), guides: p.guides.slice() };
  if (p.rb) {
    const r = p.rb;
    out.rb = { thr: r.thr, spacing: r.spacing, types: r.types, count: r.count.slice(), x: r.x.slice(), y: r.y.slice(), s: r.s.slice(), nx: r.nx.slice(), ny: r.ny.slice(), hw: r.hw.slice(), src: r.src.slice(), box: r.box.slice(), tag: r.tag.slice() };
  }
  return out;
}

// 描河读的东西的内容摘要：几样推导数组、陆海与陆地程度（按字节），门槛、河道的内容、海岸破碎度与种子、河流类型的粗细
function riversKey(world: World, types: string): string {
  const { derived: d, causes, small, mesh } = world;
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x5bd1e995) ^ (b >>> 15);
  };
  const arr = (x: ArrayBufferView | undefined) => {
    if (!x) return mix(-1);
    mix(x.byteLength);
    const n4 = x.byteLength >> 2;
    const w = new Int32Array(x.buffer, x.byteOffset, n4);
    for (let i = 0; i < n4; i++) mix(w[i]);
    const u = new Uint8Array(x.buffer, x.byteOffset + n4 * 4, x.byteLength - n4 * 4);
    for (let i = 0; i < u.length; i++) mix(u[i]);
  };
  for (const x of [d.discharge, d.receiver, d.lake, d.elevation, d.water, d.riverType, causes.land, causes.landness]) arr(x);
  return [world.settings.seed, mesh.n, mesh.spacing, small.planet.riverThreshold, guidesSignature(small.guides), small.terrain.coastRoughness, coastSeed(world), types, a >>> 0, b >>> 0].join('|');
}
