import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { DOC_VERSION, OLD_DOC_ERROR, isCurrentDoc } from './doc-version';
import { Engine, type WorldDoc } from './engine';
import { engineFor, meshFor } from './testing/fixtures';

// 文档版本：第九轮起一律是 5，不再兼容以前的存档。旧版本的世界打开时直接说打不开，不去重放

describe('文档版本', () => {
  const cmds: Command[] = [
    { op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true },
    { op: 'batch', label: '一组', commands: [{ op: 'set_planet', patch: { riverThreshold: 80 } }, { op: 'batch', commands: [{ op: 'set_coast_style', roughness: 1.2 }] }] },
  ];

  it('toDoc 一律存成 7（第三十二轮；一块地区、整个星球都是）；fromDoc 照样打开', () => {
    for (const settings of [{ seed: 2, cells: 3000 }, { seed: 2, cells: 3000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }]) {
      const eng = engineFor(settings);
      for (const c of cmds) eng.exec(c);
      const doc = eng.toDoc();
      expect(doc.version).toBe(DOC_VERSION);
      expect(DOC_VERSION).toBe(7);
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
    for (const version of [1, 2, 3, 4, 5, 6, 8]) {
      const doc = { ...v4, version } as unknown as WorldDoc;
      expect(() => Engine.fromDoc(doc, mesh)).toThrow(OLD_DOC_ERROR);
      expect(isCurrentDoc(doc)).toBe(false);
    }
    expect(OLD_DOC_ERROR).toBe('旧版本的世界文件打不开');
    expect(() => Engine.fromDoc({ ...v4, format: 'x' } as unknown as WorldDoc, mesh)).toThrow('不是 map2 世界文件');
    expect(isCurrentDoc({ ...v4, version: 7 })).toBe(true);
    expect(isCurrentDoc(null)).toBe(false);
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
