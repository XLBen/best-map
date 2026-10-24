import { signal } from '@preact/signals';
import type { Command } from '../../../core/commands';
import { wrapX } from '../../../core/geo';
import { lassoStroke } from '../../../core/select';
import {
  islandTypeName,
  type ChainSpec,
  type IslandSpec,
  centerCell,
  chainIslands,
  combineStamps,
  fragmentAfter,
  fragmentStroke,
  islandSizeRangeKm,
  sizeText,
  islandStamp,
  lakeIslandStamp,
  landStroke,
  previewLand,
  reliefStroke,
  restoreStroke,
  roundKm as km,
  type TerrainPreview,
} from '../../../core/terrain';
import { islandTypeById, liveIslandKind } from '../../../core/island-types';
import type { World } from '../../../core/world';
import type { GhostEdit, HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { type ToolOptions, exec, noteCost, options, previewTerrainOnce, setOptions, showToast, slowHint, slowPreview, world, worldPreviewError } from '../../state';
import { erasableLayer, terrainHere, terrainMask } from '../edits';
import { Exact, Settle } from '../exact';
import { ghostFollows, queueHint, trackEdit } from '../pending';
import { BLOCKED_RGB, type Backdrop, EMPTY, type Pointer, type Preview, type RGB, type ToolHandler, WHITE, aroundPole, guard, isBusy, keepX, worldId } from './api';
import { type BrushLayers, type Stroke, brushR, brushTool, strengthValues } from './brush';
import { POLE_HINT, POLE_TOAST, type Settled, type SizeDrag, dragTo, lakeIsleExact, lakeIsleRelease, lassoAdd, lassoShapes, movedAway, sizeLine, startDrag } from './gestures';

// 地形：画陆地 / 海（画笔、圈一片）、放岛、岛链、堆山 / 压低、打碎、重画这一片、恢复原样

// 下一个岛、下一条岛链的形状（每放一个自动换一个；不是设置，不放在 options 里：换形状不让别的预览作废）
export const islandVariant = signal(0);
export const chainVariant = signal(0);

// 画陆地 / 海的幽灵海岸（含将来的破碎度，与 paint_land 同一个规则）
function landGhost(w: World, cells: number[], t: number[], mode: 'land' | 'sea'): { ghost: GhostEdit; gained: number[]; lost: number[] } {
  const r = landStroke(w, cells, t, mode);
  const p = previewLand(w, r.cells, r.delta);
  return { ghost: { cells: r.cells, delta: r.delta, frag: fragmentAfter(w, cells, t, [...p.gained, ...p.lost], false) }, gained: p.gained, lost: p.lost };
}

export function landTool(): ToolHandler {
  const modeOf = (shift: boolean) => {
    const m = options.value.landMode;
    return shift ? (m === 'land' ? 'sea' : 'land') : m;
  };
  // 画的时候直接画出将来的海岸线（幽灵海岸），不再涂绿、涂蓝。笔没动就沿用同一个结果
  let memo: { w: World; s: Stroke; v: number; mode: string; out: BrushLayers } | null = null;
  const brush = brushTool({
    hint: () => ({ text: null }),
    layers(w, s, shift) {
      const mode = modeOf(shift);
      if (memo?.w === w && memo.s === s && memo.v === s.rev && memo.mode === mode) return memo.out;
      const g = landGhost(w, s.cells, s.ts, mode);
      const out = { layers: [], ghost: g.ghost, hint: mode === 'land' ? `陆地 +${g.gained.length} 格` : `陆地 −${g.lost.length} 格` };
      memo = { w, s, v: s.rev, mode, out };
      return out;
    },
    // 排队时按新的世界重算：画陆地还是画海按松手时的（与发出的命令相同；之后在底部条上换了也不跟着变）
    ghostAt(s, shift) {
      const mode = modeOf(shift);
      return (w) => landGhost(w, s.cells, s.ts, mode).ghost;
    },
    commit: (_w, s, shift) => exec({ op: 'paint_land', cells: s.cells, t: s.ts, mode: modeOf(shift) }),
    // 0.7 倍半径以内一定变（细实线）；海岸平均落在 0.85 倍处（主圈），再往外只是零星几格
    rings: [0.7, 0.85],
  });
  const lasso = landLasso(modeOf);
  // 底部条上选的“画笔 / 圈一片”；按下时用哪个，这一笔就一直是哪个
  const chosen = () => (options.value.landShape === 'lasso' ? lasso : brush);
  let active: ToolHandler | null = null;
  return {
    drags: true,
    down(p) {
      active = chosen();
      active.down?.(p);
    },
    move(p, pressed) {
      brush.move?.(p, pressed);
      lasso.move?.(p, pressed);
    },
    async up(p) {
      const h = active ?? chosen();
      active = null;
      await h.up?.(p);
    },
    cancel() {
      brush.cancel?.();
      lasso.cancel?.();
      active = null;
    },
    leave() {
      brush.leave?.();
      lasso.leave?.();
    },
    preview: () => (active ?? chosen()).preview(),
  };
}

// 圈一片：按住画一个圈，松手后圈里变成陆地（或海），边上和画笔一样是自然的海岸。
// 预览与松手后提交的是同一个圈（每移动半格记一个点），地图上画出的将来的海岸线就是结果。
// 前面的编辑还在算时也能圈（排队，松手时的预览留到结果换上）：命令只看圈住的格，与等着圈相同
function landLasso(modeOf: (shift: boolean) => 'land' | 'sea'): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let cache: { key: string; cells: number[]; t: number[]; gained: number[]; lost: number[]; ghost: GhostEdit } | null = null;
  const compute = (w: World, pts: [number, number][], mode: 'land' | 'sea') => {
    const key = `${worldId(w)}|${ringId}|${pts.length}|${mode}`;
    if (cache?.key === key) return cache;
    const r = lassoStroke(w, pts);
    const g = landGhost(w, r.cells, r.t, mode);
    // 幽灵海岸跟着缓存走：同一个圈不必重算，松手后排队时照样用它
    cache = { key, cells: r.cells, t: r.t, gained: g.gained, lost: g.lost, ghost: g.ghost };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || p.cell < 0) return;
      if (guard('queue')) return;
      ring = [[p.x, p.y]];
      ringId++;
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w) return;
      lassoAdd(w, ring, p);
    },
    async up(p) {
      const w = world.value;
      const pts = ring;
      if (!w || !pts) return;
      const mode = modeOf(p.shift);
      if (aroundPole(w, pts)) {
        ring = null;
        showToast(POLE_TOAST, true);
        return;
      }
      const c = pts.length >= 3 ? compute(w, pts, mode) : null;
      const count = c ? (mode === 'land' ? c.gained.length : c.lost.length) : 0;
      if (!c || !count) {
        ring = null;
        showToast(!c ? '圈太小' : mode === 'land' ? '圈里都是陆地' : '圈里没有陆地', true);
        return;
      }
      // 松手时的样子（合上的圈与将来的海岸线）留在图上，直到结果换上；圈马上空出来，可以接着圈下一个。
      // 排在前面的编辑先换上了：幽灵海岸按新的世界重算（命令只看圈住的格，结果按执行时的世界算）
      ring = null;
      const shapes: Shape[] = [{ kind: 'line', points: [...pts, pts[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5 }];
      const at: Preview = { layers: [], shapes, hint: null, ghost: c.ghost };
      const ghostAt = (now: World): GhostEdit => landGhost(now, c.cells, c.t, mode).ghost;
      await trackEdit(at, exec({ op: 'paint_land', cells: c.cells, t: c.t, mode }), ghostFollows(at, w, ghostAt));
    },
    cancel() {
      ring = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const mode = modeOf(pointer.shift);
      if (!ring) return EMPTY;
      const shapes = lassoShapes(ring);
      if (ring.length < 3) return { layers: [], shapes, hint: null };
      if (aroundPole(w, ring)) return { layers: [], shapes, hint: POLE_HINT, warn: true };
      const c = compute(w, ring, mode);
      return {
        layers: [],
        shapes,
        hint: queueHint() ?? (mode === 'land' ? `陆地 +${c.gained.length} 格` : `陆地 −${c.lost.length} 格`),
        ghost: c.ghost,
      };
    },
  };
}

