import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { forgetScriptResults, placementSlots } from './biome-scripts';
import { Dirty } from './commands';
import { Engine, passStats } from './engine';
import { graphDistance } from './mesh';
import { FANTASY_RIVER_TYPES } from './packs/fantasy-rivers';
import { type RiverType, PLAIN_RIVER, matchRunStats, riverBank, riverNet, riverTypeSchema } from './river-types';
import { stemPath, traceRivers } from './rivers';
import { riverStem } from './select';
import { continents } from './testing/fixtures';
import { type World, buildMeshFor, settingsSchema } from './world';

// 河流类型：每格是哪一种河（画的河带类型、每条河一次的 match、往下游传）、河岸场、只改样子不重算、起名、重放与撤销

const blood: RiverType = { id: 'blood', name: '血河', color: '#8f1414' };
const typeOf = (w: World, i: number) => w.derived.riverType?.[i] ?? 0;

// 一条较长、汇入更大的河的自然的河（从源头往下）：它的最后一格流进的那一格是那条更大的河的
function tributary(w: World): Int32Array {
  const net = riverNet(w, w.derived);
  const d = w.derived;
  const list = net.stems.filter((cells) => {
    const r = d.receiver[cells[cells.length - 1]];
    return cells.length >= 6 && r >= 0 && net.isRiver[r] === 1;
  });
  list.sort((a, b) => b.length - a.length || a[0] - b[0]);
  expect(list.length).toBeGreaterThan(0);
  return list[0];
}

describe('河流类型：每格是哪一种河', () => {
  it('没有河流类型的世界里没有 riverType 这个键；新建再删掉后为 undefined', () => {
    const eng = continents();
    expect('riverType' in eng.world.derived).toBe(false);
    expect('effT' in eng.world.derived).toBe(false);
    expect(eng.world.small.riverTypes).toBeUndefined();
    eng.exec({ op: 'set_river_type', type: blood });
    expect(eng.world.derived.riverType).toBeInstanceOf(Uint8Array);
    // 没有规则、没有河选它：一格都不是
    expect(eng.world.derived.riverType!.every((v) => v === 0)).toBe(true);
    eng.exec({ op: 'remove_river_type', id: 'blood' });
    expect(eng.world.derived.riverType).toBeUndefined();
  });

  it('画的河带类型：这一段和下游的主干都是它，汇入更大的河就停了', () => {
    const eng = continents();
    eng.exec({ op: 'set_river_type', type: blood });
    const w = eng.world;
    const stem = tributary(w);
    const top = Array.from(stem.slice(0, Math.ceil(stem.length / 2)));
    eng.exec({ op: 'add_guide', guide: { cells: top, path: stemPath(w, top), locked: true, spring: false, name: '', type: 'blood' } });
    const d = w.derived;
    for (const c of top) expect(typeOf(w, c)).toBe(1);
    // 执行后的这条河：从画的那段的源头往下
    const net = riverNet(w, d);
    const mine = net.stems.find((cells) => cells.includes(top[0]))!;
    expect(mine).toBeDefined();
    // 画的那段是它选的；之后的每一格，只要上一格的水不少于这一格的一半，就跟着上一格
    let typed = 0;
    for (let q = 0; q < mine.length; q++) {
      const c = mine[q];
      if (q >= top.length && d.discharge[mine[q - 1]] < 0.5 * d.discharge[c]) break;
      expect(typeOf(w, c), `第 ${q} 格`).toBe(1);
      typed++;
    }
    expect(typed).toBeGreaterThan(top.length);
    // 汇入的那条更大的河：不是血河（一格都不传过去）
    const join = d.receiver[mine[mine.length - 1]];
    expect(net.isRiver[join]).toBe(1);
    const big = net.stems.find((cells) => cells.includes(join))!;
    expect(big.every((c) => typeOf(w, c) === 0)).toBe(true);
  });

  it('match 每条河只算一次（变量是整条河的汇总），不会一段是一段不是', () => {
    const eng = continents();
    const w = eng.world;
    const before = riverNet(w, w.derived).stems.length;
    const runs = matchRunStats.rivers;
    const passes = passStats.passes;
    eng.exec({
      op: 'set_river_type',
      type: { ...blood, scripts: { match: { api: 1, src: '// 长河\nreturn 河长 > 300 && 流量 > 2 * 河流门槛 && fbmAt(2, 2) > -0.1;' } } },
    });
    // 没有涂色、没有影响：只算一遍，每条河一次
    expect(passStats.passes - passes).toBe(1);
    const net = riverNet(w, w.derived);
    expect(net.stems.length).toBe(before);
    expect(matchRunStats.rivers - runs).toBe(net.stems.length);
    let matched = 0;
    for (const cells of net.stems) {
      const t = typeOf(w, cells[0]);
      for (const c of cells) expect(typeOf(w, c)).toBe(t);
      if (t) matched++;
    }
    expect(matched).toBeGreaterThan(0);
    expect(matched).toBeLessThan(net.stems.length);
    expect(w.derived.scriptIssues).toBeUndefined();
  });

  it('选了“普通的河”的画的河不按规则变；规则出错时按不匹配处理，说明记下', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: { ...blood, scripts: { match: { api: 1, src: 'return true;' } } } });
    const stem = tributary(w);
    expect(Array.from(stem).every((c) => typeOf(w, c) === 1)).toBe(true);
    const cells = Array.from(stem);
    eng.exec({ op: 'add_guide', guide: { cells, path: stemPath(w, cells), locked: true, spring: false, name: '', type: PLAIN_RIVER } });
    expect(cells.slice(0, -1).every((c) => typeOf(w, c) === 0)).toBe(true);
    eng.exec({ op: 'set_river_type', type: { ...blood, scripts: { match: { api: 1, src: 'const o = undefined;\nreturn o.x;' } } } });
    expect(w.derived.riverType!.every((v) => v === 0)).toBe(true);
    expect(w.derived.scriptIssues?.[0]).toMatchObject({ kind: 'match', id: 'blood', line: 2 });
  });

  it('删掉一种河：选了它的画的河变回普通的河（撤销时一起回来）', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: blood });
    const top = Array.from(tributary(w).slice(0, 4));
    eng.exec({ op: 'add_guide', guide: { cells: top, path: stemPath(w, top), locked: true, spring: false, name: '', type: 'blood' } });
    eng.exec({ op: 'remove_river_type', id: 'blood' });
    expect(w.small.guides.at(-1)!.type).toBeUndefined();
    eng.undo();
    expect(w.small.guides.at(-1)!.type).toBe('blood');
    expect(typeOf(w, top[0])).toBe(1);
  });
});

