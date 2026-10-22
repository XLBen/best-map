import { describe, expect, it } from 'vitest';
import type { FeatureType, GeoFeature } from '../../core/features';
import { type OverlayState, placeLabels } from './overlay';

// 放标签：用户自己的地名（圈的地区、放的地名、改过的名字）和悬停的那个总是标出来，最先放，避让时别的让它们

// 只量字宽的假画布：每个字 10 像素，画布 800 × 600
const ctx = { canvas: { clientWidth: 800, clientHeight: 600 }, font: '', measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D;
// 每个地图单位 1000 像素、1000 km：面积 a km² 的地物在屏幕上约 √a 像素大
const cam = { x: 0.5, y: 0.5, zoom: 1000 };
const feature = (name: string, type: FeatureType, areaKm2: number, x: number, more: Partial<GeoFeature> = {}): GeoFeature => ({
  key: name,
  type,
  anchor: 0,
  cells: new Int32Array(0),
  areaKm2,
  x,
  y: 0.5,
  angle: 0,
  span: 0,
  tags: [],
  importance: 1,
  name,
  custom: false,
  ...more,
});
const state = (features: GeoFeature[], hoverLabel: string | null = null) => ({ features, labelTypes: null, kmPerUnit: 1000, hoverLabel }) as unknown as OverlayState;
const shown = (features: GeoFeature[], hoverLabel: string | null = null) => placeLabels(ctx, cam, state(features, hoverLabel), [0], 1000).placed.map((l) => l.key);

describe('用户自己的地名总是标出来', () => {
  it('圈的小地区压在大森林上：地区标出来，森林让开；太小的自然地物照旧不标，改过名的小地物标出来', () => {
    const features = [
      feature('大森林', 'forest', 1e6, 0.5, { importance: 9 }),
      // 只有约 10 像素大（自然地物要 45 像素才标）
      feature('小村', 'region', 100, 0.5, { region: 'r1' }),
      feature('小湖', 'lake', 100, 0.7),
      feature('老林', 'forest', 100, 0.3, { custom: true }),
    ];
    const keys = shown(features);
    expect(keys).toContain('小村');
    expect(keys).toContain('老林');
    expect(keys).not.toContain('大森林');
    expect(keys).not.toContain('小湖');
  });

  it('悬停的地名也标出来；换了悬停的地名就重新排（布局缓存的键里有它）', () => {
    const features = [feature('大森林', 'forest', 1e6, 0.5, { importance: 9 }), feature('小湖', 'lake', 100, 0.7)];
    expect(shown(features)).toEqual(['大森林']);
    expect(shown(features, '小湖')).toEqual(['小湖', '大森林']);
    expect(shown(features)).toEqual(['大森林']);
  });
});