// 重画过的范围（重画这一片的圈）：恢复原样不管它们，选中恢复原样时画成虚线圈。按圈的数组缓存
let rerollMemo: { rerolls: unknown; shapes: Shape[] } | null = null;
function rerollCircles(w: World): Shape[] {
  const rerolls = w.small.terrain.gen?.rerolls ?? [];
  if (rerollMemo?.rerolls !== rerolls) {
    rerollMemo = {
      rerolls,
      shapes: rerolls.map((r) => ({ kind: 'circle', x: r.x, y: r.y, r: r.radius, dashed: true, color: 'rgba(255, 220, 140, 0.8)', width: 1.5, geodesic: true })),
    };
  }
  return rerollMemo.shapes;
}

// 恢复原样：画到的地方，画过的陆地、海、山和放的岛都退回生成时的样子（中间全收回，边上渐变）。
// 选中时地图上一直用浅斜线标出改过的格（见 edits.ts），悬停说这里改过什么；重画过的范围画成虚线圈（不归它管）。
// 只涂得到改过的格（淡淡的白色）；地图上直接画出恢复后的海岸线
export function restoreTool(): ToolHandler {
  // 擦的时候连看不出的零头一起擦掉（标出来的只是看得出的改动）
  const edited = (w: World, i: number) => w.causes.landDelta[i] !== 0 || w.causes.upliftDelta[i] !== 0 || w.causes.erodDelta[i] !== 0 || (w.causes.fragment?.[i] ?? 0) !== 0;
  let memo: { w: World; s: Stroke; v: number; out: BrushLayers } | null = null;
  let back: { layer: HighlightLayer | null; shapes: Shape[]; out: Backdrop } | null = null;
  return brushTool({
    hint: () => ({ text: null }),
    filter: edited,
    backdrop(w) {
      const layer = erasableLayer(terrainMask(w));
      const shapes = rerollCircles(w);
      if (back?.layer !== layer || back.shapes !== shapes) back = { layer, shapes, out: { layers: layer ? [layer] : [], shapes } };
      return back.out;
    },
    here: (w, cells) => terrainHere(w, cells),
    layers(w, s) {
      if (memo?.w === w && memo.s === s && memo.v === s.rev) return memo.out;
      const r = restoreStroke(w, s.cells, s.ts);
      const p = previewLand(w, r.cells, r.delta);
      // 破碎度按画笔权重退回；中间那一圈、陆海变了的格清零（与 restore_terrain 同一个规则）
      const out = {
        layers: [{ cells: s.cells, values: s.weights(), color: WHITE, alpha: 0.25 }],
        ghost: { cells: r.cells, delta: r.delta, frag: fragmentAfter(w, s.cells, s.ts, [...p.gained, ...p.lost], true) },
        hint: !s.t.size ? '这里没改过' : p.gained.length || p.lost.length ? `陆地 +${p.gained.length} / −${p.lost.length} 格` : `恢复 ${s.t.size} 格`,
      };
      memo = { w, s, v: s.rev, out };
      return out;
    },
    async commit(_w, s) {
      if (!s.t.size) {
        showToast('这里的地形没改过', true);
        return;
      }
      await exec({ op: 'restore_terrain', cells: s.cells, t: s.ts }, '正在计算…');
    },
    // 0.7 倍半径以内全收回（细实线），往外到半径处渐变
    rings: [0.7, 1],
  });
}

