import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../../core/commands';
import { brushCells } from '../../../core/select';
import { continents } from '../../../core/testing/fixtures';
import { exec, openPanel, picking, selectedRiver, setOptions, sliderActive, tool, world } from '../../state';
import { riverTool } from '../river';
import { type ToolHandler, islandTool, landTool, reliefTool } from '../tools';
import { PRESSURE_MIN, Stroke } from '../tools/brush';
import { resetTouchUi, setPenPressure } from '../touch-ui';
import { type Rig, makeRig } from './input-rig';
import { TOOL_DELAY_MS } from './touch';

// 第一百轮：真的工具接在手指上。一指画一笔发一条命令；画到一半第二根手指落下、被系统拿走（pointercancel）时一条都不发、
// 预览去掉；两指捏合一条都不发。命令不真的执行（exec 是假的，和 tool-replay.test.ts 一样）

vi.mock('../../state', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../state')>();
  const { previewTerrain: run } = await import('../../../core/terrain');
  return { ...mod, exec: vi.fn(async () => true), previewTerrainOnce: vi.fn(async (patch) => run(mod.world.value!, patch)), previewProvinces: vi.fn(async () => null) };
});

const Z = 1600;
const W = 800;
const H = 600;
const eng = continents({ provinces: true });
const w = eng.world;
const s = w.mesh.spacing;
const cellKm = s * w.kmPerUnit;
const inMiddle = (i: number) => w.mesh.x[i] > 0.25 * w.mesh.width && w.mesh.x[i] < 0.75 * w.mesh.width && w.mesh.y[i] > 0.25 * w.mesh.height && w.mesh.y[i] < 0.75 * w.mesh.height;
const ring = (i: number, r: number) => brushCells(w, w.mesh.x[i], w.mesh.y[i], r * cellKm).cells;
const find = (keep: (i: number) => boolean) => {
  for (let i = 0; i < w.mesh.n; i += 7) if (keep(i)) return i;
  throw new Error('找不到合适的格');
};
// 一片内陆、一片海
const inland = find((i) => inMiddle(i) && w.causes.land[i] === 1 && ring(i, 6).every((c) => w.causes.land[c] && w.derived.lake[c] !== 1));
const sea = find((i) => inMiddle(i) && ring(i, 5).every((c) => !w.causes.land[c]));

