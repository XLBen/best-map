import { describe, expect, it } from 'vitest';
import type { FeatureType, GeoFeature } from '../../core/features';
import { LABEL_REF_WIDTH, exportFrame, planTiles, tileMargin, tileSize, tileView } from './export-plan';
import { type OverlayState, placeLabels } from './overlay';

// 导出整张地图（.png）：虚拟镜头、分块、每一块的视图

// 地图单位 → 图上的像素（与渲染器的视图同一个算式：镜头在图的中间）
const toImage = (f: ReturnType<typeof exportFrame>, x: number, y: number) => {
  const Z = f.cam.zoom * f.dpr;
  return [(x - f.cam.x) * Z + f.width / 2, (y - f.cam.y) * Z + f.height / 2];
};

describe('虚拟镜头盖住整张图', () => {
  it('一块地区：左上角、右下角正好是图的两角，高按长宽比', () => {
    const f = exportFrame({ width: 1.6, height: 1 }, 4096, 'medium');
    expect(f.width).toBe(4096);
    expect(f.height).toBe(2560);
    expect(toImage(f, 0, 0)).toEqual([0, 0]);
    const [x1, y1] = toImage(f, 1.6, 1);
    expect(x1).toBeCloseTo(4096, 6);
    expect(y1).toBeCloseTo(2560, 6);
  });

  it('整个星球：2:1，经度 0–2 正好一整圈（一份，不重复）', () => {
    const f = exportFrame({ width: 2, height: 1 }, 8192, 'medium');
    expect([f.width, f.height]).toEqual([8192, 4096]);
    expect(toImage(f, 0, 0)).toEqual([0, 0]);
    expect(toImage(f, 2, 1)[0]).toBeCloseTo(8192, 6);
    expect(toImage(f, 2, 1)[1]).toBeCloseTo(4096, 6);
  });

  it('字号：按“在 refWidth 宽的窗口里看全图”画，再放大到图宽；图比窗口还窄时不缩小', () => {
    const mid = exportFrame({ width: 1.6, height: 1 }, 4096, 'medium');
    expect(mid.cw).toBeCloseTo(LABEL_REF_WIDTH.medium, 6);
    expect(mid.dpr).toBeCloseTo(4096 / LABEL_REF_WIDTH.medium, 9);
    // 同一张图，字号越大，虚拟窗口越窄、放大倍数越大
    const big = exportFrame({ width: 1.6, height: 1 }, 4096, 'large');
    const small = exportFrame({ width: 1.6, height: 1 }, 4096, 'small');
    expect(big.dpr).toBeGreaterThan(mid.dpr);
    expect(small.dpr).toBeLessThan(mid.dpr);
    // 8192 与 4096 的版面一样（同一个虚拟窗口），只是放大倍数翻倍
    const m8 = exportFrame({ width: 1.6, height: 1 }, 8192, 'medium');
    expect(m8.cam).toEqual(mid.cam);
    expect(m8.dpr).toBeCloseTo(2 * mid.dpr, 9);
    expect(exportFrame({ width: 1.6, height: 1 }, 1024, 'small').dpr).toBe(1);
  });
});

