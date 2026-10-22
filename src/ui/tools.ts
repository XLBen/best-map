import type { Command } from '../../core/commands';
import { lakeArea } from '../../core/elevation';
import { endemicSpecies } from '../../core/endemic';
import { hexToRgb } from '../../core/export';
import { type GeoFeature, REGION_KIND_INFO, guessRegionKind } from '../../core/features';
import { arcUnits, densify, unwrapNear, wrapX } from '../../core/geo';
import { type ProvinceSeam, scissors } from '../../core/seams';
import { type CutResult, type RiverPlan, brushCells, growRegion, lassoStroke, planRiver, provinceCells, ringCells, ringWinding } from '../../core/select';
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
import { type ProvinceMeta, type RegionKind, type World, provinceColor } from '../../core/world';
import { type DisplayCell, displayCellAt } from '../../core/display';
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
  previewProvinces,
  redrawTick,
  selectedFeature,
  selectedProvince,
  setOptions,
  sheet,
  showToast,
  sliderActive,
  world,
} from '../state';
import { queueHint, queuedCount, trackEdit } from './pending';

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
  // 屏幕上这一点画的是哪一格（扭曲后的格、格以下的海岸、剪刀切线两边，与着色器相同，见 core/display.ts）。
  // 悬停卡片、吸取、选省、合并、点地名按它取；画笔、放岛等按 cell 与坐标算
  shown?: DisplayCell;
}

export interface Preview {
  layers: HighlightLayer[];
  shapes: Shape[];
  hint: string | null;
  // warn：做不了（点了也不会执行）；caution：做得了，但要留意（比如合并后是一省两块）
  warn?: boolean;
  caution?: boolean;
  // 拖底部条上的滑块时这句话也写出来（在鼠标最后停的地方，那里正预览着涂一下会怎样）；
  // 没有这一项时，拖滑块由滑块上的数说明，鼠标旁不写
  sliderHint?: boolean;
  // 省份的预览：这些格将来属于哪个省。地图照此画出将来真实的省界（同一个对象不必重新上传）
  provinces?: ProvincePreview | null;
}

export interface ProvincePreview {
  cells: number[];
  ids: number[];
  // 剪刀：将来的切线（命令会记下的，每个切开的省一条，见 core/seams.ts 的 scissors），切开的几块之间的边界画在线上
  seams?: Omit<ProvinceSeam, 'id'>[];
  // 整份将来的省份数组（重划、重新划分：Worker 里的省份预览算好的）。有它时 cells、ids 改在它上面，
  // seamList 是将来全部的切线（替换现有的，不再加 seams），metas 是将来的各省（类型定颜色，名字写标签）
  province?: Int32Array;
  seamList?: ProvinceSeam[] | null;
  metas?: Record<number, ProvinceMeta>;
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
// 正在新建、打开、导出（世界可能马上换掉）：排队的工具也要等。只是在算前面的编辑时可以排队
const blockedByOther = () => busy.value !== null && !onlyEditsPending();

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
  layers: (w: World, s: Stroke, shift: boolean) => { layers: HighlightLayer[]; hint?: string; warn?: boolean; caution?: boolean; provinces?: ProvincePreview | null };
  commit: (w: World, s: Stroke, shift: boolean) => Promise<unknown>;
  // 画笔圈画在半径的几倍处：最后一个是主圈（悬停时虚线、按住时实线），前面的是细实线。省略时只在半径处画一圈
  rings?: number[];
}

// 一笔涂多重的预览深浅：变化量占滑块最大值的比例，最淡也有 0.35（力度很小时也看得见涂到了哪里）
export const strengthValues = (deltas: number[], max: number) => deltas.map((d) => 0.35 + 0.65 * Math.min(1, Math.abs(d) / max));

