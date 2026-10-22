import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import { Engine, type WorldDoc } from './engine';

// 检查点：从检查点恢复（再撤掉、补上与存档不同的那几步）与从头重放逐值一致，之后的编辑、撤销、重做也一致

function build(kind: 'region' | 'planet') {
  const eng = new Engine(kind === 'planet' ? { seed: 3, cells: 5000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 3, cells: 5000 });
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  const cells = coastalStroke(eng.world, 0.3, 4);
  eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
  const land = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.land[i]);
  eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 120), value: 2, mode: 'add' });
  eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(200, 260), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } });
  return eng;
}

const same = (a: Engine, b: Engine) => {
  expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
  expect(a.history).toEqual(b.history);
};

describe('检查点', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(`${kind}：恢复与重放一致；存档比检查点长、短、不同时也一致`, () => {
      const eng = build(kind);
      const mesh = eng.world.mesh;
      const cp = structuredClone(eng.toCheckpoint());
      const doc = eng.toDoc();
      const replay = (d: WorldDoc) => Engine.fromDoc(d, mesh);
      const restore = (d: WorldDoc) => Engine.fromCheckpoint(structuredClone(cp), d, mesh)!;

      // 一样长
      const a = restore(doc);
      const b = replay(doc);
      same(a, b);
      // 之后再编辑、撤销、重做
      for (const e of [a, b]) {
        e.exec({ op: 'set_coast_style', roughness: 1.3 });
        e.undo();
        e.undo();
        e.redo();
      }
      same(a, b);

      // 存档多两步（检查点落后了）
      const more = build(kind);
      more.exec({ op: 'set_planet', patch: { humidity: 1.4 } });
      more.exec({ op: 'add_island', island: { x: kind === 'planet' ? 1.995 : 0.4, y: 0.35, kind: 'volcanic', size: 300, variant: 1 } });
      same(restore(more.toDoc()), replay(more.toDoc()));

      // 存档少两步（检查点之后撤销过）
      const fewer: WorldDoc = { ...doc, commands: doc.commands.slice(0, 3) };
      same(restore(fewer), replay(fewer));

      // 最后一步不同
      const other: WorldDoc = { ...doc, commands: [...doc.commands.slice(0, 4), { op: 'set_planet', patch: { tilt: 35 } }] };
      same(restore(other), replay(other));

      // 设置不同：不能用
      expect(Engine.fromCheckpoint(structuredClone(cp), { ...doc, settings: { ...doc.settings, seed: 9 } }, mesh)).toBeNull();
    });
  }
});
