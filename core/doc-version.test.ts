import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { DOC_VERSION, NEWER_DOC_ERROR, NOT_DOC_ERROR, OLD_DOC_ERROR, checkDoc, docAge, docVersionOf, isCurrentDoc } from './doc-version';
import { Engine, type WorldDoc } from './engine';
import { engineFor, meshFor } from './testing/fixtures';

// 文档版本：第九轮起一律是 5，不再兼容以前的存档。旧版本的世界打开时直接说打不开，不去重放

describe('文档版本', () => {
  const cmds: Command[] = [
    { op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true },
    { op: 'batch', label: '一组', commands: [{ op: 'set_planet', patch: { riverThreshold: 80 } }, { op: 'batch', commands: [{ op: 'set_coast_style', roughness: 1.2 }] }] },
  ];

  it('toDoc 一律存成 22（第九十一轮；一块地区、整个星球都是）；fromDoc 照样打开', () => {
    for (const settings of [{ seed: 2, cells: 3000 }, { seed: 2, cells: 3000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }]) {
      const eng = engineFor(settings);
      for (const c of cmds) eng.exec(c);
      const doc = eng.toDoc();
      expect(doc.version).toBe(DOC_VERSION);
      expect(DOC_VERSION).toBe(22);
      const again = Engine.fromDoc(JSON.parse(JSON.stringify(doc)) as WorldDoc, meshFor(settings));
      expect(digestWorld(again.world)).toEqual(digestWorld(eng.world));
    }
  });

  it('第 2–6 版（第三十一轮以前）的世界：打开时说“这是旧版本的世界，打不开”，不重放', () => {
    const settings = { seed: 2, cells: 3000 };
    const mesh = meshFor(settings);
    // 一个第八轮存的世界（第 4 版，带山挡风那一步）
    const v4 = {
      format: 'map2-world',
      version: 4,
      settings,
      commands: [
        { op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true },
        { op: 'batch', label: '山挡风：旧存档也打开', commands: [{ op: 'set_planet', patch: { terrainWind: 1 } }] },
      ],
    } as unknown as WorldDoc;
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) {
      const doc = { ...v4, version } as unknown as WorldDoc;
      expect(() => Engine.fromDoc(doc, mesh)).toThrow(OLD_DOC_ERROR);
      expect(isCurrentDoc(doc)).toBe(false);
    }
    expect(OLD_DOC_ERROR).toBe('旧版本的世界文件打不开');
    expect(() => Engine.fromDoc({ ...v4, format: 'x' } as unknown as WorldDoc, mesh)).toThrow('不是 map2 世界文件');
    expect(isCurrentDoc({ ...v4, version: 22 })).toBe(true);
    expect(isCurrentDoc(null)).toBe(false);
  });

  it('比这一版新的世界文件：另一句话（请先更新程序），不说成“旧版本”；不重放', () => {
    const settings = { seed: 2, cells: 3000 };
    const newer = { format: 'map2-world', version: DOC_VERSION + 1, settings, commands: [] } as unknown as WorldDoc;
    expect(() => Engine.fromDoc(newer, meshFor(settings))).toThrow(NEWER_DOC_ERROR);
    expect(() => checkDoc(newer)).toThrow(NEWER_DOC_ERROR);
    expect(NEWER_DOC_ERROR).toBe('这个世界是更新的版本做的，请先更新程序');
    expect(NEWER_DOC_ERROR).not.toBe(OLD_DOC_ERROR);
    expect(isCurrentDoc(newer)).toBe(false);
    expect(docAge(newer)).toBe('newer');
    expect(docAge({ ...newer, version: 999 })).toBe('newer');
    expect(docAge({ ...newer, version: DOC_VERSION - 1 })).toBe('older');
    expect(docAge({ ...newer, version: DOC_VERSION })).toBe('current');
    // 没写版本号、写的不是数：当旧版本（打不开，但留着）
    expect(docAge({ format: 'map2-world' })).toBe('older');
    expect(docAge({ format: 'map2-world', version: '30' })).toBe('older');
    expect(docAge({ format: 'x', version: DOC_VERSION })).toBe('other');
    expect(docAge(null)).toBe('other');
    expect(() => checkDoc({ format: 'x' })).toThrow(NOT_DOC_ERROR);
    expect(docVersionOf(newer)).toBe(DOC_VERSION + 1);
    expect(docVersionOf({ format: 'map2-world' })).toBeNull();
    expect(docVersionOf('x')).toBeNull();
  });

  it('检查点也不能拿来恢复旧版本的世界', () => {
    const settings = { seed: 2, cells: 3000 };
    const eng = engineFor(settings);
    for (const c of cmds) eng.exec(c);
    const cp = eng.toCheckpoint();
    const doc = eng.toDoc();
    expect(Engine.fromCheckpoint(cp, doc, meshFor(settings))).not.toBeNull();
    expect(() => Engine.fromCheckpoint(cp, { ...doc, version: 4 } as unknown as WorldDoc, meshFor(settings))).toThrow(OLD_DOC_ERROR);
  });
});
