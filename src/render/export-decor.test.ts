import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_MAP_STYLES, DRAWN_MAP_STYLES } from '../../core/packs/map-styles';
import { DECOR_KEYS, type DecorInfo, type DecorOptions, NO_DECOR, anyDecor, defaultDecor, drawExportDecor } from './export-decor';

// 第八十七轮：导出的装饰（罗盘、标题、边框、图例）。手绘默认全开、别的画风默认全关；每一样单独开关，关着的一笔不画

// 记下画了什么的假画布（每次调用的方法名与写的字）
function fakeCtx() {
  const calls: string[] = [];
  const texts: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s: string) => ({ width: 10 * [...s].length });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...a: unknown[]) => {
        calls.push(k);
        if (k === 'fillText') texts.push(String(a[0]));
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, texts };
}

const info = (style = DRAWN_MAP_STYLES[0]): DecorInfo => ({
  title: '测试世界',
  style,
  legendTitle: '国家',
  legend: [
    { color: '#c04040', label: '甲国' },
    { color: '#4060c0', label: '乙国' },
    { symbol: 'mountain', label: '山脉' },
    { symbol: 'forest', label: '森林' },
    { symbol: 'city', label: '城市' },
    { symbol: 'road', label: '道路' },
  ],
});

describe('导出的装饰', () => {
  beforeAll(() => {
    // Node 里没有 Path2D（图例里的山、树用它）：一个什么都不做的
    const g = globalThis as { Path2D?: unknown };
    if (!g.Path2D)
      g.Path2D = class {
        moveTo() {}
        lineTo() {}
        closePath() {}
        arc() {}
        quadraticCurveTo() {}
      };
  });

  it('默认：手绘全开，写实、地图册全关', () => {
    expect(defaultDecor(DRAWN_MAP_STYLES[0])).toEqual({ frame: true, compass: true, title: true, legend: true });
    for (const s of BUILTIN_MAP_STYLES) expect(defaultDecor(s)).toEqual(NO_DECOR);
    expect(anyDecor(NO_DECOR)).toBe(false);
  });

  it('全关时一笔不画', () => {
    const f = fakeCtx();
    drawExportDecor(f.ctx, 2000, 1400, NO_DECOR, info());
    expect(f.calls).toEqual([]);
  });

  it('每一样单独开：只画那一样（标题写世界的名字，图例写每一行，罗盘写“北”）', () => {
    const got: Record<string, { calls: string[]; texts: string[] }> = {};
    for (const k of DECOR_KEYS) {
      const f = fakeCtx();
      const o: DecorOptions = { ...NO_DECOR, [k]: true };
      drawExportDecor(f.ctx, 2000, 1400, o, info());
      expect(f.calls.length, k).toBeGreaterThan(0);
      got[k] = f;
    }
    expect(got.title.texts.join('')).toBe('测试世界');
    expect(got.compass.texts).toEqual(['北']);
    expect(got.legend.texts).toEqual(['国家', '甲国', '乙国', '山脉', '森林', '城市', '道路']);
    expect(got.frame.texts).toEqual([]);
    expect(got.frame.calls).toContain('strokeRect');
    // 图例里的山、树按画风的符号画（填了路径）
    expect(got.legend.calls).toContain('fill');
  });

  it('没有名字时不画标题、没有行时不画图例；别的画风开了也照样画', () => {
    const f = fakeCtx();
    drawExportDecor(f.ctx, 2000, 1400, { ...NO_DECOR, title: true, legend: true }, { ...info(BUILTIN_MAP_STYLES[0]), title: '', legend: [] });
    expect(f.calls).not.toContain('fillText');
    const g = fakeCtx();
    drawExportDecor(g.ctx, 2000, 1400, { ...NO_DECOR, compass: true }, info(BUILTIN_MAP_STYLES[1]));
    expect(g.texts).toEqual(['北']);
  });
});
