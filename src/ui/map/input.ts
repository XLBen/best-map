import { batch } from '@preact/signals';
import { displayCellAt } from '../../../core/display';
import { findCell } from '../../../core/mesh';
import { nearestCell } from '../../../core/sphere';
import { EE_HALF_W, GLOBE_G, type Proj, rotateToAnchor, screenToPlane } from '../../render/projection';
import type { Renderer } from '../../render/renderer';
import { cursorHint, hoverCell, hoverProvinceCell, measure, openPanel, prefs, showToast, tool, world } from '../../state';
import { clampPlanetCamera, maxZoom, minZoom, shapeFitsWidth } from '../camera';
import { CATEGORY_DEFS, TOOL_DEFS, category } from '../defs/tools';
import { type Pointer, type ToolHandler, provinceCellAt } from '../tools';

// 地图上的指针：拖着平移、滚轮与触控板缩放平移、Safari 的捏合、空格键拖地图；其余的按下、移动、松手、单击交给当前工具。
// 鼠标在哪里（pointer、lastPointer）、按没按着（pressed）与地图视图共用（view）

// 地图视图与指针共用的状态
export interface PointerState {
  pointer: Pointer | null;
  // 鼠标最后停在地图上的位置：拖左侧滑块时在这里显示预览
  lastPointer: Pointer | null;
  pressed: boolean;
  // 鼠标下的地名（地名类工具开着时）
  hoverLabel: string | null;
  // 用户还没手动平移缩放时，画布尺寸变了就重新适配整张图
  userMoved: boolean;
}

export interface MapInput {
  // 屏幕上的一点（CSS 像素，相对画布）在地图上的哪里
  pointerAt(sx: number, sy: number, shift: boolean, alt: boolean): Pointer;
  // 鼠标下的格：“这里”说的那一格，省份那一行按画出来的省
  setHover(p: Pointer): void;
  // 镜头动了而鼠标没动：按鼠标在屏幕上的位置重新算它指着地图的哪里
  refreshPointer(): void;
  zoomAt(sx: number, sy: number, f: number): void;
  // Esc：取消正在画的一笔、正在拖的平移（没有时 false）
  cancel(): boolean;
  dispose(): void;
}

// 鼠标滚轮还是触控板：触控板的滚动有横向分量、数值细碎；鼠标滚轮一格是固定的大步
// （Chrome / Safari 在 Mac 上是 4.000244140625 的倍数，Windows 上 wheelDelta 是 120 的倍数）
function looksLikeTrackpad(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return false;
  if (e.deltaX !== 0) return true;
  const y = Math.abs(e.deltaY);
  if (y > 0 && Math.abs(y / 4.000244140625 - Math.round(y / 4.000244140625)) < 1e-6) return false;
  const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof wd === 'number' && wd !== 0 && wd % 120 === 0) return false;
  return true;
}

