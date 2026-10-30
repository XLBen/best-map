import { describe, expect, it } from 'vitest';
import { coastalStroke } from '../tools/hash';
import { clearCoastMemo, memoStats, setCoastMemo } from './coast-memo';
import { DELTA_DRAW, deltaBulge, deltaCells, deltaMouths } from './delta';
import type { Engine } from './engine';
import type { Mesh } from './mesh';
import { MAP_UNDER_SHORE, drawTypes, riverDraw } from './river-pack';
import { type RiverLine, type RiverRibbon, riverRibbon, riverWidth, traceRivers } from './rivers';
import { mulberry32 } from './rng';
import { coastValueAt, coastValues, shownCoastValues, vnoise } from './subcell';
import { COAST_AMP, coastNoiseField, coastSeed } from './terrain';
import { seededEngine } from './testing/fixtures';
import type { World } from './world';

// 第三十三轮（提速）：Worker 每改一笔重描整个世界的河（描河、分汊、打包），新加的缓存与快路与直白的写法逐值相同。
//   · 描河里按画面海岸场的几样查询（河口走到岸线、岸线的法向、圆与岸线的交点、一段线在不在陆地上）与三角洲分汊的几何
//     跨几次描河记下来（core/coast-memo.ts）：一组加工里每一步之后，开着与关着描出来的河逐值相同；
//     两个世界（当前与预览）交替描时也一样；开着时真的用上了记下的
//   · 带子（riverRibbon）拆成几个小函数、粗细倍数先算好、来回平滑共用一遍 exp：与以前的写法逐位相同
//   · 海岸值（coastValues）只重算陆地程度或陆海变了的格：与整张重算逐位相同（含就地改过的数组）
//   · 三角洲向海凸出（deltaBulge）改用按格的数组：与以前的 Map 写法逐位相同（含几个三角洲挨着时取抬得最多的）

// 河线的全部内容；-0 与 NaN 单独写出来
const ser = (lines: RiverLine[]) => JSON.stringify(lines, (_, v) => (typeof v === 'number' && (Object.is(v, -0) || Number.isNaN(v)) ? String(v) : v));

const bits = (a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

const settingsOf = {
  // 与 testing/fixtures 的 continents 同一种地图（有三角洲、有分汊）
  region: { cells: 12000, seed: 1, latNorth: 72, latSouth: 20 },
  planet: { seed: 4, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 },
} as const;

function world(kind: 'region' | 'planet', mesh?: Mesh): Engine {
  const eng = seededEngine(settingsOf[kind], mesh);
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4 }, reset: true });
  return eng;
}

const landCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] === 0);

// 一组加工：改气候（河多了、少了）、放湖、抬山、画陆地、轴倾角 / 纬度、门槛、撤销
function edits(eng: Engine): ((e: Engine) => void)[] {
  const w = eng.world;
  const land = landCells(w);
  const pick = (f: number) => land[Math.floor(land.length * f)];
  const near = (c: number, r: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * r);
  return [
    (e) => e.exec({ op: 'set_planet', patch: { humidity: 1.3 } }),
    (e) => e.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 400), value: 3, mode: 'add' }),
    (e) => e.exec({ op: 'add_lake', lake: { cell: pick(0.4), radius: 150, depth: 120, perennial: false } }),
    (e) => {
      const cells = near(pick(0.6), 4);
      e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.7 });
    },
    (e) => {
      const s = coastalStroke(e.world, 0.5, 4);
      e.exec({ op: 'paint_land', cells: s, t: s.map(() => 0), mode: 'sea' });
    },
    (e) => e.exec({ op: 'set_planet', patch: e.world.settings.globe ? { tilt: 30 } : { latShift: 4 } }),
    (e) => e.exec({ op: 'set_planet', patch: { riverThreshold: e.world.small.planet.riverThreshold * 0.6 } }),
    (e) => e.exec({ op: 'set_planet', patch: { humidity: 0.8 } }),
    (e) => e.undo(),
    (e) => e.undo(),
  ];
}

// 关着记下的查询描一遍（记下的留着，下一步照样用）
function plain(w: World): RiverLine[] {
  setCoastMemo(false);
  try {
    return traceRivers(w);
  } finally {
    setCoastMemo(true);
  }
}

// 与 Worker 一样：高程换一份副本再描（按数组认的海岸场缓存是空的）
const copyWorld = (w: World): World => ({ ...w, derived: { ...w.derived, elevation: w.derived.elevation.slice() } });

