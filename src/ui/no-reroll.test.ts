import { describe, expect, it } from 'vitest';
import { continents } from '../../core/testing/fixtures';
import { setOptions, world } from '../state';
import { TOOL_DEFS } from './defs/tools';

// 第十三轮：去掉“换个形状”“换个排列”（工具栏按钮、R 键、提示条的按钮）；每放一个岛、每画一条岛链自动换一个
describe('放岛、岛链没有“换个形状 / 换个排列”', () => {
  it('工具栏里只有种类；工具定义里没有 R 键的“换一个”', () => {
    const w = continents().world;
    world.value = w;
    for (const kind of ['continental', 'low', 'atoll', 'reef'] as const) {
      setOptions({ islandKind: kind });
      const bar = TOOL_DEFS.island.bar!(w);
      expect(bar.filter((b) => b.kind === 'action')).toEqual([]);
      expect(JSON.stringify(bar)).not.toContain('换个');
    }
    const chain = TOOL_DEFS.chain.bar!(w);
    expect(chain.filter((b) => b.kind === 'action')).toEqual([]);
    expect(JSON.stringify(chain)).not.toContain('换个');
    for (const def of Object.values(TOOL_DEFS)) expect('reroll' in def).toBe(false);
  });
});
