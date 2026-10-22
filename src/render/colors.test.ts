import { describe, expect, it } from 'vitest';
import { continents } from '../../core/testing/fixtures';
import { highlightColors, provinceScale } from './colors';

// 高亮的编码（着色器按 alpha 字节解码）与省界淡出用的省份大小

describe('highlightColors 的 alpha 字节', () => {
  const w = continents().world;

  it('平涂 1–127、只描边 128、斜线 129–255；后面的层盖住前面的层', () => {
    const out = highlightColors(w, [
      { cells: [0, 1, 2], color: [10, 20, 30], alpha: 0.5 },
      { cells: [1], color: [40, 50, 60], pattern: 'outline' },
      { cells: [2], color: [70, 80, 90], alpha: 0.85, pattern: 'hatch' },
      // 只描边不看 alpha、values：淡到 0 也照样描
      { cells: [3], color: [255, 255, 255], alpha: 0, pattern: 'outline' },
    ])!;
    expect(Array.from(out.subarray(0, 4))).toEqual([10, 20, 30, Math.round(127 * 0.5)]);
    expect(Array.from(out.subarray(4, 8))).toEqual([40, 50, 60, 128]);
    expect(Array.from(out.subarray(8, 12))).toEqual([70, 80, 90, 128 + Math.round(127 * 0.85)]);
    expect(out[15]).toBe(128);
    // 没有高亮的格是 0
    expect(out[19]).toBe(0);
  });

  it('淡到一个字节以下的平涂、斜线不写（不会被当成只描边）', () => {
    const out = highlightColors(w, [
      { cells: [0], color: [255, 255, 255], alpha: 0.003 },
      { cells: [1], color: [255, 255, 255], alpha: 0.003, pattern: 'hatch' },
    ])!;
    expect(out[3]).toBe(0);
    expect(out[7]).toBe(0);
  });

  it('闪烁淡出时每一步的不透明度都编成平涂（轮廓跟着它淡）', () => {
    for (let step = 1; step <= 7; step++) {
      const out = highlightColors(w, [{ cells: [5], color: [255, 236, 120], alpha: step / 40 }])!;
      const A = out[5 * 4 + 3];
      expect(A).toBeGreaterThan(0);
      expect(A).toBeLessThan(128);
    }
  });
});

describe('provinceScale', () => {
  it('省份格数中位数的平方根；没划分的格不算', () => {
    const p = Int32Array.from([-1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, -1]);
    // 省 0：4 格，省 1：9 格，省 2：1 格 → 中位数 4
    expect(provinceScale(p)).toBe(2);
  });

  it('没有省份时为 1', () => {
    expect(provinceScale(new Int32Array(10).fill(-1))).toBe(1);
  });

  it('划好省份的世界：每个省大约几格宽', () => {
    const w = continents({ provinces: true }).world;
    const s = provinceScale(w.causes.province);
    expect(s).toBeGreaterThan(2);
    expect(s).toBeLessThan(40);
  });
});
