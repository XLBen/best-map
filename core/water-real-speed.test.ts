import { describe, expect, it } from 'vitest';
import { digest } from './digest';
import { Engine } from './engine';
import { lakeParts, lakeShores } from './lake-types';
import { MAP_UNDER_SHORE, drawTypes, packRivers, riverDraw, riverDrawDebug, riverDrawStats, unpackRivers, worldRivers } from './river-pack';
import { riverRibbon, traceRivers } from './rivers';
import { builtinPacks, worldPartsOf } from './packs/builtin-tree';
import { packImportCommands } from './packs/import';
import { continents, engineFor } from './testing/fixtures';
import { baseBiomes, waterCells } from './vegetation';
import { scriptDiffStats, scriptPassDebug } from './biome-scripts';
import type { World } from './world';
import { digestWorld } from '../tools/hash';

// 第五十七轮的提速：描河时带子不重算（一条线和上一次一模一样时）、一片片的湖不重走，新旧逐位相同。断流的尾巴收尖只在用了断流的世界里有

// 整份打包好的河的摘要（带子、类型都在里面）
function packedDigest(p: ReturnType<typeof worldRivers>): string[] {
  const r = p.rb!;
  return [p.meta, p.pts, p.flow, p.cells, p.mul, p.type, p.joins, r.count, r.x, r.y, r.s, r.nx, r.ny, r.hw, r.src, r.box, r.tag].map((a) => digest(a));
}

// 不走缓存重新描一遍（同一个世界）
function fresh(w: World): string[] {
  const thr = w.small.planet.riverThreshold;
  const types = drawTypes(w);
  const copy: World = { ...w, derived: { ...w.derived, elevation: w.derived.elevation.slice() } };
  const lines = traceRivers(copy);
  const draws = lines.map((l) => riverDraw(l, thr, w.mesh.spacing, types, 1, MAP_UNDER_SHORE));
  return packedDigest(packRivers(lines, draws, { thr, spacing: w.mesh.spacing, types: '' }));
}

describe('描河时带子不重算', () => {
  it('一串加工每一步都和不走缓存的逐位相同；改一笔时多数的线不用重算', () => {
    const eng = engineFor({ seed: 3, cells: 12000, latNorth: 60, latSouth: 10 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    const w = eng.world;
    expect(w.derived.riverType).toBeDefined();
    const land: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i]) land.push(i);
    const near = (c: number, r: number) => land.filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < r * w.mesh.spacing);
    const a = near(land[land.length >> 1], 5);
    const steps = [
      () => eng.exec({ op: 'paint', field: 'tempOffset', cells: a, values: a.map(() => -6), mode: 'add' }),
      () => eng.exec({ op: 'paint', field: 'moistOffset', cells: a, values: a.map(() => 0.5), mode: 'add' }),
      () => eng.exec({ op: 'paint_relief', cells: a, t: a.map(() => 0), strength: 0.7 }),
      () => eng.exec({ op: 'set_river_type', type: { ...w.small.riverTypes![0], width: 2 } }),
      () => eng.exec({ op: 'update_species', id: 'desert', patch: { plainRiver: false, waterBlock: 'stop' } }),
      () => eng.exec({ op: 'set_planet', patch: { riverThreshold: 200 } }),
      () => eng.undo(),
      () => eng.undo(),
      () => eng.undo(),
    ];
    worldRivers(w);
    for (const step of steps) {
      step();
      expect(packedDigest(worldRivers(w)), step.toString()).toEqual(fresh(w));
    }
    // 只改一小块时大多数的线碰不到
    worldRivers(w);
    riverDrawStats.hit = 0;
    riverDrawStats.miss = 0;
    const b = near(land[land.length >> 2], 4);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: b, values: b.map(() => 1), mode: 'add' });
    worldRivers(w);
    expect(riverDrawStats.hit).toBeGreaterThan(riverDrawStats.miss);
  }, 120000);

  it('关掉缓存和开着逐位相同', () => {
    const eng = engineFor({ seed: 5, cells: 8000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continent' }, reset: true });
    const w = eng.world;
    const cells: number[] = [];
    for (let i = 0; i < w.mesh.n && cells.length < 60; i++) if (w.causes.land[i]) cells.push(i);
    eng.exec({ op: 'paint', field: 'tempOffset', cells, values: cells.map(() => -2), mode: 'add' });
    const on = packedDigest(worldRivers(w));
    riverDrawDebug.memo = false;
    eng.exec({ op: 'paint', field: 'tempOffset', cells, values: cells.map(() => 2), mode: 'add' });
    const off = packedDigest(worldRivers(w));
    eng.undo();
    const back = packedDigest(worldRivers(w));
    riverDrawDebug.memo = true;
    expect(back).toEqual(on);
    expect(off).not.toEqual(on);
  }, 60000);
});