// 堆山 / 压低的力度最大是多少（底部条滑块的上限，预览深浅按它算）
export const RELIEF_MAX = 1.6;

// 堆山 / 压低一笔大约让地势升降多少米（提示里的“约 +900 m”）：笔下升得最多、降得最多的地方变多少。
// 经验估计（在地区、星球几种格数的地图上，画笔半径 1–25 格量过，多数与实际差在五成以内，个别差到两倍）：
// 堆山与力度^0.9、画笔半径（格）^0.75、“最高的山”成正比，抬升量最多到 2，已经很高的地方堆不了那么多；
// 压低是每格按现在的高度、去掉的抬升量占原有的几成估计，取最多的那格（没有抬升的平地压不下去）；
// 半径一两格的小画笔压不了那么多（周围的山撑着）。cells、delta：这一笔涂到的格与抬升量的变化（reliefStroke）；
// km：画笔半径（省略时用底部条上的）
export function reliefEstimateM(w: World, cells: number[], delta: number[], strength: number, km = options.value.brushKm): number {
  const rc = Math.max(0.5, brushR(w, km) / w.mesh.spacing);
  if (strength >= 0) {
    let u = 0;
    for (const i of cells) u += w.causes.uplift[i];
    u /= Math.max(1, cells.length);
    const s = Math.max(0, Math.min(strength, 2 - u));
    return 0.2 * w.small.planet.mountainScale * Math.pow(s, 0.9) * Math.pow(rc, 0.75);
  }
  let drop = 0;
  cells.forEach((i, k) => {
    const u = w.causes.uplift[i];
    drop = Math.max(drop, (Math.max(0, w.derived.elevation[i]) * Math.min(u, -delta[k])) / (0.035 + u));
  });
  return -drop * Math.min(1.1, 0.65 * Math.pow(rc, 0.4));
}

// 高度变化写成“约 +900 m”：一千米以上取整到百米，一百米以上取整到 50 米
export function fmtMeters(v: number): string {
  const m = Math.abs(v);
  if (m < 5) return '几乎不变';
  const step = m >= 1000 ? 100 : m >= 100 ? 50 : 10;
  return `约 ${v > 0 ? '+' : '−'}${(Math.round(m / step) * step).toLocaleString()} m`;
}

