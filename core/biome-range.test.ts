import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { activeConflicts } from './constraints';
import { Engine } from './engine';
import { lakeParts, lakeShores } from './lake-types';
import { type RiverType, riverNet } from './river-types';
import type { Species } from './species';
import { continents, engineFor } from './testing/fixtures';
import { baseBiomes, explainCell, landmassCells } from './vegetation';
import type { World } from './world';

// 第十二轮 A：生态只长在某个岛上 / 圈的范围里、“自然生成”开关（生态、河流类型、湖泊类型）、
// 水体类型“只在这些生态里出现”与脚本的 biome()、没涂成的“就这样”

const archipelago = () => {
  const eng = engineFor({ cells: 12000, seed: 1, latNorth: 30, latSouth: 0 });
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true });
  return eng;
};

// 岛上最多的那种生态
function mostOn(w: World, cells: ArrayLike<number>): number {
  const count = new Map<number, number>();
  for (let k = 0; k < cells.length; k++) {
    const s = w.derived.dominant[cells[k]];
    if (s >= 0) count.set(s, (count.get(s) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

// 放几个湖（内陆平地，彼此隔开）
function addLakes(eng: Engine, count = 3) {
  const w = eng.world;
  const d = w.derived;
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n && out.length < count; i++) {
    if (!w.causes.land[i] || d.lake[i] || d.continentality[i] < 0.55 || d.slope[i] > 6) continue;
    if (out.some((c) => Math.hypot(w.mesh.x[c] - w.mesh.x[i], w.mesh.y[c] - w.mesh.y[i]) < 0.12)) continue;
    out.push(i);
  }
  out.forEach((cell, k) => eng.exec({ op: 'add_lake', lake: { id: `L${k}`, cell, radius: 80 + 40 * k, depth: 150, perennial: true } }));
}

const replayDigest = (eng: Engine) => digestWorld(Engine.fromDoc(eng.toDoc(), eng.world.mesh).world);

describe('生态只长在哪里（range）', () => {
  it('只在一个岛上：整个岛上原来最多的那种都换成它，岛外一格不变；撤销、重放一致', () => {
    const eng = archipelago();
    const w = eng.world;
    const island = w.derived.features.filter((f) => f.type === 'island').sort((a, b) => b.cells.length - a.cells.length)[0];
    const base = mostOn(w, island.cells);
    const before = w.derived.dominant.slice();
    const sp: Species = { ...structuredClone(w.small.species[base]), id: 'isle', name: '岛上的林', competition: w.small.species[base].competition * 3, range: { kind: 'island', cell: island.anchor } };
    eng.exec({ op: 'add_species', species: sp });
    const s = w.small.species.findIndex((x) => x.id === 'isle');
    const mass = landmassCells(w, island.anchor);
    let grown = 0;
    let wasBase = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!mass[i]) {
        expect(w.derived.dominant[i]).toBe(before[i]);
        continue;
      }
      if (before[i] === base) wasBase++;
      if (w.derived.dominant[i] === s) grown++;
    }
    // 竞争力高出一大截：原来是底生态的格全换成它（不再像以前那样只换一半）
    expect(grown).toBeGreaterThanOrEqual(wasBase);
    expect(grown).toBeGreaterThan(0);
    // 岛外：说清是范围外
    const outside = [...Array(w.mesh.n).keys()].find((i) => !mass[i] && before[i] === base)!;
    expect(explainCell(w, w.derived, outside).find((e) => e.species === 'isle')!.why).toBe('range');
    expect(digestWorld(w)).toEqual(replayDigest(eng));
  });

  it('圈的范围：只长在圈的格里；涂在范围外的没涂成，说明里说是范围外', () => {
    const eng = continents();
    const w = eng.world;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1);
    const centre = land[600];
    const near = (c: number, r: number) => land.filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < r);
    const cells = near(centre, 0.06);
    const forest = w.small.species.find((x) => x.id === 'temperate_forest')!;
    eng.exec({ op: 'add_species', species: { ...structuredClone(forest), id: 'ringed', name: '圈里的', competition: 50, tolerances: [], range: { kind: 'cells', cells } } });
    const s = w.small.species.findIndex((x) => x.id === 'ringed');
    const inRange = new Set(cells);
    let grown = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.derived.dominant[i] !== s) continue;
      expect(inRange.has(i)).toBe(true);
      grown++;
    }
    expect(grown).toBe(cells.length);
    const far = land.find((i) => !inRange.has(i) && Math.hypot(w.mesh.x[i] - w.mesh.x[centre], w.mesh.y[i] - w.mesh.y[centre]) > 0.3)!;
    eng.exec({ op: 'add_constraint', constraint: { cells: near(far, 0.03), species: 'ringed', mode: 'constraint' } });
    const c = w.derived.conflicts.find((x) => x.species === 'ringed')!;
    expect(c).toBeTruthy();
    expect(c.suggestions.join('')).toContain('生态的范围外');
  });
});

