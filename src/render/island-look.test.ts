import { describe, expect, it } from 'vitest';

import type { World } from '../../core/world';
import { type ColorOptions, cellLayers, lithLayer, shoreElevation } from './colors';
import { LITH_LAND_GLSL, packElevation } from './renderer';
import { seededEngine } from '../../core/testing/fixtures';

// 第十三轮修：陡的小岛四周不再有一圈多边形的浅水（水深只来自水面格）；几种岛大到两百公里也一眼分得出

const opts: ColorOptions = { mode: 'terrain', season: 'annual', focusSpecies: null, borders: false };

function islands(humidity: number): { w: World; centers: number[] } {
  const eng = seededEngine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
  const centers = [0.6, 1.0, 1.4];
  // 第十四轮去掉了火山岛：第一个换成自己选了暗色的岛（颜色在 CPU 上混进陆地的底色）
  eng.exec({ op: 'set_island_type', type: { id: 'dark', name: '黑岛', shape: 'round', height: 'high', color: '#3d3a38' } });
  (['dark', 'continental', 'low'] as const).forEach((kind, k) => eng.exec({ op: 'add_island', island: { x: centers[k], y: 0.5, kind, size: 100, variant: 2 } }));
  eng.exec({ op: 'set_planet', patch: { humidity } });
  return { w: eng.world, centers };
}

describe('水深只来自水面格', () => {
  it('陆地格的“水面高程”是挨着它的水面格里最浅的（至多 −2 m），水面格是自己的高程', () => {
    const eng = seededEngine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
    // 陡的小火山岛：陆地上千米、四周是深海
    eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'continental', size: 30, variant: 1 } });
    const w = eng.world;
    const L = cellLayers(w, opts);
    const { mesh } = w;
    let coastal = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (L.coast[i] <= 0) {
        expect(L.shore![i]).toBe(L.elevation[i]);
        continue;
      }
      let best = -Infinity;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (L.coast[mesh.adj[e]] <= 0) best = Math.max(best, L.elevation[mesh.adj[e]]);
      expect(L.shore![i]).toBeLessThanOrEqual(-2);
      if (Number.isFinite(best)) {
        coastal++;
        expect(L.shore![i]).toBe(Math.fround(Math.min(-2, best)));
        // 不会比挨着的海浅：陆地的高程不再插值进水里
        expect(L.shore![i]).toBeLessThanOrEqual(Math.max(-2, best));
      }
    }
    expect(coastal).toBeGreaterThan(5);
    // 打包给着色器的第二个通道
    const out = new Float32Array(mesh.n * 2);
    packElevation(out, L.elevation, L.coast, L.shore!, 0, mesh.n);
    for (let i = 0; i < mesh.n; i++) expect(out[2 * i + 1]).toBe(L.coast[i] <= 0 ? L.elevation[i] : L.shore![i]);
    // 没给时陆地按 −2 m
    expect(shoreElevation(mesh, new Float32Array(mesh.n).fill(5), L.elevation).every((v) => v === -2)).toBe(true);
  });
});

// 着色器里岛的样子那一段（LITH_LAND_GLSL）的 JS 版：按格算陆地的底色（不含晕渲、细节；自己选的颜色已经在 smooth 里）
type V3 = [number, number, number];
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function landColor(col: V3, lith: number[], hh: number, sandy: number): V3 {
  const lowK = 1 - sstep(20, 160, hh);
  let c = col;
  const soft = mix3([0.36, 0.5, 0.42], [0.9, 0.85, 0.68], sstep(0.15, 0.6, sandy));
  c = mix3(c, soft, lith[1] * lowK * 0.8);
  return c;
}
function lab(c: V3): V3 {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = c.map((v) => f(Math.min(1, Math.max(0, v))));
  const h = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = h((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const Y = h(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const Z = h((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const dE = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('几种岛大到两百公里也分得出', () => {
  it('JS 版与着色器用的是同样的数', () => {
    // 第十四轮：没有玄武岩了
    expect(LITH_LAND_GLSL).not.toContain('basalt');
    expect(LITH_LAND_GLSL).toContain('mix(vec3(0.36, 0.50, 0.42), vec3(0.90, 0.85, 0.68), smoothstep(0.15, 0.6, vLandCol.a))');
    expect(LITH_LAND_GLSL).toContain('col = mix(col, soft, vLith.g * lowK * 0.8);');
  });

  for (const [name, humidity] of [
    ['稀树草原', 0.6],
    ['森林', 1.6],
  ] as const) {
    it(`${name}：自己选了颜色的岛、大陆岛、低平岛的平均颜色两两 ΔE ≥ 15`, () => {
      const { w, centers } = islands(humidity);
      const L = cellLayers(w, opts);
      const lith = lithLayer(w);
      const { mesh, causes, derived: d } = w;
      const avg = centers.map((cx) => {
        const sum: V3 = [0, 0, 0];
        let n = 0;
        for (let i = 0; i < mesh.n; i++) {
          if (!causes.land[i] || d.lake[i] || Math.abs(mesh.x[i] - cx) > 0.2) continue;
          const col: V3 = [L.smooth[4 * i] / 255, L.smooth[4 * i + 1] / 255, L.smooth[4 * i + 2] / 255];
          const c = landColor(col, [lith[4 * i] / 255, lith[4 * i + 1] / 255], d.elevation[i], L.smooth[4 * i + 3] / 255);
          for (let k = 0; k < 3; k++) sum[k] += c[k];
          n++;
        }
        return lab([sum[0] / n, sum[1] / n, sum[2] / n]);
      });
      expect(dE(avg[0], avg[1]), '黑岛 / 大陆岛').toBeGreaterThanOrEqual(15);
      expect(dE(avg[0], avg[2]), '黑岛 / 低平岛').toBeGreaterThanOrEqual(15);
      expect(dE(avg[1], avg[2]), '大陆岛 / 低平岛').toBeGreaterThanOrEqual(15);
    });
  }
});
