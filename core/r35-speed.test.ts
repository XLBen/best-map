import { describe, expect, it } from 'vitest';
import { coastalStroke } from '../tools/hash';
import { deflectWind } from './climate';
import { seafloor, seafloorSameLand, seafloorStats } from './elevation';
import type { Engine } from './engine';
import { humanCellMemo } from './human/cell-memo';
import { cellInputs } from './human/rules';
import { provinceLand } from './island-types';
import { fillUnassigned, provinceSizes, repairProvinces } from './provinces';
import { type Mesh, type SphereMesh, graphDistance, graphDistanceAvoid, graphDistanceSame, ringDistance } from './mesh';
import { landFractionSphere } from './planet-climate';
import { mulberry32, smoothstep } from './rng';
import { buildFlowSphere, sphereAux } from './sphere-flow';
import { seededEngine } from './testing/fixtures';
import { HUMAN_DERIVED, type World, worldLatitude } from './world';

// 第三十五轮（提速）：新加的缓存、快路与以前的写法逐值相同。
//   · 人文的几层按格记下（human/cell-memo.ts）：自动的地形类别、资源与宜居度只重算输入变了的格——开着与关着逐值相同
//     （一组加工：改气候、冷暖笔、放湖、抬山、画河、画陆地、纬度 / 轴倾角、画地形类别、画资源、改资源的规则、撤销、重做），
//     开着时真的只重算了一部分格
//   · 海底：陆海不变时（海岸上堆山）照用离岸距离、只重算属性变了的岸边格管着的格——与整个重算逐值相同，真的走了这条路
//   · 两种常用代价的 Dijkstra（graphDistanceSame、graphDistanceAvoid）与传闭包的 graphDistance 逐值相同
//   · 星球的陆地占比（landFractionSphere）列号查表、权重先算：与以前的写法逐位相同
//   · 球面的输运图（buildFlowSphere）拆成小函数、山挡风（deflectWind）拆成小函数：与以前的写法逐位相同
//   · 人文的输入里纬度按网格记下：与逐格现算的相同
//   · 省份的格数（provinceSizes）先按编号数、修补省份（repairProvinces）先查每个编号的陆海：与逐格放进 Map、逐格查的写法逐值相同
// 别的拆成小函数的几处（地区与星球的气候、洋流、高程求解的开头、海底、地物的连通块与海）是原样照搬，由金标准
// （golden、golden-full、r31-digests、solver-identity、seabed 等）逐值把关，一个都没有重录

// 逐位比两个数组：不同的个数
function diffBits(a: ArrayBufferView, b: ArrayBufferView): number {
  if (a.byteLength !== b.byteLength) return Number.POSITIVE_INFINITY;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  let d = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d++;
  return d;
}
const sameBits = (a: ArrayBufferView, b: ArrayBufferView) => diffBits(a, b) === 0;

const settingsOf = {
  region: { seed: 4, cells: 6000 },
  planet: { seed: 4, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 },
} as const;

function world(kind: 'region' | 'planet', mesh?: Mesh): Engine {
  const eng = seededEngine(settingsOf[kind], mesh);
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
  return eng;
}

const dryCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] === 0);

// 从一格起顺着邻格往东走（不回头、只走陆地）
function walk(w: World, src: number, len: number): number[] {
  const path = [src];
  const seen = new Set(path);
  for (let k = 0; k < len; k++) {
    const c = path[path.length - 1];
    let best = -1;
    for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
      const j = w.mesh.adj[e];
      if (!seen.has(j) && w.causes.land[j] && (best < 0 || w.mesh.x[j] > w.mesh.x[best])) best = j;
    }
    if (best < 0) break;
    path.push(best);
    seen.add(best);
  }
  return path;
}

