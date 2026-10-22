import { describe, expect, it, vi } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import type { Command } from './commands';
import type { Engine } from './engine';
import { buildModel, sampleComponents } from './generate';
import { previewWorldOf } from './preview-world';
import { engineFor } from './testing/fixtures';

// 预览：副本与原世界共用生成器的结果（地形命令的预览不重新采样整个生成器），
// 副本上执行与新世界上执行逐值相同；什么都没改的命令不因“采用预览”进历史

// 数一数生成器被调用了几次（照常计算）
vi.mock('./generate', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./generate')>();
  return { ...mod, buildModel: vi.fn(mod.buildModel), sampleComponents: vi.fn(mod.sampleComponents) };
});

const settings = { seed: 6, cells: 5000 };
function make(): Engine {
  const eng = engineFor(settings);
  eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
  return eng;
}

function commands(eng: Engine): Record<string, Command> {
  const { mesh } = eng.world;
  const cells = coastalStroke(eng.world, 0.4, 5);
  return {
    paint_land: { op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' },
    reroll_region: { op: 'reroll_region', x: mesh.width * 0.4, y: mesh.height * 0.5, radius: mesh.height * 0.12, variant: 1 },
  };
}

describe('副本共用生成器的结果', () => {
  for (const name of ['paint_land', 'reroll_region']) {
    it(`${name}：副本上执行与新世界上执行逐值相同，原世界不受影响`, () => {
      const a = make();
      const before = digestWorld(a.world);
      const cmd = commands(a)[name];
      const copy = a.clone();
      copy.exec(cmd);
      const fresh = make();
      fresh.exec(cmd);
      const expected = digestWorld(fresh.world);
      expect(digestWorld(copy.world)).toEqual(expected);
      expect(digestWorld(a.world)).toEqual(before);
      // 原世界接着执行同一条命令，结果也一样
      a.exec(cmd);
      expect(digestWorld(a.world)).toEqual(expected);
    });
  }

  it('副本重画过一片之后，原世界画陆地照旧', () => {
    const a = make();
    const cmds = commands(a);
    a.clone().exec(cmds.reroll_region);
    a.exec(cmds.paint_land);
    const fresh = make();
    fresh.exec(cmds.paint_land);
    expect(digestWorld(a.world)).toEqual(digestWorld(fresh.world));
    // 撤销、重做也一样
    a.undo();
    expect(digestWorld(a.world)).toEqual(digestWorld(make().world));
  });

  it('地形命令的预览不重新采样生成器', () => {
    const a = make();
    const cmds = commands(a);
    vi.mocked(buildModel).mockClear();
    vi.mocked(sampleComponents).mockClear();
    const p = a.preview(cmds.paint_land);
    expect(p.changedCells.length).toBeGreaterThan(0);
    expect(buildModel).not.toHaveBeenCalled();
    expect(sampleComponents).not.toHaveBeenCalled();
    // 重画一片：模型照用，只局部重算重画圈里的格
    a.preview(cmds.reroll_region);
    expect(buildModel).not.toHaveBeenCalled();
    expect(sampleComponents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sampleComponents).mock.calls[0][2]).toBeDefined();
  });
});

describe('采用预览', () => {
  it('什么都没改的命令：预览过也不进历史、不清掉重做', () => {
    const a = make();
    const thr = a.world.small.planet.riverThreshold;
    a.exec({ op: 'set_planet', patch: { riverThreshold: thr * 2 } });
    a.undo();
    const before = digestWorld(a.world);
    const history = JSON.stringify(a.history);
    const same: Command = { op: 'set_planet', patch: { riverThreshold: thr } };
    a.preview(same);
    a.exec(same);
    expect(a.lastNoop).toBe(true);
    expect(JSON.stringify(a.history)).toBe(history);
    expect(a.canRedo).toBe(true);
    expect(digestWorld(a.world)).toEqual(before);
  });

  it('有变化的命令照旧直接采用预览，结果与直接执行一致', () => {
    const a = make();
    const b = make();
    const cmd: Command = { op: 'set_planet', patch: { riverThreshold: a.world.small.planet.riverThreshold * 2 } };
    a.preview(cmd);
    const previewed = (a as unknown as { lastPreview: { copy: Engine } }).lastPreview.copy.world.derived;
    a.exec(cmd);
    expect(a.lastNoop).toBe(false);
    expect(a.world.derived).toBe(previewed);
    b.exec(cmd);
    expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    expect(a.history).toEqual(b.history);
  });
});

