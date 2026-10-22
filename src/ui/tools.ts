import type { Command } from '../../core/commands';
import { lakeArea } from '../../core/elevation';
import { endemicSpecies } from '../../core/endemic';
import { hexToRgb } from '../../core/export';
import { type GeoFeature, REGION_KIND_INFO, guessRegionKind } from '../../core/features';
import { arcUnits, densify, unwrapNear, wrapX } from '../../core/geo';
import { findCell } from '../../core/mesh';
import { type CutResult, type RiverPlan, brushCells, cutProvinces, growRegion, lassoStroke, planRiver, provinceCells, ringCells, ringWinding } from '../../core/select';
import { riverWidth } from '../../core/rivers';
import {
  ISLAND_KIND_INFO,
  type ChainSpec,
  type IslandSpec,
  chainIslands,
  combineStamps,
  islandRadiusKm,
  islandSizeRangeKm,
  islandStamp,
  landStroke,
  previewLand,
  reliefStroke,
  restoreStroke,
  roundKm as km,
} from '../../core/terrain';
import { regenTargets } from '../../core/provinces';
import { isVegetated } from '../../core/vegetation';
import type { Species } from '../../core/species';
import { type RegionKind, type World, provinceColor } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import type { Shape } from '../render/overlay';
import {
  type Again,
  type ToolOptions,
  busy,
  cancelPreviews,
  exec,
  focusName,
  focusSpecies,
  lakeRange,
  measure,
  onlyEditsPending,
  options,
  previewCommand,
  redrawTick,
  selectedFeature,
  selectedProvince,
  setOptions,
  sheet,
  showToast,
  sliderActive,
  world,
} from '../state';

// 地图工具：每个工具在动手前或动手时给出确切的预览（高亮的格、矢量图形、一句话），
// 松手后执行的命令与预览用同一份计算，所以结果与预览一致。

export interface Pointer {
  // 地图单位
  x: number;
  y: number;
  // 鼠标下的格；地图外为 -1
  cell: number;
  // 屏幕坐标（CSS 像素）
  sx: number;
  sy: number;
  shift: boolean;
  alt: boolean;
}

export interface Preview {
  layers: HighlightLayer[];
  shapes: Shape[];
  hint: string | null;
  warn?: boolean;
  // 拖底部条上的滑块时这句话也写出来（在鼠标最后停的地方，那里正预览着涂一下会怎样）；
  // 没有这一项时，拖滑块由滑块上的数说明，鼠标旁不写
  sliderHint?: boolean;
}

export interface ToolHandler {
  // 左键拖动是工具自己的手势；否则左键拖动平移地图，单击才是工具动作
  drags: boolean;
  down?(p: Pointer): void;
  move?(p: Pointer, pressed: boolean): void;
  up?(p: Pointer): Promise<void> | void;
  click?(p: Pointer): Promise<void> | void;
  cancel?(): void;
  // 鼠标离开地图
  leave?(): void;
  // 鼠标离开地图后预览还要留着（排队中的笔画：结果换上之前一直显示）
  keep?(): boolean;
  preview(): Preview;
}

const EMPTY: Preview = { layers: [], shapes: [], hint: null };

type RGB = [number, number, number];
const LAND_RGB: RGB = [120, 205, 95];
const SEA_RGB: RGB = [70, 150, 235];
const WHITE: RGB = [255, 255, 255];

// 画笔半径（地图单位）
const brushR = (w: World) => options.value.brushKm / w.kmPerUnit;
// 两点之间的距离（地图单位）：整个星球上是球面上的距离
const mapDist = (w: World, ax: number, ay: number, bx: number, by: number) => (w.mesh.kind === 'sphere' ? arcUnits(ax, ay, bx, by) : Math.hypot(ax - bx, ay - by));
// 整个星球：存进命令的经度绕回 [0, 2)
const keepX = (w: World, x: number) => (w.mesh.kind === 'sphere' ? wrapX(x) : x);
// 整个星球：圈绕着极点（在平铺图上圈不住任何地方）
const aroundPole = (w: World, ring: [number, number][]) => w.mesh.kind === 'sphere' && ringWinding(ring) !== 0;
// 正在计算时按下：说一声，不默默地忽略
let busyNoted = 0;
const busyNote = () => {
  if (performance.now() - busyNoted < 2000) return;
  busyNoted = performance.now();
  showToast('还在计算上一步，稍等一下');
};
const isBusy = () => {
  if (busy.value === null) return false;
  busyNote();
  return true;
};

// 一笔：经过的格与到笔画中心线的最近归一化距离 t（0 中心，1 边缘）
class Stroke {
  t = new Map<number, number>();
  private last: [number, number] | null = null;

  add(w: World, x: number, y: number, filter?: (i: number) => boolean) {
    const r = brushR(w);
    const last = this.last;
    const steps = last ? Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / (r * 0.4))) : 1;
    for (let k = 1; k <= steps; k++) {
      const px = last ? last[0] + ((x - last[0]) * k) / steps : x;
      const py = last ? last[1] + ((y - last[1]) * k) / steps : y;
      const b = brushCells(w, px, py, options.value.brushKm);
      b.cells.forEach((c, j) => {
        if (filter && !filter(c)) return;
        const prev = this.t.get(c);
        if (prev === undefined || b.t[j] < prev) this.t.set(c, b.t[j]);
      });
    }
    this.last = [x, y];
  }
  // 最后一下落在哪里（地图单位）
  get end(): [number, number] | null {
    return this.last;
  }
  get cells() {
    return [...this.t.keys()];
  }
  get ts() {
    return [...this.t.values()];
  }
  weights() {
    return this.ts.map((u) => 1 - u * u * (3 - 2 * u));
  }
}

// ---------- 通用的画笔工具 ----------

interface BrushConfig {
  // 鼠标悬停时的一句话：只在现在不能用时说（warn）；能用时一般不说（怎么用在工具的悬停提示里）
  hint: (shift: boolean) => { text: string | null; warn?: boolean };
  // 哪些格能被这一笔涂到
  filter?: (w: World, i: number) => boolean;
  layers: (w: World, s: Stroke, shift: boolean) => { layers: HighlightLayer[]; hint?: string; warn?: boolean };
  commit: (w: World, s: Stroke, shift: boolean) => Promise<unknown>;
  // 画笔圈画在半径的几倍处：最后一个是主圈（悬停时虚线、按住时实线），前面的是细实线。省略时只在半径处画一圈
  rings?: number[];
}

// 一笔涂多重的预览深浅：变化量占滑块最大值的比例，最淡也有 0.35（力度很小时也看得见涂到了哪里）
export const strengthValues = (deltas: number[], max: number) => deltas.map((d) => 0.35 + 0.65 * Math.min(1, Math.abs(d) / max));

