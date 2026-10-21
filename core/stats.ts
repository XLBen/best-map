import type { World } from './world';

// 地形的统计量，用于检验生成结果是否符合真实世界的分布规律（测试与 tools/terrain-stats.ts 共用）
export interface TerrainStats {
  landFraction: number;
  landmasses: number;
  // 最大陆块占全部陆地面积的比例
  largestShare: number;
  // 除最大的几块大陆之外的陆块（面积小于最大陆块 5%）
  islands: number;
  // 岛屿面积累积分布 N(>A) ∝ A^-k 的拟合指数
  powerLawK: number;
  // 海岸边数 / 等面积圆的周长（以格边计）
  coastRoughness: number;
  // 每个陆块的面积（格数），从大到小
  sizes: number[];
}

export function landmassSizes(world: World): number[] {
  const { mesh, causes } = world;
  const comp = new Int32Array(mesh.n).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || comp[i] >= 0) continue;
    const q = [i];
    comp[i] = sizes.length;
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) {
        const b = mesh.adj[e];
        if (causes.land[b] && comp[b] < 0) {
          comp[b] = sizes.length;
          q.push(b);
        }
      }
    }
    sizes.push(q.length);
  }
  return sizes.sort((a, b) => b - a);
}

export function terrainStats(world: World): TerrainStats {
  const { mesh, causes } = world;
  const sizes = landmassSizes(world);
  const land = sizes.reduce((a, b) => a + b, 0);
  let coastEdges = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) coastEdges++;
  }
  const islandSizes = sizes.filter((s) => s < (sizes[0] ?? 0) * 0.05);
  return {
    landFraction: land / mesh.n,
    landmasses: sizes.length,
    largestShare: land ? sizes[0] / land : 0,
    islands: islandSizes.length,
    powerLawK: fitPowerLaw(islandSizes),
    coastRoughness: land ? coastEdges / (2 * Math.sqrt(Math.PI * land)) : 0,
    sizes,
  };
}

// 对 log N(>A) ~ -k log A 做最小二乘（只用 A ≥ 2 的点，单格岛受格子离散影响太大）
export function fitPowerLaw(sizes: number[]): number {
  const s = sizes.filter((a) => a >= 2).sort((a, b) => b - a);
  if (s.length < 8) return NaN;
  const xs: number[] = [];
  const ys: number[] = [];
  s.forEach((a, k) => {
    if (k > 0 && s[k - 1] === a) return;
    xs.push(Math.log(a));
    ys.push(Math.log(k + 1));
  });
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
  }
  return sxx > 0 ? -sxy / sxx : NaN;
}
