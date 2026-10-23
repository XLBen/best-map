import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { sampledBaseMemo } from './terrain';
import { meshFor } from './testing/fixtures';

// 生成器结果按网格、按采样的键缓存（换了一个世界也用）：与重新采样逐值相同。
// 同一个种子、不同的陆地多少（模型的参数换成这个世界的）、重画过的、打开存档（重放）都比一遍

function fresh<T>(f: () => T): T {
  sampledBaseMemo.on = false;
  try {
    return f();
  } finally {
    sampledBaseMemo.on = true;
  }
}

describe('生成器结果跨世界复用与重新采样逐值相同', () => {
  for (const [label, settings] of [
    ['一块地区', { cells: 3000, seed: 4 }],
    ['整个星球', { cells: 3000, seed: 4, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
  ] as const) {
    it(label, () => {
      const mesh = meshFor(settings);
      const build = (steps: (e: Engine) => void) => {
        const e = new Engine(settings, mesh);
        steps(e);
        return e;
      };
      const a = build((e) => {
        e.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents', landFraction: 0.5, mountains: 1.4 }, reset: true });
        e.exec({ op: 'reroll_region', x: 0.6, y: 0.45, radius: 0.08, variant: 1 });
      });
      const hits = sampledBaseMemo.hits;
      // 同一个种子、参数不同的新世界：用上 a 的采样
      const plain = (e: Engine) => e.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
      const b = build(plain);
      expect(sampledBaseMemo.hits).toBeGreaterThan(hits);
      expect(digestWorld(b.world)).toEqual(digestWorld(fresh(() => build(plain)).world));
      // 重放 a（重画过的那一份也在缓存里）
      const doc = a.toDoc();
      const replayed = Engine.fromDoc(doc, mesh);
      expect(digestWorld(replayed.world)).toEqual(digestWorld(a.world));
      expect(digestWorld(replayed.world)).toEqual(digestWorld(fresh(() => Engine.fromDoc(doc, mesh)).world));
    });
  }
});
