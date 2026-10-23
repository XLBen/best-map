import { afterEach, describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { blendRgb } from './biome-look';
import { forgetScriptResults, placementSlots, scriptRunStats } from './biome-scripts';
import { type Command, CommandError, Dirty } from './commands';
import { Engine } from './engine';
import { featureLabel } from './features';
import { graphDistance } from './mesh';
import { FANTASY_BIOMES, fantasyBiomeCommands } from './packs/fantasy-biomes';
import { smoothstep } from './rng';
import { ScriptError, setScriptsEnabled } from './script';
import { type Species, trapezoid, withRect } from './species';
import { engineFor, snapshot } from './testing/fixtures';
import { explainCell, fieldGetter, isVegetated } from './vegetation';
import { buildMeshFor, settingsSchema, type World } from './world';

// 生态的脚本与侵占（第三批）：长在哪里的系数乘进适宜度、求解器与解释里也乘上；颜色脚本写进 d.look；
// 脚本出错按没有脚本处理；只改外观、名字不重算；按格记住结果与从头算逐值相同

// 5000 格、北纬 5°–55° 的大陆（南边有暖湿的地方，水晶丛林能长）；建一次，各测试用它的副本
const world = () =>
  snapshot('b3-scripts', () => {
    const e = engineFor({ cells: 5000, seed: 2, latNorth: 55, latSouth: 5 });
    e.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', landFraction: 0.4 }, reset: true });
    return e;
  });
const script = (src: string) => ({ api: 1 as const, src });
const wide = (sp: Omit<Species, 'tolerances'>): Species => withRect({ ...sp, tolerances: [] }, { t0: -40, t1: 40, m0: 0, m1: 50 });
const veg = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => isVegetated(w, w.derived, i));
// 一片：离第 f 份处的那个长植被的格最近的 k 个长植被的格
const near = (w: World, f: number, k: number) => {
  const land = veg(w);
  const dist = graphDistance(w.mesh, [land[Math.floor(f * (land.length - 1))]]);
  return [...land].sort((a, b) => dist[a] - dist[b] || a - b).slice(0, k);
};
const fantasy = (w: World, picks?: string[]) => fantasyBiomeCommands({ fields: Object.keys(w.causes.fields), species: w.small.species.map((s) => s.id) }, picks);
// 从头算：忘掉这个网格上记下的脚本结果，再在同一个网格上重放
const scratch = (eng: Engine) => {
  forgetScriptResults(eng.world.mesh);
  const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
  return { digest: digestWorld(again.world), issues: again.world.derived.scriptIssues };
};
const sameAsScratch = (eng: Engine, label: string) => {
  const s = scratch(eng);
  expect(digestWorld(eng.world), label).toEqual(s.digest);
  expect(eng.world.derived.scriptIssues, label).toEqual(s.issues);
};

afterEach(() => setScriptsEnabled(true));