// 画笔可以排队：前面的笔画还在算时照样能画，松手后按顺序执行，各自是一步（结果与一笔一笔等着画相同）。
// 排队中的笔画一直显示松手时的预览（高亮与省界，见 pending.ts），直到结果换上（不先跳回原样，也不变成白色的“等待”）
function brushTool(cfg: BrushConfig): ToolHandler {
  let stroke: Stroke | null = null;
  let pointer: Pointer | null = null;
  // 鼠标在不在地图上：离开后只留排队中的笔画（拖滑块时照样在最后停的地方预览）
  let inside = false;
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
      if (blockedByOther()) return busyNote();
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
      // 松手时的预览（高亮、省界）留在图上，直到这一笔的结果换上
      const r = cfg.layers(w, s, p.shift);
      await trackEdit({ layers: r.layers, shapes: [], hint: null, provinces: r.provinces ?? null }, cfg.commit(w, s, p.shift));
    },
    cancel() {
      stroke = null;
    },
    leave() {
      inside = false;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      // 排队时（前面的编辑还没算完）：排队中的笔画由地图照旧画出松手时的预览，鼠标旁说一声
      const inLine = queuedCount() ? `正在计算…（${queuedCount()} 步）` : null;
      if (!stroke) {
        if (!inside && !sliderActive.value) return EMPTY;
        const h = cfg.hint(pointer.shift);
        if (sliderActive.value && !h.warn) {
          const d = dabAt(w, pointer);
          return { layers: d.layers, shapes: ringsAt(w, pointer), hint: inLine ?? d.hint, warn: d.warn, sliderHint: true };
        }
        return { layers: h.warn ? [] : footprint(w, pointer), shapes: ringsAt(w, pointer), hint: h.warn ? h.text : (inLine ?? h.text), warn: h.warn };
      }
      const r = cfg.layers(w, stroke, pointer.shift);
      // 做不了、要留意的话比排队要紧
      const hint = r.warn || r.caution ? (r.hint ?? null) : (queueHint() ?? r.hint ?? null);
      return { layers: r.layers, shapes: ringsAt(w, pointer), hint, warn: r.warn, caution: r.caution, provinces: r.provinces ?? null };
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
    preview: () => (active ?? chosen()).preview(),
  };
}

