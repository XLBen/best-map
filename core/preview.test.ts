import { describe, expect, it, vi } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import type { Command } from './commands';
import type { Engine } from './engine';
import { buildModel, sampleComponents } from './generate';
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
