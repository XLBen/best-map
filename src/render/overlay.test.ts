import { describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import type { FeatureType, GeoFeature } from '../../core/features';
import { previewWorldOf } from '../../core/preview-world';
import { encodePath, traceRivers } from '../../core/rivers';
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

  it('预览世界（地图画将来的样子）的河与当前世界同一个键：没改河时直接用当前世界的路径；画河的预览世界画出来的河与执行后逐段相同，拖粗细照样画', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    // 只改名字：预览世界沿用当前世界的流量数组，键相同（地图不重描河）
    const named = w.derived.features.find((f) => f.type === 'river' && /^\w+:\d+$/.test(f.key))!;
    const renamed = previewWorldOf(w, structuredClone(eng.previewWorld({ op: 'rename_feature', key: named.key, name: '赤江' }).patch));
    expect(samePathsKey(riverPathsKey(renamed, null), riverPathsKey(w, null))).toBe(true);
    // 画一条自定义走向的河：预览带着两边加的项（画的河、挖出的河床；说明、状态编号、陆海变化）
    let cmd: Command | null = null;
    for (let i = 0; i < mesh.n && !cmd; i++) {
      if (!w.causes.land[i] || w.derived.continentality[i] <= 0.5 || i % 7 !== 0) continue;
      const plan = planCourse(w, w.derived, [[mesh.x[i], mesh.y[i]], [mesh.x[i] + 12 * mesh.spacing, mesh.y[i] + 2 * mesh.spacing]], { endOnLand: 'flow' });
      if (plan.blocked || plan.drawn < 5 || plan.crossings.length || plan.reroute) continue;
      cmd = { op: 'add_guide', guide: { id: 'river-a', cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 4, carve: 'bed', name: '' } };
    }
    expect(cmd).not.toBeNull();
    const liveKey = riverPathsKey(w, null);
    const { result, patch } = eng.previewWorld(cmd!);
    expect(result.guide?.id).toBe('river-a');
    expect(result.guide!.followed).toBe(true);
    expect(result.carved.cells.length).toBeGreaterThanOrEqual(0);
    expect(result.summary).not.toBe('');
    expect(result.stateId).toBe(eng.stateId);
    expect(result.landGained).toEqual([]);
    const shown = previewWorldOf(w, structuredClone(patch));
    expect(samePathsKey(riverPathsKey(shown, null), liveKey)).toBe(false);
    const wide = { id: 'river-a', width: 2.5 };
    const plain = buildPaths(shown);
    const widened = buildPaths(shown, wide);
    expect(plain.rivers.some((b) => opsOf(b.path).length)).toBe(true);
    expect(bucketsOf(widened.rivers)).not.toEqual(bucketsOf(plain.rivers));
    // 松手执行（采用预览）之后的河与预览世界画的逐段相同
    eng.exec(cmd!);
    const after = eng.world;
    expect(bucketsOf(buildPaths(after).rivers)).toEqual(bucketsOf(plain.rivers));
    expect(opsOf(buildPaths(after).lockedGuides)).toEqual(opsOf(plain.lockedGuides));
    expect(bucketsOf(buildPaths(after, wide).rivers)).toEqual(bucketsOf(widened.rivers));
  });

  it('预览世界只换了湖面、流向、高程或陆海（流量数组还是当前世界那个）：键不同，描出来的是它自己的河；点河用的当前世界那份不被一份份预览世界挤掉', () => {
    const w = continents().world;
    const live = riverPathsKey(w, null);
    // 预览世界只带内容变了的数组（见 preview-world.ts）：只换其中一个，别的（包括流量）沿用当前世界的同一个对象
    const d = w.derived;
    for (const s of [
      { ...w, derived: { ...d, receiver: d.receiver.slice() } },
      { ...w, derived: { ...d, lake: d.lake.slice() } },
      { ...w, derived: { ...d, elevation: d.elevation.slice() } },
      { ...w, causes: { ...w.causes, land: w.causes.land.slice() } },
    ]) {
      expect(s.derived.discharge).toBe(d.discharge);
      expect(samePathsKey(riverPathsKey(s, null), live)).toBe(false);
    }
    // 一条自然大河中段的一格将来成了湖：预览世界的河在那里断开，不能照用当前世界描好的河
    const lines = riverLines(w);
    const big = lines.filter((l) => !l.guide && l.points.length > 12).sort((a, b) => b.points.length - a.points.length)[0];
    const lake = d.lake.slice();
    lake[big.cells![Math.floor(big.cells!.length / 2)]] = 1;
    const shown = { ...w, derived: { ...d, lake } };
    expect(riverLines(shown)).toEqual(traceRivers(shown));
    expect(riverLines(shown)).not.toEqual(lines);
    // 拖着调整面板的滑块：预览世界一份份换，中间点河、画选中的河的光用的当前世界那份一直留着（不重描）
    for (let k = 0; k < 3; k++) {
      expect(riverLines(w)).toBe(lines);
      riverLines({ ...w, derived: { ...d, discharge: d.discharge.slice() } });
    }
    expect(riverLines(w)).toBe(lines);
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
