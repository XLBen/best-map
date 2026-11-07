import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { PACK_FORMAT, PACK_VERSION, readPack } from './packs';
import { BIOME_ID } from './packs/biome-ids';
import { DEFAULT_SPECIES } from './packs/nature';
import { ALPINE_LOW, CONDITIONS, HEIGHT_MARGIN, HEIGHT_MAX, type Species, elevationAsHeight, heightTolerance, speciesTolerances } from './species';
import { engineFor } from './testing/fixtures';
import type { Engine } from './engine';

// 第七十二轮：界面上海拔只在高度范围里设。读进来的生态带着海拔的耐受条件时，换成高度范围后算出来逐值相同才换（elevationAsHeight），
// 否则原样留着。这里拿整个世界的推导对照（除了 small：生态的写法本来就变了），不靠推算

// 高山多的一块地区
function mountains(): Engine {
  const eng = engineFor({ cells: 5000, seed: 1, latNorth: 60, latSouth: 20 });
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4, mountains: 1.5 }, reset: true });
  return eng;
}

// 世界里这几种生态换成给的写法，返回推导的摘要（small 不算）
function derivedWith(changes: readonly Species[]): Record<string, string> {
  const eng = mountains();
  for (const sp of changes) eng.exec({ op: 'update_species', id: sp.id, patch: { tolerances: sp.tolerances, height: sp.height ?? null } });
  const d = digestWorld(eng.world);
  delete d.small;
  return d;
}

const builtin = (id: string) => structuredClone(DEFAULT_SPECIES.find((s) => s.id === id)!) as Species;

// 高度范围写成最后一条海拔条件（以前的版本、别的程序可能这样存）
const asTolerance = (sp: Species): Species => {
  const { height, ...rest } = sp;
  return { ...rest, tolerances: [...sp.tolerances, heightTolerance(height!)] };
};

describe('读进来的海拔条件换成高度范围', () => {
  it('能换的：最后一条、唯一一条、和高度范围的曲线一样；换完就是原来的写法', () => {
    for (const id of [BIOME_ID.alpineMeadow, BIOME_ID.alpineTundra]) {
      const sp = builtin(id);
      expect(sp.height).toBeTruthy();
      const read = asTolerance(sp);
      expect(speciesTolerances(read)).toEqual(speciesTolerances(sp));
      expect(elevationAsHeight(read)).toEqual(sp);
    }
    // 两头不限、只限上限的也换
    const plain = { id: 'x', tolerances: [heightTolerance({ low: 0, high: 2000 })] };
    expect(elevationAsHeight(plain)).toEqual({ id: 'x', tolerances: [], height: { low: 0, high: 2000 } });
    expect(elevationAsHeight({ id: 'x', tolerances: [heightTolerance({ low: 800, high: HEIGHT_MAX })] })).toEqual({ id: 'x', tolerances: [], height: { low: 800, high: HEIGHT_MAX } });
  });

  it('换了以后整个世界的推导逐值相同', () => {
    const ids = [BIOME_ID.alpineMeadow, BIOME_ID.alpineTundra];
    const read = ids.map((id) => asTolerance(builtin(id)));
    const converted = read.map((sp) => elevationAsHeight(sp));
    expect(converted.map((sp) => sp.height)).toEqual(ids.map((id) => builtin(id).height));
    expect(derivedWith(converted)).toEqual(derivedWith(read));
  });

  it('换不了的原样留着：只长在高山上（过渡宽 500 m）、不是最后一条、已经有高度范围、两条海拔', () => {
    const mountain = CONDITIONS.mountain.tol();
    expect(mountain.optLow).toBe(ALPINE_LOW);
    expect(heightTolerance({ low: ALPINE_LOW, high: HEIGHT_MAX }).min).toBe(ALPINE_LOW - HEIGHT_MARGIN);
    expect(mountain.min).not.toBe(ALPINE_LOW - HEIGHT_MARGIN);
    const a = { id: 'a', tolerances: [mountain] };
    expect(elevationAsHeight(a)).toBe(a);
    const t = heightTolerance({ low: 1000, high: 3000 });
    const notLast = { id: 'b', tolerances: [t, { field: 'tMean', min: 0, optLow: 5, optHigh: 20, max: 25 }] };
    expect(elevationAsHeight(notLast)).toBe(notLast);
    const both = { id: 'c', tolerances: [t], height: { low: 500, high: 4000 } };
    expect(elevationAsHeight(both)).toBe(both);
    const two = { id: 'd', tolerances: [t, t] };
    expect(elevationAsHeight(two)).toBe(two);
  });

  it('只长在高山上真的换不了：硬换成高度范围时地图会变', () => {
    const sp = builtin(BIOME_ID.alpineMeadow);
    const { height: _, ...rest } = sp;
    const withMountain: Species = { ...rest, tolerances: [...sp.tolerances, CONDITIONS.mountain.tol()] };
    const forced: Species = { ...rest, tolerances: sp.tolerances, height: { low: ALPINE_LOW, high: HEIGHT_MAX } };
    expect(elevationAsHeight(withMountain)).toBe(withMountain);
    const a = derivedWith([forced]);
    const b = derivedWith([withMountain]);
    const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
    expect(diff.length).toBeGreaterThan(0);
  });

  it('从文件读资源包时换（包里的生态在 read 这一步换）', () => {
    const read = asTolerance(builtin(BIOME_ID.alpineMeadow));
    const r = readPack(JSON.stringify({ format: PACK_FORMAT, version: PACK_VERSION, id: 'p', name: '包', biomes: [read, { ...read, id: 'kept', tolerances: [...read.tolerances.slice(0, -1), CONDITIONS.mountain.tol()] }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.biomes![0].height).toEqual(builtin(BIOME_ID.alpineMeadow).height);
    expect(r.pack.biomes![0].tolerances.some((t) => t.field === 'elevation')).toBe(false);
    expect(r.pack.biomes![1].height).toBeUndefined();
    expect(r.pack.biomes![1].tolerances.at(-1)).toEqual(CONDITIONS.mountain.tol());
  });
});
