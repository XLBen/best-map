import { batch, effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { displayCellAt } from '../../core/display';
import { FEATURE_INFO, type FeatureType, type GeoFeature } from '../../core/features';
import { findCell } from '../../core/mesh';
import { COAST_AMP } from '../../core/terrain';
import type { ProvinceMeta, World } from '../../core/world';
import { type ColorOptions, type GhostEdit, GhostBuffer, type HighlightLayer, cellLayers, colorSignature, editGhost, fxLayers, groupPreview, highlightColors, lakeTintLayer, lakeTypesSignature, provinceScale, terrainGhost } from '../render/colors';
import { exportFrame, type LabelSize, planTiles, tileMargin, tileSize, tileView } from '../render/export-plan';
import { type Frame, type LabelBox, type OverlayPaths, type OverlayState, type ProvinceLabel, buildPaths, drawOverlay, riverPathsKey, samePathsKey } from '../render/overlay';
import { type CellLayers, Renderer, SETTLE_MS } from '../render/renderer';
import {
  FLASH_MS,
  adjustPreview,
  adjustPreviewWorld,
  cornerLift,
  cursorHint,
  exportProgress,
  flash,
  imageExportCancel,
  focusSpecies,
  hoverCell,
  hoverProvinceCell,
  hoverRiver,
  labelGroups,
  mapStyle,
  measure,
  mode,
  openPanel,
  options,
  overlays,
  prefs,
  redrawTick,
  reference,
  riverStyleOverride,
  season,
  selectedFeature,
  selectedProvince,
  selectedLake,
  selectedRiver,
  sheet,
  showToast,
  sliderActive,
  tool,
  visualOverrides,
  world,
  worldEpoch,
} from '../state';
import { MAP_INSETS, clampPlanetCamera, mapApi, maxZoom, minZoom } from './camera';
import { TOOL_DEFS, category } from './defs/tools';
import { pendingEdits, pendingPreview } from './pending';
import { barPreview } from './provincePreview';
import { lakeSizeDraft } from './lakeInfo';
import { riverGlow, riverInfo } from './riverCourse';
import { editLayers } from './edits';
import { type Pointer, type Preview, type ProvincePreview, type ToolHandler, endemicPicked, measureTool, provinceCellAt, reliefLayers } from './tools';

// 地图视图：WebGL 底图 + 2D 矢量叠加；指针事件交给当前工具，工具给出预览

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

// 省名标签：每个省放在它的格的中心。province、metas 可以是预览里将来的（重划、重新划分时先看新的省名）
function provinceLabelsOf(w: World, province: Int32Array, metas: Record<number, ProvinceMeta>): ProvinceLabel[] {
  if (w.mesh.kind === 'sphere') {
    // 整个星球：经度取圆周平均，跨过经度 180° 的省份名字也落在省份上
    const sums = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < w.mesh.n; i++) {
      const p = province[i];
      if (p < 0) continue;
      const s = sums.get(p) ?? [0, 0, 0, 0];
      s[0] += Math.sin(Math.PI * w.mesh.x[i]);
      s[1] += Math.cos(Math.PI * w.mesh.x[i]);
      s[2] += w.mesh.y[i];
      s[3]++;
      sums.set(p, s);
    }
    return [...sums]
      .filter(([p]) => metas[p])
      .map(([p, [sn, cs, y, c]]) => {
        const x = Math.atan2(sn, cs) / Math.PI;
        return { x: x < 0 ? x + 2 : x, y: y / c, text: metas[p].name || String(p), kind: metas[p].kind };
      });
  }
  const sums = new Map<number, [number, number, number]>();
  for (let i = 0; i < w.mesh.n; i++) {
    const p = province[i];
    if (p < 0) continue;
    const s = sums.get(p) ?? [0, 0, 0];
    s[0] += w.mesh.x[i];
    s[1] += w.mesh.y[i];
    s[2]++;
    sums.set(p, s);
  }
  return [...sums].filter(([p]) => metas[p]).map(([p, [x, y, c]]) => ({ x: x / c, y: y / c, text: metas[p].name || String(p), kind: metas[p].kind }));
}

// 几个省份预览叠在一起（排队中的、按钮悬停的、当前工具的，后面的盖住前面的）。整份的（重划、重新划分）作底，
// 它前面的就不要了。同样的几个预览给同一个对象（地图不必重新上传）
let merged: { from: (ProvincePreview | null | undefined)[]; out: ProvincePreview | null } = { from: [], out: null };
function mergeProvinces(from: (ProvincePreview | null | undefined)[]): ProvincePreview | null {
  if (from.length === merged.from.length && from.every((x, k) => x === merged.from[k])) return merged.out;
  const list = from.filter((x): x is ProvincePreview => !!x);
  let out: ProvincePreview | null = list[0] ?? null;
  if (list.length > 1) {
    const top = list.map((x) => !!x.province).lastIndexOf(true);
    const base = top >= 0 ? list[top] : null;
    const rest = list.slice(top + 1);
    // 将来全部的切线：最后给出的那一份（对半分开时切线接着管分出来的一半）
    const seamList = [base, ...rest].reverse().find((x) => x && x.seamList !== undefined)?.seamList;
    out = {
      cells: [...(base?.cells ?? []), ...rest.flatMap((x) => x.cells)],
      ids: [...(base?.ids ?? []), ...rest.flatMap((x) => x.ids)],
      seams: [...(base?.seams ?? []), ...rest.flatMap((x) => x.seams ?? [])],
      ...(base ? { province: base.province, metas: base.metas } : {}),
      ...(seamList !== undefined ? { seamList } : {}),
    };
  }
  merged = { from, out };
  return out;
}

// 几步的幽灵海岸合在一起（排队中的、当前工具的；同一格的增量相加）。同样的几份给同一个对象（地图不必重算）
let ghosts: { from: (GhostEdit | null | undefined)[]; out: GhostEdit | null } = { from: [], out: null };
function mergeGhosts(from: (GhostEdit | null | undefined)[]): GhostEdit | null {
  if (from.length === ghosts.from.length && from.every((x, k) => x === ghosts.from[k])) return ghosts.out;
  const list = from.filter((x): x is GhostEdit => !!x);
  const out = list.length <= 1 ? (list[0] ?? null) : { cells: list.flatMap((g) => g.cells), delta: list.flatMap((g) => g.delta), lake: list.flatMap((g) => g.lake ?? []) };
  ghosts = { from, out };
  return out;
}

type OverlayArgs = Parameters<typeof drawOverlay> extends [unknown, ...infer R] ? R : never;