describe('一片片的湖不重走', () => {
  it('湖、陆地变了就跟着变：放湖、撤销、改海陆之后和从头重放的世界逐值相同', () => {
    const eng = continents();
    const w = eng.world;
    const land: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && !w.derived.lake[i]) land.push(i);
    const before = digest(w.derived.lakeType ?? new Uint8Array(0));
    const cell = land[land.length >> 1];
    eng.exec({ op: 'add_lake', lake: { cell, radius: 150, depth: 120, perennial: true } });
    const parts = lakeParts(w, w.derived);
    expect(lakeShores(w, parts).length).toBe(parts.lakes.length);
    expect(digest(w.derived.lakeType!)).toBe(digest(Engine.fromDoc(eng.toDoc()).world.derived.lakeType!));
    eng.undo();
    expect(digest(w.derived.lakeType ?? new Uint8Array(0))).toBe(before);
    expect(digestWorld(w)['derived.lakeType']).toBe(digestWorld(Engine.fromDoc(eng.toDoc()).world)['derived.lakeType']);
  }, 120000);
});

describe('不计水体类型的一遍植被只算河格和湖岸', () => {
  it('这些格上和全算逐值相同：现实库、奇幻库、涂过之后', () => {
    for (const lib of ['medieval', 'fantasy']) {
      for (const [settings, params] of [
        [{ seed: 3, cells: 12000 }, { seed: 3, type: 'continents' }],
        [{ seed: 2, cells: 12000, latNorth: 25, latSouth: -25 }, { seed: 2, type: 'fragmented' }],
      ] as const) {
        const eng = engineFor(settings, { bare: true });
        eng.exec({ op: 'batch', commands: [...packImportCommands(builtinPacks(), { packs: worldPartsOf(lib), groups: [] }), { op: 'set_worldgen', params, reset: true }] });
        const w = eng.world;
        const check = () => {
          const d = w.derived;
          const full = baseBiomes(w, d);
          const part = baseBiomes(w, d, true);
          const on = new Uint8Array(w.mesh.n);
          waterCells(w, d, on);
          let hit = 0;
          for (let i = 0; i < w.mesh.n; i++) {
            if (!on[i]) continue;
            hit++;
            expect(part[i], `${lib} ${i}`).toBe(full[i]);
          }
          expect(hit).toBeGreaterThan(50);
        };
        check();
        const land: number[] = [];
        for (let i = 0; i < w.mesh.n && land.length < 300; i += 7) if (w.causes.land[i]) land.push(i);
        eng.exec({ op: 'paint', field: 'tempOffset', cells: land, values: land.map(() => -5), mode: 'add' });
        check();
      }
    }
  }, 120000);

  it('整个世界和全算时逐值相同：有扩散范围的生态走全算，读河岸的奇幻生态、脚本出错也一样', () => {
    const eng = engineFor({ seed: 4, cells: 8000 }, { bare: true });
    eng.exec({ op: 'batch', commands: [...packImportCommands(builtinPacks(), { packs: worldPartsOf('fantasy'), groups: [] }), { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true }] });
    const replay = () => digestWorld(Engine.fromDoc(eng.toDoc()).world);
    expect(digestWorld(eng.world)).toEqual(replay());
    // 脚本在河外的格出错：整段作废（和全算一样，所以脚本总是所有的格都跑）
    const sp = eng.world.small.species.find((s) => s.id === 'taiga')!;
    eng.exec({ op: 'update_species', id: sp.id, patch: { scripts: { placement: { api: 1, src: 'if (x > 0.5) throw new Error("x"); return 1;' } } } });
    expect(eng.world.derived.scriptIssues?.length).toBeGreaterThan(0);
    expect(digestWorld(eng.world)).toEqual(replay());
    const a = baseBiomes(eng.world, eng.world.derived);
    const b = baseBiomes(eng.world, eng.world.derived, true);
    const on = new Uint8Array(eng.world.mesh.n);
    waterCells(eng.world, eng.world.derived, on);
    for (let i = 0; i < on.length; i++) if (on[i]) expect(b[i]).toBe(a[i]);
  }, 120000);
});