// ---------- 第八轮：预览世界、采用、状态编号 ----------

// 一个世界里几条有代表性的命令：改陆海、自然融入地涂生态、冷暖、整体冷暖、河流多少、重画一片
function edits(eng: Engine): Record<string, Command> {
  const w = eng.world;
  const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1);
  // 最暖的一片陆地上涂冰原（自然融入）：多半涂不成，有没涂成的格
  const warm = [...land].sort((a, b) => w.derived.tMean[b] - w.derived.tMean[a]).slice(0, 40);
  return {
    ...commands(eng),
    add_constraint: { op: 'add_constraint', constraint: { cells: land.slice(100, 180), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } },
    ice: { op: 'add_constraint', constraint: { cells: warm, species: 'ice', mode: 'constraint', ratio: 1, radius: 300 } },
    temp: { op: 'paint', field: 'tempOffset', cells: land.slice(0, 150), values: land.slice(0, 150).map(() => -4), mode: 'add' },
    solar: { op: 'set_planet', patch: { solar: 0.9 } },
    river: { op: 'set_planet', patch: { riverThreshold: w.small.planet.riverThreshold * 0.5 } },
  };
}

const copyOf = (eng: Engine) => (eng as unknown as { lastPreview: { copy: Engine } | null }).lastPreview?.copy ?? null;

