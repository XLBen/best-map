import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import type { PreviewResult } from '../../core/engine';
import { lakeArea } from '../../core/elevation';
import { hexToRgb } from '../../core/export';
import { type GeoFeature, REGION_KIND_INFO, guessRegionKind } from '../../core/features';
import { arcUnits, densify, unwrapNear, wrapX } from '../../core/geo';
import { type ProvinceSeam, scissors } from '../../core/seams';
import { type CutResult, brushCells, growRegion, lassoStroke, provinceCells, ringCells, ringWinding } from '../../core/select';
import {
  ISLAND_KIND_INFO,
  type ChainSpec,
  type IslandSpec,
  chainIslands,
  combineStamps,
  islandSizeRangeKm,
  islandStamp,
  landStroke,
  previewLand,
  reliefStroke,
  restoreStroke,
  roundKm as km,
  type TerrainPreview,
} from '../../core/terrain';
import { regenTargets } from '../../core/provinces';
import { isVegetated, landmassCells } from '../../core/vegetation';
import { type ProvinceMeta, type RegionKind, type World, provinceColor } from '../../core/world';
import { type DisplayCell, displayCellAt } from '../../core/display';
import type { GhostEdit, HighlightLayer } from '../render/colors';
import type { Shape } from '../render/overlay';
import {
  type Again,
  type ToolId,
  editsIdle,
  history,
  replaceLast,
  type ToolOptions,
  busy,
  exec,
  focusName,
  focusSpecies,
  lakeRange,
  measure,
  noteCost,
  onlyEditsPending,
  options,
  previewProvinces,
  previewTerrainOnce,
  redrawTick,
  selectedFeature,
  selectedLake,
  selectedProvince,
  setOptions,
  sheet,
  showToast,
  sliderActive,
  slowPreview,
  world,
} from '../state';
import { climateHere, climateMask, erasableLayer, natureHere, natureMask, terrainHere, terrainMask } from './edits';
import { Exact, type ExactView } from './exact';
import { ghostFollows, queueHint, queuedCount, trackEdit } from './pending';
import { chosenLakeType, lakeCellsAt, lakeInfo, lakeRefAt, lakeSizeDraft } from './lakeInfo';

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
  // 幽灵海岸：这些格的 landness 将来加多少（lake：将来成湖的格）。地图照此画出将来真实的海岸线（同一个对象不必重算）
  ghost?: GhostEdit | null;
  // 整份将来的海岸（重画这一片）：与“调整”滑块的预览同一种，海岸值与结果逐位相同
  terrain?: TerrainPreview | null;
  // 确切预览算出的将来的世界：地图按它画生态颜色、雪、河、地名、风和没涂成的格（工具、悬停卡片照旧看当前世界）
  world?: World | null;
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
  // 鼠标离开地图后预览还要留着：点了以后还在算、又不排队的那一步（重画这一片），结果换上之前一直显示。
  // 排队的编辑（画笔、放岛、圈一片……）不用它：松手时的预览交给 pending.ts，由地图画出来
  keep?(): boolean;
  // Esc、回车（在取消正在画的一笔之后、退出量距离之前）：工具自己要用时返回 true（比如画河时截不截走别的河）
  escape?(): boolean;
  enter?(): boolean;
  preview(): Preview;
  // 工具选中时一直画着的东西（鼠标不在地图上也画）：橡皮擦能擦的格、重画过的范围……
  // 画在预览下面。同样的输入给同一个图层对象（地图不必重新上传）
  backdrop?(): Backdrop | null;
}

export interface Backdrop {
  layers: HighlightLayer[];
  shapes: Shape[];
}

const EMPTY: Preview = { layers: [], shapes: [], hint: null };

type RGB = [number, number, number];
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
let busyNoted = Number.NEGATIVE_INFINITY;
const busyNote = () => {
  if (performance.now() - busyNoted < 2000) return;
  busyNoted = performance.now();
  showToast('还在计算上一步，稍等一下');
};
export const isBusy = () => {
  if (busy.value === null) return false;
  busyNote();
  return true;
};
// 正在新建、打开、导出（世界可能马上换掉）：排队的工具也要等。只是在算前面的编辑时可以排队
const blockedByOther = () => busy.value !== null && !onlyEditsPending();

// 一笔：经过的格与到笔画中心线的最近归一化距离 t（0 中心，1 边缘）
let strokeIds = 0;
class Stroke {
  t = new Map<number, number>();
  id = ++strokeIds;
  // 改过几次（涂到新的格、离中心线更近）：确切预览、幽灵海岸按它判断还是不是同一笔（笔没变就沿用同一个结果）
  rev = 0;
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
        if (prev === undefined || b.t[j] < prev) {
          this.t.set(c, b.t[j]);
          this.rev++;
        }
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
  layers: (w: World, s: Stroke, shift: boolean) => { layers: HighlightLayer[]; hint?: string; warn?: boolean; caution?: boolean; provinces?: ProvincePreview | null; ghost?: GhostEdit | null };
  // 松手后排在队里、前面的编辑换上了新世界时，按新世界重算这一笔的幽灵海岸。在松手时调用：用到的选项（画陆地还是画海……）
  // 按松手时的定下来，与 commit 发出的命令相同（之后在底部条上换了也不跟着变）。省略时用 layers 重算（只看笔画、不看选项的画笔）
  ghostAt?: (s: Stroke, shift: boolean) => (w: World) => GhostEdit | null;
  commit: (w: World, s: Stroke, shift: boolean) => Promise<unknown>;
  // 画笔圈画在半径的几倍处：最后一个是主圈（悬停时虚线、按住时实线），前面的是细实线。省略时只在半径处画一圈
  rings?: number[];
  // 确切预览：松手时会执行的命令（commit 执行的就是它）。有这一项的画笔，按住停顿 250 毫秒时在世界的副本上
  // 算一遍，地图画出将来的世界、变了的格描边；拖底部条的滑块时在鼠标最后停的地方确切地预览涂一下
  exact?: (w: World, s: Stroke, shift: boolean) => Command | null;
  // 确切的结果到了以后鼠标旁的那句话（如“森林 · 38 格会变 · 6 格没涂成”）
  exactHint?: (w: World, s: Stroke, shift: boolean, r: PreviewResult) => string;
  // 画笔圈外再画一道淡淡的虚线圈：周围跟着变的范围（自然融入的过渡，地图单位）；null 不画
  reach?: (w: World) => number | null;
  // 工具选中时一直画着的东西（橡皮擦：能擦的格）
  backdrop?: (w: World) => Backdrop | null;
  // 空闲悬停时鼠标旁的一句话：画笔圈住的格里有什么（橡皮擦：“这里：画过陆地、堆过山”）。p：鼠标
  here?: (w: World, cells: number[], p: Pointer) => string | null;
}

// 一笔涂多重的预览深浅：变化量占滑块最大值的比例，最淡也有 0.35（力度很小时也看得见涂到了哪里）
export const strengthValues = (deltas: number[], max: number) => deltas.map((d) => 0.35 + 0.65 * Math.min(1, Math.abs(d) / max));