describe('同一遍里脚本比较快照的结果复用', () => {
  it('开着和关着逐位相同（奇幻库一串加工、脚本出错、撤销），比较的次数少了', () => {
    const run = (reuse: boolean) => {
      scriptPassDebug.reuse = reuse;
      scriptDiffStats.diffs = 0;
      // 新的网格：记录是空的，两边从同样的状态开始
      const eng = new Engine({ seed: 4, cells: 6000 });
      eng.exec({ op: 'batch', commands: [...packImportCommands(builtinPacks(), { packs: worldPartsOf('fantasy'), groups: [] }), { op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true }] });
      const w = eng.world;
      const land: number[] = [];
      for (let i = 0; i < w.mesh.n && land.length < 200; i += 3) if (w.causes.land[i]) land.push(i);
      const out: unknown[] = [digestWorld(w)];
      const step = (f: () => void) => {
        f();
        out.push(digestWorld(w), w.derived.scriptIssues ?? null);
      };
      step(() => eng.exec({ op: 'paint', field: 'tempOffset', cells: land, values: land.map(() => -3), mode: 'add' }));
      step(() => eng.exec({ op: 'paint', field: 'moistOffset', cells: land, values: land.map(() => 0.4), mode: 'add' }));
      step(() => eng.exec({ op: 'set_planet', patch: { humidity: 1.2 } }));
      step(() => eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(0, 30), species: 'crystal_jungle', mode: 'constraint', ratio: 1, radius: 300, label: '' } }));
      step(() => eng.exec({ op: 'update_species', id: 'taiga', patch: { scripts: { placement: { api: 1, src: 'if (x > 0.5) throw new Error("x"); return tMean > 0 ? 1 : 0.5;' } } } }));
      step(() => eng.exec({ op: 'paint', field: 'tempOffset', cells: land, values: land.map(() => 1), mode: 'add' }));
      step(() => eng.exec({ op: 'update_species', id: 'desert', patch: { plainRiver: false, waterBlock: 'stop' } }));
      step(() => eng.exec({ op: 'paint', field: 'moistOffset', cells: land, values: land.map(() => -0.4), mode: 'add' }));
      step(() => eng.undo());
      step(() => eng.undo());
      step(() => eng.undo());
      return { out, diffs: scriptDiffStats.diffs };
    };
    const on = run(true);
    const off = run(false);
    scriptPassDebug.reuse = true;
    expect(on.out).toEqual(off.out);
    expect(on.diffs).toBeLessThan(off.diffs);
  }, 180000);
});

describe('断流的尾巴收尖', () => {
  it('用了断流的世界里，河在没水的地方收尖；没用的世界里一条这样的线都没有', () => {
    const eng = continents();
    const w = eng.world;
    expect(traceRivers(w).some((l) => l.tail)).toBe(false);
    // 这几种生态断流，没有别的类型可换
    for (const t of [...w.small.riverTypes!]) eng.exec({ op: 'remove_river_type', id: t.id });
    const stopped = ['savanna', 'steppe', 'desert', 'shrubland'];
    for (const id of stopped) eng.exec({ op: 'update_species', id, patch: { plainRiver: false, waterBlock: 'stop' } });
    const lines = traceRivers(w);
    const tails = lines.filter((l) => l.tail);
    expect(tails.length).toBeGreaterThan(0);
    const sp = w.mesh.spacing;
    for (const l of tails) {
      expect(l.mouth).toBeUndefined();
      const rb = riverRibbon(l, w.small.planet.riverThreshold, sp);
      const plain = riverRibbon({ ...l, tail: undefined }, w.small.planet.riverThreshold, sp);
      const m = rb.hw.length;
      // 最后一点细到源头的尖那样，别的地方不会比不收尖时宽
      expect(rb.hw[m - 1]).toBeLessThan(0.2 * plain.hw[m - 1]);
      for (let i = 0; i < m; i++) expect(rb.hw[i]).toBeLessThanOrEqual(plain.hw[i]);
    }
    // 打包、拆开之后还在
    const un = unpackRivers(packRivers(lines)).lines;
    expect(un.filter((l) => l.tail).length).toBe(tails.length);
    // 撤销断流之后没有了
    for (let k = 0; k < stopped.length; k++) eng.undo();
    expect(traceRivers(w).some((l) => l.tail)).toBe(false);
  }, 120000);
});