export function reliefTool(): ToolHandler {
  const sign = (shift: boolean) => ((options.value.reliefMode === 'up') !== shift ? 1 : -1);
  return brushTool({
    hint: () => ({ text: null }),
    filter: (w, i) => w.causes.land[i] === 1,
    layers(w, s, shift) {
      const strength = sign(shift) * options.value.reliefAmount;
      const r = reliefStroke(s.cells, s.ts, strength);
      const name = strength > 0 ? '堆山' : '压低';
      return {
        // 深浅跟着力度：拖“力度”滑块时预览跟着变
        layers: [{ cells: r.cells, values: strengthValues(r.delta, RELIEF_MAX), color: strength > 0 ? [205, 135, 70] : [120, 150, 190], alpha: 0.7 }],
        hint: s.t.size ? `${name} ${fmtMeters(reliefEstimateM(w, r.cells, r.delta, strength))}` : name,
      };
    },
    commit: (_w, s, shift) => exec({ op: 'paint_relief', cells: s.cells, t: s.ts, strength: sign(shift) * options.value.reliefAmount }, '正在计算…'),
  });
}

// 打碎（第十八轮）：按住涂。裂成碎块：圈里的陆地按固定的裂缝图裂开（裂开的格涂成蓝色）；只打碎海岸：只把海岸一两格以内打碎。
// 涂到的格淡淡地标出（越碎越浓），手停一下就是松手后的样子（确切预览：碎岛、裂缝、新的海岸线都画出来）
export function fragmentTool(): ToolHandler {
  const cmdOf = (s: Stroke): Command => {
    const o = options.value;
    return { op: 'fragment', cells: s.cells, t: s.ts, strength: o.fragAmount, mode: o.fragMode, size: o.brushKm };
  };
  let memo: { w: World; s: Stroke; v: number; o: ToolOptions; out: BrushLayers } | null = null;
  return brushTool({
    hint: () => ({ text: null }),
    layers(w, s) {
      const o = options.value;
      if (memo?.w === w && memo.s === s && memo.v === s.rev && memo.o === o) return memo.out;
      const r = fragmentStroke(w, s.cells, s.ts, o.fragAmount, o.fragMode, o.brushKm);
      const layers: HighlightLayer[] = [{ cells: r.frag.cells, values: r.frag.value.map((v) => v / 255), color: [240, 220, 160], alpha: 0.45 }];
      if (r.cracked.length) layers.push({ cells: r.cracked, color: [70, 130, 210], alpha: 0.7 });
      const hint = o.fragMode === 'coast' ? (r.frag.cells.length ? `打碎海岸 ${r.frag.cells.length} 格` : '这里没有海岸') : r.cracked.length ? `裂开 ${r.cracked.length} 格陆地` : r.frag.cells.length ? `打碎 ${r.frag.cells.length} 格` : '这里已经这么碎了';
      const out = { layers, hint };
      memo = { w, s, v: s.rev, o, out };
      return out;
    },
    exact: (_w, s) => (s.t.size ? cmdOf(s) : null),
    exactHint: (_w, _s, _shift, r) => r.summary,
    commit: (_w, s) => exec(cmdOf(s), '正在计算…'),
    // 0.7 倍半径以内裂得最开（细实线），往外到半径处渐渐收住
    rings: [0.7, 1],
  });
}

