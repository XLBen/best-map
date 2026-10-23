import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { type GeoFeature, featureLabel } from './features';
import { findCell, graphDistance, ringDistance } from './mesh';
import { DEFAULT_PACK, type WordPack, generateName, hashString } from './names';
import { continents, engineFor, snapshot } from './testing/fixtures';

// 人工构造的地图：一块带半岛和海湾的大陆，东边两个岛之间隔着一道窄海峡
function handmade() {
  const eng = new Engine({ cells: 12000, seed: 2, latNorth: 50, latSouth: 30 });
  const { mesh } = eng.world;
  const inside = (x: number, y: number) => {
    const main = x > 0.3 && x < 1.0 && y > 0.25 && y < 0.75 && !(x > 0.8 && y > 0.42 && y < 0.58);
    const peninsula = x > 0.08 && x <= 0.3 && y > 0.475 && y < 0.525;
    const islandA = x > 1.3 && x < 1.55 && y > 0.3 && y < 0.7;
    const islandB = x > 1.595 && x < 1.85 && y > 0.3 && y < 0.7;
    return main || peninsula || islandA || islandB;
  };
  const cells: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (inside(mesh.x[i], mesh.y[i])) cells.push(i);
  eng.exec({ op: 'set_coast_style', roughness: 0.2 });
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  return eng;
}

const near = (eng: Engine, type: string, x: number, y: number) => {
  const { mesh, derived } = eng.world;
  const c = findCell(mesh, x, y);
  return derived.features.find((f) => f.type === type && f.cells.includes(c));
};

describe('地理要素识别', () => {
  const eng = handmade();

  it('识别出半岛、海湾、海峡、大陆或岛', () => {
    expect(near(eng, 'peninsula', 0.18, 0.5)).toBeDefined();
    expect(near(eng, 'bay', 0.92, 0.5)).toBeDefined();
    expect(near(eng, 'strait', 1.572, 0.5)).toBeDefined();
    expect(near(eng, 'island', 1.42, 0.5)).toBeDefined();
  });

  it('每个要素都有名字，且同一张图重算名字不变', () => {
    const names = eng.world.derived.features.map((f) => `${f.key}=${f.name}`);
    expect(eng.world.derived.features.every((f) => f.name.length > 0)).toBe(true);
    const again = handmade();
    expect(again.world.derived.features.map((f) => `${f.key}=${f.name}`)).toEqual(names);
  });
});

describe('改名与文字包', () => {
  it('改过的名字在之后的地形编辑后保留', () => {
    const eng = handmade();
    const island = near(eng, 'island', 1.42, 0.5)!;
    eng.exec({ op: 'rename_feature', key: island.key, name: '我的岛' });
    expect(near(eng, 'island', 1.42, 0.5)!.name).toBe('我的岛');
    // 在别处放一个岛，地物整体重算
    eng.exec({ op: 'add_island', island: { x: 0.6, y: 0.1, kind: 'volcanic', size: 370, variant: 0 } });
    expect(near(eng, 'island', 1.42, 0.5)!.name).toBe('我的岛');
    // 恢复自动命名
    eng.exec({ op: 'rename_feature', key: island.key, name: '' });
    expect(near(eng, 'island', 1.42, 0.5)!.name).not.toBe('我的岛');
  });

  it('重抽换一个名字；撤销回到原来的名字', () => {
    const eng = handmade();
    const f = near(eng, 'bay', 0.92, 0.5)!;
    const before = f.name;
    eng.exec({ op: 'reroll_feature', key: f.key });
    const after = near(eng, 'bay', 0.92, 0.5)!.name;
    expect(after).not.toBe(before);
    eng.undo();
    expect(near(eng, 'bay', 0.92, 0.5)!.name).toBe(before);
  });

  it('自定义文字包：名字用包里的词；模板引用不存在的词表时拒绝', () => {
    const eng = handmade();
    const pack: WordPack = {
      id: 'test',
      name: '测试包',
      lists: { a: ['甲'], b: ['乙'] },
      types: Object.fromEntries(Object.keys(DEFAULT_PACK.types).map((t) => [t, { patterns: [{ p: '{a}{b}' }] }])),
    };
    eng.exec({ op: 'set_word_pack', pack });
    expect(eng.world.derived.features.some((f) => f.name.startsWith('甲乙'))).toBe(true);
    const bad = { ...pack, types: { island: { patterns: [{ p: '{没有}岛' }] } } };
    expect(() => eng.exec({ op: 'set_word_pack', pack: bad })).toThrow(/不存在的词表/);
  });

  it('情境标签：寒冷的岛优先用寒冷的字', () => {
    let cold = 0;
    for (let s = 0; s < 60; s++) {
      const name = generateName(DEFAULT_PACK, 'island', ['cold'], s);
      if (DEFAULT_PACK.lists.cold.some((c) => name.includes(c))) cold++;
    }
    expect(cold).toBeGreaterThan(25);
  });
});

