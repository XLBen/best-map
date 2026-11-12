import type { World } from '../../../core/world';
import { type ProjCamera, screenToWorld as projScreenToWorld } from '../../render/projection';
import type { Renderer } from '../../render/renderer';
import type { Pointer, Preview, ToolHandler } from '../tools';
import { type MapInput, type PointerState, mapInput } from './input';

// 测试用（第一百轮）：没有浏览器时把 map/input.ts 接在假的画布、假的渲染器上，事件由测试自己发，
// 记下调到工具上的每一下。input-mouse.test.ts（鼠标的一串事件，录在改之前）和 input-touch.test.ts 共用。
// 应用里不引用这个文件

type Listener = (e: unknown) => unknown;

// 假的窗口：只收事件（键盘的空格）。别的测试文件可能已经放了一个不记事件的，这里换成记的
const winListeners = new Map<string, Listener[]>();
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (k: string, f: Listener) => winListeners.set(k, [...(winListeners.get(k) ?? []), f]),
  removeEventListener: (k: string, f: Listener) => winListeners.set(k, (winListeners.get(k) ?? []).filter((x) => x !== f)),
};

export interface FakeCanvas {
  on: Map<string, Listener>;
  clientWidth: number;
  clientHeight: number;
  captured: number[];
  addEventListener(k: string, f: Listener): void;
  getBoundingClientRect(): { left: number; top: number };
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
}

export function fakeCanvas(width = 800, height = 600): FakeCanvas {
  const on = new Map<string, Listener>();
  const captured: number[] = [];
  return {
    on,
    clientWidth: width,
    clientHeight: height,
    captured,
    addEventListener: (k, f) => on.set(k, f),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (id) => void captured.push(id),
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  };
}

// 假的渲染器：镜头和屏幕 → 地图的换算与真的同一套式子（render/renderer.ts 的 screenToWorld / onProjection）
export function fakeRenderer(w: World, canvas: { clientWidth: number; clientHeight: number }, camera: ProjCamera): Renderer {
  const planet = w.mesh.kind === 'sphere';
  const r = {
    camera,
    screenToWorld(px: number, py: number): [number, number] {
      const c = r.camera;
      if (planet && c.proj) {
        const p = projScreenToWorld(c, canvas.clientWidth, canvas.clientHeight, px, py);
        return [p.x, p.y];
      }
      return [c.x + (px - canvas.clientWidth / 2) / c.zoom, c.y + (py - canvas.clientHeight / 2) / c.zoom];
    },
    onProjection(px: number, py: number): boolean {
      const c = r.camera;
      return !(planet && c.proj) || projScreenToWorld(c, canvas.clientWidth, canvas.clientHeight, px, py).inside;
    },
    polarPick: () => false,
  };
  return r as unknown as Renderer;
}

const num = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(9)) : String(v));
export const pointText = (p: Pointer) => `${num(p.x)},${num(p.y)} @${num(p.sx)},${num(p.sy)} c${p.cell}${p.shift ? ' shift' : ''}${p.alt ? ' alt' : ''}`;

const NONE: Preview = { layers: [], shapes: [], hint: null };

// 只记不做的工具：调到它上面的每一下写进 log。drags 可以是函数（像发源地：停在东西上才是拖的工具）
export function recorderTool(log: string[], drags: boolean | (() => boolean), opts: { moveKey?: boolean } = {}): ToolHandler {
  const t: ToolHandler = {
    get drags() {
      return typeof drags === 'function' ? drags() : drags;
    },
    down: (p) => void log.push(`down ${pointText(p)}`),
    move: (p, pressed) => void log.push(`move${pressed ? '*' : ''} ${pointText(p)}`),
    up: (p) => void log.push(`up ${pointText(p)}`),
    click: (p) => void log.push(`click ${pointText(p)}`),
    cancel: () => void log.push('cancel'),
    leave: () => void log.push('leave'),
    preview: () => NONE,
  };
  if (opts.moveKey) t.moveKey = (p) => [p.cell];
  return t;
}

export interface Rig {
  ov: FakeCanvas;
  gl: FakeCanvas;
  view: PointerState;
  input: MapInput;
  renderer: Renderer;
  log: string[];
  draws: () => number;
  // 发一个事件到叠加层的画布上（pointerdown、pointermove、pointerup、pointercancel、pointerleave、wheel……）；等它做完
  fire(type: string, e: object): Promise<void>;
  key(type: 'keydown' | 'keyup', code: string): void;
  camera(): string;
}

export function makeRig(w: World, tool: (log: string[]) => ToolHandler, camera: ProjCamera, size: [number, number] = [800, 600]): Rig {
  const ov = fakeCanvas(...size);
  const gl = fakeCanvas(...size);
  const renderer = fakeRenderer(w, gl, camera);
  const log: string[] = [];
  const handler = tool(log);
  const view: PointerState = { pointer: null, lastPointer: null, pressed: false, hoverLabel: null, userMoved: false };
  let draws = 0;
  const input = mapInput(view, {
    renderer: () => renderer,
    glCanvas: gl as unknown as HTMLCanvasElement,
    ovCanvas: ov as unknown as HTMLCanvasElement,
    active: () => handler,
    requestDraw: () => void draws++,
    hitLabel: () => null,
    hintAt: (p) => void log.push(`hint @${num(p.sx)},${num(p.sy)}`),
  });
  return {
    ov,
    gl,
    view,
    input,
    renderer,
    log,
    draws: () => draws,
    async fire(type, e) {
      await ov.on.get(type)?.({ preventDefault() {}, ...e });
    },
    key(type, code) {
      for (const f of winListeners.get(type) ?? []) f({ type, code, target: { tagName: 'BODY' }, preventDefault() {} });
    },
    camera() {
      const c = renderer.camera;
      return `${num(c.x)},${num(c.y)} z${num(c.zoom)}${c.proj ? ` ${c.proj.kind} ${num(c.proj.lon0)},${num(c.proj.lat0)}` : ''}`;
    },
  };
}