describe('描河：跨几次描河记下的查询与分汊与不记逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      clearCoastMemo();
      const eng = world(kind);
      // 预览世界：同一个网格上另一组改动，与当前的世界交替描
      const other = world(kind, eng.world.mesh);
      other.exec({ op: 'set_planet', patch: { humidity: 0.75 } });
      const h0 = memoStats().hits;
      let branches = 0;
      const check = (w: World) => {
        const got = traceRivers(copyWorld(w));
        branches += got.filter((l) => l.branch !== undefined).length;
        expect(ser(got)).toBe(ser(plain(copyWorld(w))));
      };
      check(eng.world);
      for (const step of edits(eng)) {
        step(eng);
        check(eng.world);
        check(other.world);
      }
      // 真的用上了记下的，也真的有分汊
      expect(memoStats().hits - h0).toBeGreaterThan(1000);
      expect(branches).toBeGreaterThan(0);
    });
  }
});

describe('地图上的河（带子）与以前的写法逐位相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = world(kind);
      eng.exec({ op: 'set_planet', patch: { humidity: 1.2 } });
      const w = eng.world;
      const thr = w.small.planet.riverThreshold;
      const sp = w.mesh.spacing;
      const lines = traceRivers(copyWorld(w));
      const rnd = mulberry32(3);
      let joined = 0;
      let weighted = 0;
      // 随点变的粗细倍数（河流类型的粗细）
      const typeMul = (k: number) => 1 + 0.5 * ((k * 7) % 3);
      for (const line of lines) {
        if (line.joins?.length) joined++;
        if (line.mul) weighted++;
        // 地图上的画法（河口多画进水里）、导出的画法（不多画）、再乘随点变的粗细
        const ways: [((k: number) => number) | undefined, { underShore?: number } | undefined][] = [
          [undefined, { underShore: MAP_UNDER_SHORE }],
          [undefined, undefined],
          [typeMul, { underShore: 0.5 + rnd() }],
        ];
        for (const [mulAt, opts] of ways) {
          const a = riverRibbon(line, thr, sp, mulAt, opts);
          const b = riverRibbonOld(line, thr, sp, mulAt, opts);
          for (const k of ['x', 'y', 's', 'nx', 'ny', 'hw', 'src'] as const) expect(bits(a[k])).toEqual(bits(b[k]));
          for (const k of ['x0', 'y0', 'x1', 'y1', 'maxHw'] as const) expect(Object.is(a[k], b[k])).toBe(true);
        }
      }
      // 带汇合处、粗细倍数的线都有
      expect(joined).toBeGreaterThan(0);
      expect(weighted).toBeGreaterThan(0);
      // riverDraw 照旧用它
      const d = riverDraw(lines[0], thr, sp, drawTypes(w), 1, MAP_UNDER_SHORE);
      expect(bits(d.rb.x)).toEqual(bits(riverRibbonOld(lines[0], thr, sp, () => 1, { underShore: MAP_UNDER_SHORE }).x));
    });
  }

  it('短线、湖口流出的线、带汇合处与粗细倍数的线', () => {
    const rnd = mulberry32(9);
    for (let n = 2; n < 12; n++) {
      const points: [number, number][] = [];
      for (let k = 0; k < n; k++) points.push([0.1 + k * 0.01 + rnd() * 0.004, 0.2 + rnd() * 0.01]);
      for (const head of ['source', 'lake', undefined] as const) {
        const line: RiverLine = { points, flow: points.map(() => 10 + rnd() * 50), mul: points.map(() => 0.5 + rnd()), joins: [rnd() * (n - 1)], mouth: rnd() < 0.5, ...(head ? { head } : {}) };
        const a = riverRibbon(line, 10, 0.01, undefined, { underShore: 0.3 });
        const b = riverRibbonOld(line, 10, 0.01, undefined, { underShore: 0.3 });
        for (const k of ['x', 'y', 's', 'nx', 'ny', 'hw', 'src'] as const) expect(bits(a[k])).toEqual(bits(b[k]));
      }
    }
  });
});

// 以前的写法：每格从头算
function coastValuesOld(world: World): Float32Array {
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const amp = COAST_AMP * world.small.terrain.coastRoughness;
  const s = new Float32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) s[i] = coastValueAt(causes.landness[i], coast[i], amp, causes.land[i] !== 0);
  return s;
}

