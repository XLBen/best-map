import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { elevationMemo } from './elevation';
import type { Engine } from './engine';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { meshFor, seededEngine } from './testing/fixtures';

// 高程记忆的快路（第三十一轮，elevation.ts 的 fromMemo）：整份照用最近的一份、只逐块比碰到改动的陆块，
// 与每块陆地逐块比（fast = false，以前的做法）逐值相同，重算的陆块也一样多。
// 两个引擎各用一个网格（记忆按网格存），一步一步对照：抬山、岩性、画陆地、画海（陆地变成海）、放岛、重画一片、放湖、
// 陆地多少、撤销、重做

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

function withFast<T>(fast: boolean, f: () => T): T {
  const saved = elevationMemo.fast;
  elevationMemo.fast = fast;
  try {
    return f();
  } finally {
    elevationMemo.fast = saved;
  }
}

for (const [label, settings] of [
  ['一块地区', { cells: 5000, seed: 6 }],
  ['整个星球', { cells: 4000, seed: 6, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const) {
  it(`高程记忆的快路与逐块比逐值相同：${label}`, () => {
    const mesh = meshFor(settings);
    const a = seededEngine(settings, fresh(mesh));
    const b = seededEngine(settings, fresh(mesh));
    // 撤销、重做也重算（不用撤销缓存），记忆才用得上
    a.undoCache = 0;
    b.undoCache = 0;
    const both = (step: (e: Engine) => void) => {
      const c0 = elevationMemo.computed;
      withFast(true, () => step(a));
      const ca = elevationMemo.computed - c0;
      const c1 = elevationMemo.computed;
      withFast(false, () => step(b));
      expect(ca).toBe(elevationMemo.computed - c1);
      expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    };
    const run = (cmd: Command) => both((e) => e.exec(cmd));
    run({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
    const w = a.world;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]);
    const near = (c: number, r: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * r);
    const hill = near(land[Math.floor(land.length * 0.4)], 4);
    run({ op: 'paint_relief', cells: hill, t: hill.map(() => 0), strength: 0.6 });
    const soft = near(land[Math.floor(land.length * 0.7)], 4);
    run({ op: 'paint', field: 'erodDelta', cells: soft, value: 0.5, mode: 'add' });
    const coast = coastalStroke(w, 0.3, 5);
    run({ op: 'paint_land', cells: coast, t: coast.map(() => 0), mode: 'land' });
    const cut = coastalStroke(w, 0.6, 5);
    run({ op: 'paint_land', cells: cut, t: cut.map(() => 0), mode: 'sea' });
    let sea = 0;
    for (let i = Math.floor(w.mesh.n * 0.45); i < w.mesh.n; i++) if (!w.causes.land[i] && Math.abs(w.mesh.y[i] - 0.5) < 0.3) {
      sea = i;
      break;
    }
    run({ op: 'add_island', island: { x: w.mesh.x[sea], y: w.mesh.y[sea], kind: 'continental', size: 250, variant: 0 } });
    const c = land[Math.floor(land.length * 0.55)];
    run({ op: 'reroll_region', x: w.mesh.x[c], y: w.mesh.y[c], radius: 0.1, variant: 1 });
    const lc = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i])[300];
    run({ op: 'add_lake', lake: { cell: lc, radius: 120, depth: 80 } });
    run({ op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: 0.45 } });
    both((e) => e.undo());
    both((e) => e.undo());
    both((e) => e.undo());
    both((e) => e.redo());
    run({ op: 'paint_relief', cells: hill, t: hill.map(() => 0.5), strength: -0.4 });
  });
}

describe('计数', () => {
  it('快路：没改动时不重算任何陆块', () => {
    const e = seededEngine({ cells: 3000, seed: 2 });
    e.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    const c0 = elevationMemo.computed;
    e.exec({ op: 'set_planet', patch: { mountainScale: 5000 } });
    expect(elevationMemo.computed).toBe(c0);
  });
});
