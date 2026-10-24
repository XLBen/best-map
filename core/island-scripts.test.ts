import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { BUILTIN_COUNT, type IslandTypeInput } from './island-types';
import { applyPackCommands } from './packs';
import { FANTASY_PACK } from './packs/fantasy';
import { FANTASY_ISLAND_TYPES, LAKE_ISLE_SHAPE } from './packs/fantasy-islands';
import { arrayInputs, checkPurity, findScripts, runScript, setScriptsEnabled } from './script';
import { continents } from './testing/fixtures';
import { FREE_HEIGHT, type World } from './world';

// 第十五轮：岛的种类的脚本（放在哪里、岛的样子）与示例包里的湖心岛

const all = (w: World) => [...Array(w.mesh.n).keys()];
const script = (src: string) => ({ api: 1 as const, src });

// 内陆放一个大湖（常年蓄满），返回湖心那一格
function withLake(): { eng: Engine; c: number } {
  const eng = continents();
  const w = eng.world;
  const inland = all(w).find((i) => w.causes.land[i] && w.derived.lake[i] !== 1 && w.derived.continentality[i] > 0.6 && w.derived.slope[i] < 5)!;
  eng.exec({ op: 'add_lake', lake: { cell: inland, radius: 300, depth: 150, perennial: true } });
  return { eng, c: inland };
}

function ocean(): Engine {
  const eng = new Engine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
  return eng;
}

// 示例包里只勾湖心岛（经资源包的流程：校验、撞 id、命令）
function addLakeIsle(eng: Engine) {
  eng.exec(applyPackCommands(eng.world, FANTASY_PACK, { biomes: [], riverTypes: [], lakeTypes: [], islandTypes: ['lake_isle'] }));
}

const isleAt = (w: World, c: number) => ({ x: w.mesh.x[c], y: w.mesh.y[c], kind: 'lake_isle', size: 150, variant: 0 });

// 一片格四周一圈（不在这片里的邻格）
function ringOf(w: World, cells: number[]): number[] {
  const set = new Set(cells);
  const out = new Set<number>();
  for (const c of cells) for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!set.has(w.mesh.adj[e])) out.add(w.mesh.adj[e]);
  return [...out].sort((a, b) => a - b);
}

