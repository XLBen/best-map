import { cityAt, dragRoadHandle, roadHandles, roadPoints, settleInputs, smoothRoad, traceRoad } from '../../../core/human';
import type { SettleInputs } from '../../../core/human/settlements';
import type { World } from '../../../core/world';
import type { Shape } from '../../render/overlay';
import type { SettleMark } from '../../render/settle-draw';
import { type SettleRef, exec, options, selectedSettle, sheet, showToast, world } from '../../state';
import { modeDef, modeOf } from '../map/modes';
import { shownMarks } from '../map/settle';
import {
  addCityCommand,
  addLandmarkCommand,
  addPointCommand,
  addRoadCommand,
  attachFor,
  cellPxOf,
  editRoadCommand,
  liveLandmarkType,
  markKey,
  livePointType,
  moveCityCommand,
  moveLandmarkCommand,
  movePointCommand,
  pickMark,
  pickRoad,
  refOfKey,
  removeCommand,
  settleHoverText,
  settleLists,
} from '../settlements';
import { EMPTY, type Pointer, type Preview, type ToolHandler, guard, isBusy, keepX } from './api';

// “城市”一类的四个工具（第二十四轮）：城市（点空地新建、点城市打开档案、拖动挪走）、道路（按住画、点选、拖控制点改走向，像改河）、
// 地标、自定义点（点击放、点选、拖动挪走）。选中的一样记在 state.ts 的 selectedSettle，Delete 删除

// 鼠标离点多近算点中（屏幕像素）；拖多远算拖动
export const HIT_PX = 9;
const MOVE_PX = 4;
// 道路：离线多近算点中；控制点点中的范围；画的一笔起止离城市多近时接到城市上
const ROAD_HIT_PX = 6;
const HANDLE_PX = 8;
const SNAP_PX = 12;

export const HOVER = 'rgba(255, 226, 120, 0.95)';
const SELECT = 'rgba(255, 210, 60, 1)';
const GLOW = 'rgba(255, 226, 120, 0.55)';

const cellOf = (p: Pointer) => p.shown?.here ?? p.cell;

// 选中一样（open：同时打开档案；道路没有档案）
export function selectSettle(ref: SettleRef | null, open = true) {
  selectedSettle.value = ref;
  if (ref && open && ref.kind !== 'road') sheet.value = 'settle';
  // 道路没有档案：选中道路、取消选择时关上档案的抽屉
  if ((!ref || ref.kind === 'road') && sheet.value === 'settle') sheet.value = null;
}

// 删除选中的（Delete 键、底部条的“删除”）。kinds：这个工具管的几种
export function deleteSelected(kinds: readonly SettleRef['kind'][]): boolean {
  const r = selectedSettle.value;
  if (!r || !kinds.includes(r.kind) || isBusy()) return false;
  void exec(removeCommand(r), '正在计算…').then((ok) => {
    if (ok) selectSettle(null);
  });
  return true;
}

// 编辑时地图上画着的点（与地图同一份：“城市”一类开着时城市、全部地标都画，选中的城市写名字）
export function editMarks(w: World): SettleMark[] {
  const r = selectedSettle.value;
  return shownMarks(w, { mode: modeDef(modeOf(w)), editing: true, selected: r && (r.kind === 'city' || r.kind === 'point') ? markKey(r.kind, r.id) : null });
}

export const ring = (x: number, y: number, rPx: number, zoom: number, color: string, width = 2): Shape => ({ kind: 'circle', x, y, r: rPx / zoom, color, width });
const nextId = (w: World) => Math.max(1, w.small.nextSettlement ?? 1);

// 选中的那一个画一个圈（城市、地标、点）
export function selectedRing(marks: readonly SettleMark[], zoom: number, kinds: readonly SettleRef['kind'][]): Shape[] {
  const r = selectedSettle.value;
  if (!r || !kinds.includes(r.kind)) return [];
  const m = marks.find((x) => refOfKey(x.key)?.kind === r.kind && refOfKey(x.key)?.id === r.id);
  return m ? [ring(m.x, m.y, 12, zoom, 'rgba(20, 20, 24, 0.55)', 4), ring(m.x, m.y, 12, zoom, SELECT, 2.2)] : [];
}