describe('河岸场 river:<id>', () => {
  it('在 0–1 之间，河上为 1，范围以外为 0', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: { ...blood, bank: { radiusKm: 300 }, scripts: { match: { api: 1, src: 'return 流量 > 3 * 河流门槛;' } } } });
    const d = w.derived;
    const bank = riverBank(w, d, 'blood')!;
    expect(bank).toBeInstanceOf(Float32Array);
    const seeds: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (d.riverType![i] === 1) seeds.push(i);
    expect(seeds.length).toBeGreaterThan(0);
    const R = 300 / w.kmPerUnit;
    const dist = graphDistance(w.mesh, seeds);
    let inside = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      expect(bank[i]).toBeGreaterThanOrEqual(0);
      expect(bank[i]).toBeLessThanOrEqual(1);
      if (dist[i] === 0) expect(bank[i]).toBe(1);
      if (dist[i] > R) expect(bank[i]).toBe(0);
      if (dist[i] > 0 && dist[i] < R * 0.5) inside++;
    }
    expect(inside).toBeGreaterThan(0);
    // 按内容缓存：再要一次是同一份
    expect(riverBank(w, d, 'blood')).toBe(bank);
    // 没有这种河时没有河岸场
    expect(riverBank(w, d, 'nothing')).toBeUndefined();
  });

  it('生态的脚本、耐受条件都能用它：长在血河两岸', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: { ...blood, bank: { radiusKm: 200 }, scripts: { match: { api: 1, src: 'return 流量 > 3 * 河流门槛;' } } } });
    const tol = { field: 'river:blood', min: 0.2, optLow: 0.5, optHigh: 1, max: 1 };
    eng.exec({ op: 'add_species', species: { id: 'red', name: '红原', color: '#aa2222', competition: 50, tolerances: [tol] } });
    eng.exec({ op: 'add_species', species: { id: 'red2', name: '红林', color: '#aa4422', competition: 0.01, tolerances: [], scripts: { placement: { api: 1, src: "return hasRiver('blood') ? river('blood') : 0;" } } } });
    const d = w.derived;
    const bank = riverBank(w, d, 'blood')!;
    const red = w.small.species.findIndex((s) => s.id === 'red');
    let n = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (d.dominant[i] !== red) continue;
      n++;
      expect(bank[i]).toBeGreaterThanOrEqual(0.2);
    }
    expect(n).toBeGreaterThan(0);
    const P = 1;
    const f = d.placeF!;
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && d.lake[i] !== 1) expect(f[i * P]).toBeCloseTo(bank[i], 6);
  });
});

