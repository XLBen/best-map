import type { World } from '../../../core/world';
import { openPanel, pinCell, world } from '../../state';
import { type Pointer, type ToolHandler, pinTarget } from '../tools';
import { fingerOnMap, fingerPans, noteTouch, penPressure } from '../touch-ui';
import { type TouchAct, type TouchEv, TouchGestures, type TouchRole } from './touch';

// 触摸与笔接到地图上（第一百轮）：手势怎么判定在 touch.ts（纯的状态机），这里只把它说要做的事（TouchAct）
// 接到工具、镜头上——用的都是 map/input.ts 里鼠标那一条路已有的做法（startPan、zoomAt、离开、吸取），由它递进来

export interface TouchHost {
  // 鼠标在哪里、按没按着（和鼠标共用）
  view: { pointer: Pointer | null; lastPointer: Pointer | null; pressed: boolean };
  active(): ToolHandler;
  // 屏幕上的一点在地图上的哪里
  pointerAt(sx: number, sy: number, shift: boolean, alt: boolean): Pointer;
  // 悬停的那一套：鼠标下的格、鼠标下的地名
  hover(p: Pointer): void;
  // 和鼠标离开地图一样：预览、鼠标旁的话都去掉
  leave(): void;
  requestDraw(): void;
  // 平移：从这一点起、让它跟着走到这里、收尾
  startPan(sx: number, sy: number): void;
  panTo(sx: number, sy: number): void;
  endPan(): void;
  zoomAt(sx: number, sy: number, f: number): void;
  // 这一下是不是吸取（底部条上的吸管开着、Alt）；吸取
  wantsPick(alt: boolean): boolean;
  pick(w: World, p: Pointer): void;
  // 鼠标正按着（它的手势没完）：手指先不算
  mouseHeld(): boolean;
  now(): number;
  setTimer(f: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

// PointerEvent 里用到的几样（测试里是手造的对象）
export interface TouchPointerEvent {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  pressure?: number;
}

export interface TouchWire {
  // 手指 / 笔的四种事件。rect：画布在页面上的位置
  down(e: TouchPointerEvent, rect: { left: number; top: number }): void;
  move(e: TouchPointerEvent, rect: { left: number; top: number }): void;
  up(e: TouchPointerEvent, rect: { left: number; top: number }): void;
  cancel(e: TouchPointerEvent, rect: { left: number; top: number }): void;
  // 这个指针是不是手势里记着的（没记着的笔的移动是悬停）
  tracks(id: number): boolean;
  // 有手势正在进行
  readonly busy: boolean;
  // Esc：正做着的不算；真的取消了什么返回 true
  abort(): boolean;
  dispose(): void;
}

export function touchWire(host: TouchHost): TouchWire {
  const sm = new TouchGestures();
  const { view } = host;
  // 这次手势里最后一个事件带的 Shift、Alt（外接键盘；屏幕上的开关由 pointerAt 那边加上）：到点了的那一下（长按、等够了开始画）沿用
  let shift = false;
  let alt = false;
  // 笔的这一下的压力要不要带给工具
  const at = (x: number, y: number, pressure?: number): Pointer => {
    const p = host.pointerAt(x, y, shift, alt);
    if (pressure !== undefined && penPressure()) p.pressure = pressure;
    return p;
  };
  // 等工具做完再画一次（和鼠标松手一样：松手时先画，结果到了再画）
  const after = (done: Promise<void> | void) => {
    host.requestDraw();
    if (done) void Promise.resolve(done).then(host.requestDraw, host.requestDraw);
  };
  // 这一下是吸取（吸管开着）：手指点一下是吸取，不交给工具
  let picking = false;

  function run(acts: TouchAct[]) {
    const w = world.value;
    for (const a of acts) {
      switch (a.do) {
        case 'hover': {
          const p = at(a.x, a.y);
          view.pointer = p;
          view.lastPointer = p;
          host.hover(p);
          host.active().move?.(p, false);
          host.requestDraw();
          break;
        }
        case 'leave':
          if (fingerOnMap.peek()) fingerOnMap.value = false;
          host.leave();
          break;
        case 'draw-start': {
          const p = at(a.x, a.y, a.pressure);
          view.pointer = p;
          view.lastPointer = p;
          view.pressed = true;
          host.active().down?.(p);
          host.requestDraw();
          break;
        }
        case 'draw-move': {
          const p = at(a.x, a.y, a.pressure);
          view.pointer = p;
          view.lastPointer = p;
          host.hover(p);
          host.active().move?.(p, true);
          host.requestDraw();
          break;
        }
        case 'draw-end': {
          view.pressed = false;
          after(host.active().up?.(at(a.x, a.y)));
          break;
        }
        case 'draw-cancel':
          host.active().cancel?.();
          view.pressed = false;
          host.requestDraw();
          break;
        case 'tap': {
          const p = at(a.x, a.y);
          if (picking && w) host.pick(w, p);
          else after(host.active().click?.(p));
          break;
        }
        case 'pin': {
          if (!w) break;
          const t = pinTarget(w, at(a.x, a.y));
          pinCell(t.cell, t.part);
          host.requestDraw();
          break;
        }
        case 'pan-start':
        case 'pinch-start':
          host.startPan(a.x, a.y);
          break;
        case 'pan-move':
          host.panTo(a.x, a.y);
          break;
        case 'pinch-move':
          // 先让两指的中点下面那一点跟着中点走，再在中点处缩放（那一点不动），然后从这里重新记起点
          host.panTo(a.x, a.y);
          if (a.scale !== 1) host.zoomAt(a.x, a.y, a.scale);
          host.startPan(a.x, a.y);
          break;
        case 'pan-end':
        case 'pinch-end':
          host.endPan();
          break;
      }
    }
    arm();
  }

  // 状态机要等到什么时候（等够了开始画、长按）：到点叫它一声
  let timer: unknown = null;
  function arm() {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
    const wake = sm.wake();
    if (wake === null) return;
    timer = host.setTimer(
      () => {
        timer = null;
        run(sm.tick(host.now()));
      },
      Math.max(1, wake - host.now()),
    );
  }

  const ev = (e: TouchPointerEvent, rect: { left: number; top: number }): TouchEv => ({ id: e.pointerId, pen: e.pointerType === 'pen', x: e.clientX - rect.left, y: e.clientY - rect.top, t: host.now(), pressure: e.pointerType === 'pen' ? e.pressure : undefined });
  const keys = (e: TouchPointerEvent) => {
    shift = e.shiftKey;
    alt = e.altKey;
  };

  return {
    down(e, rect) {
      noteTouch(e.pointerType);
      if (!world.value || (!sm.busy && host.mouseHeld())) return;
      // 有弹出面板时，点地图只把面板关上，不在地图上动手（和鼠标一样）
      if (openPanel.value && !sm.busy) {
        openPanel.value = null;
        return;
      }
      const t = ev(e, rect);
      // 这一根要当主角时才问：它拿来做什么。顺便把“悬停”补上——触摸没有悬停，工具的预览在手指按下时照常有；
      // 有的工具停在东西上才是拖的工具（发源地），也要先有这一下
      const role = (): TouchRole => {
        keys(e);
        const h = host.active();
        const p = at(t.x, t.y);
        picking = host.wantsPick(e.altKey);
        if (!picking) h.move?.(p, false);
        const drags = !picking && h.drags;
        // 手指只移动地图：拖的工具不听手指的（点的工具照常点）
        if (drags && !t.pen && fingerPans()) {
          h.leave?.();
          return 'none';
        }
        view.pointer = p;
        view.lastPointer = p;
        host.hover(p);
        host.requestDraw();
        // 工具的那句话（“堆山 约 +600 m”）写在手指上面，不被手指挡着（App.tsx 的 CursorHint）
        if (!t.pen) fingerOnMap.value = true;
        return drags ? 'drag' : 'click';
      };
      run(sm.down(t, role));
    },
    move(e, rect) {
      if (!sm.tracks(e.pointerId)) return;
      keys(e);
      run(sm.move(ev(e, rect)));
    },
    up(e, rect) {
      if (!sm.tracks(e.pointerId)) return;
      keys(e);
      run(sm.up(ev(e, rect)));
    },
    cancel(e, rect) {
      if (!sm.tracks(e.pointerId)) return;
      run(sm.cancel(ev(e, rect)));
    },
    tracks: (id) => sm.tracks(id),
    get busy() {
      return sm.busy;
    },
    abort() {
      const acts = sm.abort();
      run(acts);
      return acts.some((a) => a.do !== 'leave');
    },
    dispose() {
      if (timer !== null) host.clearTimer(timer);
      timer = null;
    },
  };
}