// 点、拖一个已有的点（城市、地标、自定义点共用）：drags 只在鼠标下有点时为真（按住空地拖是平移地图）
interface MarkDrag {
  mark: SettleMark;
  sx: number;
  sy: number;
  moved: boolean;
}

function markTool(o: {
  zoom: () => number;
  kinds: readonly SettleMark['kind'][];
  // 这个工具能选、能拖的（城市工具不拖地标）
  accepts(ref: SettleRef): boolean;
  selectKinds: readonly SettleRef['kind'][];
  // 点空地
  place(w: World, p: Pointer): Promise<void>;
  placeHint(w: World, p: Pointer): Preview;
  // 拖到这里
  move(w: World, ref: SettleRef, p: Pointer): Promise<void>;
  moveHint(w: World, ref: SettleRef, p: Pointer): { hint: string; warn?: boolean };
  name(w: World, ref: SettleRef): string;
}): ToolHandler {
  let pointer: Pointer | null = null;
  let hot: SettleMark | null = null;
  let drag: MarkDrag | null = null;
  const zoom = o.zoom;
  const find = (w: World, p: Pointer) => {
    const m = pickMark(w, editMarks(w), p.x, p.y, HIT_PX / zoom(), cellPxOf(w, zoom()), o.kinds);
    const r = m && refOfKey(m.key);
    return m && r && o.accepts(r) ? m : null;
  };
  return {
    get drags() {
      return !!hot;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!w) return;
      if (!pressed) hot = p.cell >= 0 ? find(w, p) : null;
      else if (drag && !drag.moved && Math.hypot(p.sx - drag.sx, p.sy - drag.sy) > MOVE_PX) drag.moved = true;
    },
    leave() {
      pointer = null;
      if (!drag) hot = null;
    },
    down(p) {
      if (hot) drag = { mark: hot, sx: p.sx, sy: p.sy, moved: false };
    },
    async up(p) {
      const d = drag;
      drag = null;
      const w = world.value;
      if (!d || !w) return;
      const ref = refOfKey(d.mark.key)!;
      if (!d.moved) {
        selectSettle(ref);
        return;
      }
      if (p.cell < 0 || isBusy()) return;
      selectSettle(ref, false);
      await o.move(w, ref, p);
    },
    async click(p) {
      const w = world.value;
      if (!w || p.cell < 0) return;
      const m = find(w, p);
      if (m) {
        selectSettle(refOfKey(m.key));
        return;
      }
      if (isBusy()) return;
      await o.place(w, p);
    },
    cancel() {
      drag = null;
    },
    backdrop() {
      const w = world.value;
      return w ? { layers: [], shapes: selectedRing(editMarks(w), zoom(), o.selectKinds) } : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      const z = zoom();
      if (drag) {
        const ref = refOfKey(drag.mark.key)!;
        if (!drag.moved) return { layers: [], shapes: [ring(drag.mark.x, drag.mark.y, 11, z, HOVER)], hint: o.name(w, ref) };
        const h = o.moveHint(w, ref, pointer);
        return {
          layers: [],
          shapes: [
            { kind: 'line', points: [[drag.mark.x, drag.mark.y], [pointer.x, pointer.y]], color: 'rgba(255, 255, 255, 0.7)', width: 1.2, dashed: true },
            ring(pointer.x, pointer.y, 8, z, h.warn ? 'rgba(235, 80, 70, 0.95)' : HOVER),
          ],
          hint: h.hint,
          warn: h.warn,
        };
      }
      if (hot) return { layers: [], shapes: [ring(hot.x, hot.y, 11, z, HOVER)], hint: o.name(w, refOfKey(hot.key)!) };
      return o.placeHint(w, pointer);
    },
  };
}

