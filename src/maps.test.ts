import { describe, expect, it } from 'vitest';
import type { WorldDoc } from '../core/engine';
import {
  GEN_STEPS,
  activeLink,
  createMap,
  defaultMapName,
  deleteMap,
  describeMap,
  fileNameOf,
  isQuotaError,
  listMaps,
  memoryMapStore,
  nameFromFile,
  needsSaveQuestion,
  overwriteMap,
  renameMap,
  summaryOf,
  uniqueName,
} from './maps';

// 我的地图：名字、新存、盖掉、另存为、改名、删掉、连着哪一张、要不要问“先保存吗”。存储换成内存里的

const region = { seed: 1, cells: 40000, aspect: 2, latNorth: 60, latSouth: 20 };
const doc = (commands: number, settings: Partial<WorldDoc['settings']> = {}): WorldDoc => ({
  format: 'map2-world',
  version: 7,
  settings: { ...region, ...settings },
  commands: Array.from({ length: commands }, (_, k) => ({ op: 'set_name', key: `k${k}`, name: `n${k}` }) as unknown as WorldDoc['commands'][number]),
});

describe('名字', () => {
  it('重了就加个数', () => {
    expect(uniqueName('赤原', [])).toBe('赤原');
    expect(uniqueName('赤原', ['赤原'])).toBe('赤原 2');
    expect(uniqueName('赤原', ['赤原', '赤原 2'])).toBe('赤原 3');
    expect(uniqueName('  ', [])).toBe('新世界');
    expect(uniqueName(' 赤原 ', [])).toBe('赤原');
  });

  it('默认名字是最大的一块陆地的名字，没有时“新世界”', () => {
    const f = [
      { type: 'island', name: '小岛', areaKm2: 10 },
      { type: 'ocean', name: '大洋', areaKm2: 1e7 },
      { type: 'continent', name: '赤原', areaKm2: 5e5 },
      { type: 'range', name: '山', areaKm2: 9e5 },
    ];
    expect(defaultMapName(f, [])).toBe('赤原');
    expect(defaultMapName(f, ['赤原'])).toBe('赤原 2');
    expect(defaultMapName([{ type: 'ocean', name: '大洋', areaKm2: 1 }], [])).toBe('新世界');
    expect(defaultMapName([], ['新世界'])).toBe('新世界 2');
  });

  it('文件名', () => {
    expect(nameFromFile('我的世界.json')).toBe('我的世界');
    expect(nameFromFile('a.JSON')).toBe('a');
    expect(fileNameOf('赤原 2')).toBe('赤原 2.json');
    expect(fileNameOf('a/b:c')).toBe('a_b_c.json');
    expect(fileNameOf('')).toBe('world.json');
  });

  it('概况：一块地区写宽，整个星球写半径', () => {
    expect(summaryOf(doc(0).settings)).toEqual({ kind: 'region', sizeKm: Math.round(40 * 111.2 * 2), cells: 40000 });
    expect(summaryOf(doc(0, { globe: true, radiusKm: 3000, cells: 100000 }).settings)).toEqual({ kind: 'planet', sizeKm: 3000, cells: 100000 });
    expect(describeMap({ kind: 'region', sizeKm: 8896, cells: 40000 })).toBe('一块地区 · 约 8900 km 宽 · 4 万格');
    expect(describeMap({ kind: 'planet', sizeKm: 6371, cells: 100000 })).toBe('整个星球 · 半径 6400 km · 10 万格');
  });
});

