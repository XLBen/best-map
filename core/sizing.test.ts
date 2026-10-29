import { describe, expect, it } from 'vitest';
import { hashArray } from '../tools/hash';
import { type Command, commandSchema } from './commands';
import { lakeArea } from './elevation';
import { Engine } from './engine';
import { hashString } from './names';
import { buildMesh, findCell, ringDistance } from './mesh';
import { planetSettings, settingsFor } from './presets';
import { brushCells } from './select';
import { buildSphereMesh } from './sphere';

import {
  brushRangeKm,
  chainIslands,
  combineStamps,
  defaultIslandKm,
  islandSizeRangeKm,
  islandStamp,
  lakeRangeKm,
  roundKm,
  sizeText,
  previewTerrain,
  reachRangeKm,
  resolveTerrain,
} from './terrain';
import { continents, meshFor, seededEngine, seededWorld } from './testing/fixtures';
import { type Settings, settingsSchema } from './world';
import { BUILTIN_ISLAND_TYPES } from './packs/base';

// 第三轮：岛的大小连续可调；“调整”面板拖滑块时的预览就是松手后的结果
// 第八轮：岛、湖、画笔的最小值更小；小礁。第九轮：岛的大小只收 km 数，湖、岛链只有新的下限

const mesh = buildMesh(40000, 2, 1);

// 有形状的内置岛（小礁只占一格）。第十四轮去掉了火山岛；第十八轮的碎岛不长出陆地（见 shards.test.ts）
const SHAPED_KINDS = BUILTIN_ISLAND_TYPES.filter((t) => t.shape !== 'cell' && t.shape !== 'frag').map((t) => t.id);

function ocean(rough = 1) {
  const w = seededWorld({ cells: mesh.n, seed: 1 }, mesh);
  w.small.terrain.gen = { seed: 1, type: 'ocean', mountains: 1, rerolls: [] };
  w.small.terrain.coastRoughness = rough;
  resolveTerrain(w);
  return w;
}

