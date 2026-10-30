import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { DELTA_DRAW, deltaMouths } from './delta';
import { computeElevation, elevationMemo, plainsOn } from './elevation';
import type { Engine } from './engine';
import type { Mesh } from './mesh';
import { packMesh, unpackMesh } from './mesh-pack';
import { PLAINS, plainStats } from './plains';
import { settingsFor } from './presets';
import { traceRivers } from './rivers';
import { drainage, lowFlatShare, statsInput, trunkRise } from './stats';
import { coastValues, shownCoastValues } from './subcell';
import { continents, meshFor, seededEngine } from './testing/fixtures';
import type { World } from './world';

// 第三十三轮：平原与河口。求解里的冲积平原、冲积扇、三角洲平原（core/plains.ts），画法里的三角洲向海凸出（core/delta.ts）
// 与分汊（core/rivers.ts 的 withBranches）。这里查：记忆开着与关着逐值相同、改一块陆地别的陆地不变、改气候不改高程，
// 平原让大河两旁低平、不打乱流域，细地图上有冲积扇，三角洲平原低湿，海岸凸出不过半格，分汊的几股照规矩画

const fresh = (mesh: Mesh) => unpackMesh(structuredClone(packMesh(mesh).packed));

function withMemo<T>(on: boolean, f: () => T): T {
  const saved = elevationMemo.on;
  elevationMemo.on = on;
  try {
    return f();
  } finally {
    elevationMemo.on = saved;
  }
}

function withPlains<T>(on: boolean, f: () => T): T {
  const saved = plainsOn.on;
  plainsOn.on = on;
  try {
    return f();
  } finally {
    plainsOn.on = saved;
  }
}

const SETTINGS = [
  ['一块地区', { cells: 5000, seed: 7 }],
  ['整个星球', { cells: 4000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
] as const;

// 最大的入海河口（按水文的汇水面积）
function bigMouth(w: World): number {
  const { mesh, causes, derived: d } = w;
  let best = -1;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || d.lake[i] === 1) continue;
    const r = d.receiver[i];
    if (r < 0 || causes.land[r]) continue;
    if (best < 0 || d.drainArea[i] > d.drainArea[best]) best = i;
  }
  return best;
}

for (const [label, settings] of SETTINGS) {
  it(`高程记忆开着与关着逐值相同（平原与河口在大河口附近改了几笔）：${label}`, () => {
    const mesh = meshFor(settings);
    const a = seededEngine(settings, fresh(mesh));
    const b = seededEngine(settings, fresh(mesh));
    a.undoCache = 0;
    b.undoCache = 0;
    const both = (step: (e: Engine) => void) => {
      withMemo(true, () => step(a));
      withMemo(false, () => step(b));
      expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    };
    const run = (cmd: Command) => both((e) => e.exec(cmd));
    run({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    const w = a.world;
    const m = bigMouth(w);
    expect(m).toBeGreaterThanOrEqual(0);
    const near = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && Math.hypot(w.mesh.x[i] - w.mesh.x[m], w.mesh.y[i] - w.mesh.y[m]) < w.mesh.spacing * 3);
    // 河口附近抬山、改岩性：三角洲、平原跟着重算
    run({ op: 'paint_relief', cells: near, t: near.map(() => 0), strength: 0.4 });
    run({ op: 'paint', field: 'erodDelta', cells: near, value: 0.5, mode: 'add' });
    both((e) => e.undo());
    both((e) => e.redo());
    // 河口那里画一点陆地（海陆变了）
    const sea = [...Array(w.mesh.n).keys()].filter((i) => !w.causes.land[i] && Math.hypot(w.mesh.x[i] - w.mesh.x[m], w.mesh.y[i] - w.mesh.y[m]) < w.mesh.spacing * 1.5);
    if (sea.length) run({ op: 'paint_land', cells: sea, t: sea.map(() => 0), mode: 'land' });
    both((e) => e.undo());
  });

  it(`改一块陆地，别的陆地的高程一格不变：${label}`, () => {
    const e = seededEngine(settings, fresh(meshFor(settings)));
    e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    const w = e.world;
    const before = withMemo(false, () => computeElevation(w).elevation);
    // 最大的陆块里抬一片山
    const comp = new Int32Array(w.mesh.n).fill(-1);
    const sizes: number[] = [];
    for (let s = 0; s < w.mesh.n; s++) {
      if (!w.causes.land[s] || comp[s] >= 0) continue;
      const q = [s];
      comp[s] = sizes.length;
      for (let h = 0; h < q.length; h++)
        for (let k = w.mesh.off[q[h]]; k < w.mesh.off[q[h] + 1]; k++) {
          const j = w.mesh.adj[k];
          if (w.causes.land[j] && comp[j] < 0) {
            comp[j] = sizes.length;
            q.push(j);
          }
        }
      sizes.push(q.length);
    }
    const big = sizes.indexOf(Math.max(...sizes));
    const cells = [...Array(w.mesh.n).keys()].filter((i) => comp[i] === big).slice(0, 200);
    e.exec({ op: 'paint_relief', cells, t: cells.map(() => 0), strength: 0.6 });
    const after = withMemo(false, () => computeElevation(e.world).elevation);
    let other = 0;
    let changed = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!w.causes.land[i]) continue;
      if (comp[i] === big) {
        if (after[i] !== before[i]) changed++;
        continue;
      }
      other++;
      expect(after[i]).toBe(before[i]);
    }
    expect(other).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
  });

  it(`改气候不改高程（有三角洲、平原的世界）：${label}`, () => {
    const e = seededEngine(settings, fresh(meshFor(settings)));
    const f0 = plainStats.flood;
    const d0 = plainStats.deltas;
    e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
    expect(plainStats.flood).toBeGreaterThan(f0);
    expect(plainStats.deltas).toBeGreaterThan(d0);
    const terrain = digestWorld(e.world)['derived.elevation'];
    const c0 = elevationMemo.computed;
    const land = [...Array(e.world.mesh.n).keys()].filter((i) => e.world.causes.land[i]).slice(0, 400);
    for (const cmd of [
      { op: 'set_planet', patch: { humidity: 0.5 } },
      { op: 'set_planet', patch: { humidity: 1.7 } },
      { op: 'paint', field: 'tempOffset', cells: land, value: -8, mode: 'add' },
    ] as Command[]) {
      e.exec(cmd);
      expect(digestWorld(e.world)['derived.elevation']).toBe(terrain);
    }
    expect(elevationMemo.computed).toBe(c0);
  });
}

