import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smallGlobe } from '../../../core/testing/class-only';
import { continents } from '../../../core/testing/fixtures';
import type { World } from '../../../core/world';
import type { ProjCamera } from '../../render/projection';
import { openPanel, picking, pinnedCell, pinnedPart, tool, toast, world } from '../../state';
import { penSeen, resetTouchUi, setFingerPans, setHeld, setPenPressure, touchUi } from '../touch-ui';
import { type Rig, makeRig, recorderTool } from './input-rig';
import { LONG_PRESS_MS, TAP_SLOP_PX, TOOL_DELAY_MS } from './touch';
import '../tools/bind';

// 第一百轮：手指和笔接到地图上（map/input.ts → touch-wire.ts）。事件是手造的，时钟是假的（不等真的时间）。
// 手势怎么判定的细节在 touch.test.ts；这里查的是接到工具、镜头、钉住上的那一头

const region = continents({ provinces: true });
const globe = smallGlobe();

let rigs: Rig[] = [];
function start(drags: boolean | (() => boolean), camera: ProjCamera = { x: 0.5, y: 0.3, zoom: 1000 }, w: World = region.world) {
  world.value = w;
  const r = makeRig(w, (log) => recorderTool(log, drags), camera);
  rigs.push(r);
  const ptr = (type: 'touch' | 'pen' | 'mouse', id: number, x: number, y: number, more: object = {}) => ({ pointerType: type, pointerId: id, clientX: x, clientY: y, shiftKey: false, altKey: false, button: 0, pressure: type === 'pen' ? 0.5 : 0, ...more });
  const calls = () => r.log.splice(0).map((l) => l.replace(/ [-\d.]+,[-\d.]+ @/, ' @').replace(/ c-?\d+/, ''));
  return {
    r,
    calls,
    down: (id: number, x: number, y: number, type: 'touch' | 'pen' | 'mouse' = 'touch', more?: object) => r.fire('pointerdown', ptr(type, id, x, y, more)),
    move: (id: number, x: number, y: number, type: 'touch' | 'pen' | 'mouse' = 'touch', more?: object) => r.fire('pointermove', ptr(type, id, x, y, more)),
    up: (id: number, x: number, y: number, type: 'touch' | 'pen' | 'mouse' = 'touch') => r.fire('pointerup', ptr(type, id, x, y)),
    cancel: (id: number, x: number, y: number, type: 'touch' | 'pen' | 'mouse' = 'touch') => r.fire('pointercancel', ptr(type, id, x, y)),
    leave: (id: number, x: number, y: number, type: 'touch' | 'pen' | 'mouse' = 'touch') => r.fire('pointerleave', ptr(type, id, x, y)),
    wait: (ms: number) => vi.advanceTimersByTime(ms),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTouchUi();
  tool.value = 'land';
  picking.value = false;
  openPanel.value = null;
  toast.value = null;
  pinnedCell.value = -1;
  pinnedPart.value = null;
});
afterEach(() => {
  for (const r of rigs) r.input.dispose();
  rigs = [];
  vi.useRealTimers();
});

