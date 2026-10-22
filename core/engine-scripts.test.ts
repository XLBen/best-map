import { afterEach, describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { forgetScriptResults } from './biome-scripts';
import type { Command } from './commands';
import { Engine, type WorldDoc } from './engine';
import { graphDistance } from './mesh';
import { fantasyBiomeCommands } from './packs/fantasy-biomes';
import { POLAR_CONTINENTS } from './packs/fantasy-forms';
import { ScriptError, findScripts, setScriptHost, setScriptsEnabled } from './script';
import { type Species, withRect } from './species';
import { engineFor, snapshot } from './testing/fixtures';
import { isVegetated } from './vegetation';
import type { World } from './world';

// 引擎的整步生效（第三批）：带脚本的命令写错了整条不生效；重算中途出错时执行、撤销、重做、换一个都回到之前的样子；
// 带脚本的步撤销、重做、检查点恢复都与从头重放逐值一致；安全模式（脚本不运行）打开时命令照旧保留

// 5000 格、北纬 5°–55° 的大陆，加上五种示例生态（都带脚本）
const scripted = () =>
  snapshot('engine-scripts', () => {
    const e = engineFor({ cells: 5000, seed: 2, latNorth: 55, latSouth: 5 });
    e.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents', landFraction: 0.4 }, reset: true });
    e.exec(fantasyBiomeCommands({ fields: Object.keys(e.world.causes.fields), species: e.world.small.species.map((s) => s.id) }));
    return e;
  });

const script = (src: string) => ({ api: 1 as const, src });
const wide = (sp: Omit<Species, 'tolerances'>): Species => withRect({ ...sp, tolerances: [] }, { t0: -40, t1: 40, m0: 0, m1: 50 });
const veg = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => isVegetated(w, w.derived, i));
const near = (w: World, f: number, k: number) => {
  const land = veg(w);
  const dist = graphDistance(w.mesh, [land[Math.floor(f * (land.length - 1))]]);
  return [...land].sort((a, b) => dist[a] - dist[b] || a - b).slice(0, k);
};

// 引擎对外看得到的全部状态
const state = (e: Engine) => ({ digest: digestWorld(e.world), history: e.history, canRedo: e.canRedo, ids: e.stepIds(), stateId: e.stateId, issues: e.world.derived.scriptIssues });

// 从头重放（忘掉按格记住的脚本结果，真的重新运行每段脚本）
const replay = (e: Engine, doc: WorldDoc = e.toDoc()) => {
  forgetScriptResults(e.world.mesh);
  return Engine.fromDoc(doc, e.world.mesh);
};
const sameAsReplay = (e: Engine, label: string) => {
  const r = replay(e);
  expect(digestWorld(e.world), label).toEqual(digestWorld(r.world));
  expect(e.world.derived.scriptIssues, label).toEqual(r.world.derived.scriptIssues);
  expect(e.toDoc(), label).toEqual(r.toDoc());
};

// 下一次重算写了一半就出错（只出错一次）：模拟脚本以外的地方出了意外
const breakNextUpdate = (e: Engine) => {
  const self = e as unknown as { recompute?: () => unknown; world: World };
  self.recompute = function () {
    delete self.recompute;
    self.world.derived.elevation.fill(123);
    self.world.derived.dominant.fill(-1);
    throw new Error('重算出了意外');
  };
};

afterEach(() => {
  setScriptsEnabled(true);
  setScriptHost(null);
});