describe('海岸值：只重算变了的格与整张重算逐位相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = world(kind);
      expect(bits(coastValues(eng.world))).toEqual(bits(coastValuesOld(eng.world)));
      for (const step of edits(eng)) {
        step(eng);
        expect(bits(coastValues(eng.world))).toEqual(bits(coastValuesOld(eng.world)));
      }
      // 数组就地改过（同一个对象）、海岸破碎度变了
      const w = eng.world;
      const landness = w.causes.landness.slice();
      const land = w.causes.land.slice();
      const ww: World = { ...w, causes: { ...w.causes, landness, land } };
      coastValues(ww);
      const rnd = mulberry32(5);
      for (let k = 0; k < 200; k++) {
        const i = Math.floor(rnd() * w.mesh.n);
        landness[i] = (rnd() - 0.5) * 400;
        land[i] = landness[i] > 0 ? 1 : 0;
      }
      landness[0] = -0;
      expect(bits(coastValues(ww))).toEqual(bits(coastValuesOld(ww)));
      const rough: World = { ...ww, small: { ...ww.small, terrain: { ...ww.small.terrain, coastRoughness: ww.small.terrain.coastRoughness * 1.5 } } };
      expect(bits(coastValues(rough))).toEqual(bits(coastValuesOld(rough)));
      expect(bits(coastValues(ww))).toEqual(bits(coastValuesOld(ww)));
    });
  }
});

describe('三角洲向海凸出：按格的数组与以前的 Map 写法逐位相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind).world;
      const KM2 = DELTA_DRAW.KM2;
      try {
        // 门槛放低：三角洲多、挨在一起（取抬得最多的那一份）
        for (const km2 of [KM2, KM2 / 4, KM2 / 20]) {
          DELTA_DRAW.KM2 = km2;
          const a = coastValues(w);
          const b = a.slice();
          deltaBulge(w, a);
          deltaBulgeOld(w, b);
          expect(bits(a)).toEqual(bits(b));
          if (km2 === KM2) expect(bits(shownCoastValues(w))).toEqual(bits(a));
          expect(deltaMouths(w).length).toBeGreaterThan(0);
        }
      } finally {
        DELTA_DRAW.KM2 = KM2;
      }
    });
  }
});

// ---------- 以前的写法（第三十三轮，1921b3c），原样照搬 ----------