// 一组加工（两个引擎各做一遍，命令按各自的世界挑格，两边的世界一直相同，挑出来的也相同）
function edits(): ((e: Engine) => void)[] {
  const land = (e: Engine) => dryCells(e.world);
  const pick = (e: Engine, f: number) => {
    const l = land(e);
    return l[Math.floor(l.length * f)];
  };
  const near = (e: Engine, c: number, r: number) => {
    const m = e.world.mesh;
    return [...Array(m.n).keys()].filter((i) => Math.hypot(m.x[i] - m.x[c], m.y[i] - m.y[c]) < m.spacing * r);
  };
  return [
    (e) => e.exec({ op: 'set_planet', patch: { humidity: 0.7 } }),
    (e) => e.exec({ op: 'paint', field: 'tempOffset', cells: land(e).slice(0, 300), value: 3, mode: 'add' }),
    (e) => e.exec({ op: 'add_lake', lake: { cell: pick(e, 0.4), radius: 150, depth: 120, perennial: false } }),
    (e) => {
      const cells = near(e, pick(e, 0.6), 4);
      e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.7 });
    },
    (e) => e.exec({ op: 'add_guide', guide: { cells: walk(e.world, pick(e, 0.3), 8), locked: true, spring: true, flow: 3, name: '' } }),
    (e) => {
      const s = coastalStroke(e.world, 0.5, 4);
      e.exec({ op: 'paint_land', cells: s, t: s.map(() => 0), mode: 'land' });
    },
    (e) => e.exec({ op: 'set_planet', patch: e.world.settings.globe ? { tilt: 30 } : { latShift: 4 } }),
    (e) => e.exec({ op: 'set_cell_class', cells: land(e).slice(10, 60), class: 'highlands' }),
    (e) => e.exec({ op: 'set_cell_resource', cells: land(e).slice(100, 140), resource: 'gold' }),
    (e) => {
      const cells = near(e, pick(e, 0.2), 3);
      e.exec({ op: 'paint', field: 'moistOffset', cells, value: 0.4, mode: 'add' });
    },
    (e) => e.exec({ op: 'set_content', kind: 'resource', id: 'iron', item: null }),
    (e) => {
      const cells = near(e, pick(e, 0.8), 3);
      e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: -0.5 });
    },
    (e) => e.undo(),
    (e) => e.undo(),
    (e) => e.redo(),
    (e) => e.exec({ op: 'set_planet', patch: { humidity: 1.2 } }),
  ];
}

describe('人文的几层按格记下：开着与关着逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const a = world(kind);
      const b = world(kind, a.world.mesh);
      const p0 = humanCellMemo.partial;
      let partialSteps = 0;
      let fewSteps = 0;
      try {
        for (const [k, step] of edits().entries()) {
          humanCellMemo.on = true;
          const before = humanCellMemo.partial;
          step(a);
          if (humanCellMemo.partial > before) {
            partialSteps++;
            // 输入变了的格不到干陆地的一半（画河、放湖、抬山……）
            if (humanCellMemo.lastChanged < dryCells(a.world).length / 2) fewSteps++;
          }
          humanCellMemo.on = false;
          step(b);
          for (const key of HUMAN_DERIVED) expect(diffBits(a.world.derived[key], b.world.derived[key]), `第 ${k + 1} 步 ${key}`).toBe(0);
          expect(sameBits(a.world.causes.land, b.world.causes.land)).toBe(true);
        }
      } finally {
        humanCellMemo.on = true;
      }
      // 真的只重算了一部分格（自然的推导每次都重算，几乎每一步都走这条路）
      expect(humanCellMemo.partial - p0).toBeGreaterThan(8);
      expect(partialSteps).toBeGreaterThan(8);
      expect(fewSteps).toBeGreaterThan(3);
    });
  }

  it('纬度按网格记下：与逐格现算的相同（挪过纬度之后也一样）', () => {
    const eng = world('region');
    const w = eng.world;
    for (const shift of [0, 7, -3.5]) {
      if (shift) eng.exec({ op: 'set_planet', patch: { latShift: shift } });
      const x = cellInputs(w, w.derived);
      let bad = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        const want = x.dry[i] ? Math.fround(Math.abs(worldLatitude(w, w.mesh.y[i]))) : 0;
        if (!Object.is(x.lat[i], want)) bad++;
      }
      expect(bad).toBe(0);
    }
  });
});