describe('脚本出错的命令整体不生效', () => {
  it('语法错误：添加、修改（在一整步里）都当场拒绝，说明第几行；世界、历史、重做记录、状态编号都不变', () => {
    const eng = scripted();
    const w = eng.world;
    eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.3, 40), value: 2, mode: 'add' });
    eng.undo();
    const before = state(eng);
    const bad = wide({ id: 'bad', name: '坏脚本', color: '#123456', terrain: 'plains', competition: 2, scripts: { placement: script('const a = 1;\nreturn (a +;') } });
    let err: unknown;
    try {
      eng.exec({ op: 'add_species', species: bad });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).owner).toBe('坏脚本');
    expect((err as ScriptError).message).toContain('语法');
    expect(state(eng)).toEqual(before);
    // 一整步里的第二条写错了：第一条也不生效
    const batch: Command = {
      op: 'batch',
      commands: [
        { op: 'set_planet', patch: { humidity: 1.3 } },
        { op: 'update_species', id: 'crystal_jungle', patch: { scripts: { placement: script('return clamp(;') } } },
      ],
    };
    expect(() => eng.exec(batch)).toThrow(ScriptError);
    expect(state(eng)).toEqual(before);
    // 之后照常重做、编辑，与重放一致
    eng.redo();
    eng.exec({ op: 'set_planet', patch: { humidity: 1.2 } });
    sameAsReplay(eng, '出错之后再编辑');
  });

  it('运行时出错不挡操作：这一次按没有脚本处理，记下出错的格与行号，画笔照常', () => {
    const eng = scripted();
    const w = eng.world;
    const odd = wide({ id: 'odd', name: '高处出错', color: '#aa3355', terrain: 'plains', competition: 2, scripts: { placement: script('// 高的地方出错\nif (elevation > 400) throw new Error("太高了");\nreturn 1;') } });
    eng.exec({ op: 'add_species', species: odd });
    const issues = eng.world.derived.scriptIssues!;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ owner: '高处出错', kind: 'placement', reason: 'runtime', line: 2 });
    expect(issues[0].cell).toBeGreaterThanOrEqual(0);
    expect(eng.world.derived.elevation[issues[0].cell!]).toBeGreaterThan(400);
    expect(() => eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.6, 50), value: -3, mode: 'add' })).not.toThrow();
    eng.undo();
    eng.redo();
    sameAsReplay(eng, '出错的脚本在世界里');
  });
});

describe('重算出错时整步不生效', () => {
  for (const cache of [true, false]) {
    const tag = cache ? '存着推导' : '没存推导';
    it(`执行（${tag}）：原因、推导、历史、重做记录、状态编号都回到执行前；之后照常`, () => {
      const eng = scripted();
      if (!cache) eng.undoCache = 0;
      const w = eng.world;
      eng.exec({ op: 'paint', field: 'moistOffset', cells: near(w, 0.4, 60), value: 0.4, mode: 'add' });
      eng.undo();
      const before = state(eng);
      breakNextUpdate(eng);
      expect(() => eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.5, 80), value: 3, mode: 'add' })).toThrow('重算出了意外');
      expect(state(eng)).toEqual(before);
      // 重做记录还在
      eng.redo();
      sameAsReplay(eng, '出错后重做');
      eng.exec({ op: 'paint', field: 'tempOffset', cells: near(w, 0.5, 80), value: 3, mode: 'add' });
      sameAsReplay(eng, '出错后再执行');
    });

    it(`重做、撤销、换一个（${tag}）：出错时都回到之前的样子`, () => {
      const eng = scripted();
      if (!cache) eng.undoCache = 0;
      const w = eng.world;
      const a: Command = { op: 'paint', field: 'tempOffset', cells: near(w, 0.2, 60), value: -2, mode: 'add' };
      const b: Command = { op: 'paint', field: 'field:holy', cells: near(w, 0.7, 40), value: 1, mode: 'set' };
      eng.exec(a);
      eng.exec(b);
      eng.undo();
      // 重做出错：这一步还在重做记录里
      let before = state(eng);
      breakNextUpdate(eng);
      // 存着重做之后的推导时直接换上，不重算，也就不会出错
      if (cache) expect(eng.redo()).toBe(true);
      else {
        expect(() => eng.redo()).toThrow('重算出了意外');
        expect(state(eng)).toEqual(before);
        eng.redo();
      }
      delete (eng as unknown as { recompute?: unknown }).recompute;
      sameAsReplay(eng, '重做之后');
      // 撤销出错：这一步照原来的编号放回去（新的一步没存推导，撤销时要重算）
      eng.undoCache = 0;
      eng.exec({ op: 'set_planet', patch: { humidity: 1.15 } });
      before = state(eng);
      breakNextUpdate(eng);
      expect(() => eng.undo()).toThrow('重算出了意外');
      expect(state(eng)).toEqual(before);
      sameAsReplay(eng, '撤销出错之后');
      // 换一个出错：原来那一步放回去，重做记录也在
      eng.undo();
      eng.redo();
      eng.undo();
      before = state(eng);
      breakNextUpdate(eng);
      expect(() => eng.replaceLast({ op: 'paint', field: 'tempOffset', cells: near(w, 0.25, 70), value: -1, mode: 'add' })).toThrow('重算出了意外');
      expect(state(eng)).toEqual(before);
      sameAsReplay(eng, '换一个出错之后');
      // 换一个的新命令本身做不了：照旧
      expect(() => eng.replaceLast({ op: 'remove_species', id: 'no_such' })).toThrow();
      expect(state(eng)).toEqual(before);
      eng.replaceLast({ op: 'paint', field: 'tempOffset', cells: near(w, 0.25, 70), value: -1, mode: 'add' });
      sameAsReplay(eng, '换一个');
    });
  }
});

