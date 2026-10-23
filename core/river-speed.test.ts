import { describe, expect, it } from 'vitest';
import { displayCoast } from './display';
import { traceRivers } from './rivers';
import { continents, engineFor, snapshot } from './testing/fixtures';
import type { World } from './world';

// 第十三轮：描河（traceRivers）不太慢。河口沿法向进水、挤在一起的河口挪开以后一度慢到第十二轮的两倍半到三倍
// （大星球主线程上 80–120 ms）；提速后单独跑：10 万格的奇幻星球约 40 ms（第十二轮的同一个世界约 20 ms，那时河口不改），
// 1.2 万格的地区约 7 ms、4000 格星球约 20 ms。现在地图上的河在 Worker 里描（见 river-pack.ts），主线程只拆包。
// 这里只防大的退步（和别的测试一起跑时慢三四倍，预算按十倍留）：每次换一份高程数组（海岸场按数组缓存，每次都是新算的，与改了一笔之后一样），取中位数

const planet = () =>
  snapshot('planet-4000-s4', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    return eng;
  });

function median(w: World, runs = 7): number {
  const ts: number[] = [];
  for (let r = 0; r < runs; r++) {
    const w2: World = { ...w, derived: { ...w.derived, elevation: w.derived.elevation.slice() } };
    displayCoast(w2);
    const t = performance.now();
    traceRivers(w2);
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  return ts[runs >> 1];
}

describe('描河的速度（第十三轮）', () => {
  it('一块地区、整个星球：描一遍的中位数在预算以内（机器忙时会慢几倍，预算留得宽）', () => {
    const a = median(continents().world);
    const b = median(planet().world);
    console.log(`描河：1.2 万格地区 ${a.toFixed(1)} ms，4000 格星球 ${b.toFixed(1)} ms`);
    expect(a).toBeLessThan(80);
    expect(b).toBeLessThan(200);
  });
});