describe('岛的大小', () => {
  it('放岛、岛链、湖的固定哈希', () => {
    // 四种岛 × 三种大小（约等于以前的小 · 中 · 大）、两条岛链、一个湖。第九轮去掉旧存档兼容时重录；之后的优化必须逐值不变
    // 第十二轮修：岛链不并进原有的岛（太近时缩小、岛心在陆地上的不放），有意改变结果，重录
    // 第十三轮：每种岛有岩性（erodDelta，多记一项）、火山岛抬升减半并有火山口、珊瑚岛的潟湖两头都改、最小的岛一格，有意改变结果，重录
    // 第十三轮修：珊瑚岛的潟湖不再压低原来的陆地、放岛的轮廓按小块海并回陆地的规则算、火山岛的高度按大小定，重录
    const eng = seededEngine({ seed: 4, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'archipelago' }, reset: true });
    let k = 0;
    for (const kind of SHAPED_KINDS) {
      for (const size of [370, 810, 1660]) {
        try {
          eng.exec({ op: 'add_island', island: { x: 0.2 + (k % 6) * 0.3, y: 0.15 + Math.floor(k / 6) * 0.35, kind, size, variant: k % 3 } });
        } catch {
          // 放不下（已经是陆地）的跳过
        }
        k++;
      }
    }
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.3, 0.8], [1.0, 0.9], [1.7, 0.75]], kind: 'continental', size: 370, density: 1.4, variant: 2 } });
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.2, 0.6], [0.9, 0.55]], kind: 'continental', size: 1660, density: 0.7, variant: 0 } });
    const w = eng.world;
    // 湖的格写死，以后改水文也不会挪到别处
    eng.exec({ op: 'add_lake', lake: { cell: 5490, radius: 60, depth: 120, perennial: true } });
    expect({
      landDelta: hashArray(w.causes.landDelta),
      upliftDelta: hashArray(w.causes.upliftDelta),
      erodDelta: hashArray(w.causes.erodDelta),
      land: hashArray(w.causes.land),
      elevation: hashArray(w.derived.elevation),
      discharge: hashArray(w.derived.discharge),
    }).toEqual({ landDelta: '8e725bfc', upliftDelta: 'de566817', erodDelta: '9989d588', land: '1ad11545', elevation: '79dfd765', discharge: '12f31e2a' });
  });

  it('数值大小是海岸线的半径：放出来的岛平均就这么大', () => {
    for (const rough of [0.35, 1, 1.8]) {
      const w = ocean(rough);
      const cellKm = mesh.spacing * w.kmPerUnit;
      const cellArea = (mesh.width * mesh.height * w.kmPerUnit ** 2) / mesh.n;
      for (const kind of SHAPED_KINDS) {
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
    const eng = seededEngine({ seed: 2, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true });
    const w = eng.world;
    const before = w.causes.landDelta.slice();
    const r = (islandSizeRangeKm(w)[0] + islandSizeRangeKm(w)[1]) / 6;
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.3, 0.3], [1.2, 0.5], [1.7, 0.8]], kind: 'continental', size: r, density: 1, variant: 0 } });
    eng.exec({ op: 'add_island', island: { x: 1.0, y: 0.8, kind: 'atoll', size: r, variant: 1 } });
    const land = hashArray(w.causes.land);
    const replay = Engine.fromDoc(eng.toDoc());
    expect(hashArray(replay.world.causes.land)).toBe(land);
    expect(hashArray(replay.world.derived.elevation)).toBe(hashArray(w.derived.elevation));
    eng.undo();
    eng.undo();
    expect(Array.from(w.causes.landDelta)).toEqual(Array.from(before));
  });

  it('换掉最后一步（replaceLast）只留一步历史，结果与撤销后重放相同', () => {
    const eng = seededEngine({ seed: 2, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true });
    const r = islandSizeRangeKm(eng.world)[1] / 4;
    eng.exec({ op: 'add_island', island: { x: 0.8, y: 0.5, kind: 'continental', size: r, variant: 0 } });
    const steps = eng.history.length;
    eng.replaceLast({ op: 'add_island', island: { x: 0.8, y: 0.5, kind: 'continental', size: r, variant: 1 } });
    expect(eng.history.length).toBe(steps);
    const other = seededEngine({ seed: 2, cells: 12000 });
    other.exec({ op: 'set_worldgen', params: { seed: 2, type: 'ocean' }, reset: true });
    other.exec({ op: 'add_island', island: { x: 0.8, y: 0.5, kind: 'continental', size: r, variant: 1 } });
    expect(hashArray(eng.world.causes.land)).toBe(hashArray(other.world.causes.land));
    expect(hashArray(eng.world.derived.elevation)).toBe(hashArray(other.world.derived.elevation));
  });
});

