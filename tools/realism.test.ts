import { describe, expect, it } from 'vitest';
import { PLANET_SIZES, planetCells, planetSettings, settingsFor } from '../core/presets';
import { type RealismRow, coastRaster, realismRow, realismWorld } from './realism';

// 和地球比的区间（第三十二到三十四轮，慢测试：不进 test:fast）。6 个种子 × {半个星球的区域、类地星球}，按平均值查计划里的区间。
// 汇水面积超越指数、前十流域的 L/√A 还没到地球的区间（见开发说明“大格局与长河”）：L/√A 查比第三十一轮好，
// 超越指数查只数前十个流域的那一种不超出地球区间的上沿太多

const SEEDS = [1, 2, 3, 4, 5, 6];

function means(rows: RealismRow[]): Record<keyof RealismRow, number> {
  const out = {} as Record<keyof RealismRow, number>;
  for (const k of Object.keys(rows[0]) as (keyof RealismRow)[]) {
    const v = rows.map((r) => r[k]).filter((x) => Number.isFinite(x));
    out[k] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  }
  return out;
}

const band = (v: number, lo: number, hi: number) => {
  expect(v).toBeGreaterThanOrEqual(lo);
  expect(v).toBeLessThanOrEqual(hi);
};

describe('和地球比（6 个种子的平均）', () => {
  it('半个星球的区域', () => {
    const m = means(SEEDS.map((seed) => {
      const w = realismWorld(settingsFor('hemisphere', 'temperate', 40000), seed);
      return realismRow(w, coastRaster(w, 2048));
    }));
    band(m.below200, 0.22, 0.32);
    band(m.above2000, 0.07, 0.15);
    band(m.longestPerDiameter, 0.8, 1.4);
    expect(m.endorheic).toBeGreaterThanOrEqual(0.03);
    expect(m.plateau).toBeGreaterThanOrEqual(0.008);
    expect(m.riftRatio).toBeGreaterThan(4);
    // 第三十一轮：L/√A 1.80；只数前十个流域的超越指数 0.42（这一轮约 0.50）
    expect(m.lOverSqrtA).toBeGreaterThan(1.85);
    expect(m.exceedanceBasins).toBeLessThanOrEqual(0.53);
    // 第三十三轮：比第三十二轮（低平地 15.1%、低处大干流两旁高出 65 m）低平；入海的大河 30–80% 有分汊；有冲积扇
    expect(m.lowFlat).toBeGreaterThan(0.151);
    expect(m.trunkRise).toBeLessThan(60);
    band(m.deltaShare, 0.3, 0.8);
    expect(m.fans).toBeGreaterThan(0);
    // 第三十四轮：冰川低地里湖面 3–12%、别处 < 2%，冰川区的湖大小幂律指数 0.8–1.2；峡湾海岸的盒维数 ≥ 1.25、沙坝海岸 ≤ 1.1，
    // 沙坝海岸占海岸 5–15%
    band(m.glacialLakeShare, 0.03, 0.12);
    expect(m.otherLakeShare).toBeLessThan(0.02);
    band(m.glacialLakeK, 0.8, 1.2);
    expect(m.fjordDim).toBeGreaterThanOrEqual(1.25);
    expect(m.barrierDim).toBeLessThanOrEqual(1.1);
    band(m.barrierShare, 0.05, 0.15);
  }, 240_000);

  it('类地星球', () => {
    const settings = planetSettings('earth');
    expect(settings.cells).toBe(planetCells(PLANET_SIZES.earth.radiusKm));
    const m = means(SEEDS.map((seed) => {
      const w = realismWorld(settings, seed);
      // 星球 2048 像素宽时一格只有五六个像素，刻出来的海湾不到两个像素宽，峡湾的盒维数量不出来（约 1.25）：用 4096
      return realismRow(w, coastRaster(w, 4096));
    }));
    band(m.below200, 0.22, 0.32);
    band(m.above2000, 0.07, 0.15);
    expect(m.basinTop1).toBeGreaterThanOrEqual(0.03);
    expect(m.basinTop5).toBeGreaterThanOrEqual(0.1);
    band(m.longestPerDiameter, 0.8, 1.4);
    expect(m.endorheic).toBeGreaterThanOrEqual(0.03);
    expect(m.plateau).toBeGreaterThanOrEqual(0.008);
    expect(m.riftRatio).toBeGreaterThan(4);
    // 第三十一轮：L/√A 1.70；只数前十个流域的超越指数 0.46（这一轮约 0.50）
    expect(m.lOverSqrtA).toBeGreaterThan(1.85);
    expect(m.exceedanceBasins).toBeLessThanOrEqual(0.53);
    // 第三十三轮：比第三十二轮（低平地 16.0%、低处大干流两旁高出 81 m）低平；入海的大河 30–80% 有分汊；有冲积扇
    expect(m.lowFlat).toBeGreaterThan(0.16);
    expect(m.trunkRise).toBeLessThan(75);
    band(m.deltaShare, 0.3, 0.8);
    expect(m.fans).toBeGreaterThan(0);
    // 第三十四轮：冰川低地里湖面 3–12%、别处 < 2%，冰川区的湖大小幂律指数 0.8–1.2；峡湾海岸的盒维数 ≥ 1.25、沙坝海岸 ≤ 1.1，
    // 沙坝海岸占海岸 5–15%
    band(m.glacialLakeShare, 0.03, 0.12);
    expect(m.otherLakeShare).toBeLessThan(0.02);
    band(m.glacialLakeK, 0.8, 1.2);
    expect(m.fjordDim).toBeGreaterThanOrEqual(1.25);
    expect(m.barrierDim).toBeLessThanOrEqual(1.1);
    band(m.barrierShare, 0.05, 0.15);
  }, 480_000);
});