// 圈一片：按住画一个圈，松手后圈里变成陆地（或海），边上和画笔一样是自然的海岸。
// 预览与松手后提交的是同一个圈（每移动半格记一个点），所以绿色的格就是结果。
// 前面的编辑还在算时也能圈（排队，松手时的预览留到结果换上）：命令只看圈住的格，与等着圈相同
function lassoTool(modeOf: (shift: boolean) => 'land' | 'sea'): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let cache: { key: string; cells: number[]; t: number[]; gained: number[]; lost: number[]; layers: HighlightLayer[] } | null = null;
  const compute = (w: World, pts: [number, number][], mode: 'land' | 'sea') => {
    const key = `${worldId(w)}|${ringId}|${pts.length}|${mode}`;
    if (cache?.key === key) return cache;
    const r = lassoStroke(w, pts);
    const st = landStroke(w, r.cells, r.t, mode);
    const p = previewLand(w, st.cells, st.delta);
    // 图层对象跟着缓存走：同一个圈不必重新上传高亮，松手后排队时照样用它
    const layers: HighlightLayer[] = [
      { cells: p.gained, color: LAND_RGB, alpha: 0.75 },
      { cells: p.lost, color: SEA_RGB, alpha: 0.75 },
    ];
    cache = { key, cells: r.cells, t: r.t, gained: p.gained, lost: p.lost, layers };
    return cache;
  };
  return {
    drags: true,
    down(p) {
      if (!world.value || p.cell < 0) return;
      if (blockedByOther()) return busyNote();
      ring = [[p.x, p.y]];
      ringId++;
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w) return;
      const [lx, ly] = ring[ring.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) >= w.mesh.spacing * 0.5) ring.push([p.x, p.y]);
    },
    async up(p) {
      const w = world.value;
      const pts = ring;
      if (!w || !pts) return;
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
      // 松手时的样子（合上的圈与会变的格）留在图上，直到结果换上；圈马上空出来，可以接着圈下一个
      ring = null;
      const shapes: Shape[] = [{ kind: 'line', points: [...pts, pts[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5 }];
      await trackEdit({ layers: c.layers, shapes, hint: null }, exec({ op: 'paint_land', cells: c.cells, t: c.t, mode }));
    },
    cancel() {
      ring = null;
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
        layers: c.layers,
        shapes,
        hint: queueHint() ?? (mode === 'land' ? `陆地 +${c.gained.length} 格` : `陆地 −${c.lost.length} 格`),
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

// 堆山 / 压低一笔大约让地势升降多少米（提示里的“约 +900 m”）：笔下升得最多、降得最多的地方变多少。
// 经验估计（在地区、星球几种格数的地图上，画笔半径 1–25 格量过，多数与实际差在五成以内，个别差到两倍）：
// 堆山与力度^0.9、画笔半径（格）^0.75、“最高的山”成正比，抬升量最多到 2，已经很高的地方堆不了那么多；
// 压低是每格按现在的高度、去掉的抬升量占原有的几成估计，取最多的那格（没有抬升的平地压不下去）；
// 半径一两格的小画笔压不了那么多（周围的山撑着）。cells、delta：这一笔涂到的格与抬升量的变化（reliefStroke）
export function reliefEstimateM(w: World, cells: number[], delta: number[], strength: number): number {
  const rc = Math.max(0.5, brushR(w) / w.mesh.spacing);
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

// 小礁的预览：那一格淡淡地涂上，格心画一个半格大的实心点（放出来大约就这么大）。
// 整个星球：点是球面上真实大小的圆（高纬度的格在平铺图上横向拉长，点也跟着拉长）
function reefPreview(w: World, fresh: number[], nearX: number, hint: string, warn: boolean): Preview {
  const { mesh } = w;
  const c = fresh[0];
  if (c === undefined) return { layers: [], shapes: [], hint, warn };
  const x = mesh.kind === 'sphere' ? unwrapNear(mesh.x[c], nearX) : mesh.x[c];
  return {
    layers: [{ cells: fresh, color: LAND_RGB, alpha: 0.25 }],
    shapes: [{ kind: 'circle', x, y: mesh.y[c], r: mesh.spacing * 0.25, fill: true, geodesic: true, color: 'rgba(120, 205, 95, 0.95)', width: 1 }],
    hint,
    warn,
  };
}

// 刚松手、鼠标还停在原处（屏幕上 6 像素以内）：这一步还在算时不画下一次的悬停预览，只留排队中的那个；
// 在原处再按一下也不算（多点了一下，不在同一个地方叠一个）
type Settled = { sx: number; sy: number } | null;
const movedAway = (s: Settled, p: Pointer) => !s || Math.hypot(p.sx - s.sx, p.sy - s.sy) > 6;

// 点一下：用底部滑块的大小放岛；按住往外拖：拖多远岛就多大（松手后滑块也停在这个大小）。
// 前面的编辑还在算时也能放（排队）：命令只看位置、种类、大小、形状，与等着放相同
export function islandTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: { x: number; y: number; cell: number; sx: number; sy: number; km: number | null } | null = null;
  let settled: Settled = null;
  let cache: { key: string; preview: Preview; spec: IslandSpec | null; block: string | null } | null = null;
  const compute = () => {
    const w = world.value;
    if (!w || !pointer) return null;
    const center = drag ?? (pointer.cell >= 0 ? pointer : null);
    if (!center) return null;
    const o = options.value;
    // 滑块停在别的种类的大小上（比如从火山岛换成珊瑚岛）时，补到这一种的最小值
    const size = Math.max(islandSizeRangeKm(w, o.islandKind)[0], drag?.km ?? o.islandKm);
    const spec: IslandSpec = { x: keepX(w, center.x), y: center.y, kind: o.islandKind, size, variant: o.islandVariant };
    const key = `${worldId(w)}|${spec.x.toFixed(5)},${spec.y.toFixed(5)}|${spec.kind}|${spec.size}|${spec.variant}`;
    if (cache?.key === key) return cache;
    const name = ISLAND_KIND_INFO[spec.kind].name;
    const reef = spec.kind === 'reef';
    // 小礁不看大小：画出来约半格大
    const diameter = km(reef ? w.mesh.spacing * w.kmPerUnit * 0.5 : islandRadiusKm(w, spec.size) * 2);
    let block: string | null = null;
    if (spec.kind === 'atoll' && !w.causes.land[center.cell] && w.derived.tMean[center.cell] < 20) {
      block = `海水太凉（${Math.round(w.derived.tMean[center.cell])} °C），珊瑚岛要 20 °C 以上`;
    }
    const stamp = islandStamp(w, spec);
    const fresh = stamp.footprint.filter((c) => !w.causes.land[c]);
    if (!block && !fresh.length) block = '这里已经是陆地';
    const preview: Preview = reef
      ? reefPreview(w, fresh, pointer.x, block ?? `${name} · 约 ${diameter} km`, !!block)
      : {
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
      if (!world.value || p.cell < 0 || !movedAway(settled, p)) return;
      if (blockedByOther()) return busyNote();
      pointer = p;
      drag = { x: p.x, y: p.y, cell: p.cell, sx: p.sx, sy: p.sy, km: null };
    },
    move(p, pressed) {
      pointer = p;
      if (movedAway(settled, p)) settled = null;
      const w = world.value;
      if (!pressed || !drag || !w) return;
      // 拖出 6 像素以上才算在拖大小，手抖不算；小礁不看大小
      const kind = options.value.islandKind;
      if (kind === 'reef' || Math.hypot(p.sx - drag.sx, p.sy - drag.sy) <= 6) drag.km = null;
      else {
        // 先取整再限制在范围里：取整后不会比最小值还小
        const [lo, hi] = islandSizeRangeKm(w, kind);
        drag.km = Math.min(hi, Math.max(lo, snapRadiusKm(mapDist(w, p.x, p.y, drag.x, drag.y) * w.kmPerUnit)));
      }
    },
    async up(p) {
      pointer = p;
      const d = drag;
      if (!d) return;
      const c = compute();
      drag = null;
      if (!c?.spec) return;
      if (c.block) {
        showToast(c.block, true);
        return;
      }
      const spec = c.spec;
      // 滑块停在拖出的大小；下一个岛换个形状（悬停的预览里看得到）
      setOptions({ islandVariant: spec.variant + 1, ...(d.km !== null ? { islandKm: d.km } : {}) });
      const mark = { sx: p.sx, sy: p.sy };
      settled = mark;
      // 松手时的岛留在图上直到结果换上（拖大小的虚线不留；小礁的点就是它自己，留着）
      const shown: Preview = { layers: c.preview.layers, shapes: spec.kind === 'reef' ? c.preview.shapes : [], hint: null };
      try {
        // 小礁只有一种样子：不用“换个形状”
        await trackEdit(shown, exec({ op: 'add_island', island: spec }, '正在造岛…', spec.kind === 'reef' ? undefined : islandAgain(spec)));
      } finally {
        if (settled === mark) settled = null;
      }
    },
    cancel() {
      drag = null;
    },
    preview() {
      if (settled) return { ...EMPTY, hint: '正在计算…' };
      const c = compute();
      if (!c) return EMPTY;
      const q = c.block ? null : queueHint();
      return q ? { ...c.preview, hint: q } : c.preview;
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

// 岛链：按住拖出一条线，岛沿着线排开。前面的编辑还在算时也能画（排队）
export function chainTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let points: [number, number][] | null = null;
  let lastScreen: [number, number] = [0, 0];
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
    // 岛链用自己的种类和大小；fine：小一号的岛最小到 0.75 格（旧存档里的岛链没有这一项，照旧）
    const size = w ? Math.max(islandSizeRangeKm(w, o.chainKind)[0], o.chainKm) : o.chainKm;
    return { points: use, kind: o.chainKind, size, density: o.chainDensity, variant: o.chainVariant, fine: true as const };
  };
  const previewOf = (w: World, spec: ReturnType<typeof specFor>): Preview => {
    const key = `${worldId(w)}|${JSON.stringify(spec)}`;
    if (cache?.key !== key) {
      const islands = chainIslands(w, spec);
      // 与命令同一个规则（带 fine：太小的岛岛心那一格成陆），预览就是结果
      const stamp = combineStamps(w, islands, spec.fine);
      cache = {
        key,
        preview: {
          layers: [{ cells: stamp.footprint, color: LAND_RGB, alpha: 0.75 }],
          shapes: [{ kind: 'line', points: spec.points, dashed: true, color: 'rgba(255,255,255,0.8)' }],
          hint: `${islands.length} 个${ISLAND_KIND_INFO[spec.kind].name}`,
        },
      };
    }
    return cache.preview;
  };
  return {
    drags: true,
    down(p) {
      if (blockedByOther()) return busyNote();
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
        showToast('按住鼠标拖出一条线，岛会沿着线排开', true);
        return;
      }
      const chain = specFor(pts);
      setOptions({ chainVariant: chain.variant + 1 });
      // 松手时的岛与线留在图上，直到结果换上
      await trackEdit({ ...previewOf(w, chain), hint: null }, exec({ op: 'add_island_chain', chain }, '正在造岛链…', chainAgain(chain)));
    },
    cancel() {
      points = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (!points || points.length < 2) return EMPTY;
      const pv = previewOf(w, specFor(points));
      const q = queueHint();
      return q ? { ...pv, hint: q } : pv;
    },
  };
}

export function rerollTool(): ToolHandler {
  let pointer: Pointer | null = null;
  // 重画的圈至少 1.2 格：再小可能一格都不变
  const radius = (w: World) => Math.max(brushR(w), w.mesh.spacing * 1.2);
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
      await exec({ op: 'reroll_region', x: keepX(w, p.x), y: p.y, radius: radius(w), variant: gen.rerolls.length + 1 }, '正在重画…');
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      return {
        layers: [],
        shapes: [{ kind: 'circle', x: pointer.x, y: pointer.y, r: radius(w), dashed: true, color: 'rgba(255, 220, 120, 0.95)', width: 2, geodesic: true }],
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

// 点一下：用底部滑块的大小放湖；按住往外拖：拖多远湖就多大。前面的编辑还在算时也能放（排队）
export function lakeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: { x: number; y: number; cell: number; sx: number; sy: number; km: number | null } | null = null;
  let settled: Settled = null;
  let cache: { key: string; cells: number[] } | null = null;
  const centerOf = () => drag ?? (pointer && pointer.cell >= 0 ? pointer : null);
  const radiusNow = () => drag?.km ?? options.value.lakeKm;
  const cellsNow = (w: World) => {
    const c = centerOf();
    if (!c) return [];
    const key = `${worldId(w)}|${c.cell}|${radiusNow()}`;
    // 新湖都带 exact：半径就按给的算（最小只淹一格）
    if (cache?.key !== key) cache = { key, cells: lakeArea(w, c.cell, radiusNow(), true) };
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
      if (!w || p.cell < 0 || !movedAway(settled, p)) return;
      if (blockedByOther()) return busyNote();
      if (!w.causes.land[p.cell]) {
        showToast('湖要放在陆地上', true);
        return;
      }
      pointer = p;
      drag = { x: p.x, y: p.y, cell: p.cell, sx: p.sx, sy: p.sy, km: null };
    },
    move(p, pressed) {
      pointer = p;
      if (movedAway(settled, p)) settled = null;
      const w = world.value;
      if (!pressed || !drag || !w) return;
      if (Math.hypot(p.sx - drag.sx, p.sy - drag.sy) <= 6) drag.km = null;
      else {
        // 先取整再限制在范围里：取整后不会比最小值还小
        const [lo, hi] = lakeRange(w);
        drag.km = Math.min(hi, Math.max(lo, snapRadiusKm(mapDist(w, p.x, p.y, drag.x, drag.y) * w.kmPerUnit)));
      }
    },
    async up(p) {
      const w = world.value;
      const d = drag;
      if (!w || !d) return;
      // 碰到海岸的湖存不住水，放了也看不见：松手时就拦下，不进历史
      const cells = cellsNow(w);
      if (!cells.length || coastalOf(w, cells)) {
        drag = null;
        // 拖出来的大小留着：往内陆挪一点再点，还是这么大
        if (d.km !== null) setOptions({ lakeKm: d.km });
        showToast('离海太近，留不住水：往内陆挪一点', true);
        return;
      }
      const radius = radiusNow();
      drag = null;
      if (d.km !== null) setOptions({ lakeKm: d.km });
      const mark = { sx: p.sx, sy: p.sy };
      settled = mark;
      try {
        // 松手时的湖留在图上，直到结果换上
        const shown: Preview = { layers: [{ cells, color: [70, 140, 220], alpha: 0.8 }], shapes: [], hint: null };
        await trackEdit(shown, exec({ op: 'add_lake', lake: { cell: d.cell, radius, depth: 120, perennial: true, exact: true } }, '正在计算湖泊…'));
      } finally {
        if (settled === mark) settled = null;
      }
    },
    cancel() {
      drag = null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      if (settled) return { ...EMPTY, hint: '正在计算…' };
      const c = centerOf();
      if (!c || !w.causes.land[c.cell]) return EMPTY;
      const cells = cellsNow(w);
      const coastal = coastalOf(w, cells);
      return {
        layers: [{ cells, color: coastal ? [230, 120, 70] : [70, 140, 220], alpha: 0.8 }],
        shapes: drag?.km ? [{ kind: 'line', points: [[drag.x, drag.y], [pointer.x, pointer.y]], color: 'rgba(255,255,255,0.85)', width: 1.5, dashed: true }] : [],
        hint: coastal ? '离海太近，留不住水' : (queueHint() ?? `湖 · ${km(radiusNow() * 2)} km`),
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
        best = { kind: 'lake', id: l.id, cells: lakeArea(w, l.cell, l.radius, l.exact) };
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

// 屏幕上这一点画的是哪一格（见 core/display.ts）：MapView 算好放在指针上，没有时（比如测试里）当场算
export function shownAt(w: World, p: Pointer): DisplayCell | null {
  if (p.cell < 0) return null;
  return p.shown ?? displayCellAt(w, p.x, p.y, p.cell);
}

// 鼠标下算哪一格的省（选省、合并、吸取省份用）：地图上这一点画成哪个省就是哪个
// （扭曲后的格、剪刀切线两边按显示出来的那一边，与着色器同一条规则）
export function provinceCellAt(w: World, p: Pointer): number {
  return shownAt(w, p)?.province ?? -1;
}

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
      const id = w.causes.province[provinceCellAt(w, p)];
      selectedProvince.value = id >= 0 ? id : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      const id = w.causes.province[provinceCellAt(w, pointer)];
      if (id < 0) return EMPTY;
      return { layers: [], shapes: [], hint: provinceName(w, id) };
    },
  };
}

// 每个省的格与原来就有几块（按世界缓存：涂省时每动一下都要看被涂到的省还连不连着）
const provinceListCache = new WeakMap<World, { cells: Map<number, number[]>; pieces: Map<number, number> }>();
function provincesNow(w: World) {
  let m = provinceListCache.get(w);
  if (!m) {
    m = { cells: new Map(), pieces: new Map() };
    for (let i = 0; i < w.mesh.n; i++) {
      const p = w.causes.province[i];
      if (p < 0) continue;
      let l = m.cells.get(p);
      if (!l) m.cells.set(p, (l = []));
      l.push(i);
    }
    provinceListCache.set(w, m);
  }
  return m;
}

// 一组格连成几片：只在这组格里走（相邻的算一片）
function piecesOf(w: World, cells: number[]): number {
  const left = new Set(cells);
  let k = 0;
  for (const c of cells) {
    if (!left.delete(c)) continue;
    k++;
    const queue = [c];
    for (let h = 0; h < queue.length; h++) {
      for (let e = w.mesh.off[queue[h]]; e < w.mesh.off[queue[h] + 1]; e++) {
        const j = w.mesh.adj[e];
        if (left.delete(j)) queue.push(j);
      }
    }
  }
  return k;
}

export function provinceBrushTool(): ToolHandler {
  const target = () => selectedProvince.value;
  // 涂到的格换成选中的省：地图上省界当场跟着变（按笔画、省缓存，同一个对象不必重新上传）。
  // 被涂掉一部分的省剩下的格比原来多断成了几块（会变成一省几块）：黄色提醒，照样能涂
  let prov: { key: string; s: Stroke; value: ProvincePreview; split: { id: number; parts: number } | null } | null = null;
  const provincesOf = (w: World, s: Stroke, id: number) => {
    const key = `${worldId(w)}|${id}|${s.t.size}`;
    if (prov?.s !== s || prov.key !== key) {
      const cells = s.cells;
      const taken = new Set(cells);
      const losers = new Set<number>();
      for (const c of cells) if (w.causes.province[c] >= 0 && w.causes.province[c] !== id) losers.add(w.causes.province[c]);
      let split: { id: number; parts: number } | null = null;
      const now = provincesNow(w);
      for (const p of losers) {
        const all = now.cells.get(p) ?? [];
        const rest = all.filter((c) => !taken.has(c));
        const parts = rest.length ? piecesOf(w, rest) : 0;
        if (parts < 2 || (split && parts <= split.parts)) continue;
        // 原来就是几块的（比如一省几个岛）：多断出来才提醒
        let before = now.pieces.get(p);
        if (before === undefined) now.pieces.set(p, (before = piecesOf(w, all)));
        if (parts > before) split = { id: p, parts };
      }
      prov = { key, s, value: { cells, ids: cells.map(() => id) }, split };
    }
    return prov;
  };
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
      const { value, split } = provincesOf(w, s, id);
      return {
        layers: [{ cells: s.cells, color: provinceColor(id), alpha: 0.8 }],
        hint: split ? `会把「${provinceName(w, split.id)}」分成 ${split.parts} 块` : `${provinceName(w, id)} +${s.t.size} 格`,
        caution: !!split,
        provinces: value,
      };
    },
    async commit(_w, s) {
      const id = target();
      if (id === null || !s.t.size) return;
      await exec({ op: 'assign_province', cells: s.cells, province: id }, '正在划分…');
    },
  });
}

// 剪刀：沿画的线切开省份（线是墙，两端自动延长到省界）。切成几块就是几个省，切开的两省之间的边界就是画的线。
// 拖动时地图上直接画出切开后真实的省界（与结果同一套编码、扭曲和切线规则），新的几块用它们将来的颜色；
// 切出几块之后原来的红线隐去，只留两端的小点和自动延长的虚线。松手后预览一直留到结果回来。
// 预览与命令用同一条线（延长、化简之后的，见 core/seams.ts 的 scissors），所以切出来的块、新省的编号都一样
const CUT_RED = 'rgba(255, 90, 70, 0.95)';

export function provinceCutTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let line: [number, number][] | null = null;
  let lastScreen: [number, number] = [0, 0];
  let committing = false;
  let cache: { key: string; cut: CutResult; line: [number, number][]; view: Preview } | null = null;
  const cutNow = (w: World, pts: [number, number][]) => {
    const key = `${worldId(w)}|${pts.length}|${pts[pts.length - 1].join(',')}`;
    if (cache?.key !== key) {
      const { ext, line: sent, cut, seams } = scissors(w, pts);
      cache = { key, cut, line: sent, view: viewOf(pts, ext, seams, cut) };
    }
    return cache;
  };
  // 新的几块：编号按命令里的顺序（与执行时新建省份的顺序相同，见 core/seams.ts 的 cutSeams），颜色就是将来的颜色
  const viewOf = (pts: [number, number][], ext: CutResult, seams: Omit<ProvinceSeam, 'id'>[], cut: CutResult): Preview => {
    const layers: HighlightLayer[] = [];
    const cells: number[] = [];
    const ids: number[] = [];
    cut.plans.forEach((pl, k) => {
      pl.parts.forEach((part, j) => {
        if (!j) return;
        const id = seams[k].provinces[j];
        layers.push({ cells: part, color: provinceColor(id), alpha: 0.45 });
        for (const c of part) {
          cells.push(c);
          ids.push(id);
        }
      });
    });
    const shapes: Shape[] = [];
    if (!cut.plans.length) shapes.push({ kind: 'line', points: pts, color: CUT_RED, width: 2.5 });
    else {
      const dot = 2.5 / zoom();
      for (const [x, y] of [pts[0], pts[pts.length - 1]]) shapes.push({ kind: 'circle', x, y, r: dot, color: CUT_RED, width: 2 });
    }
    if (ext.before) shapes.push({ kind: 'line', points: ext.line.slice(0, ext.before + 1), color: 'rgba(255, 90, 70, 0.8)', width: 2, dashed: true });
    if (ext.after) shapes.push({ kind: 'line', points: ext.line.slice(ext.line.length - 1 - ext.after), color: 'rgba(255, 90, 70, 0.8)', width: 2, dashed: true });
    const pieces = cut.plans.reduce((n, pl) => n + pl.parts.length, 0);
    return { layers, shapes, hint: cut.plans.length ? `切成 ${pieces} 块` : '线还没把省分开', provinces: cells.length ? { cells, ids, seams } : null };
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
      if (pressed && line && !committing && Math.hypot(p.sx - lastScreen[0], p.sy - lastScreen[1]) > 6) {
        line.push([p.x, p.y]);
        lastScreen = [p.sx, p.sy];
      }
    },
    async up(p) {
      const w = world.value;
      if (!w || !line || committing) return;
      line.push([p.x, p.y]);
      const { cut, line: sent } = cutNow(w, line);
      if (!cut.plans.length) {
        line = null;
        showToast('线没有把省份分开', true);
        return;
      }
      committing = true;
      try {
        await exec({ op: 'cut_province', line: sent }, '正在划分…');
      } finally {
        committing = false;
        line = null;
      }
    },
    cancel() {
      if (!committing) line = null;
    },
    preview() {
      // 松手后（正在计算）：停在松手时的样子。新世界先到时也不重新算（线在新世界里已经切不开什么了）
      if (committing && cache) return { ...cache.view, hint: '正在计算…' };
      const w = world.value;
      if (!w || !pointer || !line || line.length < 2) return EMPTY;
      return cutNow(w, [...line, [pointer.x, pointer.y]]).view;
    },
  };
}