describe('长在哪里的脚本', () => {
  it('脚本条件乘进适宜度且 explainCell.placement 相同', () => {
    const eng = world();
    const glass = wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1, scripts: { placement: script('// 越高越多\nreturn clamp(elevation / 2000);') } });
    eng.exec({ op: 'add_species', species: glass });
    const w = eng.world;
    const d = w.derived;
    const S = w.small.species.length;
    const s = S - 1;
    const { slot, P } = placementSlots(w.small.species);
    expect(P).toBe(1);
    expect(slot[s]).toBe(0);
    expect(d.placeF).toBeInstanceOf(Float32Array);
    expect(d.placeF!.length).toBe(w.mesh.n);
    expect(d.scriptIssues).toBeUndefined();
    let checked = 0;
    let partial = 0;
    for (const i of veg(w)) {
      const want = Math.fround(Math.min(1, Math.max(0, d.elevation[i] / 2000)));
      expect(d.placeF![i]).toBe(want);
      let trap = 1;
      for (const t of glass.tolerances) trap *= trapezoid(t, fieldGetter(w, d, t.field)(i));
      expect(d.suit[i * S + s]).toBe(Math.fround(trap > 0 ? trap * want : 0));
      if (i % 37 === 0) {
        const e = explainCell(w, d, i).find((x) => x.species === 'glass')!;
        expect(e.placement).toBe(d.placeF![i]);
        expect(e.suitability).toBe(d.suit[i * S + s]);
        checked++;
      }
      if (want > 0 && want < 1) partial++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(partial).toBeGreaterThan(100);
    // 没有脚本的生态没有这一项
    expect(explainCell(w, d, veg(w)[0]).find((x) => x.species === 'taiga')!.placement).toBeUndefined();
  });

  it('自然融入涂水晶丛林：满足的格都在脚本 > 0 处、placeF=0 的格进冲突', () => {
    const eng = world();
    const w = eng.world;
    // 南边暖的地方一片，按 x 一分为二：西半边脚本给 1，东半边给 0
    const land = veg(w);
    const seed = land.reduce((a, b) => (w.derived.tMean[b] > w.derived.tMean[a] ? b : a));
    const dist = graphDistance(w.mesh, [seed]);
    const patch = [...land].sort((a, b) => dist[a] - dist[b] || a - b).slice(0, 60);
    const xs = patch.map((i) => w.mesh.x[i]).sort((a, b) => a - b);
    const cut = xs[xs.length >> 1];
    const crystal = { ...FANTASY_BIOMES[0], scripts: { placement: script(`return x < ${cut} ? 1 : 0;`) } };
    eng.exec({ op: 'add_species', species: crystal });
    eng.exec({ op: 'add_constraint', constraint: { id: 'c1', cells: patch, species: 'crystal_jungle', mode: 'constraint', ratio: 1, radius: 400 } });
    const d = w.derived;
    const s = w.small.species.findIndex((sp) => sp.id === 'crystal_jungle');
    const { slot, P } = placementSlots(w.small.species);
    const pf = (i: number) => d.placeF![i * P + slot[s]];
    const cells = patch.filter((i) => isVegetated(w, d, i));
    const ok = cells.filter((i) => d.dominant[i] === s);
    const zero = cells.filter((i) => pf(i) === 0);
    expect(ok.length).toBeGreaterThan(5);
    expect(zero.length).toBeGreaterThan(5);
    for (const i of ok) expect(pf(i)).toBeGreaterThan(0);
    const conflict = d.conflicts.find((c) => c.constraintId === 'c1')!;
    expect(conflict).toBeDefined();
    for (const i of zero) expect(conflict.failing).toContain(i);
    expect(conflict.suggestions.some((t) => t.includes('脚本条件'))).toBe(true);
  });

  it('脚本出错（NaN）时按没有脚本处理且记下问题、画笔照常', () => {
    const plain = world();
    plain.exec({ op: 'add_species', species: wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1 }) });
    const eng = world();
    const bad = wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1, scripts: { placement: script('const h = elevation;\nreturn h > 800 ? NaN : 0.5;') } });
    eng.exec({ op: 'add_species', species: bad });
    const d = eng.world.derived;
    expect(d.scriptIssues).toHaveLength(1);
    expect(d.scriptIssues![0].reason).toBe('value');
    expect(d.scriptIssues![0].message).toContain('「玻璃原」');
    expect(d.scriptIssues![0].text).toContain('NaN');
    // 系数全是 1：适宜度、份额与没有脚本时逐值相同
    expect(d.placeF!.every((v) => v === 1)).toBe(true);
    expect(Buffer.from(d.suit.buffer).equals(Buffer.from(plain.world.derived.suit.buffer))).toBe(true);
    expect(Buffer.from(d.dominant.buffer).equals(Buffer.from(plain.world.derived.dominant.buffer))).toBe(true);
    // 画笔照常（问题还在）；运行时抛错也一样
    const land = veg(eng.world);
    expect(() => eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 50), value: -3, mode: 'add' })).not.toThrow();
    expect(eng.world.derived.scriptIssues).toHaveLength(1);
    eng.exec({ op: 'update_species', id: 'glass', patch: { scripts: { placement: script('const a = 1;\nthrow new Error("坏了");') } } });
    const issue = eng.world.derived.scriptIssues![0];
    expect(issue.reason).toBe('runtime');
    expect(issue.line).toBe(2);
    // 修好之后问题消失（undefined）
    eng.exec({ op: 'update_species', id: 'glass', patch: { scripts: { placement: script('return 1;') } } });
    expect(eng.world.derived.scriptIssues).toBeUndefined();
  });

  it('语法错误：添加、修改生态的命令当场被拒绝，世界不变', () => {
    const eng = world();
    const before = digestWorld(eng.world);
    const steps = eng.history.length;
    const bad = wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1, scripts: { placement: script('return (elevation;') } });
    let err: unknown;
    try {
      eng.exec({ op: 'add_species', species: bad });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScriptError);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as Error).message).toContain('「玻璃原」的长在哪里脚本');
    expect(digestWorld(eng.world)).toEqual(before);
    expect(eng.history.length).toBe(steps);
    // 生态只能有两种脚本
    expect(() => eng.exec({ op: 'add_species', species: { ...bad, scripts: { match: script('return true;') } } })).toThrow('只能有');
    eng.exec({ op: 'add_species', species: { ...bad, scripts: undefined } });
    expect(() => eng.exec({ op: 'update_species', id: 'glass', patch: { scripts: { color: script('return [1, 2,') } } })).toThrow('颜色脚本');
    expect(eng.world.small.species.at(-1)!.scripts).toBeUndefined();
  });

  it('安全模式（脚本关掉）：没有 placeF、look，适宜度与没有脚本时相同', () => {
    setScriptsEnabled(false);
    const eng = world();
    eng.exec(fantasy(eng.world));
    const d = eng.world.derived;
    expect(d.placeF).toBeUndefined();
    expect(d.look).toBeUndefined();
    expect(d.scriptIssues).toBeUndefined();
  });
});