let rigs: Rig[] = [];
// 镜头对着这一格：它在屏幕正中
function start(make: () => ToolHandler, center: number) {
  world.value = w;
  let handler: ToolHandler | null = null;
  const r = makeRig(w, () => (handler = make()), { x: w.mesh.x[center], y: w.mesh.y[center], zoom: Z }, [W, H]);
  rigs.push(r);
  const ptr = (id: number, x: number, y: number) => ({ pointerType: 'touch', pointerId: id, clientX: x, clientY: y, shiftKey: false, altKey: false, button: 0, pressure: 0 });
  return {
    r,
    tool: () => handler!,
    down: (id: number, x: number, y: number) => r.fire('pointerdown', ptr(id, x, y)),
    move: (id: number, x: number, y: number) => r.fire('pointermove', ptr(id, x, y)),
    up: (id: number, x: number, y: number) => r.fire('pointerup', ptr(id, x, y)),
    cancel: (id: number, x: number, y: number) => r.fire('pointercancel', ptr(id, x, y)),
    // 一指从 (x0, y0) 拖到 (x1, y1)，每 6 像素一下；不抬起
    async stroke(id: number, x0: number, y0: number, x1: number, y1: number) {
      await r.fire('pointerdown', ptr(id, x0, y0));
      vi.advanceTimersByTime(TOOL_DELAY_MS);
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
      for (let k = 1; k <= n; k++) await r.fire('pointermove', ptr(id, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
    },
  };
}
const sent = () => vi.mocked(exec).mock.calls.map((c) => c[0] as Command);

beforeEach(() => {
  vi.useFakeTimers();
  resetTouchUi();
  vi.mocked(exec).mockClear();
  tool.value = 'land';
  picking.value = false;
  openPanel.value = null;
  sliderActive.value = false;
  selectedRiver.value = null;
  setOptions({ brushKm: 1.5 * cellKm, islandKm: 2 * cellKm, landMode: 'land', landShape: 'brush', reliefMode: 'up', reliefAmount: 0.7, riverMode: 'course', riverEnd: 'flow', riverFlow: 4 });
});
afterEach(() => {
  for (const r of rigs) r.input.dispose();
  rigs = [];
  vi.useRealTimers();
});

describe('真的工具接在手指上', () => {
  it('一指画一笔陆地：抬起时发一条命令', async () => {
    const t = start(() => landTool(), sea);
    await t.stroke(1, 400, 300, 460, 300);
    expect(t.r.view.pressed).toBe(true);
    // 按着时有预览（画笔涂到的格）
    expect(t.tool().preview().layers.length + (t.tool().preview().ghost ? 1 : 0)).toBeGreaterThan(0);
    expect(sent()).toEqual([]);
    await t.up(1, 460, 300);
    const cmds = sent();
    expect(cmds.length).toBe(1);
    expect(cmds[0].op).toBe('paint_land');
    expect((cmds[0] as Extract<Command, { op: 'paint_land' }>).cells.length).toBeGreaterThan(3);
    expect(t.r.view.pressed).toBe(false);
    expect(t.r.view.pointer).toBeNull();
  });

  it('画到一半第二根手指落下：一条命令都不发，预览去掉；全部抬起以后再画照常', async () => {
    const t = start(() => landTool(), sea);
    await t.stroke(1, 400, 300, 460, 300);
    await t.down(2, 560, 300);
    expect(t.r.view.pressed).toBe(false);
    // 这一笔的预览没了（没有排着队的、没有按着的）
    const pv = t.tool().preview();
    expect(pv.layers).toEqual([]);
    expect(pv.ghost ?? null).toBeNull();
    await t.move(2, 620, 300);
    await t.up(1, 460, 300);
    await t.move(2, 500, 320);
    await t.up(2, 500, 320);
    expect(sent()).toEqual([]);
    expect(t.r.renderer.camera.zoom).not.toBe(Z);
    await t.stroke(3, 300, 300, 340, 300);
    await t.up(3, 340, 300);
    expect(sent().map((c) => c.op)).toEqual(['paint_land']);
  });

  it('画着被系统拿走（pointercancel）：不发命令，不卡在按着，之后还能画', async () => {
    const t = start(() => reliefTool(), inland);
    await t.stroke(1, 400, 300, 450, 300);
    await t.cancel(1, 450, 300);
    expect(sent()).toEqual([]);
    expect(t.r.view.pressed).toBe(false);
    expect(t.tool().preview().layers).toEqual([]);
    await t.stroke(2, 400, 300, 450, 300);
    await t.up(2, 450, 300);
    expect(sent().map((c) => c.op)).toEqual(['paint_relief']);
  });

  it('两指捏合、两指点一下：一条命令都不发', async () => {
    const t = start(() => landTool(), sea);
    await t.down(1, 350, 300);
    await t.down(2, 450, 300);
    await t.move(1, 300, 300);
    await t.move(2, 500, 300);
    await t.up(1, 300, 300);
    await t.up(2, 500, 300);
    // 两指几乎同时落下、马上抬起（没有移动）
    vi.advanceTimersByTime(1000);
    await t.down(3, 350, 300);
    await t.down(4, 450, 300);
    await t.up(3, 350, 300);
    await t.up(4, 450, 300);
    vi.advanceTimersByTime(1000);
    expect(sent()).toEqual([]);
    expect(t.r.view.pressed).toBe(false);
  });

  it('放岛：手指点一下放一个；按住时第二根手指落下不放', async () => {
    const t = start(() => islandTool(), sea);
    await t.down(1, 400, 300);
    await t.up(1, 400, 300);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent().length).toBe(1);
    const op = sent()[0].op;
    expect(['add_island', 'batch']).toContain(op);
    vi.mocked(exec).mockClear();
    vi.advanceTimersByTime(1000);
    await t.down(2, 300, 300);
    vi.advanceTimersByTime(TOOL_DELAY_MS);
    await t.down(3, 500, 300);
    await t.up(2, 300, 300);
    await t.up(3, 500, 300);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent()).toEqual([]);
  });

  it('笔的压力：开了偏好，堆山的力度乘上这一笔里最重的那一下；没开、手指、鼠标照旧', async () => {
    const pen = (id: number, x: number, pressure: number) => ({ pointerType: 'pen', pointerId: id, clientX: x, clientY: 300, shiftKey: false, altKey: false, button: 0, pressure });
    const penStroke = async (r: Rig, peak: number) => {
      await r.fire('pointerdown', pen(7, 400, 0.2));
      for (let k = 1; k <= 8; k++) await r.fire('pointermove', pen(7, 400 + 6 * k, k === 4 ? peak : 0.3));
      await r.fire('pointerup', pen(7, 448, 0));
    };
    const strength = () => (sent()[0] as Extract<Command, { op: 'paint_relief' }>).strength;
    const t = start(() => reliefTool(), inland);
    // 没开偏好：笔和鼠标一样
    await penStroke(t.r, 0.5);
    expect(strength()).toBe(0.7);
    vi.mocked(exec).mockClear();
    vi.advanceTimersByTime(1000);
    setPenPressure(true);
    await penStroke(t.r, 0.5);
    expect(strength()).toBe(0.7 * 0.5);
    vi.mocked(exec).mockClear();
    vi.advanceTimersByTime(1000);
    // 中间有一下很轻：按这一笔里最重的那一下算（别的几下是 0.3）
    await penStroke(t.r, 0.02);
    expect(strength()).toBe(0.7 * 0.3);
    // 一直按得极轻：也不低于 PRESSURE_MIN
    const faint = new Stroke();
    faint.press(0.01);
    expect(faint.pressure).toBe(PRESSURE_MIN);
    faint.press(undefined);
    expect(faint.pressure).toBe(PRESSURE_MIN);
    expect(new Stroke().pressure).toBe(1);
    vi.mocked(exec).mockClear();
    vi.advanceTimersByTime(1000);
    // 手指：没有压力这回事
    await t.stroke(1, 400, 300, 450, 300);
    await t.up(1, 450, 300);
    expect(strength()).toBe(0.7);
  });

  it('画河到一半第二根手指落下：不画', async () => {
    const t = start(() => riverTool(() => Z), inland);
    await t.stroke(1, 400, 300, 470, 330);
    await t.down(2, 600, 300);
    await t.up(1, 470, 330);
    await t.up(2, 600, 300);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent()).toEqual([]);
    expect(t.tool().preview().shapes).toEqual([]);
    // 对照：同样的一笔画完了是发命令的
    vi.advanceTimersByTime(1000);
    await t.stroke(3, 400, 300, 470, 330);
    await t.up(3, 470, 330);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent().length).toBe(1);
  });
});