// 画笔可以排队：前面的笔画还在算时照样能画，松手后按顺序执行，各自是一步（结果与一笔一笔等着画相同）。
// 排队中的笔画一直显示松手时的预览，直到结果换上（不先跳回原样，也不变成白色的“等待”）
function brushTool(cfg: BrushConfig): ToolHandler {
  let stroke: Stroke | null = null;
  let pointer: Pointer | null = null;
  // 鼠标在不在地图上：离开后只留排队中的笔画（拖滑块时照样在最后停的地方预览）
  let inside = false;
  let queued: { stroke: Stroke; layers: HighlightLayer[] }[] = [];
  // 空闲悬停只显示圈，不显示涂了会怎样。只有很小的画笔（半径不到 2 格，圈里看不出会碰到哪几格）
  // 另外描出一笔会涂到的格（只描边、不填色）；格没变就沿用同一个图层，不必重新上传
  let foot: { cells: number[]; layer: HighlightLayer } | null = null;
  const footprint = (w: World, p: Pointer): HighlightLayer[] => {
    if (brushR(w) > w.mesh.spacing * 2 || p.cell < 0) return [];
    const cells = brushCells(w, p.x, p.y, options.value.brushKm).cells.filter((i) => !cfg.filter || cfg.filter(w, i));
    if (!foot || foot.cells.length !== cells.length || foot.cells.some((c, k) => c !== cells[k])) foot = { cells, layer: { cells, color: WHITE, pattern: 'outline' } };
    return [foot.layer];
  };
  // 拖底部条上的滑块（半径、力度、过渡……）时：在鼠标最后停的地方预览涂一下会怎样，大小、深浅跟着滑块变，
  // 旁边写出这一下的变化量（如“堆山 约 +600 m”）
  let dab: { w: World; o: ToolOptions; p: Pointer; layers: HighlightLayer[]; hint: string | null; warn?: boolean } | null = null;
  const dabAt = (w: World, p: Pointer) => {
    if (dab?.w !== w || dab.o !== options.value || dab.p !== p) {
      const s = new Stroke();
      if (p.cell >= 0) s.add(w, p.x, p.y, cfg.filter && ((i) => cfg.filter!(w, i)));
      // 特别大的画笔（两万格以上）不预览，免得拖滑块卡顿
      const r = s.t.size && s.t.size <= 20000 ? cfg.layers(w, s, p.shift) : null;
      dab = { w, o: options.value, p, layers: r?.layers ?? [], hint: r?.hint ?? null, warn: r?.warn };
    }
    return dab;
  };
  const ringsAt = (w: World, p: Pointer): Shape[] => {
    const r = brushR(w);
    const ks = cfg.rings ?? [1];
    return ks.map((k, j): Shape =>
      j === ks.length - 1
        ? { kind: 'circle', x: p.x, y: p.y, r: r * k, dashed: !stroke, geodesic: true }
        : { kind: 'circle', x: p.x, y: p.y, r: r * k, color: 'rgba(255, 255, 255, 0.6)', width: 1, geodesic: true },
    );
  };
  return {
    drags: true,
    down(p) {
      const w = world.value;
      inside = true;
      if (!w || p.cell < 0 || stroke) return;
      // 正在新建、打开、导出时不能画（世界可能马上换掉）；只是在算前面的编辑时可以排队
      if (busy.value !== null && !onlyEditsPending()) return busyNote();
      const h = cfg.hint(p.shift);
      if (h.warn) {
        showToast(h.text ?? '现在不能用', true);
        return;
      }
      stroke = new Stroke();
      stroke.add(w, p.x, p.y, cfg.filter && ((i) => cfg.filter!(w, i)));
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      inside = true;
      const w = world.value;
      if (pressed && stroke && w) stroke.add(w, p.x, p.y, cfg.filter && ((i) => cfg.filter!(w, i)));
    },
    async up(p) {
      const w = world.value;
      const s = stroke;
      stroke = null;
      if (!w || !s || !s.t.size) return;
      // 松手时的预览留在图上，直到这一笔的结果换上
      const q = { stroke: s, layers: cfg.layers(w, s, p.shift).layers };
      queued.push(q);
      try {
        await cfg.commit(w, s, p.shift);
      } finally {
        queued = queued.filter((x) => x !== q);
        redrawTick.value++;
      }
    },
    cancel() {
      stroke = null;
    },
    leave() {
      inside = false;
    },
    keep: () => queued.length > 0,
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      // 排队时世界还没换上前面笔画的结果：每一笔照旧显示松手时的预览
      const waiting = queued.flatMap((q) => q.layers);
      const inLine = queued.length ? `正在计算…（${queued.length} 笔）` : null;
      if (!stroke) {
        if (!inside && !sliderActive.value) return waiting.length ? { layers: waiting, shapes: [], hint: null } : EMPTY;
        const h = cfg.hint(pointer.shift);
        if (sliderActive.value && !h.warn) {
          const d = dabAt(w, pointer);
          return { layers: [...waiting, ...d.layers], shapes: ringsAt(w, pointer), hint: inLine ?? d.hint, warn: d.warn, sliderHint: true };
        }
        return { layers: [...waiting, ...(h.warn ? [] : footprint(w, pointer))], shapes: ringsAt(w, pointer), hint: inLine ?? h.text, warn: h.warn };
      }
      const r = cfg.layers(w, stroke, pointer.shift);
      return { layers: [...waiting, ...r.layers], shapes: ringsAt(w, pointer), hint: queued.length ? `排队中：前面还有 ${queued.length} 笔` : (r.hint ?? null), warn: r.warn };
    },
  };
}

// ---------- 地形 ----------

export function landTool(): ToolHandler {
  const modeOf = (shift: boolean) => {
    const m = options.value.landMode;
    return shift ? (m === 'land' ? 'sea' : 'land') : m;
  };
  const brush = brushTool({
    hint: () => ({ text: null }),
    layers(w, s, shift) {
      const mode = modeOf(shift);
      const r = landStroke(w, s.cells, s.ts, mode);
      const p = previewLand(w, r.cells, r.delta);
      return {
        layers: [
          { cells: p.gained, color: LAND_RGB, alpha: 0.75 },
          { cells: p.lost, color: SEA_RGB, alpha: 0.75 },
        ],
        hint: mode === 'land' ? `陆地 +${p.gained.length} 格` : `陆地 −${p.lost.length} 格`,
      };
    },
    commit: (_w, s, shift) => exec({ op: 'paint_land', cells: s.cells, t: s.ts, mode: modeOf(shift) }),
    // 0.7 倍半径以内一定变（细实线）；海岸平均落在 0.85 倍处（主圈），再往外只是零星几格
    rings: [0.7, 0.85],
  });
  const lasso = lassoTool(modeOf);
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
    keep: () => !!brush.keep?.(),
    preview: () => (active ?? chosen()).preview(),
  };
}

// 圈一片：按住画一个圈，松手后圈里变成陆地（或海），边上和画笔一样是自然的海岸。
// 预览与松手后提交的是同一个圈（每移动半格记一个点），所以绿色的格就是结果
function lassoTool(modeOf: (shift: boolean) => 'land' | 'sea'): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let committing = false;
  let cache: { key: string; cells: number[]; t: number[]; gained: number[]; lost: number[] } | null = null;
  const compute = (w: World, pts: [number, number][], mode: 'land' | 'sea') => {
    const key = `${worldId(w)}|${ringId}|${pts.length}|${mode}`;
    if (cache?.key === key) return cache;
    const r = lassoStroke(w, pts);
    const st = landStroke(w, r.cells, r.t, mode);
    const p = previewLand(w, st.cells, st.delta);
    cache = { key, cells: r.cells, t: r.t, gained: p.gained, lost: p.lost };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || p.cell < 0 || isBusy() || committing) return;
      ring = [[p.x, p.y]];
      ringId++;
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w || committing) return;
      const [lx, ly] = ring[ring.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) >= w.mesh.spacing * 0.5) ring.push([p.x, p.y]);
    },
    async up(p) {
      const w = world.value;
      const pts = ring;
      if (!w || !pts || committing) return;
      const mode = modeOf(p.shift);
      if (aroundPole(w, pts)) {
        ring = null;
        showToast('圈不能绕着极点画', true);
        return;
      }
      const c = pts.length >= 3 ? compute(w, pts, mode) : null;
      const count = c ? (mode === 'land' ? c.gained.length : c.lost.length) : 0;
      if (!c || !count) {
        ring = null;
        showToast(!c ? '圈太小了：按住拖一圈再松手' : mode === 'land' ? '圈里已经都是陆地了' : '圈里没有陆地', true);
        return;
      }
      committing = true;
      try {
        await exec({ op: 'paint_land', cells: c.cells, t: c.t, mode });
      } finally {
        committing = false;
        ring = null;
      }
    },
    cancel() {
      if (!committing) ring = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const mode = modeOf(pointer.shift);
      if (!ring) {
        return EMPTY;
      }
      const shapes: Shape[] = [{ kind: 'line', points: ring, color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }];
      if (ring.length < 3) return { layers: [], shapes, hint: null };
      shapes.push({ kind: 'line', points: [ring[ring.length - 1], ring[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5, dashed: true });
      if (aroundPole(w, ring)) return { layers: [], shapes, hint: '绕着极点了，松手不会生效', warn: true };
      const c = compute(w, ring, mode);
      return {
        layers: [
          { cells: c.gained, color: LAND_RGB, alpha: 0.75 },
          { cells: c.lost, color: SEA_RGB, alpha: 0.75 },
        ],
        shapes,
        hint: committing ? '正在计算…' : mode === 'land' ? `陆地 +${c.gained.length} 格` : `陆地 −${c.lost.length} 格`,
      };
    },
  };
}

// 恢复原样：画到的地方，画过的陆地、海、山和放的岛都退回生成时的样子（中间全收回，边上渐变）。
// 只涂得到改过的格；绿色会变回陆地，蓝色会变回海
export function restoreTool(): ToolHandler {
  const edited = (w: World, i: number) => w.causes.landDelta[i] !== 0 || w.causes.upliftDelta[i] !== 0 || w.causes.erodDelta[i] !== 0;
  return brushTool({
    hint: () => ({ text: null }),
    filter: edited,
    layers(w, s) {
      const r = restoreStroke(w, s.cells, s.ts);
      const p = previewLand(w, r.cells, r.delta);
      return {
        layers: [
          { cells: s.cells, values: s.weights(), color: WHITE, alpha: 0.35 },
          { cells: p.gained, color: LAND_RGB, alpha: 0.75 },
          { cells: p.lost, color: SEA_RGB, alpha: 0.75 },
        ],
        hint: !s.t.size ? '这里没改过' : p.gained.length || p.lost.length ? `陆地 +${p.gained.length} / −${p.lost.length} 格` : `恢复 ${s.t.size} 格`,
      };
    },
    async commit(_w, s) {
      if (!s.t.size) {
        showToast('这里的地形没改过', true);
        return;
      }
      await exec({ op: 'restore_terrain', cells: s.cells, t: s.ts }, '正在计算地形…');
    },
    // 0.7 倍半径以内全收回（细实线），往外到半径处渐变
    rings: [0.7, 1],
  });
}