describe('海底：陆海不变时只重算属性变了的岸边格管着的格，与整个重算逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = world(kind);
      const w = eng.world;
      const { mesh } = w;
      const c0 = seafloorStats.coast;
      const check = (what: string) => {
        const got = w.derived.elevation;
        seafloorStats.on = false;
        try {
          const fresh = new Float32Array(mesh.n).fill(Number.NaN);
          seafloor(w, fresh);
          let bad = 0;
          for (let i = 0; i < mesh.n; i++) if (!w.causes.land[i] && !Object.is(got[i], fresh[i])) bad++;
          expect(bad, what).toBe(0);
        } finally {
          seafloorStats.on = true;
        }
      };
      const coastLand = () => {
        const out: number[] = [];
        for (let i = 0; i < mesh.n; i++) {
          if (!w.causes.land[i]) continue;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++)
            if (!w.causes.land[mesh.adj[e]]) {
              out.push(i);
              break;
            }
        }
        return out;
      };
      const rnd = mulberry32(35);
      for (let step = 0; step < 5; step++) {
        const list = coastLand();
        const c = list[Math.floor(rnd() * list.length)];
        const cells = [...Array(mesh.n).keys()].filter((i) => w.causes.land[i] && Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < mesh.spacing * 3);
        const land0 = w.causes.land.slice();
        eng.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: step % 2 ? -0.6 : 1 });
        // 堆山不改陆海：这一步走陆海不变的那条路
        if (sameBits(land0, w.causes.land)) check(`海岸上堆山 ${step + 1}`);
      }
      eng.undo();
      check('撤销');
      eng.redo();
      check('重做');
      expect(seafloorStats.coast).toBeGreaterThan(c0);
      // 关掉这条路时结果也一样（走原来的只重算改动附近）
      seafloorSameLand.on = false;
      try {
        const c = coastLand()[3];
        const cells = [...Array(mesh.n).keys()].filter((i) => w.causes.land[i] && Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) < mesh.spacing * 3);
        eng.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.8 });
        check('关掉时海岸上堆山');
      } finally {
        seafloorSameLand.on = true;
      }
    });
  }
});

describe('两种常用代价的 Dijkstra 与传闭包的写法逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind).world;
      const { mesh } = w;
      const rnd = mulberry32(5);
      for (let t = 0; t < 6; t++) {
        const cls = new Uint8Array(mesh.n);
        for (let i = 0; i < mesh.n; i++) cls[i] = t < 3 ? w.causes.land[i] : rnd() < 0.3 ? 1 : 0;
        const seeds: number[] = [];
        for (let i = 0; i < mesh.n; i++) if (rnd() < 0.01) seeds.push(i);
        seeds.push(seeds[0]);
        const limit = t % 2 ? Number.POSITIVE_INFINITY : mesh.spacing * (3 + 10 * rnd());
        const same = graphDistance(mesh, seeds, limit, (i, j, e) => (cls[i] === cls[j] ? mesh.dist[e] : Number.POSITIVE_INFINITY));
        expect(sameBits(graphDistanceSame(mesh, Int32Array.from(seeds), limit, cls), same)).toBe(true);
        const avoid = graphDistance(mesh, seeds, limit, (_a, b, e) => (cls[b] ? Number.POSITIVE_INFINITY : mesh.dist[e]));
        expect(sameBits(graphDistanceAvoid(mesh, seeds, limit, cls), avoid)).toBe(true);
      }
    });
  }
});

// ---------- 以前的写法（a011fbb） ----------

const ROWS = 90;
const COLS = 180;

