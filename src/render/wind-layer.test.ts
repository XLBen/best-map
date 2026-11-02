import { afterEach, describe, expect, it } from 'vitest';
import { findCell } from '../../core/mesh';
import { meshFor, seededEngine } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { type OverlayState, buildPaths, drawOverlay, overlayDebug } from './overlay';
import type { Camera } from './renderer';
import { currentLines, flushWindQueue, windLines, windTilesCached } from './wind';
import { drawFlows, flowStats } from './wind-layer';

// 风与洋流（第四十六轮）：不在这种模式时一块不算、一笔不画；停稳时贴位图、移动中平移缩放挪位图；三种投影都画；区域的洋流

// 测试里没有画布：Path2D 记下画了几个点，画布的上下文记下画了几笔
class FakePath {
  n = 0;
  constructor(_d?: unknown) {}
  moveTo() {
    this.n++;
  }
  lineTo() {
    this.n++;
  }
  arc() {}
  closePath() {}
  rect() {}
}
(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;

function fakeCtx(width: number, height: number) {
  const calls = { stroke: 0, image: 0, points: 0 };
  const state: Record<string, unknown> = { lineWidth: 1, strokeStyle: '', fillStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1 };
  const canvas = { width, height, clientWidth: width, clientHeight: height };
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k === 'canvas') return canvas;
      if (k === 'stroke')
        return (p?: FakePath) => {
          calls.stroke++;
          calls.points += p?.n ?? 0;
        };
      if (k === 'drawImage') return () => calls.image++;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, canvas };
}

// 停稳、移动中的位图要用的离屏画布
class FakeOffscreen {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return fakeCtx(this.width, this.height).ctx;
  }
}

const g = globalThis as unknown as { OffscreenCanvas?: unknown };
afterEach(() => {
  delete g.OffscreenCanvas;
  overlayDebug.noFlowBitmap = false;
});

const worlds = new Map<string, World>();
function world(kind: 'region' | 'planet'): World {
  let w = worlds.get(kind);
  if (!w) {
    const settings = kind === 'planet' ? { seed: 4, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 4, cells: 8000 };
    const e = seededEngine(settings, meshFor(settings));
    e.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    worlds.set(kind, (w = e.world));
  }
  return w;
}

const stateOf = (w: World, on: boolean, more: Partial<OverlayState> = {}): OverlayState =>
  ({
    rivers: false,
    wind: on,
    currents: on,
    markers: false,
    season: 'summer',
    style: { countryLabel: '#3a2a1a' } as OverlayState['style'],
    shapes: [],
    provinceLabels: [],
    features: null,
    labelTypes: null,
    kmPerUnit: w.kmPerUnit,
    hoverLabel: null,
    scaleBar: false,
    cornerLift: 0,
    latitude: null,
    ...more,
  }) as OverlayState;

const frame = { cw: 1000, ch: 700, dpr: 1 };
const fieldTiles = (w: World) => windTilesCached(w.derived.windSX) + windTilesCached(w.derived.currentX);

describe('不在“风与洋流”模式：一块不算、一笔不画', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const w = world(kind);
      const paths = buildPaths(w);
      const cams: Camera[] =
        kind === 'planet'
          ? [{ x: 1, y: 0.5, zoom: 500 }, { x: 1, y: 0.5, zoom: 600, proj: { kind: 'globe', lon0: 0.3, lat0: 0.2 } }, { x: 1, y: 0.5, zoom: 400, proj: { kind: 'equalEarth', lon0: 0, lat0: 0 } }]
          : [{ x: 1, y: 0.5, zoom: 500 }];
      const before = { ...flowStats };
      for (const cam of cams) {
        for (const motion of [false, true]) {
          const { ctx, calls } = fakeCtx(1000, 700);
          drawOverlay(ctx, w, paths, cam, stateOf(w, false, { motion, lazy: () => {} }));
          expect(calls.stroke).toBe(0);
          expect(calls.image).toBe(0);
        }
      }
      flushWindQueue();
      expect(fieldTiles(w)).toBe(0);
      expect(flowStats).toEqual(before);
    });
  }
});