// 堆山 / 压低的力度最大是多少（底部条滑块的上限，预览深浅按它算）
export const RELIEF_MAX = 1.6;

// 堆山 / 压低一笔大约让地势升降多少米（提示里的“约 +900 m”）：堆山是笔下最高处升多少，压低是 cell 这一格降多少。
// 经验估计（在几种大小、格数的地图上量过，几处的中位数差不到一倍，个别地方差得更多）：
// 堆山与力度^0.9、画笔半径（格）^0.75、“最高的山”成正比，抬升量最多到 2，已经很高的地方堆不了那么多；
// 压低最多压到接近海平面：按 cell 现在的高度、笔下平均的抬升量能减掉几成估计。cells：这一笔涂到的格
export function reliefEstimateM(w: World, cells: number[], cell: number, strength: number): number {
  const rc = Math.max(0.5, brushR(w) / w.mesh.spacing);
  let u = 0;
  for (const i of cells) u += w.causes.uplift[i];
  u /= Math.max(1, cells.length);
  if (strength >= 0) {
    const s = Math.max(0, Math.min(strength, 2 - u));
    return 0.2 * w.small.planet.mountainScale * Math.pow(s, 0.9) * Math.pow(rc, 0.75);
  }
  const frac = Math.min(u, -strength) / (0.035 + u);
  return -Math.max(0, w.derived.elevation[cell]) * frac * Math.min(1, 0.35 * Math.pow(rc, 0.55));
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
  // 估计高度变化用的格：最后一下落的那一格；不在陆地上时取这一笔离它最近的陆地格
  const cellOf = (w: World, s: Stroke) => {
    const cells = s.cells;
    const [x, y] = s.end ?? [w.mesh.x[cells[0]], w.mesh.y[cells[0]]];
    const c = findCell(w.mesh, x, y);
    if (w.causes.land[c]) return c;
    let best = cells[0];
    let bd = Infinity;
    for (const i of cells) {
      const d = mapDist(w, w.mesh.x[i], w.mesh.y[i], x, y);
      if (d < bd) [best, bd] = [i, d];
    }
    return best;
  };
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
        hint: s.t.size ? `${name} ${fmtMeters(reliefEstimateM(w, s.cells, cellOf(w, s), strength))}` : name,
      };
    },
    commit: (_w, s, shift) => exec({ op: 'paint_relief', cells: s.cells, t: s.ts, strength: sign(shift) * options.value.reliefAmount }, '正在计算地形…'),
  });
}

// 世界的编号：用来判断预览缓存是否过期
const worldIds = new WeakMap<World, number>();
let nextWorldId = 1;
const worldId = (w: World) => {
  let id = worldIds.get(w);
  if (!id) worldIds.set(w, (id = nextWorldId++));
  return id;
};

// 岛的大小取整成好读的直径：气泡、提示、历史里是同一个数
export const snapRadiusKm = (r: number) => km(r * 2) / 2;

// “换个形状”：同一个位置换下一个形状重放（替换刚放的那个岛）
function islandAgain(spec: IslandSpec): Again {
  let cur = spec;
  return {
    label: '换个形状',
    next: () => {
      cur = { ...cur, variant: options.value.islandVariant };
      setOptions({ islandVariant: cur.variant + 1 });
      return { op: 'add_island', island: cur };
    },
  };
}

// 点一下：用底部滑块的大小放岛；按住往外拖：拖多远岛就多大（松手后滑块也停在这个大小）
export function islandTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: { x: number; y: number; cell: number; sx: number; sy: number; km: number | null } | null = null;
  let committing = false;
  let cache: { key: string; preview: Preview; spec: IslandSpec | null; block: string | null } | null = null;
  const compute = () => {
    const w = world.value;
    if (!w || !pointer) return null;
    const center = drag ?? (pointer.cell >= 0 ? pointer : null);
    if (!center) return null;
    const o = options.value;
    const spec: IslandSpec = { x: keepX(w, center.x), y: center.y, kind: o.islandKind, size: drag?.km ?? o.islandKm, variant: o.islandVariant };
    const key = `${worldId(w)}|${spec.x.toFixed(5)},${spec.y.toFixed(5)}|${spec.kind}|${spec.size}|${spec.variant}`;
    if (cache?.key === key) return cache;
    const name = ISLAND_KIND_INFO[spec.kind].name;
    const diameter = km(islandRadiusKm(w, spec.size) * 2);
    let block: string | null = null;
    if (spec.kind === 'atoll' && !w.causes.land[center.cell] && w.derived.tMean[center.cell] < 20) {
      block = `海水太凉（${Math.round(w.derived.tMean[center.cell])} °C），珊瑚岛要 20 °C 以上`;
    }
    const stamp = islandStamp(w, spec);
    const fresh = stamp.footprint.filter((c) => !w.causes.land[c]);
    if (!block && !fresh.length) block = '这里已经是陆地';
    const preview: Preview = {
      layers: [{ cells: stamp.footprint, color: block ? [230, 90, 70] : LAND_RGB, alpha: 0.75 }],
      shapes: drag?.km ? [{ kind: 'line', points: [[drag.x, drag.y], [pointer.x, pointer.y]], color: 'rgba(255,255,255,0.85)', width: 1.5, dashed: true }] : [],
      hint: block ?? `${name} · ${diameter} km`,
      warn: !!block,
    };
    cache = { key, preview, spec, block };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || p.cell < 0 || isBusy() || committing) return;
      pointer = p;
      drag = { x: p.x, y: p.y, cell: p.cell, sx: p.sx, sy: p.sy, km: null };
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !drag || !w) return;
      // 拖出 6 像素以上才算在拖大小，手抖不算
      if (Math.hypot(p.sx - drag.sx, p.sy - drag.sy) <= 6) drag.km = null;
      else {
        const [lo, hi] = islandSizeRangeKm(w);
        drag.km = snapRadiusKm(Math.min(hi, Math.max(lo, mapDist(w, p.x, p.y, drag.x, drag.y) * w.kmPerUnit)));
      }
    },
    async up(p) {
      pointer = p;
      const d = drag;
      if (!d || committing) return;
      const c = compute();
      if (!c?.spec) {
        drag = null;
        return;
      }
      if (c.block) {
        drag = null;
        showToast(c.block, true);
        return;
      }
      const spec = c.spec;
      committing = true;
      // 滑块停在拖出的大小；下一个岛换个形状（悬停的预览里看得到）
      setOptions({ islandVariant: spec.variant + 1, ...(d.km !== null ? { islandKm: d.km } : {}) });
      try {
        await exec({ op: 'add_island', island: spec }, '正在造岛…', islandAgain(spec));
      } finally {
        committing = false;
        drag = null;
      }
    },
    cancel() {
      if (!committing) drag = null;
    },
    preview() {
      const c = compute();
      if (!c) return EMPTY;
      return committing ? { ...c.preview, hint: '正在计算…' } : c.preview;
    },
  };
}

// “换个排列”：同一条线换下一种排列重放
function chainAgain(chain: ChainSpec): Again {
  let cur = chain;
  return {
    label: '换个排列',
    next: () => {
      cur = { ...cur, variant: options.value.chainVariant };
      setOptions({ chainVariant: cur.variant + 1 });
      return { op: 'add_island_chain', chain: cur };
    },
  };
}

export function chainTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let points: [number, number][] | null = null;
  let lastScreen: [number, number] = [0, 0];
  let committing = false;
  let cache: { key: string; preview: Preview } | null = null;
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
    return { points: use, kind: o.islandKind, size: o.islandKm, density: o.chainDensity, variant: o.chainVariant };
  };
  return {
    drags: true,
    down(p) {
      if (isBusy() || committing) return;
      points = [[p.x, p.y]];
      lastScreen = [p.sx, p.sy];
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      if (pressed && points && !committing && Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 10) {
        points.push([p.x, p.y]);
        lastScreen = [p.sx, p.sy];
      }
    },
    async up(p) {
      const pts = points;
      if (!pts || committing) return;
      if (Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 2) pts.push([p.x, p.y]);
      if (pts.length < 2) {
        points = null;
        showToast('按住鼠标拖出一条线，岛会沿着线排开', true);
        return;
      }
      committing = true;
      const chain = specFor(pts);
      setOptions({ chainVariant: chain.variant + 1 });
      try {
        await exec({ op: 'add_island_chain', chain }, '正在造岛链…', chainAgain(chain));
      } finally {
        committing = false;
        points = null;
      }
    },
    cancel() {
      if (!committing) points = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (!points || points.length < 2) return EMPTY;
      const spec = specFor(points);
      const key = `${worldId(w)}|${JSON.stringify(spec)}`;
      if (cache?.key !== key) {
        const islands = chainIslands(w, spec);
        const stamp = combineStamps(w, islands);
        cache = {
          key,
          preview: {
            layers: [{ cells: stamp.footprint, color: LAND_RGB, alpha: 0.75 }],
            shapes: [{ kind: 'line', points: spec.points, dashed: true, color: 'rgba(255,255,255,0.8)' }],
            hint: `${islands.length} 个${ISLAND_KIND_INFO[spec.kind].name}`,
          },
        };
      }
      return committing ? { ...cache.preview, hint: '正在计算…' } : cache.preview;
    },
  };
}

