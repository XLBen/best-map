import { describe, expect, it } from 'vitest';
import type { Command } from './commands';
import type { Engine } from './engine';
import { routeMemo, slopeMemo } from './hydrology';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { routePartStats } from './routing-parts';
import { meshFor, seededEngine } from './testing/fixtures';
import { coastalStroke } from '../tools/hash';

// 第八十八轮（提速）：水文的路由按陆块记（core/routing-parts.ts：没变的陆块照用，变了的几块一起求），坡度只重算高度变了的格与邻格
// （core/hydrology.ts 的 slopeAgain）。一串加工（画陆地、放岛、堆山、改岩性、画河、放湖、涂冷、挪纬度、撤销）每一步之后水文的推导
// 与关掉记忆、在新的网格上从头算的逐值相同；而且真的有陆块照用了

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

const SETS = [
  ['一块地区', { cells: 8000, seed: 4, latNorth: 70, latSouth: 20 }],
  ['整个星球', { cells: 8000, seed: 4, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const;

const KEYS = ['elevation', 'water', 'lake', 'discharge', 'drainArea', 'receiver', 'basin', 'slope', 'wetness'] as const;

function plan(e: Engine): ((e: Engine) => void)[] {
  const w = e.world;
  const land: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i]) land.push(i);
  const near = (c: number, r: number) => land.filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < r * w.mesh.spacing);
  const a = near(land[Math.floor(land.length * 0.3)], 4);
  const b = near(land[Math.floor(land.length * 0.6)], 4);
  // 从内陆一格顺着邻格往东走几格
  const path = [land[Math.floor(land.length * 0.45)]];
  for (let k = 0; k < 8; k++) {
    const c = path[path.length - 1];
    let best = -1;
    for (let q = w.mesh.off[c]; q < w.mesh.off[c + 1]; q++) {
      const j = w.mesh.adj[q];
      if (!path.includes(j) && w.causes.land[j] && (best < 0 || w.mesh.x[j] > w.mesh.x[best])) best = j;
    }
    if (best < 0) break;
    path.push(best);
  }
  const ex = (c: Command) => (e: Engine) => e.exec(c);
  const stroke = coastalStroke(w, 0.37, 5);
  let sea = 0;
  for (let i = Math.floor(w.mesh.n * 0.41); i < w.mesh.n; i++) if (!w.causes.land[i] && Math.abs(w.mesh.y[i] - 0.5) < 0.25) {
    sea = i;
    break;
  }
  return [
    ex({ op: 'paint_land', cells: stroke, t: stroke.map(() => 0), mode: 'land' }),
    ex({ op: 'add_island', island: { x: w.mesh.x[sea], y: w.mesh.y[sea], kind: 'continental', size: 300, variant: 0 } }),
    ex({ op: 'paint_relief', cells: a, t: a.map(() => 0), strength: 0.7 }),
    ex({ op: 'paint', field: 'erodDelta', cells: b, value: 0.5, mode: 'add' }),
    ex({ op: 'add_guide', guide: { cells: path, locked: true, spring: true, flow: 4, name: '' } }),
    ex({ op: 'add_lake', lake: { cell: land[Math.floor(land.length * 0.7)], radius: 150, depth: 120, perennial: true } }),
    ex({ op: 'paint', field: 'tempOffset', cells: b, values: b.map(() => -4), mode: 'add' }),
    ex(w.mesh.kind === 'sphere' ? { op: 'set_planet', patch: { solar: 0.97 } } : { op: 'set_planet', patch: { latShift: 3 } }),
    (e) => e.undo(),
    (e) => e.undo(),
    (e) => e.redo(),
  ];
}

describe('水文按陆块记的路由、只重算变了的坡度：与从头算的逐值相同', () => {
  for (const [label, settings] of SETS) {
    it(label, () => {
      const mesh = meshFor(settings);
      const run = (memo: boolean): Record<string, number[]>[] => {
        const e = seededEngine(settings, fresh(mesh));
        e.undoCache = 0;
        e.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
        const saved = [routeMemo.on, slopeMemo.on];
        routeMemo.on = memo;
        slopeMemo.on = memo;
        try {
          return plan(e).map((step) => {
            step(e);
            return Object.fromEntries(KEYS.map((k) => [k, Array.from(e.world.derived[k])]));
          });
        } finally {
          [routeMemo.on, slopeMemo.on] = saved;
        }
      };
      const r0 = routePartStats.reused;
      const got = run(true);
      expect(routePartStats.reused - r0).toBeGreaterThan(0);
      const want = run(false);
      got.forEach((g, k) => {
        for (const key of KEYS) expect(g[key], `${k} ${key}`).toEqual(want[k][key]);
      });
    }, 120000);
  }
});