describe('放岛只在岛的附近找格', () => {
  it('固定哈希（地图边上、接缝、高纬度）', () => {
    // 原来按第八轮改动前（全图扫描）的代码记下；第九轮去掉“小 · 中 · 大”三档时重录；
    // 第十三轮火山岛的抬升、珊瑚岛的潟湖（两头都改、环与潟湖里的海格也进 cells）改了，重录
    // 第十三轮修：潟湖不再压低原来的陆地、轮廓按小块海并回陆地的规则算，重录
    const planet = seededWorld({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, buildSphereMesh(3000, 1));
    planet.small.terrain.gen = { seed: 1, type: 'archipelago', mountains: 1, rerolls: [] };
    resolveTerrain(planet);
    const land = seededWorld({ cells: mesh.n, seed: 1 }, mesh);
    land.small.terrain.gen = { seed: 2, type: 'archipelago', mountains: 1, rerolls: [] };
    resolveTerrain(land);
    const got: Record<string, string> = {};
    for (const [name, w, spots] of [
      ['海洋', ocean(1.8), [[0.5, 0.5], [0.004, 0.3], [1.996, 0.97], [1.2, 0.01]]],
      ['群岛', land, [[0.7, 0.4], [1.5, 0.6], [0.01, 0.99]]],
      ['星球', planet, [[1.0, 0.45], [1.9995, 0.45], [0.6, 0.04], [0.3, 0.97]]],
    ] as const) {
      const cellKm = w.mesh.spacing * w.kmPerUnit;
      const parts: string[] = [];
      for (const kind of ['continental', 'low', 'atoll'] as const) {
        for (const size of [1.5, 2, 5, 14]) {
          spots.forEach(([x, y], k) => {
            const s = islandStamp(w, { x, y, kind, size: cellKm * size, variant: k });
            parts.push([hashArray(s.cells), hashArray(s.landDelta), hashArray(s.upliftDelta), hashArray(s.footprint)].join(','));
          });
        }
      }
      got[name] = `${hashString(parts.join('|')).toString(16)} ${parts.length}`;
    }
    expect(got).toEqual({ 星球: '94099864 48', 海洋: '9b41f786 48', 群岛: '23383b55 36' });
  });
});

describe('岛链的固定哈希', () => {
  it('小一号的岛最小一格（与放岛的最小值相同），太小时岛心那一格成陆', () => {
    // 底数 0.99 × 1.5 格、1.6 格、3 格；一块地区与整个星球。第九轮去掉旧存档兼容时重录（原来按旧岛链的 1.5 格下限）
    // 第十二轮修：第 1 种起按第 0 种的面积之和缩放岛的大小（换个排列时陆地一样多），重录
    // 第十三轮：小一号的岛最小 0.4 格（以前 0.75 格，0.99×1.5 一档的大小变了）、火山岛的抬升减半，重录
    const planet = seededWorld({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, buildSphereMesh(3000, 1));
    planet.small.terrain.gen = { seed: 1, type: 'ocean', mountains: 1, rerolls: [] };
    resolveTerrain(planet);
    const got: Record<string, string> = {};
    for (const [name, w, pts] of [
      ['地区', ocean(), [[0.3, 0.3], [1.0, 0.5], [1.7, 0.4]]],
      ['星球', planet, [[0.2, 0.4], [0.9, 0.55], [1.6, 0.5]]],
    ] as const) {
      const cellKm = w.mesh.spacing * w.kmPerUnit;
      for (const [label, mult] of [['0.99×1.5', 0.99 * 1.5], ['1.6', 1.6], ['3', 3]] as const) {
        for (const kind of ['continental'] as const) {
          const islands = chainIslands(w, { points: pts.map(([x, y]) => [x, y] as [number, number]), kind, size: cellKm * mult, density: 1, variant: 1 });
          const r = combineStamps(w, islands);
          got[`${name}|${label}|${kind}`] = [hashArray(islands.map((s) => s.size)), hashArray(r.cells), hashArray(r.landDelta), hashArray(r.upliftDelta), r.footprint.length].join(' ');
        }
      }
    }
    expect(got).toEqual({
      '地区|0.99×1.5|continental': '60cecec5 b5891995 d5536d25 1f5b5c5d 467',
      '地区|1.6|continental': 'a0851fda 9e8bf34d e9e49f4e 5dd46468 499',
      '地区|3|continental': '35ccfc81 d2510db5 c74eb974 db1104f0 1023',
      '星球|0.99×1.5|continental': 'b1a4fe49 5c1d7675 181ce244 1d6b4f9b 189',
      '星球|1.6|continental': 'ef569565 2a4226b5 152c53b7 370c3e90 214',
      '星球|3|continental': 'fdc24236 f91098f5 f21c987f e883f700 424',
    });
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
      const eng = seededEngine({ seed: 3, cells: 12000 });
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

describe('第八轮：更小的岛、湖、画笔', () => {
  // 第十三轮：最小的岛 = 最小的陆地 = 一格（0.4 格，与最小的画笔相同），四种岛一样（以前 0.75 格、珊瑚岛 1.5 格）
  it('最小的岛（0.4 格，与最小的画笔相同）就是一两格陆地，四种岛一样', () => {
    for (const rough of [0.35, 1, 1.8]) {
      const w = ocean(rough);
      const cellKm = mesh.spacing * w.kmPerUnit;
      for (const kind of SHAPED_KINDS) {
        expect(islandSizeRangeKm(w, kind)[0]).toBe(cellKm * 0.4);
        expect(islandSizeRangeKm(w, kind)[0]).toBe(brushRangeKm(w)[0]);
        for (let v = 0; v < 40; v++) {
          const x = 0.1 + ((v * 0.0437) % 1.8);
          const y = 0.1 + ((v * 0.0721) % 0.8);
          const n = islandStamp(w, { x, y, kind, size: cellKm * 0.4, variant: v }).footprint.filter((c) => !w.causes.land[c]).length;
          // 放出来 1–2 格：放不出陆地时岛心那一格成陆
          expect(n, `${kind} ${rough} ${v}`).toBeGreaterThanOrEqual(1);
          expect(n, `${kind} ${rough} ${v}`).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('画笔、岛的大小都写直径，不到半格的半径写“一格 ≈ N km”', () => {
    const w = ocean();
    const cellKm = mesh.spacing * w.kmPerUnit;
    expect(sizeText(w, islandSizeRangeKm(w)[0])).toBe(`一格 ≈ ${roundKm(cellKm)} km`);
    expect(sizeText(w, brushRangeKm(w)[0])).toBe(`一格 ≈ ${roundKm(cellKm)} km`);
    expect(sizeText(w, cellKm * 3)).toBe(`${roundKm(cellKm * 6)} km`);
  });

  it('太小、一格陆地都放不出来时岛心那一格成陆（岛心在地图外时不补）；岛链也一样', () => {
    const w = ocean();
    const cellKm = mesh.spacing * w.kmPerUnit;
    let single = 0;
    for (let v = 0; v < 40; v++) {
      const spec = { x: 0.1 + ((v * 0.0437) % 1.8), y: 0.1 + ((v * 0.0721) % 0.8), kind: 'continental' as const, variant: v };
      // 0.4 格：常常只有岛心那一格
      const now = islandStamp(w, { ...spec, size: cellKm * 0.4 });
      expect(now.footprint.length).toBeGreaterThanOrEqual(1);
      if (now.footprint.length === 1) single++;
      // 1.5 格以上放得出陆地，不用补
      for (const mult of [1.5, 3]) expect(islandStamp(w, { ...spec, size: cellKm * mult }).footprint.length).toBeGreaterThan(1);
    }
    expect(single).toBeGreaterThan(0);
    // 岛心在地图外（岛链画出了地图边）：没有岛心那一格，不补
    for (const [x, y] of [[-cellKm / w.kmPerUnit, 0.5], [1, 1 + (3 * cellKm) / w.kmPerUnit]]) {
      expect(islandStamp(w, { x, y, kind: 'continental', size: cellKm * 0.4, variant: 0 }).footprint).toEqual([]);
    }
    // 岛链（命令里的大小比滑块的最小值还小时）：每个岛都至少有一格陆地
    const islands = chainIslands(w, { points: [[0.2, 0.3], [1.8, 0.7]], kind: 'continental', size: cellKm * 0.4, density: 1, variant: 0 });
    for (const isl of islands) expect(islandStamp(w, isl).footprint.length).toBeGreaterThanOrEqual(1);
    expect(combineStamps(w, islands).footprint.length).toBeGreaterThanOrEqual(islands.length / 2);
  });

  it('最小的湖只有一格', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh: m } = w;
    const cellKm = m.spacing * w.kmPerUnit;
    const lo = lakeRangeKm(w)[0];
    expect(lo).toBe(cellKm * 0.5);
    // 内陆、离地图边远一些：三圈以内都是陆地
    const inland = [...Array(m.n).keys()]
      .filter((c) => m.x[c] > 0.2 && m.x[c] < 1.8 && m.y[c] > 0.2 && m.y[c] < 0.8)
      .filter((c) => [...ringDistance(m, [c], 3)].every((d, i) => d < 0 || w.causes.land[i]))
      .slice(0, 5);
    expect(inland.length).toBe(5);
    for (const c of inland) {
      // 最小只淹放湖的那一格；一格半就不止一格
      expect(lakeArea(w, c, lo)).toEqual([c]);
      expect(lakeArea(w, c, cellKm * 1.5).length).toBeGreaterThan(1);
    }
    // 放下去：湖面就是那一格
    const c = inland[0];
    const before = w.derived.lake.slice();
    eng.exec({ op: 'add_lake', lake: { cell: c, radius: lo, depth: 120, perennial: true } });
    const added = [...Array(m.n).keys()].filter((i) => w.derived.lake[i] === 1 && before[i] !== 1);
    expect(added).toEqual([c]);
    // 按世界文件重放，结果相同
    const replay = Engine.fromDoc(eng.toDoc(), m);
    expect(hashArray(replay.world.derived.lake)).toBe(hashArray(w.derived.lake));
  });

  it('滑块最小值命令都接受', () => {
    const worlds: [string, Partial<Settings>][] = [];
    for (const cells of [40000, 200000]) {
      worlds.push([`1500 km · ${cells}`, settingsFor('islands', 'temperate', cells)]);
      worlds.push([`5000 km · ${cells}`, settingsFor('region', 'tropical', cells)]);
      worlds.push([`类地 · ${cells}`, planetSettings('earth', cells)]);
    }
    for (const [name, s] of worlds) {
      const w = seededWorld(settingsSchema.parse(s), meshFor(s));
      const cellKm = w.mesh.spacing * w.kmPerUnit;
      const lake = lakeRangeKm(w)[0];
      const reach = reachRangeKm(w)[0];
      const island = islandSizeRangeKm(w, 'continental')[0];
      const brush = brushRangeKm(w)[0];
      const cmds: Command[] = [
        { op: 'add_lake', lake: { cell: 0, radius: lake, depth: 120, perennial: true } },
        { op: 'add_constraint', constraint: { cells: [0], species: 'forest', mode: 'constraint', ratio: 1, radius: reach, label: '' } },
        { op: 'add_island', island: { x: 1, y: 0.5, kind: 'continental', size: island, variant: 0 } },
        { op: 'add_island', island: { x: 1, y: 0.5, kind: 'reef', size: island, variant: 0 } },
        { op: 'add_island_chain', chain: { points: [[0.5, 0.5], [1, 0.5]], kind: 'continental', size: island, density: 1, variant: 0 } },
        { op: 'reroll_region', x: 1, y: 0.5, radius: Math.max(brush / w.kmPerUnit, w.mesh.spacing * 1.2), variant: 1 },
        // 画河的“大小”最小 1.0（正好是“河流多少”的门槛）
        { op: 'add_guide', guide: { cells: [0, 1], locked: true, spring: true, flow: 1 } },
      ];
      for (const cmd of cmds) expect(commandSchema.safeParse(cmd).success, `${name} ${cmd.op}`).toBe(true);
      // 比原来的 schema 下限小：以前这些最小值会被拒绝
      if (name.startsWith('1500')) {
        expect(lake).toBeLessThan(10);
        expect(reach).toBeLessThan(50);
      }
      // 最小的画笔不到半格：只涂鼠标下那一格
      expect(brush).toBe(cellKm * 0.4);
      expect(brushCells(w, 1, 0.5, brush)).toEqual({ cells: [findCell(w.mesh, 1, 0.5)], t: [0], weights: [1] });
    }
  });
});