describe('侵占', () => {
  it('目标森林适宜处得分 ×(1 + k·suit)', () => {
    const swarm = FANTASY_BIOMES.find((sp) => sp.id === 'swarm_zone')!;
    // 不带脚本，只看侵占：同一个生态带不带侵占
    const without = world();
    without.exec({ op: 'add_species', species: { ...swarm, scripts: undefined, effects: undefined } });
    const eng = world();
    eng.exec({ op: 'add_species', species: { ...swarm, scripts: undefined } });
    const w = eng.world;
    const d = w.derived;
    const S = w.small.species.length;
    const s = S - 1;
    const k = swarm.effects!.invade!.strength;
    const targets = swarm.effects!.invade!.targets.map((id) => w.small.species.findIndex((x) => x.id === id)).filter((t) => t >= 0);
    let boosted = 0;
    for (const i of veg(w)) {
      let m = 0;
      for (const t of targets) m = Math.max(m, d.suit[i * S + t]);
      const ex = explainCell(w, d, i);
      const e = ex.find((x) => x.species === 'swarm_zone')!;
      expect(e.boost).toBe(1 + k * m);
      expect(e.score).toBe(d.suit[i * S + s] * swarm.competition * (1 + k * m));
      // 份额 ∝ 得分^锐度
      const kk = w.small.planet.vegSharpness;
      const total = ex.reduce((a, x) => a + (x.score > 0 ? Math.pow(x.score, kk) : 0), 0);
      if (total > 0) expect(Math.abs(e.share - (e.score > 0 ? Math.pow(e.score, kk) : 0) / total)).toBeLessThan(1e-6);
      if (m > 0.5 && d.suit[i * S + s] > 0) boosted++;
      // 适宜度不受侵占影响（没有反馈）
      expect(d.suit[i * S + s]).toBe(without.world.derived.suit[i * S + s]);
    }
    expect(boosted).toBeGreaterThan(50);
    const count = (e: Engine) => e.world.derived.dominant.reduce((a, v) => a + (v === s ? 1 : 0), 0);
    expect(count(eng)).toBeGreaterThan(count(without));
    // 没有侵占的生态没有 boost 这一项
    expect(explainCell(w, d, veg(w)[0]).find((x) => x.species === 'taiga')!.boost).toBeUndefined();
  });
});

