import { describe, expect, it } from 'vitest';
import { Dirty } from './commands';
import { Engine } from './engine';
import { type GeoFeature, detectFeatures, featureLabel, featureMemo } from './features';
import { graphDistance } from './mesh';
import { FANTASY_BIOMES, fantasyBiomeCommands } from './packs/fantasy-biomes';
import { type Species, withRect } from './species';
import { continents, snapshot } from './testing/fixtures';

// 自带地名设定的生态（第三批的 feature：水晶丛林的“晶林”……）自然长成的一片也有自己的地名，
// 不只是涂出来的那些。只看这样的生态：只有内置生态的世界、不带地名设定的自定义生态，地物与以前完全一样

const FANTASY = new Set(FANTASY_BIOMES.map((sp) => sp.id));

// 1.2 万格的大陆世界加上五种示例生态（一步）；每次给副本
const fantasy = () =>
  snapshot('features-biome:fantasy', () => {
    const eng = continents();
    eng.exec(fantasyBiomeCommands({ fields: Object.keys(eng.world.causes.fields), species: eng.world.small.species.map((s) => s.id) }));
    return eng;
  });

// 自然长成、带着生态的地物（没涂过时就是全部带生态的地物）
const own = (eng: Engine) => eng.world.derived.features.filter((f) => f.species !== undefined);
const keyName = (fs: GeoFeature[]) => fs.map((f) => `${f.key}=${f.name}`);
// 地物的全部内容（含格子）
const json = (fs: GeoFeature[]) => JSON.stringify(fs.map((f) => ({ ...f, cells: Array.from(f.cells) })));

// 一种不带脚本、到处都能长的普通生态（竞争力高：长得出大片）
const glass = (extra: Partial<Species> = {}): Species =>
  withRect({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 6, tolerances: [], ...extra }, { t0: 5, t1: 30, m0: 0.4, m1: 3 });

describe('自带地名设定的生态自然长成的一片有自己的地名', () => {
  it('示例生态：类型名是它的（晶林、枯林……），名字按它的模板；每块 8 格以上、都是这种生态，每种最多 10 块', () => {
    const eng = fantasy();
    const w = eng.world;
    const fs = own(eng);
    expect(fs.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const f of fs) {
      const sp = w.small.species.find((x) => x.id === f.species)!;
      expect(FANTASY.has(sp.id), sp.id).toBe(true);
      seen.add(sp.id);
      expect(f.type).toBe('biome');
      expect(featureLabel(w, f)).toBe(sp.feature!.label);
      expect(f.cells.length).toBeGreaterThanOrEqual(8);
      const s = w.small.species.indexOf(sp);
      expect(Array.from(f.cells).every((c) => w.derived.dominant[c] === s)).toBe(true);
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.custom).toBe(false);
    }
    for (const id of seen) expect(fs.filter((f) => f.species === id).length).toBeLessThanOrEqual(10);
    // 水晶丛林按它的模板起名
    for (const f of fs.filter((x) => x.species === 'crystal_jungle')) expect(f.name).toMatch(/(晶林|晶丛|水晶林)$/);
    // 与大类的地物（森林……）不重叠：长在森林里的一片从森林里分出来
    const taken = new Set(fs.flatMap((f) => Array.from(f.cells)));
    for (const f of w.derived.features) if (f.species === undefined && ['forest', 'desert', 'tundra', 'icecap', 'wetland'].includes(f.type)) expect(Array.from(f.cells).some((c) => taken.has(c)), f.key).toBe(false);
    // 用缓存的与从头识别的逐值相同
    featureMemo.on = false;
    try {
      // 按没挖河床、没修湖底的地形识别（与引擎相同；推导里的高程修过湖底，第三十二轮湖多了，盆地会差一两格）
      const terrain = (eng as unknown as { base: { terrain: Float32Array } }).base.terrain;
      expect(json(detectFeatures(w, w.derived, terrain))).toBe(json(w.derived.features));
    } finally {
      featureMemo.on = true;
    }
    // 存成文件再打开（从头重放）：地物与名字逐值相同
    expect(json(Engine.fromDoc(eng.toDoc(), w.mesh).world.derived.features)).toBe(json(w.derived.features));
  });

  it('名字稳定：改别的地物的名字、圈一块地名、远处涂一片别的生态，自然长成的那几片 key 与名字都不变；撤销也不变', () => {
    const eng = fantasy();
    const w = eng.world;
    const before = keyName(own(eng));
    const steps = eng.history.length;
    // 改一座山（不是生态区）的名字、重抽一个湖的名字
    const other = w.derived.features.find((f) => f.species === undefined && f.type !== 'river')!;
    eng.exec({ op: 'rename_feature', key: other.key, name: '测试之地' });
    expect(keyName(own(eng))).toEqual(before);
    // 圈一块地名
    const land = [...Array(w.mesh.n).keys()].filter((c) => w.causes.land[c]);
    eng.exec({ op: 'add_region', region: { name: '', kind: 'region', cells: land.slice(0, 30) } });
    expect(keyName(own(eng))).toEqual(before);
    // 远处（离每一片自然长成的都远：地图宽 2，这里是 0.15）涂一片荒漠
    const ownCells = own(eng).flatMap((f) => Array.from(f.cells));
    const dist = graphDistance(w.mesh, ownCells);
    const far = land.filter((c) => dist[c] >= 0.15 && w.derived.dominant[c] >= 0 && w.derived.lake[c] !== 1);
    expect(far.length).toBeGreaterThan(40);
    const d0 = graphDistance(w.mesh, [far[0]]);
    const patch = [...far].sort((a, b) => d0[a] - d0[b] || a - b).slice(0, 40);
    eng.exec({ op: 'add_constraint', constraint: { cells: patch, species: 'desert', mode: 'override', ratio: 1, radius: 300 } });
    expect(keyName(own(eng).filter((f) => !Array.from(f.cells).some((c) => patch.includes(c))))).toEqual(before);
    for (let k = 0; k < 3; k++) eng.undo();
    expect(eng.history.filter((h) => h.done).length).toBe(steps);
    expect(keyName(own(eng))).toEqual(before);
  });

  it('涂出来的一片照旧：涂的格是涂出来的生态区，自然长成的不算进去', () => {
    const eng = fantasy();
    const w = eng.world;
    const natural = own(eng);
    // 离自然长成的水晶丛林都远的地方涂 40 格水晶丛林
    const crystal = natural.filter((f) => f.species === 'crystal_jungle').flatMap((f) => Array.from(f.cells));
    const dist = graphDistance(w.mesh, crystal.length ? crystal : natural.flatMap((f) => Array.from(f.cells)));
    const far = [...Array(w.mesh.n).keys()].filter((c) => w.causes.land[c] && w.derived.lake[c] !== 1 && w.derived.dominant[c] >= 0 && dist[c] >= 0.15);
    expect(far.length).toBeGreaterThan(40);
    const d0 = graphDistance(w.mesh, [far[Math.floor(far.length / 2)]]);
    const patch = [...far].sort((a, b) => d0[a] - d0[b] || a - b).slice(0, 40);
    eng.exec({ op: 'add_constraint', constraint: { cells: patch, species: 'crystal_jungle', mode: 'override', ratio: 1, radius: 300 } });
    const painted = own(eng).filter((f) => Array.from(f.cells).some((c) => patch.includes(c)));
    expect(painted.length).toBe(1);
    expect(Array.from(painted[0].cells).every((c) => patch.includes(c))).toBe(true);
    expect(featureLabel(w, painted[0])).toBe('晶林');
    // 涂出来的标注先放（重要度高一点），自然长成的那几片还在
    const rest = own(eng).filter((f) => f !== painted[0]);
    // 名字都还在（第三十二轮：洼地里的湖跟着气候涨落，涂的生态对周围的影响会让远处一片的锚点挪一格，地物的键跟着变，名字不变）
    expect(rest.map((f) => f.name).sort()).toEqual(natural.map((f) => f.name).sort());
    for (const f of rest) if (f.cells.length === painted[0].cells.length) expect(painted[0].importance).toBeGreaterThan(f.importance);
  });
});