describe('湖心岛（示例包里的一种自己的岛，全靠脚本）', () => {
  it('放在湖里：岛上是高出湖面的干陆地，四周一圈还是湖，湖面不变；是一个带名字的岛，按湖心岛的模板起名', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    const level = w.derived.water[c];
    const lakeBefore = all(w).filter((i) => w.derived.lake[i] === 1 && Math.abs(w.derived.water[i] - level) < 1e-3);
    const elevBefore = w.derived.elevation.slice();
    addLakeIsle(eng);
    expect(eng.world.small.islandTypes?.[0].scripts?.shape?.src).toBe(LAKE_ISLE_SHAPE);
    expect(eng.exec({ op: 'add_island', island: isleAt(w, c) })).toBe('放了一个湖心岛（直径约 300 km）');
    const isle = all(w).filter((i) => w.causes.islandType[i] === BUILTIN_COUNT + 1);
    expect(isle.length).toBeGreaterThan(3);
    for (const i of isle) {
      expect(w.derived.lake[i]).toBe(0);
      expect(w.derived.elevation[i]).toBeGreaterThan(level + 3.9);
      expect(w.derived.elevation[i]).toBeLessThan(level + 34);
      expect(w.derived.elevation[i]).toBe(w.causes.islandHeight![i]);
    }
    // 岛四周一圈全是湖，湖面还是原来的高度；原来的湖格只少了岛占的那些
    for (const j of ringOf(w, isle)) {
      expect(w.derived.lake[j]).toBe(1);
      expect(w.derived.water[j]).toBeCloseTo(level, 4);
    }
    const lakeAfter = lakeBefore.filter((i) => w.derived.lake[i] === 1);
    expect(lakeAfter.length + isle.length).toBe(lakeBefore.length);
    // 定了高度的只有岛上的格；别的格高度一格不变
    for (const i of all(w)) {
      if (isle.includes(i)) continue;
      expect(w.causes.islandHeight![i]).toBe(FREE_HEIGHT);
      expect(w.derived.elevation[i]).toBe(elevBefore[i]);
    }
    const f = w.derived.features.find((x) => x.type === 'island' && x.cells.some((i) => isle.includes(i)))!;
    expect([...f.cells].sort((a, b) => a - b)).toEqual(isle);
    expect(f.tags).toContain('itype:lake_isle');
    expect(f.name).toMatch(/(洲|心岛|渚)$/);
  });

  it('放不进湖外：点在陆地、海上时拒绝，说是湖心岛的脚本说的', () => {
    const { eng } = withLake();
    const w = eng.world;
    addLakeIsle(eng);
    const dry = all(w).find((i) => w.causes.land[i] && !w.derived.lake[i])!;
    const sea = all(w).find((i) => !w.causes.land[i])!;
    expect(() => eng.exec({ op: 'add_island', island: isleAt(w, dry) })).toThrow('「湖心岛」的脚本说这里放不了');
    expect(() => eng.exec({ op: 'add_island', island: isleAt(w, sea) })).toThrow('「湖心岛」的脚本说这里放不了');
    expect(w.causes.islandHeight).toBeUndefined();
    expect(eng.history.at(-1)?.summary).not.toContain('湖心岛（');
  });

  it('伸出湖的部分被裁掉：湖边上放的大岛只占湖面的格', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    addLakeIsle(eng);
    const lake = new Uint8Array(w.derived.lake);
    eng.exec({ op: 'add_island', island: { ...isleAt(w, c), size: 900 } });
    const touched = all(w).filter((i) => w.causes.islandType[i] || w.causes.islandHeight![i] !== FREE_HEIGHT);
    expect(touched.length).toBeGreaterThan(0);
    for (const i of touched) expect(lake[i]).toBe(1);
  });

  it('重放与现场逐值相同；撤销回到放之前（去掉定高度的数组），重做回来', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    addLakeIsle(eng);
    const elev = w.derived.elevation.slice();
    const names = (e: Engine) => e.world.derived.features.map((f) => `${f.key}=${f.name}`).join('|');
    const before = names(eng);
    eng.exec({ op: 'add_island', island: isleAt(w, c) });
    const after = { elev: w.derived.elevation.slice(), lake: w.derived.lake.slice(), heights: w.causes.islandHeight!.slice(), names: names(eng) };
    const again = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(again.world.causes.islandHeight).toEqual(after.heights);
    expect(again.world.causes.islandType).toEqual(w.causes.islandType);
    expect(again.world.derived.elevation).toEqual(after.elev);
    expect(again.world.derived.lake).toEqual(after.lake);
    expect(names(again)).toBe(after.names);
    eng.undo();
    expect(eng.world.causes.islandHeight).toBeUndefined();
    expect(eng.world.derived.elevation).toEqual(elev);
    expect(names(eng)).toBe(before);
    eng.redo();
    expect(eng.world.causes.islandHeight).toEqual(after.heights);
    expect(eng.world.derived.elevation).toEqual(after.elev);
    expect(names(eng)).toBe(after.names);
  });

  it('画海、恢复原样画到的地方不再定高度；湖单独成省时岛是陆地省', () => {
    const { eng, c } = withLake();
    const w = eng.world;
    addLakeIsle(eng);
    eng.exec({ op: 'generate_provinces', rules: { lakeMode: 'separate', seed: 3 } });
    eng.exec({ op: 'add_island', island: isleAt(w, c) });
    const isle = all(w).filter((i) => w.causes.islandHeight![i] !== FREE_HEIGHT);
    for (const i of isle) {
      const meta = w.small.provinces[w.causes.province[i]];
      expect(meta.kind).toBe('land');
    }
    eng.exec({ op: 'restore_terrain', cells: isle, t: isle.map(() => 0) });
    for (const i of isle) expect(w.causes.islandHeight![i]).toBe(FREE_HEIGHT);
    // 恢复原样：又是湖
    for (const i of isle) expect(w.derived.lake[i]).toBe(1);
  });

  it('脚本是纯的：正着、倒着、隔一格算结果一样；同样的输入两次结果逐值相同', () => {
    const n = 400;
    const r = Float64Array.from({ length: n }, (_, i) => (i % 40) / 30);
    const angle = Float64Array.from({ length: n }, (_, i) => (i * 0.37) % 6.28);
    const waterLevel = new Float64Array(n).fill(120);
    const inputs = arrayInputs(n, { r, angle, waterLevel, seed: 7 });
    const cells = Int32Array.from({ length: n }, (_, i) => i);
    const run = (cs: Int32Array) => runScript({ kind: 'shape', src: LAKE_ISLE_SHAPE, scope: 'island' }, { owner: '湖心岛', id: 'lake_isle', seedKey: 'lake_isle:0', seed: 7, inputs, cells: cs });
    const res = checkPurity(run, cells);
    expect(res.pure).toBe(true);
    const a = run(cells);
    const b = run(cells);
    expect(a.ok && b.ok).toBe(true);
    expect(a.output).toEqual(b.output);
    // 外圈 land: false，里面高出水面
    if (a.ok) {
      expect(a.output.land[39]).toBe(0);
      expect(a.output.height[0]).toBeGreaterThan(120 + 29);
    }
  });

  it('示例包里的岛的脚本经信任流程：找得到、叫“放在哪里”“岛的样子”', () => {
    const found = findScripts(FANTASY_PACK).filter((s) => s.id === 'lake_isle');
    expect(found.map((s) => [s.kind, s.label])).toEqual([
      ['placement', '放在哪里'],
      ['shape', '岛的样子'],
    ]);
    const cmd = { op: 'set_island_type', type: FANTASY_ISLAND_TYPES[0] };
    expect(findScripts(cmd).map((s) => s.label)).toEqual(['放在哪里', '岛的样子']);
  });
});