describe('一根手指用工具', () => {
  it('拖的工具：按下有预览，等一下开始画，移动接着画，抬起画完、预览去掉', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    // 按下：补一次“悬停”（工具的预览照常有），还没交给工具
    expect(t.calls()).toEqual(['move @400,300']);
    expect(t.r.view.pointer).not.toBeNull();
    expect(t.r.view.pressed).toBe(false);
    t.wait(TOOL_DELAY_MS);
    expect(t.calls()).toEqual(['down @400,300']);
    expect(t.r.view.pressed).toBe(true);
    await t.move(1, 420, 310);
    await t.move(1, 440, 320);
    expect(t.calls()).toEqual(['move* @420,310', 'move* @440,320']);
    await t.up(1, 440, 320);
    expect(t.calls()).toEqual(['up @440,320', 'leave']);
    expect(t.r.view.pressed).toBe(false);
    // 抬起以后不留一个停在最后位置的预览圈
    expect(t.r.view.pointer).toBeNull();
    // 拖滑块时还在最后停的地方预览
    expect(t.r.view.lastPointer?.sx).toBe(440);
    expect(touchUi()).toBe(true);
  });

  it('点一下（很快抬起）也是一笔：放岛、点一个点照常', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    await t.up(1, 400, 300);
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300', 'up @400,300', 'leave']);
    t.wait(1000);
    expect(t.calls()).toEqual([]);
  });

  it('点的工具：点一下是点击；拖开是平移，不点', async () => {
    const t = start(false);
    await t.down(1, 400, 300);
    await t.up(1, 403, 300);
    expect(t.calls()).toEqual(['move @400,300', 'click @403,300', 'leave']);
    const before = t.r.camera();
    await t.down(1, 400, 300);
    await t.move(1, 400 + TAP_SLOP_PX + 20, 300);
    await t.up(1, 400 + TAP_SLOP_PX + 20, 300);
    expect(t.calls()).toEqual(['move @400,300', 'leave']);
    expect(t.r.camera()).not.toBe(before);
    // 按下的那一点跟着手指：往右拖了 30 像素，镜头往左 30 / 1000
    expect(t.r.renderer.camera.x).toBeCloseTo(0.5 - (TAP_SLOP_PX + 20) / 1000, 9);
    expect(t.r.view.userMoved).toBe(true);
  });

  it('停在东西上才是拖的工具的（发源地）：按按下时那一下“悬停”之后的定', async () => {
    let hovered = false;
    const t = start(() => hovered);
    // 工具收到 move 以后才知道手指下有东西
    const tool0 = t.r.log;
    const orig = tool0.push.bind(tool0);
    tool0.push = (...items: string[]) => {
      if (items.some((s) => s.startsWith('move '))) hovered = true;
      return orig(...items);
    };
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300']);
  });

  it('屏幕上的开关（多选、汇入）开着时，每一下都带着 Shift / Alt', async () => {
    const t = start(false);
    setHeld('shift', true);
    await t.down(1, 400, 300);
    await t.up(1, 400, 300);
    expect(t.calls()).toEqual(['move @400,300 shift', 'click @400,300 shift', 'leave']);
    setHeld('shift', false);
    setHeld('alt', true);
    // 鼠标也一样（开关是界面上的状态）；当前工具能吸取时 Alt 是吸取，换一个不能吸取的
    tool.value = 'pselect';
    await t.move(9, 100, 100, 'mouse');
    expect(t.calls()).toEqual(['move @100,100 alt']);
  });
});

describe('长按', () => {
  it('点的工具下按住不动：钉住这里，不点', async () => {
    const t = start(false);
    await t.down(1, 400, 300);
    t.wait(LONG_PRESS_MS - 1);
    expect(pinnedCell.value).toBe(-1);
    t.wait(1);
    expect(pinnedCell.value).toBeGreaterThanOrEqual(0);
    expect(pinnedCell.value).toBe(t.r.input.pointerAt(400, 300, false, false).shown?.focus?.cell ?? pinnedCell.value);
    await t.move(1, 500, 300);
    await t.up(1, 500, 300);
    expect(t.calls()).toEqual(['move @400,300', 'leave']);
    expect(t.r.renderer.camera.x).toBe(0.5);
  });

  it('画笔下按住不动是预览，不钉住', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(LONG_PRESS_MS * 2);
    expect(pinnedCell.value).toBe(-1);
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300']);
    await t.up(1, 400, 300);
  });
});

