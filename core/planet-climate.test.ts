import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import type { SphereMesh } from './mesh';
import { PLANET_SWEEPS, buildFlowSphere, sphereAux } from './planet-climate';

// 整个星球的气候：没有接缝（不会在某个经度出现一条干带）、转动不变、输运图规整、迭代收敛

const globe = (cells: number) => ({ cells, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
const latOf = (y: number) => 90 - 180 * y;
const lonOf = (x: number) => 180 * (x - 1);

describe('整个星球的气候', () => {
  it('全是海的星球：同一纬度带里每个经度扇区的降水几乎一样（包括接缝两边）', () => {
    const eng = new Engine(globe(20000));
    eng.update();
    const { mesh } = eng.world;
    const d = eng.world.derived;
    for (let b = -80; b < 80; b += 20) {
      const sum = new Array(18).fill(0);
      const cnt = new Array(18).fill(0);
      for (let i = 0; i < mesh.n; i++) {
        const lat = latOf(mesh.y[i]);
        if (lat < b || lat >= b + 20) continue;
        const s = Math.min(17, Math.floor((mesh.x[i] / 2) * 18));
        sum[s] += d.precip[i];
        cnt[s]++;
      }
      const means = sum.map((v, k) => v / cnt[k]);
      const avg = means.reduce((a, v) => a + v, 0) / 18;
      for (const m of means) expect(Math.abs(m / avg - 1), `纬度 ${b}–${b + 20}`).toBeLessThan(0.03);
    }
  });

  it('同样形状的大陆放在不同经度：各纬度带的气候一样（转动不变）', () => {
    const stats = [0, 137, 251].map((lon0) => {
      const eng = new Engine(globe(20000));
      const { mesh } = eng.world;
      const cells: number[] = [];
      for (let i = 0; i < mesh.n; i++) {
        const lat = latOf(mesh.y[i]);
        const dl = ((lonOf(mesh.x[i]) - lon0 + 540) % 360) - 180;
        if (lat > 10 && lat < 55 && dl > 0 && dl < 70 - lat * 0.4) cells.push(i);
      }
      eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
      const d = eng.world.derived;
      const out: { p: number; t: number }[] = [];
      for (let b = 10; b < 55; b += 15) {
        let p = 0;
        let t = 0;
        let k = 0;
        for (let i = 0; i < mesh.n; i++) {
          const lat = latOf(mesh.y[i]);
          if (!eng.world.causes.land[i] || lat < b || lat >= b + 15) continue;
          p += d.precip[i];
          t += d.tMean[i];
          k++;
        }
        out.push({ p: p / k, t: t / k });
      }
      return out;
    });
    for (let s = 1; s < stats.length; s++) {
      stats[s].forEach((v, k) => {
        expect(Math.abs(v.p / stats[0][k].p - 1)).toBeLessThan(0.06);
        expect(Math.abs(v.t - stats[0][k].t)).toBeLessThan(0.5);
      });
    }
  });

  it('输运图：没有互相指向的两格；只有跨接缝、顺着风带的边滞后；两极几乎无风', () => {
    const eng = new Engine(globe(20000));
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    const mesh = eng.world.mesh as SphereMesh;
    const d = eng.world.derived;
    const { rev, seam } = sphereAux(mesh);
    const flow = buildFlowSphere(mesh, d.windSX, d.windSY, { lag: 'seam' });
    let lagged = 0;
    for (let i = 0; i < mesh.n; i++) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (flow.frac[e] > 0 && flow.frac[rev[e]] > 0) {
          // 只有静风格会均匀地分给所有邻居
          const j = mesh.adj[e];
          const calm = (c: number) => Math.hypot(d.windSX[c], d.windSY[c]) <= 1e-6;
          expect(calm(i) || calm(j)).toBe(true);
        }
        if (flow.lagged[e]) {
          lagged++;
          expect(seam[e]).toBe(1);
        }
      }
    }
    expect(lagged).toBeGreaterThan(10);
    for (let i = 0; i < mesh.n; i++) {
      if (Math.abs(latOf(mesh.y[i])) > 89) expect(Math.hypot(d.windSX[i], d.windSY[i])).toBeLessThan(0.05);
    }
  });

  it('扫描遍数加到三倍，结果几乎不变（已经收敛）', () => {
    const run = () => {
      const eng = new Engine(globe(12000));
      eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
      return eng.world.derived;
    };
    const a = run();
    const saved = PLANET_SWEEPS.wind;
    PLANET_SWEEPS.wind = saved * 3;
    let b;
    try {
      b = run();
    } finally {
      PLANET_SWEEPS.wind = saved;
    }
    let maxP = 0;
    let maxC = 0;
    for (let i = 0; i < a.precip.length; i++) {
      maxP = Math.max(maxP, Math.abs(a.precip[i] - b.precip[i]) / (a.precip[i] + 50));
      maxC = Math.max(maxC, Math.abs(a.continentality[i] - b.continentality[i]));
    }
    expect(maxP).toBeLessThan(0.02);
    expect(maxC).toBeLessThan(0.01);
  });
});
