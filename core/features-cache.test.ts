import { describe, expect, it } from 'vitest';
import { coastalStroke } from '../tools/hash';
import { Engine } from './engine';
import { type GeoFeature, detectFeatures, featureMemo } from './features';

// 地物识别按地形缓存各段的输入：每一步编辑之后，引擎里（用了缓存）的地物与不用缓存从头识别的逐值相同

// 地物的全部内容（含格子）；-0 与 NaN 单独写出来，JSON 里不会混同
const json = (fs: GeoFeature[]) =>
  JSON.stringify(
    fs.map((f) => ({ ...f, cells: Array.from(f.cells) })),
    (_, v) => (typeof v === 'number' && (Object.is(v, -0) || Number.isNaN(v)) ? String(v) : v),
  );

function check(eng: Engine) {
  const got = json(eng.world.derived.features);
  featureMemo.on = false;
  let fresh: string;
  try {
    fresh = json(detectFeatures(eng.world, eng.world.derived));
  } finally {
    featureMemo.on = true;
  }
  expect(got).toBe(fresh);
  // 用缓存再识别两次（撤销换回的推导可能已不在缓存里）：第二次各段都命中，结果仍相同
  expect(json(detectFeatures(eng.world, eng.world.derived))).toBe(fresh);
  const hits = featureMemo.hits;
  expect(json(detectFeatures(eng.world, eng.world.derived))).toBe(fresh);
  expect(featureMemo.hits - hits).toBe(5);
}

describe('地物识别的缓存与从头识别逐值一致', () => {
  for (const kind of ['region', 'planet'] as const) {
    it(kind, () => {
      const settings = kind === 'planet' ? { seed: 2, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 } : { seed: 2, cells: 6000 };
      const eng = new Engine(settings);
      const w = eng.world;
      const land = () => [...Array(w.mesh.n).keys()].filter((i) => eng.world.causes.land[i]);
      eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'archipelago' }, reset: true });
      check(eng);
      // 只改气候：陆海、地势不变的段直接用缓存
      const hits = featureMemo.hits;
      eng.exec({ op: 'paint', field: 'tempOffset', cells: land().slice(0, 200), value: -4, mode: 'add' });
      expect(featureMemo.hits).toBeGreaterThan(hits);
      check(eng);
      eng.exec({ op: 'paint', field: 'moistOffset', cells: land().slice(100, 300), value: -0.5, mode: 'add' });
      check(eng);
      // 生态约束
      eng.exec({ op: 'add_constraint', constraint: { cells: land().slice(300, 380), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } });
      check(eng);
      // 涂出来的生态区：硬覆盖一片荒漠、擦掉其中一段、新加一种生态再涂上、涂过之后再改气候
      const l0 = land();
      eng.exec({ op: 'add_constraint', constraint: { cells: l0.slice(400, 520), species: 'desert', mode: 'override', ratio: 1, radius: 300 } });
      check(eng);
      eng.exec({ op: 'erase_constraints', cells: l0.slice(440, 470) });
      check(eng);
      const never = { field: 'tMean', min: 90, optLow: 95, optHigh: 98, max: 99 };
      eng.exec({ op: 'add_species', species: { id: 'crystal', name: '水晶丛林', terrain: 'plains', tolerances: [never] } });
      check(eng);
      eng.exec({ op: 'add_constraint', constraint: { cells: l0.slice(600, 680), species: 'crystal', mode: 'override', ratio: 1, radius: 300 } });
      check(eng);
      expect(w.derived.features.some((f) => f.species === 'crystal')).toBe(true);
      eng.exec({ op: 'paint', field: 'tempOffset', cells: l0.slice(0, 300), value: 3, mode: 'add' });
      check(eng);
      eng.exec({ op: 'update_species', id: 'crystal', patch: { name: '水晶林' } });
      check(eng);
      // 改海陆（先预览：预览用的副本与引擎共用网格，也共用缓存）
      let cells = coastalStroke(w, 0.4, 5);
      const cmd = { op: 'paint_land' as const, cells, t: cells.map(() => 0), mode: 'land' as const };
      eng.preview(cmd);
      eng.exec(cmd);
      check(eng);
      // 只改地势：陆海不变，小岛的“火山”标签按新的高度
      const l = land();
      eng.exec({ op: 'paint_relief', cells: l.slice(0, 120), t: l.slice(0, 120).map(() => 0.3), strength: 1.5 });
      check(eng);
      // 河的门槛
      eng.exec({ op: 'set_planet', patch: { riverThreshold: 60 } });
      check(eng);
      // 改名：不重新识别，只重新起名
      eng.exec({ op: 'rename_feature', key: eng.world.derived.features[0].key, name: '测试之地' });
      check(eng);
      cells = coastalStroke(w, 0.7, 4);
      eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
      check(eng);
      for (let k = 0; k < 3; k++) {
        eng.undo();
        check(eng);
      }
      eng.redo();
      check(eng);
      eng.exec({ op: 'set_planet', patch: { humidity: 1.3 } });
      check(eng);
      eng.undo();
      check(eng);
    });
  }
});