describe('岛的脚本（通用）', () => {
  const tall: IslandTypeInput = { id: 'tall', name: '高台岛', shape: 'round', height: 'flat', province: 'land', scripts: { shape: script('return 300;') } };

  it('没有放在哪里的脚本：只改海里的格；岛的样子给的高度就是结果的高度，只在岛的范围里', () => {
    const eng = ocean();
    const w = eng.world;
    eng.exec({ op: 'set_island_type', type: tall });
    const land0 = w.causes.land.slice();
    eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'tall', size: 120, variant: 3 } });
    const fixed = all(w).filter((i) => w.causes.islandHeight![i] !== FREE_HEIGHT);
    expect(fixed.length).toBeGreaterThan(5);
    for (const i of fixed) {
      expect(land0[i]).toBe(0);
      expect(w.causes.land[i]).toBe(1);
      expect(w.derived.elevation[i]).toBe(300);
      // 岛的范围：离岛心不超过岛的大小（再多一格）
      expect(Math.hypot(w.mesh.x[i] - 1, w.mesh.y[i] - 0.5) * w.kmPerUnit).toBeLessThan(120 * 1.8 + w.mesh.spacing * w.kmPerUnit);
    }
  });

  it('放在哪里的脚本裁掉岛的一部分：只占脚本说行的格，别的格一格不动', () => {
    const eng = ocean();
    const w = eng.world;
    eng.exec({ op: 'set_island_type', type: { id: 'half', name: '半边岛', shape: 'round', height: 'flat', province: 'land', scripts: { placement: script('return x < 1.0;') } } });
    const before = { land: w.causes.landDelta.slice() };
    eng.exec({ op: 'add_island', island: { x: 0.99, y: 0.5, kind: 'half', size: 200, variant: 1 } });
    let left = 0;
    for (const i of all(w)) {
      if (w.causes.landDelta[i] === before.land[i]) continue;
      expect(w.mesh.x[i]).toBeLessThan(1);
      left++;
    }
    expect(left).toBeGreaterThan(5);
    // 岛心在右边：不放
    expect(() => eng.exec({ op: 'add_island', island: { x: 1.2, y: 0.5, kind: 'half', size: 200, variant: 2 } })).toThrow('「半边岛」的脚本说这里放不了');
  });

  it('岛链：每个岛按放在哪里裁，岛心不行的岛不放', () => {
    const eng = ocean();
    const w = eng.world;
    eng.exec({ op: 'set_island_type', type: { id: 'west', name: '西岛', shape: 'round', height: 'flat', province: 'land', scripts: { placement: script('return x < 1.0;') } } });
    const s = eng.exec({ op: 'add_island_chain', chain: { points: [[0.6, 0.5], [1.4, 0.5]], kind: 'west', size: 60, variant: 0 } });
    expect(s).toMatch(/^画了一条岛链：\d+ 个西岛$/);
    for (const i of all(w)) if (w.causes.islandType[i]) expect(w.mesh.x[i]).toBeLessThan(1);
    expect(() => eng.exec({ op: 'add_island_chain', chain: { points: [[1.2, 0.5], [1.6, 0.5]], kind: 'west', size: 60, variant: 0 } })).toThrow('「西岛」的脚本说这里放不了');
  });

  it('脚本出错：那一段按没有脚本放（与不带脚本的同一种岛逐值相同），说明里写出来', () => {
    const a = ocean();
    const b = ocean();
    const plain = { id: 'p', name: '石岛', shape: 'round' as const, height: 'flat' as const, province: 'land' as const, rock: 0.8 };
    a.exec({ op: 'set_island_type', type: plain });
    b.exec({ op: 'set_island_type', type: { ...plain, scripts: { shape: script("return '高';"), placement: script('return nothere > 1;') } } });
    const spec = { x: 1, y: 0.5, kind: 'p', size: 120, variant: 5 };
    a.exec({ op: 'add_island', island: spec });
    const s = b.exec({ op: 'add_island', island: spec });
    expect(s).toContain('「石岛」的放在哪里脚本');
    expect(s).toContain('按没有这段脚本放的');
    expect(b.world.causes.landDelta).toEqual(a.world.causes.landDelta);
    expect(b.world.causes.erodDelta).toEqual(a.world.causes.erodDelta);
    expect(b.world.causes.islandType).toEqual(a.world.causes.islandType);
    expect(b.world.causes.islandHeight).toBeUndefined();
  });

  it('安全模式下脚本不运行：按没有脚本放', () => {
    const a = ocean();
    a.exec({ op: 'set_island_type', type: tall });
    setScriptsEnabled(false);
    try {
      const s = a.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'tall', size: 120, variant: 3 } });
      expect(s).toContain('安全模式下脚本不运行');
      expect(a.world.causes.islandHeight).toBeUndefined();
    } finally {
      setScriptsEnabled(true);
    }
  });

  it('语法错误：新建、修改种类时就拒绝；只能有两种脚本；带脚本的岛不能放进批量命令', () => {
    const eng = ocean();
    expect(() => eng.exec({ op: 'set_island_type', type: { ...tall, scripts: { shape: script('return (1;') } } })).toThrow('「高台岛」的岛的样子脚本有语法错误');
    expect(() => eng.exec({ op: 'set_island_type', type: { ...tall, scripts: { color: script('return [1, 2, 3];') } } })).toThrow('只能有“放在哪里”和“岛的样子”两种脚本');
    eng.exec({ op: 'set_island_type', type: tall });
    expect(() => eng.exec({ op: 'batch', commands: [{ op: 'add_island', island: { x: 1, y: 0.5, kind: 'tall', size: 120, variant: 0 } }] })).toThrow('不能放进批量命令');
  });

  it('只给岛的变量只在岛的脚本里有', () => {
    const eng = continents().clone();
    expect(() =>
      eng.exec({ op: 'set_island_type', type: { ...tall, scripts: { placement: script('return 离岛心 < 0.5 && 水面高度 > 0 && 是海 === 0 && 方位 > 0 && 岛的大小 > 1;') } } }),
    ).not.toThrow();
    const sp = structuredClone(eng.world.small.species.find((s) => s.id === 'temperate_forest')!);
    const r = eng.exec({ op: 'update_species', id: sp.id, patch: { scripts: { placement: script('return 离岛心 < 0.5;') } } });
    expect(eng.world.derived.scriptIssues?.[0]?.text).toContain('只有岛的种类的脚本能用');
    expect(r).toBeTruthy();
  });
});
