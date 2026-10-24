import { describe, expect, it } from 'vitest';
import type { Command } from '../../core/commands';
import type { FeatureType, GeoFeature } from '../../core/features';
import { previewWorldOf } from '../../core/preview-world';
import { encodePath, traceRivers } from '../../core/rivers';
import { planCourse } from '../../core/select';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { type OverlayPaths, type OverlayState, buildPaths, drawOverlay, placeLabels, riverDraws, riverLines, riverPathsKey, samePathsKey } from './overlay';

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
  closePath() {}
}
(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;
const opsOf = (p: Path2D) => (p as unknown as FakePath).ops;
// 每条河的带子：中线与半宽（逐位比）
const ribbonsOf = (list: OverlayPaths['rivers']) => list.map((d) => [Array.from(d.rb.x), Array.from(d.rb.y), Array.from(d.rb.hw)]);
const widest = (list: OverlayPaths['rivers']) => Math.max(...list.map((d) => d.rb.maxHw));

// 只记下填了、描了哪些路径的假画布（drawOverlay 按导出的虚拟窗口直接画，不碰缓存）
interface Call {
  op: 'fill' | 'stroke';
  style: string;
  width: number;
  dash: number;
  path: FakePath | null;
}
function recordingCtx() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
  let dash = 0;
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k === 'canvas') return { width: 800, height: 600, clientWidth: 800, clientHeight: 600 };
      if (k === 'fill') return (p?: FakePath) => calls.push({ op: 'fill', style: String(t.fillStyle), width: Number(t.lineWidth), dash, path: p ?? null });
      if (k === 'stroke') return (p?: FakePath) => calls.push({ op: 'stroke', style: String(t.strokeStyle), width: Number(t.lineWidth), dash, path: p ?? null });
      if (k === 'setLineDash') return (d: number[]) => (dash = d.length);
      if (k === 'measureText') return () => ({ width: 10 });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
const riverState = (w: World): OverlayState =>
  ({
    rivers: true,
    wind: false,
    markers: false,
    season: 'annual',
    style: 'realistic',
    shapes: [],
    provinceLabels: [],
    features: null,
    labelTypes: null,
    kmPerUnit: w.kmPerUnit,
    hoverLabel: null,
    scaleBar: false,
    cornerLift: 0,
    latitude: null,
    frame: { cw: 800, ch: 600, dpr: 1 },
  }) as OverlayState;


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
    eng.exec({ op: 'add_guide', guide: { id: 'river-a', cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 4, name: '' } });
    return 'river-a';
  }
  throw new Error('画不出河');
}

