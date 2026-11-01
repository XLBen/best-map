import { describe, expect, it } from 'vitest';
import { coastalStroke } from '../tools/hash';
import type { Engine } from './engine';
import { type AddInput, type GeoFeature, detectFeatures, featureMemo, lakeIslandInputs, nearMax, riverInputs } from './features';
import { computeHydrology, slopeMemo } from './hydrology';
import type { Mesh } from './mesh';
import { mulberry32 } from './rng';
import { POCKET_MAX, fillSeaPockets } from './terrain';
import { seededEngine } from './testing/fixtures';
import { type Derived, type World, emptyDerived } from './world';

// 第三十二轮（提速）：新加的缓存与快路与直白的写法逐值相同。
//   · 地物：山脉、高原与平原、盆地三小段各自按读的数组缓存（湖面随气候涨落时盆地不重算）——用缓存与从头识别逐值相同；
//     盆地的“附近最高”两份数组轮换（nearMax）与以前每遍先复制一份的写法逐值相同；
//     湖里的岛只从湖岸出发、碰到海就停（lakeIslandInputs）与以前整块干陆地走一遍的写法逐值相同
//   · 水文：坡度按高程、海陆缓存（slopeMemo）——开着与关着逐值相同
// 拆成小函数的几处（气候、洋流、水文、植被、高程求解、地物的陆海段）是原样照搬，由金标准（golden、golden-full、
// r31-digests、solver-identity 等）逐值把关

// 地物的全部内容（含格子）；-0 与 NaN 单独写出来
const json = (fs: GeoFeature[]) =>
  JSON.stringify(
    fs.map((f) => ({ ...f, cells: Array.from(f.cells) })),
    (_, v) => (typeof v === 'number' && (Object.is(v, -0) || Number.isNaN(v)) ? String(v) : v),
  );

const settingsOf = {
  region: { seed: 4, cells: 6000 },
  planet: { seed: 4, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 },
} as const;

function world(kind: 'region' | 'planet'): Engine {
  const eng = seededEngine(settingsOf[kind]);
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
  return eng;
}

const landCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] === 0);

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

// 一组加工：改气候（内流湖涨落，湖面变了）、放湖、抬山、画河、画陆地、轴倾角 / 纬度、撤销
function edits(eng: Engine): ((e: Engine) => void)[] {
  const w = eng.world;
  const land = landCells(w);
  const pick = (f: number) => land[Math.floor(land.length * f)];
  const near = (c: number, r: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * r);
  return [
    (e) => e.exec({ op: 'set_planet', patch: { humidity: 0.7 } }),
    (e) => e.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 400), value: 3, mode: 'add' }),
    (e) => e.exec({ op: 'add_lake', lake: { cell: pick(0.4), radius: 150, depth: 120, perennial: false } }),
    (e) => {
      const cells = near(pick(0.6), 4);
      e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.7 });
    },
    (e) => e.exec({ op: 'add_guide', guide: { cells: walk(w, pick(0.3), 8), locked: true, spring: true, flow: 3, name: '' } }),
    (e) => {
      const s = coastalStroke(e.world, 0.5, 4);
      e.exec({ op: 'paint_land', cells: s, t: s.map(() => 0), mode: 'land' });
    },
    (e) => e.exec({ op: 'set_planet', patch: e.world.settings.globe ? { tilt: 30 } : { latShift: 4 } }),
    (e) => e.exec({ op: 'set_planet', patch: { humidity: 1.3 } }),
    (e) => e.undo(),
    (e) => e.undo(),
  ];
}

describe('地物：分段缓存与从头识别逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = world(kind);
      let lakeChanged = 0;
      for (const step of edits(eng)) {
        const before = eng.world.derived.lake.slice();
        step(eng);
        if (eng.world.derived.lake.some((v, i) => v !== before[i])) lakeChanged++;
        const got = json(eng.world.derived.features);
        featureMemo.on = false;
        let fresh: string;
        try {
          // 引擎按没挖河床、没修湖底的地形认（与 features-biome 测试一样取引擎里的那一份）
          fresh = json(detectFeatures(eng.world, eng.world.derived, (eng as unknown as { base: { terrain: Float32Array } }).base.terrain));
        } finally {
          featureMemo.on = true;
        }
        expect(got).toBe(fresh);
      }
      // 改气候的几步里湖面真的变了（分段缓存要对付的情形）
      expect(lakeChanged).toBeGreaterThan(2);
    });
  }
});

// 以前的写法：每遍先复制一份，再逐个取最大
function nearMaxOld(mesh: Mesh, land: Uint8Array, elevation: ArrayLike<number>): Float64Array {
  const n = mesh.n;
  const near = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    let mx = elevation[i];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) mx = Math.max(mx, elevation[mesh.adj[e]]);
    near[i] = mx;
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = Float64Array.from(near);
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) next[i] = Math.max(next[i], near[mesh.adj[e]]);
    }
    near.set(next);
  }
  return near;
}

const bits = (a: Float64Array) => Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length * 2));

