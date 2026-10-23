import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
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

  it('山挡风打开：先偏转再乘极地衰减，两极照样几乎无风；拐过的风建的输运图照样规整', () => {
    const run = (terrainWind: number | null) => {
      const eng = new Engine(globe(20000));
      if (terrainWind !== null) eng.exec({ op: 'set_planet', patch: { terrainWind } });
      eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
      return eng.world;
    };
    const off = run(0);
    const on = run(null);
    const mesh = on.mesh as SphereMesh;
    const d = on.derived;
    let polar = 0;
    let touched = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (Math.abs(latOf(mesh.y[i])) <= 89) continue;
      polar++;
      if (d.windSX[i] !== off.derived.windSX[i] || d.windWX[i] !== off.derived.windWX[i]) touched++;
      expect(Math.hypot(d.windSX[i], d.windSY[i])).toBeLessThan(0.05);
      expect(Math.hypot(d.windWX[i], d.windWY[i])).toBeLessThan(0.05);
    }
    // 不是空跑：离极点 1° 以内有格，而且风被山挡风改过
    expect(polar).toBeGreaterThan(0);
    expect(touched).toBeGreaterThan(0);
    const { rev, seam } = sphereAux(mesh);
    for (const [wx, wy] of [
      [d.windSX, d.windSY],
      [d.windWX, d.windWY],
    ]) {
      const flow = buildFlowSphere(mesh, wx, wy, { lag: 'seam' });
      const calm = (c: number) => Math.hypot(wx[c], wy[c]) <= 1e-6;
      for (let i = 0; i < mesh.n; i++) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          if (flow.frac[e] > 0 && flow.frac[rev[e]] > 0) expect(calm(i) || calm(mesh.adj[e])).toBe(true);
          if (flow.lagged[e]) expect(seam[e]).toBe(1);
        }
      }
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

// 山挡风为 0：与加山挡风之前的算法逐值相同（一块地区的在 terrain-wind.test.ts）
describe('山挡风为 0 时与旧算法逐值相同（整个星球）', () => {
  it('与 golden-full 同一组加长的操作（含洋流强弱、撤销与重做）', () => {
    // 加山挡风之前记下的 core/golden-full.json（planet）里风、洋流、气候往后的几项
    const FROZEN: Record<string, string> = {
      'derived.windSX': '7f20aaf7ba887e51',
      'derived.windSY': '953a8cfe334432a5',
      'derived.windWX': 'a5a3a8b6a6099966',
      'derived.windWY': 'a6c525ec270bdd63',
      'derived.continentality': '8d7378377565d571',
      'derived.currentX': 'daf9f25265bc4c7a',
      'derived.currentY': 'e231f3f0ce14af61',
      'derived.sstAnom': '15c504aef4e5d9a4',
      'derived.tS': '27b7cd6bbfd11180',
      'derived.tW': '1752dc613d57c5b9',
      'derived.pS': '3e531f913985639a',
      'derived.pW': '1125d9c714cb4fa4',
      'derived.precip': '57bc9946fc17ee72',
      'derived.moisture': '79ba6632442d947e',
      'derived.corrT': '680cda049b5b311f',
      'derived.corrP': 'b707062b22d3bfbf',
      'derived.discharge': 'd93f0c082bae792f',
      'derived.dominant': '8d05968b26841f7c',
      'causes.province': '2da35ff8d22a84c0',
    };
    const eng = new Engine({ seed: 5, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
    const w = eng.world;
    eng.exec({ op: 'set_planet', patch: { terrainWind: 0 } });
    eng.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 7 } });
    eng.exec({ op: 'reroll_region', x: 1.99, y: 0.45, radius: 0.08, variant: 1 });
    let cells = coastalStroke(w, 0.37, 6);
    eng.exec({ op: 'paint_land', cells, t: cells.map((_, k) => (k % 7) / 7), mode: 'land' });
    cells = coastalStroke(w, 0.71, 5);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    eng.exec({ op: 'set_coast_style', roughness: 1.4 });
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(100, 400), value: 2, mode: 'add' });
    eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(500, 650), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 600 } });
    eng.exec({ op: 'set_worldgen', params: { ...w.small.terrain.gen!, landFraction: 0.33 } });
    eng.exec({ op: 'add_island', island: { x: 1.9995, y: 0.3, kind: 'volcanic', size: 400, variant: 2 } });
    eng.exec({ op: 'set_planet', patch: { currents: 1.5 } });
    eng.undo();
    eng.undo();
    eng.redo();
    expect(w.small.planet.terrainWind).toBe(0);
    const all = digestWorld(w);
    expect(Object.fromEntries(Object.keys(FROZEN).map((k) => [k, all[k]]))).toEqual(FROZEN);
  });
});