const cityName = (w: World, ref: SettleRef) => {
  const lists = settleLists(w);
  if (ref.kind === 'point') return lists.points.find((p) => p.id === ref.id)?.name ?? '点';
  if (ref.kind === 'landmark') return lists.landmarks.find((l) => l.id === ref.id)?.name ?? '地标';
  return lists.cities.find((c) => !c.point && c.id === ref.id)?.name ?? '城市';
};

// ---------- 城市 ----------

export function cityTool(zoom: () => number): ToolHandler {
  return markTool({
    zoom,
    kinds: ['city'],
    // 当作城市、没挂在城市上的点画成城市：城市工具里也能选、能拖
    accepts: (r) => r.kind === 'city' || r.kind === 'point',
    selectKinds: ['city', 'point'],
    // 城市写名字、等级、人口（第二十五轮：地图上不写名字的城市在这里看）
    name: settleHoverText,
    placeHint(w, p) {
      const cell = cellOf(p);
      if (!w.causes.land[cell]) return { ...EMPTY, hint: '城市要在陆地上', warn: true };
      const c = cityAt(w, cell);
      if (c) return { ...EMPTY, hint: `这里有城市“${cityName(w, { kind: 'city', id: c.id })}”，放大后可选` };
      return { layers: [{ cells: [cell], color: [255, 236, 140], alpha: 0.55 }], shapes: [], hint: '新建城市' };
    },
    async place(w, p) {
      const cell = cellOf(p);
      if (!w.causes.land[cell]) {
        showToast('城市要在陆地上', true);
        return;
      }
      const c = cityAt(w, cell);
      if (c) {
        selectSettle({ kind: 'city', id: c.id });
        return;
      }
      const id = nextId(w);
      if (await exec(addCityCommand(cell), '正在计算…')) {
        if (world.value?.small.cities?.[id]) selectSettle({ kind: 'city', id }, false);
      }
    },
    moveHint(w, ref, p) {
      const cell = cellOf(p);
      if (!w.causes.land[cell]) return { hint: '城市要在陆地上', warn: true };
      if (ref.kind === 'city') {
        const c = cityAt(w, cell);
        if (c && c.id !== ref.id) return { hint: '这一格已经有城市', warn: true };
      }
      return { hint: `挪到这里` };
    },
    async move(w, ref, p) {
      const cell = cellOf(p);
      if (!w.causes.land[cell]) {
        showToast('城市要在陆地上', true);
        return;
      }
      if (ref.kind === 'point') {
        await exec(movePointCommand(ref.id, cell, keepX(w, p.x), p.y), '正在计算…');
        return;
      }
      const c = cityAt(w, cell);
      if (c && c.id !== ref.id) {
        showToast('这一格已经有城市', true);
        return;
      }
      if (w.small.cities?.[ref.id]?.cell === cell) return;
      await exec(moveCityCommand(ref.id, cell), '正在计算…');
    },
  });
}

// ---------- 地标 ----------

export function landmarkTool(zoom: () => number): ToolHandler {
  return markTool({
    zoom,
    kinds: ['landmark'],
    accepts: (r) => r.kind === 'landmark',
    selectKinds: ['landmark'],
    name: cityName,
    placeHint(w, p) {
      const cell = cellOf(p);
      if (!w.causes.land[cell]) return { ...EMPTY, hint: '地标要在陆地上', warn: true };
      const t = liveLandmarkType(w, options.value.landmarkType);
      return { layers: [{ cells: [cell], color: [255, 236, 140], alpha: 0.55 }], shapes: [], hint: t ? `新建${t.name}` : null };
    },
    async place(w, p) {
      const cell = cellOf(p);
      const t = liveLandmarkType(w, options.value.landmarkType);
      if (!t) return;
      if (!w.causes.land[cell]) {
        showToast('地标要在陆地上', true);
        return;
      }
      const id = nextId(w);
      if (await exec(addLandmarkCommand(t.id, cell), '正在计算…')) {
        if (world.value?.small.landmarks?.[id]) selectSettle({ kind: 'landmark', id }, false);
      }
    },
    moveHint(w, _ref, p) {
      return w.causes.land[cellOf(p)] ? { hint: '挪到这里' } : { hint: '地标要在陆地上', warn: true };
    },
    async move(w, ref, p) {
      const cell = cellOf(p);
      if (!w.causes.land[cell]) {
        showToast('地标要在陆地上', true);
        return;
      }
      if (w.small.landmarks?.[ref.id]?.cell === cell) return;
      await exec(moveLandmarkCommand(ref.id, cell), '正在计算…');
    },
  });
}

