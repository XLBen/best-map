import { describe, expect, it } from 'vitest';
import type { GeoFeature } from '../../core/features';
import { findCell } from '../../core/mesh';
import { buildSphereMesh } from '../../core/sphere';
import { type OverlayState, placeLabels } from './overlay';
import { type Proj, type ProjCamera, EE_HALF_W, EE_K, centerScale, convertCamera, forward, inverse, planeBounds, polarOf, rotateToAnchor, sceneNeed, screenToWorld, trueScale, worldOfPolar, worldToScreen } from './projection';
import { planScene, sceneFits } from './renderer';

// 整个星球的投影（第十三轮 G4）：算式来回一致、等面积真的等面积、屏幕上的一点取到画在那里的格、换投影时画面中心不动

// 可重复的伪随机数
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const EE: Proj = { kind: 'equalEarth', lon0: 0.7, lat0: 0 };
const GLOBE: Proj = { kind: 'globe', lon0: -2.1, lat0: 0.6 };
const dx = (a: number, b: number) => Math.abs(a - b - 2 * Math.round((a - b) / 2));

describe('投影的算式来回一致', () => {
  it('等面积：世界 → 平面 → 世界（整个球面，含两极附近）', () => {
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      const x = 2 * r();
      const y = 0.002 + 0.996 * r();
      const q = forward(EE, x, y)!;
      const w = inverse(EE, q[0], q[1])!;
      expect(w).not.toBeNull();
      expect(dx(w[0], x)).toBeLessThan(1e-9);
      expect(Math.abs(w[1] - y)).toBeLessThan(1e-9);
    }
  });

  it('等面积：平面 → 世界 → 平面（椭圆之内）；椭圆之外是 null', () => {
    const r = rng(2);
    const [u0, u1, v0, v1] = planeBounds(EE);
    let inside = 0;
    for (let i = 0; i < 3000; i++) {
      const u = u0 + (u1 - u0) * r();
      const v = v0 + (v1 - v0) * r();
      const w = inverse(EE, u, v);
      if (!w) continue;
      inside++;
      const q = forward(EE, w[0], w[1])!;
      expect(Math.abs(q[0] - u)).toBeLessThan(1e-9);
      expect(Math.abs(q[1] - v)).toBeLessThan(1e-9);
    }
    // 椭圆约占外接长方形的 π/4
    expect(inside / 3000).toBeGreaterThan(0.75);
    expect(inside / 3000).toBeLessThan(0.9);
    expect(inverse(EE, 1 + EE_HALF_W * 1.01, 0.5)).toBeNull();
    expect(inverse(EE, 1, -0.01)).toBeNull();
    // 南北高 1、东西宽约 2.05
    expect(planeBounds(EE)[3] - planeBounds(EE)[2]).toBeCloseTo(1, 12);
    expect(2 * EE_HALF_W).toBeGreaterThan(2.03);
    expect(2 * EE_HALF_W).toBeLessThan(2.07);
  });

  it('球形：看得见的一面来回一致，背面看不见，球外是 null', () => {
    const r = rng(3);
    let front = 0;
    for (let i = 0; i < 2000; i++) {
      const x = 2 * r();
      const y = 0.001 + 0.998 * r();
      const q = forward(GLOBE, x, y);
      if (!q) continue;
      front++;
      const w = inverse(GLOBE, q[0], q[1])!;
      expect(dx(w[0], x)).toBeLessThan(1e-7);
      expect(Math.abs(w[1] - y)).toBeLessThan(1e-7);
    }
    // 看得见的约是一半
    expect(front / 2000).toBeGreaterThan(0.4);
    expect(front / 2000).toBeLessThan(0.6);
    expect(inverse(GLOBE, 1.51, 0.5)).toBeNull();
    // 正中就是朝着的那一点
    const c = inverse(GLOBE, 1, 0.5)!;
    expect(dx(c[0], 1 + GLOBE.lon0 / Math.PI)).toBeLessThan(1e-12);
    expect(c[1]).toBeCloseTo(0.5 - GLOBE.lat0 / Math.PI, 12);
  });

  it('球形看着北极（lat0 = 90°）时正中是北极，四周的经度连续', () => {
    const p: Proj = { kind: 'globe', lon0: 0.3, lat0: Math.PI / 2 };
    expect(inverse(p, 1, 0.5)![1]).toBeCloseTo(0, 9);
    const w = inverse(p, 1.2, 0.5)!;
    const q = forward(p, w[0], w[1])!;
    expect(q[0]).toBeCloseTo(1.2, 9);
    expect(q[1]).toBeCloseTo(0.5, 9);
  });
});