function landFractionOld(mesh: SphereMesh, land: Uint8Array, kmPerUnit: number): Float64Array {
  const px = new Int32Array(ROWS * COLS);
  let hint = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      hint = mesh.locate(((c + 0.5) / COLS) * 2, (r + 0.5) / ROWS, hint);
      px[r * COLS + c] = hint;
    }
  }
  const grid = new Float64Array(ROWS * COLS);
  for (let k = 0; k < grid.length; k++) grid[k] = land[px[k]];
  const sigmaKm = 0.463 * 1500;
  const pxKm = kmPerUnit / ROWS;
  const tmp = new Float64Array(ROWS * COLS);
  for (let r = 0; r < ROWS; r++) {
    const cosLat = Math.sin(((r + 0.5) / ROWS) * Math.PI);
    const s = sigmaKm / (pxKm * Math.max(cosLat, 1e-3));
    if (s > COLS / 2) {
      let m = 0;
      for (let c = 0; c < COLS; c++) m += grid[r * COLS + c];
      m /= COLS;
      for (let c = 0; c < COLS; c++) tmp[r * COLS + c] = m;
      continue;
    }
    const rad = Math.ceil(3 * s);
    const w: number[] = [];
    let wsum = 0;
    for (let d = -rad; d <= rad; d++) {
      const v = Math.exp(-(d * d) / (2 * s * s));
      w.push(v);
      wsum += v;
    }
    for (let c = 0; c < COLS; c++) {
      let acc = 0;
      for (let d = -rad; d <= rad; d++) acc += w[d + rad] * grid[r * COLS + ((((c + d) % COLS) + COLS) % COLS)];
      tmp[r * COLS + c] = acc / wsum;
    }
  }
  const s = sigmaKm / pxKm;
  const rad = Math.ceil(3 * s);
  const blurred = new Float64Array(ROWS * COLS);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      let acc = 0;
      let wsum = 0;
      for (let d = -rad; d <= rad; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= ROWS) continue;
        const v = Math.exp(-(d * d) / (2 * s * s));
        acc += v * tmp[rr * COLS + c];
        wsum += v;
      }
      blurred[r * COLS + c] = acc / wsum;
    }
  }
  const n = mesh.n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fx = (mesh.x[i] / 2) * COLS - 0.5;
    const fy = Math.min(ROWS - 1, Math.max(0, mesh.y[i] * ROWS - 0.5));
    const c0 = Math.floor(fx);
    const r0 = Math.min(ROWS - 2, Math.floor(fy));
    const tx = fx - c0;
    const ty = fy - r0;
    const ca = ((c0 % COLS) + COLS) % COLS;
    const cb = (ca + 1) % COLS;
    const a = r0 * COLS;
    const b = (r0 + 1) * COLS;
    out[i] = (blurred[a + ca] * (1 - tx) + blurred[a + cb] * tx) * (1 - ty) + (blurred[b + ca] * (1 - tx) + blurred[b + cb] * tx) * ty;
  }
  return out;
}

function buildFlowSphereOld(mesh: SphereMesh, wx: ArrayLike<number>, wy: ArrayLike<number>, o: { lag: 'seam' | 'all'; mask?: Uint8Array }) {
  const { rev, dirE, dirS, seam } = sphereAux(mesh);
  const { n, off, adj, edgeLen, x } = mesh;
  const E = adj.length;
  const frac = new Float64Array(E);
  const diffuse = 0.15;
  const calm = new Uint8Array(n);
  const mask = o.mask;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const a = off[i];
    const b = off[i + 1];
    const mag = Math.hypot(wx[i], wy[i]);
    const ux = mag > 1e-6 ? wx[i] / mag : 0;
    const uy = mag > 1e-6 ? wy[i] / mag : 0;
    let sum = 0;
    let fwdLen = 0;
    for (let e = a; e < b; e++) {
      if (mask && !mask[adj[e]]) continue;
      const dot = ux * dirE[e] + uy * dirS[e];
      if (dot > 0) {
        const f = dot * dot * edgeLen[e];
        frac[e] = f;
        sum += f;
        fwdLen += edgeLen[e];
      }
    }
    if (sum <= 0) {
      let total = 0;
      for (let e = a; e < b; e++) if (!mask || mask[adj[e]]) total += edgeLen[e];
      for (let e = a; e < b; e++) frac[e] = !mask || mask[adj[e]] ? (0.6 * edgeLen[e]) / (total || 1) : 0;
      calm[i] = 1;
      continue;
    }
    for (let e = a; e < b; e++) {
      if (frac[e] <= 0) continue;
      frac[e] = (1 - diffuse) * (frac[e] / sum) + (diffuse * edgeLen[e]) / fwdLen;
    }
  }
  for (let i = 0; i < n; i++) {
    if (calm[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const fe = frac[e];
      if (fe <= 0) continue;
      const j = adj[e];
      const ff = frac[rev[e]];
      if (calm[j] || ff <= 0) continue;
      if (fe < ff || (fe === ff && i > j)) frac[e] = 0;
    }
  }
  const lagged = new Uint8Array(E);
  const em = new Uint8Array(E);
  const indeg = new Int32Array(n);
  const seamLag = o.lag === 'seam';
  for (let i = 0; i < n; i++) {
    if (calm[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      if (frac[e] <= 0) continue;
      const j = adj[e];
      if (seamLag && seam[e] && !calm[j]) {
        const s = x[j] < x[i] ? 1 : -1;
        const mi = Math.hypot(wx[i], wy[i]);
        const mj = Math.hypot(wx[j], wy[j]);
        if ((s * wx[i]) / mi > 0.3 && (s * wx[j]) / mj > 0.3) {
          lagged[e] = 1;
          continue;
        }
      }
      em[e] = 1;
      indeg[j]++;
    }
  }
  // 拓扑序（与新写法共用同一个 kahnOrder：没有改它）
  const flow = buildFlowSphere(mesh, wx, wy, o);
  const order = flow.order;
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[order[k]] = k;
  const lagAll = o.lag === 'all';
  for (let i = 0; i < n; i++) {
    const pi = pos[i];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      if (frac[e] <= 0 || pos[adj[e]] >= pi) continue;
      if (lagAll) lagged[e] = 1;
      else if (!lagged[e]) frac[e] = 0;
    }
  }
  const koff = new Int32Array(n + 1);
  const src = new Int32Array(E);
  const w = new Float64Array(E);
  const den = new Float64Array(n);
  let p = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    let s = 0;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const f = frac[rev[e]];
      if (f <= 0) continue;
      src[p] = adj[e];
      w[p++] = f;
      s += f;
    }
    den[k] = s;
    koff[k + 1] = p;
  }
  return { frac, order, lagged, em, indeg, koff, src: src.slice(0, p), w: w.slice(0, p), den };
}