// ---------- 自定义点 ----------

// 放下时挂在哪：一句话
export function attachHint(w: World, type: string, x: number, y: number, attach: boolean): string | null {
  const a = attachFor(w, type, x, y, attach);
  if (a === undefined) return null;
  if (a === null) return '自己当一座城市';
  const c = settleLists(w).cities.find((x) => !x.point && x.id === a);
  return c ? `挂在“${c.name}”上` : null;
}

export function pointTool(zoom: () => number): ToolHandler {
  return markTool({
    zoom,
    kinds: ['point', 'city'],
    accepts: (r) => r.kind === 'point',
    selectKinds: ['point'],
    name: cityName,
    placeHint(w, p) {
      const t = livePointType(w, options.value.pointType);
      if (!t) return EMPTY;
      const where = attachHint(w, t.id, p.x, p.y, options.value.pointAttach);
      return { layers: [], shapes: [ring(p.x, p.y, 7, zoom(), HOVER, 1.6)], hint: `新建${t.name}${where ? ` · ${where}` : ''}` };
    },
    async place(w, p) {
      const t = livePointType(w, options.value.pointType);
      if (!t) return;
      const id = nextId(w);
      const x = keepX(w, p.x);
      if (await exec(addPointCommand(t.id, cellOf(p), x, p.y, attachFor(w, t.id, p.x, p.y, options.value.pointAttach)), '正在计算…')) {
        if (world.value?.small.points?.[id]) selectSettle({ kind: 'point', id }, false);
      }
    },
    moveHint: () => ({ hint: '挪到这里' }),
    async move(w, ref, p) {
      await exec(movePointCommand(ref.id, cellOf(p), keepX(w, p.x), p.y), '正在计算…');
    },
  });
}

// ---------- 道路 ----------

// 一条路的光、控制点
function roadGlow(w: World, cells: readonly number[], color = GLOW, width = 7): Shape {
  return { kind: 'line', points: smoothRoad(roadPoints(w, cells)), color, width };
}
function handleShapes(w: World, cells: readonly number[], H: readonly number[], zoom: number, hot: number): Shape[] {
  const pts = roadPoints(w, cells);
  const dark = 'rgba(20, 28, 36, 0.75)';
  const out: Shape[] = [];
  H.forEach((i, j) => {
    const [x, y] = pts[i];
    const end = j === 0 || j === H.length - 1;
    const r = ((end ? 5 : 3.8) * (hot === j ? 1.4 : 1)) / zoom;
    out.push({ kind: 'circle', x, y, r, color: 'rgba(255, 255, 255, 0.95)', width: 1, fill: true });
    out.push({ kind: 'circle', x, y, r, color: dark, width: 1.2 });
  });
  return out;
}

// 画的一笔的起点、终点离城市很近时接到城市的格心上
function snapEnds(w: World, pts: [number, number][], tol: number, cellPx: number): [number, number][] {
  if (pts.length < 2) return pts;
  const marks = editMarks(w);
  const snap = (p: [number, number]): [number, number] => {
    const m = pickMark(w, marks, p[0], p[1], tol, cellPx, ['city']);
    if (!m) return p;
    // 星球：接到同一圈上
    const x = w.mesh.kind === 'sphere' ? m.x + 2 * Math.round((p[0] - m.x) / 2) : m.x;
    return [x, m.y];
  };
  return [snap(pts[0]), ...pts.slice(1, -1), snap(pts[pts.length - 1])];
}