describe('没有用到时', () => {
  it('无脚本时 derived 没有 placeF / look 键（值为 undefined，digest 不变）', () => {
    const base = world();
    const d0 = base.world.derived;
    expect('placeF' in d0).toBe(false);
    expect('look' in d0).toBe(false);
    expect('scriptIssues' in d0).toBe(false);
    // 只带外观、地名、侵占目标为空的生态：推导与不带这些项时逐值相同（只有 small 不同；
    // 带地名设定的生态自然长成的一片有自己的地名，所以地物也多了几个，见下面）
    const plain = wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 2 });
    const a = world();
    a.exec({ op: 'add_species', species: plain });
    const b = world();
    b.exec({ op: 'add_species', species: { ...plain, visual: { pattern: 'sparkle', glow: 0.4 }, feature: { label: '玻原' }, seedKey: 'x' } });
    expect(b.world.derived.placeF).toBeUndefined();
    expect(b.world.derived.look).toBeUndefined();
    const da = digestWorld(a.world);
    const db = digestWorld(b.world);
    expect(Object.keys(db).sort()).toEqual(Object.keys(da).sort());
    for (const key of Object.keys(da)) if (key !== 'small' && key !== 'derived.features') expect(db[key], key).toBe(da[key]);
    const named = b.world.derived.features.filter((f) => f.species === 'glass');
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((f) => f.type === 'biome' && featureLabel(b.world, f) === '玻原')).toBe(true);
    expect(a.world.derived.features.some((f) => f.species === 'glass')).toBe(false);
    // 用过脚本又去掉：值为 undefined
    b.exec({ op: 'update_species', id: 'glass', patch: { scripts: { placement: script('return 0.5;') } } });
    expect(b.world.derived.placeF).toBeDefined();
    b.exec({ op: 'update_species', id: 'glass', patch: { scripts: null } });
    expect(b.world.derived.placeF).toBeUndefined();
    expect(digestWorld(b.world)['derived.dominant']).toBe(da['derived.dominant']);
  });
});

describe('只改外观、名字', () => {
  it('只改外观不重算；只改名字、地名设定只重新起名；带脚本的生态改名、改脚本照旧重算', () => {
    const eng = world();
    eng.exec(fantasy(eng.world, ['crystal_jungle']));
    eng.takeRecomputed();
    const d = eng.world.derived;
    const share = d.share;
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { visual: { pattern: 'spots', glow: 0.8 } } });
    expect(eng.takeRecomputed()).toBe(Dirty.None);
    expect(eng.world.derived).toBe(d);
    expect(eng.world.derived.share).toBe(share);
    expect(eng.history.at(-1)!.summary).toBe('修改了生态“水晶丛林”的外观');
    eng.undo();
    expect(eng.takeRecomputed()).toBe(Dirty.None);
    expect(eng.world.small.species.at(-1)!.visual!.pattern).toBe('sparkle');
    // 没有脚本的生态改名：只重新起名
    eng.exec({ op: 'update_species', id: 'taiga', patch: { name: '北方针叶林', visual: { pattern: 'stripes' } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Names);
    // 带脚本的：出错的说明里有它的名字，从求解重算（脚本记着结果，不重跑）
    scriptRunStats.placement = 0;
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { name: '琉璃林', visual: { pattern: 'none' } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Solve);
    expect(scriptRunStats.placement).toBe(0);
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { feature: { label: '琉璃' } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Names);
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { scripts: { placement: script('return 0.9;') } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Solve);
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { color: '#112233' } });
    expect(eng.takeRecomputed()).toBe(Dirty.Solve);
    // 结果与从头重放逐值相同
    const again = Engine.fromDoc(eng.toDoc(), eng.world.mesh);
    expect(digestWorld(again.world)).toEqual(digestWorld(eng.world));
  });
});

describe('改名', () => {
  it('带脚本的生态改名后，出错的说明换成新名字（与重放相同）', () => {
    const eng = world();
    eng.exec({ op: 'add_species', species: wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1, scripts: { placement: script('return NaN;') } }) });
    expect(eng.world.derived.scriptIssues![0].message).toContain('「玻璃原」');
    eng.exec({ op: 'update_species', id: 'glass', patch: { name: '琉璃原' } });
    expect(eng.world.derived.scriptIssues![0].message).toContain('「琉璃原」');
    sameAsScratch(eng, '改名');
  });

  it('冲突的建议里不写生态的名字，改名后与重放相同', () => {
    const eng = world();
    const w = eng.world;
    eng.exec({ op: 'add_species', species: wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1, scripts: { placement: script('return 0;') } }) });
    eng.exec({ op: 'add_constraint', constraint: { id: 'c1', cells: near(w, 0.5, 40), species: 'glass', mode: 'constraint', ratio: 1, radius: 400 } });
    const tips = () => w.derived.conflicts.find((c) => c.constraintId === 'c1')!.suggestions;
    expect(tips().some((t) => t.includes('脚本条件'))).toBe(true);
    for (const t of tips()) expect(t).not.toContain('玻璃原');
    eng.exec({ op: 'update_species', id: 'glass', patch: { name: '琉璃原' } });
    expect(Engine.fromDoc(eng.toDoc(), w.mesh).world.derived.conflicts).toEqual(w.derived.conflicts);
  });
});

