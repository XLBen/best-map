import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { Engine, docVersion } from './engine';
import { engineFor, meshFor } from './testing/fixtures';

// 文档版本：没用新字段、新命令的世界照旧是 2（一块地区）或 3（整个星球）；打开时也接受 4

describe('docVersion', () => {
  const cmds: Command[] = [
    { op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true },
    { op: 'batch', label: '一组', commands: [{ op: 'set_planet', patch: { riverThreshold: 80 } }, { op: 'batch', commands: [{ op: 'set_coast_style', roughness: 1.2 }] }] },
  ];

  it('与原来的写法相同：地区 2、星球 3（batch 里的命令也逐条看）', () => {
    expect(docVersion({ globe: false }, [])).toBe(2);
    expect(docVersion({ globe: true }, [])).toBe(3);
    expect(docVersion({ globe: false }, cmds)).toBe(2);
    expect(docVersion({ globe: true }, cmds)).toBe(3);
  });

  it('toDoc 用它；fromDoc 接受 2、3、4，拒绝别的', () => {
    const settings = { seed: 2, cells: 3000 };
    const eng = engineFor(settings);
    for (const c of cmds) eng.exec(c);
    const doc = eng.toDoc();
    expect(doc.version).toBe(2);
    const mesh = meshFor(settings);
    const again = Engine.fromDoc({ ...doc, version: 4 }, mesh);
    expect(digestWorld(again.world)).toEqual(digestWorld(eng.world));
    expect(() => Engine.fromDoc({ ...doc, version: 1 as 2 }, mesh)).toThrow('旧版本');
  });

  it('画的河（第八轮）：用了新的几项、截走、改一条画的河的存成 4；旧式的画河照旧', () => {
    expect(docVersion({ globe: false }, [{ op: 'add_guide', guide: { cells: [1, 2, 3], locked: true, spring: true, flow: 3 }, reroute: true, label: '画了一条河' }])).toBe(2);
    expect(docVersion({ globe: false }, [{ op: 'add_guide', guide: { cells: [1, 2], carve: 'bed' } }])).toBe(4);
    expect(docVersion({ globe: false }, [{ op: 'add_guide', guide: { cells: [1, 2], name: '' } }])).toBe(4);
    expect(docVersion({ globe: true }, [{ op: 'add_guide', guide: { cells: [1, 2] }, capture: true }])).toBe(4);
    expect(docVersion({ globe: false }, [{ op: 'batch', commands: [{ op: 'update_guide', id: 'river-1', patch: { width: 2 } }] }])).toBe(4);
  });

  it('类型自动判断的区块（第八轮）：存成 4；只是圈地区、改类型的照旧', () => {
    expect(docVersion({ globe: false }, [{ op: 'add_region', region: { kind: 'forest', cells: [1, 2, 3], auto: true } }])).toBe(4);
    expect(docVersion({ globe: true }, [{ op: 'batch', commands: [{ op: 'update_region', id: 'r1', auto: false }] }])).toBe(4);
    expect(docVersion({ globe: false }, [{ op: 'add_region', region: { kind: 'forest', cells: [1, 2, 3] } }, { op: 'update_region', id: 'r1', kind: 'plain' }])).toBe(2);
  });
});