export function rerollTool(): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    async click(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy()) return;
      const gen = w.small.terrain.gen;
      if (!gen) {
        showToast('空白海洋没有可以重画的地形；先用“画陆地”或“放岛”', true);
        return;
      }
      await exec({ op: 'reroll_region', x: keepX(w, p.x), y: p.y, radius: brushR(w), variant: gen.rerolls.length + 1 }, '正在重画…');
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      return {
        layers: [],
        shapes: [{ kind: 'circle', x: pointer.x, y: pointer.y, r: brushR(w), dashed: true, color: 'rgba(255, 220, 120, 0.95)', width: 2, geodesic: true }],
        hint: null,
      };
    },
  };
}

// ---------- 自然 ----------

const speciesOf = (w: World, id: string | null) => (id ? w.small.species.find((s) => s.id === id) : undefined);

function constraintCmd(cells: number[], species: string) {
  const o = options.value;
  return { op: 'add_constraint' as const, constraint: { cells, species, mode: o.biomeMode === 'natural' ? ('constraint' as const) : ('override' as const), ratio: 1, radius: o.reachKm, label: '' } };
}

export function biomeTool(): ToolHandler {
  return brushTool({
    hint: () => {
      const w = world.value;
      const sp = w && speciesOf(w, options.value.biome);
      if (!sp) return { text: '先在右上角“生态”里选一种', warn: true };
      return { text: null };
    },
    filter: (w, i) => isVegetated(w, w.derived, i),
    layers(w, s) {
      const sp = speciesOf(w, options.value.biome)!;
      return { layers: [{ cells: s.cells, color: hexToRgb(sp.color), alpha: 0.8 }], hint: `${sp.name} ${s.t.size} 格` };
    },
    commit: (_w, s) => exec(constraintCmd(s.cells, options.value.biome!), '正在计算生态…'),
  });
}

// 同一种生态、离按下处不超过画笔半径的连片格：拖动扩张的“起点地块”
function patchAt(w: World, cell: number): number[] {
  const { mesh } = w;
  const s = w.derived.dominant[cell];
  const r = brushR(w);
  const out = [cell];
  const seen = new Set(out);
  for (let h = 0; h < out.length; h++) {
    const c = out[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (seen.has(j) || w.derived.dominant[j] !== s || !w.causes.land[j]) continue;
      seen.add(j);
      if (mapDist(w, mesh.x[j], mesh.y[j], mesh.x[cell], mesh.y[cell]) <= r) out.push(j);
    }
  }
  return out;
}

export function growTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let start: { x: number; y: number; cell: number; region: number[]; species: number } | null = null;
  let committing = false;
  let cache: { key: string; grown: number[] } | null = null;
  const grownNow = (w: World): number[] => {
    if (!start || !pointer) return [];
    const dx = pointer.x - start.x;
    const dy = pointer.y - start.y;
    const reach = mapDist(w, pointer.x, pointer.y, start.x, start.y) * w.kmPerUnit;
    const key = `${worldId(w)}|${start.cell}|${dx.toFixed(5)},${dy.toFixed(5)}|${options.value.brushKm}`;
    if (cache?.key !== key) cache = { key, grown: reach > 0 ? growRegion(w, w.derived, start.region, start.species, reach, [dx, dy], [start.x, start.y]) : [] };
    return cache.grown;
  };
  return {
    drags: true,
    down(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy() || committing) return;
      const s = w.derived.dominant[p.cell];
      if (s < 0 || !isVegetated(w, w.derived, p.cell)) {
        showToast('在一片有生态的陆地上按住，再往外拖', true);
        return;
      }
      start = { x: p.x, y: p.y, cell: p.cell, region: patchAt(w, p.cell), species: s };
      pointer = p;
    },
    move(p) {
      pointer = p;
    },
    async up() {
      const w = world.value;
      if (!w || !start || committing) return;
      const grown = grownNow(w);
      const sp = w.small.species[start.species];
      if (!grown.length || !sp) {
        start = null;
        return;
      }
      committing = true;
      try {
        await exec(constraintCmd(grown, sp.id), '正在计算生态…');
      } finally {
        committing = false;
        start = null;
        cache = null;
      }
    },
    cancel() {
      if (!committing) start = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (!start) {
        const c = pointer.cell;
        const s = c >= 0 ? w.derived.dominant[c] : -1;
        if (s < 0) return EMPTY;
        const sp = w.small.species[s];
        return {
          layers: [{ cells: patchAt(w, c), color: WHITE, alpha: 0.3 }],
          shapes: [],
          hint: sp.name,
        };
      }
      const sp = w.small.species[start.species];
      const grown = grownNow(w);
      return {
        layers: [
          { cells: start.region, color: WHITE, alpha: 0.3 },
          { cells: grown, color: hexToRgb(sp.color), alpha: 0.8 },
        ],
        shapes: [{ kind: 'arrow', points: [[start.x, start.y], [pointer.x, pointer.y]], color: 'rgba(255, 240, 140, 0.95)', width: 2.5 }],
        hint: committing ? '正在计算…' : `${sp.name} +${grown.length} 格`,
      };
    },
  };
}

export const CLIMATE_INFO = {
  warm: { name: '更暖', color: [235, 110, 70] as RGB, flip: 'cold' },
  cold: { name: '更冷', color: [90, 150, 235] as RGB, flip: 'warm' },
  wet: { name: '更湿', color: [60, 190, 170] as RGB, flip: 'dry' },
  dry: { name: '更干', color: [225, 190, 90] as RGB, flip: 'wet' },
} as const;
type ClimateKind = keyof typeof CLIMATE_INFO;

// 冷暖干湿、自定义场的力度最大是多少（底部条滑块的上限，预览深浅按它算）
export const CLIMATE_MAX = 2;
export const FIELD_MAX = 1;

// 力度 1：中心升降 4 °C，或雨水乘除 e^0.5（多约 65% / 少约 39%）。short 是底部条上滑块右边的数
export function climateEffect(c: ClimateKind, amount: number): { field: 'tempOffset' | 'moistOffset'; value: number; text: string; short: string } {
  if (c === 'warm' || c === 'cold') {
    const v = (c === 'warm' ? 4 : -4) * amount;
    const deg = Math.abs(v).toFixed(Math.abs(v) < 2 ? 1 : 0);
    return { field: 'tempOffset', value: v, text: `中心${v > 0 ? '升温' : '降温'}约 ${deg} °C`, short: `${v > 0 ? '+' : '−'}${deg} °C` };
  }
  const v = (c === 'wet' ? 0.5 : -0.5) * amount;
  const pct = Math.round(Math.abs(Math.exp(v) - 1) * 100);
  return { field: 'moistOffset', value: v, text: `中心雨水${v > 0 ? '多' : '少'}约 ${pct}%`, short: `雨水${v > 0 ? '+' : '−'}${pct}%` };
}

// 冷暖（group = temp）或干湿（moist）画笔；按住 Shift 反着来：更暖 ↔ 更冷，更湿 ↔ 更干
export function climateKind(group: 'temp' | 'moist'): ClimateKind {
  return group === 'temp' ? options.value.tempMode : options.value.moistMode;
}

export function climateTool(group: 'temp' | 'moist'): ToolHandler {
  const kindOf = (shift: boolean): ClimateKind => (shift ? CLIMATE_INFO[climateKind(group)].flip : climateKind(group));
  return brushTool({
    hint: () => ({ text: null }),
    layers(_w, s, shift) {
      const c = kindOf(shift);
      const amount = options.value.climateAmount;
      // 深浅跟着力度：拖“力度”滑块时预览跟着变
      const values = strengthValues(s.weights().map((wt) => wt * amount), CLIMATE_MAX);
      return { layers: [{ cells: s.cells, values, color: CLIMATE_INFO[c].color, alpha: 0.65 }], hint: `${CLIMATE_INFO[c].name} ${climateEffect(c, amount).short}` };
    },
    commit(_w, s, shift) {
      const e = climateEffect(kindOf(shift), options.value.climateAmount);
      return exec({ op: 'paint', field: e.field, cells: s.cells, values: s.weights().map((wt) => wt * e.value), mode: 'add' }, '正在计算气候…');
    },
  });
}

// 擦掉冷暖干湿的改动：只涂得到改过的格，中心全收回、边缘渐变
export function climateEraseTool(): ToolHandler {
  const changed = (w: World, i: number) => w.causes.tempOffset[i] !== 0 || w.causes.moistOffset[i] !== 0;
  return brushTool({
    hint: () => ({ text: null }),
    filter: changed,
    layers(_w, s) {
      return { layers: [{ cells: s.cells, values: s.weights(), color: WHITE, alpha: 0.6 }], hint: s.t.size ? `擦掉 ${s.t.size} 格` : '这里没改过' };
    },
    async commit(_w, s) {
      if (!s.t.size) {
        showToast('这里的冷暖干湿没改过', true);
        return;
      }
      await exec({ op: 'restore_climate', cells: s.cells, t: s.ts }, '正在计算气候…');
    },
  });
}