describe('等面积真的等面积', () => {
  it('处处的面积比例相同（按真实距离算的比例是 K·π），两极附近也一样', () => {
    const r = rng(4);
    const want = EE_K * Math.PI;
    for (let i = 0; i < 500; i++) {
      const x = 2 * r();
      const y = 0.01 + 0.98 * r();
      expect(trueScale(EE, x, y) / want).toBeCloseTo(1, 3);
    }
    expect(centerScale(EE)).toBeCloseTo(want, 12);
  });

  it('同样大小的一块球面在图上面积相同：赤道与北纬 80° 的两个经纬方块按面积比例', () => {
    // 经纬方块的球面面积 ∝ Δλ·(sin φ1 − sin φ0)；图上用四个角的多边形近似（细分以后很准）
    const areaOnMap = (lat0: number, lat1: number) => {
      const pts: [number, number][] = [];
      const n = 40;
      const lonA = -10;
      const lonB = 10;
      for (let k = 0; k <= n; k++) pts.push([lonA + ((lonB - lonA) * k) / n, lat0]);
      for (let k = 0; k <= n; k++) pts.push([lonB, lat0 + ((lat1 - lat0) * k) / n]);
      for (let k = 0; k <= n; k++) pts.push([lonB - ((lonB - lonA) * k) / n, lat1]);
      for (let k = 0; k <= n; k++) pts.push([lonA, lat1 - ((lat1 - lat0) * k) / n]);
      const q = pts.map(([lo, la]) => forward(EE, 1 + (lo + (EE.lon0 * 180) / Math.PI) / 180, (90 - la) / 180)!);
      let a = 0;
      for (let k = 0; k < q.length; k++) {
        const [x0, y0] = q[k];
        const [x1, y1] = q[(k + 1) % q.length];
        a += x0 * y1 - x1 * y0;
      }
      return Math.abs(a) / 2;
    };
    const sphere = (lat0: number, lat1: number) => Math.sin((lat1 * Math.PI) / 180) - Math.sin((lat0 * Math.PI) / 180);
    const ratioMap = areaOnMap(0, 10) / areaOnMap(78, 88);
    const ratioSphere = sphere(0, 10) / sphere(78, 88);
    expect(ratioMap / ratioSphere).toBeCloseTo(1, 3);
  });
});

describe('球形：拖着转、在鼠标处缩放', () => {
  it('转到让世界上的一点落在平面上的那一点', () => {
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const x = 2 * r();
      const y = 0.05 + 0.9 * r();
      const a = 2 * Math.PI * r();
      const rad = 0.45 * r();
      const u = 1 + rad * Math.cos(a);
      const v = 0.5 + rad * Math.sin(a);
      const p = rotateToAnchor(GLOBE, x, y, u, v);
      const q = forward(p, x, y);
      // 有的目标做不到（要翻过极点）：做不到时朝向不变
      if (p === GLOBE) continue;
      expect(q).not.toBeNull();
      expect(q![0]).toBeCloseTo(u, 7);
      expect(q![1]).toBeCloseTo(v, 7);
      expect(Math.abs(p.lat0)).toBeLessThanOrEqual(Math.PI / 2 + 1e-12);
    }
  });
});

