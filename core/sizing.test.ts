import { describe, expect, it } from 'vitest';
import { hashArray } from '../tools/hash';
import { type Command, commandSchema } from './commands';
import { lakeArea } from './elevation';
import { Engine, docVersion } from './engine';
import { hashString } from './names';
import { buildMesh, findCell, ringDistance } from './mesh';
import { planetSettings, settingsFor } from './presets';
import { brushCells } from './select';
import { buildSphereMesh } from './sphere';
import {
  ISLAND_KINDS,
  brushRangeKm,
  chainIslands,
  combineStamps,
  defaultIslandKm,
  islandSizeRangeKm,
  islandStamp,
  lakeRangeKm,
  previewTerrain,
  reachRangeKm,
  resolveTerrain,
} from './terrain';
import { continents, meshFor } from './testing/fixtures';
import { type Settings, createWorld, settingsSchema } from './world';

// 第三轮：岛的大小连续可调（旧存档照旧逐值重放）；“调整”面板拖滑块时的预览就是松手后的结果
// 第八轮：岛、湖、画笔的最小值更小；小礁

const mesh = buildMesh(40000, 2, 1);

// 第八轮之前就有的四种岛（小礁是新加的，旧存档里没有）：固定的哈希按这四种排
const LEGACY_KINDS = ISLAND_KINDS.filter((k) => k !== 'reef');

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
    for (const kind of LEGACY_KINDS) {
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
      for (const kind of LEGACY_KINDS) {
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

describe('放岛只在岛的附近找格', () => {
  it('结果与原来的全图扫描逐值相同（地图边上、接缝、高纬度）', () => {
    // 哈希来自第八轮改动前（全图扫描）的代码
    const planet = createWorld({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, buildSphereMesh(3000, 1));
    planet.small.terrain.gen = { seed: 1, type: 'archipelago', mountains: 1, rerolls: [] };
    resolveTerrain(planet);
    const land = createWorld({ cells: mesh.n, seed: 1 }, mesh);
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
      for (const kind of ['volcanic', 'continental', 'low', 'atoll'] as const) {
        for (const size of ['small', 'medium', 'large', 1.5, 2, 5, 14] as const) {
          spots.forEach(([x, y], k) => {
            const s = islandStamp(w, { x, y, kind, size: typeof size === 'number' ? cellKm * size : size, variant: k });
            parts.push([hashArray(s.cells), hashArray(s.landDelta), hashArray(s.upliftDelta), hashArray(s.footprint)].join(','));
          });
        }
      }
      got[name] = `${hashString(parts.join('|')).toString(16)} ${parts.length}`;
    }
    expect(got).toEqual({ 星球: 'a78536e2 112', 海洋: '1d1e0513 112', 群岛: 'be9362d4 84' });
  });
});

describe('岛链的下限冻结', () => {
  it('旧存档里的数值岛链（不带 fine）照旧逐值重放', () => {
    // 哈希来自第八轮改动前的代码：底数 0.99 × 1.5 格（旧的拖动取整后会略小于下限）、1.6 格、3 格；一块地区与整个星球
    const planet = createWorld({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, buildSphereMesh(3000, 1));
    planet.small.terrain.gen = { seed: 1, type: 'ocean', mountains: 1, rerolls: [] };
    resolveTerrain(planet);
    const got: Record<string, string> = {};
    for (const [name, w, pts] of [
      ['地区', ocean(), [[0.3, 0.3], [1.0, 0.5], [1.7, 0.4]]],
      ['星球', planet, [[0.2, 0.4], [0.9, 0.55], [1.6, 0.5]]],
    ] as const) {
      const cellKm = w.mesh.spacing * w.kmPerUnit;
      for (const [label, mult] of [['0.99×1.5', 0.99 * 1.5], ['1.6', 1.6], ['3', 3]] as const) {
        for (const kind of ['volcanic', 'continental'] as const) {
          const islands = chainIslands(w, { points: pts.map(([x, y]) => [x, y] as [number, number]), kind, size: cellKm * mult, density: 1, variant: 1 });
          const r = combineStamps(w, islands);
          got[`${name}|${label}|${kind}`] = [hashArray(islands.map((s) => s.size as number)), hashArray(r.cells), hashArray(r.landDelta), hashArray(r.upliftDelta), r.footprint.length].join(' ');
        }
      }
    }
    expect(got).toEqual({
      '地区|0.99×1.5|continental': 'c547f079 a00bb7ed f60daeb4 39703c78 592',
      '地区|0.99×1.5|volcanic': 'c547f079 e411e905 9dfbd236 2eeb0014 599',
      '地区|1.6|continental': '6124aac0 39e90c65 fec2fee5 e3a7a09 629',
      '地区|1.6|volcanic': '6124aac0 8c72b29d e380fd19 cc11eb7f 636',
      '地区|3|continental': '2d639ef5 23dd75e5 20e36a14 6b332680 727',
      '地区|3|volcanic': '2d639ef5 bfa84f75 601185d9 c1a74d25 733',
      '星球|0.99×1.5|continental': 'ce94c8c7 bc2784d5 345f303d 5f023c75 177',
      '星球|0.99×1.5|volcanic': 'ce94c8c7 9f6e9ebd 8b56c13c 321fec54 181',
      '星球|1.6|continental': 'ff394bb2 23305d25 945a332a f1478350 190',
      '星球|1.6|volcanic': 'ff394bb2 1a347c75 a89fa989 28e748e9 195',
      '星球|3|continental': '5a89615 6351b4bd 17824cfe 1639f772 261',
      '星球|3|volcanic': '5a89615 c9b86b25 8e2f67b3 ada37b6e 242',
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

describe('第八轮：更小的岛、湖、画笔', () => {
  it('最小的岛（0.75 格）不会是空的', () => {
    for (const rough of [0.35, 1, 1.8]) {
      const w = ocean(rough);
      const cellKm = mesh.spacing * w.kmPerUnit;
      for (const kind of ['volcanic', 'continental', 'low'] as const) {
        expect(islandSizeRangeKm(w, kind)[0]).toBe(cellKm * 0.75);
        for (let v = 0; v < 40; v++) {
          const x = 0.1 + ((v * 0.0437) % 1.8);
          const y = 0.1 + ((v * 0.0721) % 0.8);
          const fresh = (mult: number) => islandStamp(w, { x, y, kind, size: cellKm * mult, variant: v }).footprint.filter((c) => !w.causes.land[c]).length;
          // 放出来 1–4 格
          const n = fresh(0.75);
          expect(n, `${kind} ${rough} ${v}`).toBeGreaterThanOrEqual(1);
          expect(n, `${kind} ${rough} ${v}`).toBeLessThanOrEqual(4);
          // 比最小值还小也不会是空的：放不出陆地时岛心那一格成陆
          expect(fresh(0.4), `${kind} ${rough} ${v}`).toBeGreaterThanOrEqual(1);
        }
      }
      // 珊瑚岛的环要 1.5 格才看得出来：最小值不变
      expect(islandSizeRangeKm(w, 'atoll')[0]).toBe(cellKm * 1.5);
    }
  });

  it('岛心成陆只在大小不到 1.5 格时发生；旧岛链（不带 fine）照旧不补', () => {
    const w = ocean();
    const cellKm = mesh.spacing * w.kmPerUnit;
    let filled = 0;
    for (let v = 0; v < 40; v++) {
      const spec = { x: 0.1 + ((v * 0.0437) % 1.8), y: 0.1 + ((v * 0.0721) % 0.8), kind: 'volcanic' as const, variant: v };
      // 0.4 格：旧的写法（不补）常常一格陆地都放不出来，新的写法补上岛心那一格
      const tiny = { ...spec, size: cellKm * 0.4 };
      const old = islandStamp(w, tiny, false);
      const now = islandStamp(w, tiny);
      if (!old.footprint.length) {
        filled++;
        expect(now.footprint.length).toBe(1);
      } else expect(now).toEqual(old);
      // 1.5 格以上（旧的最小值）：补不补都一样
      for (const mult of [1.5, 3]) {
        const big = { ...spec, size: cellKm * mult };
        expect(islandStamp(w, big)).toEqual(islandStamp(w, big, false));
      }
    }
    expect(filled).toBeGreaterThan(0);
    // 岛链：带 fine 的才补（命令里的大小比滑块的最小值还小时）
    const chain = { points: [[0.2, 0.3], [1.8, 0.7]] as [number, number][], kind: 'volcanic' as const, size: cellKm * 0.4, density: 1, variant: 0 };
    const islands = chainIslands(w, { ...chain, fine: true });
    const fine = combineStamps(w, islands, true);
    const old = combineStamps(w, islands);
    expect(fine.footprint.length).toBeGreaterThan(old.footprint.length);
  });

  it('最小的湖只有一格 / 旧湖照旧', () => {
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
      // 新湖（exact）：最小只淹放湖的那一格
      expect(lakeArea(w, c, lo, true)).toEqual([c]);
      // 旧湖（不带 exact）照旧至少一格半
      const old = lakeArea(w, c, lo);
      expect(old.length).toBeGreaterThan(1);
      expect(old).toEqual(lakeArea(w, c, cellKm * 1.5, true));
    }
    // 放下去：湖面就是那一格
    const c = inland[0];
    const before = w.derived.lake.slice();
    eng.exec({ op: 'add_lake', lake: { cell: c, radius: lo, depth: 120, perennial: true, exact: true } });
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
      const w = createWorld(settingsSchema.parse(s), meshFor(s));
      const cellKm = w.mesh.spacing * w.kmPerUnit;
      const lake = lakeRangeKm(w)[0];
      const reach = reachRangeKm(w)[0];
      const island = islandSizeRangeKm(w, 'volcanic')[0];
      const brush = brushRangeKm(w)[0];
      const cmds: Command[] = [
        { op: 'add_lake', lake: { cell: 0, radius: lake, depth: 120, perennial: true, exact: true } },
        { op: 'add_constraint', constraint: { cells: [0], species: 'forest', mode: 'constraint', ratio: 1, radius: reach, label: '' } },
        { op: 'add_island', island: { x: 1, y: 0.5, kind: 'volcanic', size: island, variant: 0 } },
        { op: 'add_island', island: { x: 1, y: 0.5, kind: 'reef', size: island, variant: 0 } },
        { op: 'add_island_chain', chain: { points: [[0.5, 0.5], [1, 0.5]], kind: 'volcanic', size: island, density: 1, variant: 0, fine: true } },
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

  it('用了小礁、只淹一格的湖、带 fine 的岛链：文档存成第 4 版', () => {
    const old: Command[] = [
      { op: 'add_island', island: { x: 1, y: 0.5, kind: 'volcanic', size: 'medium', variant: 0 } },
      { op: 'add_lake', lake: { cell: 3, radius: 60, depth: 120, perennial: true } },
      { op: 'add_island_chain', chain: { points: [[0.5, 0.5], [1, 0.5]], kind: 'volcanic', size: 40, density: 1, variant: 0 } },
    ];
    expect(docVersion({ globe: false }, old)).toBe(2);
    expect(docVersion({ globe: true }, old)).toBe(3);
    const fresh: Command[] = [
      { op: 'add_island', island: { x: 1, y: 0.5, kind: 'reef' } },
      { op: 'add_lake', lake: { cell: 3, radius: 6, depth: 120, perennial: true, exact: true } },
      { op: 'add_island_chain', chain: { points: [[0.5, 0.5], [1, 0.5]], kind: 'volcanic', size: 40, density: 1, variant: 0, fine: true } },
    ];
    for (const cmd of fresh) {
      expect(docVersion({ globe: false }, [...old, cmd])).toBe(4);
      expect(docVersion({ globe: true }, [{ op: 'batch', commands: [cmd] }])).toBe(4);
    }
  });
});