describe('存、盖掉、另存为、改名、删掉', () => {
  it('新存一张：列表里一小条，世界文件另存；名字重了加个数', async () => {
    const s = memoryMapStore();
    const a = await createMap(s, { name: '赤原', doc: doc(3), thumb: 'data:a', now: 100 });
    expect(a).toMatchObject({ name: '赤原', savedAt: 100, kind: 'region', cells: 40000, steps: 3, thumb: 'data:a' });
    expect(s.entries.get(a.id)).not.toHaveProperty('doc');
    expect(s.docs.get(a.id)!.commands).toHaveLength(3);
    const b = await createMap(s, { name: '赤原', doc: doc(2), now: 200 });
    expect(b.name).toBe('赤原 2');
    expect(b.id).not.toBe(a.id);
    expect(b).not.toHaveProperty('thumb');
    // 最近保存的在前
    expect((await listMaps(s)).map((e) => e.name)).toEqual(['赤原 2', '赤原']);
  });

  it('盖掉：名字照旧，世界文件、时间换新的；没给缩略图时缩略图照旧；那一张不在了返回 null', async () => {
    const s = memoryMapStore();
    const a = await createMap(s, { name: '赤原', doc: doc(3), thumb: 'data:a', now: 100 });
    const b = await overwriteMap(s, a.id, { doc: doc(5, { globe: true }), now: 300 });
    expect(b).toMatchObject({ id: a.id, name: '赤原', savedAt: 300, steps: 5, kind: 'planet', thumb: 'data:a' });
    expect(s.docs.get(a.id)!.commands).toHaveLength(5);
    const c = await overwriteMap(s, a.id, { doc: doc(6), thumb: 'data:b', now: 400 });
    expect(c!.thumb).toBe('data:b');
    expect(s.entries.size).toBe(1);
    expect(await overwriteMap(s, 'nope', { doc: doc(1) })).toBeNull();
    expect(s.entries.size).toBe(1);
  });

  it('另存为是新的一张，原来那一张不动', async () => {
    const s = memoryMapStore();
    const a = await createMap(s, { name: '赤原', doc: doc(3), now: 100 });
    const b = await createMap(s, { name: uniqueName(a.name, (await s.list()).map((e) => e.name)), doc: doc(4), now: 200 });
    expect(b.name).toBe('赤原 2');
    expect(s.docs.get(a.id)!.commands).toHaveLength(3);
    expect(s.docs.get(b.id)!.commands).toHaveLength(4);
  });

  it('改名：和别的重了加个数，和自己一样不加；空的不改；删掉连世界文件一起删', async () => {
    const s = memoryMapStore();
    const a = await createMap(s, { name: '赤原', doc: doc(1), now: 100 });
    const b = await createMap(s, { name: '青川', doc: doc(1), now: 200 });
    expect((await renameMap(s, b.id, '赤原'))!.name).toBe('赤原 2');
    expect((await renameMap(s, a.id, '赤原'))!.name).toBe('赤原');
    expect((await renameMap(s, a.id, '  '))!.name).toBe('赤原');
    expect((await renameMap(s, a.id, '白原'))!.name).toBe('白原');
    expect(s.docs.get(a.id)!.commands).toHaveLength(1);
    expect(await renameMap(s, 'nope', 'x')).toBeNull();
    await deleteMap(s, a.id);
    expect(s.entries.has(a.id)).toBe(false);
    expect(s.docs.has(a.id)).toBe(false);
    expect((await listMaps(s)).map((e) => e.name)).toEqual(['赤原 2']);
  });
});

describe('连着哪一张、先保存吗', () => {
  it('新建、打开了别的世界（纪元变了）之后不再连着', () => {
    const link = { id: 'a', name: '赤原', epoch: 3 };
    expect(activeLink(link, 3)).toBe(link);
    expect(activeLink(link, 4)).toBeNull();
    expect(activeLink(null, 3)).toBeNull();
  });

  it('没连着、生成之后又改过才问；连着的不问（自动保存一直写进去）', () => {
    expect(needsSaveQuestion(false, GEN_STEPS)).toBe(false);
    expect(needsSaveQuestion(false, GEN_STEPS + 1)).toBe(true);
    expect(needsSaveQuestion(true, GEN_STEPS + 10)).toBe(false);
    expect(needsSaveQuestion(false, 0)).toBe(false);
  });

  it('存储满了', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});
