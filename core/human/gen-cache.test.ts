import { describe, expect, it } from 'vitest';
import { ERA_PACKS } from '../packs/eras';
import { continents, humanDigest, humanExec } from '../testing/fixtures';
import { clearGenCaches } from './gen-cache';

// 第八十四轮：重新生成国家时照用上一次的宗教传播、过河翻山的倍数（gen-cache.ts）。有缓存和清掉缓存再算，结果逐位相同；
// 撤销、重做以后（推导是新的数组、内容一样）照样对得上；换了地形以后缓存不用（结果和清掉缓存一样）
const digestAll = (e: ReturnType<typeof continents>) => ({ ...humanDigest(e.world), roads: JSON.stringify(e.world.small.roads ?? null) });

describe('生成人文的缓存', () => {
  for (const era of ['medieval', 'fantasy']) {
    it(`${era}：重新生成国家，有缓存与没缓存逐位相同`, () => {
      const e = continents({ provinces: true });
      humanExec(e, { op: 'generate_human', packs: [[era]], groups: ERA_PACKS.get(era)!.cultures.map(([id, weight]) => ({ id, weight })), countries: {}, settlements: {} });
      const base = e.clone();
      const runs = [5, 6, 5].map((seed) => {
        const a = base.clone();
        a.exec({ op: 'regenerate_countries', seed } as never);
        a.update();
        const cached = digestAll(a);
        const b = base.clone();
        clearGenCaches();
        b.exec({ op: 'regenerate_countries', seed } as never);
        b.update();
        expect(cached).toEqual(digestAll(b));
        return cached;
      });
      expect(runs[2]).toEqual(runs[0]);
      // 撤销、重做以后再重新生成
      e.exec({ op: 'regenerate_countries', seed: 6 } as never);
      e.undo();
      e.redo();
      e.update();
      expect(digestAll(e)).toEqual(runs[1]);
      // 改了冷暖（宜居度、河变了）：缓存不能照用
      const land = [...Array(e.world.mesh.n).keys()].filter((i) => e.world.causes.land[i]);
      const c = base.clone();
      c.exec({ op: 'paint', field: 'tempOffset', cells: land.slice(0, 400), values: land.slice(0, 400).map(() => -8), mode: 'add' } as never);
      const d = c.clone();
      c.exec({ op: 'regenerate_countries', seed: 5 } as never);
      c.update();
      clearGenCaches();
      d.exec({ op: 'regenerate_countries', seed: 5 } as never);
      d.update();
      expect(digestAll(c)).toEqual(digestAll(d));
    });
  }
});