// 点一下：用底部滑块的大小放岛；按住往外拖：拖多远岛就多大（松手后滑块也停在这个大小）。
// 前面的编辑还在算时也能放（排队）：命令只看位置、种类、大小、形状，与等着放相同。
// 湖面上（第十五轮）：主线程马上画出岛占的湖面格（白框），手停下时在 Worker 里确切地预览（就是松手后的样子：岛高出湖面、
// 湖照旧），松手时直接采用
export function islandTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: SizeDrag | null = null;
  let settled: Settled = null;
  let cache: { key: string; preview: Preview; spec: IslandSpec | null; block: string | null; lake?: number[] } | null = null;
  const ex = new Exact();
  const cmdOf = (spec: IslandSpec): Command => ({ op: 'add_island', island: spec });
  const compute = () => {
    const w = world.value;
    if (!w || !pointer) return null;
    const center = drag ?? (pointer.cell >= 0 ? pointer : null);
    if (!center) return null;
    const o = options.value;
    // 选着的种类被删掉了：按大陆岛
    const kind = liveIslandKind(w, o.islandKind);
    // 滑块停在别的种类的大小上时，补到这一种的最小值
    const size = Math.max(islandSizeRangeKm(w, kind)[0], drag?.km ?? o.islandKm);
    const spec: IslandSpec = { x: keepX(w, center.x), y: center.y, kind, size, variant: islandVariant.value };
    const key = `${worldId(w)}|${spec.x.toFixed(5)},${spec.y.toFixed(5)}|${spec.kind}|${spec.size}|${spec.variant}`;
    if (cache?.key === key) return cache;
    const name = islandTypeName(w, spec.kind);
    const reef = islandTypeById(w.small, spec.kind)?.shape === 'cell';
    // 一格的岛（小礁）不看大小：占一格（画出来的海岸约半格大，但它是一整格陆地），说一格有多大
    const diameter = km(w.mesh.spacing * w.kmPerUnit);
    let block: string | null = null;
    const shape = sizeLine(drag, pointer);
    // 碎岛（第十八轮）：一片比一格小的碎岛，格还是海（大小至少约 0.75 格的半径，碰得到岛心附近几格）
    const shards = islandTypeById(w.small, spec.kind)?.shape === 'frag';
    const label = reef ? `${name} · 一格（约 ${diameter} km）` : shards ? `${name} · ${km(Math.max(spec.size, w.mesh.spacing * w.kmPerUnit * 0.75) * 2)} km` : `${name} · ${sizeText(w, spec.size)}`;
    // 岛心那一格（与命令同一个算法）
    const c0 = centerCell(w.mesh, spec.x, spec.y);
    if (w.causes.land[c0] && w.derived.lake[c0] === 1) {
      // 湖面上：岛只占这个湖里不挨岸的湖面格（与命令同一个规则），确切的样子等 Worker（见 preview）
      const st = lakeIslandStamp(w, spec, w.derived);
      // 碎岛：不占湖面格，只抬破碎度（地图上直接画出将来的碎岛）
      const took = shards ? (st.frag?.cells ?? []) : st.cells;
      if (spec.kind === 'atoll' && w.derived.tMean[c0] < 20) block = `湖水太凉（${Math.round(w.derived.tMean[c0])} °C），珊瑚岛要 20 °C 以上`;
      else if (!took.length) block = shards ? '这里已经这么碎了' : '湖太窄，放不下岛';
      if (shards) {
        const preview: Preview = {
          layers: block ? [{ cells: [c0], color: BLOCKED_RGB, alpha: 0.75 }] : [],
          shapes: shape,
          hint: block ?? `湖里的${label}`,
          warn: !!block,
          ghost: block ? null : { cells: [], delta: [], frag: st.frag },
        };
        cache = { key, preview, spec, block };
        return cache;
      }
      const preview: Preview = {
        layers: block ? [{ cells: st.cells.length ? st.cells : [c0], color: BLOCKED_RGB, alpha: 0.75 }] : [{ cells: st.cells, color: WHITE, pattern: 'outline' }],
        shapes: shape,
        hint: block ?? `湖里的${label}`,
        warn: !!block,
      };
      cache = { key, preview, spec, block, lake: st.cells };
      return cache;
    }
    if (spec.kind === 'atoll' && !w.causes.land[center.cell] && w.derived.tMean[center.cell] < 20) {
      block = `海水太凉（${Math.round(w.derived.tMean[center.cell])} °C），珊瑚岛要 20 °C 以上`;
    }
    const stamp = islandStamp(w, spec);
    if (shards) {
      // 碎岛：岛心在干的陆地上放不了；放得下时地图上直接画出将来的碎岛
      if (w.causes.land[c0]) block = '碎岛要放在海里或湖里';
      else if (!stamp.frag?.cells.length) block = '这里已经这么碎了';
      const preview: Preview = {
        layers: block ? [{ cells: [c0], color: BLOCKED_RGB, alpha: 0.75 }] : [],
        shapes: shape,
        hint: block ?? label,
        warn: !!block,
        ghost: block ? null : { cells: [], delta: [], frag: stamp.frag },
      };
      cache = { key, preview, spec, block };
      return cache;
    }
    const fresh = stamp.footprint.filter((c) => !w.causes.land[c]);
    if (!block && !fresh.length) block = '这里已是陆地';
    // 放得下：地图上直接画出岛将来的海岸线（小礁也是，画出来约半格大）；放不下：轮廓涂红
    const preview: Preview = {
      layers: block ? [{ cells: stamp.footprint, color: BLOCKED_RGB, alpha: 0.75 }] : [],
      shapes: shape,
      hint: block ?? label,
      warn: !!block,
      ghost: block ? null : { cells: stamp.cells, delta: stamp.landDelta },
    };
    cache = { key, preview, spec, block };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || p.cell < 0 || !movedAway(settled, p)) return;
      if (guard('queue')) return;
      pointer = p;
      drag = startDrag(p);
    },
    move(p, pressed) {
      pointer = p;
      if (movedAway(settled, p)) settled = null;
      const w = world.value;
      if (!pressed || !drag || !w) return;
      // 一格的岛（小礁）不看大小
      const kind = liveIslandKind(w, options.value.islandKind);
      dragTo(w, drag, p, () => (islandTypeById(w.small, kind)?.shape === 'cell' ? null : islandSizeRangeKm(w, kind)));
    },
    async up(p) {
      pointer = p;
      const d = drag;
      if (!d) return;
      const w = world.value;
      const c = compute();
      drag = null;
      if (!c?.spec || !w) return;
      const why = c.lake && !c.block ? worldPreviewError(cmdOf(c.spec)) : null;
      if (c.block || why) {
        showToast(c.block ?? why!, true);
        return;
      }
      const spec = c.spec;
      // 滑块停在拖出的大小；下一个岛自动换一个形状（悬停的预览里看得到）
      islandVariant.value = spec.variant + 1;
      if (d.km !== null) setOptions({ islandKm: d.km });
      const mark = { sx: p.sx, sy: p.sy };
      settled = mark;
      // 松手时的岛（将来的海岸线）留在图上直到结果换上，鼠标离开地图也留着，不闪回原来的海岸（拖大小的虚线不留）。
      // 排在前面的编辑先换上了：按新的世界重算（结果按执行时的世界算）
      if (c.lake) {
        // 湖里的岛：确切预览算好了就留着它（将来的世界），没算好时留着岛占的湖面格
        const future = lakeIsleRelease(ex, cmdOf(spec));
        const shown: Preview = future ? { layers: c.preview.layers, shapes: [], hint: null, world: future } : { layers: c.preview.layers, shapes: [], hint: null };
        try {
          await trackEdit(shown, exec(cmdOf(spec), '正在计算…'));
        } finally {
          if (settled === mark) settled = null;
          ex.clear();
        }
        return;
      }
      const shown: Preview = { layers: c.preview.layers, shapes: [], hint: null, ghost: c.preview.ghost };
      const ghostAt = (now: World): GhostEdit => {
        const c1 = centerCell(now.mesh, spec.x, spec.y);
        const st = now.causes.land[c1] && now.derived.lake[c1] === 1 ? lakeIslandStamp(now, spec, now.derived) : islandStamp(now, spec);
        return { cells: st.cells, delta: st.landDelta, frag: st.frag };
      };
      try {
        await trackEdit(shown, exec(cmdOf(spec), '正在计算…'), ghostFollows(shown, w, ghostAt));
      } finally {
        if (settled === mark) settled = null;
      }
    },
    cancel() {
      drag = null;
      ex.clear();
    },
    preview() {
      if (settled) return { ...EMPTY, hint: '正在计算…' };
      const c = compute();
      if (!c) return EMPTY;
      if (c.lake && c.spec && !c.block) {
        const x = lakeIsleExact(ex, world.value!, cmdOf(c.spec));
        if (x.why) return { ...c.preview, layers: [{ cells: c.lake, color: BLOCKED_RGB, alpha: 0.75 }], hint: x.why, warn: true };
        const q = queueHint();
        if (x.world) return { ...c.preview, hint: q ?? c.preview.hint, world: x.world };
        return { ...c.preview, hint: q ?? `${c.preview.hint}${x.tail}` };
      }
      const q = c.block ? null : queueHint();
      return q ? { ...c.preview, hint: q } : c.preview;
    },
  };
}