export function mapInput(
  view: PointerState,
  o: { renderer: () => Renderer; glCanvas: HTMLCanvasElement; ovCanvas: HTMLCanvasElement; active: () => ToolHandler; requestDraw: () => void; hitLabel: (sx: number, sy: number) => string | null },
): MapInput {
  const { glCanvas, ovCanvas, active, requestDraw } = o;
  // 拖着平移：按下的位置、那时的镜头；投影时另记那时的朝向，球形还记按下的那一点（拖着转时它跟着鼠标）
  let panning: { x: number; y: number; cx: number; cy: number; proj?: Proj; anchor?: [number, number] | null } | null = null;
  let clickStart: { sx: number; sy: number } | null = null;
  let spaceDown = false;

  // 屏幕上的一点（CSS 像素，相对画布）在地图上的哪里；shown：那里画的是哪一格（悬停卡片、吸取、选省按它）
  const pointerAt = (sx: number, sy: number, shift: boolean, alt: boolean): Pointer => {
    const renderer = o.renderer();
    const [x, y] = renderer.screenToWorld(sx, sy);
    const w = world.value;
    // 整个星球东西相接：只看南北（等面积、球形投影另看在不在投影之内）
    const inside = !!w && (w.mesh.kind === 'sphere' ? y >= 0 && y <= 1 && renderer.onProjection(sx, sy) : x >= 0 && y >= 0 && x <= w.mesh.width && y <= w.mesh.height);
    // 球形看着极地时画的是球面上的 Voronoi：按球面上真正最近的格取（与画出来的一致）
    const cell = !inside ? -1 : w!.mesh.kind === 'sphere' && renderer.polarPick() ? nearestCell(w!.mesh, x, y) : findCell(w!.mesh, x, y);
    return { x, y, sx, sy, cell, shift, alt, shown: cell >= 0 ? displayCellAt(w!, x, y, cell) : undefined };
  };
  // 悬停卡片“这里”说的那一格：屏幕上这一点画成的陆地或海
  const hereOf = (p: Pointer) => p.shown?.here ?? p.cell;
  // 鼠标下的格：“这里”说的那一格，省份那一行按画出来的省（切线旁按显示的那一边）
  function setHover(p: Pointer) {
    const here = p.shown?.here ?? p.cell;
    const prov = p.shown?.province ?? p.cell;
    if (hoverCell.peek() === here && hoverProvinceCell.peek() === prov) return;
    batch(() => {
      hoverProvinceCell.value = prov;
      hoverCell.value = here;
    });
  }
  const pointerOf = (e: PointerEvent | MouseEvent): Pointer => {
    const r = ovCanvas.getBoundingClientRect();
    return pointerAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey, e.altKey);
  };

  // 镜头动了而鼠标没动（触控板平移、+ / − 缩放、捏合、看全图、换了世界、窗口变了大小）：按鼠标在屏幕上的位置
  // 重新算它指着地图的哪里，画笔圈、悬停的格跟着手。拖着平移时鼠标下始终是同一点，不必算
  function refreshPointer() {
    if (!view.pointer || panning) return;
    const p = pointerAt(view.pointer.sx, view.pointer.sy, view.pointer.shift, view.pointer.alt);
    view.pointer = p;
    view.lastPointer = p;
    setHover(p);
    active().move?.(p, view.pressed);
  }

  const startPan = (sx: number, sy: number) => {
    const renderer = o.renderer();
    const c = renderer.camera;
    const anchor = c.proj?.kind === 'globe' && renderer.onProjection(sx, sy) ? renderer.screenToWorld(sx, sy) : null;
    panning = { x: sx, y: sy, cx: c.x, cy: c.y, proj: c.proj, anchor };
    view.userMoved = true;
  };

  // 投影时的平移（dx、dy 是从 base 起屏幕上挪了多少 CSS 像素，正的是内容往右、往下）：
  // 球形转动（有按下的那一点时让它跟着鼠标 (sx, sy)）；等面积平移，整个椭圆东西放得下时左右是转动中央经线
  const panProjected = (base: { cx: number; cy: number; proj: Proj; anchor?: [number, number] | null }, dx: number, dy: number, sx: number, sy: number) => {
    const c = o.renderer().camera;
    const cw = glCanvas.clientWidth;
    const ch = glCanvas.clientHeight;
    if (base.proj.kind === 'globe') {
      if (base.anchor) {
        const [u, v] = screenToPlane(c, cw, ch, sx, sy);
        c.proj = rotateToAnchor(c.proj ?? base.proj, base.anchor[0], base.anchor[1], u, v);
      } else {
        const k = c.zoom * GLOBE_G;
        c.proj = { kind: 'globe', lon0: base.proj.lon0 - dx / k, lat0: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, base.proj.lat0 + dy / k)) };
      }
      return;
    }
    c.x = base.cx - dx / c.zoom;
    c.y = base.cy - dy / c.zoom;
    if (shapeFitsWidth(c, cw)) {
      const l = base.proj.lon0 - ((dx / c.zoom) * Math.PI) / EE_HALF_W;
      c.proj = { kind: 'equalEarth', lon0: l - 2 * Math.PI * Math.floor((l + Math.PI) / (2 * Math.PI)), lat0: 0 };
    }
  };

  const zoomAt = (sx: number, sy: number, f: number) => {
    const renderer = o.renderer();
    const c = renderer.camera;
    const w = world.value;
    const cw = glCanvas.clientWidth;
    const ch = glCanvas.clientHeight;
    // 投影时按投影平面算（球形另记鼠标下的那一点，缩放后转回到鼠标下）
    const proj = w?.mesh.kind === 'sphere' ? c.proj : undefined;
    const anchor = proj?.kind === 'globe' && renderer.onProjection(sx, sy) ? renderer.screenToWorld(sx, sy) : null;
    const [wx, wy] = proj ? screenToPlane(c, cw, ch, sx, sy) : renderer.screenToWorld(sx, sy);
    c.zoom = Math.max(w ? minZoom(w.mesh, cw, ch, proj) : 100, Math.min(w ? maxZoom(w.mesh, proj) : 60000, c.zoom * f));
    view.userMoved = true;
    if (proj?.kind === 'globe') {
      if (w) clampPlanetCamera(w.mesh, c, ch, false, cw);
      if (anchor) {
        const [u, v] = screenToPlane(c, cw, ch, sx, sy);
        c.proj = rotateToAnchor(c.proj!, anchor[0], anchor[1], u, v);
      }
    } else {
      const [nx, ny] = proj ? screenToPlane(c, cw, ch, sx, sy) : renderer.screenToWorld(sx, sy);
      c.x += wx - nx;
      c.y += wy - ny;
      if (w) clampPlanetCamera(w.mesh, c, ch, !view.pressed && !panning, cw);
    }
    refreshPointer();
    requestDraw();
  };

  const onDown = (e: PointerEvent) => {
    const w = world.value;
    if (!w) return;
    // 有弹出面板时，点地图只把面板关上，不在地图上动手
    if (openPanel.value && e.button === 0 && !spaceDown) {
      openPanel.value = null;
      return;
    }
    ovCanvas.setPointerCapture(e.pointerId);
    const p = pointerOf(e);
    view.pointer = p;
    view.lastPointer = p;
    if (e.button === 1 || e.button === 2 || spaceDown) {
      startPan(p.sx, p.sy);
      return;
    }
    if (e.button !== 0) return;
    // Alt+点：吸取（取这里的生态、这里的省份）
    const def = TOOL_DEFS[tool.value];
    if (e.altKey && def.pick && !measure.value) {
      // 吸取的是屏幕上这一点画的：省份按画出来的省（扭曲后的格、切线两边），生态按画成的陆地
      const cell = CATEGORY_DEFS[def.category].map?.provinces ? provinceCellAt(w, p) : hereOf(p);
      const got = cell >= 0 ? def.pick(w, cell) : null;
      showToast(got ? `吸取了“${got}”` : '这里没有可以吸取的', !got);
      requestDraw();
      return;
    }
    const h = active();
    if (h.drags) {
      view.pressed = true;
      h.down?.(p);
    } else clickStart = { sx: p.sx, sy: p.sy };
    requestDraw();
  };

  const onMove = (e: PointerEvent) => {
    const w = world.value;
    if (!w) return;
    const renderer = o.renderer();
    const p = pointerOf(e);
    view.pointer = p;
    view.lastPointer = p;
    if (panning) {
      if (w.mesh.kind === 'sphere' && panning.proj && renderer.camera.proj) panProjected({ ...panning, proj: panning.proj }, p.sx - panning.x, p.sy - panning.y, p.sx, p.sy);
      else {
        renderer.camera.x = panning.cx - (p.sx - panning.x) / renderer.camera.zoom;
        renderer.camera.y = panning.cy - (p.sy - panning.y) / renderer.camera.zoom;
      }
      clampPlanetCamera(w.mesh, renderer.camera, glCanvas.clientHeight, false, glCanvas.clientWidth);
      requestDraw();
      return;
    }
    // 单击类工具：按住拖动就是平移地图
    if (clickStart && Math.hypot(p.sx - clickStart.sx, p.sy - clickStart.sy) > 5) {
      startPan(clickStart.sx, clickStart.sy);
      clickStart = null;
      return;
    }
    setHover(p);
    if (CATEGORY_DEFS[category.value].map?.labels) view.hoverLabel = o.hitLabel(p.sx, p.sy);
    active().move?.(p, view.pressed);
    requestDraw();
  };

  const onUp = async (e: PointerEvent) => {
    if (!world.value) return;
    const p = pointerOf(e);
    if (panning) {
      panning = null;
      // 平移结束：整个星球的镜头绕回第一份（画面不变，但鼠标下的经度差了一整圈，画笔圈要跟着换到这一份上）
      clampPlanetCamera(world.value.mesh, o.renderer().camera, glCanvas.clientHeight, true, glCanvas.clientWidth);
      refreshPointer();
      requestDraw();
      return;
    }
    if (view.pressed) {
      view.pressed = false;
      const done = active().up?.(p);
      requestDraw();
      await done;
      requestDraw();
      return;
    }
    if (clickStart) {
      clickStart = null;
      const done = active().click?.(p);
      requestDraw();
      await done;
      requestDraw();
    }
  };

  // 滚轮：鼠标滚轮缩放；触控板双指滑动平移、捏合缩放（Chrome / Firefox 的捏合是 ctrl+滚轮）
  let gesture: { zoom: number; sx: number; sy: number } | null = null;
  let wheelKind: { trackpad: boolean; at: number } | null = null;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (gesture) return;
    const r = ovCanvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (e.ctrlKey) {
      zoomAt(sx, sy, Math.exp(-e.deltaY * 0.01));
      return;
    }
    // 一串连续的滚动只判断一次，免得中途忽而平移忽而缩放
    const now = performance.now();
    if (!wheelKind || now - wheelKind.at > 250) wheelKind = { trackpad: looksLikeTrackpad(e), at: now };
    wheelKind.at = now;
    const pref = prefs.value.wheel;
    const pan = pref === 'pan' || (pref === 'auto' && wheelKind.trackpad);
    if (pan) {
      const renderer = o.renderer();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? glCanvas.clientHeight : 1;
      const w = world.value;
      const c = renderer.camera;
      if (w?.mesh.kind === 'sphere' && c.proj) panProjected({ cx: c.x, cy: c.y, proj: c.proj }, -e.deltaX * unit, -e.deltaY * unit, sx, sy);
      else {
        renderer.camera.x += (e.deltaX * unit) / renderer.camera.zoom;
        renderer.camera.y += (e.deltaY * unit) / renderer.camera.zoom;
      }
      if (w) clampPlanetCamera(w.mesh, renderer.camera, glCanvas.clientHeight, !view.pressed, glCanvas.clientWidth);
      view.userMoved = true;
      refreshPointer();
      requestDraw();
    } else zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
  };
  // Safari 的触控板捏合
  type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    const g = e as GestureEvent;
    const r = ovCanvas.getBoundingClientRect();
    gesture = { zoom: o.renderer().camera.zoom, sx: g.clientX - r.left, sy: g.clientY - r.top };
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    if (!gesture) return;
    const target = gesture.zoom * (e as GestureEvent).scale;
    zoomAt(gesture.sx, gesture.sy, target / o.renderer().camera.zoom);
  };
  const onGestureEnd = (e: Event) => {
    e.preventDefault();
    gesture = null;
  };

  const typing = (e: KeyboardEvent) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
  const onKey = (e: KeyboardEvent) => {
    if (typing(e)) return;
    if (e.code === 'Space') {
      spaceDown = e.type === 'keydown';
      if (e.type === 'keydown') e.preventDefault();
    }
  };
  const onLeave = () => {
    view.pointer = null;
    active().leave?.();
    view.hoverLabel = null;
    cursorHint.value = null;
    requestDraw();
  };
  const noMenu = (e: Event) => e.preventDefault();

  ovCanvas.addEventListener('pointerdown', onDown);
  ovCanvas.addEventListener('pointermove', onMove);
  ovCanvas.addEventListener('pointerup', onUp);
  ovCanvas.addEventListener('wheel', onWheel, { passive: false });
  ovCanvas.addEventListener('gesturestart', onGestureStart);
  ovCanvas.addEventListener('gesturechange', onGestureChange);
  ovCanvas.addEventListener('gestureend', onGestureEnd);
  ovCanvas.addEventListener('contextmenu', noMenu);
  ovCanvas.addEventListener('pointerleave', onLeave);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  return {
    pointerAt,
    setHover,
    refreshPointer,
    zoomAt,
    cancel() {
      if (!view.pressed && !panning) return false;
      active().cancel?.();
      view.pressed = false;
      panning = null;
      requestDraw();
      return true;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    },
  };
}