// 每格属于哪个陆块要素（大陆或岛），按世界缓存
const landmassCache = new WeakMap<World, Map<number, GeoFeature>>();
export function landmassOf(w: World, cell: number): GeoFeature | null {
  let m = landmassCache.get(w);
  if (!m) {
    m = new Map();
    for (const f of w.derived.features) if (f.type === 'island' || f.type === 'continent') for (const c of f.cells) m.set(c, f);
    landmassCache.set(w, m);
  }
  return m.get(cell) ?? null;
}

// 岛屿特有生态：点一个岛，岛上最多的那种生态换成只长在这个岛上的特有版本（名字、颜色跟着岛）。
// 悬停时先在岛上标出会换成特有版本的格；一个岛只有一种，再点就是选中它
export function endemicTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let cache: { w: World; anchor: number; sp: Species | null; cells: number[] } | null = null;
  const plan = (w: World, f: GeoFeature) => {
    if (cache?.w !== w || cache.anchor !== f.anchor) {
      const cells = Array.from(f.cells);
      const sp = endemicSpecies(w, cells, `endemic_${f.anchor}`, f.name);
      const base = sp ? w.small.species.findIndex((x) => sp.name === `${f.name}${x.name || x.id}`) : -1;
      cache = { w, anchor: f.anchor, sp, cells: cells.filter((c) => w.derived.dominant[c] === base) };
    }
    return cache;
  };
  const existing = (w: World, f: GeoFeature) => w.small.species.find((s) => s.id === `endemic_${f.anchor}`);
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    async click(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy()) return;
      const f = landmassOf(w, p.cell);
      if (!f || f.type !== 'island') {
        showToast(f ? '只能点岛' : '点一个岛', true);
        return;
      }
      const old = existing(w, f);
      if (old) {
        setOptions({ biome: old.id });
        showToast(`这个岛已经有：${old.name}`);
        return;
      }
      const { sp } = plan(w, f);
      if (!sp) {
        showToast('这个岛上没有能长东西的地方', true);
        return;
      }
      const edit = () => {
        focusSpecies.value = sp.id;
        setOptions({ biome: sp.id });
        sheet.value = 'species';
      };
      if (await exec({ op: 'add_species', species: sp }, '正在创造生态…', undefined, { label: '编辑', run: edit })) setOptions({ biome: sp.id });
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const f = pointer.cell >= 0 ? landmassOf(w, pointer.cell) : null;
      if (!f) return EMPTY;
      if (f.type !== 'island') return { layers: [], shapes: [], hint: '只能点岛', warn: true };
      const old = existing(w, f);
      if (old) return { layers: [], shapes: [], hint: `已有：${old.name}` };
      const { sp, cells } = plan(w, f);
      if (!sp) return { layers: [], shapes: [], hint: '岛上没有能长东西的地方', warn: true };
      return { layers: [{ cells, color: hexToRgb(sp.color), alpha: 0.85 }], shapes: [], hint: sp.name };
    },
  };
}

export function eraseTool(): ToolHandler {
  const painted = (w: World) => {
    const set = new Set<number>();
    for (const c of w.small.constraints) for (const i of c.cells) set.add(i);
    return set;
  };
  let cachePainted: { w: World; set: Set<number> } | null = null;
  const paintedOf = (w: World) => {
    if (cachePainted?.w !== w) cachePainted = { w, set: painted(w) };
    return cachePainted.set;
  };
  return brushTool({
    hint: () => ({ text: null }),
    filter: (w, i) => paintedOf(w).has(i),
    layers(_w, s) {
      return { layers: [{ cells: s.cells, color: WHITE, alpha: 0.6 }], hint: s.t.size ? `擦掉 ${s.t.size} 格` : '这里没涂过' };
    },
    async commit(_w, s) {
      if (!s.t.size) {
        showToast('这里没有涂过的生态', true);
        return;
      }
      await exec({ op: 'erase_constraints', cells: s.cells }, '正在计算生态…');
    },
  });
}

// 自定义场：按住拖动增加或减少（中心多、边缘少），按住 Shift 反过来
export function fieldTool(): ToolHandler {
  const sign = (shift: boolean) => ((options.value.fieldMode === 'add') !== shift ? 1 : -1);
  return brushTool({
    hint: () => {
      const name = options.value.field;
      const w = world.value;
      if (!name || !w?.causes.fields[name]) return { text: '先在“调整”里新建自定义场', warn: true };
      return { text: null };
    },
    layers(_w, s, shift) {
      const amount = options.value.fieldAmount;
      // 深浅跟着力度：拖“力度”滑块时预览跟着变；提示写出中心变多少
      const values = strengthValues(s.weights().map((wt) => wt * amount), FIELD_MAX);
      const up = sign(shift) > 0;
      return { layers: [{ cells: s.cells, values, color: up ? [190, 120, 230] : [120, 120, 140], alpha: 0.65 }], hint: `${options.value.field} ${up ? '变大' : '变小'}：中心 ${up ? '+' : '−'}${amount.toFixed(2)}` };
    },
    commit(_w, s, shift) {
      const amount = sign(shift) * options.value.fieldAmount;
      return exec({ op: 'paint', field: `field:${options.value.field}`, cells: s.cells, values: s.weights().map((wt) => wt * amount), mode: 'add' }, '正在计算…');
    },
  });
}

// ---------- 水 ----------

// 河的大小（“河流多少”门槛的倍数）叫什么
export const riverSizeName = (flow: number) => (flow < 3 ? '小河' : flow < 15 ? '中等的河' : '大河');

// 流量取两位有效数字，好读
export const fmtFlow = (q: number) => {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(q, 1))) - 1));
  return (Math.round(q / p) * p).toLocaleString();
};

// 一组格连成几片（相邻的算一片）
function groupCount(w: World, cells: number[]): number {
  const left = new Set(cells);
  let groups = 0;
  for (const c of cells) {
    if (!left.has(c)) continue;
    groups++;
    left.delete(c);
    const queue = [c];
    for (let h = 0; h < queue.length; h++) {
      for (let e = w.mesh.off[queue[h]]; e < w.mesh.off[queue[h] + 1]; e++) {
        const j = w.mesh.adj[e];
        if (left.delete(j)) queue.push(j);
      }
    }
  }
  return groups;
}

// 汇入的那条河叫什么（只有大河有名字）
const riverNameAt = (w: World, cell: number) => w.derived.features.find((f) => f.type === 'river' && f.cells.includes(cell))?.name || null;

