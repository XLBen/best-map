import { describe, expect, it } from 'vitest';
import { type GhostEdit, cellLayers, editGhost, ghostLayers } from '../src/render/colors';
import type { Command } from './commands';
import type { Engine } from './engine';
import { brushCells } from './select';
import { coastPatch, coastValueAt, coastValues, rasterizeWorld } from './subcell';
import {
  COAST_AMP,
  type ChainSpec,
  type IslandSpec,
  type TerrainPatch,
  chainIslands,
  coastNoiseField,
  coastSeed,
  combineStamps,
  islandStamp,
  landPatch,
  landStroke,
  previewTerrain,
  restoreStroke,
} from './terrain';
import { continents, engineFor, snapshot } from './testing/fixtures';
import type { World } from './world';

// 幽灵海岸：画陆地、放岛、岛链、恢复原样、调整里的地形滑块、重画这一片，松手前画出的海岸线就是结果。
// 海岸值与执行后的 coastValues 相同（补丁格差不到 1 mm，整份预览逐位相同），画出来的陆海与执行后的栅格一致

// 小星球（3000 格）：一个星球的几种情况都用它
const planet = () =>
  snapshot('ghost:planet', () => {
    const eng = engineFor({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    return eng;
  });
const WORLDS: [string, () => Engine][] = [
  ['一块地区', () => continents()],
  ['整个星球', planet],
];

const cellKm = (w: World) => w.mesh.spacing * w.kmPerUnit;

// 一格陆地，挨着海（不是湖）
function coastCell(w: World, from = 0.4): number {
  const { mesh, causes } = w;
  for (let k = 0; k < mesh.n; k++) {
    const i = (Math.floor(mesh.n * from) + k) % mesh.n;
    if (!causes.land[i] || w.derived.lake[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) return i;
  }
  throw new Error('没有海岸');
}

// 一格海，周围 5 格以内都是海（放岛用）
function seaCell(w: World, from = 0.3): number {
  const { mesh, causes } = w;
  for (let k = 0; k < mesh.n; k++) {
    const i = (Math.floor(mesh.n * from) + k) % mesh.n;
    if (causes.land[i] || mesh.boundary[i]) continue;
    if (brushCells(w, mesh.x[i], mesh.y[i], cellKm(w) * 5).cells.every((c) => !causes.land[c] && !mesh.boundary[c])) return i;
  }
  throw new Error('没有开阔的海');
}

// 一组改动：预览给的增量（与工具算的一样）和松手后执行的命令
interface Case {
  name: string;
  edit: (eng: Engine) => { ghost: GhostEdit; cmd: Command };
}

function brushAt(w: World, cell: number, rCells: number) {
  return brushCells(w, w.mesh.x[cell], w.mesh.y[cell], rCells * cellKm(w));
}

const paint = (mode: 'land' | 'sea'): Case => ({
  name: mode === 'land' ? '画陆地' : '画海',
  edit: (eng) => {
    const w = eng.world;
    const b = brushAt(w, coastCell(w), 3);
    const st = landStroke(w, b.cells, b.t, mode);
    return { ghost: { cells: st.cells, delta: st.delta }, cmd: { op: 'paint_land', cells: b.cells, t: b.t, mode } };
  },
});

const island = (kind: IslandSpec['kind']): Case => ({
  name: `放岛（${kind}）`,
  edit: (eng) => {
    const w = eng.world;
    const c = seaCell(w);
    const spec: IslandSpec = { x: w.mesh.x[c], y: w.mesh.y[c], kind, size: 2.5 * cellKm(w), variant: 1 };
    const st = islandStamp(w, spec);
    return { ghost: { cells: st.cells, delta: st.landDelta }, cmd: { op: 'add_island', island: spec } };
  },
});

const CASES: Case[] = [
  paint('land'),
  paint('sea'),
  ...(['continental', 'low', 'atoll', 'reef'] as const).map(island),
  {
    name: '恢复原样',
    edit: (eng) => {
      // 先画一笔陆地，再在同一处恢复（画笔中心收回、边上渐变）
      const w = eng.world;
      const at = coastCell(w);
      const b = brushAt(w, at, 3);
      eng.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode: 'land' });
      const r = brushAt(w, at, 2.5);
      const keep = r.cells.map((c) => w.causes.landDelta[c] !== 0);
      const cells = r.cells.filter((_, k) => keep[k]);
      const t = r.t.filter((_, k) => keep[k]);
      const st = restoreStroke(w, cells, t);
      return { ghost: { cells: st.cells, delta: st.delta }, cmd: { op: 'restore_terrain', cells, t } };
    },
  },
  {
    name: '岛链',
    edit: (eng) => {
      const w = eng.world;
      const c = seaCell(w);
      const sp = w.mesh.spacing;
      const chain: ChainSpec = { points: [[w.mesh.x[c] - 3 * sp, w.mesh.y[c] - sp], [w.mesh.x[c] + 3 * sp, w.mesh.y[c] + sp]], kind: 'continental', size: 1.2 * cellKm(w), density: 1, variant: 0 };
      const st = combineStamps(w, chainIslands(w, chain));
      return { ghost: { cells: st.cells, delta: st.landDelta }, cmd: { op: 'add_island_chain', chain } };
    },
  },
];

// coastValueAt 与抽出前的算式逐位相同见 shared-helpers.test.ts；这里看幽灵用的两条路：逐格的 coastPatch、整份的 coastValueAt
describe('什么都不改时，coastPatch 与 coastValues 逐位一致', () => {
  for (const [name, make] of WORLDS) {
    it(name, () => {
      const w = make().world;
      const s = coastValues(w);
      const all = Int32Array.from({ length: w.mesh.n }, (_, i) => i);
      const p = coastPatch(w, all, w.causes.landness, w.causes.land);
      const noise = coastNoiseField(w.mesh, coastSeed(w));
      const amp = COAST_AMP * w.small.terrain.coastRoughness;
      let bad = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        if (!Object.is(s[i], p[i])) bad++;
        if (!Object.is(s[i], Math.fround(coastValueAt(w.causes.landness[i], noise[i], amp, w.causes.land[i] === 1)))) bad++;
      }
      expect(bad).toBe(0);
    });
  }
});