describe('预览世界', () => {
  it('预览不改世界：原因、推导、小数据、历史、状态编号都不变', () => {
    const a = make();
    const before = digestWorld(a.world);
    const history = JSON.stringify(a.history);
    const state = a.stateId;
    for (const cmd of Object.values(edits(a))) a.previewWorld(cmd);
    expect(digestWorld(a.world)).toEqual(before);
    expect(JSON.stringify(a.history)).toBe(history);
    expect(a.stateId).toBe(state);
  });

  for (const name of ['paint_land', 'add_constraint', 'temp', 'solar', 'river', 'reroll_region']) {
    it(`先预览再执行 = 直接执行，撤销后回到原样：${name}`, () => {
      const a = make();
      const b = make();
      const cmd = edits(a)[name];
      const before = digestWorld(a.world);
      const land0 = a.world.causes.land.slice();
      const p = a.preview(cmd);
      const previewed = copyOf(a)!.world.derived;
      const live = a.world;
      a.exec(cmd);
      // 采用了预览：推导就是预览算出来的那一份，没有再算；世界对象没换
      expect(a.world.derived).toBe(previewed);
      expect(a.world).toBe(live);
      expect(a.lastNoop).toBe(false);
      b.exec(cmd);
      expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
      expect(a.history).toEqual(b.history);
      expect(p.summary).toBe(b.history[b.history.length - 1].summary);
      // 陆海的变化与执行后一致
      const n = a.world.mesh.n;
      expect(p.landGained).toEqual([...Array(n).keys()].filter((i) => !land0[i] && b.world.causes.land[i]));
      expect(p.landLost).toEqual([...Array(n).keys()].filter((i) => land0[i] && !b.world.causes.land[i]));
      a.undo();
      expect(digestWorld(a.world)).toEqual(before);
      a.redo();
      expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    });
  }

  // 采用换上的是副本的推导、气候底、求解结果和地形底图：之后接着改、撤销，与两条都直接执行逐值相同
  it('采用之后接着改 = 两条都直接执行；撤销两步回到原样', () => {
    const w0 = make().world;
    const land = [...Array(w0.mesh.n).keys()].filter((i) => w0.causes.land[i] && w0.derived.lake[i] !== 1);
    const coast = coastalStroke(w0, 0.7, 4);
    const next: Command[] = [
      { op: 'add_constraint', constraint: { cells: land.slice(300, 360), species: 'desert', mode: 'constraint', ratio: 1, radius: 400 } },
      { op: 'paint_land', cells: coast, t: coast.map(() => 0), mode: 'land' },
      { op: 'set_planet', patch: { humidity: 1.4 } },
    ];
    for (const name of ['paint_land', 'add_constraint', 'temp', 'reroll_region']) {
      for (const then of next) {
        const a = make();
        const b = make();
        const cmd = edits(a)[name];
        const before = digestWorld(a.world);
        a.preview(cmd);
        const previewed = copyOf(a)!.world.derived;
        a.exec(cmd);
        expect(a.world.derived, name).toBe(previewed);
        a.exec(then);
        b.exec(cmd);
        b.exec(then);
        expect(digestWorld(a.world), `${name} → ${then.op}`).toEqual(digestWorld(b.world));
        a.undo();
        a.undo();
        expect(digestWorld(a.world), `${name} → ${then.op}`).toEqual(before);
      }
    }
  });

  it('没有变化的命令不因采用预览进历史：在陆地上画陆地', () => {
    const a = make();
    const w = a.world;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.causes.landness[i] > 400).slice(0, 30);
    const cmd: Command = { op: 'paint_land', cells: land, t: land.map(() => 0.9), mode: 'land' };
    const before = digestWorld(w);
    const history = JSON.stringify(a.history);
    const state = a.stateId;
    a.preview(cmd);
    a.exec(cmd);
    expect(a.lastNoop).toBe(true);
    expect(JSON.stringify(a.history)).toBe(history);
    expect(digestWorld(a.world)).toEqual(before);
    expect(a.stateId).toBe(state);
  });

  it('failing = 执行后的冲突里没涂成的格', () => {
    const a = make();
    const b = make();
    const cmd = edits(a).ice;
    const p = a.preview(cmd);
    b.exec(cmd);
    const failing = b.world.derived.conflicts.flatMap((c) => c.failing);
    expect(failing.length).toBeGreaterThan(0);
    expect(p.failing).toEqual(failing);
    expect(p.conflicts).toBe(b.world.derived.conflicts.length);
  });

  it('previewPatch 只含变了的数组；在当前世界上补上它，与副本逐值相同', () => {
    const a = make();
    const cmds = edits(a);
    // 河流多少：地形、气候不变，不带高程、气温；只改小数据和水文以后的推导
    const river = a.previewWorld(cmds.river).patch;
    expect(Object.keys(river.causes)).toEqual([]);
    expect(river.derived.elevation).toBeUndefined();
    expect(river.derived.tMean).toBeUndefined();
    expect(river.fields).toBeNull();
    // 冷暖：原因只带 tempOffset，不带高程
    const temp = a.previewWorld(cmds.temp).patch;
    expect(Object.keys(temp.causes)).toEqual(['tempOffset']);
    expect(temp.derived.elevation).toBeUndefined();
    expect(temp.derived.tMean).toBeDefined();
    // 份额、适宜度按稀疏的行带上：只有变了的格
    expect(temp.share).not.toBeNull();
    expect(temp.share!.idx.length).toBeLessThan(a.world.mesh.n);
    // 发给主线程（结构化克隆）之后拼回来，与副本逐值相同；没变的数组还是当前世界的同一个对象
    const crystal: Command = { op: 'add_species', species: { id: 'crystal', name: '水晶丛林', terrain: 'plains', tolerances: [] } };
    for (const cmd of [cmds.river, cmds.temp, cmds.paint_land, cmds.add_constraint, crystal]) {
      const { patch } = a.previewWorld(cmd);
      const shown = previewWorldOf(a.world, structuredClone(patch));
      expect(digestWorld(shown), cmd.op).toEqual(digestWorld(copyOf(a)!.world));
    }
    const shown = previewWorldOf(a.world, structuredClone(a.previewWorld(cmds.river).patch));
    expect(shown.derived.elevation).toBe(a.world.derived.elevation);
    expect(shown.causes.land).toBe(a.world.causes.land);
  });

  it('状态编号：每次改动换一个新的，预览带着算它时的编号；过期的预览对不上', () => {
    const a = make();
    const cmds = edits(a);
    const s0 = a.stateId;
    const p = a.preview(cmds.temp);
    expect(p.stateId).toBe(s0);
    a.exec(cmds.solar);
    const s1 = a.stateId;
    expect(s1).not.toBe(s0);
    // 在旧状态上算的预览（排在执行前面的）已经过期
    expect(p.stateId).not.toBe(a.stateId);
    a.undo();
    expect(a.stateId).not.toBe(s1);
    expect(a.stateId).not.toBe(s0);
    const s2 = a.stateId;
    a.redo();
    expect(a.stateId).not.toBe(s2);
    // 新建的引擎也不会与这个撞号
    expect(make().stateId).not.toBe(a.stateId);
    // 副本的编号与原来的相同（预览按它比较）
    expect(a.clone().stateId).toBe(a.stateId);
  });
});