describe('生态脚本记住的结果：河岸场变了照样对', () => {
  it('血河换了几条、一条都没有了、又有了、撤销：每一步都与另一个网格上从头算的逐值相同', () => {
    const eng = continents();
    const w = eng.world;
    const rule = (src: string) => ({ ...blood, bank: { radiusKm: 250 }, scripts: { match: { api: 1 as const, src } } });
    eng.exec({ op: 'set_river_type', type: rule('return 流量 > 3 * 河流门槛;') });
    eng.exec({
      op: 'add_species',
      species: {
        id: 'red',
        name: '红林',
        color: '#aa4422',
        competition: 3,
        tolerances: [],
        scripts: { placement: { api: 1, src: "if (hasRiver('blood')) return smoothstep(0.3, 0.7, river('blood'));\nreturn 0.25;" } },
      },
    });
    // 另一个网格（没有这个网格上记下的结果）：每次先忘掉，再从头重放
    const fresh = buildMeshFor(settingsSchema.parse(w.settings));
    const same = (label: string) => {
      forgetScriptResults(fresh);
      expect(digestWorld(Engine.fromDoc(eng.toDoc(), fresh).world), label).toEqual(digestWorld(w));
    };
    const slot = placementSlots(w.small.species).slot[w.small.species.findIndex((s) => s.id === 'red')];
    const { P } = placementSlots(w.small.species);
    const factors = () => new Set(Array.from({ length: w.mesh.n }, (_, i) => w.derived.placeF![i * P + slot]));
    same('有血河');
    expect(factors().size).toBeGreaterThan(2);
    eng.exec({ op: 'set_river_type', type: rule('return 流量 > 12 * 河流门槛;') });
    same('血河少了');
    eng.exec({ op: 'set_river_type', type: rule('return false;') });
    same('没有血河');
    // 没有血河：hasRiver 为假，每格都是 0.25
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && w.derived.lake[i] !== 1) expect(w.derived.placeF![i * P + slot]).toBeCloseTo(0.25, 6);
    eng.exec({ op: 'set_river_type', type: rule('return 流量 > 3 * 河流门槛;') });
    same('又有了');
    eng.undo();
    same('撤销');
  });
});

