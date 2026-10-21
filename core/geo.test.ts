import { describe, expect, it } from 'vitest';
import { arcUnits, circle, densify, unwrapNear, wrapDelta, wrapX } from './geo';
import { brushCells, lassoStroke, ringCells, ringWinding } from './select';
import { buildSphereMesh } from './sphere';
import { createWorld } from './world';

// 整个星球的几何小工具，以及画笔、圈一片在接缝和两极附近的行为

const world = createWorld({ cells: 20000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, buildSphereMesh(20000, 1));
const { mesh } = world;
// 纬度 → y
const yOf = (lat: number) => (90 - lat) / 180;

describe('经度绕回、球面距离', () => {
  it('绕回与展开', () => {
    expect(wrapX(2.25)).toBeCloseTo(0.25);
    expect(wrapX(-0.25)).toBeCloseTo(1.75);
    expect(wrapDelta(1.9)).toBeCloseTo(-0.1);
    expect(unwrapNear(0.05, 1.95)).toBeCloseTo(2.05);
  });

  it('赤道上 90° 是 1/2，极点到极点是 1；跨接缝和不跨一样', () => {
    expect(arcUnits(1, 0.5, 1.5, 0.5)).toBeCloseTo(0.5, 9);
    expect(arcUnits(0.3, 0, 1.7, 1)).toBeCloseTo(1, 9);
    expect(arcUnits(1.95, 0.4, 0.05, 0.4)).toBeCloseTo(arcUnits(0.95, 0.4, 1.05, 0.4), 9);
    // 高纬度同样的经度差，距离更短
    expect(arcUnits(0.9, yOf(60), 1.1, yOf(60))).toBeLessThan(arcUnits(0.9, 0.5, 1.1, 0.5) * 0.51);
  });

  it('沿大圆加密：跨接缝时 x 连续，经过极地附近', () => {
    const line = densify(
      [
        [1.95, yOf(30)],
        [0.05, yOf(30)],
      ],
      0.01,
    );
    for (let k = 1; k < line.length; k++) expect(Math.abs(line[k][0] - line[k - 1][0])).toBeLessThan(0.05);
    expect(line[line.length - 1][0]).toBeCloseTo(2.05, 6);
    // 北纬 45° 上经度相差 180° 的两点：最短的弧经过北极
    const polar = densify(
      [
        [0.5, yOf(45)],
        [1.5, yOf(45)],
      ],
      0.01,
    );
    expect(Math.min(...polar.map((p) => p[1]))).toBeLessThan(0.01);
  });

  it('球面上的圆：每一点到中心的距离都是半径；包住极点时标出来', () => {
    const c = circle(1.2, yOf(50), 0.05);
    expect(c.pole).toBe(0);
    for (const [x, y] of c.pts) expect(arcUnits(1.2, yOf(50), x, y)).toBeCloseTo(0.05, 6);
    expect(circle(1.2, yOf(85), 0.05).pole).toBe(1);
    expect(circle(1.2, yOf(-85), 0.05).pole).toBe(-1);
  });
});

describe('画笔、圈一片：接缝与两极', () => {
  it('圈绕着极点：绕一圈的不为 0；跨接缝的普通圈为 0', () => {
    const around: [number, number][] = [];
    for (let k = 0; k < 36; k++) around.push([k / 18, yOf(80)]);
    expect(Math.abs(ringWinding(around))).toBe(1);
    const seam: [number, number][] = [
      [1.9, 0.4],
      [2.1, 0.4],
      [2.1, 0.5],
      [1.9, 0.5],
    ];
    expect(ringWinding(seam)).toBe(0);
  });

  it('画在接缝上的画笔：两边都涂到，大小与赤道中间的一样', () => {
    const r = 800;
    const a = brushCells(world, 1.999, 0.45, r);
    const b = brushCells(world, 1.0, 0.45, r);
    expect(a.cells.some((c) => mesh.x[c] < 0.5)).toBe(true);
    expect(a.cells.some((c) => mesh.x[c] > 1.5)).toBe(true);
    const area = (cells: number[]) => cells.reduce((s, c) => s + mesh.area[c], 0);
    expect(Math.abs(area(a.cells) - area(b.cells)) / area(b.cells)).toBeLessThan(0.06);
    // 高纬度的画笔也是真实大小（图上横向拉长）
    const hi = brushCells(world, 1.0, yOf(70), r);
    expect(Math.abs(area(hi.cells) - area(b.cells)) / area(b.cells)).toBeLessThan(0.08);
    for (const c of a.cells) expect(arcUnits(1.999, 0.45, mesh.x[c], mesh.y[c]) * world.kmPerUnit).toBeLessThanOrEqual(r + 1e-6);
  });

  it('跨接缝的圈：圈里两边的格都算进来', () => {
    const ring: [number, number][] = [
      [1.92, 0.4],
      [2.08, 0.4],
      [2.08, 0.5],
      [1.92, 0.5],
    ];
    const inside = ringCells(world, ring);
    expect(inside.some((c) => mesh.x[c] < 0.1)).toBe(true);
    expect(inside.some((c) => mesh.x[c] > 1.9)).toBe(true);
    // 圈里的格数与同样大小、放在中间的圈相当
    const mid = ringCells(
      world,
      ring.map(([x, y]) => [x - 1, y]),
    );
    expect(Math.abs(inside.length - mid.length) / mid.length).toBeLessThan(0.1);
    const stroke = lassoStroke(world, ring);
    for (const c of inside) expect(stroke.cells).toContain(c);
  });
});