const RIBBON_STEP = 1 / 16;
const TAPER_LEN = 1.25;
const TAPER_MIN = 0.15;
const FLARE_LEN = 0.6;
const FLARE = 0.3;
// 从湖里流出来的短河（不到 2 格；2–4 格之间渐渐不收）：从湖岸起收细，湖岸处约四成宽，到全长的七成是全宽。
// 不然一个小湖流出来一两格就入海、入别的湖的河画成一块平头的方块
const OUTLET_MIN = 0.4;
const OUTLET_SHORT = 2;
const OUTLET_FADE = 2;
const WIDTH_SMOOTH = 0.5;
const MEANDER_AMP = 0.08;
// 弯曲的噪声频率：格点相隔 1/4 格，约半格一个弯
const MEANDER_FREQ = 4;

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// line：河线；thr：河的门槛；spacing：格距；mulAt（可选）：每个河线点再乘的粗细（拖粗细、河流类型的粗细）
// opts.underShore（格，可选）：入海、入湖的河沿最后一段的方向再往水里多画这么长（河口的平头埋在水面下）。只给按陆地裁掉水面上那部分的画法用
// （地图的河那一层按画面上的陆地遮住：河口正好收在弯弯曲曲的岸线上，不是一个跨在岸线上的平头）
function riverRibbonOld(line: RiverLine, thr: number, spacing: number, mulAt?: (k: number) => number, opts?: { underShore?: number }): RiverRibbon {
  const under = line.mouth && opts?.underShore && line.points.length >= 2 ? opts.underShore * spacing : 0;
  if (under > 0) {
    const Q = line.points;
    const [ax, ay] = Q[Q.length - 2];
    const [bx, by] = Q[Q.length - 1];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const more: [number, number] = [bx + ((bx - ax) / l) * under, by + ((by - ay) / l) * under];
    const last = <T>(a: T[]) => [...a, a[a.length - 1]];
    line = { ...line, points: [...Q, more], flow: last(line.flow), ...(line.mul ? { mul: last(line.mul) } : {}), ...(line.type ? { type: last(line.type) } : {}), ...(line.cells ? { cells: last(line.cells) } : {}) };
  }
  const P = line.points;
  const m = P.length;
  // 1. 加密：每段等分到不长于 1/16 格
  const step = RIBBON_STEP * spacing;
  let count = 1;
  const parts = new Uint32Array(Math.max(0, m - 1));
  for (let k = 0; k + 1 < m; k++) {
    parts[k] = Math.max(1, Math.ceil(Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) / step));
    count += parts[k];
  }
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const w = new Float64Array(count);
  const mul = new Float64Array(count);
  const src = new Uint32Array(count);
  const mulOf = (k: number) => (line.mul ? line.mul[k] : 1) * (mulAt ? mulAt(k) : 1);
  let o = 0;
  const put = (k: number, t: number) => {
    const k1 = Math.min(m - 1, k + 1);
    x[o] = P[k][0] + (P[k1][0] - P[k][0]) * t;
    y[o] = P[k][1] + (P[k1][1] - P[k][1]) * t;
    w[o] = riverWidth(line.flow[k] + (line.flow[k1] - line.flow[k]) * t, thr);
    mul[o] = mulOf(k) + (mulOf(k1) - mulOf(k)) * t;
    src[o] = Math.min(k, Math.max(0, m - 2));
    o++;
  };
  put(0, 0);
  for (let k = 0; k + 1 < m; k++) for (let j = 1; j <= parts[k]; j++) put(k, j / parts[k]);
  // 2. 沿河的长度
  const s = new Float64Array(count);
  for (let i = 1; i < count; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const L = s[count - 1];
  // 岸线在哪里（往水里多画的那段之前）
  const Ls = L - under;
  // 3. 宽度：往下游只增不减，再沿河来回各平滑一遍（约半格；只增不减的数列平滑后仍只增不减）
  for (let i = 1; i < count; i++) if (w[i] < w[i - 1]) w[i] = w[i - 1];
  const lam = WIDTH_SMOOTH * spacing;
  for (let i = 1; i < count; i++) {
    const a = 1 - Math.exp(-(s[i] - s[i - 1]) / lam);
    w[i] = w[i - 1] + (w[i] - w[i - 1]) * a;
  }
  for (let i = count - 2; i >= 0; i--) {
    const a = 1 - Math.exp(-(s[i + 1] - s[i]) / lam);
    w[i] = w[i + 1] + (w[i] - w[i + 1]) * a;
  }
  // 4. 源头收尖、河口张开（从湖里流出来的短河从湖岸起收细），乘上粗细
  const outlet = line.head === 'lake' && L > 0 ? 1 - smooth01((L / spacing - OUTLET_SHORT) / OUTLET_FADE) : 0;
  const hw = new Float32Array(count);
  let maxHw = 0;
  for (let i = 0; i < count; i++) {
    let f = mul[i];
    if (line.head === 'source') f *= TAPER_MIN + (1 - TAPER_MIN) * smooth01(s[i] / (TAPER_LEN * spacing));
    if (outlet > 0) f *= 1 - outlet * (1 - OUTLET_MIN) * (1 - smooth01(s[i] / (0.7 * L)));
    if (line.mouth) f *= 1 + FLARE * smooth01((s[i] - (Ls - FLARE_LEN * spacing)) / (FLARE_LEN * spacing));
    hw[i] = (w[i] * f) / 2;
    if (hw[i] > maxHw) maxHw = hw[i];
  }
  // 5. 细小的弯曲：沿原来那条线的法向错开（按位置取噪声，结果确定）；两头半格之内渐渐不弯，水多（按流量的宽）的河弯得少，
  //    拖粗细不改中线
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  const normals = () => {
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(count - 1, i + 1);
      const tx = x[b] - x[a];
      const ty = y[b] - y[a];
      const l = Math.hypot(tx, ty) || 1;
      nx[i] = -ty / l;
      ny[i] = tx / l;
    }
  };
  normals();
  if (count > 2) {
    const q = MEANDER_FREQ / spacing;
    // 别的河汇进来的地方前后半格也渐渐不弯：支流的最后一点在原来那条线上，也就落在画出来的中线上（见 RiverLine.joins）
    let damp: Float64Array | null = null;
    if (line.joins?.length) {
      damp = new Float64Array(count).fill(1);
      const start = new Uint32Array(Math.max(1, m - 1));
      for (let k = 1; k + 1 < m; k++) start[k] = start[k - 1] + parts[k - 1];
      for (const pos of line.joins) {
        const k = Math.max(0, Math.min(m - 2, Math.floor(pos)));
        // 汇合点在加密后的第 i0、i0 + 1 点之间；前后各一步之内一点也不弯（这一小段就在原来的线上）
        const f = (pos - k) * parts[k];
        const i0 = Math.min(count - 1, start[k] + Math.floor(f));
        const i1 = Math.min(count - 1, i0 + 1);
        const sj = s[i0] + (s[i1] - s[i0]) * (f - Math.floor(f));
        const reach = 0.5 * spacing + step;
        const at = (i: number) => (damp![i] = Math.min(damp![i], smooth01((Math.abs(s[i] - sj) - step) / (0.5 * spacing))));
        for (let i = i0; i >= 0 && sj - s[i] < reach; i--) at(i);
        for (let i = i1; i < count && s[i] - sj < reach; i++) at(i);
      }
    }
    for (let i = 1; i < count - 1; i++) {
      const ends = smooth01(s[i] / (0.5 * spacing)) * smooth01((Ls - s[i]) / (0.5 * spacing)) * (damp ? damp[i] : 1);
      if (ends <= 0) continue;
      const amp = (MEANDER_AMP * spacing * ends) / (1 + 0.5 * Math.max(0, w[i] - 1));
      const off = amp * vnoise(x[i] * q + 5.3, y[i] * q - 7.9);
      x[i] += nx[i] * off;
      y[i] += ny[i] * off;
    }
    normals();
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    if (x[i] < x0) x0 = x[i];
    if (x[i] > x1) x1 = x[i];
    if (y[i] < y0) y0 = y[i];
    if (y[i] > y1) y1 = y[i];
  }
  return { x, y, s, nx, ny, hw, src, x0, y0, x1, y1, maxHw };
}