describe('只改样子不重算', () => {
  it('只改颜色、画法、粗细：推导一点不动（轻快照）；改名字、模板只重新起名；改规则从水文起重算', () => {
    const eng = continents();
    const w = eng.world;
    const t = { ...blood, scripts: { match: { api: 1 as const, src: 'return 流量 > 3 * 河流门槛;' } } };
    eng.exec({ op: 'set_river_type', type: t });
    eng.takeRecomputed();
    const d = w.derived;
    const rt = d.riverType;
    eng.exec({ op: 'set_river_type', type: { ...t, color: '#123456', style: 'glow', width: 2, atlasColor: '#654321' } });
    expect(eng.takeRecomputed()).toBe(Dirty.None);
    expect(w.derived).toBe(d);
    expect(w.derived.riverType).toBe(rt);
    expect(eng.history.at(-1)!.summary).toBe('修改河流类型“血河”');
    eng.exec({ op: 'set_river_type', type: { ...t, color: '#123456', style: 'glow', width: 2, atlasColor: '#654321', names: [{ p: '{color}血河' }] } });
    expect(eng.takeRecomputed()).toBe(Dirty.Names);
    eng.exec({ op: 'set_river_type', type: { ...t, scripts: { match: { api: 1, src: 'return false;' } } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Vegetation);
    // 脚本有语法错误：整条命令不生效
    expect(() => eng.exec({ op: 'set_river_type', type: { ...t, scripts: { match: { api: 1, src: 'return (;' } } } })).toThrow(/血河/);
    // 只能有 match
    expect(() => eng.exec({ op: 'set_river_type', type: { ...t, scripts: { placement: { api: 1, src: 'return 1;' } } } })).toThrow(/只能有/);
    // plain 是留给“普通的河”的
    expect(riverTypeSchema.safeParse({ ...blood, id: PLAIN_RIVER }).success).toBe(false);
  });
});

describe('名字', () => {
  it('带类型的河用那种河的模板起名（第二轮）；给一条自然的河固定并选类型，名字照旧', () => {
    const eng = continents();
    const w = eng.world;
    const names = w.derived.features.filter((f) => f.type === 'river').map((f) => [f.key, f.name]);
    expect(names.length).toBeGreaterThan(2);
    eng.exec({ op: 'set_river_type', type: blood });
    // 没有河是血河：名字一个不变
    expect(w.derived.features.filter((f) => f.type === 'river').map((f) => [f.key, f.name])).toEqual(names);

    // 固定一条有名字的自然河并选血河（一步）：名字照旧，也不是“自己改过”的
    const f = w.derived.features.filter((x) => x.type === 'river' && x.guide === undefined).sort((a, b) => b.importance - a.importance)[0];
    const mouth = f.cells[0];
    const stem = riverStem(w, w.derived, mouth);
    const cells = stem.cells;
    eng.exec({ op: 'add_guide', guide: { cells, path: stemPath(w, cells), locked: true, spring: false, nameKey: f.key, type: 'blood' }, label: `${f.name}改成血河` });
    const g = w.small.guides.at(-1)!;
    const pinned = w.derived.features.find((x) => x.guide === g.id)!;
    expect(pinned.name).toBe(f.name);
    expect(pinned.custom).toBe(false);
    expect(cells.slice(0, -1).filter((c) => w.derived.lake[c] !== 1 && w.causes.land[c]).every((c) => typeOf(w, c) === 1)).toBe(true);

    // 带模板、按规则成了血河的自然的河：用模板起名
    eng.exec({ op: 'set_river_type', type: { ...blood, names: [{ p: '{color}血河' }], scripts: { match: { api: 1, src: 'return true;' } } } });
    const typed = w.derived.features.filter((x) => x.type === 'river' && x.guide === undefined);
    expect(typed.length).toBeGreaterThan(0);
    for (const x of typed) {
      expect(x.tags).toContain('rtype:blood');
      expect(x.name.endsWith('血河')).toBe(true);
    }
    // 固定时自己选了类型的那条：名字仍照旧
    expect(w.derived.features.find((x) => x.guide === g.id)!.name).toBe(f.name);
  });
});

describe('画出来的河', () => {
  it('每个点带着是哪一种河（与格的类型一致）；没有河流类型时不带', () => {
    const plain = continents();
    expect(traceRivers(plain.world).every((l) => l.type === undefined)).toBe(true);
    const eng = continents();
    const w = eng.world;
    eng.exec({ op: 'set_river_type', type: { ...blood, scripts: { match: { api: 1, src: 'return 流量 > 3 * 河流门槛;' } } } });
    const lines = traceRivers(w);
    let typedPts = 0;
    for (const l of lines) {
      expect(l.type).toBeDefined();
      expect(l.type!.length).toBe(l.points.length);
      // 与格的类型相同；画到别的河上的那几点（在汇合的那格里）算这条河自己的
      const last = l.cells![l.points.length - 1];
      for (let k = 0; k + 1 < l.points.length; k++) {
        if (l.cells![k] === last) continue;
        expect(l.type![k]).toBe(typeOf(w, l.cells![k]));
        if (l.type![k]) typedPts++;
      }
    }
    expect(typedPts).toBeGreaterThan(0);
    // 点与流量与没有类型时逐位相同
    const base = traceRivers(plain.world);
    expect(lines.map((l) => [l.points, l.flow])).toEqual(base.map((l) => [l.points, l.flow]));
  });
});

describe('重放、撤销、检查点', () => {
  it('与从头重放逐值一致；撤销回到原样', () => {
    const eng = continents();
    const w = eng.world;
    const start = digestWorld(w);
    for (const t of FANTASY_RIVER_TYPES) eng.exec({ op: 'set_river_type', type: t });
    const top = Array.from(tributary(w).slice(0, 5));
    eng.exec({ op: 'add_guide', guide: { cells: top, path: stemPath(w, top), locked: true, spring: false, name: '', type: 'styx' } });
    eng.exec({ op: 'set_river_type', type: { ...FANTASY_RIVER_TYPES[0], color: '#222222' } });
    eng.exec({ op: 'remove_river_type', id: 'crystal_river' });
    expect(w.derived.effT).toBeInstanceOf(Float32Array);
    const after = digestWorld(w);
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    expect(doc.version).toBe(5);
    expect(digestWorld(Engine.fromDoc(doc, w.mesh).world)).toEqual(after);
    const cp = structuredClone(eng.toCheckpoint());
    const shorter = { ...doc, commands: doc.commands.slice(0, -2) };
    const restored = Engine.fromCheckpoint(cp, shorter, w.mesh)!;
    expect(digestWorld(restored.world)).toEqual(digestWorld(Engine.fromDoc(shorter, w.mesh).world));
    for (let k = 0; k < 7; k++) eng.undo();
    expect(digestWorld(w)).toEqual(start);
    for (let k = 0; k < 7; k++) eng.redo();
    expect(digestWorld(w)).toEqual(after);
  });
});