describe('带脚本的步', () => {
  it('撤销/重做带脚本的步与重放逐值一致', () => {
    const eng = scripted();
    const w = eng.world;
    const steps: Command[] = [
      { op: 'paint', field: 'field:holy', cells: near(w, 0.5, 120), value: 1, mode: 'set' },
      { op: 'update_species', id: 'crystal_jungle', patch: { scripts: { placement: script('return clamp(0.6 + 0.4 * fbmAt(3, 2));') } } },
      { op: 'paint', field: 'tempOffset', cells: near(w, 0.3, 150), value: 4, mode: 'add' },
      { op: 'update_species', id: 'dead_forest', patch: { scripts: { placement: script('return 1;'), color: script('return mixColor(color, [200, 200, 200], clamp(elevation / 3000));') } } },
      { op: 'set_planet', patch: { humidity: 1.3 } },
    ];
    for (const s of steps) eng.exec(s);
    expect(eng.world.derived.look).toBeInstanceOf(Uint8Array);
    sameAsReplay(eng, '执行完');
    eng.undo();
    eng.undo();
    sameAsReplay(eng, '撤销两步');
    eng.redo();
    sameAsReplay(eng, '重做一步');
    eng.undo();
    eng.undo();
    eng.redo();
    eng.redo();
    eng.redo();
    sameAsReplay(eng, '来回之后');
  });

  it('检查点恢复与重放一致（含脚本；检查点能结构化克隆）', () => {
    const eng = scripted();
    const w = eng.world;
    eng.exec({ op: 'paint', field: 'field:holy', cells: near(w, 0.45, 100), value: 1, mode: 'set' });
    eng.exec({ op: 'update_species', id: 'dead_forest', patch: { scripts: { placement: script('return 1;'), color: script('return [120, 120, 120];') } } });
    eng.exec({ op: 'paint', field: 'moistOffset', cells: near(w, 0.6, 90), value: -0.4, mode: 'add' });
    const cp = structuredClone(eng.toCheckpoint());
    const doc = eng.toDoc();
    forgetScriptResults(w.mesh);
    const restored = Engine.fromCheckpoint(structuredClone(cp), doc, w.mesh)!;
    expect(restored).not.toBeNull();
    expect(digestWorld(restored.world)).toEqual(digestWorld(replay(eng, doc).world));
    // 存档比检查点多一步、少一步
    const more: WorldDoc = { ...doc, commands: [...doc.commands, { op: 'set_planet', patch: { solar: 1.05 } }] };
    expect(digestWorld(Engine.fromCheckpoint(structuredClone(cp), more, w.mesh)!.world)).toEqual(digestWorld(replay(eng, more).world));
    const fewer: WorldDoc = { ...doc, commands: doc.commands.slice(0, -1) };
    const r = Engine.fromCheckpoint(structuredClone(cp), fewer, w.mesh)!;
    expect(digestWorld(r.world)).toEqual(digestWorld(replay(eng, fewer).world));
    expect(r.world.derived.scriptIssues).toEqual(replay(eng, fewer).world.derived.scriptIssues);
  });
});