describe('只在有自带地名设定的生态时才有', () => {
  it('不带地名设定的生态长成大片也没有自己的地名；加上地名设定（重新识别）就有，去掉、撤销就没有；改类型名只重新起名', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'add_species', species: glass() });
    const s = w.small.species.findIndex((x) => x.id === 'glass');
    let grown = 0;
    for (let i = 0; i < w.mesh.n; i++) if (w.derived.dominant[i] === s) grown++;
    expect(grown).toBeGreaterThan(50);
    expect(own(eng)).toEqual([]);
    const plain = json(w.derived.features);
    eng.takeRecomputed();
    // 加上地名设定：地物重新识别（不只是重新起名），推导的其余部分不变
    const dominant = w.derived.dominant.slice();
    eng.exec({ op: 'update_species', id: 'glass', patch: { feature: { label: '玻原', names: [{ p: '{color}玻原' }] } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Solve);
    expect(w.derived.dominant).toEqual(dominant);
    const named = own(eng);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((f) => f.species === 'glass' && featureLabel(w, f) === '玻原' && /玻原$/.test(f.name))).toBe(true);
    // 只改类型名：只重新起名，地物（key、格）不变
    eng.exec({ op: 'update_species', id: 'glass', patch: { feature: { label: '琉璃', names: [{ p: '{color}琉璃' }] } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Names);
    expect(own(eng).map((f) => f.key)).toEqual(named.map((f) => f.key));
    expect(own(eng).every((f) => /琉璃$/.test(f.name))).toBe(true);
    // 去掉地名设定：回到原样（与从来没有时逐值相同）
    eng.exec({ op: 'update_species', id: 'glass', patch: { feature: null } });
    expect(json(w.derived.features)).toBe(plain);
    eng.undo();
    expect(own(eng).map((f) => f.key)).toEqual(named.map((f) => f.key));
    eng.undo();
    eng.undo();
    expect(json(w.derived.features)).toBe(plain);
    eng.redo();
    expect(keyName(own(eng))).toEqual(keyName(named));
    expect(json(Engine.fromDoc(eng.toDoc(), w.mesh).world.derived.features)).toBe(json(w.derived.features));
  });

  it('带地名设定、但自然长不出来的生态：地物与没有它时逐值相同', () => {
    const never = { field: 'tMean', min: 90, optLow: 95, optHigh: 98, max: 99 };
    const a = continents();
    a.exec({ op: 'add_species', species: { id: 'ghost', name: '幽林', terrain: 'plains', color: '#334455', tolerances: [never] } });
    const b = continents();
    b.exec({ op: 'add_species', species: { id: 'ghost', name: '幽林', terrain: 'plains', color: '#334455', tolerances: [never], feature: { label: '幽林' } } });
    expect(json(b.world.derived.features)).toBe(json(a.world.derived.features));
    expect(json(a.world.derived.features)).toBe(json(continents().world.derived.features));
  });

  it('内置的大类生态（针叶林……）带了地名设定，自然长成的仍是森林，不另算', () => {
    const eng = continents();
    const before = json(eng.world.derived.features);
    eng.exec({ op: 'update_species', id: 'taiga', patch: { feature: { label: '针林' } } });
    expect(own(eng)).toEqual([]);
    expect(eng.world.derived.features.map((f) => f.key)).toEqual(JSON.parse(before).map((f: GeoFeature) => f.key));
  });
});