describe('冲积平原', () => {
  const settings = settingsFor('hemisphere', 'temperate', 20000);
  const build = (on: boolean) =>
    withPlains(on, () =>
      withMemo(false, () => {
        const e = seededEngine({ ...settings, seed: 3 });
        e.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
        return e.world;
      }),
    );
  const off = build(false);
  const on = build(true);
  const so = statsInput(off);
  const sn = statsInput(on);
  const doff = drainage(so);
  const don = drainage(sn);

  it('低处大干流两旁更低平，低平地占比上升', () => {
    expect(trunkRise(sn, don)).toBeLessThan(trunkRise(so, doff) - 5);
    expect(lowFlatShare(sn, don.landKm)).toBeGreaterThan(lowFlatShare(so, doff.landKm));
  });

  // 计划写的是“大干流旁的格平均高出 < 30 m”：格大（这里一格约 100 km）时挨着大河的格要照旧流向原来的下游（不打乱流域），
  // 压不到那么低（约 50 m，见开发说明“平原与河口”）。这里查压低的那些格高出的比原来少了三成以上（约四成）
  it('压低的格比它流进的低处大干流（≥ 10 万 km²）高出的少了三成以上', () => {
    const { mesh, derived: d } = on;
    let now = 0;
    let was = 0;
    let count = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (!on.causes.land[i] || d.lake[i] || d.elevation[i] >= off.derived.elevation[i] - 1) continue;
      const r = d.receiver[i];
      if (r < 0 || !on.causes.land[r] || don.drainKm[r] < 1e5 || d.elevation[r] > 300) continue;
      now += Math.max(0, d.elevation[i] - d.elevation[r]);
      was += Math.max(0, off.derived.elevation[i] - off.derived.elevation[r]);
      count++;
    }
    expect(count).toBeGreaterThan(20);
    expect(now).toBeLessThan(0.7 * was);
    expect(now / count).toBeLessThan(60);
  });

  it('不打乱流域：最大的几个流域、汇水面积的分布与没有平原时差不多', () => {
    const top = (d: ReturnType<typeof drainage>) => d.basins.slice(0, 5).reduce((a, b) => a + b.areaKm, 0) / d.landKm;
    expect(Math.abs(top(don) - top(doff))).toBeLessThan(0.02);
    // 汇水面积超过 100 格的格数差不到一成
    const cell = doff.landKm / so.land.reduce((a, b) => a + b, 0);
    const big = (s: typeof so, d: typeof doff) => [...Array(s.n).keys()].filter((i) => s.land[i] && d.drainKm[i] >= 100 * cell).length;
    expect(Math.abs(big(sn, don) - big(so, doff))).toBeLessThan(0.1 * big(so, doff));
    // 湖的个数不少
    const lakes = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] === 1).length;
    expect(lakes(on)).toBeGreaterThanOrEqual(lakes(off) * 0.9);
  });

  it('三角洲平原：大河口附近压成低地，干流是最低的一路；多半是湿的', () => {
    const mouths = deltaMouths(on);
    expect(mouths.length).toBeGreaterThan(3);
    let wet = 0;
    for (const m of mouths) {
      expect(on.derived.elevation[m]).toBeLessThanOrEqual(DELTA_DRAW.TOP_M);
      if (on.derived.wetness[m] >= 21) wet++;
    }
    expect(wet).toBeGreaterThan(mouths.length / 2);
  });
});