// ---------- 涂出来的生态区（第八轮） ----------

// 涂生态：硬覆盖，涂了一定涂得上
const paint = (eng: Engine, cells: number[], species: string) =>
  eng.exec({ op: 'add_constraint', constraint: { cells, species, mode: 'override', ratio: 1, radius: 300 } });
// cells 里离 seed 最近的 k 格（图距离，同距按编号）
const nearest = (eng: Engine, cells: Iterable<number>, seed: number, k: number) => {
  const d = graphDistance(eng.world.mesh, [seed]);
  return [...cells].sort((a, b) => d[a] - d[b] || a - b).slice(0, k);
};
const byKey = (eng: Engine, key: string) => eng.world.derived.features.find((f) => f.key === key);
const paintedFeatures = (eng: Engine) => eng.world.derived.features.filter((f) => f.species !== undefined);
// 标注落在地物自己的格上
const labelInside = (eng: Engine, f: GeoFeature) => f.cells.includes(findCell(eng.world.mesh, f.x, f.y));
const speciesAt = (eng: Engine, c: number) => eng.world.small.species[eng.world.derived.dominant[c]]?.id;
// 地物里每格离边（地物外、地图边）的步数
const depthIn = (eng: Engine, f: GeoFeature) => {
  const { mesh } = eng.world;
  const inside = new Set(f.cells);
  const edge = [...inside].filter((c) => {
    if (mesh.boundary[c]) return true;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (!inside.has(mesh.adj[e])) return true;
    return false;
  });
  return ringDistance(mesh, edge, Infinity, (j) => inside.has(j));
};

