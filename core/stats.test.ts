import { describe, expect, it } from 'vitest';
import {
  type Basin,
  type StatsInput,
  boxCountDimension,
  coastPixels,
  components,
  drainage,
  endorheicShare,
  exceedanceExponent,
  hackExponent,
  hypsometry,
  linearFit,
  median,
  plateauShare,
  realismStats,
  sizePowerLaw,
} from './stats';

// 第三十一轮：和地球比的统计（core/stats.ts）在手搭的小网上的结果。整个世界的报告是 tools/realism-report.ts，不在这里跑

// W × H 的方格网，四邻相连，每格 1 km²、相邻 1 km；陆地按 land(x, y)，下游按 down(x, y)（返回格号或 -1）
function grid(W: number, H: number, land: (x: number, y: number) => boolean, down: (x: number, y: number) => number = () => -1): StatsInput {
  const n = W * H;
  const off = new Int32Array(n + 1);
  const adj: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      off[i] = adj.length;
      if (x > 0) adj.push(i - 1);
      if (x < W - 1) adj.push(i + 1);
      if (y > 0) adj.push(i - W);
      if (y < H - 1) adj.push(i + W);
    }
  }
  off[n] = adj.length;
  const s: StatsInput = {
    n,
    land: new Uint8Array(n),
    edge: new Uint8Array(n),
    elevation: new Float64Array(n),
    receiver: new Int32Array(n).fill(-1),
    stepKm: new Float64Array(n),
    areaKm: new Float64Array(n).fill(1),
    lake: new Uint8Array(n),
    off,
    adj: Int32Array.from(adj),
    distKm: new Float64Array(adj.length).fill(1),
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      s.land[i] = land(x, y) ? 1 : 0;
      if (s.land[i]) {
        s.receiver[i] = down(x, y);
        if (s.receiver[i] >= 0) s.stepKm[i] = 1;
      }
    }
  }
  return s;
}