// 选项的编号：确切预览的 key 用它（换了生态、力度、过渡，就不是同一个预览）
const optionIds = new WeakMap<ToolOptions, number>();
let nextOptionId = 1;
const optionsId = () => {
  let id = optionIds.get(options.value);
  if (!id) optionIds.set(options.value, (id = nextOptionId++));
  return id;
};

// 图层里只留一部分格（确切预览之后新涂的格）
function onlyCells(l: HighlightLayer, keep: (c: number) => boolean): HighlightLayer {
  const cells: number[] = [];
  const values: number[] = [];
  l.cells.forEach((c, k) => {
    if (!keep(c)) return;
    cells.push(c);
    if (l.values) values.push(l.values[k]);
  });
  return { ...l, cells, values: l.values ? values : undefined };
}

// 确切预览的说法：几格会变、这一笔里几格没涂成
function exactCounts(r: PreviewResult, cells: Iterable<number>): { changed: number; failing: number } {
  const mine = new Set(cells);
  return { changed: r.changedCells.length, failing: r.failing.filter((c) => mine.has(c)).length };
}

// 画笔可以排队：前面的笔画还在算时照样能画，松手后按顺序执行，各自是一步（结果与一笔一笔等着画相同）。
// 排队中的笔画一直显示松手时的预览（高亮、省界、幽灵海岸，见 pending.ts），直到结果换上（不先跳回原样，也不变成白色的“等待”）。
// 有确切预览的画笔（cfg.exact）：按住停顿时地图画出将来的世界；之后接着画也不跳回原样（一直显示上一个确切预览，
// 新涂的格淡淡地涂上估计的颜色），直到新的确切预览换上。松手执行的是同一条命令，Worker 直接采用算好的结果
function brushTool(cfg: BrushConfig): ToolHandler {
  let stroke: Stroke | null = null;
  let pointer: Pointer | null = null;
  // 鼠标在不在地图上：离开后只留排队中的笔画（拖滑块时照样在最后停的地方预览）
  let inside = false;
  // 本工具排队中的笔画（画在地图上的是 pending.ts 里的那一份）：有确切预览的带着它（key：松手时这一笔的确切预览的 key）
  type Queued = { s: Stroke; shift: boolean; key: string; view: ExactView | null };
  let queued: Queued[] = [];
  const ex = new Exact();
  // 每个确切预览算的时候这一笔已经涂到了哪些格：之后新涂的格另外淡淡地涂上估计的颜色
  const covered = new Map<string, Set<number>>();
  // 不带世界：这一笔的格松手前不再变，命令也就不变；排在前面的笔画算完、世界换了，按新世界算的预览照样是它的结果
  const keyOf = (s: Stroke, shift: boolean) => `${s.id}|${s.rev}|${shift}|${optionsId()}`;
  const wantExact = (s: Stroke, shift: boolean, pause?: number) => {
    const key = keyOf(s, shift);
    ex.want(
      key,
      () => {
        // 停顿期间又涂了几格（还没来得及重画）：等下一次
        const w = world.value;
        if (!w || keyOf(s, shift) !== key || !s.t.size) return null;
        const cmd = cfg.exact!(w, s, shift);
        if (cmd) covered.set(key, new Set(s.t.keys()));
        return cmd;
      },
      pause,
    );
    return key;
  };
  // 确切预览到了：变了的格描边（将来的颜色由地图画出来），之后新涂的格淡淡地涂上估计的颜色。按预览与这一笔缓存
  const exactCache = new WeakMap<Stroke, { v: ExactView; rev: number; o: ToolOptions; layers: HighlightLayer[] }>();
  const exactLayers = (v: ExactView, s: Stroke, est: () => HighlightLayer[]): HighlightLayer[] => {
    const c = exactCache.get(s);
    if (c?.v === v && c.rev === s.rev && c.o === options.value) return c.layers;
    const cov = covered.get(v.key);
    const added = (cov ? est().map((l) => onlyCells(l, (i) => !cov.has(i))) : est()).filter((l) => l.cells.length);
    const layers: HighlightLayer[] = [{ cells: v.result.changedCells, color: WHITE, pattern: 'outline' }, ...added];
    exactCache.set(s, { v, rev: s.rev, o: options.value, layers });
    return layers;
  };
  // 排队中的笔画能显示的确切预览：松手后才算好的（还在 ex 里）优先；世界换了就没有
  const viewOf = (q: Queued, now: World): ExactView | null => {
    const v = ex.view?.key === q.key ? ex.view : q.view;
    return v && v.base === now ? v : null;
  };
  // 新的一笔、换工具之前：松手后才算好的确切预览交给它的排队项（ex 马上要清掉）
  const handOver = () => {
    for (const q of queued) if (ex.view?.key === q.key) q.view = ex.view;
  };
  // 排队中的一笔现在画成什么样（地图每帧问一次，见 pending.ts）：世界换了（排在前面的编辑算完换上了）就按新世界
  // 重算它的幽灵海岸，排在最前的那一笔的增量因此与执行时相同；松手后才算好的确切预览到了，画出将来的世界、
  // 变了的格描边。输入没变就给同一个对象（地图不必重新上传）
  const liveOf = (q: Queued, at: Preview, w0: World, ghostAt: (w: World) => GhostEdit | null) => {
    let memo: { w: World; v: ExactView | null; out: Preview } | null = null;
    let ghost: { w: World; g: GhostEdit | null } = { w: w0, g: at.ghost ?? null };
    return (now: World): Preview => {
      const v = viewOf(q, now);
      if (memo?.w === now && memo.v === v) return memo.out;
      if (at.ghost && ghost.w !== now) ghost = { w: now, g: ghostAt(now) };
      let out: Preview = ghost.g === at.ghost ? at : { ...at, ghost: ghost.g };
      if (v) out = { ...out, layers: exactLayers(v, q.s, () => at.layers), world: v.world };
      memo = { w: now, v, out };
      return out;
    };
  };
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
  let dab: { w: World; o: ToolOptions; p: Pointer; s: Stroke; layers: HighlightLayer[]; hint: string | null; warn?: boolean; ghost: GhostEdit | null } | null = null;
  const dabAt = (w: World, p: Pointer) => {
    if (dab?.w !== w || dab.o !== options.value || dab.p !== p) {
      const s = new Stroke();
      if (p.cell >= 0) s.add(w, p.x, p.y, cfg.filter && ((i) => cfg.filter!(w, i)));
      // 特别大的画笔（两万格以上）不预览，免得拖滑块卡顿
      const r = s.t.size && s.t.size <= 20000 ? cfg.layers(w, s, p.shift) : null;
      dab = { w, o: options.value, p, s, layers: r?.layers ?? [], hint: r?.hint ?? null, warn: r?.warn, ghost: r?.ghost ?? null };
    }
    return dab;
  };
  // 空闲悬停时画笔圈住的格（橡皮擦说这里改过什么）：鼠标、世界、半径没变就沿用
  let hereMemo: { w: World; p: Pointer; km: number; text: string | null } | null = null;
  const hereAt = (w: World, p: Pointer): string | null => {
    if (!cfg.here || p.cell < 0) return null;
    if (hereMemo?.w !== w || hereMemo.p !== p || hereMemo.km !== options.value.brushKm) {
      // 很大的画笔只看鼠标下面那一格（每次移动都搜整个画笔圈太费：最大的画笔有几万格）
      const big = brushR(w) > 60 * w.mesh.spacing;
      const cells = big ? [p.cell] : brushCells(w, p.x, p.y, options.value.brushKm).cells;
      hereMemo = { w, p, km: options.value.brushKm, text: cfg.here(w, cells, p) };
    }
    return hereMemo.text;
  };
  const ringsAt = (w: World, p: Pointer): Shape[] => {
    const r = brushR(w);
    const ks = cfg.rings ?? [1];
    const shapes = ks.map((k, j): Shape =>
      j === ks.length - 1
        ? { kind: 'circle', x: p.x, y: p.y, r: r * k, dashed: !stroke, geodesic: true }
        : { kind: 'circle', x: p.x, y: p.y, r: r * k, color: 'rgba(255, 255, 255, 0.6)', width: 1, geodesic: true },
    );
    const reach = cfg.reach?.(w);
    if (reach) shapes.unshift({ kind: 'circle', x: p.x, y: p.y, r: r + reach, dashed: true, color: 'rgba(255, 255, 255, 0.35)', width: 1, geodesic: true });
    return shapes;
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
      // 新的一笔：上一笔松手后才算好的确切预览交给它的排队项，拖滑块时预览的那一下不要了
      handOver();
      ex.clear();
      // 排队中的笔画用得到的留着：已经交过去的，和松手时还在算、回来才交过去的（见 up）
      const kept = new Set(queued.flatMap((q) => [q.key, q.view?.key]));
      for (const k of [...covered.keys()]) if (!kept.has(k)) covered.delete(k);
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
      if (!w || !s || !s.t.size) {
        ex.clear();
        return;
      }
      // 不再算新的确切预览（已经发出去的照算：它就是这一笔的结果，执行时直接采用）
      const key = cfg.exact ? keyOf(s, p.shift) : '';
      ex.stop();
      // 松手时的预览（高亮、省界、幽灵海岸）留在图上，直到这一笔的结果换上；之后算好的确切预览也画在它上面
      const r = cfg.layers(w, s, p.shift);
      const q: Queued = { s, shift: p.shift, key, view: ex.view };
      const at: Preview = { layers: r.layers, shapes: [], hint: null, provinces: r.provinces ?? null, ghost: r.ghost ?? null };
      // 松手时还在算的就是这一笔的确切预览：回来时直接交给它。接着画下一笔、换了工具（ex 清掉了）也不丢，
      // 回来就画出将来的世界，不等到结果换上时才跳过去
      void (key ? ex.late(key) : null)?.then((v) => {
        if (!v) return;
        q.view = v;
        redrawTick.value++;
      });
      const ghostAt = cfg.ghostAt?.(s, p.shift) ?? ((now: World) => cfg.layers(now, s, p.shift).ghost ?? null);
      queued.push(q);
      try {
        await trackEdit(at, cfg.commit(w, s, p.shift), liveOf(q, at, w, ghostAt));
      } finally {
        queued = queued.filter((x) => x !== q);
      }
    },
    cancel() {
      stroke = null;
      handOver();
      ex.clear();
    },
    leave() {
      inside = false;
    },
    backdrop() {
      const w = world.value;
      return w && cfg.backdrop ? cfg.backdrop(w) : null;
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      // 排队时（前面的编辑还没算完）：排队中的笔画由地图照旧画出松手时的预览（见 pending.ts），鼠标旁说一声
      const inLine = queuedCount() ? `正在计算…（${queuedCount()} 步）` : null;
      if (!stroke) {
        // 松开了滑块：不再预览涂一下（空闲悬停只有圈）
        if (!sliderActive.value) ex.stop();
        if (!inside && !sliderActive.value) return EMPTY;
        const h = cfg.hint(pointer.shift);
        if (sliderActive.value && !h.warn) {
          const d = dabAt(w, pointer);
          // 拖滑块：在这里确切地涂一下会怎样（只在拖滑块、没有排队时；空闲悬停只有圈）
          if (cfg.exact && d.s.t.size && d.s.t.size <= 20000 && !queuedCount()) {
            const key = wantExact(d.s, pointer.shift, 200);
            const v = ex.view?.key === key ? ex.view : null;
            if (v) return { layers: exactLayers(v, d.s, () => d.layers), shapes: ringsAt(w, pointer), hint: '在这里涂会这样', sliderHint: true, world: v.world };
          }
          return { layers: d.layers, shapes: ringsAt(w, pointer), hint: inLine ?? d.hint, warn: d.warn, sliderHint: true, ghost: d.ghost };
        }
        return { layers: h.warn ? [] : footprint(w, pointer), shapes: ringsAt(w, pointer), hint: h.warn ? h.text : (inLine ?? hereAt(w, pointer) ?? h.text), warn: h.warn };
      }
      const r = cfg.layers(w, stroke, pointer.shift);
      // 做不了、要留意的话比排队要紧
      const head = r.warn || r.caution ? null : queueHint();
      const own = { shapes: ringsAt(w, pointer), warn: r.warn, caution: r.caution, provinces: r.provinces ?? null, ghost: r.ghost ?? null };
      if (cfg.exact) {
        // 按住停顿 250 毫秒：确切预览；接着画时一直显示上一个，直到新的换上（不跳回原样）
        const key = wantExact(stroke, pointer.shift);
        const v = ex.view;
        // 太慢不再自动预览：说松手后大约几秒（留着的上一个确切预览不会再被换掉，不写“…”）
        const slow = ex.slow !== null ? `，松手后约 ${ex.slow} 秒出结果` : '';
        if (v) {
          const s = stroke;
          const hint = v.key === key && cfg.exactHint ? cfg.exactHint(w, s, pointer.shift, v.result) : `${r.hint ?? ''}${slow || '…'}`;
          return { ...own, layers: exactLayers(v, s, () => r.layers), hint: head ?? hint, world: v.world };
        }
        return { ...own, layers: r.layers, hint: head ?? `${r.hint ?? ''}${slow}` };
      }
      return { ...own, layers: r.layers, hint: head ?? r.hint ?? null };
    },
  };
}

