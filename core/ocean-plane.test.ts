import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../tools/hash';
import { planeLayers } from './climate';
import { meshFor, seededEngine } from './testing/fixtures';
import { zonalBelt } from './ocean';
import { type PlaneOceanInputs, planeGrid, planeOcean, planeOceanCache, planeSea } from './ocean-plane';

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

// 第四十六轮续：缓存按像素上取到的输入认、每格的那一份的数组挤掉后再用：结果都与不用缓存现算的逐值相同
describe('区域的洋流：缓存与现算逐值相同', () => {
  const seaInputs = (land: Uint8Array) => {
    const b = basin();
    const n = b.mesh.n;
    const f = (v: ArrayLike<number>) => Float32Array.from(v);
    const seasons = [f(b.inp.wE!), f(b.inp.wS!), f(b.inp.wE!), f(b.inp.wS!)];
    return { mesh: b.mesh, n, inp: { ...b.inp, wE: undefined, wS: undefined, land, seasons, strength: 1 } };
  };
  const fresh = (mesh: Parameters<typeof planeSea>[0], inp: Parameters<typeof planeSea>[1]) => {
    planeOceanCache.on = false;
    try {
      return planeSea(mesh, inp);
    } finally {
      planeOceanCache.on = true;
    }
  };
  const same = (a: ReturnType<typeof planeSea>, b: ReturnType<typeof planeSea>) => {
    expect(Array.from(a.cellE)).toEqual(Array.from(b.cellE));
    expect(Array.from(a.cellS)).toEqual(Array.from(b.cellS));
    expect(Array.from(a.x[0])).toEqual(Array.from(b.x[0]));
    expect(Array.from(a.x[1])).toEqual(Array.from(b.x[1]));
  };

  it('改的格不在任何像素中心：栅格那份照用，每格的那一份跟着格的陆海变，与现算相同', () => {
    const base = basin().inp.land;
    const { mesh, inp } = seaInputs(base);
    const { cells } = planeGrid(mesh);
    const sampled = new Set(cells);
    const c = [...Array(mesh.n).keys()].find((i) => !sampled.has(i) && !base[i] && mesh.x[i] > 0.6 && mesh.x[i] < 1.4)!;
    expect(c).toBeGreaterThanOrEqual(0);
    const land2 = base.slice();
    land2[c] = 1;
    const oc1 = planeOcean(mesh, inp);
    const oc2 = planeOcean(mesh, { ...inp, land: land2 });
    expect(oc2).toBe(oc1);
    const v = planeSea(mesh, { ...inp, land: land2 });
    expect(v.cellE[c]).toBe(0);
    same(v, fresh(mesh, { ...inp, land: land2 }));
  });

  it('来回改海陆（数组挤掉后再用、撤销回到先前的海陆）：每一步都与现算相同', () => {
    const base = basin().inp.land;
    const { mesh, inp } = seaInputs(base);
    const lands = [0.5, 0.8, 1.1, 0.5, 1.4, 0.8].map((x0) => {
      const l = base.slice();
      for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.x[i] - x0, mesh.y[i] - 0.5) < 0.12) l[i] = 1;
      return l;
    });
    for (const land of lands) same(planeSea(mesh, { ...inp, land }), fresh(mesh, { ...inp, land }));
    // 洋流强弱不同是另一份
    same(planeSea(mesh, { ...inp, land: lands[0], strength: 0.5 }), fresh(mesh, { ...inp, land: lands[0], strength: 0.5 }));
  });
});

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
      expect(Array.from(fresh.cE)).toEqual(Array.from(b.oc.cE));
      expect(Array.from(fresh.dSST1)).toEqual(Array.from(b.oc.dSST1));
    } finally {
      planeOceanCache.on = true;
    }
    // 栅格：像素约 3 格宽、长边不超过 128
    const g = planeGrid(b.mesh);
    expect(Math.max(g.cols, g.rows)).toBeLessThanOrEqual(128);
  });
});

// 第四十五轮的代码上同样的世界（洋流强弱为 0）的哈希：tools/hash.ts 的 digest(digestWorld(世界))。
// 第五十一轮：来源的路径（small.origin）从 common 换成 medieval，重录；核对过 from 写回 common 时还是原来的 bcb87b61dc9df52a
// 第五十五轮：内置生态有了高度范围、多了两种，重录；核对过去掉高度范围时还是原来的 806db8ce0d15ee5c
// 第五十七轮：新世界默认带现实的水系（riverType、lakeType、地物的类型标签、小数据），毛皮多一种生态，重录；核对过去掉这些时还是原来的 42d3888d3cfd1fe8
// 第五十八轮：内置的地形类别写了典型高度（只差在小数据），重录；核对过去掉典型高度时还是原来的 11e0b5f3b200fb7f
// 第七十六轮：中文地名风格的模板“某某沙漠 / 冻原 / 冰原”改成“荒漠 / 苔原 / 冰盖”，重录变了的几项（地名、小数据里的地名风格、世界文件）；核对过两边的世界只差这三个字
const R45_CURRENTS0 = '70bea62f622ff23f';

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