describe('屏幕上的一点取到画在那里的格', () => {
  const mesh = buildSphereMesh(3000, 7);
  const cw = 900;
  const ch = 600;
  for (const [name, cam] of [
    ['等面积', { x: 1, y: 0.5, zoom: 400, proj: EE }],
    ['等面积（放大、平移）', { x: 0.7, y: 0.3, zoom: 2500, proj: EE }],
    ['球形', { x: 1, y: 0.5, zoom: 550, proj: GLOBE }],
    ['球形（看着南极）', { x: 1, y: 0.5, zoom: 550, proj: { kind: 'globe', lon0: 1, lat0: -Math.PI / 2 } }],
  ] as [string, ProjCamera][]) {
    it(name, () => {
      let checked = 0;
      for (let i = 0; i < mesh.n; i += 3) {
        const s = worldToScreen(cam, cw, ch, mesh.x[i], mesh.y[i]);
        if (!s || s[0] < 0 || s[1] < 0 || s[0] > cw || s[1] > ch) continue;
        const p = screenToWorld(cam, cw, ch, s[0], s[1]);
        expect(p.inside).toBe(true);
        expect(findCell(mesh, p.x, p.y)).toBe(i);
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
    });
  }

  it('投影之外不在地图上，但坐标是有限的数（在最近的边上）', () => {
    const cam: ProjCamera = { x: 1, y: 0.5, zoom: 400, proj: GLOBE };
    const p = screenToWorld(cam, cw, ch, 5, 5);
    expect(p.inside).toBe(false);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    // 球的背面画不到屏幕上
    const back = inverse(GLOBE, 1, 0.5)!;
    expect(worldToScreen(cam, cw, ch, back[0] + 1, 1 - back[1])).toBeNull();
  });

  it('等距圆柱（镜头上没有投影）与原来的算式相同', () => {
    const cam: ProjCamera = { x: 0.8, y: 0.4, zoom: 700 };
    const s = worldToScreen(cam, cw, ch, 1.1, 0.35)!;
    expect(s[0]).toBeCloseTo((1.1 - 0.8) * 700 + cw / 2, 9);
    expect(s[1]).toBeCloseTo((0.35 - 0.4) * 700 + ch / 2, 9);
    const p = screenToWorld(cam, cw, ch, s[0], s[1]);
    expect(p.x).toBeCloseTo(1.1, 12);
    expect(p.y).toBeCloseTo(0.35, 12);
  });
});

describe('换投影时画面中心不动、大小不变', () => {
  const cw = 1000;
  const ch = 700;
  it('等距圆柱 → 等面积 → 球形 → 等距圆柱', () => {
    const eq: ProjCamera = { x: 0.6, y: 0.3, zoom: 900 };
    const center = screenToWorld(eq, cw, ch, cw / 2, ch / 2);
    const ee = convertCamera(eq, cw, ch, 'equalEarth');
    const c1 = screenToWorld(ee, cw, ch, cw / 2, ch / 2);
    expect(dx(c1.x, center.x)).toBeLessThan(1e-9);
    expect(c1.y).toBeCloseTo(center.y, 9);
    // 那里的比例：真实距离一个地图单位合几个像素
    expect(ee.zoom * trueScale(ee.proj!, c1.x, c1.y)).toBeCloseTo(900, 6);
    const gl = convertCamera(ee, cw, ch, 'globe');
    const c2 = screenToWorld(gl, cw, ch, cw / 2, ch / 2);
    expect(dx(c2.x, center.x)).toBeLessThan(1e-9);
    expect(c2.y).toBeCloseTo(center.y, 9);
    expect(gl.zoom * centerScale(gl.proj!)).toBeCloseTo(900, 6);
    const back = convertCamera(gl, cw, ch, 'equirect');
    expect(back.proj).toBeUndefined();
    expect(dx(back.x, center.x)).toBeLessThan(1e-9);
    expect(back.y).toBeCloseTo(center.y, 9);
    expect(back.zoom).toBeCloseTo(900, 6);
  });
});

describe('合成用的场景', () => {
  const cw = 1000;
  const ch = 700;
  it('球形看得见整个半球：要整圈（转动时不必重画），密度是正中的比例', () => {
    const cam = { x: 1, y: 0.5, zoom: 600, proj: { ...GLOBE, lat0: 0.25 } };
    const need = sceneNeed(cam, cw, ch, 0.01)!;
    expect(need.full).toBe(true);
    expect(need.x0).toBe(0);
    expect(need.x1).toBe(2);
    expect(need.zy).toBeGreaterThan(0.9 * 600 * centerScale(GLOBE));
    expect(need.zy).toBeLessThan(1.05 * 600 * centerScale(GLOBE));
    // 转一下：照样是整圈、密度差不多，场景照用
    const sc = planScene({ ...need, zx: need.zx * 2, zy: need.zy * 2 }, 1, 0.1, 8192, 8e6);
    const turned = sceneNeed({ ...cam, proj: { ...GLOBE, lon0: GLOBE.lon0 + 0.8, lat0: -0.1 } }, cw, ch, 0.01)!;
    expect(sceneFits(sc, { ...turned, zx: turned.zx * 2, zy: turned.zy * 2 }, 0.9, 2.2)).toBe(true);
  });

  it('放大以后只要看得见的一块，盖住画面上每个像素取到的地方', () => {
    const cam = { x: 0.9, y: 0.35, zoom: 4000, proj: EE };
    const need = sceneNeed(cam, cw, ch, 0.003)!;
    expect(need.full).toBe(false);
    for (let j = 0; j <= 50; j++) {
      for (let i = 0; i <= 50; i++) {
        const p = screenToWorld(cam, cw, ch, (cw * i) / 50, (ch * j) / 50);
        if (!p.inside) continue;
        const x = need.x0 + ((((p.x - need.x0) % 2) + 2) % 2);
        expect(x).toBeGreaterThanOrEqual(need.x0);
        expect(x).toBeLessThanOrEqual(need.x1);
        expect(p.y).toBeGreaterThanOrEqual(need.y0);
        expect(p.y).toBeLessThanOrEqual(need.y1);
      }
    }
    // 画出来的场景受纹理大小、像素总数所限
    const sc = planScene(need, 2, 0.1, 4096, 4e6);
    expect(sc.W).toBeLessThanOrEqual(4096);
    expect(sc.H).toBeLessThanOrEqual(4096);
    expect(sc.W * sc.H).toBeLessThanOrEqual(4e6 * 1.01);
  });

  it('等面积放大到北极那条边上：南北伸到极点，东西只要看得见的那一段（等面积的极点是一条线）', () => {
    const cam = { x: 1, y: 0.03, zoom: 6000, proj: EE };
    const need = sceneNeed(cam, cw, ch, 0.003)!;
    expect(need.full).toBe(false);
    expect(need.y0).toBe(0);
    expect(need.x1 - need.x0).toBeLessThan(0.5);
  });

  it('球形看着极地：改用以极点为中心的场景（整圈，绕极轴转动时照用），看着赤道时照旧是等距圆柱', () => {
    const polar = sceneNeed({ x: 1, y: 0.5, zoom: 2000, proj: { kind: 'globe', lon0: 0.3, lat0: 1.2 } }, cw, ch, 0.003)!;
    expect(polar.pole).toBe(1);
    expect(polar.x0).toBe(-polar.x1);
    expect(polar.y0).toBe(-polar.y1);
    const sc = planScene(polar, 1, 0.1, 8192, 8e6);
    const turned = sceneNeed({ x: 1, y: 0.5, zoom: 2000, proj: { kind: 'globe', lon0: 2.3, lat0: 1.2 } }, cw, ch, 0.003)!;
    expect(sceneFits(sc, turned, 0.9, 2.2)).toBe(true);
    const south = sceneNeed({ x: 1, y: 0.5, zoom: 2000, proj: { kind: 'globe', lon0: 0.3, lat0: -1.4 } }, cw, ch, 0.003)!;
    expect(south.pole).toBe(-1);
    expect(sceneNeed({ x: 1, y: 0.5, zoom: 2000, proj: { kind: 'globe', lon0: 0.3, lat0: 0.1 } }, cw, ch, 0.003)!.pole).toBe(0);
    // 等面积不用
    expect(sceneNeed({ x: 1, y: 0.05, zoom: 3000, proj: EE }, cw, ch, 0.003)!.pole).toBe(0);
  });

  it('极地平面：来回一致', () => {
    const r = rng(9);
    for (let i = 0; i < 200; i++) {
      const x = 2 * r();
      const y = r();
      for (const pole of [1, -1] as const) {
        const [X, Y] = polarOf(pole, x, y);
        const w = worldOfPolar(pole, X, Y);
        expect(w[1]).toBeCloseTo(y, 9);
        if (Math.hypot(X, Y) > 1e-6 && Math.hypot(X, Y) < 1 - 1e-6) expect(dx(w[0], x)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('地名按投影放（球的背面不标）', () => {
  // 只量字宽的假画布：每个字 10 像素，画布 800 × 600
  const ctx = { canvas: { clientWidth: 800, clientHeight: 600 }, font: '', measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D;
  const spot = (key: string, x: number, y: number): GeoFeature => ({ key, type: 'spot', anchor: 0, cells: new Int32Array(0), areaKm2: 0, x, y, angle: 0, span: 0, tags: [], importance: 1, name: key, custom: true });
  const state = (features: GeoFeature[]) => ({ features, labelTypes: null, kmPerUnit: 1000, hoverLabel: null }) as unknown as OverlayState;

  it('球形：正面的地名在投影算出的位置，背面的不标', () => {
    const cam = { x: 1, y: 0.5, zoom: 500, proj: { kind: 'globe', lon0: 0, lat0: 0 } as Proj };
    const features = [spot('正中', 1, 0.5), spot('背面', 0.02, 0.5), spot('东边', 1.25, 0.5)];
    const { placed } = placeLabels(ctx, cam, state(features), [0], 1000);
    const keys = placed.map((l) => l.key);
    expect(keys).toContain('正中');
    expect(keys).toContain('东边');
    expect(keys).not.toContain('背面');
    // 地点的圆点落在放的位置上（字在右边：中心右移半个字串宽减半个字宽）
    const mid = placed.find((l) => l.key === '正中')!;
    expect(mid.x - (mid.total / 2 - mid.widths[0] / 2)).toBeCloseTo(400, 6);
    expect(mid.y).toBeCloseTo(300, 6);
    const east = placed.find((l) => l.key === '东边')!;
    const s = worldToScreen(cam, 800, 600, 1.25, 0.5)!;
    expect(east.x - (east.total / 2 - east.widths[0] / 2)).toBeCloseTo(s[0], 6);
    // 经度 45° 在正射投影上是 sin 45° 个半径
    expect(s[0]).toBeCloseTo(400 + 500 * 0.5 * Math.SQRT1_2, 6);
  });

  it('等面积：整圈都看得见（没有背面），等距圆柱的副本不再重复', () => {
    const cam = { x: 1, y: 0.5, zoom: 300, proj: { kind: 'equalEarth', lon0: 0, lat0: 0 } as Proj };
    const { placed } = placeLabels(ctx, cam, state([spot('西边', 0.05, 0.5), spot('东边', 1.95, 0.5)]), [0], 1000);
    expect(placed.map((l) => l.key).sort()).toEqual(['东边', '西边']);
  });
});

describe('投影的着色器源码', () => {
  it('合成：括号配得上，场景都按世界坐标取（toScene），相邻像素、圆圈在世界坐标上；花纹的退路照样完整', async () => {
    const { PROJ_SOURCES, COMPOSE_SOURCES, withoutFx } = await import('./renderer');
    const count = (src: string, s: string) => src.split(s).length - 1;
    for (const src of [PROJ_SOURCES.compose, withoutFx(PROJ_SOURCES.compose)]) {
      expect(count(src, '{')).toBe(count(src, '}'));
      expect(count(src, '(')).toBe(count(src, ')'));
    }
    const src = PROJ_SOURCES.compose;
    // 画面上的位置只在开头算投影时用；场景上的位置都经过 toScene
    expect(src).not.toContain('* uSceneXf.xy');
    expect(src).toContain('vec2 dx = uDX * 1.5;');
    expect(src).toContain('vec2 hy = uDY * 1.5;');
    expect(src).toContain('if (!projInv(uPlane, pW, uEdge)) {');
    expect(src).toContain('oColor = projFinish(col);');
    expect(src).toContain('texture(uRiver, toScene(pW) * uRiverXf.xy + uRiverXf.zw)');
    // 省份的环上取样照旧（半径按格算，在世界坐标上）
    expect(src).toContain('vec2 r = ((landPx ? 0.3 : 0.6) * float(ring) * uCellPx) * uTexel;');
    // 等距圆柱的两份不受影响
    expect(COMPOSE_SOURCES.plane).not.toContain('projInv');
    expect(COMPOSE_SOURCES.planet).not.toContain('projInv');
  });

  it('极地的场景：位置按极点的等距方位投影，坡度换到平面上再换回来', async () => {
    const { PROJ_SOURCES } = await import('./renderer');
    const count = (src: string, s: string) => src.split(s).length - 1;
    for (const [name, src] of Object.entries(PROJ_SOURCES)) {
      expect(count(src, '{'), name).toBe(count(src, '}'));
      expect(count(src, '('), name).toBe(count(src, ')'));
    }
    expect(PROJ_SOURCES.polarCellVs).toContain('vGradP = g0.x * pE + g0.y * pS;');
    expect(PROJ_SOURCES.polarTerrainFs).toContain('vGrad = vec2(dot(vGradP, pE), dot(vGradP, pS));');
    for (const s of [PROJ_SOURCES.polarCellVs, PROJ_SOURCES.polarIdVs, PROJ_SOURCES.polarSeamVs]) expect(s).toContain('uPole * sin(pa)');
  });
});