describe('landPatch 的海岸值 = 执行后的 coastValues', () => {
  for (const [world, make] of WORLDS) {
    for (const c of CASES) {
      it(`${world}：${c.name}`, () => {
        const eng = make();
        const { ghost, cmd } = c.edit(eng);
        const w = eng.world;
        const before = coastValues(w);
        const landBefore = w.causes.land.slice();
        const lp = landPatch(w, ghost.cells, ghost.delta);
        const cp = coastPatch(w, lp.cells, lp.landness, lp.land);
        const after = eng.clone();
        after.exec(cmd);
        const wa = after.world;
        const sa = coastValues(wa);
        const inPatch = new Uint8Array(w.mesh.n);
        let worst = 0;
        let flips = 0;
        lp.cells.forEach((i, k) => {
          inPatch[i] = 1;
          expect(lp.land[k], `格 ${i} 的陆海`).toBe(wa.causes.land[i]);
          worst = Math.max(worst, Math.abs(cp[k] - sa[i]));
          if (lp.land[k] !== landBefore[i]) flips++;
        });
        expect(worst).toBeLessThan(1e-3);
        // 改动确实动了海岸
        expect(flips).toBeGreaterThan(0);
        // 补丁外的格一个都没变
        let outside = 0;
        for (let i = 0; i < w.mesh.n; i++) if (!inPatch[i] && (!Object.is(sa[i], before[i]) || wa.causes.land[i] !== landBefore[i])) outside++;
        expect(outside).toBe(0);
      });
    }
  }
});

describe('幽灵海岸与渲染一致', () => {
  const opts = { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false } as const;
  const picked = CASES.filter((c) => ['画陆地', '画海', '放岛（continental）', '放岛（reef）'].includes(c.name));
  for (const [world, make] of WORLDS) {
    for (const c of picked) {
      it(`${world}：${c.name}`, () => {
        const eng = make();
        const { ghost, cmd } = c.edit(eng);
        const w = eng.world;
        const { mesh } = w;
        // 屏幕上画的：底图的图层换上幽灵（海岸值，新陆地、新海的高程估计）
        const base = cellLayers(w, opts);
        const g = ghostLayers(w, base, editGhost(w, base, ghost), 'terrain');
        const isLake = (x: World, i: number) => x.causes.land[i] === 1 && x.derived.lake[i] === 1;
        // 幽灵当作一个世界栅格化（与屏幕、导出同一个规则）：改动后的 landness、陆海，高程用幽灵的估计
        const lp = landPatch(w, ghost.cells, ghost.delta);
        const landness = w.causes.landness.slice();
        const land = w.causes.land.slice();
        lp.cells.forEach((i, k) => {
          landness[i] = lp.landness[k];
          land[i] = lp.land[k];
        });
        const elevation = g.elevation.slice();
        for (let i = 0; i < mesh.n; i++) if (isLake(w, i)) elevation[i] = w.derived.elevation[i];
        const gw: World = { ...w, causes: { ...w.causes, landness, land }, derived: { ...w.derived, elevation } };
        // 交给着色器的海岸值就是这个世界的（湖面另画）
        const sg = coastValues(gw);
        let bad = 0;
        for (let i = 0; i < mesh.n; i++) if (!isLake(w, i) && !Object.is(g.coast[i], sg[i])) bad++;
        expect(bad).toBe(0);
        const after = eng.clone();
        after.exec(cmd);
        const wa = after.world;
        const W = 720;
        const H = Math.round((W * mesh.height) / mesh.width);
        const ra = rasterizeWorld(wa, W, H);
        const rg = rasterizeWorld(gw, W, H);
        const rb = rasterizeWorld(w, W, H);
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (const i of lp.cells) {
          x0 = Math.min(x0, mesh.x[i] - mesh.spacing);
          x1 = Math.max(x1, mesh.x[i] + mesh.spacing);
          y0 = Math.min(y0, mesh.y[i] - mesh.spacing);
          y1 = Math.max(y1, mesh.y[i] + mesh.spacing);
        }
        let total = 0;
        let agree = 0;
        let changed = 0;
        let changedAgree = 0;
        for (let py = 0; py < H; py++) {
          const y = ((py + 0.5) / H) * mesh.height;
          if (y < y0 || y > y1) continue;
          for (let px = 0; px < W; px++) {
            const x = ((px + 0.5) / W) * mesh.width;
            if (x < x0 || x > x1) continue;
            const p = py * W + px;
            // 湖在屏幕上是水面、在栅格里算陆地：不比
            if (isLake(w, ra.cell[p]) || isLake(wa, ra.cell[p])) continue;
            total++;
            if (rg.land[p] === ra.land[p]) agree++;
            if (rb.land[p] !== ra.land[p]) {
              changed++;
              if (rg.land[p] === ra.land[p]) changedAgree++;
            }
          }
        }
        expect(changed).toBeGreaterThan(0);
        expect(agree / total).toBeGreaterThanOrEqual(0.99);
        // 变了陆海的像素：幽灵画对的至少 97%（差的只是新陆地的高程估计让海岸细节的幅度略有不同）
        expect(changedAgree / changed).toBeGreaterThanOrEqual(0.97);
      });
    }
  }
});