describe('地图上的河、预览的河同一套画法', () => {
  it('预览的河（river 图形）与地图上的河是同一条带子；拖粗细只让这条河变宽，hide 时不画它', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    const id = drawCourse(eng, (ww, i) =>
      ww.causes.land[i] && ww.derived.continentality[i] > 0.5 && i % 7 === 0 ? [[mesh.x[i], mesh.y[i]], [mesh.x[i] + 12 * mesh.spacing, mesh.y[i] + 2 * mesh.spacing]] : null,
    );
    const lines = riverLines(w);
    expect(lines.some((l) => l.guide === id)).toBe(true);
    const base = buildPaths(w).rivers;
    expect(ribbonsOf(riverDraws(w, lines))).toEqual(ribbonsOf(base));
    const own = lines.filter((l) => l.guide === id).length;
    const wide = buildPaths(w, { id, width: 3 }).rivers;
    expect(wide.length).toBe(base.length);
    expect(widest(wide)).toBeGreaterThanOrEqual(widest(base));
    // 只有这条河变了：别的河的带子逐位相同，这条河的中线不变、半宽变成三倍
    lines.forEach((l, k) => {
      if (l.guide !== id) expect(ribbonsOf([wide[k]])).toEqual(ribbonsOf([base[k]]));
      else {
        expect(Array.from(wide[k].rb.x)).toEqual(Array.from(base[k].rb.x));
        for (let i = 0; i < base[k].rb.hw.length; i++) expect(wide[k].rb.hw[i]).toBeCloseTo(3 * base[k].rb.hw[i], 4);
      }
    });
    expect(buildPaths(w, { id, hide: true }).rivers.length).toBe(base.length - own);
    // 河道的白色虚线标记：画出来的那条线，一笔连着画（虚线不在每段重新开始）
    expect(opsOf(buildPaths(w).lockedGuides).filter((o) => o[0] === 'M').length).toBe(1);
  });

  it('同色的河一次填（交汇处不叠出深色）：宽的河另描两岸（压在河面下面）；看全图时细于一个像素的河沿中线描', () => {
    const w = continents().world;
    const p = buildPaths(w);
    const big = p.rivers.reduce((a, b) => (b.rb.maxHw > a.rb.maxHw ? b : a));
    const at = (zoom: number) => {
      const cam = { x: big.rb.x[big.rb.x.length >> 1], y: big.rb.y[big.rb.y.length >> 1], zoom };
      const { ctx, calls } = recordingCtx();
      drawOverlay(ctx, w, p, cam, riverState(w));
      return calls;
    };
    const calls = at(40 / w.mesh.spacing);
    const fills = calls.filter((c) => c.op === 'fill' && c.path);
    expect(fills.length).toBe(1);
    expect(fills[0].style).toBe('rgba(52, 104, 168, 0.92)');
    expect(fills[0].path!.ops.filter((o) => o[0] === 'M').length).toBeGreaterThan(0);
    const bank = calls.findIndex((c) => c.op === 'stroke' && c.style.startsWith('rgba(24, 52, 88'));
    expect(bank).toBeGreaterThanOrEqual(0);
    expect(bank).toBeLessThan(calls.indexOf(fills[0]));
    const far = at((1.2 * 800) / w.mesh.width);
    expect(far.filter((c) => c.op === 'stroke' && c.style === 'rgba(52, 104, 168, 0.92)').length).toBeGreaterThan(0);
  });

  it('路径缓存按河道的内容认：只改名字时不重画，改了粗细、拖粗细时重画；岸线（陆地程度、海岸破碎度、湖面）变了重描河', () => {
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
    expect(samePathsKey(riverPathsKey({ ...w, causes: { ...w.causes, landness: w.causes.landness.slice() } }, null), key)).toBe(false);
    const rough = { ...w, small: { ...w.small, terrain: { ...w.small.terrain, coastRoughness: w.small.terrain.coastRoughness + 0.1 } } };
    expect(samePathsKey(riverPathsKey(rough, null), key)).toBe(false);
    expect(samePathsKey(riverPathsKey({ ...w, derived: { ...w.derived, water: w.derived.water.slice() } }, null), key)).toBe(false);
  });

  it('预览世界（地图画将来的样子）的河与当前世界同一个键：没改河时直接用当前世界的路径；画河的预览世界画出来的河与执行后逐点相同，拖粗细照样画', () => {
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
      cmd = { op: 'add_guide', guide: { id: 'river-a', cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 4, name: '' } };
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
    expect(plain.rivers.length).toBeGreaterThan(0);
    expect(ribbonsOf(widened.rivers)).not.toEqual(ribbonsOf(plain.rivers));
    // 松手执行（采用预览）之后的河与预览世界画的逐点相同
    eng.exec(cmd!);
    const after = eng.world;
    expect(ribbonsOf(buildPaths(after).rivers)).toEqual(ribbonsOf(plain.rivers));
    expect(opsOf(buildPaths(after).lockedGuides)).toEqual(opsOf(plain.lockedGuides));
    expect(ribbonsOf(buildPaths(after, wide).rivers)).toEqual(ribbonsOf(widened.rivers));
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

  it('整个星球：跨接缝的河是连续的一条带子，画的时候按看得见的副本平移 2；跨接缝的河道标记照样连着画', () => {
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
    for (const d of p.rivers) for (let i = 1; i < d.rb.x.length; i++) expect(Math.abs(d.rb.x[i] - d.rb.x[i - 1])).toBeLessThan(0.05);
    // 镜头对着接缝（x = 0 附近）：跨接缝的那条河画得出来（平移过的那一份落在画面里）
    const seamRiver = p.rivers.find((d) => d.rb.x1 > 2)!;
    const { ctx, calls } = recordingCtx();
    const zoom = 30 / mesh.spacing;
    const k = seamRiver.rb.x.findIndex((v) => v > 2);
    drawOverlay(ctx, w, p, { x: seamRiver.rb.x[k] - 2, y: seamRiver.rb.y[k], zoom }, riverState(w));
    const xs = calls.filter((c) => c.path).flatMap((c) => c.path!.ops.map((o) => o[1]));
    expect(xs.some((x) => Math.abs(x - (seamRiver.rb.x[k] - 2)) < 100 / zoom)).toBe(true);
    // 标记：挪的份数变了才另起一笔，每一笔里相邻两点挨着
    const ops = opsOf(p.lockedGuides);
    expect(ops.filter((o) => o[0] === 'M').length).toBeLessThanOrEqual(2);
    for (const o of ops) if (o[0] === 'M') expect(o[1]).toBeGreaterThanOrEqual(0);
    for (let j = 1; j < ops.length; j++) if (ops[j][0] === 'L') expect(Math.abs(ops[j][1] - ops[j - 1][1])).toBeLessThan(0.5);
  });

  it('河流类型：带类型的点乘类型的粗细、按类型的颜色填；虚线的河沿中线一笔描；只改颜色、画法时不重新描河', () => {
    const eng = continents();
    const plainCount = buildPaths(eng.world).rivers.length;
    const rule = { match: { api: 1 as const, src: 'return 流量 > 3 * 河流门槛;' } };
    const blood = { id: 'blood', name: '血河', color: '#8f1414', width: 2, scripts: rule };
    eng.exec({ op: 'set_river_type', type: blood });
    const w = eng.world;
    const p = buildPaths(w);
    expect(p.rivers.length).toBe(plainCount);
    const typed = p.rivers.filter((d) => d.type);
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.every((d) => d.type!.every((t) => t === 0 || t === 1))).toBe(true);
    // 粗细：两倍粗的河比一倍的宽
    const thinner = buildPaths({ ...w, small: { ...w.small, riverTypes: [{ ...blood, width: 1 }] } });
    expect(widest(p.rivers)).toBeGreaterThan(widest(thinner.rivers));
    const big = typed.reduce((a, b) => (b.rb.maxHw > a.rb.maxHw ? b : a));
    const k = big.rb.src.findIndex((s) => big.type![s] === 1);
    const draw = (ww: World, paths: OverlayPaths) => {
      const { ctx, calls } = recordingCtx();
      drawOverlay(ctx, ww, paths, { x: big.rb.x[k], y: big.rb.y[k], zoom: 30 / ww.mesh.spacing }, riverState(ww));
      return calls;
    };
    expect(draw(w, p).some((c) => c.op === 'fill' && c.style === '#8f1414')).toBe(true);
    // 只改颜色、画法（轻快照，推导数组不变）：分档的键变了（重画），描好的河照用
    const lines = riverLines(w);
    const key = riverPathsKey(w, null);
    eng.exec({ op: 'set_river_type', type: { ...blood, color: '#123456', style: 'dashed' } });
    expect(eng.world.derived.riverType).toBe(w.derived.riverType);
    expect(samePathsKey(riverPathsKey(eng.world, null), key)).toBe(false);
    expect(riverLines(eng.world)).toBe(lines);
    // 虚线：沿中线描，每条一笔
    const dashed = draw(eng.world, buildPaths(eng.world)).filter((c) => c.op === 'stroke' && c.style === '#123456');
    expect(dashed.length).toBeGreaterThan(0);
    expect(dashed.every((c) => c.dash === 2 && c.path!.ops.filter((o) => o[0] === 'M').length === 1)).toBe(true);
  });
});

describe('删掉的地名（第十六轮）', () => {
  it('不标；选中、悬停着的那个照样标出来', () => {
    const features = [feature('大森林', 'forest', 1e6, 0.5, { hidden: true }), feature('小湾', 'bay', 1e5, 0.2)];
    expect(shown(features)).toEqual(['小湾']);
    expect(shown(features, '大森林')).toContain('大森林');
  });
});