// 共用的大陆世界里：全是一种生态的森林里最大的一片（针叶林），和锚点不在边上的森林里最大的一片
const base = continents();
const forests = base.world.derived.features.filter((f) => f.type === 'forest');
const pure = forests.find((f) => Array.from(f.cells).every((c) => speciesAt(base, c) === speciesAt(base, f.anchor)))!;
const deep = forests.find((f) => depthIn(base, f)[f.anchor] >= 1 && f.cells.length >= 150)!;
// 6000 格的小星球（几个测试共用，每次给副本）
const planet = () =>
  snapshot('features:planet', () => {
    const eng = engineFor({ cells: 6000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    return eng;
  });
// 面状地物（河沿河标、山峰标在峰顶、群岛的岛之间本来是海、用户的区块另算）
const areal = (f: GeoFeature) => !f.region && f.type !== 'river' && f.type !== 'peak' && f.type !== 'archipelago';

describe('涂出来的生态区有自己的名字', () => {
  it('在森林里涂一片别的森林：新名字在涂的地方、旧名字留在没涂的部分、两个标签都在自己的格上', () => {
    expect(speciesAt(base, pure.anchor)).toBe('taiga');
    const eng = continents();
    // 森林里离锚点最远的一头涂 60 格温带阔叶林
    const d = graphDistance(eng.world.mesh, [pure.anchor]);
    const far = [...pure.cells].sort((a, b) => d[b] - d[a] || a - b)[0];
    const cells = nearest(eng, pure.cells, far, 60);
    paint(eng, cells, 'temperate_forest');
    const [f, ...rest] = paintedFeatures(eng);
    expect(rest).toEqual([]);
    expect([f.type, f.species, featureLabel(eng.world, f)]).toEqual(['forest', 'temperate_forest', '温带阔叶林']);
    expect(f.cells.length).toBeGreaterThanOrEqual(8);
    expect(Array.from(f.cells).every((c) => cells.includes(c))).toBe(true);
    expect(f.name.length).toBeGreaterThan(0);
    expect(f.name).not.toBe(pure.name);
    const old = byKey(eng, pure.key)!;
    expect(old.name).toBe(pure.name);
    expect(Array.from(old.cells).some((c) => cells.includes(c))).toBe(false);
    expect(old.cells.length).toBe(pure.cells.length - 60);
    expect(labelInside(eng, f)).toBe(true);
    expect(labelInside(eng, old)).toBe(true);
    // 涂出来的标注先放
    expect(f.importance).toBeGreaterThan(old.importance);
  });

  it('整片涂成雨林：名字换了', () => {
    const eng = continents();
    paint(eng, Array.from(pure.cells), 'rainforest');
    expect(byKey(eng, pure.key)).toBeUndefined();
    const [f] = paintedFeatures(eng);
    expect([f.type, f.species, featureLabel(eng.world, f)]).toEqual(['forest', 'rainforest', '热带雨林']);
    expect(f.cells.length).toBe(pure.cells.length);
    expect(f.name.length).toBeGreaterThan(0);
    expect(f.name).not.toBe(pure.name);
    // 其余的地物名字都不变（新的在第二轮起名，不抢原有地物的名字）
    const before = new Map(base.world.derived.features.map((x) => [x.key, x.name]));
    for (const x of eng.world.derived.features) if (before.has(x.key)) expect(x.name, x.key).toBe(before.get(x.key));
  });

  it('涂出来的地名第二轮才起：字很少的文字包里也不抢原有地物的名字', () => {
    // 森林只有 12 个字可选：涂出来的森林比多数自然的森林“重要”，一起按重要度起名时会先挑走它们要的字
    const pack: WordPack = {
      id: 'few',
      name: '少字',
      lists: { a: [...'甲乙丙丁戊己庚辛壬癸子丑'], b: [...'东南西北中上下前后左右内外远近高低长短'] },
      types: { forest: { patterns: [{ p: '{a}林' }] }, island: { patterns: [{ p: '{b}{b}岛' }] } },
    };
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_word_pack', pack });
    const before = new Map(w.derived.features.map((f) => [f.key, f.name]));
    // 离所有五大类生态 4 格以上的空地上涂三片雨林：原有的地物一个都不变，只多出涂的这几片
    const grouped = (c: number) => ['forest', 'jungle', 'desert', 'arctic', 'marsh'].includes(w.small.species[w.derived.dominant[c]]?.terrain ?? '');
    const far = ringDistance(w.mesh, [...Array(w.mesh.n).keys()].filter(grouped), 4);
    const open = [...Array(w.mesh.n).keys()].filter((c) => w.causes.land[c] && w.derived.lake[c] !== 1 && w.derived.dominant[c] >= 0 && far[c] < 0);
    // 三片互相离得够远（不连成一片）：按空地的 1/6、3/6、5/6 处取，太近的换下一个位置；每片 14 格
    // （第十三轮修：小块内海并回陆地后空地少了，原来每片 25 格、按位置取时有两片连成了一片）
    const seeds: number[] = [];
    for (const f of [1 / 6, 3 / 6, 5 / 6, 0.05, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.95]) {
      const c = open[Math.floor(open.length * f)];
      if (seeds.every((t) => graphDistance(w.mesh, [t])[c] > 6 * w.mesh.spacing)) seeds.push(c);
      if (seeds.length === 3) break;
    }
    for (const c of seeds) paint(eng, nearest(eng, open, c, 14), 'rainforest');
    const painted = paintedFeatures(eng);
    expect(painted.length).toBe(3);
    expect(painted.every((f) => f.type === 'forest' && f.name.endsWith('林'))).toBe(true);
    expect(w.derived.features.length).toBe(before.size + 3);
    for (const f of w.derived.features) if (!f.species) expect(f.name, f.key).toBe(before.get(f.key));
  });

  it('同种生态往外涂：名字不变，也没有新地名（换几个位置）', () => {
    const w = base.world;
    const { mesh } = w;
    const sp = speciesAt(base, pure.anchor);
    const inside = new Set(pure.cells);
    const forestish = (c: number) => ['forest', 'jungle'].includes(w.small.species[w.derived.dominant[c]]?.terrain ?? '');
    // 能往外涂的格：有植被、不是森林、离别的森林 3 格以上（不和别的森林连成一片）
    const elsewhere = ringDistance(mesh, [...Array(mesh.n).keys()].filter((c) => forestish(c) && !inside.has(c)), 3);
    const open = [...Array(mesh.n).keys()].filter((c) => w.causes.land[c] && w.derived.lake[c] !== 1 && w.derived.dominant[c] >= 0 && !forestish(c) && elsewhere[c] < 0);
    const rim = open.filter((c) => {
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (inside.has(mesh.adj[e])) return true;
      return false;
    });
    expect(rim.length).toBeGreaterThan(20);
    const all = continents();
    for (const k of [0, 1, 2, 3]) {
      const cells = nearest(base, open, rim[Math.floor((rim.length * k) / 4)], 40);
      const eng = continents();
      paint(eng, cells, sp);
      paint(all, cells, sp);
      const f = eng.world.derived.features.find((x) => x.type === 'forest' && x.cells.includes(cells[0]))!;
      expect(f.cells.length, `位置 ${k}`).toBe(pure.cells.length + 40);
      expect([f.key, f.name], `位置 ${k}`).toEqual([pure.key, pure.name]);
      expect(paintedFeatures(eng)).toEqual([]);
    }
    // 几处一起涂
    expect(byKey(all, pure.key)!.name).toBe(pure.name);
    expect(paintedFeatures(all)).toEqual([]);
  });

  it('在森林中间涂沙漠：森林名字不变（锚点在涂的洞里也不变）', () => {
    const depth = depthIn(base, deep);
    const eng = continents();
    // 锚点周围、不挨着森林边的 30 格：涂完四周还是这片森林
    const cells = nearest(
      eng,
      Array.from(deep.cells).filter((c) => depth[c] >= 1),
      deep.anchor,
      30,
    );
    expect(cells).toContain(deep.anchor);
    paint(eng, cells, 'desert');
    const f = byKey(eng, deep.key)!;
    expect(f.name).toBe(deep.name);
    expect(f.cells.length).toBe(deep.cells.length - 30);
    expect(labelInside(eng, f)).toBe(true);
    const [desert] = paintedFeatures(eng);
    expect([desert.type, desert.species, featureLabel(eng.world, desert)]).toEqual(['desert', 'desert', '荒漠']);
    expect(desert.cells.length).toBe(30);
    expect(labelInside(eng, desert)).toBe(true);
  });

  it('涂一块自定义生态：有自己的名字；草原用草原的模板；导入的文字包里没有时用内置的', () => {
    const eng = continents();
    const w = eng.world;
    // 自然长不出来（只在涂的地方有）
    const never = { field: 'tMean', min: 90, optLow: 95, optHigh: 98, max: 99 };
    eng.exec({ op: 'add_species', species: { id: 'crystal', name: '水晶丛林', terrain: 'plains', color: '#88ccee', competition: 1, tolerances: [never] } });
    const veg = [...Array(w.mesh.n).keys()].filter((c) => w.causes.land[c] && w.derived.lake[c] !== 1 && w.derived.dominant[c] >= 0);
    const steppe = veg.find((c) => speciesAt(eng, c) === 'steppe')!;
    paint(eng, nearest(eng, veg, steppe, 20), 'crystal');
    const f = paintedFeatures(eng)[0];
    expect([f.type, f.species, featureLabel(w, f), f.cells.length]).toEqual(['biome', 'crystal', '水晶丛林', 20]);
    expect(f.name).toContain('水晶丛林');
    expect(labelInside(eng, f)).toBe(true);
    // 内置的温带草原：类型名是“温带草原”，名字按草原的模板
    const grass = nearest(eng, veg, veg[Math.floor(veg.length / 2)], 25);
    paint(eng, grass, 'steppe');
    const g = paintedFeatures(eng).find((x) => x.species === 'steppe')!;
    expect([g.type, featureLabel(w, g)]).toEqual(['biome', '温带草原']);
    expect(g.name).toMatch(/草原|牧野/);
    // 文字包里没有生态区的模板：用内置的模板和词表
    const pack: WordPack = { id: 'mini', name: '小包', lists: { a: ['甲'] }, types: { island: { patterns: [{ p: '{a}岛' }] } } };
    eng.exec({ op: 'set_word_pack', pack });
    expect(paintedFeatures(eng).find((x) => x.species === 'crystal')!.name).toContain('水晶丛林');
    // 模板里可以用 {__species}
    eng.exec({ op: 'set_word_pack', pack: { ...pack, types: { ...pack.types, biome: { patterns: [{ p: '{a}{__species}' }] } } } });
    expect(paintedFeatures(eng).find((x) => x.species === 'crystal')!.name).toBe('甲水晶丛林');
  });

  it('改过的名字不会自动变', () => {
    const eng = continents();
    eng.exec({ op: 'rename_feature', key: deep.key, name: '我的林子' });
    const named = () => eng.world.derived.features.filter((f) => f.name === '我的林子');
    // 在中间涂一片雨林，包住锚点：名字留在原来的森林上，雨林另起名字
    const depth = depthIn(base, deep);
    const hole = nearest(
      eng,
      Array.from(deep.cells).filter((c) => depth[c] >= 1),
      deep.anchor,
      30,
    );
    paint(eng, hole, 'rainforest');
    expect(named().map((f) => f.key)).toEqual([deep.key]);
    expect(byKey(eng, deep.key)!.custom).toBe(true);
    const rain = paintedFeatures(eng)[0];
    expect(rain.species).toBe('rainforest');
    expect(rain.custom).toBe(false);
    // 整片涂成雨林：名字跟着包含原锚点的那一片
    paint(eng, Array.from(deep.cells), 'rainforest');
    expect(named().length).toBe(1);
    expect(named()[0].species).toBe('rainforest');
    expect(named()[0].custom).toBe(true);
  });

  it('每个面状地物的标注都落在自己的格上（星球上跨过接缝涂一片也一样）', () => {
    const eng = planet();
    const w = eng.world;
    for (const f of w.derived.features.filter(areal)) expect(labelInside(eng, f), f.key).toBe(true);
    // 经度 ±180° 两边的陆地涂成稀树草原：涂出来的地物跨过接缝，标注仍在它自己的格上
    const seam = [...Array(w.mesh.n).keys()].filter((c) => w.causes.land[c] && w.derived.lake[c] !== 1 && (w.mesh.x[c] < 0.08 || w.mesh.x[c] > 1.92));
    paint(eng, seam, 'savanna');
    const across = paintedFeatures(eng).filter((f) => Array.from(f.cells).some((c) => w.mesh.x[c] < 0.5) && Array.from(f.cells).some((c) => w.mesh.x[c] > 1.5));
    expect(across.length).toBeGreaterThan(0);
    expect(across.every((f) => f.type === 'biome' && featureLabel(w, f) === '稀树草原')).toBe(true);
    for (const f of w.derived.features.filter(areal)) expect(labelInside(eng, f), f.key).toBe(true);
    for (const f of base.world.derived.features.filter(areal)) expect(labelInside(base, f), f.key).toBe(true);
  });
});

// 这一轮之前的程序算出的“key=名字”（没涂过生态的世界：识别、锚点、起名都不能变，只有标注位置可以变）。
// 第九轮去掉旧存档兼容时重录（山挡风默认打开，气候、河、地名都跟着变）
// 第十三轮修：陆地围住的小块海（6 格以内）并回陆地、三格以上挖成湖，放的火山岛按大小定高度并有火山口，陆海、高程往后都变了，重录变了的项
describe('名字稳定', () => {
  const kv = (eng: Engine) => hashString(eng.world.derived.features.map((f) => `${f.key}=${f.name}`).join('|')).toString(16);
  it('没涂过生态的世界：地物的 key 与名字和以前完全相同', () => {
    expect(kv(continents())).toBe('ea72bd4b');
    expect(kv(planet())).toBe('594997ff');
    const islands = engineFor({ seed: 2, cells: 6000 });
    islands.exec({ op: 'set_worldgen', params: { seed: 2, type: 'archipelago' }, reset: true });
    expect(kv(islands)).toBe('b00d2f79');
  });
});