interface Stroke {
  pts: [number, number][];
  sx: number;
  sy: number;
  moved: boolean;
  // 按下时鼠标下的道路（没拖动时选中它）
  road: number | null;
}
interface HandleDrag {
  id: number;
  cells: number[];
  H: number[];
  j: number;
  S: SettleInputs;
  moved: boolean;
  sx: number;
  sy: number;
  // 拖到的格与那时的结果
  at: number;
  result: { cells: number[] } | { blocked: string } | null;
}

export function roadTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let hotRoad: number | null = null;
  let hotHandle = -1;
  let stroke: Stroke | null = null;
  let drag: HandleDrag | null = null;
  // 选中的路的控制点：按道路的那一份缓存
  let handleMemo: { cells: number[]; H: number[] } | null = null;
  const selectedRoad = (w: World) => {
    const r = selectedSettle.value;
    return r?.kind === 'road' ? w.small.roads?.[r.id] : undefined;
  };
  const handlesOf = (w: World, cells: number[]) => {
    if (handleMemo?.cells !== cells) handleMemo = { cells, H: roadHandles(w, { cells }) };
    return handleMemo.H;
  };
  const dist = (w: World, a: [number, number], x: number, y: number) => {
    let dx = x - a[0];
    if (w.mesh.kind === 'sphere') dx -= 2 * Math.round(dx / 2);
    return Math.hypot(dx, y - a[1]);
  };
  const hover = (w: World, p: Pointer) => {
    hotHandle = -1;
    hotRoad = null;
    const z = zoom();
    const sel = selectedRoad(w);
    if (sel) {
      const pts = roadPoints(w, sel.cells);
      const H = handlesOf(w, sel.cells);
      let bd = HANDLE_PX / z;
      H.forEach((i, j) => {
        const d = dist(w, pts[i], p.x, p.y);
        if (d <= bd) {
          bd = d;
          hotHandle = j;
        }
      });
      if (hotHandle >= 0) return;
    }
    hotRoad = pickRoad(w, p.x, p.y, ROAD_HIT_PX / z, cellPxOf(w, z))?.id ?? null;
  };
  // 拖控制点的结果：拖到的格变了才重算（按地形找路）
  const dragResult = (d: HandleDrag, p: Pointer) => {
    const cell = cellOf(p);
    if (cell === d.at && d.result) return d.result;
    d.at = cell;
    d.result = dragRoadHandle(d.S, { cells: d.cells }, d.H, d.j, [p.x, p.y]);
    return d.result;
  };
  const traced = (w: World, s: Stroke) => {
    const z = zoom();
    return traceRoad(w, snapEnds(w, s.pts, SNAP_PX / z, cellPxOf(w, z)));
  };
  return {
    drags: true,
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!w) return;
      if (!pressed) {
        if (p.cell >= 0) hover(w, p);
        return;
      }
      if (stroke) {
        if (!stroke.moved && Math.hypot(p.sx - stroke.sx, p.sy - stroke.sy) > MOVE_PX) stroke.moved = true;
        const last = stroke.pts[stroke.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) * zoom() >= 3) stroke.pts.push([p.x, p.y]);
      } else if (drag) {
        if (!drag.moved && Math.hypot(p.sx - drag.sx, p.sy - drag.sy) > MOVE_PX) drag.moved = true;
        if (drag.moved) dragResult(drag, p);
      }
    },
    leave() {
      pointer = null;
      if (!stroke && !drag) {
        hotRoad = null;
        hotHandle = -1;
      }
    },
    down(p) {
      const w = world.value;
      if (!w || p.cell < 0 || guard('refuse')) return;
      hover(w, p);
      const sel = selectedRoad(w);
      if (sel && hotHandle >= 0) {
        drag = { id: sel.id, cells: sel.cells, H: handlesOf(w, sel.cells), j: hotHandle, S: settleInputs(w, w.derived), moved: false, sx: p.sx, sy: p.sy, at: -1, result: null };
        return;
      }
      stroke = { pts: [[p.x, p.y]], sx: p.sx, sy: p.sy, moved: false, road: hotRoad };
    },
    async up(p) {
      const w = world.value;
      const s = stroke;
      const d = drag;
      stroke = null;
      drag = null;
      if (!w) return;
      if (d) {
        if (!d.moved) return;
        const r = dragResult(d, p);
        if ('blocked' in r) {
          showToast(r.blocked, true);
          return;
        }
        if (r.cells.length === d.cells.length && r.cells.every((c, k) => c === d.cells[k])) return;
        await exec(editRoadCommand(d.id, r.cells), '正在计算…');
        return;
      }
      if (!s) return;
      if (!s.moved) {
        selectSettle(s.road !== null ? { kind: 'road', id: s.road } : null);
        return;
      }
      s.pts.push([p.x, p.y]);
      const t = traced(w, s);
      if ('blocked' in t) {
        showToast(t.blocked, true);
        return;
      }
      const id = nextId(w);
      if (await exec(addRoadCommand(t.cells, options.value.roadKind), '正在计算…')) {
        if (world.value?.small.roads?.[id]) selectSettle({ kind: 'road', id });
      }
    },
    cancel() {
      stroke = null;
      drag = null;
    },
    backdrop() {
      const w = world.value;
      const sel = w && selectedRoad(w);
      if (!w || !sel) return null;
      return { layers: [], shapes: [roadGlow(w, sel.cells, 'rgba(255, 210, 60, 0.55)', 8)] };
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      const z = zoom();
      const sel = selectedRoad(w);
      const handles = sel && !drag ? handleShapes(w, sel.cells, handlesOf(w, sel.cells), z, hotHandle) : [];
      if (drag) {
        if (!drag.moved || !drag.result) return { layers: [], shapes: handleShapes(w, drag.cells, drag.H, z, drag.j), hint: null };
        const r = drag.result;
        if ('blocked' in r) return { layers: [], shapes: [roadGlow(w, drag.cells, 'rgba(235, 80, 70, 0.5)', 6)], hint: r.blocked, warn: true };
        return { layers: [], shapes: [roadGlow(w, r.cells, 'rgba(255, 255, 255, 0.9)', 3), ring(pointer.x, pointer.y, 6, z, HOVER)], hint: '改走向' };
      }
      if (stroke) {
        const line: Shape = { kind: 'line', points: stroke.pts.slice(), color: 'rgba(255, 255, 255, 0.7)', width: 1.4, dashed: true };
        if (!stroke.moved || stroke.pts.length < 2) return { layers: [], shapes: [line, ...handles], hint: null };
        const t = traced(w, { ...stroke, pts: [...stroke.pts, [pointer.x, pointer.y]] });
        if ('blocked' in t) return { layers: [], shapes: [line], hint: t.blocked, warn: true };
        return { layers: [], shapes: [line, roadGlow(w, t.cells, options.value.roadKind === 'major' ? 'rgba(118, 62, 38, 0.9)' : 'rgba(118, 62, 38, 0.7)', options.value.roadKind === 'major' ? 2.2 : 1.4)], hint: options.value.roadKind === 'major' ? '画大道' : '画小路' };
      }
      if (hotHandle >= 0) return { layers: [], shapes: handles, hint: '拖动改走向' };
      if (hotRoad !== null) {
        const r = w.small.roads?.[hotRoad];
        const glow = r ? [roadGlow(w, r.cells)] : [];
        return { layers: [], shapes: [...glow, ...handles], hint: r ? `${r.name ? `${r.name} · ` : ''}${r.kind === 'major' ? '大道' : '小路'}` : null };
      }
      return { layers: [], shapes: handles, hint: null };
    },
  };
}