function deltaBulgeOld(world: World, s: Float32Array): void {
  const mouths = deltaMouths(world);
  if (!mouths.length) return;
  const { mesh, causes } = world;
  const land = causes.land;
  const { off, adj, dist } = mesh;
  const sp = mesh.spacing;
  const R = DELTA_DRAW.BULGE_R * sp;
  const raise = new Map<number, number>();
  for (const m of mouths) {
    // 河口附近的海格：从河口那格沿海格走（按边长），R 以内
    const seen = new Map<number, number>([[m, 0]]);
    const queue = [m];
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      const dc = seen.get(c)!;
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (land[j]) continue;
        const dj = dc + dist[e];
        if (dj > R) continue;
        const old = seen.get(j);
        if (old !== undefined && old <= dj) continue;
        seen.set(j, dj);
        queue.push(j);
      }
    }
    for (const [j, dj] of seen) {
      if (j === m) continue;
      const w = 1 - smooth((dj / sp - DELTA_DRAW.BULGE_FULL) / (DELTA_DRAW.BULGE_R - DELTA_DRAW.BULGE_FULL));
      if (w <= 0) continue;
      const v = bulgeValue(mesh, land, s, j, Math.min(DELTA_DRAW.BULGE_SHIFT, deltaCells(world, m)) * w);
      if (v > (raise.get(j) ?? -Infinity)) raise.set(j, v);
    }
  }
  for (const [j, v] of raise) if (v > s[j]) s[j] = v;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 海格 j 的海岸值最多抬到多少：每个陆上的邻格 a 到它的边上，岸线（两格的值线性内插为 0 处）往海里最多挪 shift 格（边上的比例不过 0.95）。
// 没有陆上的邻格时不抬（返回原值）
function bulgeValue(mesh: World['mesh'], land: Uint8Array, s: Float32Array, j: number, shift: number): number {
  const sj = s[j];
  let best = Infinity;
  for (let e = mesh.off[j]; e < mesh.off[j + 1]; e++) {
    const a = mesh.adj[e];
    if (!land[a]) continue;
    const sa = s[a];
    if (!(sa > 0) || !(sj < 0)) continue;
    const t0 = sa / (sa - sj);
    // 挪 shift 格：按这条边的长短折成边上的比例
    const t1 = Math.min(0.95, t0 + (shift * mesh.spacing) / mesh.dist[e]);
    best = Math.min(best, sa * (1 - 1 / t1));
  }
  if (!Number.isFinite(best)) return sj;
  return Math.min(-1, Math.max(sj, best));
}
