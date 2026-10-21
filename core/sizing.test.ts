import { describe, expect, it } from 'vitest';
import { hashArray } from '../tools/hash';
import { Engine } from './engine';
import { buildMesh } from './mesh';
import { ISLAND_KINDS, defaultIslandKm, islandSizeRangeKm, islandStamp, previewTerrain, resolveTerrain } from './terrain';
import { createWorld } from './world';

// 第三轮：岛的大小连续可调（旧存档照旧逐值重放）；“调整”面板拖滑块时的预览就是松手后的结果

const mesh = buildMesh(40000, 2, 1);

function ocean(rough = 1) {
  const w = createWorld({ cells: mesh.n, seed: 1 }, mesh);
  w.small.terrain.gen = { seed: 1, type: 'ocean', mountains: 1, rerolls: [] };
  w.small.terrain.coastRoughness = rough;
  resolveTerrain(w);
  return w;
}

describe('岛的大小', () => {
  it('旧存档里的小 · 中 · 大照旧逐值重放', () => {
    // 哈希来自改动前的代码：四种岛 × 三档、两条岛链、一个湖
    const eng = new Engine({ seed: 4, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'archipelago' }, reset: true });
    let k = 0;
    for (const kind of ISLAND_KINDS) {
      for (const size of ['small', 'medium', 'large'] as const) {
        try {
          eng.exec({ op: 'add_island', island: { x: 0.2 + (k % 6) * 0.3, y: 0.15 + Math.floor(k / 6) * 0.35, kind, size, variant: k % 3 } });
        } catch {
          // 放不下（已经是陆地）的跳过，改动前也一样
        }
        k++;
      }
    }
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.3, 0.8], [1.0, 0.9], [1.7, 0.75]], kind: 'volcanic', size: 'small', density: 1.4, variant: 2 } });
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.2, 0.6], [0.9, 0.55]], kind: 'continental', size: 'large', density: 0.7, variant: 0 } });
    const w = eng.world;
    // 湖的格写死（存档里的命令就是这样存的），以后改水文也不会挪到别处
    eng.exec({ op: 'add_lake', lake: { cell: 5490, radius: 60, depth: 120, perennial: true } });
    expect({
      landDelta: hashArray(w.causes.landDelta),
      upliftDelta: hashArray(w.causes.upliftDelta),
      land: hashArray(w.causes.land),
      elevation: hashArray(w.derived.elevation),
      discharge: hashArray(w.derived.discharge),
      // 第五轮起不足 3 格的自然洼地不算湖：流量变了，地形、高程不变
    }).toEqual({ landDelta: 'd2ae5e44', upliftDelta: 'cf768e09', land: '78511545', elevation: 'f58c005c', discharge: 'b8650ac7' });
  });

  it('数值大小是海岸线的半径：放出来的岛平均就这么大', () => {
    for (const rough of [0.35, 1, 1.8]) {
      const w = ocean(rough);
      const cellKm = mesh.spacing * w.kmPerUnit;
      const cellArea = (mesh.width * mesh.height * w.kmPerUnit ** 2) / mesh.n;
      for (const kind of ISLAND_KINDS) {
        for (const mult of [4, 10, 24]) {
          const rKm = cellKm * mult;
          const x = 0.5 + mult * 0.04;
          const y = 0.5;
          const s = islandStamp(w, { x, y, kind, size: rKm, variant: mult });
          if (kind === 'atoll') {
            // 环礁量外缘：离中心最远的那 5% 的格
            const dist = s.footprint.map((c) => Math.hypot(mesh.x[c] - x, mesh.y[c] - y) * w.kmPerUnit).sort((a, b) => a - b);
            const outer = dist[Math.floor(dist.length * 0.95)] / rKm;
            expect(outer).toBeGreaterThan(0.85);
            expect(outer).toBeLessThan(1.15);
          } else {
            const eqR = Math.sqrt((s.footprint.length * cellArea) / Math.PI) / rKm;
            expect(eqR).toBeGreaterThan(0.85);
            expect(eqR).toBeLessThan(1.15);
          }
        }
      }
    }
  });

  it('数值大小的岛形状与位置无关：鼠标挪一点，预览的轮廓几乎不变', () => {
    const w = ocean();
    const cell = mesh.spacing;
    const rKm = cell * w.kmPerUnit * 8;
    const a = new Set(islandStamp(w, { x: 0.9, y: 0.5, kind: 'continental', size: rKm, variant: 3 }).footprint);
    // 挪三分之一格：形状跟着走，只有边上个别格因为落点变化而不同
    const b = islandStamp(w, { x: 0.9 + cell / 3, y: 0.5 + cell / 4, kind: 'continental', size: rKm, variant: 3 }).footprint;
    const inter = b.filter((c) => a.has(c)).length;
    expect(inter / (a.size + b.length - inter)).toBeGreaterThan(0.85);
    // 同一个选项再算一次，逐值相同
    expect(islandStamp(w, { x: 0.9, y: 0.5, kind: 'continental', size: rKm, variant: 3 })).toEqual(islandStamp(w, { x: 0.9, y: 0.5, kind: 'continental', size: rKm, variant: 3 }));
  });

  it('默认大小与可调范围随地图尺度变化', () => {
    const w = ocean();
    const [lo, hi] = islandSizeRangeKm(w);
    expect(lo).toBeLessThan(hi);
    const d = defaultIslandKm(w);
    expect(d).toBeGreaterThanOrEqual(lo);
    expect(d).toBeLessThanOrEqual(hi);
  });

  it('数值大小的岛链：确定、可撤销、按世界文件重放结果相同', () => {
    const eng = new Engine({ seed: 2, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true });
    const w = eng.world;
    const before = w.causes.landDelta.slice();
    const r = (islandSizeRangeKm(w)[0] + islandSizeRangeKm(w)[1]) / 6;
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.3, 0.3], [1.2, 0.5], [1.7, 0.8]], kind: 'volcanic', size: r, density: 1, variant: 0 } });
    eng.exec({ op: 'add_island', island: { x: 1.0, y: 0.8, kind: 'atoll', size: r, variant: 1 } });
    const land = hashArray(w.causes.land);
    const replay = Engine.fromDoc(eng.toDoc());
    expect(hashArray(replay.world.causes.land)).toBe(land);
    expect(hashArray(replay.world.derived.elevation)).toBe(hashArray(w.derived.elevation));
    eng.undo();
    eng.undo();
    expect(Array.from(w.causes.landDelta)).toEqual(Array.from(before));
  });

  it('“换个形状”只留一步历史，结果与撤销后重放相同', () => {
    const eng = new Engine({ seed: 2, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true });
    const r = islandSizeRangeKm(eng.world)[1] / 4;
    eng.exec({ op: 'add_island', island: { x: 0.8, y: 0.5, kind: 'volcanic', size: r, variant: 0 } });
    const steps = eng.history.length;
    eng.replaceLast({ op: 'add_island', island: { x: 0.8, y: 0.5, kind: 'volcanic', size: r, variant: 1 } });
    expect(eng.history.length).toBe(steps);
    const other = new Engine({ seed: 2, cells: 12000 });
    other.exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true });
    other.exec({ op: 'add_island', island: { x: 0.8, y: 0.5, kind: 'volcanic', size: r, variant: 1 } });
    expect(hashArray(eng.world.causes.land)).toBe(hashArray(other.world.causes.land));
    expect(hashArray(eng.world.derived.elevation)).toBe(hashArray(other.world.derived.elevation));
  });
});

