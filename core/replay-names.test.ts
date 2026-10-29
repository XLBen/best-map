import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { encodePath } from './rivers';
import { isRiverCell, planCourse, riverStem, stemPath } from './select';
import { continents, seededEngine } from './testing/fixtures';

// 新起的省名记在命令里：重新打开（重放）后省名与当时一字不差。以前起名用的是重放时还没算到这一步的推导，
// 801 个省里会有 7–19 个名字不同

describe('重放后省名不变', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const eng = seededEngine(kind === 'planet' ? { seed: 1, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 3, cells: 12000 });
      eng.exec({ op: 'set_worldgen', params: { seed: kind === 'planet' ? 1 : 3, type: 'continents' }, reset: true });
      const { mesh, derived: d } = eng.world;
      const deep: number[] = [];
      for (let i = 0; i < mesh.n && deep.length < 6; i += 331) if (d.elevation[i] < -3000) deep.push(i);
      deep.forEach((c, k) => {
        try {
          eng.exec({ op: 'add_island', island: { x: mesh.x[c], y: mesh.y[c], kind: 'continental', size: 300, variant: k + 1 } });
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
      // 命令里没有记名字（provinceNames 是可选的）也能打开
      const old = eng.toDoc();
      old.commands = old.commands.map(({ provinceNames: _, ...c }) => c as typeof c);
      expect(() => Engine.fromDoc(old, mesh)).not.toThrow();
    });
  }
});

// 第八轮：画的河（有名字的河道）也是地物，第二轮起名；固定的自然河沿用原来的名字。重新打开后一字不差
describe('重放后画的河的名字不变', () => {
  it('画的河、改名、换一个、固定的自然河', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    const drawn: string[] = [];
    for (let i = 0; i < mesh.n && drawn.length < 2; i += 53) {
      if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
      const plan = planCourse(w, w.derived, [[mesh.x[i], mesh.y[i]], [mesh.x[i] + 12 * mesh.spacing, mesh.y[i] + 3 * mesh.spacing]], { endOnLand: 'flow' });
      if (plan.blocked || plan.crossings.length || plan.reroute) continue;
      const id = `river-${drawn.length}`;
      eng.exec({ op: 'add_guide', guide: { id, cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 3, name: '' } });
      drawn.push(id);
    }
    expect(drawn.length).toBe(2);
    eng.exec({ op: 'update_guide', id: drawn[0], patch: { name: '赤江' } });
    eng.exec({ op: 'update_guide', id: drawn[1], patch: { name: '', salt: 4 } });
    const f = w.derived.features.find((x) => x.type === 'river' && !x.guide)!;
    const stem = riverStem(w, w.derived, f.anchor);
    eng.exec({ op: 'add_guide', guide: { id: 'pin', cells: stem.cells, path: stemPath(w, stem.cells), locked: true, spring: false, nameKey: f.key } });
    const names = (ww: typeof w) => ww.derived.features.filter((x) => x.guide).map((x) => `${x.key}=${x.name}|${x.custom}`);
    expect(names(w)).toContain('guide:river-0=赤江|true');
    expect(names(w)).toContain(`guide:pin=${f.name}|false`);
    const replay = Engine.fromDoc(eng.toDoc(), mesh);
    expect(names(replay.world)).toEqual(names(w));
    expect(digestWorld(replay.world)).toEqual(digestWorld(w));
  });
});