describe('两根手指平移和捏合', () => {
  it('捏合：镜头变了，两指中点下面的那一点还在中点下面；工具一下都没碰', async () => {
    const t = start(true);
    const mid = () => t.r.renderer.screenToWorld(400, 300);
    const before = mid();
    await t.down(1, 350, 300);
    await t.down(2, 450, 300);
    // 第二根在等的时候落下：只补过一次悬停、去掉了
    expect(t.calls()).toEqual(['move @350,300', 'leave']);
    await t.move(1, 300, 300);
    await t.move(2, 500, 300);
    expect(t.r.renderer.camera.zoom).toBeCloseTo(2000, 6);
    expect(mid()[0]).toBeCloseTo(before[0], 9);
    expect(mid()[1]).toBeCloseTo(before[1], 9);
    await t.up(1, 300, 300);
    await t.up(2, 500, 300);
    expect(t.calls()).toEqual([]);
    expect(t.r.view.pressed).toBe(false);
    expect(t.r.view.userMoved).toBe(true);
  });

  it('平移：两指一起挪，中点下面的那一点跟着走', async () => {
    const t = start(true);
    const under = t.r.renderer.screenToWorld(400, 300);
    await t.down(1, 350, 300);
    await t.down(2, 450, 300);
    await t.move(1, 410, 340);
    await t.move(2, 510, 340);
    const now = t.r.renderer.screenToWorld(460, 340);
    expect(now[0]).toBeCloseTo(under[0], 9);
    expect(now[1]).toBeCloseTo(under[1], 9);
    expect(t.r.renderer.camera.zoom).toBeCloseTo(1000, 6);
  });

  it('同时平移和捏合', async () => {
    const t = start(false);
    const under = t.r.renderer.screenToWorld(400, 300);
    await t.down(1, 350, 300);
    await t.down(2, 450, 300);
    // 一根不动、一根拉远：中点挪了、距离变了
    await t.move(2, 550, 380);
    const midNow = t.r.renderer.screenToWorld(450, 340);
    expect(midNow[0]).toBeCloseTo(under[0], 9);
    expect(midNow[1]).toBeCloseTo(under[1], 9);
    expect(t.r.renderer.camera.zoom).toBeCloseTo(1000 * (Math.hypot(200, 80) / 100), 6);
    await t.up(1, 350, 300);
    await t.up(2, 550, 380);
    expect(t.calls()).toEqual(['move @350,300', 'leave']);
  });

  it('整个星球的球形投影：手指下的那一点跟着手指', async () => {
    const cam: ProjCamera = { x: 1, y: 0.5, zoom: 500, proj: { kind: 'globe', lon0: 0.3, lat0: 0.2 } };
    const t = start(true, cam, globe.world);
    // 镜头先按球形的规矩摆好（转一下再转回来）
    await t.down(1, 380, 300);
    await t.down(2, 420, 300);
    await t.move(1, 381, 300);
    await t.move(2, 421, 300);
    await t.up(1, 381, 300);
    await t.up(2, 421, 300);
    const c = t.r.renderer.camera;
    const sx = 400;
    const sy = 280;
    expect(t.r.renderer.onProjection(sx, sy)).toBe(true);
    const under = t.r.renderer.screenToWorld(sx, sy);
    await t.down(1, sx - 40, sy);
    await t.down(2, sx + 40, sy);
    // 平移 + 放大
    await t.move(1, sx - 60 + 30, sy + 20);
    await t.move(2, sx + 60 + 30, sy + 20);
    const now = t.r.renderer.screenToWorld(sx + 30, sy + 20);
    expect(now[0]).toBeCloseTo(under[0], 5);
    expect(now[1]).toBeCloseTo(under[1], 5);
    expect(c.zoom).toBeCloseTo(500 * 1.5, 3);
    expect(c.proj?.kind).toBe('globe');
    await t.up(1, 0, 0);
    await t.up(2, 0, 0);
    expect(t.calls().filter((l) => !l.startsWith('move @') && l !== 'leave')).toEqual([]);
  });
});

describe('画到一半第二根手指落下', () => {
  it('这一笔不算（取消，不松手），改成平移缩放；全部手指抬起以后才回到工具', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    await t.move(1, 430, 300);
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300', 'move* @430,300']);
    await t.down(2, 530, 300);
    expect(t.calls()).toEqual(['cancel', 'leave']);
    expect(t.r.view.pressed).toBe(false);
    expect(t.r.view.pointer).toBeNull();
    await t.move(2, 630, 300);
    expect(t.r.renderer.camera.zoom).toBeCloseTo(2000, 6);
    await t.up(2, 630, 300);
    // 剩下的那根接着动：不画
    await t.move(1, 300, 200);
    await t.up(1, 300, 200);
    expect(t.calls()).toEqual([]);
    // 都抬起了：下一根又是工具
    await t.down(3, 200, 200);
    await t.up(3, 200, 200);
    expect(t.calls()).toEqual(['move @200,200', 'down @200,200', 'up @200,200', 'leave']);
  });
});