// 岛链：按住拖出一条线，岛沿着线排开。前面的编辑还在算时也能画（排队）。
// 有岛心落在湖面上时（第十五轮）：海里的岛照旧画出将来的海岸线，湖里的岛画出占的湖面格（白框），
// 手停下时在 Worker 里确切地预览（与放岛一样）
export function chainTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let points: [number, number][] | null = null;
  let lastScreen: [number, number] = [0, 0];
  let cache: { key: string; preview: Preview; lake: boolean } | null = null;
  const ex = new Exact();
  // 推导里的湖面（与命令里 ensureDerived 的相同）
  const lakesOf = (w: World) => () => w.derived;
  // 预览与执行用同一份参数
  const specFor = (pts: [number, number][]) => {
    const o = options.value;
    const w = world.value;
    // 整个星球：整条线一起平移若干个 2，第一点落在 [0, 2)
    const shift = w && w.mesh.kind === 'sphere' && pts.length ? wrapX(pts[0][0]) - pts[0][0] : 0;
    let use = shift ? pts.map(([x, y]) => [x + shift, y] as [number, number]) : pts;
    if (use.length > 40) {
      const all = use;
      use = [];
      for (let k = 0; k < 40; k++) use.push(all[Math.round((k * (all.length - 1)) / 39)]);
    }
    // 岛链用自己的种类和大小（小一号的岛最小一格，太小时岛心那一格成陆）
    const kind = liveIslandKind(w, o.chainKind);
    const size = w ? Math.max(islandSizeRangeKm(w, kind)[0], o.chainKm) : o.chainKm;
    // 碎岛的比例（第十八轮）：0 时不写（与以前的命令相同）；种类本身是碎岛时用不上
    const ratio = w && islandTypeById(w.small, kind)?.shape !== 'frag' ? Math.round(o.chainFrag * 20) / 20 : 0;
    return { points: use, kind, size, density: o.chainDensity, variant: chainVariant.value, ...(ratio > 0 ? { fragRatio: ratio } : {}) };
  };
  // 一条岛链的预览（按世界与参数缓存）：与命令同一个规则（太小的岛岛心那一格成陆），预览就是结果
  const previewOf = (w: World, spec: ChainSpec): Preview => {
    const key = `${worldId(w)}|${JSON.stringify(spec)}`;
    if (cache?.key !== key) {
      const islands = chainIslands(w, spec, lakesOf(w));
      const stamp = combineStamps(w, islands, lakesOf(w));
      // 湖里的岛占的格（定了高度的格）
      const lake = stamp.heights ? stamp.cells.filter((_, k) => !Number.isNaN(stamp.heights![k])) : [];
      const shards = islands.filter((x) => islandTypeById(w.small, x.kind)?.shape === 'frag').length;
      const placed = islands.length - (stamp.skipped ?? 0);
      cache = {
        key,
        lake: lake.length > 0,
        preview: {
          layers: lake.length ? [{ cells: lake, color: WHITE, pattern: 'outline' }] : [],
          shapes: [{ kind: 'line', points: spec.points, dashed: true, color: 'rgba(255,255,255,0.8)' }],
          hint: shards && shards < islands.length ? `${placed} 个岛（其中 ${shards} 片碎岛）` : shards ? `${placed} 片${islandTypeName(w, islands[0].kind)}` : `${placed} 个${islandTypeName(w, spec.kind)}`,
          // 地图上直接画出岛链将来的海岸线（与碎岛）
          ghost: { cells: stamp.cells, delta: stamp.landDelta, frag: stamp.frag },
        },
      };
    }
    return cache.preview;
  };
  // 有湖里的岛时：确切预览
  const exact = (w: World, spec: ChainSpec, pv: Preview): Preview => {
    const x = lakeIsleExact(ex, w, { op: 'add_island_chain', chain: spec });
    if (x.why) return { ...pv, layers: pv.layers.map((l) => ({ ...l, color: BLOCKED_RGB as RGB })), hint: x.why, warn: true };
    if (x.world) return { ...pv, ghost: null, world: x.world };
    return { ...pv, hint: `${pv.hint}${x.tail}` };
  };
  return {
    drags: true,
    down(p) {
      if (guard('queue')) return;
      points = [[p.x, p.y]];
      lastScreen = [p.sx, p.sy];
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      if (pressed && points && Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 10) {
        points.push([p.x, p.y]);
        lastScreen = [p.sx, p.sy];
      }
    },
    async up(p) {
      const w = world.value;
      const pts = points;
      points = null;
      if (!pts || !w) return;
      if (Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 2) pts.push([p.x, p.y]);
      if (pts.length < 2) {
        showToast('按住拖出一条线', true);
        return;
      }
      const chain = specFor(pts);
      const pv = previewOf(w, chain);
      const cmd: Command = { op: 'add_island_chain', chain };
      if (cache?.lake) {
        // 有湖里的岛：确切预览算好了就留着它（将来的世界），没算好时留着海岸线与湖里的岛占的格
        const why = worldPreviewError(cmd);
        if (why) {
          showToast(why, true);
          ex.clear();
          return;
        }
        const future = lakeIsleRelease(ex, cmd);
        const shown: Preview = future ? { layers: pv.layers, shapes: [], hint: null, world: future } : { ...pv, hint: null };
        chainVariant.value = chain.variant + 1;
        try {
          await trackEdit(shown, exec(cmd, '正在计算…'));
        } finally {
          ex.clear();
        }
        return;
      }
      // 松手时的岛（将来的海岸线）与线留在图上，直到结果换上（滑块马上换到下一种排列，不能再按滑块重算）。
      // 排在前面的编辑先换上了：按新的世界重算（结果按执行时的世界算）
      const at: Preview = { ...pv, hint: null };
      const ghostAt = (now: World): GhostEdit => {
        const st = combineStamps(now, chainIslands(now, chain, lakesOf(now)), lakesOf(now));
        return { cells: st.cells, delta: st.landDelta, frag: st.frag };
      };
      // 下一条岛链自动换一种排列
      chainVariant.value = chain.variant + 1;
      await trackEdit(at, exec(cmd, '正在计算…'), ghostFollows(at, w, ghostAt));
    },
    cancel() {
      points = null;
      ex.clear();
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (!points || points.length < 2) return EMPTY;
      const spec = specFor(points);
      const pv = previewOf(w, spec);
      if (cache?.lake) return exact(w, spec, pv);
      const q = queueHint();
      return q ? { ...pv, hint: q } : pv;
    },
  };
}

