import { describe, expect, it, vi } from 'vitest';
import { continents } from '../../core/testing/fixtures';
import { exec, history, options, replaceLast, setOptions, toast, world } from '../state';
import { TOOL_DEFS } from './defs/tools';
import { type Pointer, chainTool, rerollChain } from './tools';

// 岛链工具栏的“换个排列”、R（第十二轮）：上一条岛链还是最后一步时重新排它（换掉最后一步），否则换下一条的排列并说一声

vi.mock('../state', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../state')>();
  return { ...mod, exec: vi.fn(async () => true), replaceLast: vi.fn(async () => true) };
});

const pt = (x: number, y: number, sx: number, cell: number): Pointer => ({ x, y, cell, sx, sy: 100, shift: false, alt: false });

describe('岛链的换个排列', () => {
  it('画完一条：工具栏按钮、R 都换掉这一条（换下一种排列）；之后又改了别的就换下一条的', async () => {
    const eng = continents();
    const w = eng.world;
    world.value = w;
    setOptions({ chainVariant: 0, chainKm: 2 * w.mesh.spacing * w.kmPerUnit });
    // 还没画过：只换下一条的排列
    vi.mocked(replaceLast).mockClear();
    await rerollChain();
    expect(vi.mocked(replaceLast)).not.toHaveBeenCalled();
    expect(options.value.chainVariant).toBe(1);
    expect(toast.value?.text).toContain('下一条的排列');
    // 画一条
    const s = w.mesh.spacing;
    const c = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i] && w.mesh.x[i] > 0.4 && w.mesh.y[i] > 0.4)!;
    const [x, y] = [w.mesh.x[c], w.mesh.y[c]];
    const t = chainTool();
    vi.mocked(exec).mockClear();
    vi.mocked(exec).mockImplementation(async () => {
      history.value = [...history.value, { summary: '画了一条岛链：5 个火山岛', done: true }];
      return true;
    });
    t.down?.(pt(x, y, 200, c));
    t.move?.(pt(x + 6 * s, y, 240, c), true);
    await t.up?.(pt(x + 12 * s, y, 280, c));
    const first = vi.mocked(exec).mock.calls[0][0] as { op: string; chain: { variant: number } };
    expect(first.op).toBe('add_island_chain');
    expect(first.chain.variant).toBe(1);
    // 工具栏按钮：换掉这一条（下一种排列）
    const bar = TOOL_DEFS.chain.bar!(w);
    const action = bar.find((b) => b.kind === 'action');
    expect(action && action.kind === 'action' && action.label).toBe('换个排列');
    if (action?.kind === 'action') action.run();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(replaceLast)).toHaveBeenCalledTimes(1);
    const again = vi.mocked(replaceLast).mock.calls[0][0] as { op: string; chain: { variant: number; points: unknown } };
    expect(again.op).toBe('add_island_chain');
    expect(again.chain.points).toEqual((first.chain as unknown as { points: unknown }).points);
    expect(again.chain.variant).toBe(2);
    // R 也一样（再换一种）
    TOOL_DEFS.chain.reroll!();
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(replaceLast)).toHaveBeenCalledTimes(2);
    expect((vi.mocked(replaceLast).mock.calls[1][0] as { chain: { variant: number } }).chain.variant).toBe(3);
    // 之后又改了别的：只换下一条的排列
    history.value = [...history.value, { summary: '涂了 30 格荒漠', done: true }];
    await rerollChain();
    expect(vi.mocked(replaceLast)).toHaveBeenCalledTimes(2);
    expect(toast.value?.text).toContain('上一条岛链之后又改了别的');
    // 撤销了那一步：又是最后一步
    history.value = history.value.map((h, k, a) => (k === a.length - 1 ? { ...h, done: false } : h));
    await rerollChain();
    expect(vi.mocked(replaceLast)).toHaveBeenCalledTimes(3);
  });
});