describe('地名', () => {
  it('涂出来的水晶丛林：类型名是“晶林”，名字按它的模板；只改地名设定时名字跟着变', () => {
    const eng = world();
    const w = eng.world;
    eng.exec(fantasy(w, ['crystal_jungle']));
    const land = veg(w);
    const dist = graphDistance(w.mesh, [land[Math.floor(land.length / 2)]]);
    const patch = [...land].sort((a, b) => dist[a] - dist[b] || a - b).slice(0, 40);
    eng.exec({ op: 'add_constraint', constraint: { cells: patch, species: 'crystal_jungle', mode: 'override', ratio: 1, radius: 400 } });
    const f = w.derived.features.find((x) => x.species === 'crystal_jungle')!;
    expect(f).toBeDefined();
    expect(f.type).toBe('biome');
    expect(featureLabel(w, f)).toBe('晶林');
    expect(f.name).toMatch(/(晶林|晶丛|水晶林)$/);
    eng.takeRecomputed();
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { feature: { label: '石林', names: [{ p: '{color}石林' }] } } });
    expect(eng.takeRecomputed()).toBe(Dirty.Names);
    const g = w.derived.features.find((x) => x.species === 'crystal_jungle')!;
    expect(g.key).toBe(f.key);
    expect(featureLabel(w, g)).toBe('石林');
    expect(g.name).toMatch(/石林$/);
    // 只写类型名、不写模板：用文字包里生态区的模板，{__species} 换成类型名
    eng.exec({ op: 'update_species', id: 'crystal_jungle', patch: { feature: { label: '琉璃' } } });
    expect(w.derived.features.find((x) => x.species === 'crystal_jungle')!.name).toMatch(/琉璃$/);
    const again = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(again.world.derived.features.map((x) => x.name)).toEqual(w.derived.features.map((x) => x.name));
  });
});

describe('颜色脚本', () => {
  it('look 只在有颜色脚本时存在；带脚本的生态按脚本的颜色混色', () => {
    const eng = world();
    const w = eng.world;
    eng.exec(fantasy(w, ['crystal_jungle']));
    expect(w.derived.look).toBeUndefined();
    eng.exec(fantasy(w, ['dead_forest']));
    const d = w.derived;
    expect(d.look).toBeInstanceOf(Uint8Array);
    expect(d.look!.length).toBe(w.mesh.n * 4);
    const S = w.small.species.length;
    const s = w.small.species.findIndex((sp) => sp.id === 'dead_forest');
    const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const base = w.small.species.map((sp) => rgb(sp.color));
    let scripted = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!isVegetated(w, d, i)) {
        expect(d.look![i * 4 + 3]).toBe(0);
        continue;
      }
      const colors = base.map((c) => [...c] as [number, number, number]);
      if (d.share[i * S + s] > 0.004) {
        const t = smoothstep(600, 2400, d.elevation[i]);
        const c = base[s];
        colors[s] = [0, 1, 2].map((k) => Math.round(Math.min(255, Math.max(0, c[k] + ([150, 142, 134][k] - c[k]) * t)))) as [number, number, number];
        if (t > 0) scripted++;
      }
      const want = blendRgb(d.share, i, colors).map(Math.round);
      expect([d.look![i * 4], d.look![i * 4 + 1], d.look![i * 4 + 2], d.look![i * 4 + 3]]).toEqual([...want, 255]);
    }
    expect(scripted).toBeGreaterThan(10);
    // 去掉颜色脚本：look 为 undefined
    eng.exec({ op: 'update_species', id: 'dead_forest', patch: { scripts: { placement: w.small.species[s].scripts!.placement } } });
    expect(w.derived.look).toBeUndefined();
  });
});

