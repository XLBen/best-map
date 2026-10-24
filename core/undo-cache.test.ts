import { describe, expect, it } from 'vitest';
import { coastalStroke, digestWorld } from '../tools/hash';
import { Engine } from './engine';

// 撤销缓存：撤销、重做、“换一个”时直接换回存着的推导，结果必须与重算逐值一致；
// 什么都没改的命令不重算、不进历史

function script(kind: 'region' | 'planet') {
  const settings = kind === 'planet' ? { seed: 2, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 2, cells: 6000 };
  return (cache: number) => {
    const eng = new Engine(settings);
    eng.undoCache = cache;
    const w = eng.world;
    const states: Record<string, string>[] = [];
    const snap = () => states.push(digestWorld(eng.world));
    const land = () => [...Array(w.mesh.n).keys()].filter((i) => eng.world.causes.land[i]);
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 2 } });
    snap();
    let cells = coastalStroke(eng.world, 0.4, 5);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    eng.exec({ op: 'paint', field: 'tempOffset', cells: land().slice(0, 150), value: -3, mode: 'add' });
    eng.exec({ op: 'add_constraint', constraint: { cells: land().slice(200, 280), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } });
    eng.exec({ op: 'set_planet', patch: { riverThreshold: 80 } });
    const key = eng.world.derived.features[0].key;
    eng.exec({ op: 'rename_feature', key, name: '测试之地' });
    snap();
    for (let k = 0; k < 4; k++) {
      eng.undo();
      snap();
    }
    eng.redo();
    snap();
    eng.redo();
    snap();
    eng.exec({ op: 'add_island', island: { x: kind === 'planet' ? 1.99 : 0.5, y: 0.3, kind: 'continental', size: 300, variant: 1 } });
    eng.replaceLast({ op: 'add_island', island: { x: kind === 'planet' ? 1.99 : 0.5, y: 0.3, kind: 'continental', size: 300, variant: 2 } });
    snap();
    eng.undo();
    snap();
    eng.redo();
    snap();
    cells = coastalStroke(eng.world, 0.6, 4);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
    for (let k = 0; k < 6; k++) {
      eng.undo();
      snap();
    }
    for (let k = 0; k < 3; k++) {
      eng.redo();
      snap();
    }
    states.push({ history: JSON.stringify(eng.history), doc: JSON.stringify(eng.toDoc()) });
    return states;
  };
}

describe('撤销缓存与重算逐值一致', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const run = script(kind);
      const plain = run(0);
      expect(run(3)).toEqual(plain);
      // 深的缓存（第九轮：相同的数组在几份之间共用，换回来之后再重算前先复制）
      expect(run(8)).toEqual(plain);
    });
  }

  it('撤销、重做直接换回，不重算', () => {
    const eng = new Engine({ seed: 4, cells: 4000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const t0 = eng.lastTimings;
    const e0 = eng.world.derived.elevation.slice();
    const cells = coastalStroke(eng.world, 0.5, 4);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
    const t1 = eng.lastTimings;
    eng.undo();
    expect(eng.lastTimings).toBe(t0);
    expect(eng.world.derived.elevation).toEqual(e0);
    eng.redo();
    expect(eng.lastTimings).toBe(t1);
  });

  it('什么都没改的命令：不重算、不进历史、不清掉重做', () => {
    const eng = new Engine({ seed: 4, cells: 4000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const land = [...Array(eng.world.mesh.n).keys()].filter((i) => eng.world.causes.land[i]);
    eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 50), value: 1, mode: 'add' });
    eng.undo();
    const before = digestWorld(eng.world);
    const t = eng.lastTimings;
    // 在一片陆地中间画陆地：陆地已经是陆地
    eng.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 50), value: 0, mode: 'add' });
    expect(eng.lastNoop).toBe(true);
    expect(eng.lastTimings).toBe(t);
    expect(digestWorld(eng.world)).toEqual(before);
    expect(eng.canRedo).toBe(true);
    expect(eng.history.filter((h) => h.done).length).toBe(1);
  });
});

describe('画河改道：松手时直接采用确切预览', () => {
  it('采用的结果与直接执行逐值一致，撤销也一致', () => {
    const make = () => {
      const eng = new Engine({ seed: 6, cells: 5000 });
      eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
      return eng;
    };
    const a = make();
    const b = make();
    // 一条从高处往低处的路线：沿陆地上相邻的格走几步
    const w = a.world;
    let c = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]).sort((x, y) => w.derived.elevation[y] - w.derived.elevation[x])[0];
    const cells = [c];
    for (let k = 0; k < 8; k++) {
      let next = -1;
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
        const j = w.mesh.adj[e];
        if (w.causes.land[j] && !cells.includes(j) && (next < 0 || w.derived.elevation[j] < w.derived.elevation[next])) next = j;
      }
      if (next < 0) break;
      cells.push(next);
      c = next;
    }
    const cmd = { op: 'add_guide' as const, guide: { cells, locked: true, spring: true, flow: 1 }, label: '画了一条河' };
    a.preview(cmd);
    const previewed = (a as unknown as { lastPreview: { copy: Engine } }).lastPreview.copy.world.derived;
    a.exec(cmd);
    // 采用了预览：推导就是预览算出来的那一份，没有再算
    expect(a.world.derived).toBe(previewed);
    b.exec(cmd);
    expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    a.undo();
    b.undo();
    expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
    a.redo();
    b.redo();
    expect(digestWorld(a.world)).toEqual(digestWorld(b.world));
  });
});
