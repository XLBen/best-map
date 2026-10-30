import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { elevationMemo } from './elevation';
import type { Engine } from './engine';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { ensureBase, reliefFields } from './terrain';
import { meshFor, seededEngine } from './testing/fixtures';

// 第三十二轮：大格局（基准面 T、洼地 pit，见 relief.ts）进了高程的求解与记忆。
// 这里查：记忆开着与关着逐值相同（T、pit 进了记忆的键）；改气候不改高程；重画一片不挪海平面；洋壳上没有大格局

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

function withMemo<T>(on: boolean, f: () => T): T {
  const saved = elevationMemo.on;
  elevationMemo.on = on;
  try {
    return f();
  } finally {
    elevationMemo.on = saved;
  }
}

const SETTINGS = [
  ['一块地区', { cells: 5000, seed: 7 }],
  ['整个星球', { cells: 4000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const;

for (const [label, settings] of SETTINGS) {
  it(`高程记忆开着与关着逐值相同（基准面、洼地变了的几步）：${label}`, () => {
    const mesh = meshFor(settings);
    const a = seededEngine(settings, fresh(mesh));
    const b = seededEngine(settings, fresh(mesh));
    a.undoCache = 0;
    b.undoCache = 0;
    const both = (step: (e: Engine) => void) => {
      withMemo(true, () => step(a));
      withMemo(false, () => step(b));
      expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    };
    const run = (cmd: Command) => both((e) => e.exec(cmd));
    run({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    const w = a.world;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]);
    const c = land[Math.floor(land.length * 0.5)];
    // “山多高”只缩放高原：基准面变了
    run({ op: 'set_worldgen', params: { ...w.small.terrain.gen!, mountains: 1.4 } });
    // 重画一片：圈里的基准面、洼地换了
    run({ op: 'reroll_region', x: w.mesh.x[c], y: w.mesh.y[c], radius: 0.12, variant: 2 });
    const near = [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * 4);
    run({ op: 'paint_relief', cells: near, t: near.map(() => 0), strength: 0.5 });
    both((e) => e.undo());
    both((e) => e.undo());
    both((e) => e.redo());
  });

  it(`改气候永远不重算、不改高程：${label}`, () => {
    const e = seededEngine(settings, fresh(meshFor(settings)));
    e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    const w = e.world;
    const before = w.derived.elevation.slice();
    const terrain = digestWorld(w)['derived.elevation'];
    const c0 = elevationMemo.computed;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]).slice(0, 400);
    const cmds: Command[] = [
      { op: 'set_planet', patch: { humidity: 1.6 } },
      { op: 'set_planet', patch: { solar: 0.8 } },
      { op: 'set_planet', patch: { tilt: 35 } },
      { op: 'paint', field: 'tempOffset', cells: land, value: 6, mode: 'add' },
      { op: 'paint', field: 'moistOffset', cells: land, value: -1, mode: 'add' },
    ];
    if (!w.settings.globe) cmds.push({ op: 'set_planet', patch: { latShift: 12 } });
    for (const cmd of cmds) {
      e.exec(cmd);
      // 推导里的高程只多了湖底的修整（按洼地，不按气候）：与改之前逐值相同
      expect(digestWorld(e.world)['derived.elevation']).toBe(terrain);
    }
    expect(elevationMemo.computed).toBe(c0);
    expect(Array.from(e.world.derived.elevation)).toEqual(Array.from(before));
  });

  it(`重画一片不挪海平面：圈外的海陆、陆地高度不变：${label}`, () => {
    const e = seededEngine(settings, fresh(meshFor(settings)));
    e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    const w = e.world;
    const sea0 = ensureBase(w).seaLevel;
    const landness = w.causes.landness.slice();
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]);
    const c = land[Math.floor(land.length * 0.3)];
    const r = 0.1;
    e.exec({ op: 'reroll_region', x: w.mesh.x[c], y: w.mesh.y[c], radius: r, variant: 3 });
    expect(ensureBase(e.world).seaLevel).toBe(sea0);
    // 圈外（按地图坐标的距离；星球上用球面距离更远的格保险）每一格的 landness 逐值不变
    const far = (i: number) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) > 2.5 * r;
    let checked = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!far(i)) continue;
      expect(e.world.causes.landness[i]).toBe(landness[i]);
      checked++;
    }
    expect(checked).toBeGreaterThan(w.mesh.n / 2);
  });

  it(`大格局只在陆壳上：洋壳上的基准面、高原、洼地都是 0：${label}`, () => {
    const e = seededEngine(settings, fresh(meshFor(settings)));
    e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    const comp = ensureBase(e.world).components!;
    const rel = reliefFields(e.world)!;
    let ocean = 0;
    let plateau = 0;
    let pits = 0;
    for (let i = 0; i < e.world.mesh.n; i++) {
      // 深海（地壳高度在 −3000 m 以下）
      if (comp.seaB0[i] < -3000) {
        ocean++;
        expect(comp.T[i]).toBe(0);
        expect(comp.Tp[i]).toBe(0);
        expect(comp.pit[i]).toBe(0);
        expect(rel.T[i]).toBe(0);
      }
      if (comp.Tp[i] > 1000) plateau++;
      if (comp.pit[i] > 30) pits++;
    }
    expect(ocean).toBeGreaterThan(e.world.mesh.n / 4);
    // 有高原、有洼地
    expect(plateau).toBeGreaterThan(0);
    expect(pits).toBeGreaterThan(0);
  });
}

describe('迎风', () => {
  it('同一个网格、新建时纬度不同的两个地区不共用高程的记忆', () => {
    const mesh = meshFor({ cells: 3000, seed: 4 });
    const at = (latNorth: number, latSouth: number, memo: boolean) =>
      withMemo(memo, () => {
        const e = seededEngine({ cells: 3000, seed: 4, latNorth, latSouth }, mesh);
        e.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
        return digestWorld(e.world)['derived.elevation'];
      });
    const north = at(70, 30, true);
    const south = at(-10, -50, true);
    expect(at(70, 30, false)).toBe(north);
    expect(at(-10, -50, false)).toBe(south);
    // 迎风的一侧不同：结果也不同
    expect(south).not.toBe(north);
  });
});
