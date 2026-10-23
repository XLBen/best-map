import { describe, expect, it } from 'vitest';
import { coastalStroke, digest, digestWorld } from '../tools/hash';
import { SWEEPS, computeClimate, planeMemo, setSweeps } from './climate';
import { elevationMemo } from './elevation';
import { Engine } from './engine';
import { computeHydrology, routeMemo } from './hydrology';
import { PLANET_SWEEPS, computeClimateSphere, sphereLayers, sphereMemo } from './planet-climate';
import { incrementalDistance } from './script';
import { meshFor } from './testing/fixtures';
import { type Derived, type World, emptyDerived } from './world';

// 气候里只取决于地形的部分、汇流按内容缓存：用缓存与从头算（关掉缓存）逐值相同。
// 键里每一项都单独改一次：缓存必须错过，结果与从头算相同；只改气候的输入时必须命中

const memos = [planeMemo, sphereMemo, routeMemo, elevationMemo, incrementalDistance, sphereLayers];
const counts = (m: { hit: number; miss: number }) => [m.hit, m.miss];

function fresh<T>(f: () => T): T {
  const saved = memos.map((m) => m.on);
  for (const m of memos) m.on = false;
  try {
    return f();
  } finally {
    memos.forEach((m, k) => (m.on = saved[k]));
  }
}

const settingsOf = (kind: 'region' | 'planet') =>
  kind === 'planet' ? { seed: 2, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 2, cells: 6000 };

const landCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i]);

// 从最高的陆地格往低处走几步的河道
function riverPath(w: World): number[] {
  let c = landCells(w).sort((x, y) => w.derived.elevation[y] - w.derived.elevation[x])[0];
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
  return cells;
}

describe('用缓存与从头算逐值相同（各类修改、撤销与重做）', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const settings = settingsOf(kind);
      const mesh = meshFor(settings);
      const a = new Engine(settings, mesh);
      const b = new Engine(settings, mesh);
      // 不留撤销缓存：撤销、重做也要重算（用上缓存里较早的那一份）
      a.undoCache = 0;
      b.undoCache = 0;
      const hits = () => planeMemo.hit + sphereMemo.hit + routeMemo.hit;
      const h0 = hits();
      const step = (label: string, f: (e: Engine) => void) => {
        f(a);
        fresh(() => f(b));
        expect(digestWorld(a.world), label).toEqual(digestWorld(b.world));
      };
      const cmd = (label: string, c: Parameters<Engine['exec']>[0]) => step(label, (e) => e.exec(c));
      cmd('新世界', { op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
      const land = landCells(a.world);
      cmd('冷暖笔', { op: 'paint', field: 'tempOffset', cells: land.slice(0, 200), value: 2, mode: 'add' });
      cmd('干湿笔', { op: 'paint', field: 'moistOffset', cells: land.slice(100, 300), value: -0.4, mode: 'add' });
      cmd('擦掉冷暖干湿', { op: 'restore_climate', cells: land.slice(50, 150), t: land.slice(50, 150).map(() => 0.5) });
      cmd('整体干湿', { op: 'set_planet', patch: { humidity: 1.3 } });
      cmd('越高越冷', { op: 'set_planet', patch: { lapse: 8 } });
      cmd('整体冷暖', { op: 'set_planet', patch: { solar: 1.05 } });
      cmd('四季分明', { op: 'set_planet', patch: { tilt: 30 } });
      cmd('自转反向', { op: 'set_planet', patch: { rotation: -1 } });
      if (kind === 'planet') {
        cmd('洋流弱', { op: 'set_planet', patch: { currents: 0.5 } });
        cmd('没有洋流', { op: 'set_planet', patch: { currents: 0 } });
        cmd('洋流恢复', { op: 'set_planet', patch: { currents: 1.5 } });
      } else {
        cmd('南北挪动', { op: 'set_planet', patch: { latShift: 6 } });
        cmd('图外不是海', { op: 'set_planet', patch: { outsideOcean: false } });
      }
      // 之后的改海陆、堆山都带着山挡风算（星球上洋流的缓存键里没有风：洋流必须照旧用背景风）
      cmd('山挡风', { op: 'set_planet', patch: { terrainWind: 0.5 } });
      const cells = coastalStroke(a.world, 0.4, 4);
      cmd('画陆地', { op: 'paint_land', cells, t: cells.map(() => 0), mode: 'land' });
      const land2 = landCells(a.world);
      cmd('堆山', { op: 'paint_relief', cells: land2.slice(20, 80), t: land2.slice(20, 80).map(() => 0.2), strength: 0.8 });
      cmd('画河', { op: 'add_guide', guide: { cells: riverPath(a.world), locked: true, spring: true, flow: 2 } });
      cmd('河流多少', { op: 'set_planet', patch: { riverThreshold: 60 } });
      cmd('再画冷暖', { op: 'paint', field: 'tempOffset', cells: land2.slice(0, 100), value: -1.5, mode: 'add' });
      for (let k = 0; k < 4; k++) step(`撤销 ${k + 1}`, (e) => e.undo());
      for (let k = 0; k < 2; k++) step(`重做 ${k + 1}`, (e) => e.redo());
      cmd('撤销后再改湿度', { op: 'set_planet', patch: { humidity: 0.8 } });
      // 确实用上了缓存
      expect(hits() - h0).toBeGreaterThan(10);
    });
  }
});

