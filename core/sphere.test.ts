import { describe, expect, it } from 'vitest';
import { findCell, gradient } from './mesh';
import { buildSphereMesh, nearestCell, tangentBasis, toUnit, viewOf } from './sphere';
import { mulberry32 } from './rng';

// 整个星球的球面网格：几何量、拓扑、查找都要对，接缝和两极也不例外

describe('球面网格', () => {
  const mesh = buildSphereMesh(4000, 7);

  it('格数、面积、邻接、欧拉示性数', () => {
    expect(mesh.n).toBe(4000);
    let sum = 0;
    let amin = Infinity;
    let amax = 0;
    for (let i = 0; i < mesh.n; i++) {
      sum += mesh.area[i];
      amin = Math.min(amin, mesh.area[i]);
      amax = Math.max(amax, mesh.area[i]);
    }
    expect(Math.abs(sum - 4 / Math.PI) / (4 / Math.PI)).toBeLessThan(1e-9);
    expect(amax / amin).toBeLessThan(3);
    // 邻接对称，距离、边长为正，切平面位移的长度等于距离
    for (let i = 0; i < mesh.n; i++) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        let back = -1;
        for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) if (mesh.adj[f] === i) back = f;
        expect(back).toBeGreaterThanOrEqual(0);
        expect(mesh.dist[e]).toBeGreaterThan(0);
        expect(mesh.edgeLen[e]).toBeGreaterThan(0);
        expect(Math.abs(mesh.dist[e] - mesh.dist[back])).toBeLessThan(1e-15);
        expect(Math.abs(Math.hypot(mesh.edx[e], mesh.edy[e]) - mesh.dist[e])).toBeLessThan(1e-12);
      }
      // 相邻的两个邻居彼此也相邻（围成一圈）
      const a = mesh.off[i];
      const b = mesh.off[i + 1];
      for (let k = a; k < b; k++) {
        const u = mesh.adj[k];
        const v = mesh.adj[k + 1 < b ? k + 1 : a];
        let ok = false;
        for (let f = mesh.off[u]; f < mesh.off[u + 1]; f++) if (mesh.adj[f] === v) ok = true;
        expect(ok).toBe(true);
      }
    }
    const V = mesh.n;
    const E = mesh.adj.length / 2;
    const F = mesh.triangles.length / 3;
    expect(V - E + F).toBe(2);
    // 三角形从外面看都是逆时针
    const p = mesh.p;
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const [a, b, c] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
      const det =
        p[3 * a] * (p[3 * b + 1] * p[3 * c + 2] - p[3 * b + 2] * p[3 * c + 1]) -
        p[3 * a + 1] * (p[3 * b] * p[3 * c + 2] - p[3 * b + 2] * p[3 * c]) +
        p[3 * a + 2] * (p[3 * b] * p[3 * c + 1] - p[3 * b + 1] * p[3 * c]);
      expect(det).toBeGreaterThan(0);
    }
    // 没有地图边
    expect(mesh.boundary.every((b) => b === 0)).toBe(true);
    // 显示坐标与单位向量一致
    for (let i = 0; i < mesh.n; i += 37) {
      const [x, y, z] = toUnit(mesh.x[i], mesh.y[i]);
      expect(Math.hypot(x - p[3 * i], y - p[3 * i + 1], z - p[3 * i + 2])).toBeLessThan(1e-9);
    }
  });

  it('同一个种子建出同一个网格', () => {
    const again = buildSphereMesh(4000, 7);
    expect(again.p).toEqual(mesh.p);
    expect(again.adj).toEqual(mesh.adj);
    const other = buildSphereMesh(4000, 8);
    expect(other.p).not.toEqual(mesh.p);
  });

  it('球面上最近的格：与逐个比较的结果相同（包括两极和接缝）', () => {
    const rand = mulberry32(3);
    const brute = (x: number, y: number) => {
      const [qx, qy, qz] = toUnit(x, y);
      let best = 0;
      let bd = -Infinity;
      for (let i = 0; i < mesh.n; i++) {
        const d = mesh.p[3 * i] * qx + mesh.p[3 * i + 1] * qy + mesh.p[3 * i + 2] * qz;
        if (d > bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    let hint = -1;
    for (let k = 0; k < 2000; k++) {
      const x = k % 4 === 0 ? (rand() < 0.5 ? rand() * 0.02 : 2 - rand() * 0.02) : rand() * 2;
      const y = k % 5 === 0 ? (rand() < 0.5 ? rand() * 0.01 : 1 - rand() * 0.01) : rand();
      const got = nearestCell(mesh, x, y, k % 2 ? hint : -1);
      expect(got).toBe(brute(x, y));
      hint = got;
    }
    // x 超出 [0, 2) 时绕回来
    expect(nearestCell(mesh, 2.3, 0.4)).toBe(nearestCell(mesh, 0.3, 0.4));
    expect(nearestCell(mesh, -0.2, 0.6)).toBe(nearestCell(mesh, 1.8, 0.6));
  });

  it('平铺图上的格：与显示三角网上逐个比较的结果相同', () => {
    const view = viewOf(mesh);
    const rand = mulberry32(5);
    for (let k = 0; k < 1500; k++) {
      const x = rand() * 2;
      const y = rand();
      let best = 0;
      let bd = Infinity;
      for (let q = 0; q < view.x.length; q++) {
        const d = (view.x[q] - x) ** 2 + (view.y[q] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      expect(findCell(mesh, x, y, k)).toBe(view.cellOf[best]);
      expect(findCell(mesh, x + 2, y)).toBe(view.cellOf[best]);
    }
    // 保留的三角形把 [0, 2) × [0, 1] 盖满
    let covered = 0;
    const tris = view.triangles;
    for (let k = 0; k < 400; k++) {
      const px = rand() * 2;
      const py = rand();
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
        const d = (view.y[b] - view.y[c]) * (view.x[a] - view.x[c]) + (view.x[c] - view.x[b]) * (view.y[a] - view.y[c]);
        const wa = ((view.y[b] - view.y[c]) * (px - view.x[c]) + (view.x[c] - view.x[b]) * (py - view.y[c])) / d;
        const wb = ((view.y[c] - view.y[a]) * (px - view.x[c]) + (view.x[a] - view.x[c]) * (py - view.y[c])) / d;
        const wc = 1 - wa - wb;
        // 点在三角形里，或在它平移 ±2 的副本里
        const inside = (dx: number) => {
          const qx = px + dx;
          const ua = ((view.y[b] - view.y[c]) * (qx - view.x[c]) + (view.x[c] - view.x[b]) * (py - view.y[c])) / d;
          const ub = ((view.y[c] - view.y[a]) * (qx - view.x[c]) + (view.x[a] - view.x[c]) * (py - view.y[c])) / d;
          return ua >= -1e-9 && ub >= -1e-9 && 1 - ua - ub >= -1e-9;
        };
        void wa;
        void wb;
        void wc;
        if (inside(0) || inside(2) || inside(-2)) {
          covered++;
          break;
        }
      }
    }
    expect(covered).toBe(400);
  });

  it('球面上的梯度：线性场 a·p 的梯度等于 a 在切平面上的分量', () => {
    const a = [0.3, -0.5, 0.8];
    const f = new Float64Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) f[i] = a[0] * mesh.p[3 * i] + a[1] * mesh.p[3 * i + 1] + a[2] * mesh.p[3 * i + 2];
    const errs: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      const [ex, ey, ez, sx, sy, sz] = tangentBasis(mesh.p[3 * i], mesh.p[3 * i + 1], mesh.p[3 * i + 2]);
      // 1 个地图单位是 π 弧度
      const ge = Math.PI * (a[0] * ex + a[1] * ey + a[2] * ez);
      const gs = Math.PI * (a[0] * sx + a[1] * sy + a[2] * sz);
      const [gx, gy] = gradient(mesh, f, i);
      errs.push(Math.hypot(gx - ge, gy - gs) / Math.PI);
    }
    errs.sort((x, y) => x - y);
    expect(errs[Math.floor(errs.length / 2)]).toBeLessThan(0.01);
    expect(errs[errs.length - 1]).toBeLessThan(0.05);
  });

  it('10 万格：建网格不太慢', () => {
    const t0 = performance.now();
    const big = buildSphereMesh(100000, 1);
    const t1 = performance.now();
    viewOf(big);
    const t2 = performance.now();
    console.log(`10 万格球面网格 ${Math.round(t1 - t0)} ms，显示三角网 ${Math.round(t2 - t1)} ms`);
    expect(big.n).toBe(100000);
    expect(t1 - t0).toBeLessThan(3000);
  });
});
