import { describe, expect, it } from 'vitest';
import { OROGRAPHIC_KM, smoothPasses, windDeflectPasses } from './climate';

import { PLANET_CELL_KM, PLANET_SIZES, type PlanetSize, planetCells, planetSettings } from './presets';
import { buildSphereMesh } from './sphere';
import { sizeText } from './terrain';
import { meshFor, seededEngine } from './testing/fixtures';
import { createWorld, settingsSchema } from './world';

// 第十七轮：新建的整个星球每格约 100 km，格数随半径

describe('星球的格子', () => {
  it('格数随半径，量出来的格距约 100 km', () => {
    const cells = (Object.keys(PLANET_SIZES) as PlanetSize[]).map((s) => planetCells(PLANET_SIZES[s].radiusKm));
    expect(cells).toEqual([17800, 62600, 139200]);
    for (const s of Object.keys(PLANET_SIZES) as PlanetSize[]) {
      const settings = planetSettings(s);
      const R = PLANET_SIZES[s].radiusKm;
      expect(settings.cells).toBe(planetCells(R));
      const mesh = buildSphereMesh(settings.cells!, settings.seed!);
      const km = mesh.spacing * Math.PI * R;
      expect(Math.abs(km / PLANET_CELL_KM - 1), `${s} ${km}`).toBeLessThan(0.05);
      // 大小的提示里写的就是这个数
      const w = createWorld(settingsSchema.parse(settings), mesh);
      expect(sizeText(w, 1)).toBe('一格 ≈ 100 km');
    }
    // 别的格距也按同一个规则
    expect(planetCells(6371, 200)).toBe(15700);
  });

  it('按 km 定的平滑至少一遍，半径大致不变', () => {
    // 一遍扩散约走 √2 格：n 遍约 √(2n) 格
    const reach = (r: number, d: number) => Math.sqrt(2 * smoothPasses(r, d)) * d;
    for (const d of [40, 79, 100, 105]) {
      for (const r of [150, OROGRAPHIC_KM, 1500]) {
        expect(smoothPasses(r, d)).toBeGreaterThanOrEqual(1);
        expect(Math.abs(reach(r, d) / r - 1), `${r} km / ${d} km`).toBeLessThan(0.1);
      }
    }
    // 每格 100 km：山挡风 1 遍、地形雨 2 遍、陆地占比 113 遍
    expect([windDeflectPasses(100), smoothPasses(OROGRAPHIC_KM, 100), smoothPasses(1500, 100)]).toEqual([1, 2, 113]);
    // 格比半径还粗：也平滑一遍
    expect(smoothPasses(200, 1000)).toBe(1);
  });

  it('小星球（1.78 万格）上新建的世界有河、湖、省份和地名', () => {
    const settings = planetSettings('small');
    const eng = seededEngine(settings, meshFor(settings));
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const w = eng.world;
    expect(w.mesh.n).toBe(17800);
    const count = (t: string) => w.derived.features.filter((f) => f.type === t).length;
    expect(count('continent')).toBeGreaterThanOrEqual(3);
    expect(count('island')).toBeGreaterThan(5);
    expect(count('river')).toBeGreaterThan(10);
    expect(count('lake')).toBeGreaterThan(0);
    expect(count('range')).toBeGreaterThan(3);
    expect(count('peak')).toBeGreaterThan(3);
    let lakeCells = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.derived.lake[i] === 1) lakeCells++;
    expect(lakeCells).toBeGreaterThan(0);
    const provinces = new Set(w.causes.province);
    provinces.delete(-1);
    expect(provinces.size).toBeGreaterThan(100);
    const named = w.derived.features.filter((f) => f.name);
    expect(named.length).toBeGreaterThan(w.derived.features.length * 0.8);
  });
});