// 合并：悬停在邻省上时，两省之间的省界当场消失（省份预览），点了以后一直留到结果回来。
// 锁定的省标红、点了也不合并；不相邻的两省照样能合并（黄色提醒：合并后是一省两块）
export function provinceMergeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let cache: { key: string; view: Preview } | null = null;
  let committing: Preview | null = null;
  const view = (): Preview => {
    const w = world.value;
    if (!w || !pointer || pointer.cell < 0) return EMPTY;
    const id = w.causes.province[provinceCellAt(w, pointer)];
    const sel = selectedProvince.value;
    if (id < 0) return EMPTY;
    if (sel === null || sel === id || !w.small.provinces[sel]) return { layers: [], shapes: [], hint: provinceName(w, id) };
    const meta = w.small.provinces[id];
    const other = w.small.provinces[sel];
    if (meta.land !== other.land) return { layers: [], shapes: [], hint: '陆地和海域不能合并', warn: true };
    const key = `${worldId(w)}|${id}|${sel}`;
    if (cache?.key !== key) {
      const cells = provinceCells(w, id);
      const locked = meta.locked ? id : other.locked ? sel : null;
      if (locked !== null) {
        // 合并不了的不画将来的省界（省界当场消失却并不成，就不是所见即所得）：这个省标红
        cache = { key, view: { layers: [{ cells, color: [230, 90, 70], alpha: 0.45 }], shapes: [], hint: `「${provinceName(w, locked)}」已锁定，不能合并`, warn: true } };
      } else {
        const apart = !cells.some((c) => {
          for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (w.causes.province[w.mesh.adj[e]] === sel) return true;
          return false;
        });
        cache = {
          key,
          view: {
            layers: [{ cells, color: provinceColor(sel), alpha: 0.7 }],
            shapes: [],
            hint: apart ? '不相邻：合并后是一省两块' : `并进 ${provinceName(w, sel)}`,
            caution: apart,
            provinces: { cells, ids: cells.map(() => sel) },
          },
        };
      }
    }
    return cache.view;
  };
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    async click(p) {
      const w = world.value;
      if (!w || p.cell < 0 || isBusy()) return;
      const id = w.causes.province[provinceCellAt(w, p)];
      const sel = selectedProvince.value;
      if (id < 0) return;
      if (sel === null || sel === id || !w.small.provinces[sel]) {
        selectedProvince.value = id;
        return;
      }
      // 留住的预览就是点下去的这一处（与命令合并的是同一个省）；合并不了的（锁定、陆海不同）点了只说一声
      pointer = p;
      const v = view();
      if (v.warn) {
        showToast(v.hint ?? '这两个省不能合并', true);
        return;
      }
      committing = v;
      try {
        if (await exec({ op: 'merge_province', from: id, into: sel }, '正在合并…')) selectedProvince.value = sel;
      } finally {
        committing = null;
      }
    },
    preview() {
      return committing ?? view();
    },
  };
}