// 画河：从陆地上点源头或拖出路线是一条新河，碰到别的河就汇进去；从河上往外拖是改道。
// 改道时先按流量估算会变干的河段（红色虚线），手停下来后在世界的副本上确切地算一遍，
// 换成确切的结果：红色是会消失的河段，蓝色是别处会多出来的
export function riverTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: { cells: number[]; sx: number; sy: number; moved: boolean } | null = null;
  let committing = false;
  let cache: { key: string; plan: RiverPlan } | null = null;
  let exact: { key: string; removed: number[]; added: number[] } | null = null;
  let exactKey = '';
  let exactTimer: ReturnType<typeof setTimeout> | null = null;
  const planNow = (w: World): RiverPlan | null => {
    const pts = drag?.cells ?? (pointer && pointer.cell >= 0 ? [pointer.cell] : []);
    if (!pts.length) return null;
    const key = `${worldId(w)}|${pts.join(',')}`;
    if (cache?.key !== key) cache = { key, plan: planRiver(w, w.derived, pts) };
    return cache.plan;
  };
  const planKey = (w: World, p: RiverPlan) => `${worldId(w)}|${p.cells.join(',')}`;
  // 终点怎么说：“汇入「赤江」”；写进历史时不带引号
  const endText = (w: World, p: RiverPlan, quoted: boolean) => {
    if (p.end === 'river') {
      const name = riverNameAt(w, p.join);
      return name ? (quoted ? `汇入「${name}」` : `汇入${name}`) : '汇入一条河';
    }
    return p.end === 'sea' ? '入海' : p.end === 'lake' ? '流进湖里' : p.end === 'edge' ? '流出地图' : '';
  };
  const lengthKm = (w: World, cells: number[]) => km(cells.length * w.mesh.spacing * w.kmPerUnit);
  // 松手后执行的命令（确切预览用的也是它）。从画过的河的源头改道等于重画它：泉水和大小照旧
  const commandFor = (w: World, p: RiverPlan): Command => {
    const src = p.reroute ? w.small.guides.find((g) => g.spring && g.cells[0] === p.cells[0]) : undefined;
    const guide = p.reroute
      ? { cells: p.cells, locked: true, spring: !!src, ...(src?.flow !== undefined ? { flow: src.flow } : {}) }
      : { cells: p.cells, locked: true, spring: true, flow: options.value.riverFlow };
    const label = `${p.reroute ? '让河改道' : '画了一条河'}（约 ${lengthKm(w, p.cells)} km，${endText(w, p, false)}）`;
    return { op: 'add_guide', guide, ...(p.reroute ? { reroute: true } : {}), label };
  };
  // 改道：路线停下来 150 毫秒后算确切的结果
  const wantExact = (w: World, p: RiverPlan) => {
    const key = planKey(w, p);
    if (key === exactKey) return;
    exactKey = key;
    if (exactTimer) clearTimeout(exactTimer);
    exactTimer = setTimeout(() => {
      void previewCommand(commandFor(w, p)).then((r) => {
        if (!r || exactKey !== key) return;
        exact = { key, removed: r.riverRemoved, added: r.riverAdded };
        redrawTick.value++;
      });
    }, 150);
  };
  const resetExact = () => {
    if (exactTimer) clearTimeout(exactTimer);
    exactTimer = null;
    exactKey = '';
    exact = null;
  };
  const lineWidth = (w: World, p: RiverPlan) => {
    const thr = w.small.planet.riverThreshold;
    const q = p.reroute ? w.derived.discharge[p.cells[0]] : options.value.riverFlow * thr;
    return Math.max(2.5, riverWidth(q, thr) * Math.max(0.7, Math.min(2.2, zoom() / 1400)) + 1.5);
  };
  const shapesOf = (w: World, p: RiverPlan, estimate: boolean): Shape[] => {
    const { mesh } = w;
    const pt = (c: number): [number, number] => [mesh.x[c], mesh.y[c]];
    const color = p.blocked ? 'rgba(235, 80, 70, 0.95)' : p.same ? 'rgba(210, 210, 210, 0.85)' : 'rgba(40, 150, 255, 0.95)';
    const shapes: Shape[] = [];
    if (estimate && p.dried.length) shapes.push({ kind: 'cells', cells: [p.cells[0], ...p.dried], color: 'rgba(235, 80, 70, 0.95)', width: 3, dashed: true });
    if (p.cells.length > 1) shapes.push({ kind: 'arrow', points: p.cells.map(pt), color, width: lineWidth(w, p) });
    if (p.end === 'river') shapes.push({ kind: 'circle', x: mesh.x[p.join], y: mesh.y[p.join], r: 7 / zoom(), color: 'rgba(255, 255, 255, 0.95)', width: 2 });
    return shapes;
  };
  return {
    drags: true,
    down(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy() || committing) return;
      if (!w.causes.land[p.cell] || w.derived.lake[p.cell] === 1) {
        showToast('河要从陆地上开始', true);
        return;
      }
      drag = { cells: [p.cell], sx: p.sx, sy: p.sy, moved: false };
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      if (!pressed || !drag || p.cell < 0) return;
      // 手抖不算拖：在河上点一下不会变成改道
      if (Math.hypot(p.sx - drag.sx, p.sy - drag.sy) > 6) drag.moved = true;
      if (drag.moved && drag.cells[drag.cells.length - 1] !== p.cell) drag.cells.push(p.cell);
    },
    async up() {
      const w = world.value;
      const d = drag;
      if (!w || !d || committing) return;
      const p = planNow(w);
      resetExact();
      cancelPreviews();
      const fail = (text: string, error = true) => {
        drag = null;
        showToast(text, error);
      };
      if (p?.reroute && !d.moved) return fail('这里已经有河：按住往外拖，让它从这里改道', false);
      if (!p || p.cells.length < 2) return fail('这里画不出河');
      if (p.blocked) return fail(p.blocked);
      if (p.same) return fail('河本来就这么流，没有改');
      committing = true;
      try {
        await exec(commandFor(w, p), p.reroute ? '正在改道…' : '正在计算河流…');
      } finally {
        committing = false;
        drag = null;
      }
    },
    cancel() {
      if (!committing) drag = null;
      resetExact();
      cancelPreviews();
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const onLand = pointer.cell >= 0 && w.causes.land[pointer.cell] && w.derived.lake[pointer.cell] !== 1;
      if (!drag && !onLand) return EMPTY;
      const p = planNow(w);
      if (!p) return EMPTY;
      const len = lengthKm(w, p.cells);
      const where = endText(w, p, true);
      if (committing) return { layers: [], shapes: shapesOf(w, p, false), hint: '正在计算…' };
      if (!drag?.moved && p.reroute) {
        const { mesh } = w;
        const c = p.cells[0];
        return {
          layers: [],
          shapes: [{ kind: 'circle', x: mesh.x[c], y: mesh.y[c], r: 7 / zoom(), color: 'rgba(255, 255, 255, 0.95)', width: 2 }],
          hint: '已有河 · 往外拖是改道',
        };
      }
      if (p.blocked) return { layers: [], shapes: shapesOf(w, p, false), hint: p.blocked, warn: true };
      if (p.same) return { layers: [], shapes: shapesOf(w, p, false), hint: '河本来就这么流', warn: true };
      if (p.reroute) {
        wantExact(w, p);
        const head = `改道 → ${where} · ${len} km`;
        const x = exact?.key === planKey(w, p) ? exact : null;
        if (!x) {
          const dried = p.dried.length ? ` · 旧河道约 ${km(p.dried.length * w.mesh.spacing * w.kmPerUnit)} km 变干` : '';
          return { layers: [], shapes: shapesOf(w, p, true), hint: `${head}${dried}…` };
        }
        const onPath = new Set(p.cells);
        const added = x.added.filter((c) => !onPath.has(c));
        // 分开说：这条河原来的下游变干多少；别处跟着变的（多半是河挪了一格）有几处
        const old = new Set<number>();
        for (let c = w.derived.receiver[p.cells[0]]; c >= 0 && w.causes.land[c] && w.derived.lake[c] !== 1 && !old.has(c); c = w.derived.receiver[c]) old.add(c);
        const dried = x.removed.filter((c) => old.has(c));
        const others = groupCount(w, [...x.removed.filter((c) => !old.has(c)), ...added]);
        return {
          layers: [
            { cells: x.removed, color: [235, 80, 70], alpha: 0.8 },
            { cells: added, color: [70, 150, 235], alpha: 0.7 },
          ],
          shapes: shapesOf(w, p, false),
          hint:
            head +
            (dried.length ? ` · 旧河道 ${km(dried.length * w.mesh.spacing * w.kmPerUnit)} km 变干` : '') +
            (others ? ` · 另有 ${others} 处河道变` : ''),
        };
      }
      return {
        layers: [],
        shapes: shapesOf(w, p, false),
        hint: `→ ${where} · ${len} km`,
      };
    },
  };
}

// 点一下：用底部滑块的大小放湖；按住往外拖：拖多远湖就多大
export function lakeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: { x: number; y: number; cell: number; sx: number; sy: number; km: number | null } | null = null;
  let committing = false;
  let cache: { key: string; cells: number[] } | null = null;
  const centerOf = () => drag ?? (pointer && pointer.cell >= 0 ? pointer : null);
  const radiusNow = () => drag?.km ?? options.value.lakeKm;
  const cellsNow = (w: World) => {
    const c = centerOf();
    if (!c) return [];
    const key = `${worldId(w)}|${c.cell}|${radiusNow()}`;
    if (cache?.key !== key) cache = { key, cells: lakeArea(w, c.cell, radiusNow()) };
    return cache.cells;
  };
  // 碰到海岸的湖会直接流进海里，留不住水
  const coastalOf = (w: World, cells: number[]) =>
    cells.some((c) => {
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (!w.causes.land[w.mesh.adj[e]]) return true;
      return false;
    });
  return {
    drags: true,
    down(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy() || committing) return;
      if (!w.causes.land[p.cell]) {
        showToast('湖要放在陆地上', true);
        return;
      }
      pointer = p;
      drag = { x: p.x, y: p.y, cell: p.cell, sx: p.sx, sy: p.sy, km: null };
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !drag || !w) return;
      if (Math.hypot(p.sx - drag.sx, p.sy - drag.sy) <= 6) drag.km = null;
      else {
        const [lo, hi] = lakeRange(w);
        drag.km = snapRadiusKm(Math.min(hi, Math.max(lo, mapDist(w, p.x, p.y, drag.x, drag.y) * w.kmPerUnit)));
      }
    },
    async up() {
      const w = world.value;
      const d = drag;
      if (!w || !d || committing) return;
      // 碰到海岸的湖存不住水，放了也看不见：松手时就拦下，不进历史
      const cells = cellsNow(w);
      if (!cells.length || coastalOf(w, cells)) {
        drag = null;
        showToast('离海太近，留不住水：往内陆挪一点', true);
        return;
      }
      const radius = radiusNow();
      committing = true;
      if (d.km !== null) setOptions({ lakeKm: d.km });
      try {
        await exec({ op: 'add_lake', lake: { cell: d.cell, radius, depth: 120, perennial: true } }, '正在计算湖泊…');
      } finally {
        committing = false;
        drag = null;
      }
    },
    cancel() {
      if (!committing) drag = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const c = centerOf();
      if (!c || !w.causes.land[c.cell]) return EMPTY;
      const cells = cellsNow(w);
      const coastal = coastalOf(w, cells);
      return {
        layers: [{ cells, color: coastal ? [230, 120, 70] : [70, 140, 220], alpha: 0.8 }],
        shapes: drag?.km ? [{ kind: 'line', points: [[drag.x, drag.y], [pointer.x, pointer.y]], color: 'rgba(255,255,255,0.85)', width: 1.5, dashed: true }] : [],
        hint: committing ? '正在计算…' : coastal ? '离海太近，留不住水' : `湖 · ${km(radiusNow() * 2)} km`,
        warn: coastal,
      };
    },
  };
}

