import { describe, expect, it } from 'vitest';
import { outlineStats, riftCoastMatch } from '../tools/realism';
import { type GenModel, type WorldType, buildModel, riftFrames, sampleComponents, withParams } from './generate';
import { type Mesh, type SphereMesh, buildMesh } from './mesh';
import { buildPlanetModel, samplePlanetComponents, withPlanetParams } from './planet-gen';
import { buildSphereMesh } from './sphere';
import { landShape } from './stats';
import { ensureBase, resolveTerrain } from './terrain';
import { type World, createWorld } from './world';

// 第三十五轮：大陆轮廓——裂开并漂移的大陆块、板块跟着碎块走、三角形的半岛、地峡（见 core/outline.ts）。
// 基线（02b7adf，同样的网格与种子，只做 resolveTerrain）：区域凸包亏缺 0.222、半岛指数 4.54%；星球 0.311、6.61%

const region = buildMesh(40000, 2, 1);
const thumb = buildMesh(4000, 2, 1);
let planetMesh: SphereMesh | null = null;
const globeMesh = () => (planetMesh ??= buildSphereMesh(62600, 1));

function world(mesh: Mesh, seed: number, extra: Record<string, number> = {}, type: WorldType = 'continents'): World {
  const settings = mesh.kind === 'sphere' ? { cells: mesh.n, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { cells: mesh.n, seed: 1 };
  const w = createWorld(settings, mesh);
  w.small.terrain.gen = { seed, type, mountains: 1, rerolls: [], ...extra };
  resolveTerrain(w);
  return w;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const SEEDS = [1, 2, 3, 4, 5, 6];

describe('大陆轮廓（6 个种子）', () => {
  it('区域：凸包亏缺 0.2–0.5 且高于基线，半岛指数上升，两岸还原漂移后平均距离 < 0.15·D，都有地峡', () => {
    const ws = SEEDS.map((s) => world(region, s));
    const shapes = ws.map((w) => landShape(w));
    const hull = mean(shapes.map((s) => s.hull));
    expect(hull).toBeGreaterThan(0.222);
    expect(hull).toBeGreaterThanOrEqual(0.2);
    expect(hull).toBeLessThanOrEqual(0.5);
    expect(mean(shapes.map((s) => s.peninsula))).toBeGreaterThan(0.0454);
    const match = ws.flatMap((w) => riftCoastMatch(w));
    expect(match.length).toBeGreaterThanOrEqual(6);
    expect(mean(match)).toBeLessThan(0.15);
    expect(mean(ws.map((w) => outlineStats(w).isthmus))).toBeGreaterThanOrEqual(0.4);
  });

  it('星球：同上', () => {
    const ws = SEEDS.map((s) => world(globeMesh(), s));
    const shapes = ws.map((w) => landShape(w));
    const hull = mean(shapes.map((s) => s.hull));
    expect(hull).toBeGreaterThan(0.311);
    expect(hull).toBeLessThanOrEqual(0.5);
    expect(mean(shapes.map((s) => s.peninsula))).toBeGreaterThan(0.0661);
    const match = ws.flatMap((w) => riftCoastMatch(w));
    expect(match.length).toBeGreaterThanOrEqual(4);
    expect(mean(match)).toBeLessThan(0.15);
    expect(mean(ws.map((w) => outlineStats(w).isthmus))).toBeGreaterThanOrEqual(0.4);
  }, 120_000);

  it('“几块大陆”至少四成的种子有地峡（模型里有、留下来的）', () => {
    let has = 0;
    for (let seed = 1; seed <= 20; seed++) if (buildModel({ seed, type: 'continents' }, 2, 1).isthmi.length) has++;
    expect(has / 20).toBeGreaterThanOrEqual(0.4);
    let hasP = 0;
    for (let seed = 1; seed <= 10; seed++) if (buildPlanetModel({ seed, type: 'continents' }).isthmi.length) hasP++;
    expect(hasP / 10).toBeGreaterThanOrEqual(0.4);
  });

  it('约四成的半岛是三角形；大块一半抽到裂开（开得了的约六成）', () => {
    let lobes = 0;
    let tri = 0;
    let big = 0;
    let rifts = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const m = buildModel({ seed, type: 'continents' }, 2, 1);
      const parents = m.famRift.length;
      for (const b of m.blocks.slice(parents)) {
        lobes++;
        if (b.tri > 0) tri++;
      }
      big += m.blocks.slice(0, parents).filter((b) => b.r >= 0.14).length;
      rifts += m.rifts.length;
    }
    expect(tri / lobes).toBeGreaterThan(0.3);
    expect(tri / lobes).toBeLessThan(0.5);
    // 一半的大块抽到裂开；开不开得了看会不会压到别的块（“几块大陆”的块挨得近，约六成开得了：30 个种子 0.28）
    expect(rifts / big).toBeGreaterThan(0.2);
    expect(rifts / big).toBeLessThanOrEqual(0.55);
  });
});

describe('板块跟着碎块走', () => {
  const check = (m: GenModel) => {
    expect(m.plates.filter((p) => p.sib >= 0).length).toBe(2 * m.rifts.length);
    m.plates.forEach((p, k) => p.sib >= 0 && expect(m.plates[p.sib].sib).toBe(k));
    for (const p of m.plates) {
      if (p.sib < 0) continue;
      const q = m.plates[p.sib];
      // 两半往两边走：相对速度沿两个重心的连线是分开的
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      expect((q.vx - p.vx) * dx + (q.vy - p.vy) * dy).toBeGreaterThan(0);
    }
  };
  it('区域：两半的重心各一个板块，往两边走；裂开的两半之间是洋中脊，两侧海底的年龄对称', () => {
    let sym = 0;
    for (const seed of SEEDS) {
      const m = buildModel({ seed, type: 'continents' }, 2, 1);
      check(m);
      if (!m.rifts.some((r) => !r.red && r.D >= 0.12)) continue;
      const w = world(region, seed);
      const comp = ensureBase(w).components!;
      const k = m.rifts.findIndex((r) => !r.red && r.D >= 0.12);
      // 缝里的格按漂移后离原来裂谷线的 u 分两边：同样远的海底一样深，脊上浅
      const bins = [[], [], [], []] as number[][];
      for (let i = 0; i < region.n; i++) {
        if (w.causes.land[i]) continue;
        for (const f of riftFrames(m, region.x[i], region.y[i])) {
          if (f[0] !== k || f[4] >= -0.02) continue;
          const u = f[6];
          if (Math.abs(u) < 0.01) bins[0].push(comp.sea[i]);
          else if (u > 0.02 && u < 0.05) bins[1].push(comp.sea[i]);
          else if (u < -0.02 && u > -0.05) bins[2].push(comp.sea[i]);
        }
      }
      if (bins[0].length < 5 || bins[1].length < 5 || bins[2].length < 5) continue;
      sym++;
      expect(Math.abs(mean(bins[1]) - mean(bins[2]))).toBeLessThan(250);
      expect(mean(bins[0])).toBeGreaterThan(Math.max(mean(bins[1]), mean(bins[2])) + 150);
    }
    expect(sym).toBeGreaterThan(0);
  });

  it('星球：两半绕同一个欧拉极往两边转', () => {
    for (const seed of SEEDS) {
      const m = buildPlanetModel({ seed, type: 'continents' });
      for (const p of m.plates) {
        if (p.sib < 0) continue;
        const q = m.plates[p.sib];
        // 角速度一正一反、绕同一根轴
        const dot = p.w[0] * q.w[0] + p.w[1] * q.w[1] + p.w[2] * q.w[2];
        const cos = dot / (Math.hypot(...p.w) * Math.hypot(...q.w));
        expect(cos).toBeCloseTo(-1, 6);
      }
      expect(m.plates.filter((p) => p.sib >= 0).length).toBe(2 * m.rifts.length);
    }
  });
});

describe('逐点、按种子：原有的不变量', () => {
  it('陆地比例调大时原来的陆地一格不少（有裂开、地峡的种子；区域与星球）', () => {
    for (const seed of [3, 4, 6]) {
      const lo = world(region, seed, { landFraction: 0.22 });
      const hi = world(region, seed, { landFraction: 0.32 });
      for (let i = 0; i < region.n; i++) if (lo.causes.land[i]) expect(hi.causes.land[i]).toBe(1);
    }
    const lo = world(globeMesh(), 5, { landFraction: 0.22 });
    const hi = world(globeMesh(), 5, { landFraction: 0.3 });
    for (let i = 0; i < globeMesh().n; i++) if (lo.causes.land[i]) expect(hi.causes.land[i]).toBe(1);
  });

  it('“岛多少”不挪动海岸', () => {
    for (const seed of SEEDS) {
      const few = world(region, seed, { islands: 0.1 });
      const many = world(region, seed, { islands: 0.9 });
      for (let i = 0; i < region.n; i++) if (few.causes.land[i]) expect(many.causes.land[i]).toBe(1);
    }
    const few = world(globeMesh(), 2, { islands: 0.1 });
    const many = world(globeMesh(), 2, { islands: 0.9 });
    for (let i = 0; i < globeMesh().n; i++) if (few.causes.land[i]) expect(many.causes.land[i]).toBe(1);
  });

  it('4000 格的缩略图与 4 万格的成品陆海一致 ≥ 90%', () => {
    for (const seed of SEEDS) {
      const a = world(region, seed);
      const b = world(thumb, seed);
      let agree = 0;
      let total = 0;
      for (let y = 0.01; y < 1; y += 0.02) {
        for (let x = 0.01; x < 2; x += 0.02) {
          total++;
          if (a.causes.land[region.delaunay.find(x, y)] === b.causes.land[thumb.delaunay.find(x, y)]) agree++;
        }
      }
      expect(agree / total).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('重新生成一片（圈在裂谷上、地峡上）：只重算圈里的格，与从头采样逐位相同', () => {
    for (const seed of [3, 4]) {
      const m0 = buildModel({ seed, type: 'continents' }, 2, 1);
      const base = sampleComponents(m0, region);
      const r = m0.rifts[m0.rifts.length - 1];
      const l = m0.isthmi[0];
      const rerolls = [
        { x: r.ox, y: r.oy, radius: 0.12, variant: 1 },
        ...(l ? [{ x: l.cx, y: l.cy, radius: 0.1, variant: 2 }] : []),
      ];
      const m1 = withParams(m0, { seed, type: 'continents', rerolls });
      const part = sampleComponents(m1, region, { from: base, changed: rerolls });
      const full = sampleComponents(m1, region);
      for (const key of ['b0', 'mountU', 'hillU', 'T', 'pit', 'sea'] as const) {
        for (let i = 0; i < region.n; i++) expect(Object.is(part[key][i], full[key][i])).toBe(true);
      }
      for (let i = 0; i < region.n; i++) {
        if (rerolls.every((q) => Math.hypot(region.x[i] - q.x, region.y[i] - q.y) >= q.radius)) expect(part.b0[i]).toBe(base.b0[i]);
      }
    }
    const mp = buildPlanetModel({ seed: 5, type: 'continents' });
    const g = globeMesh();
    const base = samplePlanetComponents(mp, g);
    const rerolls = [{ x: 1.2, y: 0.4, radius: 0.08, variant: 1 }];
    const mp1 = withPlanetParams(mp, { seed: 5, type: 'continents', rerolls });
    const part = samplePlanetComponents(mp1, g, { from: base, changed: rerolls });
    const full = samplePlanetComponents(mp1, g);
    for (let i = 0; i < g.n; i++) expect(Object.is(part.b0[i], full.b0[i])).toBe(true);
  });
});