describe('pointercancel', () => {
  it('画着被系统拿走：取消，不卡在按着；之后还能接着画', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    await t.move(1, 430, 300);
    t.calls();
    await t.cancel(1, 430, 300);
    expect(t.calls()).toEqual(['cancel', 'leave']);
    expect(t.r.view.pressed).toBe(false);
    await t.down(2, 100, 100);
    t.wait(TOOL_DELAY_MS);
    await t.up(2, 110, 100);
    expect(t.calls()).toEqual(['move @100,100', 'down @100,100', 'up @110,100', 'leave']);
  });

  it('鼠标的 pointercancel 也是取消', async () => {
    const t = start(true);
    await t.move(9, 400, 300, 'mouse');
    await t.down(9, 400, 300, 'mouse');
    expect(t.r.view.pressed).toBe(true);
    await t.cancel(9, 400, 300, 'mouse');
    expect(t.r.view.pressed).toBe(false);
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300', 'cancel']);
  });

  it('手指抬起后浏览器发的“离开”、别的手指的“离开”不打断正画着的一笔', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    t.calls();
    await t.leave(5, 10, 10);
    await t.leave(1, 400, 300);
    expect(t.calls()).toEqual([]);
    expect(t.r.view.pointer).not.toBeNull();
    await t.up(1, 400, 300);
    expect(t.calls()).toEqual(['up @400,300', 'leave']);
  });
});

