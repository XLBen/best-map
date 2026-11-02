import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../tools/hash';
import { planeLayers } from './climate';
import { meshFor, seededEngine } from './testing/fixtures';
import { zonalBelt } from './ocean';
import { type PlaneOceanInputs, planeGrid, planeOcean, planeOceanCache } from './ocean-plane';

// 区域地图的洋流（第四十六轮，ocean-plane.ts）

// 一个长方形的大洋：东西两边各一块大陆（地图左右 15% 是陆地），北纬 50° 到 10°，图外不是海
function basin(rotation: 1 | -1 = 1, north = 50, south = 10) {
  const mesh = meshFor({ seed: 7, cells: 8000, aspect: 2 });
  const n = mesh.n;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = mesh.x[i] < 0.3 || mesh.x[i] > 1.7 ? 1 : 0;
  const latAt = (y: number) => north + (south - north) * y;
  const tAnn = new Float64Array(n);
  const wE = new Float64Array(n);
  const wS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lat = latAt(mesh.y[i]);
    tAnn[i] = 28 - 0.5 * Math.abs(lat);
    wE[i] = zonalBelt(lat, 23.4, rotation);
  }
  const inp: PlaneOceanInputs = { land, latAt, tAnn, wE, wS, tilt: 23.4, rotation, outsideOcean: false, kmPerUnit: Math.abs(north - south) * 111.2 };
  return { mesh, inp, oc: planeOcean(mesh, inp) };
}

// 某一行（纬度）海上像素的南北分量：西侧（大洋西边 400 km 以内）与东侧最强的一处
function rowFlow(b: ReturnType<typeof basin>, lat: number) {
  const { grid, cS, cE, landPx } = b.oc;
  const r = Math.round(((b.inp.latAt(0) - lat) / (b.inp.latAt(0) - b.inp.latAt(1))) * grid.rows - 0.5);
  const sea: number[] = [];
  for (let c = 0; c < grid.cols; c++) if (!landPx[r * grid.cols + c]) sea.push(c);
  const pxKm = grid.pw * b.inp.kmPerUnit;
  const band = Math.max(2, Math.round(400 / pxKm));
  const west = sea.slice(0, band).map((c) => cS[r * grid.cols + c]);
  const east = sea.slice(-band).map((c) => cS[r * grid.cols + c]);
  const mid = sea.slice(band, -band).map((c) => cS[r * grid.cols + c]);
  const zonal = sea.map((c) => cE[r * grid.cols + c]);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return { west, east, mid, meanE: mean(zonal), meanMid: mean(mid) };
}

describe('区域的洋流：方向', () => {
  it('北半球的副热带环流顺时针：西侧向北的边界流又窄又强，东侧与大洋中间向南；北边向东、南边向西', () => {
    const b = basin();
    const f = rowFlow(b, 30);
    // y 朝南：向北是负的南分量
    const westMax = Math.max(...f.west.map((v) => -v));
    const eastMax = Math.max(...f.east.map((v) => v));
    expect(westMax).toBeGreaterThan(0.3);
    expect(westMax).toBeGreaterThan(2 * eastMax);
    expect(f.meanMid).toBeGreaterThan(0);
    expect(Math.max(...f.east)).toBeGreaterThan(0);
    // 西风带下向东，信风带下向西
    expect(rowFlow(b, 42).meanE).toBeGreaterThan(0);
    expect(rowFlow(b, 15).meanE).toBeLessThan(0);
  });

  it('反向自转：环流反过来（边界流挤在东侧、向北）', () => {
    const b = basin(-1);
    const f = rowFlow(b, 30);
    const eastMax = Math.max(...f.east.map((v) => -v));
    const westMax = Math.max(...f.west.map((v) => Math.abs(v)));
    expect(eastMax).toBeGreaterThan(0.3);
    expect(eastMax).toBeGreaterThan(2 * westMax);
  });

  it('西侧的暖流比东侧的海暖（同一纬度）；东侧近岸上涌偏冷', () => {
    const b = basin();
    const { grid, dSST1, landPx } = b.oc;
    const r = Math.round(grid.rows * 0.4);
    const sea: number[] = [];
    for (let c = 0; c < grid.cols; c++) if (!landPx[r * grid.cols + c]) sea.push(dSST1[r * grid.cols + c]);
    const k = Math.max(2, Math.round(sea.length * 0.08));
    const west = sea.slice(0, k).reduce((a, x) => a + x, 0) / k;
    const east = sea.slice(-k).reduce((a, x) => a + x, 0) / k;
    expect(west).toBeGreaterThan(east + 1);
    expect(east).toBeLessThan(0);
  });

  it('海上那部分按海陆缓存：同样的输入给同一份；关掉缓存现算逐值相同', () => {
    const b = basin();
    expect(planeOcean(b.mesh, b.inp)).toBe(b.oc);
    planeOceanCache.on = false;
    try {
      const fresh = planeOcean(b.mesh, b.inp);
      expect(fresh).not.toBe(b.oc);
      expect(Array.from(fresh.cellE)).toEqual(Array.from(b.oc.cellE));
      expect(Array.from(fresh.cellD)).toEqual(Array.from(b.oc.cellD));
    } finally {
      planeOceanCache.on = true;
    }
    // 栅格：像素约 2 格宽、长边不超过 200
    const g = planeGrid(b.mesh);
    expect(Math.max(g.cols, g.rows)).toBeLessThanOrEqual(200);
  });
});

// 第四十五轮的代码上同样的世界（洋流强弱为 0）的哈希：tools/hash.ts 的 digest(digestWorld(世界))
const R45_CURRENTS0 = 'bcb87b61dc9df52a';

describe('区域的洋流进了气候', () => {
  const settings = { seed: 3, cells: 6000 };
  const make = (currents: number) => {
    const e = seededEngine(settings, meshFor(settings));
    // 先定强弱再生成（地名按变了的格修补：先有洋流再关掉时地名与一开始就没有的不同）
    if (currents !== 1) e.exec({ op: 'set_planet', patch: { currents } });
    e.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    return e;
  };

  it('有海流、有冷暖；强弱为 0 时海流、偏离全是 0，气候与没有洋流的算法相同', () => {
    const e = make(1);
    const d = e.world.derived;
    let moving = 0;
    let warm = 0;
    let cold = 0;
    for (let i = 0; i < e.world.mesh.n; i++) {
      if (e.world.causes.land[i]) continue;
      if (Math.hypot(d.currentX[i], d.currentY[i]) > 0.1) moving++;
      if (d.sstAnom[i] > 0.7) warm++;
      if (d.sstAnom[i] < -0.7) cold++;
    }
    expect(moving).toBeGreaterThan(100);
    expect(warm).toBeGreaterThan(20);
    expect(cold).toBeGreaterThan(20);
    const z = make(0);
    expect(z.world.derived.currentX.every((v) => v === 0)).toBe(true);
    expect(z.world.derived.sstAnom.every((v) => v === 0)).toBe(true);
    expect(e.world.derived.tS.some((v, i) => v !== z.world.derived.tS[i])).toBe(true);
    // 强弱为 0：整个世界与第四十五轮（899d2fb，还没有区域的洋流）逐值相同
    expect(digest(digestWorld(z.world))).toBe(R45_CURRENTS0);
  });

  it('分层缓存开着与关着逐值相同', () => {
    const e = make(1);
    const h = digestWorld(e.world);
    planeLayers.on = false;
    planeOceanCache.on = false;
    try {
      expect(digestWorld(make(1).world)).toEqual(h);
    } finally {
      planeLayers.on = true;
      planeOceanCache.on = true;
    }
  });
});
