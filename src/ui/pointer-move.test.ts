import { describe, expect, it } from 'vitest';
import { displayCellAt } from '../../core/display';
import { findCell } from '../../core/mesh';
import { continents } from '../../core/testing/fixtures';
import type { Renderer } from '../render/renderer';
import { world } from '../state';
import { mapInput } from './map/input';
import type { ToolHandler } from './tools';
import { pointerTool } from './tools/pointer';
import { countrySelectTool } from './tools/countries';

// 第四十轮：鼠标在同一格里移动、工具的预览没变时不重画（map/input.ts 按 ToolHandler.moveKey 比），只挪鼠标旁的那句话

// 没有浏览器：画布、窗口只收事件
(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
function fakeCanvas() {
  const on = new Map<string, (e: unknown) => void>();
  return {
    on,
    clientWidth: 800,
    clientHeight: 600,
    addEventListener: (k: string, f: (e: unknown) => void) => on.set(k, f),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
  };
}

describe('鼠标在同一格里移动不重画', () => {
  const eng = continents();
  world.value = eng.world;
  const w = eng.world;
  // 地图单位 → 屏幕：每单位 2000 像素
  const Z = 2000;
  const renderer = { camera: { x: 0, y: 0, zoom: Z }, screenToWorld: (sx: number, sy: number) => [sx / Z, sy / Z], onProjection: () => true, polarPick: () => false } as unknown as Renderer;
  // 一个陆地格的格心附近（画出来的仍是这一格）
  const c = (() => {
    for (let i = 0; i < w.mesh.n; i++) {
      if (!w.causes.land[i]) continue;
      const near = [0, 0.04, -0.04].every((d) => {
        const x = w.mesh.x[i] + d * w.mesh.spacing;
        const y = w.mesh.y[i] - d * w.mesh.spacing;
        const cell = findCell(w.mesh, x, y);
        return cell === i && displayCellAt(w, x, y, cell).here === i;
      });
      if (near) return i;
    }
    throw new Error('没有格');
  })();
  const at = (d: number, cell = c) => ({ clientX: (w.mesh.x[cell] + d * w.mesh.spacing) * Z, clientY: (w.mesh.y[cell] - d * w.mesh.spacing) * Z, shiftKey: false, altKey: false });
  const other = w.mesh.adj[w.mesh.off[c]];

  function run(tool: ToolHandler) {
    const ov = fakeCanvas();
    let draws = 0;
    const hints: { x: number; y: number }[] = [];
    mapInput(
      { pointer: null, lastPointer: null, pressed: false, hoverLabel: null, userMoved: false },
      {
        renderer: () => renderer,
        glCanvas: fakeCanvas() as unknown as HTMLCanvasElement,
        ovCanvas: ov as unknown as HTMLCanvasElement,
        active: () => tool,
        requestDraw: () => draws++,
        hitLabel: () => null,
        hintAt: (p) => hints.push({ x: p.sx, y: p.sy }),
      },
    );
    const move = (e: object) => ov.on.get('pointermove')!(e);
    return { move, leave: () => ov.on.get('pointerleave')!({}), draws: () => draws, hints };
  }

  it('指针：同一格里动不重画（鼠标旁的话跟着挪）；换一格、离开再回来都重画', () => {
    const t = run(pointerTool(() => Z));
    t.move(at(0));
    expect(t.draws()).toBe(1);
    t.move(at(0.04));
    t.move(at(-0.04));
    expect(t.draws()).toBe(1);
    expect(t.hints.length).toBe(2);
    expect(t.hints[1].x).toBeCloseTo((w.mesh.x[c] - 0.04 * w.mesh.spacing) * Z);
    t.move(at(0, other));
    expect(t.draws()).toBe(2);
    t.leave();
    expect(t.draws()).toBe(3);
    t.move(at(0, other));
    expect(t.draws()).toBe(4);
  });

  it('选国家：同一格里动不重画', () => {
    const t = run(countrySelectTool(() => Z));
    t.move(at(0));
    t.move(at(0.04));
    t.move(at(-0.04));
    expect(t.draws()).toBe(1);
    t.move(at(0, other));
    expect(t.draws()).toBe(2);
  });

  it('没有 moveKey 的工具（画笔圈跟着鼠标）照旧每次重画', () => {
    const t = run({ drags: true, preview: () => ({ layers: [], shapes: [], hint: null }) });
    t.move(at(0));
    t.move(at(0.04));
    t.move(at(-0.04));
    expect(t.draws()).toBe(3);
  });
});