// 函数层面：只改一项输入，看地形部分的缓存是否命中，结果是否与从头算相同
function climateCase(kind: 'region' | 'planet') {
  const settings = settingsOf(kind);
  const eng = new Engine(settings, meshFor(settings));
  eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
  const w = eng.world;
  const elevation = w.derived.elevation.slice();
  const memo = kind === 'planet' ? sphereMemo : planeMemo;
  const run = () => {
    const d = emptyDerived(w.mesh.n, 0);
    const base = (kind === 'planet' ? computeClimateSphere : computeClimate)(w, elevation, d);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) if (ArrayBuffer.isView(v)) out[k] = digest(v);
    for (const [k, v] of Object.entries(base)) out[`base.${k}`] = digest(v);
    return out;
  };
  // 改了以后算一遍（期望命中或错过），与从头算比较；改回去以后应当命中改之前存下的那一份。
  // changes：错过时结果应当确实变了（用错了缓存就能看出来）
  const check = (label: string, hit: boolean, change: () => () => void, changes = !hit) => {
    const before = run();
    const undo = change();
    const h = memo.hit;
    const m = memo.miss;
    const got = run();
    expect([memo.hit - h, memo.miss - m], `${label}：${hit ? '应当命中' : '应当错过'}`).toEqual(hit ? [1, 0] : [0, 1]);
    expect(got, label).toEqual(fresh(run));
    if (changes) expect(got, `${label}：结果确实变了`).not.toEqual(before);
    undo();
    const h2 = memo.hit;
    expect(run(), `${label}：改回去`).toEqual(before);
    expect(memo.hit - h2, `${label}：改回去应当命中`).toBe(1);
  };
  const planet = (patch: Partial<World['small']['planet']>) => () => {
    const old = w.small.planet;
    w.small.planet = { ...old, ...patch };
    return () => (w.small.planet = old);
  };
  const cellArray = (arr: Float32Array | Uint8Array, i: number, v: number) => () => {
    const old = arr[i];
    arr[i] = v;
    return () => (arr[i] = old);
  };
  const land = landCells(w);
  // 内陆的一格（四周都是陆地）、一块高地上的一格
  const inland = land.find((i) => {
    for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return false;
    return true;
  })!;
  const high = land.reduce((a, i) => (elevation[i] > elevation[a] ? i : a), land[0]);
  return { w, elevation, check, planet, cellArray, land, inland, high };
}