// 删除画过的河或湖：找离鼠标最近的（屏幕上 12 像素以内）
export function unwaterTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  const target = (w: World): { kind: 'guide' | 'lake'; id: string; cells: number[] } | null => {
    if (!pointer) return null;
    const { mesh } = w;
    const tol = 12 / zoom();
    let best: { kind: 'guide' | 'lake'; id: string; cells: number[] } | null = null;
    let bd = tol;
    for (const l of w.small.lakes) {
      const dd = mapDist(w, mesh.x[l.cell], mesh.y[l.cell], pointer.x, pointer.y) - l.radius / w.kmPerUnit;
      if (dd < bd) {
        bd = Math.max(0, dd);
        best = { kind: 'lake', id: l.id, cells: lakeArea(w, l.cell, l.radius) };
      }
    }
    const sphere = mesh.kind === 'sphere';
    for (const g of w.small.guides) {
      for (let k = 0; k + 1 < g.cells.length; k++) {
        const a = g.cells[k];
        const b = g.cells[k + 1];
        // 整个星球：两端展开到指针附近再量（格距很小，局部当平面量即可）
        const ax = sphere ? unwrapNear(mesh.x[a], pointer.x) : mesh.x[a];
        const bx = sphere ? unwrapNear(mesh.x[b], pointer.x) : mesh.x[b];
        const dd = segDist(pointer.x, pointer.y, ax, mesh.y[a], bx, mesh.y[b]);
        if (dd < bd) {
          bd = dd;
          best = { kind: 'guide', id: g.id, cells: g.cells };
        }
      }
    }
    return best;
  };
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    async click(p) {
      pointer = p;
      const w = world.value;
      if (!w || isBusy()) return;
      const t = target(w);
      if (!t) {
        showToast('这里没有画过的河或湖（自然形成的河删不掉，可以把地势压低或让这里变干）', true);
        return;
      }
      await exec(t.kind === 'guide' ? { op: 'remove_guide', id: t.id } : { op: 'remove_lake', id: t.id }, '正在计算…');
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const t = target(w);
      if (!t) return EMPTY;
      if (t.kind === 'lake') return { layers: [{ cells: t.cells, color: [235, 80, 70], alpha: 0.7 }], shapes: [], hint: '删掉这个湖' };
      return { layers: [], shapes: [{ kind: 'cells', cells: t.cells, color: 'rgba(235, 80, 70, 0.95)', width: 4 }], hint: '删掉这条河' };
    },
  };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// ---------- 量距离 ----------

// 一串点的总长（km）
export function pathKm(w: World, pts: [number, number][]): number {
  let sum = 0;
  // 整个星球：每段量球面上最短的弧
  for (let k = 1; k < pts.length; k++) sum += mapDist(w, pts[k][0], pts[k][1], pts[k - 1][0], pts[k - 1][1]);
  return sum * w.kmPerUnit;
}

// 量距离：点一下加一个点；鼠标到最后一点之间跟着一条虚线，旁边写着加上这一段一共多长。
// 左键拖动照样平移地图
export function measureTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
    },
    click(p) {
      const prev = measure.value?.[measure.value.length - 1];
      const w = world.value;
      // 整个星球：新的点展开到离上一点最近的那一份，量出来的线是连着的；南北不超出两极
      const sphere = w?.mesh.kind === 'sphere';
      const x = prev && sphere ? unwrapNear(p.x, prev[0]) : p.x;
      measure.value = [...(measure.value ?? []), [x, sphere ? Math.min(1, Math.max(0, p.y)) : p.y]];
    },
    preview() {
      const w = world.value;
      const pts = measure.value ?? [];
      if (!w) return EMPTY;
      const shapes: Shape[] = [];
      const dot = 3.5 / zoom();
      // 整个星球：画成球面上最短的弧
      const arcLine = (line: [number, number][]) => (w.mesh.kind === 'sphere' ? densify(line, w.mesh.spacing * 2) : line);
      if (pts.length > 1) shapes.push({ kind: 'line', points: arcLine(pts), color: 'rgba(255, 255, 255, 0.95)', width: 2 });
      if (pointer && pts.length) {
        const last = pts[pts.length - 1];
        const to: [number, number] = [w.mesh.kind === 'sphere' ? unwrapNear(pointer.x, last[0]) : pointer.x, pointer.y];
        shapes.push({ kind: 'line', points: arcLine([last, to]), color: 'rgba(255, 255, 255, 0.8)', width: 1.5, dashed: true });
      }
      for (const [x, y] of pts) shapes.push({ kind: 'circle', x, y, r: dot, color: 'rgba(255, 255, 255, 0.95)', width: 2 });
      if (!pointer) return { layers: [], shapes, hint: null };
      if (!pts.length) return { layers: [], shapes, hint: null };
      const total = pathKm(w, [...pts, [pointer.x, pointer.y]]);
      return { layers: [], shapes, hint: `${km(total).toLocaleString()} km` };
    },
  };
}

// ---------- 省份 ----------

const provinceName = (w: World, id: number) => w.small.provinces[id]?.name || `省份 ${id}`;

export function provinceSelectTool(): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    click(p) {
      const w = world.value;
      if (!w || p.cell < 0) return;
      const id = w.causes.province[p.cell];
      selectedProvince.value = id >= 0 ? id : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      const id = w.causes.province[pointer.cell];
      if (id < 0) return EMPTY;
      return { layers: [], shapes: [], hint: provinceName(w, id) };
    },
  };
}

export function provinceBrushTool(): ToolHandler {
  const target = () => selectedProvince.value;
  return brushTool({
    hint: () => {
      const w = world.value;
      const id = target();
      if (!w || id === null || !w.small.provinces[id]) return { text: '先按住 Alt 点一个省', warn: true };
      return { text: null };
    },
    filter: (w, i) => {
      const id = target();
      const meta = id !== null ? w.small.provinces[id] : null;
      if (!meta) return false;
      const other = w.causes.province[i];
      return (w.causes.land[i] === 1) === meta.land && other !== id && !(other >= 0 && w.small.provinces[other]?.locked);
    },
    layers(w, s) {
      const id = target()!;
      return { layers: [{ cells: s.cells, color: provinceColor(id), alpha: 0.8 }], hint: `${provinceName(w, id)} +${s.t.size} 格` };
    },
    async commit(_w, s) {
      const id = target();
      if (id === null || !s.t.size) return;
      await exec({ op: 'assign_province', cells: s.cells, province: id }, '正在划分…');
    },
  });
}

// 剪刀：沿画的线切开省份（线是墙，两端自动延长到省界）。切成几块就是几个省，
// 预览里每块新省一种颜色，延长出来的线画成虚线
const PIECE_COLORS: RGB[] = [
  [255, 214, 90],
  [110, 210, 235],
  [240, 130, 200],
  [150, 225, 120],
  [245, 160, 90],
];

export function provinceCutTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let line: [number, number][] | null = null;
  let lastScreen: [number, number] = [0, 0];
  let committing = false;
  let cache: { key: string; cut: CutResult } | null = null;
  const cutNow = (w: World, pts: [number, number][]) => {
    const key = `${worldId(w)}|${pts.length}|${pts[pts.length - 1].join(',')}`;
    if (cache?.key !== key) cache = { key, cut: cutProvinces(w, pts) };
    return cache.cut;
  };
  return {
    drags: true,
    down(p) {
      if (isBusy() || committing) return;
      line = [[p.x, p.y]];
      lastScreen = [p.sx, p.sy];
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      if (pressed && line && Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 6) {
        line.push([p.x, p.y]);
        lastScreen = [p.sx, p.sy];
      }
    },
    async up(p) {
      const w = world.value;
      if (!w || !line || committing) return;
      line.push([p.x, p.y]);
      const { plans } = cutNow(w, line);
      if (!plans.length) {
        line = null;
        showToast('线没有把省份分开', true);
        return;
      }
      committing = true;
      try {
        const names = plans.map((pl) => `“${provinceName(w, pl.id)}”`).join('、');
        const commands = plans.flatMap((pl) => pl.parts.slice(1).map((cells) => ({ op: 'assign_province' as const, cells, province: 'new' as const })));
        await exec({ op: 'batch', label: `切开了${names}`, commands }, '正在划分…');
      } finally {
        committing = false;
        line = null;
      }
    },
    cancel() {
      if (!committing) line = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (!line || line.length < 2) return EMPTY;
      const pts: [number, number][] = [...line, [pointer.x, pointer.y]];
      const cut = cutNow(w, pts);
      const layers: HighlightLayer[] = [];
      let k = 0;
      for (const pl of cut.plans) for (const cells of pl.parts.slice(1)) layers.push({ cells, color: PIECE_COLORS[k++ % PIECE_COLORS.length], alpha: 0.55 });
      const shapes: Shape[] = [{ kind: 'line', points: pts, color: 'rgba(255, 90, 70, 0.95)', width: 2.5 }];
      if (cut.before) shapes.push({ kind: 'line', points: cut.line.slice(0, cut.before + 1), color: 'rgba(255, 90, 70, 0.8)', width: 2, dashed: true });
      if (cut.after) shapes.push({ kind: 'line', points: cut.line.slice(cut.line.length - 1 - cut.after), color: 'rgba(255, 90, 70, 0.8)', width: 2, dashed: true });
      const pieces = cut.plans.reduce((n, pl) => n + pl.parts.length, 0);
      return { layers, shapes, hint: committing ? '正在计算…' : cut.plans.length ? `切成 ${pieces} 块` : '线还没把省分开' };
    },
  };
}

