// 地形统计：陆块数、最大陆块占比、岛数、岛屿大小的幂律指数、海岸粗糙度
// npx tsx tools/terrain-stats.ts [cells] [seeds]
import { WORLD_TYPES } from '../core/generate';
import { buildMesh } from '../core/mesh';
import { terrainStats } from '../core/stats';
import { resolveTerrain } from '../core/terrain';
import { createWorld } from '../core/world';

const cells = Number(process.argv[2] ?? 40000);
const seeds = Number(process.argv[3] ?? 4);
const mesh = buildMesh(cells, 2, 1);
for (const type of WORLD_TYPES) {
  for (let seed = 1; seed <= seeds; seed++) {
    const w = createWorld({ cells, seed: 1 }, mesh);
    w.small.terrain.gen = { seed, type, mountains: 1, rerolls: [] };
    const t0 = performance.now();
    resolveTerrain(w);
    const ms = performance.now() - t0;
    const s = terrainStats(w);
    console.log(
      type.padEnd(12),
      `seed ${seed}`,
      `land ${(s.landFraction * 100).toFixed(0)}%`.padEnd(9),
      `masses ${s.landmasses}`.padEnd(11),
      `largest ${(s.largestShare * 100).toFixed(0)}%`.padEnd(12),
      `islands ${s.islands}`.padEnd(12),
      `k ${Number.isFinite(s.powerLawK) ? s.powerLawK.toFixed(2) : '—'}`.padEnd(7),
      `rough ${s.coastRoughness.toFixed(1)}`.padEnd(10),
      `${ms.toFixed(0)} ms`,
    );
  }
}
