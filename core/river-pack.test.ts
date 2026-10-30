import { describe, expect, it } from 'vitest';
import { MAP_UNDER_SHORE, drawTypes, packRivers, riverDraw, unpackRivers, worldRivers } from './river-pack';
import { type RiverLine, traceRivers } from './rivers';
import { continents, engineFor, snapshot } from './testing/fixtures';
import type { World } from './world';

// 第十三轮：地图上的河在计算 Worker 里描好、打包转交，主线程拆开直接用。拆开的与主线程上描的逐位相同

const planet = () =>
  snapshot('planet-4000-s4', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    return eng;
  });

// 每个数按 Float64 的字节比（±0、NaN 也分得出）
const bytes = (a: ArrayLike<number>) => new Uint8Array(Float64Array.from(a).buffer);
function sameLines(a: RiverLine[], b: RiverLine[]) {
  expect(a.length).toBe(b.length);
  a.forEach((l, i) => {
    const o = b[i];
    expect(bytes(l.points.flat())).toEqual(bytes(o.points.flat()));
    expect(bytes(l.flow)).toEqual(bytes(o.flow));
    expect(l.cells).toEqual(o.cells);
    expect(l.mul ? bytes(l.mul) : null).toEqual(o.mul ? bytes(o.mul) : null);
    expect(l.type).toEqual(o.type);
    expect([l.head, l.mouth, l.into, l.guide, l.joins, l.branch]).toEqual([o.head, o.mouth, o.into, o.guide, o.joins, o.branch]);
  });
}

function check(w: World) {
  const here = traceRivers(w);
  const { lines, draws } = unpackRivers(worldRivers(w));
  sameLines(lines, here);
  // 带子与主线程上按地图的画法画的逐位相同
  const types = drawTypes(w);
  expect(draws).not.toBeNull();
  here.forEach((l, i) => {
    const d = riverDraw(l, w.small.planet.riverThreshold, w.mesh.spacing, types, 1, MAP_UNDER_SHORE);
    const e = draws![i];
    for (const k of ['x', 'y', 's'] as const) expect(bytes(e.rb[k])).toEqual(bytes(d.rb[k]));
    for (const k of ['nx', 'ny', 'hw', 'src'] as const) expect(Array.from(e.rb[k])).toEqual(Array.from(d.rb[k]));
    expect([e.rb.x0, e.rb.y0, e.rb.x1, e.rb.y1, e.rb.maxHw]).toEqual([d.rb.x0, d.rb.y0, d.rb.x1, d.rb.y1, d.rb.maxHw]);
    expect(e.type ? Array.from(e.type) : null).toEqual(d.type ? Array.from(d.type) : null);
  });
  return here.length;
}

describe('Worker 里描好的河（第十三轮）', () => {
  it('一块地区、整个星球：拆开的河线、带子与主线程上描的逐位相同', () => {
    expect(check(continents().world)).toBeGreaterThan(50);
    expect(check(planet().world)).toBeGreaterThan(50);
  });

  it('有画的河、河流类型：照样逐位相同；打包、拆开往返不变', () => {
    const eng = continents();
    const w = eng.world;
    // 一种河流类型（加粗）：带子按它的粗细
    eng.exec({ op: 'set_river_type', type: { id: 'blood', name: '血河', color: '#8f1414', width: 1.6 } });
    const lines = traceRivers(w);
    const big = lines.filter((l) => l.cells && l.cells.length > 20)[0];
    const cells = big.cells!.filter((c, k, a) => k === 0 || c !== a[k - 1]);
    eng.exec({ op: 'add_guide', guide: { cells, locked: true, spring: true, flow: 3, name: '', type: 'blood' } });
    expect(drawTypes(w)).not.toBeNull();
    expect(traceRivers(w).some((l) => l.type?.some((t) => t > 0))).toBe(true);
    check(w);
    const again = unpackRivers(packRivers(traceRivers(w))).lines;
    sameLines(again, traceRivers(w));
  });

  it('描河读的东西没变时用上一次描好的（复制一份）；就地改了流量也认得出来，重新描', () => {
    const w = continents().world;
    const a = worldRivers(w);
    const b = worldRivers(w);
    expect(b.pts).not.toBe(a.pts);
    sameLines(unpackRivers(b).lines, unpackRivers(a).lines);
    // 同一个数组就地改：按内容认
    const d = { ...w.derived, discharge: w.derived.discharge.slice() };
    const w2 = { ...w, derived: d };
    worldRivers(w2);
    const big = traceRivers(w2).find((l) => l.cells && l.cells.length > 10)!;
    for (const c of big.cells!) d.discharge[c] *= 4;
    sameLines(unpackRivers(worldRivers(w2)).lines, traceRivers(w2));
  });
});