// ---------- 地形 ----------

export function landTool(): ToolHandler {
  const modeOf = (shift: boolean) => {
    const m = options.value.landMode;
    return shift ? (m === 'land' ? 'sea' : 'land') : m;
  };
  // 画的时候直接画出将来的海岸线（幽灵海岸），不再涂绿、涂蓝。笔没动就沿用同一个结果
  let memo: { w: World; s: Stroke; v: number; mode: string; out: ReturnType<BrushConfig['layers']> } | null = null;
  const brush = brushTool({
    hint: () => ({ text: null }),
    layers(w, s, shift) {
      const mode = modeOf(shift);
      if (memo?.w === w && memo.s === s && memo.v === s.rev && memo.mode === mode) return memo.out;
      const r = landStroke(w, s.cells, s.ts, mode);
      const p = previewLand(w, r.cells, r.delta);
      const out = { layers: [], ghost: { cells: r.cells, delta: r.delta }, hint: mode === 'land' ? `陆地 +${p.gained.length} 格` : `陆地 −${p.lost.length} 格` };
      memo = { w, s, v: s.rev, mode, out };
      return out;
    },
    // 排队时按新的世界重算：画陆地还是画海按松手时的（与发出的命令相同；之后在底部条上换了也不跟着变）
    ghostAt(s, shift) {
      const mode = modeOf(shift);
      return (w) => {
        const r = landStroke(w, s.cells, s.ts, mode);
        return { cells: r.cells, delta: r.delta };
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
// 预览与松手后提交的是同一个圈（每移动半格记一个点），地图上画出的将来的海岸线就是结果。
// 前面的编辑还在算时也能圈（排队，松手时的预览留到结果换上）：命令只看圈住的格，与等着圈相同
function lassoTool(modeOf: (shift: boolean) => 'land' | 'sea'): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  let ringId = 0;
  let cache: { key: string; cells: number[]; t: number[]; gained: number[]; lost: number[]; ghost: GhostEdit } | null = null;
  const compute = (w: World, pts: [number, number][], mode: 'land' | 'sea') => {
    const key = `${worldId(w)}|${ringId}|${pts.length}|${mode}`;
    if (cache?.key === key) return cache;
    const r = lassoStroke(w, pts);
    const st = landStroke(w, r.cells, r.t, mode);
    const p = previewLand(w, st.cells, st.delta);
    // 幽灵海岸跟着缓存走：同一个圈不必重算，松手后排队时照样用它
    cache = { key, cells: r.cells, t: r.t, gained: p.gained, lost: p.lost, ghost: { cells: st.cells, delta: st.delta } };
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
      // 松手时的样子（合上的圈与将来的海岸线）留在图上，直到结果换上；圈马上空出来，可以接着圈下一个。
      // 排在前面的编辑先换上了：幽灵海岸按新的世界重算（命令只看圈住的格，结果按执行时的世界算）
      ring = null;
      const shapes: Shape[] = [{ kind: 'line', points: [...pts, pts[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5 }];
      const at: Preview = { layers: [], shapes, hint: null, ghost: c.ghost };
      const ghostAt = (now: World): GhostEdit => {
        const st = landStroke(now, c.cells, c.t, mode);
        return { cells: st.cells, delta: st.delta };
      };
      await trackEdit(at, exec({ op: 'paint_land', cells: c.cells, t: c.t, mode }), ghostFollows(at, w, ghostAt));
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

// 只有一个图层的背景：同一个图层给同一个对象
const hatchBacks = new WeakMap<HighlightLayer, Backdrop>();
function oneLayer(layer: HighlightLayer | null): Backdrop | null {
  if (!layer) return null;
  let b = hatchBacks.get(layer);
  if (!b) hatchBacks.set(layer, (b = { layers: [layer], shapes: [] }));
  return b;
}

// 恢复原样：画到的地方，画过的陆地、海、山和放的岛都退回生成时的样子（中间全收回，边上渐变）。
// 选中时地图上一直用浅斜线标出改过的格（见 edits.ts），悬停说这里改过什么；重画过的范围画成虚线圈（不归它管）。
// 只涂得到改过的格（淡淡的白色）；地图上直接画出恢复后的海岸线
export function restoreTool(): ToolHandler {
  // 擦的时候连看不出的零头一起擦掉（标出来的只是看得出的改动）
  const edited = (w: World, i: number) => w.causes.landDelta[i] !== 0 || w.causes.upliftDelta[i] !== 0 || w.causes.erodDelta[i] !== 0;
  let memo: { w: World; s: Stroke; v: number; out: ReturnType<BrushConfig['layers']> } | null = null;
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
      const out = {
        layers: [{ cells: s.cells, values: s.weights(), color: WHITE, alpha: 0.25 }],
        ghost: { cells: r.cells, delta: r.delta },
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
export const worldId = (w: World) => {
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
    // 小礁不看大小：占一格（画出来的海岸约半格大，但它是一整格陆地），说一格有多大
    const diameter = km(reef ? w.mesh.spacing * w.kmPerUnit : spec.size * 2);
    let block: string | null = null;
    if (spec.kind === 'atoll' && !w.causes.land[center.cell] && w.derived.tMean[center.cell] < 20) {
      block = `海水太凉（${Math.round(w.derived.tMean[center.cell])} °C），珊瑚岛要 20 °C 以上`;
    }
    const stamp = islandStamp(w, spec);
    const fresh = stamp.footprint.filter((c) => !w.causes.land[c]);
    if (!block && !fresh.length) block = '这里已经是陆地';
    // 放得下：地图上直接画出岛将来的海岸线（小礁也是，画出来约半格大）；放不下：轮廓涂红
    const preview: Preview = {
      layers: block ? [{ cells: stamp.footprint, color: [230, 90, 70], alpha: 0.75 }] : [],
      shapes: drag?.km ? [{ kind: 'line', points: [[drag.x, drag.y], [pointer.x, pointer.y]], color: 'rgba(255,255,255,0.85)', width: 1.5, dashed: true }] : [],
      hint: block ?? (reef ? `${name} · 一格（约 ${diameter} km）` : `${name} · ${diameter} km`),
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
      const w = world.value;
      const c = compute();
      drag = null;
      if (!c?.spec || !w) return;
      if (c.block) {
        showToast(c.block, true);
        return;
      }
      const spec = c.spec;
      // 滑块停在拖出的大小；下一个岛换个形状（悬停的预览里看得到）
      setOptions({ islandVariant: spec.variant + 1, ...(d.km !== null ? { islandKm: d.km } : {}) });
      const mark = { sx: p.sx, sy: p.sy };
      settled = mark;
      // 松手时的岛（将来的海岸线）留在图上直到结果换上，鼠标离开地图也留着，不闪回原来的海岸（拖大小的虚线不留）。
      // 排在前面的编辑先换上了：按新的世界重算（结果按执行时的世界算）
      const shown: Preview = { layers: c.preview.layers, shapes: [], hint: null, ghost: c.preview.ghost };
      const ghostAt = (now: World): GhostEdit => {
        const st = islandStamp(now, spec);
        return { cells: st.cells, delta: st.landDelta };
      };
      try {
        // 小礁只有一种样子：不用“换个形状”
        await trackEdit(shown, exec({ op: 'add_island', island: spec }, '正在造岛…', spec.kind === 'reef' ? undefined : islandAgain(spec)), ghostFollows(shown, w, ghostAt));
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

// 上一条画完的岛链（第十二轮）：工具栏的“换个排列”、R 重新排它。done：那时做完的步数（之后又做了别的、撤销了就不再是它）
let lastChain: { again: Again; done: number } | null = null;
const doneSteps = () => history.value.filter((h) => h.done);
const CHAIN_SUMMARY = '画了一条岛链';

// 工具栏的“换个排列”、R：上一条岛链还是最后一步时换下一种排列重放它（与松手后提示里的“换个排列”相同：只算一次，历史里只留一步）；
// 不是时（之后又改了别的、撤销了）换下一条岛链的排列，并说一声
export async function rerollChain(): Promise<void> {
  const lc = lastChain;
  const steps = doneSteps();
  const still = lc !== null && steps.length === lc.done && (steps.at(-1)?.summary.startsWith(CHAIN_SUMMARY) ?? false);
  if (!still) {
    setOptions({ chainVariant: options.value.chainVariant + 1 });
    showToast(lc ? '上一条岛链之后又改了别的：下一条岛链换个排列' : '画一条岛链之后，这里会重新排它；现在换的是下一条的排列');
    return;
  }
  if (!editsIdle()) {
    showToast('等排队的几步算完再换');
    return;
  }
  const next = lc.again.next();
  if (next) await replaceLast(next, '正在造岛链…', lc.again);
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
    // 岛链用自己的种类和大小（小一号的岛最小到 islandMinCells，太小时岛心那一格成陆）
    const size = w ? Math.max(islandSizeRangeKm(w, o.chainKind)[0], o.chainKm) : o.chainKm;
    return { points: use, kind: o.chainKind, size, density: o.chainDensity, variant: o.chainVariant };
  };
  // 一条岛链的预览（按世界与参数缓存）：与命令同一个规则（太小的岛岛心那一格成陆），预览就是结果
  const previewOf = (w: World, spec: ChainSpec): Preview => {
    const key = `${worldId(w)}|${JSON.stringify(spec)}`;
    if (cache?.key !== key) {
      const islands = chainIslands(w, spec);
      const stamp = combineStamps(w, islands);
      cache = {
        key,
        preview: {
          layers: [],
          shapes: [{ kind: 'line', points: spec.points, dashed: true, color: 'rgba(255,255,255,0.8)' }],
          hint: `${islands.length} 个${ISLAND_KIND_INFO[spec.kind].name}`,
          // 地图上直接画出岛链将来的海岸线
          ghost: { cells: stamp.cells, delta: stamp.landDelta },
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
      // 松手时的岛（将来的海岸线）与线留在图上，直到结果换上（滑块马上换到下一种排列，不能再按滑块重算）。
      // 排在前面的编辑先换上了：按新的世界重算（结果按执行时的世界算）
      const at: Preview = { ...previewOf(w, chain), hint: null };
      const ghostAt = (now: World): GhostEdit => {
        const st = combineStamps(now, chainIslands(now, chain));
        return { cells: st.cells, delta: st.landDelta };
      };
      setOptions({ chainVariant: chain.variant + 1 });
      const again = chainAgain(chain);
      const run = exec({ op: 'add_island_chain', chain }, '正在造岛链…', again);
      await trackEdit(at, run, ghostFollows(at, w, ghostAt));
      if (await run) lastChain = { again, done: doneSteps().length };
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
  const radius = (w: World) => Math.max(brushR(w), w.mesh.spacing * 1.2);
  // 与命令同一份参数（variant 是下一次重画的编号）
  const rerollAt = (w: World, p: Pointer) => ({ x: keepX(w, p.x), y: p.y, radius: radius(w), variant: (w.small.terrain.gen?.rerolls.length ?? 0) + 1 });
  const keyOf = (w: World, r: ReturnType<typeof rerollAt>) => `${worldId(w)}|${r.x}|${r.y}|${r.radius}|${r.variant}`;
  let exact: { key: string; t: TerrainPreview; layers: HighlightLayer[]; hint: string; empty: boolean } | null = null;
  let wantKey = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 点了以后：等预览、算的期间（held：点的那一份预览）
  let clicking = false;
  let held: { t: TerrainPreview; layers: HighlightLayer[] } | null = null;
  // 成本闸门（与确切预览同一个，见 state.ts 的 slowPreview）：上一次重画这一片（预览或执行）超过约 600 毫秒，
  // 就不再自动预览，说松手后大约要等几秒；不慢时为 0
  const slowSec = (r: ReturnType<typeof rerollAt>) => slowPreview({ op: 'reroll_region', ...r }) ?? 0;
  const request = async (r: ReturnType<typeof rerollAt>, key: string) => {
    const t = await previewTerrainOnce({ reroll: r });
    if (!t) return null;
    if (t.ms !== undefined) noteCost({ op: 'reroll_region', ...r }, t.ms);
    const empty = !t.gained.length && !t.lost.length && !t.relief.cells.length;
    const hint = empty ? '这一片重画不出变化' : t.gained.length || t.lost.length ? `重画：陆地 +${t.gained.length} / −${t.lost.length} 格` : '重画：只变山的高低';
    const v = { key, t, layers: reliefLayers(t.relief), hint, empty };
    if (key === wantKey) {
      exact = v;
      redrawTick.value++;
    }
    return v;
  };
  const want = (w: World, r: ReturnType<typeof rerollAt>) => {
    const key = keyOf(w, r);
    if (key === wantKey) return;
    wantKey = key;
    if (timer) clearTimeout(timer);
    timer = null;
    if (slowSec(r)) return;
    timer = setTimeout(() => void request(r, key), 150);
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    wantKey = '';
  };
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
        showToast('空白海洋没有可以重画的地形；先用“画陆地”或“放岛”', true);
        return;
      }
      const r = rerollAt(w, p);
      const key = keyOf(w, r);
      // 还没预览过（点得快）：先算一遍再决定，慢的世界不等
      wantKey = key;
      clicking = true;
      try {
        const v = exact?.key === key ? exact : slowSec(r) ? null : await request(r, key);
        if (world.value !== w) return;
        if (v?.empty) {
          showToast('这一片重画不出变化', true);
          return;
        }
        held = v;
        await exec({ op: 'reroll_region', ...r }, '正在重画…');
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
      if (exact?.key === keyOf(w, r)) return { layers: exact.layers, shapes: [ring], hint: exact.hint, warn: exact.empty, terrain: exact.empty ? null : exact.t };
      const sec = slowSec(r);
      return { layers: [], shapes: [ring], hint: sec ? `松手后约 ${sec} 秒出结果` : null };
    },
  };
}

// ---------- 自然 ----------

const speciesOf = (w: World, id: string | null) => (id ? w.small.species.find((s) => s.id === id) : undefined);

function constraintCmd(cells: number[], species: string) {
  const o = options.value;
  return { op: 'add_constraint' as const, constraint: { cells, species, mode: o.biomeMode === 'natural' ? ('constraint' as const) : ('override' as const), ratio: 1, radius: o.reachKm, label: '' } };
}

// 确切预览的结果怎么说：几格生态会变（没有变的说“生态不变”）
const biomeChange = (r: PreviewResult) => (r.changedCells.length ? `${r.changedCells.length} 格生态会变` : '生态不变');

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
      // 估计：涂到的格淡淡地涂上这种生态的颜色（停一下就换成确切的结果）
      return { layers: [{ cells: s.cells, color: hexToRgb(sp.color), alpha: 0.35 }], hint: `${sp.name} ${s.t.size} 格` };
    },
    exact: (w, s) => (speciesOf(w, options.value.biome) && s.t.size ? constraintCmd(s.cells, options.value.biome!) : null),
    exactHint(w, s, _shift, r) {
      const sp = speciesOf(w, options.value.biome)!;
      const { changed, failing } = exactCounts(r, s.t.keys());
      return `${sp.name} · ${changed} 格会变${failing ? ` · ${failing} 格没涂成` : ''}`;
    },
    // 自然融入：周围这么远跟着平滑过渡
    reach: (w) => (options.value.biomeMode === 'natural' ? options.value.reachKm / w.kmPerUnit : null),
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

// 拖动扩张：按住一片生态往外拖。手停下 250 毫秒时确切地预览（与涂生态一样），松手执行同一条命令
export function growTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let start: { x: number; y: number; cell: number; region: number[]; species: number } | null = null;
  let committing = false;
  let cache: { key: string; grown: number[] } | null = null;
  const ex = new Exact();
  // 确切预览算的时候扩张到了哪些格（之后多出来的格另外淡淡地涂上）
  const covered = new Map<string, Set<number>>();
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
      ex.clear();
      covered.clear();
    },
    move(p) {
      pointer = p;
    },
    async up() {
      const w = world.value;
      if (!w || !start || committing) return;
      const grown = grownNow(w);
      const sp = w.small.species[start.species];
      // 不再算新的确切预览；已经算好的一直显示到结果换上
      ex.stop();
      if (!grown.length || !sp) {
        start = null;
        ex.clear();
        return;
      }
      committing = true;
      try {
        await exec(constraintCmd(grown, sp.id), '正在计算生态…');
      } finally {
        committing = false;
        start = null;
        cache = null;
        ex.clear();
      }
    },
    cancel() {
      if (!committing) {
        start = null;
        ex.clear();
      }
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
      const shapes: Shape[] = [{ kind: 'arrow', points: [[start.x, start.y], [pointer.x, pointer.y]], color: 'rgba(255, 240, 140, 0.95)', width: 2.5 }];
      const key = `${cache?.key}|${optionsId()}`;
      if (!committing && grown.length && sp) {
        ex.want(key, () => {
          if (world.value !== w || `${cache?.key}|${optionsId()}` !== key) return null;
          covered.set(key, new Set(grown));
          return constraintCmd(grown, sp.id);
        });
      }
      const v = ex.view;
      const slow = ex.slow !== null ? `，松手后约 ${ex.slow} 秒出结果` : '';
      if (v && sp) {
        // 确切预览：地图画出将来的世界，变了的格描边；之后多拖出来的格淡淡地涂上
        const cov = covered.get(v.key);
        const added = cov ? grown.filter((c) => !cov.has(c)) : grown;
        const { changed, failing } = exactCounts(v.result, grown);
        return {
          layers: [{ cells: v.result.changedCells, color: WHITE, pattern: 'outline' }, ...(added.length ? [{ cells: added, color: hexToRgb(sp.color), alpha: 0.35 }] : [])],
          shapes,
          hint: committing ? '正在计算…' : v.key === key ? `${sp.name} +${grown.length} 格 · ${changed} 格会变${failing ? ` · ${failing} 格没涂成` : ''}` : `${sp.name} +${grown.length} 格${slow || '…'}`,
          world: v.world,
        };
      }
      return {
        layers: [
          { cells: start.region, color: WHITE, alpha: 0.3 },
          { cells: grown, color: hexToRgb(sp.color), alpha: 0.8 },
        ],
        shapes,
        hint: committing ? '正在计算…' : `${sp.name} +${grown.length} 格${slow}`,
      };
    },
  };
}

const CLIMATE_INFO = {
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
  // 松手时执行的命令（确切预览算的也是它）
  const cmdOf = (s: Stroke, shift: boolean): Command => {
    const e = climateEffect(kindOf(shift), options.value.climateAmount);
    return { op: 'paint', field: e.field, cells: s.cells, values: s.weights().map((wt) => wt * e.value), mode: 'add' };
  };
  const head = (shift: boolean) => {
    const c = kindOf(shift);
    return `${CLIMATE_INFO[c].name} ${climateEffect(c, options.value.climateAmount).short}`;
  };
  return brushTool({
    hint: () => ({ text: null }),
    layers(_w, s, shift) {
      const c = kindOf(shift);
      const amount = options.value.climateAmount;
      // 深浅跟着力度：拖“力度”滑块时预览跟着变
      const values = strengthValues(s.weights().map((wt) => wt * amount), CLIMATE_MAX);
      return { layers: [{ cells: s.cells, values, color: CLIMATE_INFO[c].color, alpha: 0.65 }], hint: head(shift) };
    },
    exact: (_w, s, shift) => (s.t.size ? cmdOf(s, shift) : null),
    exactHint: (_w, _s, shift, r) => `${head(shift)} · ${biomeChange(r)}`,
    commit: (_w, s, shift) => exec(cmdOf(s, shift), '正在计算气候…'),
  });
}

// 擦掉冷暖干湿的改动：只涂得到改过的格，中心全收回、边缘渐变。
// 选中时地图上一直用浅斜线标出改过的格，悬停说这里改过什么（不管自定义场和生态对周围的影响）
export function climateEraseTool(): ToolHandler {
  const changed = (w: World, i: number) => w.causes.tempOffset[i] !== 0 || w.causes.moistOffset[i] !== 0;
  return brushTool({
    hint: () => ({ text: null }),
    filter: changed,
    backdrop: (w) => oneLayer(erasableLayer(climateMask(w))),
    here: (w, cells) => climateHere(w, cells),
    layers(_w, s) {
      return { layers: [{ cells: s.cells, values: s.weights(), color: WHITE, alpha: 0.6 }], hint: s.t.size ? `擦掉 ${s.t.size} 格` : '这里没改过' };
    },
    exact: (_w, s) => (s.t.size ? { op: 'restore_climate', cells: s.cells, t: s.ts } : null),
    exactHint: (_w, s, _shift, r) => `擦掉 ${s.t.size} 格 · ${biomeChange(r)}`,
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
function landmassOf(w: World, cell: number): GeoFeature | null {
  let m = landmassCache.get(w);
  if (!m) {
    m = new Map();
    for (const f of w.derived.features) if (f.type === 'island' || f.type === 'continent') for (const c of f.cells) m.set(c, f);
    landmassCache.set(w, m);
  }
  return m.get(cell) ?? null;
}

// 岛在哪个群岛里（没有时 null）。群岛的名字标在地图上时，岛自己的名字常常让开不标：说岛时带上群岛的名字
const archipelagoCache = new WeakMap<World, Map<number, GeoFeature>>();
function archipelagoOf(w: World, f: GeoFeature): GeoFeature | null {
  let m = archipelagoCache.get(w);
  if (!m) {
    m = new Map();
    for (const a of w.derived.features) if (a.type === 'archipelago') for (const c of a.cells) m.set(c, a);
    archipelagoCache.set(w, m);
  }
  return m.get(f.anchor) ?? m.get(f.cells[0]) ?? null;
}

// 岛的叫法：在群岛里的写成“炎柳岛（二雁列岛）”
function islandLabel(w: World, f: GeoFeature): string {
  const a = archipelagoOf(w, f);
  return a?.name && a.name !== f.name ? `${f.name}（${a.name}）` : f.name;
}

// ---------- 第十二轮：给生态选“长在哪里” ----------
// 生态编辑器里点“选岛”“圈一下”进来：点一个岛（那块陆地）或按住圈一片，选好回到生态编辑器。
// back：进来之前用的工具（选好、取消都换回它）
export const rangePick = signal<{ species: string; kind: 'island' | 'cells'; back: ToolId } | null>(null);

// 选好、取消：换回原来的工具，打开生态编辑器
function leaveRangePick() {
  const pick = rangePick.value;
  rangePick.value = null;
  if (!pick) return;
  focusSpecies.value = pick.species;
  sheet.value = 'species';
  void import('./defs/tools').then((m) => m.setTool(pick.back));
}
export const cancelRangePick = leaveRangePick;

export function rangeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let ring: [number, number][] | null = null;
  // 鼠标下的那块陆地（同一块不重算）
  let mass: { w: World; mask: Uint8Array; cells: number[]; layer: HighlightLayer } | null = null;
  const massAt = (w: World, cell: number) => {
    if (cell < 0 || w.causes.land[cell] !== 1) return null;
    if (mass?.w !== w || !mass.mask[cell]) {
      const mask = landmassCells(w, cell);
      const cells: number[] = [];
      for (let i = 0; i < mask.length; i++) if (mask[i]) cells.push(i);
      mass = { w, mask, cells, layer: { cells, color: WHITE, alpha: 0.35 } };
    }
    return mass;
  };
  const target = () => {
    const pick = rangePick.value;
    const w = world.value;
    return pick && w ? { pick, w, sp: w.small.species.find((x) => x.id === pick.species) ?? null } : null;
  };
  const commit = async (range: { kind: 'island'; cell: number } | { kind: 'cells'; cells: number[] }, what: string) => {
    const t = target();
    if (!t?.sp) return leaveRangePick();
    const ok = await exec({ op: 'update_species', id: t.sp.id, patch: { range } }, '正在计算生态…', undefined, undefined, `「${t.sp.name || t.sp.id}」只长在${what}`);
    if (ok) leaveRangePick();
  };
  return {
    // 点岛时是单击类工具（按住拖动是平移地图），圈一片时按住画圈
    get drags() {
      return rangePick.value?.kind === 'cells';
    },
    down(p) {
      const t = target();
      if (!t || t.pick.kind !== 'cells' || p.cell < 0) return;
      if (isBusy()) return;
      ring = [[p.x, p.y]];
      pointer = p;
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!pressed || !ring || !w) return;
      const [lx, ly] = ring[ring.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) >= w.mesh.spacing * 0.5) ring.push([p.x, p.y]);
    },
    leave() {
      pointer = null;
    },
    cancel() {
      ring = null;
    },
    async click(p) {
      const t = target();
      if (!t || t.pick.kind !== 'island' || isBusy()) return;
      const m = massAt(t.w, p.cell);
      if (!m) {
        showToast('点一块陆地（岛或大陆）', true);
        return;
      }
      const f = landmassOf(t.w, p.cell);
      await commit({ kind: 'island', cell: p.cell }, f?.name ? `「${islandLabel(t.w, f)}」上` : '这块陆地上');
    },
    async up() {
      const t = target();
      const pts = ring;
      ring = null;
      if (!t || t.pick.kind !== 'cells' || !pts) return;
      if (aroundPole(t.w, pts)) {
        showToast('圈不能绕着极点画', true);
        return;
      }
      const cells = pts.length >= 3 ? ringCells(t.w, pts).filter((i) => t.w.causes.land[i] === 1) : [];
      if (!cells.length) {
        showToast('圈里没有陆地：按住拖一圈再松手', true);
        return;
      }
      await commit({ kind: 'cells', cells }, `圈的 ${cells.length} 格里`);
    },
    preview() {
      const t = target();
      if (!t || !pointer) return EMPTY;
      const name = t.sp?.name || t.pick.species;
      if (t.pick.kind === 'island') {
        const m = massAt(t.w, pointer.cell);
        if (!m) return { layers: [], shapes: [], hint: `点一块陆地：「${name}」只长在那上面` };
        const f = landmassOf(t.w, pointer.cell);
        return { layers: [m.layer], shapes: [], hint: `「${name}」只长在${f?.name ? `「${islandLabel(t.w, f)}」` : '这块陆地'}上（${m.cells.length} 格）` };
      }
      if (!ring) return { layers: [], shapes: [], hint: `按住圈一片：「${name}」只长在圈里` };
      const shapes: Shape[] = [{ kind: 'line', points: ring, color: 'rgba(255, 255, 255, 0.9)', width: 1.5 }];
      if (ring.length < 3) return { layers: [], shapes, hint: null };
      shapes.push({ kind: 'line', points: [ring[ring.length - 1], ring[0]], color: 'rgba(255, 255, 255, 0.6)', width: 1.5, dashed: true });
      const cells = ringCells(t.w, ring).filter((i) => t.w.causes.land[i] === 1);
      return { layers: cells.length ? [{ cells, color: WHITE, alpha: 0.35 }] : [], shapes, hint: `圈里 ${cells.length} 格陆地` };
    },
  };
}

// 自然的擦除：擦掉涂过的生态。选中时地图上一直用浅斜线标出涂过的格，悬停说这里涂成了什么；
export function eraseTool(): ToolHandler {
  return brushTool({
    hint: () => ({ text: null }),
    filter: (w, i) => natureMask(w).has[i] === 1,
    backdrop: (w) => oneLayer(erasableLayer(natureMask(w))),
    here: (w, cells) => natureHere(w, cells),
    layers(_w, s) {
      return { layers: [{ cells: s.cells, color: WHITE, alpha: 0.6 }], hint: s.t.size ? `擦掉 ${s.t.size} 格` : '这里没涂过' };
    },
    exact: (_w, s) => (s.t.size ? { op: 'erase_constraints', cells: s.cells } : null),
    exactHint: (_w, s, _shift, r) => `擦掉 ${s.t.size} 格 · ${biomeChange(r)}`,
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
  // 松手时执行的命令（确切预览算的也是它）
  const cmdOf = (s: Stroke, shift: boolean): Command => {
    const amount = sign(shift) * options.value.fieldAmount;
    return { op: 'paint', field: `field:${options.value.field}`, cells: s.cells, values: s.weights().map((wt) => wt * amount), mode: 'add' };
  };
  const head = (shift: boolean) => {
    const up = sign(shift) > 0;
    return `${options.value.field} ${up ? '变大' : '变小'}：中心 ${up ? '+' : '−'}${options.value.fieldAmount.toFixed(2)}`;
  };
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
      return { layers: [{ cells: s.cells, values, color: up ? [190, 120, 230] : [120, 120, 140], alpha: 0.65 }], hint: head(shift) };
    },
    exact: (w, s, shift) => (s.t.size && options.value.field && w.causes.fields[options.value.field] ? cmdOf(s, shift) : null),
    exactHint: (_w, _s, shift, r) => `${head(shift)} · ${biomeChange(r)}`,
    commit: (_w, s, shift) => exec(cmdOf(s, shift), '正在计算…'),
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
export function groupCount(w: World, cells: number[]): number {
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

// 点一下：用底部滑块的大小放湖；按住往外拖：拖多远湖就多大。前面的编辑还在算时也能放（排队）。
// 点在湖上是选中它（底部条换成这个湖的设置）；选着一个湖时点别处只是取消选择
const LAKE_PICK: [number, number, number] = [255, 236, 150];
export function lakeTool(): ToolHandler {
  let pointer: Pointer | null = null;
  let drag: { x: number; y: number; cell: number; sx: number; sy: number; km: number | null } | null = null;
  // 按下时点在湖上：松手时没拖开就选中它；按住拖开了就照常拖出一个新湖（可以放在已有的湖上）
  let pick: { cell: number; x: number; y: number; sx: number; sy: number } | null = null;
  // 鼠标下的湖（悬停时描出来）：按格缓存
  let hover: { key: string; cells: number[] } | null = null;
  const hoverLake = (w: World, cell: number) => {
    const key = `${worldId(w)}|${cell}`;
    if (hover?.key !== key) hover = { key, cells: lakeCellsAt(w, cell) };
    return hover.cells;
  };
  let settled: Settled = null;
  let cache: { key: string; cells: number[]; ghost: GhostEdit } | null = null;
  const centerOf = () => drag ?? (pointer && pointer.cell >= 0 ? pointer : null);
  const radiusNow = () => drag?.km ?? options.value.lakeKm;
  const lakeNow = (w: World) => {
    const c = centerOf();
    if (!c) return null;
    const key = `${worldId(w)}|${c.cell}|${radiusNow()}`;
    // 新湖都带 exact：半径就按给的算（最小只淹一格）
    if (cache?.key !== key) {
      const cells = lakeArea(w, c.cell, radiusNow());
      cache = { key, cells, ghost: { cells: [], delta: [], lake: cells } };
    }
    return cache;
  };
  const cellsNow = (w: World) => lakeNow(w)?.cells ?? [];
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
      // 点在湖上：选中它（按住拖开是放湖，见 move）；选着一个湖时点别处：取消选择
      if (w.causes.land[p.cell] && w.derived.lake[p.cell]) {
        pointer = p;
        pick = { cell: p.cell, x: p.x, y: p.y, sx: p.sx, sy: p.sy };
        return;
      }
      if (selectedLake.value) {
        selectedLake.value = null;
        return;
      }
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
      if (pressed && pick && w && Math.hypot(p.sx - pick.sx, p.sy - pick.sy) > 6) {
        const at = pick;
        pick = null;
        if (blockedByOther()) return busyNote();
        selectedLake.value = null;
        drag = { x: at.x, y: at.y, cell: at.cell, sx: at.sx, sy: at.sy, km: null };
      }
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
      if (pick) {
        const at = pick;
        pick = null;
        if (w && Math.hypot(p.sx - at.sx, p.sy - at.sy) <= 6) selectedLake.value = lakeRefAt(w, at.cell);
        return;
      }
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
        // 松手时的湖面留在图上，直到结果换上（鼠标离开地图也留着）。排在前面的编辑先换上了：按新的世界重算湖面
        const shown: Preview = { layers: [], shapes: [], hint: null, ghost: { cells: [], delta: [], lake: cells } };
        const ghostAt = (now: World): GhostEdit => ({ cells: [], delta: [], lake: lakeArea(now, d.cell, radius) });
        await trackEdit(shown, exec({ op: 'add_lake', lake: { cell: d.cell, radius, depth: 120, perennial: true, ...chosenLakeType(w) } }, '正在计算湖泊…'), ghostFollows(shown, w, ghostAt));
      } finally {
        if (settled === mark) settled = null;
      }
    },
    cancel() {
      drag = null;
      pick = null;
    },
    preview() {
      const w = world.value;
      if (!w) return EMPTY;
      // 选着一个湖：描出它；拖底部条的“大小”时画出将来的湖面
      const sel = selectedLake.value;
      if (sel) {
        const info = lakeInfo(w, sel);
        const sz = lakeSizeDraft.value;
        const spec = sz && info?.placed?.id === sz.id ? info.placed : undefined;
        const future = spec && sz ? lakeArea(w, spec.cell, sz.radius) : null;
        const over = pointer && pointer.cell >= 0 && w.derived.lake[pointer.cell] && !info?.cells.includes(pointer.cell) ? hoverLake(w, pointer.cell) : [];
        return {
          layers: [
            ...(info ? [{ cells: future ?? info.cells, color: LAKE_PICK, pattern: 'outline' as const }] : []),
            ...(over.length ? [{ cells: over, color: [255, 255, 255] as [number, number, number], pattern: 'outline' as const }] : []),
          ],
          shapes: [],
          hint: over.length ? '点一下选中这个湖' : null,
          ghost: future ? { cells: [], delta: [], lake: future } : null,
        };
      }
      if (!pointer) return EMPTY;
      if (settled) return { ...EMPTY, hint: '正在计算…' };
      // 鼠标在湖上：描出这个湖，点一下选中它
      if (!drag && pointer.cell >= 0 && w.causes.land[pointer.cell] && w.derived.lake[pointer.cell]) {
        return { layers: [{ cells: hoverLake(w, pointer.cell), color: [255, 255, 255], pattern: 'outline' }], shapes: [], hint: '点一下选中这个湖 · 按住拖开放一个新湖' };
      }
      const c = centerOf();
      if (!c || !w.causes.land[c.cell]) return EMPTY;
      const lake = lakeNow(w);
      const cells = lake?.cells ?? [];
      const coastal = coastalOf(w, cells);
      // 留得住水：地图上直接画出湖面（湖岸照湖的画法）；贴着海：橙色，松手会被拦下
      return {
        layers: coastal ? [{ cells, color: [230, 120, 70], alpha: 0.8 }] : [],
        shapes: drag?.km ? [{ kind: 'line', points: [[drag.x, drag.y], [pointer.x, pointer.y]], color: 'rgba(255,255,255,0.85)', width: 1.5, dashed: true }] : [],
        hint: coastal ? '离海太近，留不住水' : (queueHint() ?? `湖 · ${km(radiusNow() * 2)} km`),
        warn: coastal,
        ghost: coastal || !lake ? null : lake.ghost,
      };
    },
  };
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
function shownAt(w: World, p: Pointer): DisplayCell | null {
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