// 重划：涂到一大半的省重新划分。会重划哪几个省定下来 150 毫秒后在 Worker 里算确切的结果（与执行同一个算法、
// 同样的省名），地图上直接画出新的省界和省名；算好之前先把会重划的省涂黄。
// 结果只取决于重划哪几个省（不看具体涂了哪几格），所以接着在这几个省里涂时新省界一直留着，不重算、不闪回
export function provinceRegenTool(): ToolHandler {
  let cache: { key: string; s: Stroke; ids: string; cells: number[]; count: number; rough: HighlightLayer[]; framed: HighlightLayer[] } | null = null;
  let exact: { key: string; s: Stroke; prov: ProvincePreview; fresh: number } | null = null;
  let wanted: { key: string; s: Stroke } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // 会被重新划分的省份：被涂到一半以上的（与命令用同一个判断）
  const targets = (w: World, s: Stroke) => {
    const key = `${worldId(w)}|${s.t.size}|${s.cells[s.cells.length - 1]}`;
    if (cache?.s !== s || cache.key !== key) {
      const list = regenTargets(w, s.cells);
      const ids = new Set(list);
      const cells: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (ids.has(w.causes.province[i])) cells.push(i);
      const stroke: HighlightLayer = { cells: s.cells, color: [255, 255, 255], alpha: 0.25 };
      // 确切的新省界画出来以后，会重划的范围只描边（不盖住新的省界）
      cache = { key, s, ids: `${worldId(w)}|${list.join(',')}`, cells, count: ids.size, rough: [stroke, { cells, color: [255, 220, 90], alpha: 0.6 }], framed: [stroke, { cells, color: [255, 220, 90], pattern: 'outline' }] };
    }
    return cache;
  };
  // key：这个世界上重划哪几个省
  const want = (w: World, s: Stroke, key: string) => {
    if (wanted?.key === key && wanted.s === s) return;
    const mine = { key, s };
    wanted = mine;
    stop();
    const cells = s.cells;
    timer = setTimeout(() => {
      timer = null;
      void previewProvinces({ op: 'regenerate_provinces', cells }).then((r) => {
        if (!r || wanted !== mine || world.value !== w) return;
        const fresh = Object.keys(r.provinces).filter((id) => !w.small.provinces[Number(id)]).length;
        exact = { key, s, fresh, prov: { cells: [], ids: [], province: r.province, seamList: r.seams, metas: r.provinces } };
        redrawTick.value++;
      });
    }, 150);
  };
  return brushTool({
    hint: () => ({ text: null }),
    layers(w, s) {
      const t = targets(w, s);
      // 拖滑块时预览的单点一笔不去 Worker 里算（地图上只画涂黄的范围）
      if (t.count && !sliderActive.value) want(w, s, t.ids);
      const x = exact?.s === s && exact.key === t.ids ? exact : null;
      return {
        layers: x ? t.framed : t.rough,
        hint: !t.count ? '再多涂一些' : x ? `重划 ${t.count} 个省 → ${x.fresh} 个` : `重划 ${t.count} 个省`,
        provinces: x?.prov ?? null,
      };
    },
    async commit(w, s) {
      // 松手了：还没到时候的预览不必再算（Worker 先算这一步）
      stop();
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
      // 屏幕上这一点画成陆地就找陆上的地名，画成海就找海上的
      const cell = shownAt(w, p)?.here ?? -1;
      if (cell < 0) return;
      let best: GeoFeature | null = null;
      for (const f of w.derived.features) if (f.cells.includes(cell) && (!best || f.areaKm2 < best.areaKm2)) best = f;
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

// 圈一块起名：按住画一个圈，圈里的格成为一个地名区块（类型“自动”：按圈里现在的地形判断，之后涂了沙漠就变成沙漠；底部条上可以改成固定的）。
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
        if (await exec({ op: 'add_region', region: { kind: c.kind, cells: c.cells, auto: true } }, '正在起名…')) selectNewRegion();
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