describe('盆地的“附近最高”与以前的写法逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind).world;
      const elev = w.derived.elevation;
      expect(bits(nearMax(w.mesh, w.causes.land, elev))).toEqual(bits(nearMaxOld(w.mesh, w.causes.land, elev)));
      // 随机的高度（含负数、0 与 −0）
      const rnd = mulberry32(7);
      const e2 = new Float32Array(w.mesh.n);
      for (let i = 0; i < w.mesh.n; i++) e2[i] = rnd() < 0.05 ? -0 : rnd() < 0.1 ? 0 : (rnd() - 0.3) * 5000;
      expect(bits(nearMax(w.mesh, w.causes.land, e2))).toEqual(bits(nearMaxOld(w.mesh, w.causes.land, e2)));
    });
  }
});

// 以前的写法：从挨着湖面的每个干陆地格出发把整块干陆地走一遍
function lakeIslandsOld(w: World, d: Derived): number[][] {
  const { mesh } = w;
  const n = mesh.n;
  const land = w.causes.land;
  const dry = new Uint8Array(n);
  let lakes = 0;
  for (let i = 0; i < n; i++) {
    dry[i] = land[i] && d.lake[i] !== 1 ? 1 : 0;
    if (d.lake[i] === 1) lakes++;
  }
  const out: number[][] = [];
  if (!lakes) return out;
  const comp = new Int32Array(n).fill(-1);
  for (let s = 0; s < n; s++) {
    if (!dry[s] || comp[s] >= 0) continue;
    let byLake = false;
    for (let e = mesh.off[s]; e < mesh.off[s + 1] && !byLake; e++) if (d.lake[mesh.adj[e]] === 1) byLake = true;
    if (!byLake) continue;
    const cells = [s];
    comp[s] = s;
    let enclosed = !mesh.boundary[s];
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (dry[j]) {
          if (comp[j] < 0) {
            comp[j] = s;
            cells.push(j);
            if (mesh.boundary[j]) enclosed = false;
          }
        } else if (!land[j] || d.lake[j] !== 1) enclosed = false;
      }
    }
    if (!enclosed || cells.length < 2) continue;
    out.push(cells.sort((a, b) => a - b));
  }
  return out;
}

// 一圈湖水围着一块干陆地（岛），外加零散的湖面：圈的半径、位置随机，有的挨着海、地图边，有的圈不完整
function syntheticLakes(w: World, seed: number): Derived {
  const { mesh } = w;
  const n = mesh.n;
  const d = emptyDerived(n, w.small.species.length);
  const rnd = mulberry32(seed);
  const land = [...Array(n).keys()].filter((i) => w.causes.land[i]);
  for (let k = 0; k < 25; k++) {
    const c = land[Math.floor(rnd() * land.length)];
    const r1 = 0.6 + rnd() * 3;
    const r2 = r1 + 0.8 + rnd() * 2;
    const open = rnd() < 0.2;
    for (let i = 0; i < n; i++) {
      if (!w.causes.land[i]) continue;
      let dx = mesh.x[i] - mesh.x[c];
      if (mesh.kind === 'sphere') dx -= 2 * Math.round(dx / 2);
      const r = Math.hypot(dx, mesh.y[i] - mesh.y[c]) / mesh.spacing;
      if (r >= r1 && r < r2 && !(open && dx > 0 && Math.abs(mesh.y[i] - mesh.y[c]) < mesh.spacing)) d.lake[i] = 1;
    }
  }
  for (let k = 0; k < 200; k++) d.lake[land[Math.floor(rnd() * land.length)]] = rnd() < 0.8 ? 1 : 2;
  return d;
}

describe('湖里的岛：只从湖岸出发、碰到海就停，与整块走一遍逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind).world;
      let islands = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const d = syntheticLakes(w, seed);
        const got: AddInput[] = lakeIslandInputs(w, d);
        const want = lakeIslandsOld(w, d);
        expect(got.map((a) => Array.from(a.cells))).toEqual(want);
        islands += want.length;
      }
      // 真的有湖里的岛，也有不是岛的（挨着海、圈不完整）
      expect(islands).toBeGreaterThan(10);
      // 引擎里的推导（自然的湖）
      const eng = world(kind);
      expect(lakeIslandInputs(eng.world, eng.world.derived).map((a) => Array.from(a.cells))).toEqual(lakeIslandsOld(eng.world, eng.world.derived));
    });
  }
});