describe('星球的陆地占比、输运图与以前的写法逐位相同', () => {
  it('陆地占比（随机的陆海）', () => {
    const eng = world('planet');
    const mesh = eng.world.mesh as SphereMesh;
    const rnd = mulberry32(11);
    for (let t = 0; t < 4; t++) {
      const land = new Uint8Array(mesh.n);
      for (let i = 0; i < mesh.n; i++) land[i] = t === 0 ? eng.world.causes.land[i] : rnd() < 0.15 + 0.2 * t ? 1 : 0;
      for (const km of [eng.world.kmPerUnit, eng.world.kmPerUnit * 0.37]) expect(sameBits(landFractionSphere(mesh, land, km), landFractionOld(mesh, land, km))).toBe(true);
    }
  });

  it('输运图（随机的风、有没有 mask、两种滞后）', () => {
    const eng = world('planet');
    const w = eng.world;
    const mesh = w.mesh as SphereMesh;
    const rnd = mulberry32(17);
    const cases: [ArrayLike<number>, ArrayLike<number>][] = [
      [w.derived.windSX, w.derived.windSY],
      [w.derived.windWX, w.derived.windWY],
    ];
    const wx = new Float64Array(mesh.n);
    const wy = new Float64Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) {
      // 有一些无风的格（全是 0）
      wx[i] = rnd() < 0.05 ? 0 : rnd() * 2 - 1;
      wy[i] = rnd() < 0.05 ? 0 : rnd() * 2 - 1;
    }
    cases.push([wx, wy]);
    const ocean = new Uint8Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) ocean[i] = w.causes.land[i] ? 0 : 1;
    for (const [a, b] of cases) {
      for (const o of [{ lag: 'seam' as const }, { lag: 'all' as const, mask: ocean }, { lag: 'all' as const }]) {
        const got = buildFlowSphere(mesh, a, b, o);
        const old = buildFlowSphereOld(mesh, a, b, o);
        for (const k of ['frac', 'order', 'lagged', 'koff', 'src', 'w', 'den'] as const) expect(sameBits(got[k], old[k]), k).toBe(true);
      }
    }
  });
});