const NO_PREVIEW: Preview = { layers: [], shapes: [], hint: null };

export function MapView() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const refImg = useRef<HTMLImageElement>(null);
  const refTile = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const glCanvas = glRef.current!;
    const ovCanvas = ovRef.current!;
    let renderer: Renderer;
    try {
      renderer = new Renderer(glCanvas);
    } catch (e) {
      showToast((e as Error).message, true);
      return;
    }
    const ctx = ovCanvas.getContext('2d')!;
    let paths: OverlayPaths | null = null;
    // 河流路径按 riverPathsKey 缓存（流量数组、河道的内容、拖粗细时的临时样子）：只改了名字、省份时
    // （轻快照沿用同一批推导数组）不必重新描河，改了一条画的河的粗细时会重描
    let pathsKey: unknown[] = [];
    let provinceLabels: ProvinceLabel[] = [];
    // 预览里将来的省名（重划、重新划分）：按预览对象缓存
    let previewLabels: { of: ProvincePreview | null; labels: ProvinceLabel[] } = { of: null, labels: [] };
    const labelsFor = (w: World, pv: ProvincePreview | null | undefined): ProvinceLabel[] => {
      if (!pv?.province || !pv.metas) return provinceLabels;
      if (previewLabels.of !== pv) {
        const province = pv.province.slice();
        pv.cells.forEach((c, k) => (province[c] = pv.ids[k]));
        previewLabels = { of: pv, labels: provinceLabelsOf(w, province, pv.metas) };
      }
      return previewLabels.labels;
    };
    let labelBoxes: LabelBox[] = [];
    // 上一帧叠加层的参数（开发用的测速重画它）
    let lastOverlay: OverlayArgs | null = null;
    let fittedMesh: unknown = null;
    let fittedEpoch = -1;
    let frame = 0;
    // 改完后的闪烁每 1/40 不透明度才变一次：到那时再画，不必每一帧都画一遍
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    // 镜头停下以后补画全分辨率的那一帧
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // 省界淡出用的省份大小：按省份数组缓存（只改了名字时不必重数）
    let provinceScaleFor: Int32Array | null = null;
    let pointer: Pointer | null = null;
    // 鼠标最后停在地图上的位置：拖左侧滑块时在这里显示预览
    let lastPointer: Pointer | null = null;
    let hoverLabel: string | null = null;
    let lastHighlightKey: unknown[] = [];
    // 用户还没手动平移缩放时，画布尺寸变了就重新适配整张图
    let userMoved = false;
    let pressed = false;
    // 正在导出整张地图（见 exportImage）
    let exportBusy = false;

    const hitLabel = (sx: number, sy: number) => labelBoxes.find((b) => sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1)?.key ?? null;
    const env = { zoom: () => renderer.camera.zoom, hitLabel };
    let handler: ToolHandler = TOOL_DEFS[tool.value].create(env);
    // 量距离时地图上的点击交给它，不交给当前工具
    const measurer = measureTool(env.zoom);
    const active = () => (measure.value ? measurer : handler);

    const requestDraw = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => draw());
    };

    const fit = () => {
      const w = world.value;
      if (!w) return;
      // 整个星球：看全图时留在当前的经度
      const keepX = w.mesh.kind === 'sphere' ? renderer.camera.x : null;
      renderer.fit(w.mesh, MAP_INSETS);
      if (keepX !== null) {
        renderer.camera.x = keepX;
        clampPlanetCamera(w.mesh, renderer.camera, glCanvas.clientHeight, true);
      }
      userMoved = false;
      refreshPointer();
      requestDraw();
    };

    // 无人区省份的斜线图层：按省份数组与各省的类型缓存（同一个图层对象，不必重新上传）
    let waste: { key: string; province: Int32Array; layer: HighlightLayer | null } | null = null;
    function wasteLayer(w: World): HighlightLayer | null {
      const ids = Object.entries(w.small.provinces)
        .filter(([, m]) => m.kind === 'wasteland')
        .map(([p]) => p)
        .join(',');
      if (waste?.province === w.causes.province && waste.key === ids) return waste.layer;
      const set = new Set(ids ? ids.split(',').map(Number) : []);
      const cells: number[] = [];
      if (set.size) for (let i = 0; i < w.mesh.n; i++) if (set.has(w.causes.province[i])) cells.push(i);
      waste = { key: ids, province: w.causes.province, layer: cells.length ? { cells, color: [90, 90, 90], alpha: 0.45, pattern: 'hatch' } : null };
      return waste.layer;
    }

    // shown：画出来的世界（确切预览、调整面板预览的将来的世界，或当前世界）：没涂成的格按它画
    // back：工具选中时一直画着的图层（橡皮擦能擦的格、岛上特有的岛），画在预览下面
    function highlightLayers(w: World, shown: World, preview: Preview, back: HighlightLayer[]): { layers: HighlightLayer[]; key: unknown[] } {
      const layers: HighlightLayer[] = [];
      const c = category.value;
      // 图层里的“我改过的地方”：四种改动分色（任何工具下都能打开）。压在工具的描边（岛上特有描的岛）之上、
      // 别的高亮之下：只描边的格一盖就没了颜色，而描边本来就画在有高亮与没有高亮的格之间，盖上以后照样在
      const edits = overlays.value.edits ? editLayers(w) : [];
      layers.push(...back.filter((l) => l.pattern === 'outline'), ...edits);
      // 工具一直画着的其余图层（橡皮擦能擦的格的白斜线）：放在没涂成的红斜线、选中、闪烁之下，免得把它们盖掉
      layers.push(...back.filter((l) => l.pattern !== 'outline'));
      // 按每个图层对象比较：工具沿用同一个图层时不必重新上传
      const key: unknown[] = [w, shown, c, ...edits, '|', ...back, '|', ...preview.layers];
      if (c === 'nature') {
        // 没涂成的格：红色斜线
        const failing = shown.derived.conflicts.flatMap((x) => x.failing);
        if (failing.length) layers.push({ cells: failing, color: [235, 60, 50], alpha: 0.85, pattern: 'hatch' });
      }
      if (c === 'provinces' && selectedProvince.value !== null) {
        const id = selectedProvince.value;
        const cells: number[] = [];
        for (let i = 0; i < w.mesh.n; i++) if (w.causes.province[i] === id) cells.push(i);
        layers.push({ cells, color: [255, 255, 255], alpha: 0.28 });
        key.push(id);
      }
      // 无人区：灰色斜线，压在选中高亮之上（选中的省改成无人区时当场看得见）
      if (c === 'provinces') {
        const waste = wasteLayer(w);
        if (waste) layers.push(waste);
        key.push(waste);
      }
      if (c === 'names' && selectedFeature.value) {
        const f = w.derived.features.find((x) => x.key === selectedFeature.value);
        if (f) layers.push({ cells: Array.from(f.cells), color: [255, 230, 120], alpha: 0.35 });
        key.push(selectedFeature.value);
      }
      // “调整”面板拖滑块：将来的海岸线由幽灵海岸画出（见 applyGhost），这里只涂山会变高（橙）/ 变矮（蓝灰）的格
      const ap = adjustPreview.value;
      if (ap) {
        if (ap.relief.cells.length) layers.push(...reliefLayers(ap.relief));
        key.push(ap);
      }
      // 调整面板、资源包的预览世界带的高亮（资源包：会变的格描边、新生态的格淡淡涂上）
      const apw = adjustPreviewWorld.value;
      if (apw?.layers && apw.base === w) {
        layers.push(...apw.layers);
        key.push(apw);
      }
      // 改完后变化的格：淡淡地亮一下就淡出，轮廓跟着一起淡（着色器里轮廓的浓淡随填充）
      const fl = flash.value;
      if (fl) {
        const t = (performance.now() - fl.at) / FLASH_MS;
        const a = Math.max(0, 0.18 * (1 - t));
        // 每帧只在不透明度变化明显时更新
        const step = Math.round(a * 40);
        if (step > 0) layers.push({ cells: fl.cells, color: [255, 236, 120], alpha: step / 40 });
        key.push(fl, step);
      }
      layers.push(...preview.layers);
      return { layers, key };
    }

    // 省份预览（剪刀、涂省、合并）：将来的省界直接画在地图上。同一个预览对象不重新上传；换了底图着色后重新给
    let groupKey: unknown[] = [];
    function applyGroupPreview(w: World, pv: ProvincePreview | null) {
      const key = [w, pv, mode.value];
      if (key.length === groupKey.length && key.every((k, i) => k === groupKey[i])) return;
      groupKey = key;
      renderer.setGroupPreview(pv ? groupPreview(w, pv, mode.value) : null);
    }

    // 幽灵海岸：工具（连同排队中的笔画）给的 landness 增量、“调整”滑块与重画这一片给的整份海岸值 → 将来真实的海岸线。
    // 输入变了才重算（每帧最多一次）；持久的缓冲只改到补丁格，只上传改到的行。世界换了就按新世界重算
    let baseLayers: CellLayers | null = null;
    let ghostBuf: GhostBuffer | null = null;
    let ghostKey: unknown[] = [];
    // 省份预览（setGroupPreview）显示着时分组、平涂听它的；它去掉时换回的是底子，幽灵改过的那几格的分组、平涂也没了：
    // 所以键里带上有没有省份预览，去掉时把幽灵重新给一次（比如排队的陆地笔画还在时，鼠标从“对半分开”上移开）
    function applyGhost(w: World, pv: Preview | null) {
      const terrain = pv ? (pv.terrain ?? adjustPreview.value) : null;
      const edit = terrain ? null : (pv?.ghost ?? null);
      const key = [w, baseLayers, terrain, edit, !!pv?.provinces];
      if (key.length === ghostKey.length && key.every((k, i) => k === ghostKey[i])) return;
      ghostKey = key;
      if (!baseLayers || (!terrain && !edit && !ghostBuf)) return;
      ghostBuf ??= new GhostBuffer(baseLayers, mode.value);
      const patch = terrain ? terrainGhost(w, baseLayers, terrain) : edit ? editGhost(w, baseLayers, edit) : null;
      renderer.setGhost(ghostBuf.apply(w, patch, terrain && terrain.rough !== w.small.terrain.coastRoughness ? COAST_AMP * terrain.rough : undefined));
    }

    // 参考图：盖在整张地图的范围上（保持比例时放在中间），跟着镜头走
    let refUrl = '';
    function placeReference(w: World) {
      const img = refImg.current;
      const tile = refTile.current;
      const r = reference.value;
      if (!img || !tile) return;
      if (!r || !r.visible) {
        img.style.display = 'none';
        tile.style.display = 'none';
        return;
      }
      if (w.mesh.kind === 'sphere') {
        // 整个星球：草图按 2:1 铺满一整圈，左右重复，跟着平铺的副本走
        img.style.display = 'none';
        const cam = renderer.camera;
        const W = 2 * cam.zoom;
        const H = cam.zoom;
        const x = (0 - cam.x) * cam.zoom + glCanvas.clientWidth / 2;
        const y = (0 - cam.y) * cam.zoom + glCanvas.clientHeight / 2;
        tile.style.cssText = `display:block;left:0;top:${y}px;width:100%;height:${H}px;opacity:${r.opacity};background-image:url("${r.url}");background-size:${W}px ${H}px;background-repeat:repeat-x;background-position:${x}px 0`;
        return;
      }
      tile.style.display = 'none';
      if (refUrl !== r.url) {
        refUrl = r.url;
        img.onload = requestDraw;
        img.src = r.url;
      }
      const cam = renderer.camera;
      let x = (0 - cam.x) * cam.zoom + glCanvas.clientWidth / 2;
      let y = (0 - cam.y) * cam.zoom + glCanvas.clientHeight / 2;
      let W = w.mesh.width * cam.zoom;
      let H = w.mesh.height * cam.zoom;
      if (r.fit === 'contain' && img.naturalWidth && img.naturalHeight) {
        const ar = img.naturalWidth / img.naturalHeight;
        if (ar > W / H) {
          y += (H - W / ar) / 2;
          H = W / ar;
        } else {
          x += (W - H * ar) / 2;
          W = H * ar;
        }
      }
      img.style.cssText = `display:block;left:${x}px;top:${y}px;width:${W}px;height:${H}px;opacity:${r.opacity}`;
    }

    // 底部条要把左下角的比例尺抬多高：量一次缓存着，底部条或窗口变了大小时作废（不在每帧查 DOM、量位置）。
    // 没有底部条时每半秒才再找一次
    let liftCache: number | null = null;
    let liftBar: Element | null = null;
    let liftAt = 0;
    const barObs = new ResizeObserver(() => {
      liftCache = null;
      requestDraw();
    });
    const onWinResize = () => (liftCache = null);
    window.addEventListener('resize', onWinResize);
    // 生态的表打开、关上时底部条挪了位置（.app.with-sheet）却不变大小：ResizeObserver 不报，这里作废
    const disposeSheet = effect(() => {
      void sheet.value;
      liftCache = null;
      requestDraw();
    });
    function barLift(): number {
      if (liftCache !== null && (liftBar ? liftBar.isConnected : performance.now() - liftAt < 500)) return liftCache;
      const bar = document.querySelector('.bottombar');
      if (bar !== liftBar) {
        if (liftBar) barObs.unobserve(liftBar);
        if (bar) barObs.observe(bar);
        liftBar = bar;
      }
      const r = bar?.getBoundingClientRect();
      liftCache = r && r.left < 300 ? Math.ceil(window.innerHeight - r.top) + 4 : 0;
      liftAt = performance.now();
      return liftCache;
    }

    // clean：导出图片用的干净画面——不带高亮、闪烁、工具的图形和预览、鼠标旁的话（画完由调用者再按原样重画一次）
    function draw(clean = false) {
      frame = 0;
      const w = world.value;
      if (!w || !paths) return;
      // 正在导出整张地图：渲染器的图层是导出用的干净的那一份，屏幕先不画（导出完了重画）
      if (exportBusy && !clean) return;
      placeReference(w);
      // 拖左侧滑块时：鼠标不在地图上，也在最后停的地方（没有就在画面中间）显示预览
      if (sliderActive.value && !pointer && !pressed && !lastPointer) {
        const sx = glCanvas.clientWidth / 2;
        const sy = glCanvas.clientHeight / 2;
        const [x, y] = renderer.screenToWorld(sx, sy);
        lastPointer = { x, y, sx, sy, cell: findCell(w.mesh, x, y), shift: false, alt: false };
        handler.move?.(lastPointer, false);
      }
      // 量出来的线鼠标离开地图后也留着（看底部条上的数字时还在）；点了以后还在算、不排队的那一步（重画这一片）也留着
      const showPreview = !clean && (!!pointer || pressed || sliderActive.value || !!measure.value || !!active().keep?.());
      const own: Preview = showPreview ? active().preview() : NO_PREVIEW;
      // 工具选中时一直画着的东西（鼠标不在地图上也画）
      const back = clean ? null : (active().backdrop?.() ?? null);
      // 排队中的编辑（松手时的预览，直到结果换上，鼠标离开地图也留着）与底部条、“⋯”里按钮悬停的省份预览
      // （对半分开、重新划分）画在当前工具的预览下面。幽灵海岸几步合在一起；将来的世界用当前工具的确切预览，
      // 没有时用排队中最后一个有确切预览的（都是按当前世界算的，见 pending.ts）
      const queued = clean ? [] : pendingEdits.value.map((e) => pendingPreview(e, w));
      const button = !clean && barPreview.value?.base === w ? barPreview.value : null;
      const preview: Preview =
        queued.length || button
          ? {
              ...own,
              layers: [...queued.flatMap((q) => q.layers), ...(button?.layers ?? []), ...own.layers],
              shapes: [...queued.flatMap((q) => q.shapes), ...own.shapes],
              provinces: mergeProvinces([...queued.map((q) => q.provinces), button?.provinces, own.provinces]),
              ghost: mergeGhosts([...queued.map((q) => q.ghost), own.ghost]),
              world: own.world ?? [...queued].reverse().find((q) => q.world)?.world ?? null,
            }
          : own;
      // 画出来的世界：工具的确切预览、排队中的画笔的确切预览、调整面板预览的将来的世界，或当前世界（导出图片只画当前世界）。
      // 生态颜色、雪、河、地名、风、没涂成的格按它画；工具、悬停卡片照旧看当前世界
      const ap = adjustPreviewWorld.value;
      const shown = clean ? w : (preview.world ?? (ap && ap.base === w ? ap.world : null) ?? w);
      applyColors(shown);
      applyFx(shown, clean);
      applyTint(shown);
      if (clean) {
        renderer.setHighlight(null);
        lastHighlightKey = [];
      } else {
        const { layers, key } = highlightLayers(w, shown, preview, back?.layers ?? []);
        if (key.length !== lastHighlightKey.length || key.some((k, i) => k !== lastHighlightKey[i])) {
          renderer.setHighlight(highlightColors(w, layers));
          lastHighlightKey = key;
        }
      }
      applyGroupPreview(w, preview.provinces ?? null);
      // 导出图片的干净画面不带幽灵海岸（画的是现在的世界）。幽灵海岸改的是画出来的那份底子（预览世界的陆地与当前世界相同）
      applyGhost(shown, clean ? null : preview);
      // 选中的河（画河时）、河流列表里鼠标停着的河：沿河一道淡黄的光，压在工具的图形下面
      // 正在改这条河（原来的样子先不画）时不亮
      const editing = !!riverStyleOverride.value?.hide || !!riverStyleOverride.value?.cells;
      const glow = clean ? [] : [...(tool.value === 'river' && selectedRiver.value && !editing ? riverGlow(w, selectedRiver.value) : []), ...(hoverRiver.value ? riverGlow(w, hoverRiver.value) : [])];
      // 剪刀切线附近：省份着色、省份工具的高亮也按切线换过的格取
      renderer.flatByGroup = mode.value === 'provinces';
      renderer.highlightByGroup = category.value === 'provinces';
      renderer.style = mapStyle.value;
      // 镜头正在动：渲染器按低分辨率画了这一帧，停下 SETTLE_MS 以后再画一次（补上全分辨率的）。导出图片一定按停稳的画法画
      const moving = renderer.render(w.kmPerUnit, { still: clean });
      if (moving) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          requestDraw();
        }, SETTLE_MS + 10);
      }
      const c = category.value;
      const groups = labelGroups.value;
      // 底部条伸到左下角（窗口窄、选项多）时，比例尺和尺子按钮抬到它上面（底部条、窗口变了大小时才重新量，不在每帧查 DOM）
      const lift = barLift();
      if (lift !== cornerLift.value) cornerLift.value = lift;
      const types = new Set((Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => groups.has(FEATURE_INFO[t].group)));
      const ovArgs: OverlayArgs = [shown, shown === w ? paths : pathsOf(shown), renderer.camera, {
        rivers: overlays.value.rivers,
        wind: overlays.value.wind,
        markers: c === 'water' && !clean,
        season: season.value,
        style: mapStyle.value,
        shapes: glow.length || back?.shapes.length ? [...(back?.shapes ?? []), ...glow, ...preview.shapes] : preview.shapes,
        provinceLabels: c === 'provinces' ? labelsFor(w, preview.provinces) : [],
        features: overlays.value.labels || c === 'names' ? labelsShown(w, shown.derived.features, clean) : null,
        labelTypes: types,
        kmPerUnit: w.kmPerUnit,
        hoverLabel: c === 'names' && !clean ? (hoverLabel ?? selectedFeature.value) : null,
        scaleBar: overlays.value.scale,
        cornerLift: lift,
        latitude: overlays.value.latitude
          ? { north: shown.settings.latNorth + shown.small.planet.latShift, south: shown.settings.latSouth + shown.small.planet.latShift }
          : null,
        currents: overlays.value.currents,
        motion: moving,
        exact: clean,
      }];
      lastOverlay = ovArgs;
      labelBoxes = drawOverlay(ctx, ...ovArgs);
      if (clean) return;
      // 鼠标旁的一句话（拖滑块时一般由滑块上的数说明，这里不显示；画笔在鼠标最后停的地方预览涂一下时，写在那里）
      const at = sliderActive.value ? (preview.sliderHint ? lastPointer : null) : pointer;
      const hint = at && preview.hint ? { x: at.sx, y: at.sy, text: preview.hint, warn: preview.warn, caution: preview.caution } : null;
      const cur = cursorHint.value;
      if (hint?.text !== cur?.text || hint?.x !== cur?.x || hint?.y !== cur?.y || hint?.warn !== cur?.warn || hint?.caution !== cur?.caution) cursorHint.value = hint;
      if (flash.value && !flashTimer) {
        flashTimer = setTimeout(() => {
          flashTimer = null;
          requestDraw();
        }, 100);
      }
    }

    // 世界变化：网格、矢量路径、省份标签
    const disposeWorld = effect(() => {
      const w = world.value;
      if (!w) return;
      renderer.setMesh(w.mesh);
      // 换了网格，或者新建 / 打开了一个世界：看全图
      if (fittedMesh !== w.mesh || fittedEpoch !== worldEpoch.value) {
        renderer.fit(w.mesh, MAP_INSETS);
        fittedMesh = w.mesh;
        fittedEpoch = worldEpoch.value;
        userMoved = false;
        lastPointer = null;
        // 鼠标还在地图上：按新的网格重新算它指着哪一格（旧的格号属于旧网格）
        refreshPointer();
      }
      if (provinceScaleFor !== w.causes.province) {
        renderer.provinceScale = provinceScale(w.causes.province);
        provinceScaleFor = w.causes.province;
      }
      provinceLabels = provinceLabelsOf(w, w.causes.province, w.small.provinces);
      // 鼠标没动、世界变了（编辑的结果到了）：屏幕上这一点画的格可能变了（陆海、切线），重新算
      for (const p of new Set([pointer, lastPointer])) if (p && p.cell >= 0) p.shown = displayCellAt(w, p.x, p.y, p.cell);
      if (pointer?.shown) setHover(pointer);
      requestDraw();
    });

    // 河流与河道标记的路径
    const disposePaths = effect(() => {
      const w = world.value;
      const override = riverStyleOverride.value;
      if (!w) return;
      const key = riverPathsKey(w, override);
      if (samePathsKey(key, pathsKey)) return;
      pathsKey = key;
      paths = buildPaths(w, override);
      requestDraw();
    });

    // 着色：视图模式、季节、关注的类型、边界，按画出来的世界（预览的将来的世界或当前世界，在 draw 里做）。
    // 着色用到的数组都没变（只改了名字的轻快照；预览世界里没变的数组沿用当前世界的同一个对象）就不重新着色、不重画地形。
    // 最近的两份着色留着：预览出现、消失时来回切换不必重算
    let colorKey: unknown[] = [];
    const colorCache: { key: unknown[]; layers: ReturnType<typeof cellLayers> }[] = [];
    const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((k, i) => k === b[i]);
    // 小数据里着色用到的部分（colors.ts 的 colorSignature，含生态的外观）：每帧都要比，按小数据对象缓存
    const smallKeys = new WeakMap<World['small'], string>();
    function smallKey(w: World): string {
      let k = smallKeys.get(w.small);
      if (k === undefined) {
        k = colorSignature(w.small);
        smallKeys.set(w.small, k);
      }
      return k;
    }
    // 这次着色的选项（拖花纹、发光滑块时按它重算花纹）与花纹覆盖的键（见 applyFx）
    let colorOpts: ColorOptions | null = null;
    let fxKey: unknown[] = [];
    function applyColors(w: World) {
      const o = { mode: mode.value, season: season.value, focusSpecies: focusSpecies.value, borders: overlays.value.borders && (category.value === 'provinces' || mode.value === 'provinces') };
      colorOpts = o;
      const arrays: unknown[] = [];
      for (const v of Object.values(w.derived)) if (ArrayBuffer.isView(v)) arrays.push(v);
      for (const v of Object.values(w.causes)) if (ArrayBuffer.isView(v)) arrays.push(v);
      arrays.push(...Object.values(w.derived.corrF), ...Object.values(w.causes.fields));
      const key = [w.mesh, ...arrays, smallKey(w), o.mode, o.season, o.focusSpecies, o.borders];
      if (sameKey(key, colorKey)) return;
      colorKey = key;
      let hit = colorCache.find((x) => sameKey(x.key, key));
      if (!hit) {
        hit = { key, layers: cellLayers(w, o) };
        colorCache.unshift(hit);
        colorCache.length = Math.min(colorCache.length, 2);
      }
      renderer.setMesh(w.mesh);
      baseLayers = hit.layers;
      renderer.setLayers(hit.layers);
      lastHighlightKey = [];
      groupKey = [];
      // 幽灵海岸跟着新的底子重来
      ghostBuf = null;
      ghostKey = [];
      // setLayers 换回了着色里的花纹：外观覆盖要重新给
      fxKey = [];
    }

    // 拖花纹、发光滑块时的外观覆盖（state.ts 的 setSpeciesVisualOverride）：主线程上按覆盖的外观重算每格的花纹（几毫秒），
    // 不等引擎。画出来的世界里没有被覆盖的生态时用着色里的那一份；导出图片的干净画面只画世界里存着的样子
    function applyFx(w: World, clean: boolean) {
      if (!baseLayers || !colorOpts) return;
      const ov = visualOverrides.value;
      const on = !clean && ov.size > 0 && w.small.species.some((sp) => ov.has(sp.id));
      const key = [baseLayers, on ? ov : null, on ? w : null];
      if (sameKey(key, fxKey)) return;
      fxKey = key;
      const f = on ? fxLayers(w, colorOpts, ov) : null;
      renderer.setFx(on ? (f?.fx ?? null) : (baseLayers.fx ?? null), on ? (f?.palette ?? null) : (baseLayers.fxPalette ?? null));
    }
    // 湖泊类型的颜色（第九轮）：按画出来的世界、地图风格、视图模式；没有带类型的湖时为 null
    let tintKey: unknown[] = [];
    function applyTint(w: World) {
      const key = [w.mesh, w.derived.lakeType, w.derived.lake, w.causes.land, lakeTypesSignature(w.small.lakeTypes), mapStyle.value, mode.value];
      if (sameKey(key, tintKey)) return;
      tintKey = key;
      renderer.setTint(lakeTintLayer(w, { mode: mode.value }, mapStyle.value));
    }
    // 着色的选项变了、调整面板的预览世界到了：重画
    const disposeColors = effect(() => {
      void mode.value;
      void focusSpecies.value;
      void adjustPreviewWorld.value;
      requestDraw();
    });

    // 画河时选中的河：它自己的地名先不标（不盖住它的控制点、“+”）。同样的输入给同一个数组
    let labelMemo: { from: GeoFeature[]; key: string; out: GeoFeature[] } | null = null;
    function labelsShown(w: World, list: GeoFeature[], clean: boolean): GeoFeature[] {
      const sel = selectedRiver.value;
      const key = !clean && tool.value === 'river' && sel ? (riverInfo(w, sel)?.feature?.key ?? '') : '';
      if (!key) return list;
      if (labelMemo?.from === list && labelMemo.key === key) return labelMemo.out;
      labelMemo = { from: list, key, out: list.filter((f) => f.key !== key) };
      return labelMemo.out;
    }

    // 预览世界的河（河流多少、整体干湿……地图画将来的河）：与当前世界的河用同一个键（riverPathsKey，拖粗细时的临时样子也在里面）。
    // 键与当前世界的相同（预览没改描河读的数组、河道，比如涂生态、改名）时直接用当前世界的路径；不同时按键另缓存一份
    let shownPaths: { key: unknown[]; paths: OverlayPaths } | null = null;
    const pathsOf = (s: World): OverlayPaths => {
      // 预览世界里是改好的河：改着的那条河照画（先不画它只对当前世界）
      const ov = riverStyleOverride.value;
      const override = ov && (ov.hide || ov.cells) ? null : ov;
      const key = riverPathsKey(s, override);
      if (paths && samePathsKey(key, pathsKey)) return paths;
      if (!shownPaths || !samePathsKey(shownPaths.key, key)) shownPaths = { key, paths: buildPaths(s, override) };
      return shownPaths.paths;
    };

    // 换工具：新的工具对象；其他会影响预览或叠加的状态变化时重画
    const disposeTool = effect(() => {
      const id = tool.value;
      handler.cancel?.();
      handler = TOOL_DEFS[id].create(env);
      if (lastPointer) handler.move?.(lastPointer, false);
      requestDraw();
    });
    const disposeRedraw = effect(() => {
      void options.value;
      void overlays.value;
      void season.value;
      void mapStyle.value;
      void category.value;
      void flash.value;
      void selectedProvince.value;
      void selectedFeature.value;
      void selectedRiver.value;
      void selectedLake.value;
      void lakeSizeDraft.value;
      void hoverRiver.value;
      void labelGroups.value;
      void adjustPreview.value;
      void sliderActive.value;
      void openPanel.value;
      void measure.value;
      void reference.value;
      void redrawTick.value;
      void visualOverrides.value;
      void pendingEdits.value;
      void barPreview.value;
      void endemicPicked.value;
      requestDraw();
    });

    const resizeObs = new ResizeObserver(() => {
      const w = world.value;
      if (w && !userMoved) {
        renderer.fit(w.mesh, MAP_INSETS);
        refreshPointer();
      }
      requestDraw();
    });
    resizeObs.observe(glCanvas);

    // ---- 指针 ----
    let panning: { x: number; y: number; cx: number; cy: number } | null = null;
    let clickStart: { sx: number; sy: number } | null = null;
    let spaceDown = false;

    // 屏幕上的一点（CSS 像素，相对画布）在地图上的哪里；shown：那里画的是哪一格（悬停卡片、吸取、选省按它）
    const pointerAt = (sx: number, sy: number, shift: boolean, alt: boolean): Pointer => {
      const [x, y] = renderer.screenToWorld(sx, sy);
      const w = world.value;
      // 整个星球东西相接：只看南北
      const inside = !!w && (w.mesh.kind === 'sphere' ? y >= 0 && y <= 1 : x >= 0 && y >= 0 && x <= w.mesh.width && y <= w.mesh.height);
      const cell = inside ? findCell(w!.mesh, x, y) : -1;
      return { x, y, sx, sy, cell, shift, alt, shown: cell >= 0 ? displayCellAt(w!, x, y, cell) : undefined };
    };
    // 悬停卡片“这里”说的那一格：屏幕上这一点画成的陆地或海
    const hereOf = (p: Pointer) => p.shown?.here ?? p.cell;
    // 鼠标下的格：“这里”说的那一格，省份那一行按画出来的省（切线旁按显示的那一边）。世界的 effect 里也调它，所以是函数声明
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
    // 重新算它指着地图的哪里，画笔圈、悬停的格跟着手。拖着平移时鼠标下始终是同一点，不必算。
    // 世界的 effect 一建立就会调到这里：那时 pointer 还是空的，直接返回（用不到后面才定义的 panning、pointerAt）
    function refreshPointer() {
      if (!pointer || panning) return;
      const p = pointerAt(pointer.sx, pointer.sy, pointer.shift, pointer.alt);
      pointer = p;
      lastPointer = p;
      setHover(p);
      active().move?.(p, pressed);
    }

    const startPan = (sx: number, sy: number) => {
      panning = { x: sx, y: sy, cx: renderer.camera.x, cy: renderer.camera.y };
      userMoved = true;
    };

    const zoomAt = (sx: number, sy: number, f: number) => {
      const [wx, wy] = renderer.screenToWorld(sx, sy);
      const c = renderer.camera;
      const w = world.value;
      c.zoom = Math.max(w ? minZoom(w.mesh, glCanvas.clientWidth, glCanvas.clientHeight) : 100, Math.min(w ? maxZoom(w.mesh) : 60000, c.zoom * f));
      userMoved = true;
      const [nx, ny] = renderer.screenToWorld(sx, sy);
      c.x += wx - nx;
      c.y += wy - ny;
      if (w) clampPlanetCamera(w.mesh, c, glCanvas.clientHeight, !pressed && !panning);
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
      pointer = p;
      lastPointer = p;
      if (e.button === 1 || e.button === 2 || spaceDown) {
        startPan(p.sx, p.sy);
        return;
      }
      if (e.button !== 0) return;
      // Alt+点：吸取（取这里的生态、这里的省份）
      const def = TOOL_DEFS[tool.value];
      if (e.altKey && def.pick && !measure.value) {
        // 吸取的是屏幕上这一点画的：省份按画出来的省（扭曲后的格、切线两边），生态按画成的陆地
        const cell = def.category === 'provinces' ? provinceCellAt(w, p) : hereOf(p);
        const got = cell >= 0 ? def.pick(w, cell) : null;
        showToast(got ? `吸取了“${got}”` : '这里没有可以吸取的', !got);
        requestDraw();
        return;
      }
      const h = active();
      if (h.drags) {
        pressed = true;
        h.down?.(p);
      } else clickStart = { sx: p.sx, sy: p.sy };
      requestDraw();
    };

    const onMove = (e: PointerEvent) => {
      const w = world.value;
      if (!w) return;
      const p = pointerOf(e);
      pointer = p;
      lastPointer = p;
      if (panning) {
        renderer.camera.x = panning.cx - (p.sx - panning.x) / renderer.camera.zoom;
        renderer.camera.y = panning.cy - (p.sy - panning.y) / renderer.camera.zoom;
        clampPlanetCamera(w.mesh, renderer.camera, glCanvas.clientHeight, false);
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
      if (category.value === 'names') hoverLabel = hitLabel(p.sx, p.sy);
      active().move?.(p, pressed);
      requestDraw();
    };

    const onUp = async (e: PointerEvent) => {
      if (!world.value) return;
      const p = pointerOf(e);
      if (panning) {
        panning = null;
        // 平移结束：整个星球的镜头绕回第一份（画面不变，但鼠标下的经度差了一整圈，画笔圈要跟着换到这一份上）
        clampPlanetCamera(world.value.mesh, renderer.camera, glCanvas.clientHeight, true);
        refreshPointer();
        requestDraw();
        return;
      }
      if (pressed) {
        pressed = false;
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
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? glCanvas.clientHeight : 1;
        renderer.camera.x += (e.deltaX * unit) / renderer.camera.zoom;
        renderer.camera.y += (e.deltaY * unit) / renderer.camera.zoom;
        const w = world.value;
        if (w) clampPlanetCamera(w.mesh, renderer.camera, glCanvas.clientHeight, !pressed);
        userMoved = true;
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
      gesture = { zoom: renderer.camera.zoom, sx: g.clientX - r.left, sy: g.clientY - r.top };
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (!gesture) return;
      const target = gesture.zoom * (e as GestureEvent).scale;
      zoomAt(gesture.sx, gesture.sy, target / renderer.camera.zoom);
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
      pointer = null;
      active().leave?.();
      hoverLabel = null;
      cursorHint.value = null;
      requestDraw();
    };

    mapApi.current = {
      fit,
      zoomBy: (f) => zoomAt(glCanvas.clientWidth / 2, glCanvas.clientHeight / 2, f),
      cancel: () => {
        if (!pressed && !panning) return false;
        active().cancel?.();
        pressed = false;
        panning = null;
        requestDraw();
        return true;
      },
      escape: () => {
        const used = !!active().escape?.();
        if (used) requestDraw();
        return used;
      },
      enter: () => {
        const used = !!active().enter?.();
        if (used) requestDraw();
        return used;
      },
    };

    ovCanvas.addEventListener('pointerdown', onDown);
    ovCanvas.addEventListener('pointermove', onMove);
    ovCanvas.addEventListener('pointerup', onUp);
    ovCanvas.addEventListener('wheel', onWheel, { passive: false });
    ovCanvas.addEventListener('gesturestart', onGestureStart);
    ovCanvas.addEventListener('gesturechange', onGestureChange);
    ovCanvas.addEventListener('gestureend', onGestureEnd);
    ovCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
    ovCanvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    // 给调试、截图与“导出图片”用。clean（默认）：只有地图本身，不带高亮、闪烁、工具的图形和预览；
    // 调试时 snapshot(false) 截下屏幕上看到的样子（带预览）
    (window as unknown as { __map2?: unknown }).__map2 = {
      renderer,
      requestDraw,
      world: () => world.value,
      snapshot: (clean = true) => {
        draw(clean);
        const out = document.createElement('canvas');
        out.width = glCanvas.width;
        out.height = glCanvas.height;
        const o = out.getContext('2d')!;
        o.drawImage(glCanvas, 0, 0);
        o.drawImage(ovCanvas, 0, 0, out.width, out.height);
        // 截完按原样重画（高亮在下一帧重新上传）
        if (clean) requestDraw();
        return out;
      },
      exportImage,
    };
    // 导出整张地图（.png）：虚拟镜头盖住整张图（整个星球是一整圈 2:1，不重复），按停稳的画法离屏一块块画（每块四周多画一圈，
    // 拼起来没有接缝），再在整张图上画河、地名（按整张图排）、边界之外的叠加层；与“当前画面”一样是干净的画面。
    // 画的期间屏幕上的地图不重画；每画完一块让一下主线程（进度条照常动）。cancelled() 为真时停下，返回 null
    async function exportImage(o: { width: number; labels: LabelSize; tile?: number; overlay?: boolean }, progress: (p: number) => void, cancelled: () => boolean): Promise<HTMLCanvasElement | null> {
      const w = world.value;
      if (!w || !paths || exportBusy) return null;
      const mesh = w.mesh;
      const fr = exportFrame(mesh, o.width, o.labels);
      const out = document.createElement('canvas');
      out.width = fr.width;
      out.height = fr.height;
      const octx = out.getContext('2d');
      if (!octx) throw new Error('浏览器开不了这么大的画布');
      const cellPx = mesh.spacing * fr.cam.zoom * fr.dpr;
      const m = tileMargin(cellPx);
      const T = tileSize(renderer.exportLimit(), m, o.tile);
      if (T < 64) throw new Error('显卡支持的画布太小，导不出这么大的图');
      const tiles = planTiles(fr.width, fr.height, T);
      exportBusy = true;
      try {
        for (let i = 0; i < tiles.length; i++) {
          if (cancelled()) return null;
          // 每一块前都按当前世界换成干净的图层（中间世界变了也一致：都按开始时的这一份）
          cleanState(w);
          const t = tiles[i];
          const px = renderer.renderTile(w.kmPerUnit, tileView(fr, t.x, t.y, T, m), T, fr.cam.zoom, fr.dpr);
          const img = new ImageData(t.w, t.h);
          if (t.w === T) img.data.set(px.subarray(0, T * t.h * 4));
          else for (let r = 0; r < t.h; r++) img.data.set(px.subarray(r * T * 4, (r * T + t.w) * 4), r * t.w * 4);
          octx.putImageData(img, t.x, t.y);
          progress(((i + 1) / tiles.length) * 0.85);
          await new Promise((r) => setTimeout(r, 0));
        }
        if (cancelled()) return null;
        if (o.overlay !== false) drawOverlay(octx as CanvasRenderingContext2D, w, paths, fr.cam, cleanOverlay(w, { cw: fr.cw, ch: fr.ch, dpr: fr.dpr }));
        progress(0.9);
        return out;
      } finally {
        renderer.releaseExport();
        exportBusy = false;
        lastHighlightKey = [];
        requestDraw();
      }
    }

    // 干净的画面（导出图片）用的渲染器状态：当前世界的着色、存着的花纹，不带高亮、省份预览、幽灵海岸
    function cleanState(w: World) {
      applyColors(w);
      applyFx(w, true);
      applyTint(w);
      renderer.setHighlight(null);
      lastHighlightKey = [];
      applyGroupPreview(w, null);
      applyGhost(w, null);
      renderer.flatByGroup = mode.value === 'provinces';
      renderer.highlightByGroup = category.value === 'provinces';
      renderer.style = mapStyle.value;
    }

    // 干净的画面的叠加层（与 draw(true) 的一样：图层里打开的河、风、洋流、地名、比例尺、纬度刻度；省份类工具时的省名）
    function cleanOverlay(w: World, frame: Frame): OverlayState {
      const c = category.value;
      const groups = labelGroups.value;
      const types = new Set((Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => groups.has(FEATURE_INFO[t].group)));
      return {
        rivers: overlays.value.rivers,
        wind: overlays.value.wind,
        markers: false,
        season: season.value,
        style: mapStyle.value,
        shapes: [],
        provinceLabels: c === 'provinces' ? provinceLabels : [],
        features: overlays.value.labels || c === 'names' ? w.derived.features : null,
        labelTypes: types,
        kmPerUnit: w.kmPerUnit,
        hoverLabel: null,
        scaleBar: overlays.value.scale,
        cornerLift: 0,
        latitude: overlays.value.latitude ? { north: w.settings.latNorth + w.small.planet.latShift, south: w.settings.latSouth + w.small.planet.latShift } : null,
        currents: overlays.value.currents,
        motion: false,
        exact: true,
        frame,
      };
    }

    // 开发时的平移缩放测速（src/render/bench.ts）：控制台里 await __map2Bench()
    if (import.meta.env.DEV) {
      const hooks = {
        renderer,
        canvas: glCanvas,
        draw: () => draw(),
        spacing: () => world.value?.mesh.spacing ?? 0.01,
        snapshot: () => snapshotCanvas()!,
        overlay: (c2: CanvasRenderingContext2D) => (lastOverlay ? drawOverlay(c2, ...lastOverlay) : []),
      };
      Object.assign(window, {
        __map2Bench: (opts?: { frames?: number; only?: string[] }) => import('../render/bench').then((b) => b.runBench(hooks, opts)),
        __map2SaveRefs: (tag?: string) => import('../render/bench').then((b) => b.saveRefs(hooks, tag)),
        __map2CompareRefs: (tag?: string) => import('../render/bench').then((b) => b.compareRefs(hooks, tag)),
        __map2PassTimes: (moving?: boolean) => import('../render/bench').then((b) => b.passTimes(hooks, moving)),
        __map2BrushBench: (frames?: number) => import('../render/bench').then((b) => b.brushBench(hooks, frames)),
        __map2OverlayBench: (opts?: { frames?: number; only?: string[] }) => import('../render/bench').then((b) => b.overlayBench(hooks, opts)),
        // 地图单位 → 屏幕上的 CSS 像素（开发时在浏览器里按地图上的点拖动、核对用）
        __map2ToScreen: (x: number, y: number) => renderer.worldToScreen(x, y),
      });
    }
    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      barObs.disconnect();
      disposeSheet();
      window.removeEventListener('resize', onWinResize);
      disposeWorld();
      disposePaths();
      disposeColors();
      disposeTool();
      disposeRedraw();
      resizeObs.disconnect();
      mapApi.current = null;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  return (
    <div class="map">
      <canvas ref={glRef} class="map-gl" />
      <img ref={refImg} class="map-ref" alt="" />
      <div ref={refTile} class="map-ref" />
      <canvas ref={ovRef} class={`map-overlay tool-${tool.value}`} />
    </div>
  );
}

// 导出当前视图为 PNG（与屏幕上看到的地图一致，不带高亮、工具的预览）
export function snapshotCanvas(): HTMLCanvasElement | null {
  const hook = (window as unknown as { __map2?: { snapshot: (clean?: boolean) => HTMLCanvasElement } }).__map2;
  return hook ? hook.snapshot(true) : null;
}

type ExportImage = (o: { width: number; labels: LabelSize; tile?: number; overlay?: boolean }, progress: (p: number) => void, cancelled: () => boolean) => Promise<HTMLCanvasElement | null>;

// 导出整张地图（.png）：进度显示在顶部的提示条上（与游戏文件包共用，可以取消），得到 PNG 的 Blob；取消、出错时为 null
export async function exportFullMap(o: { width: number; labels: LabelSize }): Promise<Blob | null> {
  const hook = (window as unknown as { __map2?: { exportImage: ExportImage } }).__map2;
  if (!hook || exportProgress.value !== null) return null;
  let stop = false;
  exportProgress.value = 0;
  imageExportCancel.current = () => (stop = true);
  try {
    const canvas = await hook.exportImage(o, (p) => (exportProgress.value = p), () => stop);
    if (!canvas || stop) return null;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) showToast('图片太大，浏览器存不下：换小一点的尺寸', true);
    return stop ? null : blob;
  } catch (e) {
    showToast(`导出失败：${(e as Error).message}`, true);
    return null;
  } finally {
    imageExportCancel.current = null;
    exportProgress.value = null;
  }
}