describe('stats：拟合', () => {
  it('直线的最小二乘', () => {
    const f = linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(f.slope).toBeCloseTo(2, 12);
    expect(f.intercept).toBeCloseTo(1, 12);
    expect(f.r2).toBeCloseTo(1, 12);
    expect(linearFit([1], [1]).slope).toBeNaN();
  });

  it('超越概率指数：按分位数取的帕累托分布', () => {
    for (const tau of [0.45, 1]) {
      const N = 20000;
      const v = Array.from({ length: N }, (_, k) => Math.pow((k + 0.5) / N, -1 / tau));
      expect(exceedanceExponent(v, 2, 500)).toBeCloseTo(tau, 2);
    }
    expect(exceedanceExponent([], 1, 10)).toBeNaN();
  });

  it('大小的幂律：N(>A) ∝ 1/A 时 k ≈ 1', () => {
    const sizes = Array.from({ length: 60 }, (_, k) => 6000 / (k + 1));
    expect(sizePowerLaw(sizes)).toBeCloseTo(1, 1);
    expect(sizePowerLaw([5, 4, 3])).toBeNaN();
  });

  it('Hack 律：L = 2·A^0.55 的流域拟合出 0.55，太小的不算', () => {
    const basins: Basin[] = [10, 30, 100, 300, 1000, 3000].map((a, k) => ({ outlet: k, areaKm: a, lengthKm: 2 * Math.pow(a, 0.55), source: k }));
    basins.push({ outlet: 9, areaKm: 1, lengthKm: 50, source: 9 });
    expect(hackExponent(basins, 5)).toBeCloseTo(0.55, 10);
    expect(hackExponent(basins.slice(0, 4), 5)).toBeNaN();
  });

  it('中位数', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('stats：海岸线的盒维数', () => {
  it('直线约 1，填满的一片约 2', () => {
    const W = 256;
    const line = new Uint8Array(W * W);
    for (let x = 0; x < W; x++) line[100 * W + x] = 1;
    expect(boxCountDimension(line, W, W)).toBeCloseTo(1, 1);
    const full = new Uint8Array(W * W).fill(1);
    expect(boxCountDimension(full, W, W)).toBeCloseTo(2, 1);
    // 只数一部分行：那条线不在里面时没有点
    expect(boxCountDimension(line, W, W, [2, 4, 8], [0, 50])).toBeNaN();
  });

  it('海岸像素：方块的边，绕回时左右相接', () => {
    const W = 20;
    const H = 10;
    const land = new Uint8Array(W * H);
    for (let y = 2; y < 8; y++) for (let x = 5; x < 15; x++) land[y * W + x] = 1;
    const c = coastPixels(land, W, H);
    expect(c.reduce((a, b) => a + b, 0)).toBe(2 * 10 + 2 * 6 - 4);
    // 一整行陆地：不绕回时两端也是海岸以外的（地图外不算海），绕回时只有上下两边
    const band = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) for (let y = 3; y < 6; y++) band[y * W + x] = 1;
    expect(coastPixels(band, W, H, true).reduce((a, b) => a + b, 0)).toBe(2 * W);
  });
});

describe('stats：流域、内流区、高度分布', () => {
  it('一条链：流域面积、最长流路、汇水面积', () => {
    // 1 × 6 的陆地，都往左流，最左一格是出口
    const s = grid(6, 1, () => true, (x) => (x > 0 ? x - 1 : -1));
    const d = drainage(s);
    expect(d.basins).toHaveLength(1);
    expect(d.basins[0]).toEqual({ outlet: 0, areaKm: 6, lengthKm: 5, source: 5 });
    expect(Array.from(d.drainKm)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(Array.from(d.outlet)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('两个流域按面积排，海不算', () => {
    // 一行 7 格：0–3 往左流到 0，4 是海，5、6 往右流到 6
    const s = grid(7, 1, (x) => x !== 4, (x) => (x >= 1 && x <= 3 ? x - 1 : x === 5 ? 6 : -1));
    const d = drainage(s);
    expect(d.landKm).toBe(6);
    expect(d.basins.map((b) => [b.outlet, b.areaKm, b.lengthKm])).toEqual([
      [0, 4, 3],
      [6, 2, 1],
    ]);
    expect(d.outlet[4]).toBe(-1);
  });

  it('内流区：流进有干湖底的洼地的、终点在陆地中间的算；流出地图边、流进海的不算', () => {
    // 5 × 3 全是陆地（第 0 行左边一格是海）：
    //   第 1 行往右流进 (4,1)，(3,1)、(4,1) 是一片洼地，(4,1) 是干湖底 → 第 1 行 5 格内流
    //   第 2 行往左流到 (0,2)，它在地图边上 → 不算
    //   第 0 行往左流到 (1,0)，它挨着海 (0,0) → 不算
    const W = 5;
    const s = grid(W, 3, (x, y) => !(x === 0 && y === 0), (x, y) => (y === 1 ? (x < 4 ? y * W + x + 1 : -1) : y === 2 ? (x > 0 ? y * W + x - 1 : -1) : x > 1 ? x - 1 : -1));
    s.lake[1 * W + 3] = 1;
    s.lake[1 * W + 4] = 2;
    s.edge[2 * W + 0] = 1;
    const d = drainage(s);
    expect(endorheicShare(s, d)).toBeCloseTo(5 / 14, 12);
    // 没有干湖底（湖满了，水从出口流走）：(4,1) 终点在陆地中间、不在边上 → 照样内流
    s.lake[1 * W + 4] = 1;
    expect(endorheicShare(s, d)).toBeCloseTo(5 / 14, 12);
    // 它在地图边上：水流出地图，不算
    s.edge[1 * W + 4] = 1;
    expect(endorheicShare(s, d)).toBe(0);
  });

  it('高度分布按面积；高原要高、要平', () => {
    const s = grid(4, 1, () => true);
    s.elevation.set([100, 300, 2600, 2700]);
    s.areaKm.set([1, 1, 1, 3]);
    const h = hypsometry(s);
    expect(h.below200).toBeCloseTo(1 / 6, 12);
    expect(h.below500).toBeCloseTo(2 / 6, 12);
    expect(h.above2000).toBeCloseTo(4 / 6, 12);
    expect(h.meanM).toBeCloseTo((100 + 300 + 2600 + 3 * 2700) / 6, 9);
    // 相邻 1 km：2600 与 2700 差 100 m → 每 100 km 一万米，太陡
    expect(plateauShare(s, 6)).toBe(0);
    s.distKm.fill(100);
    // 每 100 km 差 100 m 的两格才算（2600 挨着 300 的那一边太陡）
    expect(plateauShare(s, 6)).toBeCloseTo(3 / 6, 12);
  });

  it('连通块', () => {
    const s = grid(5, 1, (x) => x !== 2);
    expect(components(s, (i) => s.land[i] === 1)).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('一组统计合起来：一个方形的岛', () => {
    // 9 × 9，外圈是海，里面的格都往左流，最左一列流进海
    const W = 9;
    const s = grid(W, W, (x, y) => x > 0 && y > 0 && x < W - 1 && y < W - 1, (x, y) => (x > 1 ? y * W + x - 1 : -1));
    for (let i = 0; i < s.n; i++) s.elevation[i] = s.land[i] ? 50 * (i % W) : -100;
    const r = realismStats(s, 1.1);
    expect(r.landShare).toBeCloseTo(49 / 81, 12);
    expect(r.basinTop1).toBeCloseTo(7 / 49, 12);
    expect(r.basinTop5).toBeCloseTo(35 / 49, 12);
    expect(r.longestKm).toBe(6);
    expect(r.longestPerDiameter).toBeCloseTo(6 / (2 * Math.sqrt(49 / Math.PI)), 12);
    expect(r.lOverSqrtA).toBeCloseTo(6 / Math.sqrt(7), 12);
    expect(r.endorheic).toBe(0);
    expect(r.lakes).toBe(0);
    expect(r.below200).toBeCloseTo(3 / 7, 12);
    expect(r.coastDim).toBe(1.1);
  });
});