describe('自然生成（natural）', () => {
  it('不自然生成的生态：一格都不长，只长在涂了它的格里（涂的格里照样自然融入）', () => {
    const eng = continents();
    const w = eng.world;
    const forest = w.small.species.find((x) => x.id === 'temperate_forest')!;
    const before = w.derived.dominant.slice();
    eng.exec({ op: 'add_species', species: { ...structuredClone(forest), id: 'mine', name: '我的林', competition: forest.competition * 4, natural: false } });
    const s = w.small.species.findIndex((x) => x.id === 'mine');
    expect(w.derived.dominant.every((v, i) => v === before[i])).toBe(true);
    // 打开就到处长
    eng.exec({ op: 'update_species', id: 'mine', patch: { natural: true } });
    const natural = w.derived.dominant.filter((v) => v === s).length;
    expect(natural).toBeGreaterThan(50);
    eng.undo();
    expect(w.derived.dominant.filter((v) => v === s).length).toBe(0);
    // 涂一片
    const at = [...Array(w.mesh.n).keys()].find((i) => before[i] === w.small.species.findIndex((x) => x.id === 'temperate_forest'))!;
    const patch = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && Math.hypot(w.mesh.x[i] - w.mesh.x[at], w.mesh.y[i] - w.mesh.y[at]) < 0.05);
    eng.exec({ op: 'add_constraint', constraint: { cells: patch, species: 'mine', mode: 'constraint' } });
    const inPatch = new Set(patch);
    let grown = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.derived.dominant[i] !== s) continue;
      expect(inPatch.has(i)).toBe(true);
      grown++;
    }
    expect(grown).toBeGreaterThan(0);
    const outside = [...Array(w.mesh.n).keys()].find((i) => !inPatch.has(i) && w.causes.land[i] && w.derived.lake[i] !== 1)!;
    expect(explainCell(w, w.derived, outside).find((e) => e.species === 'mine')!.why).toBe('natural');
    expect(digestWorld(w)).toEqual(replayDigest(eng));
  });

  it('关掉自然生成的河流类型、湖泊类型：match 不跑，一条河、一个湖都不是它；选了它的河照样是', () => {
    const eng = continents();
    const w = eng.world;
    addLakes(eng);
    const all: RiverType = { id: 'all', name: '全都是', color: '#123456', scripts: { match: { api: 1, src: 'return true;' } } };
    eng.exec({ op: 'set_river_type', type: all });
    expect(w.derived.riverType!.some((v) => v === 1)).toBe(true);
    eng.exec({ op: 'set_river_type', type: { ...all, natural: false } });
    expect(w.derived.riverType!.every((v) => v === 0)).toBe(true);
    eng.exec({ op: 'set_lake_type', type: { id: 'pool', name: '池', color: '#654321', scripts: { match: { api: 1, src: 'return true;' } } } });
    const lakes = lakeParts(w, w.derived).lakes.length;
    expect(lakes).toBeGreaterThan(0);
    expect(w.derived.lakeType!.some((v) => v === 1)).toBe(true);
    eng.exec({ op: 'set_lake_type', type: { id: 'pool', name: '池', color: '#654321', natural: false, scripts: { match: { api: 1, src: 'return true;' } } } });
    expect(w.derived.lakeType!.every((v) => v === 0)).toBe(true);
  });
});