// 以前的写法：建每格的整张上游表（按编号），沿流量最大的上游往上找
function riverStemsOld(w: World, d: Derived): number[][] {
  const n = w.mesh.n;
  const land = w.causes.land;
  const thr = w.small.planet.riverThreshold;
  const donorAt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const r = d.receiver[i];
    if (land[i] && r >= 0 && land[r]) donorAt[r + 1]++;
  }
  for (let i = 0; i < n; i++) donorAt[i + 1] += donorAt[i];
  const donors = new Int32Array(donorAt[n]);
  const fill = donorAt.slice(0, n);
  for (let i = 0; i < n; i++) {
    const r = d.receiver[i];
    if (land[i] && r >= 0 && land[r]) donors[fill[r]++] = i;
  }
  const mouths: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || d.lake[i] === 1 || d.discharge[i] < thr * 3) continue;
    const r = d.receiver[i];
    if (r < 0 || !land[r] || d.lake[r] === 1) mouths.push(i);
  }
  mouths.sort((a, b) => d.discharge[b] - d.discharge[a]);
  const out: number[][] = [];
  for (const m of mouths.slice(0, 40)) {
    const stem: number[] = [m];
    let c = m;
    for (let guard = 0; guard < n; guard++) {
      let best = -1;
      for (let e = donorAt[c]; e < donorAt[c + 1]; e++) {
        const j = donors[e];
        if (d.lake[j] !== 1 && d.discharge[j] >= thr && (best < 0 || d.discharge[j] > d.discharge[best])) best = j;
      }
      if (best < 0) break;
      stem.push(best);
      c = best;
    }
    if (stem.length >= 6) out.push(stem);
  }
  return out;
}

describe('大河：一遍记下每格流量最大的上游，与建整张上游表逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = world(kind);
      let rivers = 0;
      for (const step of [() => undefined, ...edits(eng)]) {
        step(eng);
        const w = eng.world;
        const got = riverInputs(w, w.derived);
        expect(got.map((a) => Array.from(a.cells))).toEqual(riverStemsOld(w, w.derived));
        rivers += got.length;
        // 河的门槛低一些：小河、并列的流量多一些
        const low = { ...w, small: { ...w.small, planet: { ...w.small.planet, riverThreshold: w.small.planet.riverThreshold / 8 } } };
        expect(riverInputs(low, w.derived).map((a) => Array.from(a.cells))).toEqual(riverStemsOld(low, w.derived));
      }
      expect(rivers).toBeGreaterThan(20);
    });
  }
});

describe('水文：坡度的缓存开着与关着逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = world(kind);
      const keys = ['slope', 'wetness', 'drainArea', 'discharge', 'receiver', 'lake', 'water', 'basin'] as const;
      let hits = 0;
      for (const step of edits(eng)) {
        step(eng);
        const w = eng.world;
        const run = (on: boolean) => {
          const d = { ...w.derived, ...Object.fromEntries(keys.map((k) => [k, w.derived[k].slice()])) } as Derived;
          const saved = slopeMemo.on;
          slopeMemo.on = on;
          try {
            computeHydrology(w, w.derived.elevation, d);
          } finally {
            slopeMemo.on = saved;
          }
          return d;
        };
        const h0 = slopeMemo.hit;
        const a = run(true);
        hits += slopeMemo.hit - h0;
        const b = run(false);
        for (const k of keys) expect(Array.from(a[k]), k).toEqual(Array.from(b[k]));
      }
      expect(hits).toBeGreaterThan(0);
    });
  }
});

// 以前的写法：每一格海都从它起找一遍（最多 POCKET_MAX + 1 格），找到的小块标上不再找
function fillSeaPocketsOld(mesh: Mesh, land: Uint8Array, isLagoon: (i: number) => boolean) {
  const seaPocket = (start: number): number[] | null => {
    if (mesh.boundary[start]) return null;
    const cells = [start];
    let lagoon = isLagoon(start);
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (land[j] || cells.includes(j)) continue;
        if (mesh.boundary[j] || cells.length >= POCKET_MAX) return null;
        cells.push(j);
        if (isLagoon(j)) lagoon = true;
      }
    }
    return cells.length > 1 && lagoon ? null : cells;
  };
  const done = new Uint8Array(mesh.n);
  const fill: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (land[i] || done[i]) continue;
    const p = seaPocket(i);
    if (!p) continue;
    for (const c of p) {
      done[c] = 1;
      fill.push(c);
    }
  }
  for (const i of fill) land[i] = 1;
}

describe('小块海并回陆地：整块走一遍再找，与逐格找逐值相同', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind).world;
      const n = w.mesh.n;
      let filled = 0;
      for (let seed = 1; seed <= 16; seed++) {
        const rnd = mulberry32(seed);
        // 陆地上随机挖些小洞（1–8 格的海块，有的挨地图边），有的是潟湖
        const land = w.causes.land.slice();
        const lagoon = new Uint8Array(n);
        const landCells = [...Array(n).keys()].filter((i) => land[i]);
        for (let k = 0; k < 300; k++) {
          let c = landCells[Math.floor(rnd() * landCells.length)];
          const size = 1 + Math.floor(rnd() * 8);
          for (let m = 0; m < size; m++) {
            land[c] = 0;
            if (rnd() < 0.1) lagoon[c] = 1;
            c = w.mesh.adj[w.mesh.off[c] + Math.floor(rnd() * (w.mesh.off[c + 1] - w.mesh.off[c]))];
          }
        }
        const a = land.slice();
        const b = land.slice();
        fillSeaPockets(w.mesh, a, (i) => lagoon[i] === 1);
        fillSeaPocketsOld(w.mesh, b, (i) => lagoon[i] === 1);
        expect(Array.from(a)).toEqual(Array.from(b));
        for (let i = 0; i < n; i++) if (a[i] !== land[i]) filled++;
      }
      expect(filled).toBeGreaterThan(100);
    });
  }
});