// 山会变高（橙）、变矮（蓝灰）的格：深浅跟着抬升量的变化。“调整”滑块与重画这一片共用
export function reliefLayers(relief: { cells: number[]; delta: number[] }): HighlightLayer[] {
  const up: number[] = [];
  const upV: number[] = [];
  const down: number[] = [];
  const downV: number[] = [];
  relief.cells.forEach((cell, k) => {
    const d = relief.delta[k];
    if (d > 0) {
      up.push(cell);
      upV.push(Math.min(1, d / 0.6));
    } else {
      down.push(cell);
      downV.push(Math.min(1, -d / 0.6));
    }
  });
  return [
    { cells: up, values: upV, color: [205, 135, 70], alpha: 0.7 },
    { cells: down, values: downV, color: [120, 150, 190], alpha: 0.7 },
  ];
}

// 重画这一片：鼠标停下 150 毫秒后在 Worker 里按同一条路算一遍（只重算圈里、重新定海平面，海岸值与结果逐位相同），
// 地图上画出将来的海岸线，山会变高、变矮的地方涂橙、涂蓝；什么都不会变时拦下点击（历史里不多一步空的）
export function rerollTool(): ToolHandler {
  let pointer: Pointer | null = null;
  // 重画的圈至少 1.2 格：再小可能一格都不变
  const radius = (w: World) => Math.max(brushR(w, options.value.brushKm), w.mesh.spacing * 1.2);
  // 与命令同一份参数（variant 是下一次重画的编号）
  const rerollAt = (w: World, p: Pointer) => ({ x: keepX(w, p.x), y: p.y, radius: radius(w), variant: (w.small.terrain.gen?.rerolls.length ?? 0) + 1 });
  const keyOf = (w: World, r: ReturnType<typeof rerollAt>) => `${worldId(w)}|${r.x}|${r.y}|${r.radius}|${r.variant}`;
  type View = { t: TerrainPreview; layers: HighlightLayer[]; hint: string; empty: boolean };
  const exact = new Settle<View>();
  // 点了以后：等预览、算的期间（held：点的那一份预览）
  let clicking = false;
  let held: View | null = null;
  // 成本闸门（与确切预览同一个，见 state.ts 的 slowPreview）：上一次重画这一片（预览或执行）超过约 600 毫秒，
  // 就不再自动预览，说松手后大约要等几秒；不慢时为 0
  const slowSec = (r: ReturnType<typeof rerollAt>) => slowPreview({ op: 'reroll_region', ...r }) ?? 0;
  const request = (r: ReturnType<typeof rerollAt>) => async (): Promise<View | null> => {
    const t = await previewTerrainOnce({ reroll: r });
    if (!t) return null;
    if (t.ms !== undefined) noteCost({ op: 'reroll_region', ...r }, t.ms);
    const empty = !t.gained.length && !t.lost.length && !t.relief.cells.length;
    const hint = empty ? '重画不出变化' : t.gained.length || t.lost.length ? `重画：陆地 +${t.gained.length} / −${t.lost.length} 格` : '重画：只变山的高低';
    return { t, layers: reliefLayers(t.relief), hint, empty };
  };
  const want = (w: World, r: ReturnType<typeof rerollAt>) => {
    if (slowSec(r)) exact.stop();
    else exact.want(keyOf(w, r), request(r), 150);
  };
  const stop = () => exact.stop();
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave: stop,
    cancel: stop,
    // 点了以后算的期间鼠标离开地图，预览照样留着
    keep: () => clicking,
    async click(p) {
      const w = world.value;
      // 等预览的那一下（点得快时）还没发出命令：这期间再点不算，免得同一个编号重画两次
      if (!w || p.cell < 0 || isBusy() || clicking) return;
      const gen = w.small.terrain.gen;
      if (!gen) {
        showToast('空白海洋没有可重画的地形', true);
        return;
      }
      const r = rerollAt(w, p);
      const key = keyOf(w, r);
      // 还没预览过（点得快）：先算一遍再决定，慢的世界不等
      clicking = true;
      try {
        const v = exact.get(key) ?? (slowSec(r) ? null : await exact.now(key, request(r)));
        if (world.value !== w) return;
        if (v?.empty) {
          showToast('重画不出变化', true);
          return;
        }
        held = v;
        await exec({ op: 'reroll_region', ...r }, '正在计算…');
      } finally {
        clicking = false;
        held = null;
      }
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const ring: Shape = { kind: 'circle', x: pointer.x, y: pointer.y, r: radius(w), dashed: true, color: 'rgba(255, 220, 120, 0.95)', width: 2, geodesic: true };
      // 点了以后算的期间：一直画着点的那一份（鼠标挪开也不变，不闪回原来的海岸）
      if (held) return { layers: held.layers, shapes: [ring], hint: '正在计算…', terrain: held.t };
      if (pointer.cell < 0 || !w.small.terrain.gen) return { layers: [], shapes: [ring], hint: null };
      const r = rerollAt(w, pointer);
      if (!clicking) want(w, r);
      const x = exact.get(keyOf(w, r));
      if (x) return { layers: x.layers, shapes: [ring], hint: x.hint, warn: x.empty, terrain: x.empty ? null : x.t };
      const sec = slowSec(r);
      return { layers: [], shapes: [ring], hint: sec ? slowHint(sec) : null };
    },
  };
}