describe('previewTerrain 的海岸值与执行后逐位一致', () => {
  const sliders: [string, (w: World) => { patch: TerrainPatch; cmd: Command }][] = [
    ['陆地多少', (w) => ({ patch: { landFraction: 0.45 }, cmd: { op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: 0.45 } } })],
    ['岛多少', (w) => ({ patch: { islands: 0.9 }, cmd: { op: 'set_worldgen', params: { ...w.small.terrain.gen!, islands: 0.9 } } })],
    ['海岸曲折', () => ({ patch: { rough: 1.6 }, cmd: { op: 'set_coast_style', roughness: 1.6 } })],
    [
      '重画这一片',
      (w) => {
        const c = coastCell(w, 0.55);
        const r = { x: w.mesh.x[c], y: w.mesh.y[c], radius: w.mesh.spacing * 4, variant: w.small.terrain.gen!.rerolls.length + 1 };
        return { patch: { reroll: r }, cmd: { op: 'reroll_region', ...r } };
      },
    ],
  ];
  for (const [world, make] of WORLDS) {
    for (const [name, build] of sliders) {
      it(`${world}：${name}`, () => {
        const eng = make();
        const w = eng.world;
        // 先手画一笔，确认用户的改动也算在里面
        const b = brushAt(w, coastCell(w, 0.2), 2);
        eng.exec({ op: 'paint_land', cells: b.cells, t: b.t, mode: 'land' });
        const { patch, cmd } = build(w);
        const landBefore = w.causes.land.slice();
        const p = previewTerrain(w, patch);
        const after = eng.clone();
        after.exec(cmd);
        const wa = after.world;
        const sa = coastValues(wa);
        let bad = 0;
        for (let i = 0; i < w.mesh.n; i++) if (!Object.is(p.coast[i], sa[i])) bad++;
        expect(bad).toBe(0);
        const gained: number[] = [];
        const lost: number[] = [];
        for (let i = 0; i < w.mesh.n; i++) {
          if (wa.causes.land[i] && !landBefore[i]) gained.push(i);
          if (!wa.causes.land[i] && landBefore[i]) lost.push(i);
        }
        expect(p.gained).toEqual(gained);
        expect(p.lost).toEqual(lost);
        // 预览不改动世界
        expect(Array.from(w.causes.land)).toEqual(Array.from(landBefore));
        if (name === '重画这一片') expect(p.gained.length + p.lost.length + p.relief.cells.length).toBeGreaterThan(0);
      });
    }
  }

  it('重画之后再画陆地：世界的缓存没被预览动过', () => {
    const eng = continents();
    const w = eng.world;
    const c = coastCell(w, 0.55);
    previewTerrain(w, { reroll: { x: w.mesh.x[c], y: w.mesh.y[c], radius: w.mesh.spacing * 4, variant: 1 } });
    const b = brushAt(w, coastCell(w, 0.2), 2);
    const cmd: Command = { op: 'paint_land', cells: b.cells, t: b.t, mode: 'land' };
    const fresh = continents();
    eng.exec(cmd);
    fresh.exec(cmd);
    expect(Array.from(coastValues(eng.world))).toEqual(Array.from(coastValues(fresh.world)));
  });
});
