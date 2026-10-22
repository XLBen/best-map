import { describe, expect, it } from 'vitest';
import type { FeatureType, GeoFeature } from '../../core/features';
import { encodePath } from '../../core/rivers';
import { planCourse } from '../../core/select';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { type OverlayState, buildPaths, placeLabels, riverLines, riverPaths, riverPathsKey, samePathsKey } from './overlay';

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

// 测试里没有画布：Path2D 只记下画了哪些点
class FakePath {
  ops: ['M' | 'L', number, number][] = [];
  moveTo(x: number, y: number) {
    this.ops.push(['M', x, y]);
  }
  lineTo(x: number, y: number) {
    this.ops.push(['L', x, y]);
  }
}
(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;
const opsOf = (p: Path2D) => (p as unknown as FakePath).ops;
const bucketsOf = (list: { path: Path2D; width: number }[]) => list.map((b) => [b.width, opsOf(b.path)]);

// 画一条自定义走向的河（只挖河床、自动起名）
function drawCourse(
  eng: ReturnType<typeof continents>,
  from: (w: World, i: number) => [number, number][] | null,
  ok: (plan: ReturnType<typeof planCourse>) => boolean = (plan) => !plan.crossings.length && !plan.reroute,
): string {
  const w = eng.world;
  for (let i = 0; i < w.mesh.n; i++) {
    const stroke = from(w, i);
    if (!stroke) continue;
    const plan = planCourse(w, w.derived, stroke, { endOnLand: 'flow' });
    if (plan.blocked || plan.drawn < 5 || !ok(plan)) continue;
    eng.exec({ op: 'add_guide', guide: { id: 'river-a', cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 4, carve: 'bed', name: '' } });
    return 'river-a';
  }
  throw new Error('画不出河');
}

describe('地图上的河、预览的河同一套画法', () => {
  it('预览的河（river 图形）与地图上的河分档、坐标都一样；拖粗细只让这条河换档，hide 时不画它', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    const id = drawCourse(eng, (ww, i) =>
      ww.causes.land[i] && ww.derived.continentality[i] > 0.5 && i % 7 === 0 ? [[mesh.x[i], mesh.y[i]], [mesh.x[i] + 12 * mesh.spacing, mesh.y[i] + 2 * mesh.spacing]] : null,
    );
    const lines = riverLines(w);
    expect(lines.some((l) => l.guide === id)).toBe(true);
    expect(bucketsOf(riverPaths(w, lines))).toEqual(bucketsOf(buildPaths(w).rivers));
    const segs = (list: { path: Path2D; width: number }[]) => list.reduce((k, b) => k + opsOf(b.path).length / 2, 0);
    const own = lines.filter((l) => l.guide === id).reduce((k, l) => k + l.points.length - 1, 0);
    const wide = buildPaths(w, { id, width: 3 }).rivers;
    expect(segs(wide)).toBe(segs(buildPaths(w).rivers));
    expect(Math.max(...wide.map((b) => b.width))).toBeGreaterThanOrEqual(Math.max(...buildPaths(w).rivers.map((b) => b.width)));
    expect(bucketsOf(wide)).not.toEqual(bucketsOf(buildPaths(w).rivers));
    expect(segs(buildPaths(w, { id, hide: true }).rivers)).toBe(segs(buildPaths(w).rivers) - own);
    // 河道的白色虚线标记：画出来的那条线，一笔连着画（虚线不在每段重新开始）
    expect(opsOf(buildPaths(w).lockedGuides).filter((o) => o[0] === 'M').length).toBe(1);
  });

  it('路径缓存按河道的内容认：只改名字时不重画，改了粗细、拖粗细时重画', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    const id = drawCourse(eng, (ww, i) =>
      ww.causes.land[i] && ww.derived.continentality[i] > 0.5 && i % 5 === 0 ? [[mesh.x[i], mesh.y[i]], [mesh.x[i] - 10 * mesh.spacing, mesh.y[i] + 4 * mesh.spacing]] : null,
    );
    // 轻快照：小数据是新的一份（这里复制一份），推导数组沿用
    const light = (patch: object): World => ({ ...w, small: { ...w.small, guides: w.small.guides.map((g) => (g.id === id ? { ...g, ...patch } : { ...g })) } });
    const key = riverPathsKey(w, null);
    expect(samePathsKey(riverPathsKey(light({}), null), key)).toBe(true);
    expect(samePathsKey(riverPathsKey(light({ name: '赤江' }), null), key)).toBe(true);
    expect(samePathsKey(riverPathsKey(light({ width: 2 }), null), key)).toBe(false);
    expect(samePathsKey(riverPathsKey(w, { id, width: 2 }), key)).toBe(false);
  });

  it('整个星球：每段河按起点挪到 [0, 2) 里（平铺的副本只看 [-0.6, 2.6]），跨接缝的河道标记照样连着画', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const { mesh } = eng.world;
    // 画的线从接缝的另一份开始（x 减了 2），往东跨过接缝
    drawCourse(
      eng,
      (ww, i) => (ww.causes.land[i] && mesh.x[i] >= 1.93 && mesh.y[i] > 0.25 && mesh.y[i] < 0.75 ? [[mesh.x[i] - 2, mesh.y[i]], [mesh.x[i] - 2 + 0.15, mesh.y[i]]] : null),
      (plan) => Math.max(...plan.path.map((q) => q[0])) > 2.005,
    );
    const w = eng.world;
    const lines = riverLines(w);
    const course = lines.filter((l) => l.guide);
    expect(Math.max(...course.flatMap((l) => l.points.map((p) => p[0])))).toBeGreaterThan(2);
    const p = buildPaths(w);
    for (const b of p.rivers) {
      const ops = opsOf(b.path);
      for (let k = 0; k < ops.length; k += 2) {
        expect(ops[k][0]).toBe('M');
        expect(ops[k][1]).toBeGreaterThanOrEqual(0);
        expect(ops[k][1]).toBeLessThan(2);
        expect(Math.abs(ops[k + 1][1] - ops[k][1])).toBeLessThan(0.5);
      }
    }
    // 标记：挪的份数变了才另起一笔，每一笔里相邻两点挨着
    const ops = opsOf(p.lockedGuides);
    expect(ops.filter((o) => o[0] === 'M').length).toBeLessThanOrEqual(2);
    for (const o of ops) if (o[0] === 'M') expect(o[1]).toBeGreaterThanOrEqual(0);
    for (let k = 1; k < ops.length; k++) if (ops[k][0] === 'L') expect(Math.abs(ops[k][1] - ops[k - 1][1])).toBeLessThan(0.5);
  });
});
