import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import { Engine } from './engine';

// 新起的省名记在命令里：重新打开（重放）后省名与当时一字不差。以前起名用的是重放时还没算到这一步的推导，
// 801 个省里会有 7–19 个名字不同

describe('重放后省名不变', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = new Engine(kind === 'planet' ? { seed: 1, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 3, cells: 12000 });
      eng.exec({ op: 'set_worldgen', params: { seed: kind === 'planet' ? 1 : 3, type: 'continents' }, reset: true });
      const { mesh, derived: d } = eng.world;
      const deep: number[] = [];
      for (let i = 0; i < mesh.n && deep.length < 6; i += 331) if (d.elevation[i] < -3000) deep.push(i);
      deep.forEach((c, k) => {
        try {
          eng.exec({ op: 'add_island', island: { x: mesh.x[c], y: mesh.y[c], kind: 'volcanic', size: 300, variant: k + 1 } });
        } catch {
          // 放不下（已经是陆地）就跳过
        }
      });
      for (const f of [0.2, 0.5, 0.8]) {
        const cells = coastalStroke(eng.world, f, 4);
        eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: f === 0.5 ? 'sea' : 'land' });
      }
      const replay = Engine.fromDoc(eng.toDoc(), mesh);
      expect(digestWorld(replay.world)).toEqual(digestWorld(eng.world));
      // 没有记名字的旧存档照旧能打开
      const old = eng.toDoc();
      old.commands = old.commands.map(({ provinceNames: _, ...c }) => c as typeof c);
      expect(() => Engine.fromDoc(old, mesh)).not.toThrow();
    });
  }
});
