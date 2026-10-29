import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld, hashArray } from '../tools/hash';
import type { Command } from './commands';
import { Engine } from './engine';
import { exportPackage, featuresCsv } from './export';
import { renderThumbnail } from './thumbnail';
import type { WorldType } from './generate';
import type { SphereMesh } from './mesh';
import { buildSphereMesh, nearestCell } from './sphere';
import { islandStamp, previewLand, resolveTerrain } from './terrain';
import { type World, createWorld } from './world';
import { seededEngine } from './testing/fixtures';

// 整个星球的生成：缩略图与成品一致、接缝和高纬度没有变形、全是陆地也能算、重放逐值一致

const globe = (cells: number) => ({ cells, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
const meshes = new Map<number, SphereMesh>();
const meshOf = (cells: number) => {
  let m = meshes.get(cells);
  if (!m) meshes.set(cells, (m = buildSphereMesh(cells, 1)));
  return m;
};

function planet(cells: number, type: WorldType, seed: number): World {
  const w = createWorld(globe(cells), meshOf(cells));
  w.small.terrain.gen = { seed, type, mountains: 1, rerolls: [] };
  resolveTerrain(w);
  return w;
}

// 斐波那契点阵：均匀铺满球面的采样点（显示坐标）
function samples(count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const z = 1 - (2 * k + 1) / count;
    const lon = (k * Math.PI * (3 - Math.sqrt(5))) % (2 * Math.PI);
    out.push([lon / Math.PI, Math.acos(z) / Math.PI]);
  }
  return out;
}

describe('生成整个星球', () => {
  it('4 千格的缩略图与 4 万格的成品陆海一致（≥ 90%）', () => {
    const pts = samples(5000);
    for (const type of ['continents', 'continent', 'archipelago', 'fragmented'] as WorldType[]) {
      for (const seed of [1, 2]) {
        const small = planet(4000, type, seed);
        const big = planet(40000, type, seed);
        let agree = 0;
        let hs = -1;
        let hb = -1;
        for (const [x, y] of pts) {
          hs = nearestCell(small.mesh as SphereMesh, x, y, hs);
          hb = nearestCell(big.mesh as SphereMesh, x, y, hb);
          if (small.causes.land[hs] === big.causes.land[hb]) agree++;
        }
        expect(agree / pts.length, `${type} 种子 ${seed}`).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it('接缝上没有断口：跨经度 180° 的相邻格，地势差与跨经度 0° 的相当', () => {
    let seam = 0;
    let seamN = 0;
    let mid = 0;
    let midN = 0;
    for (const seed of [1, 2, 3, 4]) {
      const w = planet(40000, 'continents', seed);
      const { mesh } = w;
      for (let i = 0; i < mesh.n; i++) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          const d = Math.abs(w.causes.landness[i] - w.causes.landness[j]);
          if (Math.abs(mesh.x[i] - mesh.x[j]) > 1) {
            seam += d;
            seamN++;
          } else if ((mesh.x[i] - 1) * (mesh.x[j] - 1) < 0) {
            mid += d;
            midN++;
          }
        }
      }
    }
    const ratio = seam / seamN / (mid / midN);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);
  });

  it('同一个岛放在接缝上、赤道中间、高纬度，大小一样', () => {
    const w = planet(40000, 'ocean', 1);
    const areaOf = (x: number, y: number) => {
      const s = islandStamp(w, { x, y, kind: 'continental', size: 600, variant: 3 });
      const p = previewLand(w, s.cells, s.landDelta);
      let a = 0;
      for (const c of p.gained) a += w.mesh.area[c] * w.kmPerUnit * w.kmPerUnit;
      return { a, cells: p.gained };
    };
    const center = areaOf(1.0, 0.45);
    const seam = areaOf(1.9995, 0.45);
    const high = areaOf(0.6, 0.08);
    expect(Math.abs(seam.a - center.a) / center.a).toBeLessThan(0.08);
    expect(Math.abs(high.a - center.a) / center.a).toBeLessThan(0.15);
    // 接缝上的岛是一整块（格跨过 x = 0 / 2 也连在一起）
    const set = new Set(seam.cells);
    const seen = new Set([seam.cells[0]]);
    const q = [seam.cells[0]];
    for (let h = 0; h < q.length; h++) {
      for (let e = w.mesh.off[q[h]]; e < w.mesh.off[q[h] + 1]; e++) {
        const j = w.mesh.adj[e];
        if (set.has(j) && !seen.has(j)) {
          seen.add(j);
          q.push(j);
        }
      }
    }
    expect(seen.size).toBe(set.size);
    expect(seam.cells.some((c) => w.mesh.x[c] < 0.5)).toBe(true);
    expect(seam.cells.some((c) => w.mesh.x[c] > 1.5)).toBe(true);
  });

  it('全是陆地的星球也能算完（没有海可流时最低处是终点），没有 NaN', () => {
    const eng = seededEngine(globe(4000));
    const all = [...Array(eng.world.mesh.n).keys()];
    eng.exec({ op: 'paint_land', cells: all, t: all.map(() => 0), mode: 'land' });
    const d = eng.world.derived;
    expect(eng.world.causes.land.every((v) => v === 1)).toBe(true);
    for (const k of ['elevation', 'tMean', 'precip', 'discharge', 'moisture'] as const) {
      for (let i = 0; i < d[k].length; i++) expect(Number.isFinite(d[k][i]), k).toBe(true);
    }
    expect(Math.max(...d.elevation)).toBeLessThan(9000);
  });

  it('像地球的星球：识别出几块大陆；存档重放逐值一致', () => {
    const eng = seededEngine(globe(20000));
    eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'continents' }, reset: true });
    eng.exec({ op: 'add_island', island: { x: 1.9995, y: 0.4, kind: 'continental', size: 500, variant: 1 } });
    const w = eng.world;
    const continents = w.derived.features.filter((f) => f.type === 'continent');
    expect(continents.length).toBeGreaterThanOrEqual(3);
    // 标注落在大陆上（跨接缝的也一样；个别弯曲的大陆质心可能落在海湾里）
    const onLand = continents.filter((f) => w.causes.land[nearestCell(w.mesh as SphereMesh, f.x, f.y)] === 1).length;
    expect(onLand / continents.length).toBeGreaterThanOrEqual(0.66);
    expect(continents.every((f) => f.x >= 0 && f.x < 2)).toBe(true);
    const doc = eng.toDoc();
    expect(doc.version).toBe(6);
    const replay = Engine.fromDoc(doc, w.mesh);
    for (const k of ['elevation', 'tMean', 'precip', 'discharge'] as const) expect(hashArray(replay.world.derived[k])).toBe(hashArray(w.derived[k]));
    expect(replay.world.derived.features.map((f) => f.name)).toEqual(w.derived.features.map((f) => f.name));
  });

  it('缩略图、导出：左右两边接得上；地名表里是真实的经纬度', () => {
    const eng = seededEngine(globe(8000));
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const W = 240;
    const H = 120;
    const img = renderThumbnail(eng.world, W, H);
    // 第 0 列与第 W−1 列在星球上是相邻的：两列的差别与图中间相邻两列的差别相当
    const diff = (c0: number, c1: number) => {
      let d = 0;
      for (let y = 0; y < H; y++) for (let k = 0; k < 3; k++) d += Math.abs(img[(y * W + c0) * 4 + k] - img[(y * W + c1) * 4 + k]);
      return d / H;
    };
    let inner = 0;
    for (let c = 10; c < W - 10; c += 10) inner += diff(c, c + 1);
    inner /= Math.floor((W - 20) / 10);
    expect(diff(W - 1, 0)).toBeLessThan(inner * 2.5);
    // 地名表：经度在 −180 到 180，纬度在 −90 到 90
    const rows = featuresCsv(eng.world, 2048, 1024).trim().split('\n').slice(1);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      const cols = r.split(',');
      const lat = Number(cols[cols.length - 3]);
      const lon = Number(cols[cols.length - 2]);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThan(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    }
    const pkg = exportPackage(eng.world, eng.toDoc(), { width: 512, height: 256, seaLevelGray: 95, maxElevation: 8000 });
    expect(pkg.zip.length).toBeGreaterThan(1000);
    expect(pkg.files).toContain('features.csv');
  });

  it('副本共用生成器的结果：在副本上画陆地、重画一片（跨接缝），与新世界上执行逐值相同', () => {
    const make = () => {
      const eng = seededEngine(globe(3000), meshOf(3000));
      eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
      return eng;
    };
    const a = make();
    const cells = coastalStroke(a.world, 0.3, 4);
    const cmds: Command[] = [
      { op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' },
      { op: 'reroll_region', x: 1.98, y: 0.45, radius: 0.12, variant: 1 },
    ];
    const before = digestWorld(a.world);
    for (const cmd of cmds) {
      const copy = a.clone();
      copy.exec(cmd);
      const fresh = make();
      fresh.exec(cmd);
      expect(digestWorld(copy.world), cmd.op).toEqual(digestWorld(fresh.world));
    }
    expect(digestWorld(a.world)).toEqual(before);
  });

  it('先预览再执行 = 直接执行（采用预览），撤销后回到原样：整体冷暖、冷暖画笔、画陆地', () => {
    const make = () => {
      const eng = seededEngine(globe(3000), meshOf(3000));
      eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
      return eng;
    };
    const w0 = make().world;
    const land = [...Array(w0.mesh.n).keys()].filter((i) => w0.causes.land[i]).slice(0, 120);
    const coast = coastalStroke(w0, 0.3, 4);
    const cmds: Command[] = [
      { op: 'set_planet', patch: { solar: 0.92 } },
      { op: 'paint', field: 'tempOffset', cells: land, values: land.map(() => -4), mode: 'add' },
      { op: 'paint_land', cells: coast, t: coast.map(() => 0), mode: 'land' },
    ];
    for (const cmd of cmds) {
      const a = make();
      const b = make();
      const before = digestWorld(a.world);
      a.preview(cmd);
      const previewed = (a as unknown as { lastPreview: { copy: Engine } }).lastPreview.copy.world.derived;
      a.exec(cmd);
      expect(a.world.derived, cmd.op).toBe(previewed);
      b.exec(cmd);
      expect(digestWorld(a.world), cmd.op).toEqual(digestWorld(b.world));
      a.undo();
      expect(digestWorld(a.world), cmd.op).toEqual(before);
    }
  });
});