// 以前的山挡风（a011fbb，逐字照抄）
function deflectWindOld(
  mesh: Mesh,
  lat: Float64Array,
  hPos: Float64Array,
  hx: Float64Array,
  hy: Float64Array,
  strength: number,
  rotation: number,
  passes: number,
  winds: readonly (readonly [ArrayLike<number>, ArrayLike<number>])[],
): [Float64Array, Float64Array][] {
  const n = mesh.n;
  // 每格四个数挨着放（夏东、夏南、冬东、冬南）：平滑时一格的邻居只读一遍
  let cur = new Float64Array(4 * n);
  const seeds: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = Math.sqrt(hx[i] * hx[i] + hy[i] * hy[i]);
    if (g <= 0.5) continue;
    // 指向上坡的单位向量；a > 0 迎风坡，a < 0 背风坡
    const nx = hx[i] / g;
    const ny = hy[i] / g;
    const h = Math.max(hPos[i], 1);
    const slope = smoothstep(0.5, 4, g);
    let touched = false;
    for (let s = 0; s < 2; s++) {
      const u0 = winds[s][0][i];
      const v0 = winds[s][1][i];
      const m0 = Math.sqrt(u0 * u0 + v0 * v0);
      // 无风的格没有方向可改（下面要除以风速）
      if (m0 < 1e-9) continue;
      const fr = (1000 * m0) / h;
      if (fr >= 1.6) continue;
      const a = u0 * nx + v0 * ny;
      let beta = Math.min(0.95, strength * 0.85 * (1 - smoothstep(0.4, 1.6, fr)) * slope);
      if (a < 0) beta *= 0.5;
      if (beta <= 0) continue;
      let u1 = u0 - beta * a * nx;
      let v1 = v0 - beta * a * ny;
      if (a > 0) {
        // 东、南分量里 (ny, −nx) 是面朝上坡时的左手边；赤道附近没有偏转
        const c = rotation * Math.sign(lat[i]) * Math.min(1, Math.abs(Math.sin((lat[i] * Math.PI) / 180)) / 0.5);
        u1 += 0.7 * beta * a * c * ny;
        v1 -= 0.7 * beta * a * c * nx;
      }
      const k = (m0 * (1 - 0.5 * beta * (a / m0) ** 2)) / Math.sqrt(u1 * u1 + v1 * v1);
      cur[4 * i + 2 * s] = u1 * k - u0;
      cur[4 * i + 2 * s + 1] = v1 * k - v0;
      touched = true;
    }
    if (touched) seeds.push(i);
  }
  const out: [Float64Array, Float64Array][] = [
    [new Float64Array(n), new Float64Array(n)],
    [new Float64Array(n), new Float64Array(n)],
  ];
  if (!seeds.length) return out;
  // 与 smoothPass 同样的一轮扩散，只算离有变化的格 passes 步以内的格：更远的格在这几遍里一直是 0。
  // 同理第 it 遍里离得比 it + 1 步远的格也还是 0：按步数排好，每遍只算到 it + 1 步（结果与全算逐位相同；
  // 1500 km 宽、格很密的图上要算满 48 遍，省约四分之一）
  const reach = ringDistance(mesh, seeds, passes);
  // within[r]：离有变化的格不超过 r 步的格数；active 按步数排（同一步数里按下标）
  const within = new Int32Array(passes + 1);
  for (let i = 0; i < n; i++) if (reach[i] >= 0) within[reach[i]]++;
  for (let r = 1; r <= passes; r++) within[r] += within[r - 1];
  const active = new Int32Array(within[passes]);
  const slot = new Int32Array(passes + 1);
  for (let r = 1; r <= passes; r++) slot[r] = within[r - 1];
  for (let i = 0; i < n; i++) if (reach[i] >= 0) active[slot[reach[i]]++] = i;
  const { off, adj } = mesh;
  let next = new Float64Array(4 * n);
  // 按下标走类型数组，比 for…of 快约三成
  for (let it = 0; it < passes; it++) {
    const m = within[Math.min(passes, it + 1)];
    for (let k = 0; k < m; k++) {
      const i = active[k];
      const b = 4 * i;
      let s0 = cur[b];
      let s1 = cur[b + 1];
      let s2 = cur[b + 2];
      let s3 = cur[b + 3];
      const e0 = off[i];
      const e1 = off[i + 1];
      for (let e = e0; e < e1; e++) {
        const j = 4 * adj[e];
        s0 += cur[j];
        s1 += cur[j + 1];
        s2 += cur[j + 2];
        s3 += cur[j + 3];
      }
      const den = 1 + e1 - e0;
      next[b] = s0 / den;
      next[b + 1] = s1 / den;
      next[b + 2] = s2 / den;
      next[b + 3] = s3 / den;
    }
    const t = cur;
    cur = next;
    next = t;
  }
  for (const i of active) {
    out[0][0][i] = cur[4 * i];
    out[0][1][i] = cur[4 * i + 1];
    out[1][0][i] = cur[4 * i + 2];
    out[1][1][i] = cur[4 * i + 3];
  }
  return out;
}