describe('分块', () => {
  it('块铺满整张图、互不重叠，最后一行、一列按剩下的大小', () => {
    const tiles = planTiles(2500, 1300, 1024);
    expect(tiles.length).toBe(6);
    let area = 0;
    for (const t of tiles) {
      area += t.w * t.h;
      expect(t.x % 1024).toBe(0);
      expect(t.y % 1024).toBe(0);
      expect(t.x + t.w).toBeLessThanOrEqual(2500);
      expect(t.y + t.h).toBeLessThanOrEqual(1300);
    }
    expect(area).toBe(2500 * 1300);
  });

  it('四周的边是偶数、盖得住扭曲（0.525 格）加相邻像素；块是偶数、场景不超过显卡上限', () => {
    for (const cellPx of [0.5, 3, 17.3, 64, 150]) {
      const m = tileMargin(cellPx);
      expect(m % 2).toBe(0);
      expect(m).toBeGreaterThanOrEqual(0.525 * cellPx + 2);
    }
    expect(tileSize(16384, 20)).toBe(1024);
    expect(tileSize(1000, 20)).toBe(960);
    expect(tileSize(1001, 21) % 2).toBe(0);
    expect(tileSize(16384, 20, 256)).toBe(256);
  });

  it('每一块的场景与合成画面：同一个世界点在相邻两块里落在同一个图上的像素（拼起来没有错位）', () => {
    const f = exportFrame({ width: 1.6, height: 1 }, 4096, 'medium');
    const T = 1024;
    const m = tileMargin(20);
    // 合成画面上的 uv（0–1，y 向上）→ 图上的像素
    const imagePx = (x0: number, y0: number, wx: number, wy: number) => {
      const v = tileView(f, x0, y0, T, m).out;
      const u = (wx * v[0] + v[2] + 1) / 2;
      const vv = (wy * v[1] + v[3] + 1) / 2;
      return [x0 + u * T, y0 + (1 - vv) * T];
    };
    for (const [wx, wy] of [
      [0.4, 0.25],
      [0.41, 0.26],
      [1.2, 0.9],
    ]) {
      const [ix, iy] = toImage(f, wx, wy);
      // 左边一块与右边一块（伸出块外也一样）
      for (const [x0, y0] of [
        [0, 0],
        [1024, 0],
        [2048, 1024],
      ]) {
        const [px, py] = imagePx(x0, y0, wx, wy);
        expect(px).toBeCloseTo(ix, 6);
        expect(py).toBeCloseTo(iy, 6);
      }
    }
    // 场景比合成画面四周各多 m 像素：合成画面上的 uv → 场景上的 uv
    const tv = tileView(f, 1024, 0, T, m);
    expect(tv.S).toBe(T + 2 * m);
    expect(tv.xf[0] * 0 + tv.xf[2]).toBeCloseTo(m / tv.S, 12);
    expect(tv.xf[0] * 1 + tv.xf[2]).toBeCloseTo((T + m) / tv.S, 12);
    // 场景的视图与合成画面同一个中心、同一个缩放
    expect(tv.scene[0] * tv.S).toBeCloseTo(tv.out[0] * T, 9);
    expect(-tv.scene[2] / tv.scene[0]).toBeCloseTo(tv.cx, 12);
  });
});

// 导出时排整张图的地名：按虚拟窗口，整个字在图里，不动屏幕上的版面缓存
describe('整张图的地名', () => {
  const ctx = { canvas: { clientWidth: 800, clientHeight: 600 }, font: '', measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D;
  const feature = (name: string, type: FeatureType, areaKm2: number, x: number, y: number, importance = 1): GeoFeature => ({
    key: name,
    type,
    anchor: 0,
    cells: new Int32Array(0),
    areaKm2,
    x,
    y,
    angle: 0,
    span: 0,
    tags: [],
    importance,
    name,
    custom: false,
  });
  const features = [
    feature('东海', 'ocean', 4e6, 1.59, 0.5, 9),
    feature('北原', 'forest', 2e5, 0.8, 0.002, 5),
    feature('小湖', 'lake', 3e4, 0.3, 0.6, 2),
    feature('远湖', 'lake', 3e4, 1.3, 0.3, 2),
  ];
  const f = exportFrame({ width: 1.6, height: 1 }, 4096, 'medium');
  const st = { features, labelTypes: null, kmPerUnit: 3000, hoverLabel: null, frame: { cw: f.cw, ch: f.ch, dpr: f.dpr } } as unknown as OverlayState;

  it('伸出图边的地名往里挪，整个字在图里；屏幕外（800 × 600 的画布外）的也排', () => {
    const { placed, boxes } = placeLabels(ctx, f.cam, st, [0], f.cam.zoom);
    expect(placed.map((l) => l.key).sort()).toEqual(['东海', '北原', '小湖', '远湖'].sort());
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(f.cw + 1e-9);
      expect(b.y1).toBeLessThanOrEqual(f.ch + 1e-9);
    }
  });

  it('同样的输入排出同样的版面；导出不改屏幕上的版面缓存', () => {
    const screenSt = { features, labelTypes: null, kmPerUnit: 3000, hoverLabel: null } as unknown as OverlayState;
    const cam = { x: 0.8, y: 0.5, zoom: 600 };
    const before = placeLabels(ctx, cam, screenSt, [0], 600);
    const a = placeLabels(ctx, f.cam, st, [0], f.cam.zoom);
    const b = placeLabels(ctx, f.cam, st, [0], f.cam.zoom);
    expect(b.placed.map((l) => [l.key, l.x, l.y])).toEqual(a.placed.map((l) => [l.key, l.x, l.y]));
    expect(placeLabels(ctx, cam, screenSt, [0], 600)).toBe(before);
  });
});
