import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestWorld } from '../../tools/hash';
import type { Command } from '../../core/commands';
import { previewWorldOf } from '../../core/preview-world';
import { continents } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { exactDelay, exec, noteCost, previewReply, previewWorld, setOptions, sliderActive, slowPreview, world, worldState } from '../state';
import { type Pointer, biomeTool, climateTool, growTool } from './tools';

// 确切预览：按住停顿时在副本上算出将来的世界，接着画不跳回原样，松手执行的是同一条命令（Worker 直接采用）；
// 拖滑块时单点预览；成本闸门；过期的预览不显示

// 这里没有 worker：执行只记下命令，预览直接在引擎上算（与 Worker 里同一个函数），再像主线程那样拼回来
vi.mock('../state', async (importOriginal) => ({ ...(await importOriginal<typeof import('../state')>()), exec: vi.fn(async () => true), previewWorld: vi.fn() }));

const eng = continents({ cells: 5000 });
const at = (w: World, c: number): Pointer => ({ x: w.mesh.x[c], y: w.mesh.y[c], cell: c, sx: 10, sy: 20, shift: false, alt: false });
// 等预览的 promise 落地
const settle = async () => {
  for (let k = 0; k < 5; k++) await Promise.resolve();
};

function setup() {
  const w = eng.world;
  world.value = w;
  sliderActive.value = false;
  const cellKm = w.mesh.spacing * w.kmPerUnit;
  setOptions({ brushKm: 3 * cellKm, biome: 'temperate_forest', biomeMode: 'natural', reachKm: 10 * cellKm, tempMode: 'cold', climateAmount: 1 });
  // 两格离海远一点、能长东西的陆地
  const land = [...Array(w.mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.dominant[i] >= 0 && w.derived.elevation[i] > 100);
  const c = land[Math.floor(land.length / 3)];
  let d = c;
  for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (w.causes.land[w.mesh.adj[e]]) d = w.mesh.adj[e];
  return { w, c, d, cellKm };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(exec).mockClear();
  vi.mocked(previewWorld).mockReset();
  vi.mocked(previewWorld).mockImplementation(async (cmd: Command) => {
    const base = world.value!;
    const { result, patch } = eng.previewWorld(cmd);
    return { result, world: previewWorldOf(base, structuredClone(patch)), base };
  });
});
afterEach(() => {
  vi.useRealTimers();
  sliderActive.value = false;
});

