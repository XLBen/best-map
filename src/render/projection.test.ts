import { describe, expect, it } from 'vitest';
import { findCell } from '../../core/mesh';
import { buildSphereMesh } from '../../core/sphere';
import { type Proj, type ProjCamera, EE_HALF_W, EE_K, centerScale, convertCamera, forward, inverse, planeBounds, rotateToAnchor, sceneNeed, screenToWorld, trueScale, worldToScreen } from './projection';
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
    const cam = { x: 1, y: 0.5, zoom: 600, proj: GLOBE };
    const need = sceneNeed(cam, cw, ch, 0.01)!;
    expect(need.full).toBe(true);
    expect(need.x0).toBe(0);
    expect(need.x1).toBe(2);
    expect(need.zy).toBeGreaterThan(0.9 * 600 * centerScale(GLOBE));
    expect(need.zy).toBeLessThan(1.05 * 600 * centerScale(GLOBE));
    // 转一下：照样是整圈、密度差不多，场景照用
    const sc = planScene({ ...need, zx: need.zx * 2, zy: need.zy * 2 }, 1, 0.1, 8192, 8e6);
    const turned = sceneNeed({ ...cam, proj: { ...GLOBE, lon0: GLOBE.lon0 + 0.8, lat0: 0.1 } }, cw, ch, 0.01)!;
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

  it('看着极点附近：东西方向的密度比南北方向小得多（场景不必那么宽）', () => {
    const cam = { x: 1, y: 0.5, zoom: 6000, proj: { kind: 'globe', lon0: 0, lat0: 1.45 } as Proj };
    const need = sceneNeed(cam, cw, ch, 0.003)!;
    expect(need.full).toBe(true);
    expect(need.y0).toBe(0);
    expect(need.zx).toBeLessThan(need.zy * 0.6);
  });
});
