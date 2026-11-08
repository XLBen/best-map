import { describe, expect, it } from 'vitest';
import { digest } from './digest';
import { MAP_UNDER_SHORE, drawTypes, packRivers, riverDraw, riverDrawStats, riversId, worldRivers } from './river-pack';
import { traceRivers } from './rivers';
import { engineFor } from './testing/fixtures';
import type { World } from './world';

// 第八十八轮（提速）：Worker 描好的河记最近几份（core/river-pack.ts 的 ensureRivers）：撤销、重做回到前几步时照用那一份（不重描），
// 与不走缓存重新描的逐位相同；接着再改一笔时带子的记忆换成刚才照用的那一份的（多数的线照旧不重算）

function packedDigest(p: ReturnType<typeof worldRivers>): string[] {
  const r = p.rb!;
  return [p.meta, p.pts, p.flow, p.cells, p.mul, p.type, p.joins, r.count, r.x, r.y, r.s, r.nx, r.ny, r.hw, r.src, r.box, r.tag].map((a) => digest(a));
}

function fresh(w: World): string[] {
  const thr = w.small.planet.riverThreshold;
  const types = drawTypes(w);
  const copy: World = { ...w, derived: { ...w.derived, elevation: w.derived.elevation.slice() } };
  const lines = traceRivers(copy);
  const draws = lines.map((l) => riverDraw(l, thr, w.mesh.spacing, types, 1, MAP_UNDER_SHORE));
  return packedDigest(packRivers(lines, draws, { thr, spacing: w.mesh.spacing, types: '' }));
}

describe('描好的河记几份：撤销、重做时照用', () => {
  it('回到前几步时是那时的同一份，与重新描的逐位相同；接着改一笔时多数的线不用重算', () => {
    const eng = engineFor({ seed: 3, cells: 12000, latNorth: 70, latSouth: 20 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    const w = eng.world;
    const land: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i]) land.push(i);
    const near = (c: number, r: number) => land.filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < r * w.mesh.spacing);
    const a = near(land[land.length >> 1], 5);
    const ids: number[] = [riversId(w)];
    const digests: string[][] = [packedDigest(worldRivers(w))];
    const cmds = [
      { op: 'paint', field: 'tempOffset', cells: a, values: a.map(() => -6), mode: 'add' },
      { op: 'paint_relief', cells: a, t: a.map(() => 0), strength: 0.7 },
      { op: 'set_planet', patch: { latShift: 3 } },
    ] as const;
    for (const c of cmds) {
      eng.exec(c as never);
      ids.push(riversId(w));
      digests.push(packedDigest(worldRivers(w)));
      expect(digests[digests.length - 1]).toEqual(fresh(w));
    }
    expect(new Set(ids).size).toBe(ids.length);
    // 撤销三次、重做一次：每一步都是那时的同一份（编号相同），内容与重新描的相同
    for (let k = cmds.length - 1; k >= 0; k--) {
      eng.undo();
      expect(riversId(w)).toBe(ids[k]);
      const d = packedDigest(worldRivers(w));
      expect(d).toEqual(digests[k]);
      expect(d).toEqual(fresh(w));
    }
    eng.redo();
    expect(riversId(w)).toBe(ids[1]);
    expect(packedDigest(worldRivers(w))).toEqual(fresh(w));
    // 撤销后接着改一小块：带子的记忆是刚才那一份的，多数的线照用
    riverDrawStats.hit = 0;
    riverDrawStats.miss = 0;
    const b = near(land[land.length >> 2], 4);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: b, values: b.map(() => 1), mode: 'add' });
    expect(packedDigest(worldRivers(w))).toEqual(fresh(w));
    expect(riverDrawStats.hit).toBeGreaterThan(riverDrawStats.miss);
  }, 120000);
});