describe('调整：拖滑块时的预览就是松手后的结果', () => {
  const cases: [string, Record<string, number>][] = [
    ['陆地多少', { landFraction: 0.45 }],
    ['陆地多少（变少）', { landFraction: 0.2 }],
    ['岛多少', { islands: 0.95 }],
    ['山多高', { mountains: 1.8 }],
    ['海岸破碎度', { rough: 1.7 }],
  ];
  for (const [label, patch] of cases) {
    it(label, () => {
      const eng = new Engine({ seed: 3, cells: 12000 });
      eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
      // 先手画一笔，确认用户的编辑也算在预览里
      const w = eng.world;
      const sea = [...Array(w.mesh.n).keys()].filter((i) => !w.causes.land[i]).slice(500, 560);
      eng.exec({ op: 'paint_land', cells: sea, t: sea.map(() => 0.2), mode: 'land' });
      const p = previewTerrain(w, patch);
      const before = w.causes.land.slice();
      const gen = w.small.terrain.gen!;
      if (patch.rough !== undefined) eng.exec({ op: 'set_coast_style', roughness: patch.rough });
      else eng.exec({ op: 'set_worldgen', params: { ...gen, ...patch } });
      const gained: number[] = [];
      const lost: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) {
        if (w.causes.land[i] && !before[i]) gained.push(i);
        if (!w.causes.land[i] && before[i]) lost.push(i);
      }
      expect(p.gained).toEqual(gained);
      expect(p.lost).toEqual(lost);
      if (patch.landFraction || patch.rough) expect(gained.length + lost.length).toBeGreaterThan(0);
    });
  }
});