export function provinceMergeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    async click(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy()) return;
      const id = w.causes.province[p.cell];
      const sel = selectedProvince.value;
      if (id < 0) return;
      if (sel === null || sel === id || !w.small.provinces[sel]) {
        selectedProvince.value = id;
        return;
      }
      if (await exec({ op: 'merge_province', from: id, into: sel }, '正在合并…')) selectedProvince.value = sel;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      const id = w.causes.province[pointer.cell];
      const sel = selectedProvince.value;
      if (id < 0) return EMPTY;
      if (sel === null || sel === id || !w.small.provinces[sel]) return { layers: [], shapes: [], hint: provinceName(w, id) };
      const meta = w.small.provinces[id];
      const other = w.small.provinces[sel];
      if (meta.land !== other.land) return { layers: [], shapes: [], hint: '陆地和海域不能合并', warn: true };
      return {
        layers: [{ cells: provinceCells(w, id), color: provinceColor(sel), alpha: 0.7 }],
        shapes: [],
        hint: `并进 ${provinceName(w, sel)}`,
      };
    },
  };
}

export function provinceRegenTool(): ToolHandler {
  let cache: { key: string; cells: number[]; count: number } | null = null;
  // 会被重新划分的省份：被涂到一半以上的（与命令用同一个判断）
  const targets = (w: World, s: Stroke) => {
    const key = `${worldId(w)}|${s.t.size}|${s.cells[s.cells.length - 1]}`;
    if (cache?.key !== key) {
      const ids = new Set(regenTargets(w, s.cells));
      const cells: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (ids.has(w.causes.province[i])) cells.push(i);
      cache = { key, cells, count: ids.size };
    }
    return cache;
  };
  return brushTool({
    hint: () => ({ text: null }),
    layers(w, s) {
      const t = targets(w, s);
      return {
        layers: [
          { cells: s.cells, color: [255, 255, 255], alpha: 0.25 },
          { cells: t.cells, color: [255, 220, 90], alpha: 0.6 },
        ],
        hint: t.count ? `重划 ${t.count} 个省` : '再多涂一些',
      };
    },
    async commit(w, s) {
      if (!targets(w, s).count) {
        showToast('涂的范围要盖住省份的一大半，那个省份才会重新划分', true);
        return;
      }
      await exec({ op: 'regenerate_provinces', cells: s.cells }, '正在划分…');
    },
  });
}

// ---------- 地名 ----------

// 地名模式：点地图上的字选中地名；点在别处则选中这里最小的要素
export function renameTool(hitLabel: (sx: number, sy: number) => string | null): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    click(p) {
      const w = world.value;
      if (!w) return;
      const key = hitLabel(p.sx, p.sy);
      if (key) {
        selectedFeature.value = key;
        return;
      }
      if (p.cell < 0) return;
      let best: GeoFeature | null = null;
      for (const f of w.derived.features) if (f.cells.includes(p.cell) && (!best || f.areaKm2 < best.areaKm2)) best = f;
      selectedFeature.value = best?.key ?? null;
    },
    preview() {
      if (!pointer) return EMPTY;
      const key = hitLabel(pointer.sx, pointer.sy);
      return { layers: [], shapes: [], hint: key ? '点一下改名' : null };
    },
  };
}

// 刚加上的地名：选中它，底部条的名字框直接可以打字
function selectNewRegion() {
  const w = world.value;
  const r = w?.small.regions[w.small.regions.length - 1];
  if (!r) return;
  selectedFeature.value = `region:${r.id}`;
  focusName.value = `region:${r.id}`;
}

const fmtArea = (km2: number) => (km2 >= 1e4 ? `${(km2 / 1e4).toFixed(km2 >= 1e5 ? 0 : 1)} 万 km²` : `${Math.round(km2).toLocaleString()} km²`);
const REGION_RGB: RGB = [255, 225, 120];

// 圈一块起名：按住画一个圈，圈里的格成为一个地名区块（类型按地形猜，底部条上可以改）。
// 预览高亮的格就是区块；点在地名上（不拖）是选中那个地名
export function regionTool(hitLabel: (sx: number, sy: number) => string | null): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let committing = false;
  let cache: { key: string; cells: number[]; kind: Exclude<RegionKind, 'spot'>; km2: number } | null = null;
  const compute = (w: World, pts: [number, number][]) => {
    const key = `${worldId(w)}|${ringId}|${pts.length}`;
    if (cache?.key === key) return cache;
    const cells = ringCells(w, pts);
    let km2 = 0;
    for (const c of cells) km2 += w.mesh.area[c] * w.kmPerUnit * w.kmPerUnit;
    cache = { key, cells, kind: cells.length ? guessRegionKind(w, w.derived, cells) : 'region', km2 };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || isBusy() || committing) return;
      ring = [[p.x, p.y]];
      ringId++;
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w || committing) return;
      const [lx, ly] = ring[ring.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) >= w.mesh.spacing * 0.5) ring.push([p.x, p.y]);
    },
    async up(p) {
      const w = world.value;
      const pts = ring;
      if (!w || !pts || committing) return;
      if (aroundPole(w, pts)) {
        ring = null;
        showToast('圈不能绕着极点画', true);
        return;
      }
      const c = pts.length >= 3 ? compute(w, pts) : null;
      if (!c || c.cells.length < 3) {
        ring = null;
        const key = hitLabel(p.sx, p.sy);
        if (key) selectedFeature.value = key;
        else showToast('圈太小了：按住拖一圈再松手', true);
        return;
      }
      committing = true;
      try {
        if (await exec({ op: 'add_region', region: { kind: c.kind, cells: c.cells } }, '正在起名…')) selectNewRegion();
      } finally {
        committing = false;
        ring = null;
      }
    },
    cancel() {
      if (!committing) ring = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || !ring) return EMPTY;
      const shapes: Shape[] = [{ kind: 'line', points: ring, color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }];
      if (ring.length < 3) return { layers: [], shapes, hint: null };
      shapes.push({ kind: 'line', points: [ring[ring.length - 1], ring[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5, dashed: true });
      if (aroundPole(w, ring)) return { layers: [], shapes, hint: '绕着极点了，松手不会生效', warn: true };
      const c = compute(w, ring);
      return {
        layers: [{ cells: c.cells, color: REGION_RGB, alpha: 0.4 }],
        shapes,
        hint: committing ? '正在起名…' : c.cells.length ? `${REGION_KIND_INFO[c.kind].label} · ${fmtArea(c.km2)}` : null,
      };
    },
  };
}

// 放一个地名：点一下放一个点状地名（城镇、渡口、海角……），名字按那里的地形自动起，可以直接改。
// 点在已有的地名上是选中它
export function spotTool(hitLabel: (sx: number, sy: number) => string | null, zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
    },
    async click(p) {
      const w = world.value;
      if (!w || isBusy()) return;
      const key = hitLabel(p.sx, p.sy);
      if (key) {
        selectedFeature.value = key;
        return;
      }
      if (p.cell < 0) return;
      const round = (v: number) => Math.round(v * 1e5) / 1e5;
      if (await exec({ op: 'add_region', region: { kind: 'spot', cells: [p.cell], at: [round(keepX(w, p.x)), round(p.y)] } }, '正在起名…')) selectNewRegion();
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0 || hitLabel(pointer.sx, pointer.sy)) return EMPTY;
      return { layers: [], shapes: [{ kind: 'circle', x: pointer.x, y: pointer.y, r: 4 / zoom(), color: 'rgba(255, 255, 255, 0.95)', width: 2 }], hint: null };
    },
  };
}

export interface ToolEnv {
  zoom: () => number;
  hitLabel: (sx: number, sy: number) => string | null;
}