describe('按格记住结果', () => {
  // 加上示例生态，再自然融入、冷暖、涂自定义场、硬覆盖，撤销两步、重做一步
  const edited = () =>
    snapshot('b3-edited', () => {
      const eng = world();
      const w = eng.world;
      eng.exec(fantasy(w));
      eng.exec({ op: 'add_constraint', constraint: { cells: near(w, 0.2, 50), species: 'dead_forest', mode: 'constraint', ratio: 1, radius: 500 } });
      eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.5, 150), value: 3, mode: 'add' });
      eng.exec({ op: 'paint', field: 'field:holy', cells: near(w, 0.7, 30), value: 1, mode: 'set' });
      eng.exec({ op: 'add_constraint', constraint: { cells: near(w, 0.9, 50), species: 'swarm_zone', mode: 'override', ratio: 1, radius: 500 } });
      eng.undo();
      eng.undo();
      eng.redo();
      return eng;
    });

  it('撤销/重放与带脚本的步逐值一致（与另建一个网格从头算也相同）', () => {
    const eng = edited();
    const w = eng.world;
    const digest = digestWorld(w);
    expect(digest['derived.placeF']).toBeDefined();
    expect(digest['derived.look']).toBeDefined();
    expect(w.derived.scriptIssues).toBeUndefined();
    // 同一个网格（共用记下的结果）
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toEqual(digest);
    // 新建的网格：没有记下的结果，全部从头算
    const fresh = buildMeshFor(settingsSchema.parse(w.settings));
    expect(fresh).not.toBe(w.mesh);
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), fresh).world)).toEqual(digest);
  });

  it('检查点（结构化克隆）恢复后再执行一步，与接着做的结果逐值相同', () => {
    const eng = edited();
    const w = eng.world;
    const doc = eng.toDoc();
    const cp = structuredClone(eng.toCheckpoint());
    const next: Command = { op: 'paint', field: 'moistOffset', cells: near(w, 0.3, 80), value: -0.5, mode: 'add' };
    eng.exec(next);
    const restored = Engine.fromCheckpoint(cp, { ...doc, commands: [...doc.commands, next] }, w.mesh)!;
    expect(restored).not.toBeNull();
    expect(digestWorld(restored.world)).toEqual(digestWorld(w));
  });

  it('整个星球（fbmAt 用三维噪声，没有接缝）：示例生态没有问题，重放一致', () => {
    const eng = snapshot('b3-planet', () => {
      const e = engineFor({ seed: 5, cells: 3000, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
      e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
      return e;
    });
    const w = eng.world;
    eng.exec(fantasy(w));
    expect(w.derived.scriptIssues).toBeUndefined();
    const { P } = placementSlots(w.small.species);
    const pf = w.derived.placeF!;
    // 系数有 0 有 1 也有中间的值
    expect(pf.some((v) => v === 0)).toBe(true);
    expect(pf.some((v) => v > 0 && v < 1)).toBe(true);
    expect(pf.length).toBe(w.mesh.n * P);
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), buildMeshFor(settingsSchema.parse(w.settings))).world)).toEqual(digestWorld(w));
  });

  it('只重算脚本读到的输入变了的格：涂生态、冷暖画笔一格不算，涂自定义场只算涂到的格，干湿画笔只算一片', () => {
    const eng = world();
    const w = eng.world;
    // 去掉“对周围的影响”：有影响时涂了生态，影响的源头就变了，周围的气候、河跟着变，那一片的脚本要重算（那是对的）。
    // 这里只看脚本记住的结果
    const cmd = fantasy(w);
    if (cmd.op === 'batch') for (const c of cmd.commands) if (c.op === 'add_species' && c.species.effects?.climate) c.species = { ...c.species, effects: { ...c.species.effects, climate: undefined } };
    eng.exec(cmd);
    const land = veg(w);
    const reset = () => {
      scriptRunStats.placement = 0;
      scriptRunStats.color = 0;
    };
    reset();
    eng.exec({ op: 'add_constraint', constraint: { cells: near(w, 0.1, 60), species: 'steppe', mode: 'override', ratio: 1, radius: 500 } });
    expect(scriptRunStats.placement).toBe(0);
    // 颜色脚本（死亡森林的只读海拔）最多在份额新超过门槛的格上算
    expect(scriptRunStats.color).toBeLessThan(60);
    // 五段长在哪里的脚本都不读温度：只有河、湖跟着变了的地方（血腥之地读离河多远）
    reset();
    eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.4, 100), value: 2, mode: 'add' });
    expect(scriptRunStats.placement).toBeLessThan(land.length / 10);
    // 神圣之地读 field('holy')：只重算涂到的格
    reset();
    const holy = near(w, 0.6, 40);
    eng.exec({ op: 'paint', field: 'field:holy', cells: holy, value: 1, mode: 'set' });
    expect(scriptRunStats.placement).toBe(holy.filter((i) => isVegetated(w, w.derived, i)).length);
    // 干湿画笔改了水文：重算的是一小片
    reset();
    eng.exec({ op: 'paint', field: 'moistOffset', cells: near(w, 0.8, 150), value: 0.8, mode: 'add' });
    const P = placementSlots(w.small.species).P;
    expect(scriptRunStats.placement).toBeGreaterThan(0);
    expect(scriptRunStats.placement).toBeLessThan((P * land.length) / 3);
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), buildMeshFor(settingsSchema.parse(w.settings))).world)).toEqual(digestWorld(w));
  });

  it('读的时候还没有的自定义场以后有了：整个重算（field 不再回退成同名的内置变量）', () => {
    const eng = world();
    const w = eng.world;
    eng.exec({ op: 'add_species', species: wide({ id: 'glass', name: '玻璃原', color: '#88ccdd', terrain: 'plains', competition: 1, scripts: { placement: script("// 没有叫 elevation 的自定义场时就是海拔\nreturn clamp(field('elevation') / 2000);") } }) });
    expect(veg(w).some((i) => w.derived.placeF![i] > 0)).toBe(true);
    eng.exec({ op: 'add_field', name: 'elevation' });
    // 同名的自定义场（全是 0）：系数都是 0
    expect(veg(w).every((i) => w.derived.placeF![i] === 0)).toBe(true);
    sameAsScratch(eng, '加了场');
    eng.undo();
    expect(veg(w).some((i) => w.derived.placeF![i] > 0)).toBe(true);
    sameAsScratch(eng, '撤销');
  });

  it('两种生态的源码、seedKey 都相同（复制出来的）：各记各的', () => {
    const eng = world();
    const w = eng.world;
    const src = '// 份额越大越红\nreturn mixColor(color, [255, 0, 0], share);';
    const a = wide({ id: 'a1', name: '甲', color: '#88ccdd', terrain: 'plains', competition: 1, seedKey: 'k', scripts: { color: script(src) } });
    eng.exec({ op: 'add_species', species: a });
    eng.exec({ op: 'add_species', species: { ...a, id: 'a2', name: '乙', competition: 2 } });
    eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.5, 60), value: 1, mode: 'add' });
    sameAsScratch(eng, '冷暖');
  });

  it('每一步都与从头算相同：预览、涂自定义场、删掉脚本读的场（出错）、撤销、改颜色脚本、自然融入、重做', () => {
    const eng = world();
    const w = eng.world;
    eng.exec(fantasy(w));
    sameAsScratch(eng, '加上示例生态');
    // 预览改了记下的输入（同一个网格），接着做的是另一步
    eng.preview({ op: 'paint', field: 'tempOffset', cells: near(w, 0.3, 120), value: 4, mode: 'add' });
    eng.exec({ op: 'paint', field: 'moistOffset', cells: near(w, 0.6, 120), value: -0.6, mode: 'add' });
    sameAsScratch(eng, '预览后干湿');
    eng.exec({ op: 'paint', field: 'field:holy', cells: near(w, 0.4, 40), value: 1, mode: 'set' });
    sameAsScratch(eng, '圣地场');
    // 神圣之地读的场没了：它的脚本这一次按没有脚本处理
    eng.exec({ op: 'remove_field', name: 'holy' });
    expect(w.derived.scriptIssues?.map((x) => x.owner)).toEqual(['神圣之地']);
    sameAsScratch(eng, '删场');
    eng.undo();
    expect(w.derived.scriptIssues).toBeUndefined();
    sameAsScratch(eng, '撤销删场');
    eng.exec({ op: 'update_species', id: 'dead_forest', patch: { scripts: { ...w.small.species.find((sp) => sp.id === 'dead_forest')!.scripts, color: script('return mixColor(color, [200, 40, 40], smoothstep(0, 18, wetness));') } } });
    sameAsScratch(eng, '改颜色脚本');
    eng.exec({ op: 'add_constraint', constraint: { cells: near(w, 0.8, 60), species: 'swarm_zone', mode: 'constraint', ratio: 1, radius: 500 } });
    sameAsScratch(eng, '自然融入');
    eng.undo();
    eng.undo();
    eng.redo();
    sameAsScratch(eng, '撤销两步、重做一步');
  });
});