describe('在“风与洋流”模式里', () => {
  it('一块地区也有洋流：流线只在海上（碰到陆地就停），有风有洋流', () => {
    const w = world('region');
    const cam = { x: 1, y: 0.5, zoom: 500 };
    const cur = currentLines(w, cam, frame);
    const wind = windLines(w, cam, 'summer', frame);
    expect(cur.length).toBeGreaterThan(10);
    expect(wind.length).toBeGreaterThan(10);
    let onLand = 0;
    let all = 0;
    for (const l of cur)
      for (const [x, y] of l.pts) {
        all++;
        if (w.causes.land[findCell(w.mesh, x, y)]) onLand++;
      }
    // 线上的点最多越过海岸半步
    expect(onLand / all).toBeLessThan(0.03);
    expect(new Set(cur.map((l) => l.color)).size).toBeGreaterThan(1);
  });

  it('三种投影都画（等面积、球形逐点投影，球的背面不画）', () => {
    const w = world('planet');
    overlayDebug.noFlowBitmap = true;
    for (const proj of [undefined, { kind: 'globe' as const, lon0: 0.3, lat0: 0.2 }, { kind: 'equalEarth' as const, lon0: 1, lat0: 0 }]) {
      const cam: Camera = { x: 1, y: 0.5, zoom: proj ? 600 : 500, proj };
      const { ctx, calls } = fakeCtx(1000, 700);
      drawFlows(ctx, w, cam, stateOf(w, true), frame);
      expect(calls.stroke).toBeGreaterThan(10);
      expect(calls.points).toBeGreaterThan(500);
    }
  });

  it('停稳时贴位图：镜头、场都没变时只贴、不重描；季节变了重描', () => {
    g.OffscreenCanvas = FakeOffscreen;
    const w = world('region');
    const cam = { x: 0.8, y: 0.4, zoom: 900 };
    const st = stateOf(w, true);
    const s0 = { ...flowStats };
    const a = fakeCtx(1000, 700);
    drawFlows(a.ctx, w, cam, st, frame);
    drawFlows(a.ctx, w, cam, st, frame);
    drawFlows(a.ctx, w, cam, { ...st, shapes: [] }, frame);
    expect(flowStats.paints - s0.paints).toBe(1);
    expect(flowStats.pastes - s0.pastes).toBe(2);
    expect(a.calls.image).toBe(3);
    // 叠加层本身一笔不描
    expect(a.calls.stroke).toBe(0);
    drawFlows(a.ctx, w, cam, { ...st, season: 'winter' }, frame);
    expect(flowStats.paints - s0.paints).toBe(2);
  });

  it('移动中：平移、缩放在边距之内挪位图（不重描、不重算块）；转球时直接画', () => {
    g.OffscreenCanvas = FakeOffscreen;
    for (const kind of ['region', 'planet'] as const) {
      const w = world(kind);
      const st = stateOf(w, true, { motion: true });
      const cam: Camera = { x: 1, y: 0.5, zoom: 800 };
      const a = fakeCtx(1000, 700);
      drawFlows(a.ctx, w, cam, st, frame);
      const s0 = { ...flowStats };
      const tiles = fieldTiles(w);
      // 往右挪 20 帧，每帧 6 像素；缩放 1.1 倍
      for (let k = 1; k <= 20; k++) drawFlows(a.ctx, w, { ...cam, x: cam.x + (6 * k) / cam.zoom }, st, frame);
      drawFlows(a.ctx, w, { ...cam, zoom: cam.zoom * 1.1 }, st, frame);
      expect(flowStats.paints - s0.paints).toBe(0);
      expect(flowStats.pastes - s0.pastes).toBe(21);
      expect(fieldTiles(w)).toBe(tiles);
      // 挪出边距：重画一次
      drawFlows(a.ctx, w, { ...cam, x: cam.x + 900 / cam.zoom }, st, frame);
      expect(flowStats.paints - s0.paints).toBe(1);
    }
    const w = world('planet');
    const st = stateOf(w, true, { motion: true });
    const a = fakeCtx(1000, 700);
    const turn = (lon0: number): Camera => ({ x: 1, y: 0.5, zoom: 600, proj: { kind: 'globe', lon0, lat0: 0.2 } });
    drawFlows(a.ctx, w, turn(0), st, frame);
    const s0 = { ...flowStats };
    const strokes = a.calls.stroke;
    for (let k = 1; k <= 5; k++) drawFlows(a.ctx, w, turn(k * 0.02), st, frame);
    expect(flowStats.direct - s0.direct).toBe(5);
    expect(a.calls.stroke).toBeGreaterThan(strokes);
    // 转球时只缩放：朝向没变，挪位图
    const z0 = { ...flowStats };
    drawFlows(a.ctx, w, { ...turn(0.1), zoom: 610 }, st, frame);
    expect(flowStats.direct - z0.direct).toBe(0);
  });
});