describe('涂生态、冷暖：确切预览', () => {
  it('按住停顿 250 毫秒后画出将来的世界，变了的格描边；接着画不跳回原样；松手执行的就是预览的命令', async () => {
    const { w, c, d } = setup();
    const t = biomeTool();
    t.down?.(at(w, c));
    let pv = t.preview();
    expect(pv.world).toBeFalsy();
    expect(pv.hint).toMatch(/^温带阔叶林 \d+ 格$/);
    vi.advanceTimersByTime(300);
    await settle();
    expect(previewWorld).toHaveBeenCalledTimes(1);
    pv = t.preview();
    const first = pv.world;
    expect(first).toBeTruthy();
    expect(pv.layers[0].pattern).toBe('outline');
    expect(pv.hint).toMatch(/^温带阔叶林 · \d+ 格会变( · \d+ 格没涂成)?$/);
    // 接着画：还是上一个确切预览（不跳回原样），提示带“…”，新涂的格淡淡地涂上
    t.move?.(at(w, d), true);
    pv = t.preview();
    expect(pv.world).toBe(first);
    expect(pv.hint).toMatch(/…$/);
    // 再停一下：新的确切预览换上
    vi.advanceTimersByTime(300);
    await settle();
    expect(previewWorld).toHaveBeenCalledTimes(2);
    expect(t.preview().world).not.toBe(first);
    const previewed = vi.mocked(previewWorld).mock.calls[1][0];
    await t.up?.(at(w, d));
    expect(JSON.stringify(vi.mocked(exec).mock.calls[0][0])).toBe(JSON.stringify(previewed));
  });

  it('冷暖画笔的提示：更冷 −4 °C · 几格生态会变', async () => {
    const { w, c } = setup();
    const t = climateTool('temp');
    t.down?.(at(w, c));
    t.preview();
    vi.advanceTimersByTime(300);
    await settle();
    const pv = t.preview();
    expect(pv.world).toBeTruthy();
    expect(pv.hint).toMatch(/^更冷 −4 °C · (\d+ 格生态会变|生态不变)$/);
  });

  it('空闲悬停只有圈（自然融入多一道过渡范围的虚线圈），不算预览；拖滑块时单点确切预览“在这里涂会这样”', async () => {
    const { w, c, cellKm } = setup();
    const t = biomeTool();
    t.move?.(at(w, c), false);
    const pv = t.preview();
    expect(pv.layers).toEqual([]);
    const r = (3 * cellKm) / w.kmPerUnit;
    expect(pv.shapes.map((s) => +(s.r! / r).toFixed(3))).toEqual([+(13 / 3).toFixed(3), 1]);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(previewWorld).not.toHaveBeenCalled();
    // 强制：没有过渡范围
    setOptions({ biomeMode: 'force' });
    expect(t.preview().shapes.length).toBe(1);
    // 拖“半径”滑块
    t.leave?.();
    sliderActive.value = true;
    setOptions({ brushKm: 4 * cellKm });
    expect(t.preview().world).toBeFalsy();
    vi.advanceTimersByTime(300);
    await settle();
    const dab = t.preview();
    expect(previewWorld).toHaveBeenCalledTimes(1);
    expect(dab.world).toBeTruthy();
    expect(dab.hint).toBe('在这里涂会这样');
    expect(dab.sliderHint).toBe(true);
    // 松开滑块：预览去掉
    sliderActive.value = false;
    expect(t.preview().world ?? null).toBeNull();
  });

  it('拖动扩张：停顿时确切预览，松手执行同一条命令', async () => {
    const { w, c, cellKm } = setup();
    setOptions({ brushKm: 6 * cellKm });
    const t = growTool();
    t.down?.(at(w, c));
    // 往外拖几格
    const far = [...Array(w.mesh.n).keys()].find((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) > w.mesh.spacing * 8 && w.causes.land[i])!;
    t.move?.(at(w, far), true);
    t.preview();
    vi.advanceTimersByTime(300);
    await settle();
    const pv = t.preview();
    expect(previewWorld).toHaveBeenCalledTimes(1);
    expect(pv.world).toBeTruthy();
    // 扩张的是按下处的那种生态
    expect(pv.hint).toMatch(/^\S+ \+\d+ 格 · \d+ 格会变/);
    const previewed = vi.mocked(previewWorld).mock.calls[0][0];
    await t.up?.(at(w, far));
    expect(JSON.stringify(vi.mocked(exec).mock.calls[0][0])).toBe(JSON.stringify(previewed));
  });
});

describe('成本闸门', () => {
  it('上次这类命令算了 600 毫秒以上：不自动预览，说“松手后约 N 秒出结果”', async () => {
    const { w, c } = setup();
    const t = climateTool('temp');
    noteCost({ op: 'paint', field: 'tempOffset', cells: [], values: [], mode: 'add' }, 2400);
    expect(slowPreview({ op: 'paint', field: 'tempOffset', cells: [1], values: [1], mode: 'add' })).toBe(2);
    t.down?.(at(w, c));
    t.preview();
    vi.advanceTimersByTime(1000);
    await settle();
    expect(previewWorld).not.toHaveBeenCalled();
    expect(t.preview().hint).toMatch(/松手后约 2 秒出结果$/);
    t.cancel?.();
    noteCost({ op: 'paint', field: 'tempOffset', cells: [], values: [], mode: 'add' }, 120);
    expect(slowPreview({ op: 'paint', field: 'tempOffset', cells: [1], values: [1], mode: 'add' })).toBeNull();
  });

  it('停顿多久：至少给的时间，最多 600 毫秒', () => {
    expect(exactDelay(250)).toBeGreaterThanOrEqual(250);
    expect(exactDelay(250)).toBeLessThanOrEqual(600);
  });
});

describe('状态编号', () => {
  it('不是按当前世界的状态算出来的预览不显示；对得上的拼回来与副本逐值相同', () => {
    vi.useRealTimers();
    const e = continents({ cells: 5000 });
    world.value = e.world;
    const cmd: Command = { op: 'set_planet', patch: { solar: 0.9 } };
    const { result, patch } = e.previewWorld(cmd);
    const reply = { id: 1, ok: true as const, preview: result, world: structuredClone(patch) };
    worldState.value = result.stateId + 1;
    expect(previewReply(reply)).toBeNull();
    worldState.value = result.stateId;
    const r = previewReply(reply)!;
    expect(r.base).toBe(e.world);
    const copy = (e as unknown as { lastPreview: { copy: { world: World } } }).lastPreview.copy.world;
    expect(digestWorld(r.world)).toEqual(digestWorld(copy));
  });
});