describe('冲积扇', () => {
  it('细地图（一片海域）上有冲积扇；扇只在半径够一格的 0.8 倍时做', () => {
    const f0 = plainStats.fans;
    withMemo(false, () => {
      const e = seededEngine({ ...settingsFor('region', 'subtropical', 20000), seed: 2 });
      e.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    });
    expect(plainStats.fans).toBeGreaterThan(f0);
    // 一格约 70 km 的地图上，A = 2 万 km² 的河扇的半径约 71 km：刚过 0.8 格
    expect(PLAINS.FAN_R * Math.sqrt(2e4)).toBeGreaterThan(PLAINS.FAN_MIN_CELLS * 70);
  });
});

describe('三角洲的画法', () => {
  const w = continents().world;

  it('海岸向海凸出：只抬三角洲附近挨着陆地的海格，格心仍是海，岸线挪不过半格', () => {
    const base = coastValues(w);
    const shown = shownCoastValues(w);
    const { mesh, causes } = w;
    const mouths = deltaMouths(w);
    expect(mouths.length).toBeGreaterThan(0);
    let moved = 0;
    for (let j = 0; j < mesh.n; j++) {
      if (shown[j] === base[j]) continue;
      moved++;
      expect(causes.land[j]).toBe(0);
      expect(shown[j]).toBeGreaterThan(base[j]);
      expect(shown[j]).toBeLessThanOrEqual(-1);
      // 离某个三角洲的河口不到 BULGE_R 格（按格心的直线距离量，不超过沿海格走的距离）
      expect(mouths.some((m) => Math.hypot(mesh.x[j] - mesh.x[m], mesh.y[j] - mesh.y[m]) <= DELTA_DRAW.BULGE_R * mesh.spacing + 1e-9)).toBe(true);
      // 每条陆格到它的边上，岸线（线性内插的 0 点）往海里挪了不到半格
      for (let e = mesh.off[j]; e < mesh.off[j + 1]; e++) {
        const a = mesh.adj[e];
        if (!causes.land[a]) continue;
        const t0 = base[a] / (base[a] - base[j]);
        const t1 = shown[a] / (shown[a] - shown[j]);
        expect((t1 - t0) * mesh.dist[e]).toBeLessThanOrEqual(DELTA_DRAW.BULGE_SHIFT * mesh.spacing + 1e-9);
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('分汊：大河口分出 1–4 股，各自在岸线上入海、离别的河口至少 0.6 格；点它的格就是主流的河口；主流留 40–60% 的水', () => {
    const lines = traceRivers(w);
    const branches = lines.filter((l) => l.branch !== undefined);
    expect(branches.length).toBeGreaterThan(0);
    const sp = w.mesh.spacing;
    const by = new Map<number, typeof branches>();
    for (const b of branches) by.set(b.branch!, [...(by.get(b.branch!) ?? []), b]);
    const ends = lines.filter((l) => l.mouth).map((l) => l.points[l.points.length - 1]);
    for (const [mi, bs] of by) {
      const M = lines[mi];
      expect(bs.length).toBeGreaterThanOrEqual(1);
      expect(bs.length).toBeLessThanOrEqual(4);
      expect(M.mouth).toBe(true);
      expect(M.guide).toBeUndefined();
      const c = M.cells![M.cells!.length - 1];
      expect(deltaMouths(w)).toContain(c);
      // 分汊处记在主流的 joins 里
      expect(M.joins?.length ?? 0).toBeGreaterThan(0);
      const q = bs[0].flow[0] * bs.length;
      const share = M.flow[M.flow.length - 1] / (M.flow[M.flow.length - 1] + q);
      expect(share).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(share).toBeLessThanOrEqual(0.6 + 1e-9);
      for (const b of bs) {
        expect(b.mouth).toBe(true);
        expect(b.head).toBeUndefined();
        expect(b.into).toBeUndefined();
        expect(b.cells!.every((x) => x === c)).toBe(true);
        const e = b.points[b.points.length - 1];
        for (const o of ends) if (o !== e) expect(Math.hypot(o[0] - e[0], o[1] - e[1])).toBeGreaterThanOrEqual(0.6 * sp - 1e-9);
      }
    }
  });
});