describe('安全模式', () => {
  it('安全模式打开：脚本不运行、命令照旧保留、再正常打开结果与原来一致', () => {
    const eng = scripted();
    const w = eng.world;
    eng.exec({ op: 'paint', field: 'field:holy', cells: near(w, 0.5, 100), value: 1, mode: 'set' });
    eng.exec({ op: 'update_species', id: 'dead_forest', patch: { scripts: { placement: script('return 1;'), color: script('return [90, 90, 90];') } } });
    const doc = eng.toDoc();
    const normal = digestWorld(eng.world);
    expect(findScripts(doc).length).toBeGreaterThan(0);

    setScriptsEnabled(false);
    const safe = replay(eng, doc);
    expect(safe.world.derived.placeF).toBeUndefined();
    expect(safe.world.derived.look).toBeUndefined();
    expect(safe.world.derived.scriptIssues).toBeUndefined();
    // 命令照旧保留（存出去还是同一份）
    expect(safe.toDoc()).toEqual(doc);
    // 推导与脚本都去掉时相同
    const stripped: WorldDoc = JSON.parse(JSON.stringify(doc, (k, v) => (k === 'scripts' ? undefined : v)));
    expect(findScripts(stripped)).toEqual([]);
    const plain = replay(eng, stripped);
    const derivedOf = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('derived.')));
    expect(derivedOf(digestWorld(safe.world))).toEqual(derivedOf(digestWorld(plain.world)));
    expect(derivedOf(digestWorld(safe.world))).not.toEqual(derivedOf(normal));
    // 安全模式里照常编辑、撤销
    safe.exec({ op: 'set_planet', patch: { humidity: 1.25 } });
    safe.undo();
    expect(safe.toDoc()).toEqual(doc);

    setScriptsEnabled(true);
    const again = replay(eng, doc);
    expect(digestWorld(again.world)).toEqual(normal);
  });

  it('安全模式下一段脚本都不运行（看门狗收不到“进入脚本”）：生态的、星球形态的都不跑；命令连同记下的省名照原样保留', () => {
    const entered: string[] = [];
    setScriptHost({ enter: (label) => entered.push(label), tick() {}, exit() {} });
    const planet = (cells: number) => ({ cells, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    const build = () => {
      const e = engineFor(planet(4000));
      e.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents', form: POLAR_CONTINENTS }, reset: true });
      e.exec(fantasyBiomeCommands({ fields: Object.keys(e.world.causes.fields), species: e.world.small.species.map((s) => s.id) }));
      return e;
    };
    const normal = build();
    expect(new Set(entered)).toEqual(new Set([POLAR_CONTINENTS.name, ...normal.world.small.species.filter((s) => s.scripts).map((s) => s.name)]));
    entered.length = 0;
    setScriptsEnabled(false);
    // 新建、重放、编辑、撤销都不跑
    build();
    const doc = normal.toDoc();
    const safe = Engine.fromDoc(doc, normal.world.mesh);
    safe.exec({ op: 'set_planet', patch: { humidity: 1.2 } });
    safe.undo();
    expect(entered).toEqual([]);
    // 没有地形脚本，新起的省比正常时少：命令里记着的省名也一个不丢（用安全模式打开、自动保存，再正常打开时名字不变）
    expect(Object.keys(safe.world.small.provinces).length).toBeLessThan(Object.keys(normal.world.small.provinces).length);
    expect(safe.toDoc()).toEqual(doc);
    expect(safe.world.derived.placeF).toBeUndefined();
    setScriptsEnabled(true);
    expect(digestWorld(replay(normal, safe.toDoc()).world)).toEqual(digestWorld(normal.world));
  });
});