describe('笔', () => {
  it('笔落下马上是工具；悬停和鼠标的移动一样；用过笔记下来', async () => {
    const t = start(true);
    expect(penSeen()).toBe(false);
    // 悬停（没落着）
    await t.move(7, 390, 300, 'pen');
    expect(t.calls()).toEqual(['move @390,300']);
    await t.down(7, 400, 300, 'pen');
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300']);
    expect(penSeen()).toBe(true);
    await t.move(7, 410, 300, 'pen');
    await t.up(7, 410, 300, 'pen');
    expect(t.calls()).toEqual(['move* @410,300', 'up @410,300', 'leave']);
    // 抬起后接着悬停：预览回来
    await t.move(7, 415, 300, 'pen');
    expect(t.r.view.pointer?.sx).toBe(415);
    // 笔离开感应范围
    await t.leave(7, 415, 300, 'pen');
    expect(t.r.view.pointer).toBeNull();
  });

  it('笔落着时的手指（手掌）不算；笔的那一笔照常', async () => {
    const t = start(true);
    await t.down(7, 400, 300, 'pen');
    await t.down(1, 600, 500);
    await t.move(1, 610, 500);
    await t.move(7, 420, 300, 'pen');
    await t.up(1, 610, 500);
    await t.up(7, 420, 300, 'pen');
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300', 'move* @420,300', 'up @420,300', 'leave']);
  });

  it('“手指只移动地图”：手指不画，拖是平移；笔照常画；点的工具手指照常点', async () => {
    resetTouchUi({ pen: true });
    setFingerPans(true);
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS * 2);
    await t.move(1, 450, 300);
    await t.up(1, 450, 300);
    // 只问了一次它是不是拖的工具（move、leave），没有 down / up
    expect(t.calls()).toEqual(['move @400,300', 'leave']);
    expect(t.r.renderer.camera.x).toBeCloseTo(0.5 - 50 / 1000, 9);
    await t.down(7, 400, 300, 'pen');
    await t.up(7, 400, 300, 'pen');
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300', 'up @400,300', 'leave']);
    const c = start(false);
    vi.advanceTimersByTime(1000);
    await c.down(1, 400, 300);
    await c.up(1, 400, 300);
    expect(c.calls()).toEqual(['move @400,300', 'click @400,300', 'leave']);
  });

  it('没用过笔时“手指只移动地图”不起作用（不会被它困住）', async () => {
    setFingerPans(true);
    const t = start(true);
    await t.down(1, 400, 300);
    await t.up(1, 400, 300);
    expect(t.calls()).toEqual(['move @400,300', 'down @400,300', 'up @400,300', 'leave']);
  });

  it('笔的压力：开了偏好才带给工具；鼠标、手指从来没有', async () => {
    const seen: (number | undefined)[] = [];
    world.value = region.world;
    const r = makeRig(region.world, () => ({ drags: true, down: (p) => void seen.push(p.pressure), move: (p, pressed) => void (pressed && seen.push(p.pressure)), up: () => {}, preview: () => ({ layers: [], shapes: [], hint: null }) }), { x: 0.5, y: 0.3, zoom: 1000 });
    rigs.push(r);
    const ev = (type: string, id: number, x: number, pressure: number) => ({ pointerType: type, pointerId: id, clientX: x, clientY: 300, shiftKey: false, altKey: false, button: 0, pressure });
    await r.fire('pointerdown', ev('pen', 7, 400, 0.3));
    await r.fire('pointermove', ev('pen', 7, 410, 0.9));
    await r.fire('pointerup', ev('pen', 7, 410, 0));
    expect(seen).toEqual([undefined, undefined]);
    seen.length = 0;
    setPenPressure(true);
    await r.fire('pointerdown', ev('pen', 7, 400, 0.3));
    await r.fire('pointermove', ev('pen', 7, 410, 0.9));
    await r.fire('pointerup', ev('pen', 7, 410, 0));
    expect(seen).toEqual([0.3, 0.9]);
    seen.length = 0;
    vi.advanceTimersByTime(1000);
    await r.fire('pointerdown', ev('touch', 1, 400, 0.7));
    vi.advanceTimersByTime(TOOL_DELAY_MS);
    await r.fire('pointermove', ev('touch', 1, 420, 0.7));
    await r.fire('pointerup', ev('touch', 1, 420, 0));
    await r.fire('pointerdown', ev('mouse', 9, 400, 0.5));
    await r.fire('pointermove', ev('mouse', 9, 420, 0.5));
    await r.fire('pointerup', ev('mouse', 9, 420, 0));
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('和鼠标、面板、吸管、Esc', () => {
  it('手指的手势没完时鼠标不算；鼠标按着时手指不算', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    t.calls();
    await t.move(9, 100, 100, 'mouse');
    await t.down(9, 100, 100, 'mouse');
    await t.up(9, 100, 100, 'mouse');
    expect(t.calls()).toEqual([]);
    await t.up(1, 400, 300);
    t.calls();
    await t.move(9, 100, 100, 'mouse');
    await t.down(9, 100, 100, 'mouse');
    await t.down(1, 400, 300);
    await t.move(1, 450, 300);
    await t.up(1, 450, 300);
    await t.up(9, 100, 100, 'mouse');
    expect(t.calls()).toEqual(['move @100,100', 'down @100,100', 'up @100,100']);
  });

  it('有弹出面板时点地图只把面板关上', async () => {
    const t = start(true);
    openPanel.value = 'layers';
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    await t.up(1, 400, 300);
    expect(openPanel.value).toBeNull();
    expect(t.calls()).toEqual([]);
  });

  it('吸管开着：手指点一下是吸取，不画', async () => {
    const t = start(true);
    tool.value = 'biome';
    picking.value = true;
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    await t.up(1, 400, 300);
    expect(picking.value).toBe(false);
    expect((toast.value as { text: string } | null)?.text ?? '').toMatch(/吸取/);
    expect(t.calls().filter((l) => l.startsWith('down') || l.startsWith('up') || l.startsWith('click'))).toEqual([]);
  });

  it('Esc（外接键盘）取消手指正画着的一笔；手指到抬起为止不再算', async () => {
    const t = start(true);
    await t.down(1, 400, 300);
    t.wait(TOOL_DELAY_MS);
    t.calls();
    expect(t.r.input.cancel()).toBe(true);
    expect(t.calls()).toEqual(['cancel', 'leave']);
    expect(t.r.view.pressed).toBe(false);
    await t.move(1, 450, 300);
    await t.up(1, 450, 300);
    expect(t.calls()).toEqual([]);
    expect(t.r.input.cancel()).toBe(false);
  });
});
