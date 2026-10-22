import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { effectsAt } from './effects';
import { Engine, passStats } from './engine';
import { graphDistance } from './mesh';
import { FANTASY_BIOMES } from './packs/fantasy-biomes';
import { FANTASY_RIVER_TYPES } from './packs/fantasy-rivers';
import type { Species } from './species';
import { continents } from './testing/fixtures';

// 生态、河对周围的影响：第一遍植被之后按它的结果算一次，之后的求解、最后一遍都在加了影响的气候上算

const dead = FANTASY_BIOMES.find((s) => s.id === 'dead_forest')!;
const { effects: _, ...deadPlain } = dead;

function withSpecies(sp: Species) {
  const eng = continents();
  const passes = passStats.passes;
  eng.exec({ op: 'add_species', species: sp });
  return { eng, passes: passStats.passes - passes };
}

describe('对周围的影响', () => {
  it('没有影响的世界里没有 effT、effP 这两个键', () => {
    const { eng, passes } = withSpecies(deadPlain as Species);
    expect('effT' in eng.world.derived).toBe(false);
    expect('effP' in eng.world.derived).toBe(false);
    expect(passes).toBe(1);
  });

  it('死亡森林让周围变干：范围以内雨水少了，范围以外逐位不变；固定多算一遍', () => {
    const a = withSpecies(deadPlain as Species);
    const b = withSpecies(dead);
    expect(a.passes).toBe(1);
    expect(b.passes).toBe(2);
    const w = b.eng.world;
    const da = a.eng.world.derived;
    const db = w.derived;
    expect(db.effP).toBeInstanceOf(Float32Array);
    const s = w.small.species.findIndex((x) => x.id === 'dead_forest');
    // 源头：第一遍（与没有影响的世界相同）里死亡森林主导的格
    const seeds: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (da.dominant[i] === s) seeds.push(i);
    expect(seeds.length).toBeGreaterThan(0);
    const R = dead.effects!.climate!.radiusKm / w.kmPerUnit;
    const dist = graphDistance(w.mesh, seeds);
    let drier = 0;
    let outside = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (dist[i] > R) {
        outside++;
        expect(Object.is(db.precip[i], da.precip[i]), `格 ${i}`).toBe(true);
        expect(Object.is(db.tMean[i], da.tMean[i])).toBe(true);
        expect(db.effP![i]).toBe(0);
      } else if (w.causes.land[i] && dist[i] < R * 0.5) {
        expect(db.precip[i]).toBeLessThan(da.precip[i]);
        expect(db.effP![i]).toBeLessThan(0);
        drier++;
      }
    }
    expect(outside).toBeGreaterThan(0);
    expect(drier).toBeGreaterThan(0);
    // 检查器：说得出是谁的影响（按现在的生态认源头：现在还是死亡森林的地方）
    const at = seeds.find((i) => db.dominant[i] === s && db.effP![i] < -0.1)!;
    expect(at).toBeDefined();
    expect(effectsAt(w, db, at)[0]?.name).toBe('死亡森林');
  });

  it('河的两岸：熔岩河让两岸变热变干；总量截在 ±15 °C、±2.5', () => {
    const eng = continents();
    const lava = FANTASY_RIVER_TYPES.find((t) => t.id === 'lava_river')!;
    eng.exec({ op: 'set_river_type', type: { ...lava, scripts: { match: { api: 1, src: 'return 流量 > 3 * 河流门槛;' } } } });
    const d = eng.world.derived;
    // 源头是第一遍里的熔岩河（最后一遍的河因为变干了可能少几格）：河上 +4 °C，往外减弱，范围以外为 0
    let warm = 0;
    for (let i = 0; i < eng.world.mesh.n; i++) {
      expect(d.effT![i]).toBeGreaterThanOrEqual(0);
      expect(d.effT![i]).toBeLessThanOrEqual(4 + 1e-5);
      expect(d.effP![i]).toBeLessThanOrEqual(0);
      if (!eng.world.causes.land[i]) expect(d.effT![i]).toBe(0);
      if (d.effT![i] > 4 - 1e-5) warm++;
    }
    expect(warm).toBeGreaterThan(0);
    // 截到 ±15 °C、±2.5：几种影响叠在一起时
    eng.exec({ op: 'set_river_type', type: { ...lava, bank: { radiusKm: 180, dT: 10, dP: -1.5 }, scripts: { match: { api: 1, src: 'return 流量 > 3 * 河流门槛;' } } } });
    eng.exec({ op: 'update_species', id: 'taiga', patch: { effects: { climate: { dT: 10, dP: -1.5, radiusKm: 3000 } } } });
    const e = eng.world.derived;
    let capped = 0;
    for (let i = 0; i < eng.world.mesh.n; i++) {
      expect(Math.abs(e.effT![i])).toBeLessThanOrEqual(15);
      expect(Math.abs(e.effP![i])).toBeLessThanOrEqual(2.5);
      if (e.effT![i] === 15 && e.effP![i] === -2.5) capped++;
    }
    expect(capped).toBeGreaterThan(0);
  });

  it('自然融入的涂色在加了影响的气候上求解：不另外多算一遍', () => {
    const eng = continents();
    eng.exec({ op: 'add_species', species: dead });
    const w = eng.world;
    const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1);
    const passes = passStats.passes;
    eng.exec({ op: 'add_constraint', constraint: { cells: land.slice(300, 340), species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } });
    // 第一遍 + 求解的一到两轮（影响的那一遍就是求解的那一轮）
    expect(passStats.passes - passes).toBeLessThanOrEqual(3);
    expect(w.derived.effP).toBeInstanceOf(Float32Array);
  });

  it('撤销、重放与从头算逐值一致', () => {
    const eng = continents();
    const start = digestWorld(eng.world);
    eng.exec({ op: 'add_species', species: dead });
    eng.exec({ op: 'set_river_type', type: FANTASY_RIVER_TYPES.find((t) => t.id === 'lava_river')! });
    eng.exec({ op: 'update_species', id: 'dead_forest', patch: { effects: { climate: { dP: -0.5, dT: -1, radiusKm: 400 } } } });
    const after = digestWorld(eng.world);
    expect(after['derived.effT']).toBeDefined();
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    expect(digestWorld(Engine.fromDoc(doc, eng.world.mesh).world)).toEqual(after);
    eng.undo();
    eng.undo();
    eng.undo();
    expect(digestWorld(eng.world)).toEqual(start);
    eng.redo();
    eng.redo();
    eng.redo();
    expect(digestWorld(eng.world)).toEqual(after);
  });
});
