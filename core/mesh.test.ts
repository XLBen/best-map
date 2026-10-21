import { describe, expect, it } from 'vitest';
import { buildMesh } from './mesh';

describe('mesh', () => {
  const mesh = buildMesh(4000, 2, 1);

  it('邻接对称且边长为正', () => {
    for (let i = 0; i < mesh.n; i++) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        let back = false;
        for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) if (mesh.adj[f] === i) back = true;
        expect(back).toBe(true);
        expect(mesh.edgeLen[e]).toBeGreaterThan(0);
      }
    }
  });

  it('格面积之和等于地图面积', () => {
    const total = mesh.area.reduce((s, a) => s + a, 0);
    expect(total).toBeCloseTo(2, 3);
  });

  it('格数接近请求值', () => {
    expect(Math.abs(mesh.n - 4000) / 4000).toBeLessThan(0.05);
  });
});