describe('气候地形部分的缓存：键完整', () => {
  it('一块地区', () => {
    const { w, elevation, check, planet, cellArray, land, inland, high } = climateCase('region');
    // 地形部分读到的输入：每一项都要让缓存错过
    check('海陆', false, cellArray(w.causes.land, inland, 0));
    check('高程', false, cellArray(elevation, high, elevation[high] + 400));
    check('倾角', false, planet({ tilt: 31 }));
    check('自转', false, planet({ rotation: -1 }));
    check('图外是不是海', false, planet({ outsideOcean: false }));
    check('南北挪动（各格纬度）', false, planet({ latShift: 4 }));
    check('山挡风', false, planet({ terrainWind: 0.5 }));
    check('建世界时的纬度（各格纬度）', false, () => {
      const old = w.settings;
      w.settings = { ...old, latNorth: old.latNorth + 3 };
      return () => (w.settings = old);
    });
    check('比例尺', false, () => {
      const old = w.kmPerUnit;
      w.kmPerUnit = old * 1.1;
      return () => (w.kmPerUnit = old);
    });
    // 平面的输运图无环，按拓扑序扫一遍就已收敛：只有 0 遍时结果才不同
    check('扫描遍数', false, () => {
      const old = SWEEPS;
      setSweeps(0);
      return () => setSweeps(old);
    });
    // 只影响温度、降水的输入：命中
    check('冷暖微调', true, cellArray(w.causes.tempOffset, land[5], 3));
    check('干湿微调', true, cellArray(w.causes.moistOffset, land[7], -0.5));
    check('湿度', true, planet({ humidity: 1.4 }));
    check('直减率', true, planet({ lapse: 9 }));
    check('日照', true, planet({ solar: 1.1 }));
  });

  it('整个星球', () => {
    const { w, elevation, check, planet, cellArray, land, inland, high } = climateCase('planet');
    check('海陆', false, cellArray(w.causes.land, inland, 0));
    check('高程', false, cellArray(elevation, high, elevation[high] + 400));
    check('倾角', false, planet({ tilt: 31 }));
    check('自转', false, planet({ rotation: -1 }));
    check('日照（经海温影响陆地）', false, planet({ solar: 1.1 }));
    check('洋流强弱', false, planet({ currents: 0.5 }));
    check('没有洋流', false, planet({ currents: 0 }));
    check('山挡风', false, planet({ terrainWind: 0.5 }));
    check('比例尺', false, () => {
      const old = w.kmPerUnit;
      w.kmPerUnit = old * 1.1;
      return () => (w.kmPerUnit = old);
    });
    check('风的扫描遍数', false, () => {
      const old = PLANET_SWEEPS.wind;
      PLANET_SWEEPS.wind = 2;
      return () => (PLANET_SWEEPS.wind = old);
    });
    // 洋流有自己的缓存（键里没有遍数），这一项的结果不变：只要求错过、与从头算相同
    check(
      '海流的扫描遍数',
      false,
      () => {
        const old = PLANET_SWEEPS.ocean;
        PLANET_SWEEPS.ocean = 3;
        return () => (PLANET_SWEEPS.ocean = old);
      },
      false,
    );
    // 整个星球的纬度只取决于网格（不能南北挪动），不单独改
    check('冷暖微调', true, cellArray(w.causes.tempOffset, land[5], 3));
    check('干湿微调', true, cellArray(w.causes.moistOffset, land[7], -0.5));
    check('湿度', true, planet({ humidity: 1.4 }));
    check('直减率', true, planet({ lapse: 9 }));
  });
});

describe('汇流的缓存：键完整', () => {
  it('高程、海陆、画的河改了就重算，只改气候时复用', () => {
    const settings = settingsOf('region');
    const eng = new Engine(settings, meshFor(settings));
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const w = eng.world;
    const elevation = w.derived.elevation.slice();
    const src = w.derived;
    const run = (d0: Derived) => {
      const d = { ...d0 };
      for (const [k, v] of Object.entries(d)) if (ArrayBuffer.isView(v)) (d as unknown as Record<string, unknown>)[k] = (v as Float32Array).slice();
      computeHydrology(w, elevation, d);
      return ['lake', 'water', 'receiver', 'discharge', 'drainArea', 'wetness', 'basin', 'slope'].map((k) => digest((d as unknown as Record<string, ArrayBufferView>)[k]));
    };
    const check = (label: string, hit: boolean, change: () => () => void, d: () => Derived = () => src) => {
      const before = run(src);
      const undo = change();
      const [h, m] = counts(routeMemo);
      const got = run(d());
      expect([routeMemo.hit - h, routeMemo.miss - m], `${label}：${hit ? '应当命中' : '应当错过'}`).toEqual(hit ? [1, 0] : [0, 1]);
      expect(got, label).toEqual(fresh(() => run(d())));
      undo();
      expect(run(src), `${label}：改回去`).toEqual(before);
    };
    const land = landCells(w);
    const high = land.reduce((a, i) => (elevation[i] > elevation[a] ? i : a), land[0]);
    check('高程', false, () => {
      const old = elevation[high];
      elevation[high] = old - 300;
      return () => (elevation[high] = old);
    });
    check('海陆', false, () => {
      const i = land[land.length >> 1];
      w.causes.land[i] = 0;
      return () => (w.causes.land[i] = 1);
    });
    check('画的河', false, () => {
      const old = w.small.guides;
      w.small.guides = [...old, { id: 'test', cells: riverPath(w), locked: true, spring: true }];
      return () => (w.small.guides = old);
    });
    // 气候、河流门槛：汇流不变
    let wetter: Derived = src;
    check(
      '降水',
      true,
      () => {
        wetter = { ...src, precip: src.precip.map((p) => p * 1.5) };
        return () => {};
      },
      () => wetter,
    );
    check('河流门槛', true, () => {
      const old = w.small.planet;
      w.small.planet = { ...old, riverThreshold: 40 };
      return () => (w.small.planet = old);
    });
  });
});