describe('山挡风拆成小函数：与以前的写法逐位相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind).world;
      const { mesh } = w;
      const n = mesh.n;
      const rnd = mulberry32(23);
      const lat = Float64Array.from({ length: n }, (_, i) => worldLatitude(w, mesh.y[i]));
      for (let t = 0; t < 3; t++) {
        const hPos = Float64Array.from({ length: n }, () => (rnd() < 0.5 ? 0 : rnd() * 4000));
        const hx = Float64Array.from({ length: n }, () => (rnd() - 0.5) * 12);
        const hy = Float64Array.from({ length: n }, () => (rnd() - 0.5) * 12);
        const winds = [0, 1].map(() => [Float32Array.from({ length: n }, () => (rnd() < 0.03 ? 0 : rnd() * 2 - 1)), Float32Array.from({ length: n }, () => rnd() * 2 - 1)] as const);
        for (const passes of [1, 4]) {
          const got = deflectWind(mesh, lat, hPos, hx, hy, 0.4 + 0.3 * t, t === 1 ? -1 : 1, passes, [winds[0], winds[1]]);
          const old = deflectWindOld(mesh, lat, hPos, hx, hy, 0.4 + 0.3 * t, t === 1 ? -1 : 1, passes, winds);
          for (let s = 0; s < 2; s++) for (let c = 0; c < 2; c++) expect(sameBits(got[s][c], old[s][c]), `第 ${t} 组 ${passes} 遍`).toBe(true);
        }
      }
    });
  }
});

// 以前的写法（a011fbb）
function provinceSizesOld(world: World): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const p of world.causes.province) if (p >= 0) sizes.set(p, (sizes.get(p) ?? 0) + 1);
  return sizes;
}
function repairProvincesOld(world: World) {
  const { causes, small } = world;
  const pland = provinceLand(world);
  for (let i = 0; i < causes.province.length; i++) {
    const p = causes.province[i];
    if (p < 0) continue;
    const meta = small.provinces[p];
    if (!meta || meta.land !== (pland[i] === 1)) causes.province[i] = -1;
  }
  fillUnassigned(world);
  const sizes = provinceSizesOld(world);
  for (const id of Object.keys(world.small.provinces).map(Number)) if (!sizes.has(id)) delete world.small.provinces[id];
}

describe('省份的格数与修补省份：与以前的写法逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const a = world(kind);
      a.exec({ op: 'generate_provinces', rules: { seed: 3 } });
      const b = world(kind, a.world.mesh);
      b.exec({ op: 'generate_provinces', rules: { seed: 3 } });
      const rnd = mulberry32(41);
      for (let t = 0; t < 4; t++) {
        // 同样地弄乱两边：几格换成没有的省、几格换成别的省、陆海翻过来几格（只改原因里的格，命令不知道）
        const ids = Object.keys(a.world.small.provinces).map(Number);
        for (let k = 0; k < 300; k++) {
          const i = Math.floor(rnd() * a.world.mesh.n);
          const r = rnd();
          const v = r < 0.3 ? ids[ids.length - 1] + 5 + Math.floor(rnd() * 3) : r < 0.6 ? ids[Math.floor(rnd() * ids.length)] : -1;
          a.world.causes.province[i] = v;
          b.world.causes.province[i] = v;
          if (rnd() < 0.2) {
            a.world.causes.land[i] ^= 1;
            b.world.causes.land[i] ^= 1;
          }
        }
        expect([...provinceSizes(a.world)]).toEqual([...provinceSizesOld(a.world)]);
        repairProvinces(a.world);
        repairProvincesOld(b.world);
        expect(sameBits(a.world.causes.province, b.world.causes.province), `第 ${t + 1} 次`).toBe(true);
        expect(JSON.stringify(a.world.small.provinces)).toBe(JSON.stringify(b.world.small.provinces));
        expect([...provinceSizes(a.world)]).toEqual([...provinceSizesOld(a.world)]);
      }
    });
  }
});