describe('水体类型只在这些生态里出现（biomes）、脚本的 biome()', () => {
  it('只选了生态：流经的格至少一半是那几种的河都是它，别的不是；与脚本 biome() 写法一样；重放一致', () => {
    const eng = continents();
    const w = eng.world;
    const S = w.small.species;
    // 河最多流经的两种生态
    const net = riverNet(w, w.derived);
    const count = new Map<number, number>();
    for (const cells of net.stems) for (const c of cells) count.set(w.derived.dominant[c], (count.get(w.derived.dominant[c]) ?? 0) + 1);
    const top = [...count].filter(([k]) => k >= 0).sort((a, b) => b[1] - a[1]);
    const pick = [S[top[1][0]].id];
    eng.exec({ op: 'set_river_type', type: { id: 'b', name: '生态河', color: '#336699', natural: true, biomes: pick } as never });
    const base = baseBiomes(w, w.derived);
    const k = S.findIndex((x) => x.id === pick[0]);
    const typed = w.derived.riverType!.slice();
    let yes = 0;
    let no = 0;
    for (const cells of riverNet(w, w.derived).stems) {
      let hit = 0;
      let total = 0;
      for (const c of cells) {
        if (base[c] < 0) continue;
        total++;
        if (base[c] === k) hit++;
      }
      const inside = total > 0 && hit * 2 >= total;
      // 往下游传会给不在那几种生态里的河的下游染色，只看每条河的源头那一格
      if (inside) {
        expect(typed[cells[0]]).toBe(1);
        yes++;
      } else if (typed[cells[0]] === 0) no++;
    }
    expect(yes).toBeGreaterThan(0);
    expect(no).toBeGreaterThan(0);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    // 同样的条件写成脚本
    eng.exec({ op: 'set_river_type', type: { id: 'b', name: '生态河', color: '#336699', natural: true, scripts: { match: { api: 1, src: `return biome('${pick[0]}') >= 0.5;` } } } as never });
    expect(Array.from(w.derived.riverType!)).toEqual(Array.from(typed));
    expect(w.derived.scriptIssues ?? []).toEqual([]);
    // dominantBiome、biomeAtSource 返回生态的 id
    eng.exec({ op: 'set_river_type', type: { id: 'b', name: '生态河', color: '#336699', natural: true, scripts: { match: { api: 1, src: `return dominantBiome() === '${S[top[0][0]].id}' && typeof biomeAtSource() === 'string' && typeof biomeAtMouth() === 'string';` } } } as never });
    expect(w.derived.scriptIssues ?? []).toEqual([]);
    expect(w.derived.riverType!.some((v) => v === 1)).toBe(true);
    // 没有这种生态：一条都不是
    eng.exec({ op: 'set_river_type', type: { id: 'b', name: '生态河', color: '#336699', natural: true, biomes: ['nothing_here'] } as never });
    expect(w.derived.riverType!.every((v) => v === 0)).toBe(true);
  });

  it('湖：按湖岸一圈的生态；生态的“长在哪里”脚本里用 biome() 是出错说明', () => {
    const eng = continents();
    addLakes(eng);
    const w = eng.world;
    const parts = lakeParts(w, w.derived);
    const shores = lakeShores(w, parts);
    expect(parts.lakes.length).toBeGreaterThan(0);
    const base = baseBiomes(w, w.derived);
    // 第一个湖岸边最多的生态
    const first = shores.findIndex((s) => s.some((c) => base[c] >= 0));
    const k = mostOn({ ...w, derived: { ...w.derived, dominant: base } } as World, shores[first]);
    const id = w.small.species[k].id;
    eng.exec({ op: 'set_lake_type', type: { id: 'shore', name: '岸湖', color: '#225588', natural: true, biomes: [id] } as never });
    const lt = w.derived.lakeType!;
    expect(lt[parts.lakes[first][0]]).toBe(1);
    expect(digestWorld(w)).toEqual(replayDigest(eng));
    eng.exec({ op: 'set_lake_type', type: { id: 'shore', name: '岸湖', color: '#225588', natural: true, scripts: { match: { api: 1, src: `return biome('${id}') >= 0.5 && biomeAtSource() === '';` } } } as never });
    expect((w.derived.scriptIssues ?? []).some((x) => x.text.includes('biomeAtSource() 只在河流类型的规则里有'))).toBe(true);
    eng.exec({ op: 'update_species', id: 'desert', patch: { scripts: { placement: { api: 1, src: "return biome('desert');" } } } });
    expect((w.derived.scriptIssues ?? []).some((x) => x.text.includes('只能在河流类型、湖泊类型的规则'))).toBe(true);
  });
});

describe('没涂成的“就这样”', () => {
  it('记号只改提醒：冲突照样算、推导不变；恢复、撤销、重放都一致', () => {
    const eng = continents();
    const w = eng.world;
    const cold = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.tMean[i] < -5).slice(0, 40);
    eng.exec({ op: 'add_constraint', constraint: { id: 'hot', cells: cold, species: 'rainforest', mode: 'constraint' } });
    expect(activeConflicts(w).map((c) => c.constraintId)).toContain('hot');
    const digest = digestWorld(w);
    const conflicts = JSON.stringify(w.derived.conflicts);
    eng.exec({ op: 'update_constraint', id: 'hot', patch: { ignored: true } });
    expect(eng.history.at(-1)!.summary).toContain('忽略没涂成');
    expect(JSON.stringify(w.derived.conflicts)).toBe(conflicts);
    expect(activeConflicts(w).map((c) => c.constraintId)).not.toContain('hot');
    expect(w.small.constraints.find((c) => c.id === 'hot')!.ignored).toBe(true);
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toEqual(digestWorld(w));
    eng.undo();
    expect(digestWorld(w)).toEqual(digest);
    expect(activeConflicts(w).map((c) => c.constraintId)).toContain('hot');
    eng.redo();
    eng.exec({ op: 'update_constraint', id: 'hot', patch: { ignored: false } });
    expect(activeConflicts(w).map((c) => c.constraintId)).toContain('hot');
  });
});
