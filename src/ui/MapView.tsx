import { effect, untracked } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { displayCellAt } from '../../core/display';
import { FEATURE_INFO, type FeatureType, type GeoFeature } from '../../core/features';
import { findCell } from '../../core/mesh';
import { COAST_AMP } from '../../core/terrain';
import type { ProvinceMeta, World } from '../../core/world';
import { type ColorOptions, type GhostEdit, GhostBuffer, cellLayers, colorSignature, editGhost, fxLayers, groupPreview, highlightColors, lakeTintLayer, lakeTypesSignature, provinceScale, terrainGhost } from '../render/colors';
import { type LabelBox, type OverlayPaths, type ProvinceLabel, buildPaths, drawOverlay, peakLabels, riverLayer, riverLayerScene, riverPathsKey, samePathsKey } from '../render/overlay';
import { convertCamera, effectiveZoom } from '../render/projection';
import { type CellLayers, Renderer, SETTLE_MS } from '../render/renderer';
import {
  adjustPreview,
  adjustPreviewWorld,
  cornerLift,
  cursorHint,
  erasing,
  flash,
  focusSpecies,
  hoverRiver,
  labelGroups,
  nameMode,
  mapStyle,
  measure,
  mode,
  openPanel,
  options,
  overlays,
  pinnedCell,
  picking,
  selectedSettle,
  prefs,
  redrawTick,
  reference,
  riverStyleOverride,
  season,
  sheet,
  showToast,
  sliderActive,
  tool,
  visualOverrides,
  world,
  worldEpoch,
} from '../state';
import { barPreview } from './barPreview';
import { MAP_INSETS, clampPlanetCamera, mapApi, maxZoom, minZoom } from './camera';
import { CATEGORY_DEFS, TOOL_DEFS, category, createTool, watchTools } from './defs/tools';
import { layerProvinceLabels as layerLabels } from './defs/layers';
import { type OverlayArgs, installMapHooks } from './map/debug';
import { mapExporter } from './map/export';
import { highlightLayers } from './map/highlights';
import { type PointerState, mapInput } from './map/input';
import { pendingEdits, pendingPreview } from './pending';
import { riverGlow } from './riverCourse';
import { hasCountries } from './countries';
import { type ModeDef, mapKind, modeDef, modeFeatures, modeOf } from './map/modes';
import { regionDraws } from './map/political';
import { markKey } from './settlements';
import { settleOverlay } from './map/settle';
import { onSettleImageLoad } from '../render/settle-draw';
import { type Preview, type ProvincePreview, type ToolHandler, measureTool } from './tools';

// 文化、文化组、每一维、人口模式里国界的浓淡（第二十五轮：细而淡，只留近处一圈）
const FAINT_COUNTRY = 0.4;

// 地图视图：WebGL 底图 + 2D 矢量叠加；指针事件交给当前工具（map/input.ts），工具给出预览。
// 这里只把它们接起来：哪一类工具多画什么由 defs/tools.ts 声明（map/highlights.ts），导出图片在 map/export.ts，window 上的钩子在 map/debug.ts

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

const NO_PREVIEW: Preview = { layers: [], shapes: [], hint: null };
const PICK_PREVIEW: Preview = { layers: [], shapes: [], hint: '点一下吸取' };

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
    // 图层里打开了“省名”时标的省名（“海域的省名”另开）：屏幕上一直标着，导出也是这一份
    const layerProvinceLabels = (): ProvinceLabel[] => layerLabels(provinceLabels, overlays.value.labels, labelGroups.value);
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
    // 鼠标在哪里、按没按着（与指针共用，见 map/input.ts）
    const view: PointerState = { pointer: null, lastPointer: null, pressed: false, hoverLabel: null, userMoved: false };
    let lastHighlightKey: unknown[] = [];

    const hitLabel = (sx: number, sy: number) => labelBoxes.find((b) => sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1)?.key ?? null;
    // 工具的像素容差、按像素定大小的图形按它算：投影时是相当于等距圆柱的缩放（投影正中的比例）
    const env = { zoom: () => effectiveZoom(renderer.camera), hitLabel };
    let handler: ToolHandler = createTool(tool.value, env);
    // 量距离时地图上的点击交给它，不交给当前工具
    const measurer = measureTool(env.zoom);
    const active = () => (measure.value ? measurer : handler);

    const requestDraw = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => draw());
    };

    const input = mapInput(view, { renderer: () => renderer, glCanvas, ovCanvas, active, requestDraw, hitLabel });
    // 自定义点上传的小图解码好了：重画
    onSettleImageLoad(requestDraw);

    const fit = () => {
      const w = world.value;
      if (!w) return;
      // 整个星球：看全图时留在当前的经度（投影时朝向不变，放进整个形状）
      const keepX = w.mesh.kind === 'sphere' && !renderer.camera.proj ? renderer.camera.x : null;
      renderer.fit(w.mesh, MAP_INSETS);
      if (keepX !== null) {
        renderer.camera.x = keepX;
        clampPlanetCamera(w.mesh, renderer.camera, glCanvas.clientHeight, true);
      }
      view.userMoved = false;
      input.refreshPointer();
      requestDraw();
    };

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
      // 等面积、球形投影时不铺参考图（图层里有说明）
      if (!r || !r.visible || (w.mesh.kind === 'sphere' && renderer.camera.proj)) {
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

    // 导出图片（整张地图）：画的期间屏幕上的地图不重画
    const exporter = mapExporter({
      renderer,
      paths: () => paths,
      cleanState,
      provinceLabels: layerProvinceLabels,
      done: () => {
        lastHighlightKey = [];
        requestDraw();
      },
    });

    // clean：导出图片用的干净画面——不带高亮、闪烁、工具的图形和预览、鼠标旁的话（画完由调用者再按原样重画一次）
    function draw(clean = false) {
      frame = 0;
      const w = world.value;
      if (!w || !paths) return;
      // 正在导出整张地图：渲染器的图层是导出用的干净的那一份，屏幕先不画（导出完了重画）
      if (exporter.state.busy && !clean) return;
      placeReference(w);
      // 拖左侧滑块时：鼠标不在地图上，也在最后停的地方（没有就在画面中间）显示预览
      if (sliderActive.value && !view.pointer && !view.pressed && !view.lastPointer) {
        const sx = glCanvas.clientWidth / 2;
        const sy = glCanvas.clientHeight / 2;
        const [x, y] = renderer.screenToWorld(sx, sy);
        view.lastPointer = { x, y, sx, sy, cell: findCell(w.mesh, x, y), shift: false, alt: false };
        handler.move?.(view.lastPointer, false);
      }
      const def = TOOL_DEFS[tool.value];
      const cat = CATEGORY_DEFS[def.category];
      const cm = cat.map ?? {};
      // 量出来的线鼠标离开地图后也留着（看底部条上的数字时还在）；点了以后还在算、不排队的那一步（重画这一片）也留着
      const showPreview = !clean && (!!view.pointer || view.pressed || sliderActive.value || !!measure.value || !!active().keep?.());
      // 吸管（第二十七轮）：下一次点击是吸取，鼠标旁写一声，不画笔刷的预览
      const own: Preview = !showPreview ? NO_PREVIEW : picking.value && !measure.value ? PICK_PREVIEW : active().preview();
      // 工具选中时一直画着的东西（鼠标不在地图上也画）
      const back = clean ? null : (active().backdrop?.() ?? null);
      // 排队中的编辑（松手时的预览，直到结果换上，鼠标离开地图也留着）与底部条、“⋯”里按钮悬停的预览
      // （省份的对半分开、重新划分，改一条河）画在当前工具的预览下面。幽灵海岸几步合在一起；将来的世界用当前工具的确切预览，
      // 没有时用排队中最后一个有确切预览的（都是按当前世界算的，见 pending.ts）
      const queued = clean ? [] : pendingEdits.value.map((e) => pendingPreview(e, w));
      // 底部条预览的通道里省份的那一份（改一条河的那一份由画河工具画）
      const bp = clean ? null : barPreview.value;
      const button = bp?.kind === 'provinces' && bp.base === w ? bp : null;
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
        const { layers, key } = highlightLayers(w, shown, preview, back?.layers ?? [], cat.id, cm.highlights);
        if (key.length !== lastHighlightKey.length || key.some((k, i) => k !== lastHighlightKey[i])) {
          renderer.setHighlight(highlightColors(w, layers));
          lastHighlightKey = key;
        }
      }
      applyGroupPreview(w, preview.provinces ?? null);
      // 导出图片的干净画面不带幽灵海岸（画的是现在的世界）。幽灵海岸改的是画出来的那份底子（预览世界的陆地与当前世界相同）
      applyGhost(shown, clean ? null : preview);
      // 工具选中的东西（画河时选中的河）、河流列表里鼠标停着的河：沿河一道淡黄的光，压在工具的图形下面
      const glow = clean ? [] : [...(def.focus?.glow(w) ?? []), ...(hoverRiver.value ? riverGlow(w, hoverRiver.value) : [])];
      // 剪刀切线附近：省份着色、省份工具的高亮也按切线换过的格取；国家底图按同样的规则取格（海上的像素只取海格：领海淡淡的一圈）
      renderer.flatByGroup = mode.value === 'provinces' || mode.value === 'country' || mode.value === 'bloc';
      renderer.highlightByGroup = !!cm.provinces;
      // 地图模式（第二十五轮，map/modes.ts 的表）：国家模式里省界淡一些，文化等模式里更淡（省份类工具开着时照旧）
      const md = modeDef(modeOf(shown));
      setBorderAlpha(md, !!cm.provinces);
      renderer.style = mapStyle.value;
      // 河由渲染器在合成一步里画（只画在陆地上，排在省界、高亮下面）：渲染器按这一帧是不是移动中取停稳或移动中的那张
      const shownRivers = shown === w ? paths : pathsOf(shown);
      const style = mapStyle.value;
      renderer.riverLayer = overlays.value.rivers
        ? (motion, scene) => (scene ? riverLayerScene(shown, shownRivers, scene, style) : riverLayer(shown, shownRivers, renderer.camera, { style, motion, motionEpoch: renderer.motionEpoch }, glCanvas))
        : null;
      // 镜头正在动：渲染器按低分辨率画了这一帧，停下 SETTLE_MS 以后再画一次（补上全分辨率的）。导出图片一定按停稳的画法画
      const moving = renderer.render(w.kmPerUnit, { still: clean });
      // 停下后补画全分辨率的那一帧：地图这一帧按停稳的画法画，叠加层先照移动中的样子贴，下一帧再按停稳的画（两样重活分在两帧）
      const settling = !moving && !clean && renderer.justSettled;
      if (settling) requestDraw();
      if (moving) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          requestDraw();
        }, SETTLE_MS + 10);
      }
      const groups = labelGroups.value;
      // 底部条伸到左下角（窗口窄、选项多）时，比例尺和尺子按钮抬到它上面（底部条、窗口变了大小时才重新量，不在每帧查 DOM）
      const lift = barLift();
      if (lift !== cornerLift.value) cornerLift.value = lift;
      const types = new Set((Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => groups.has(FEATURE_INFO[t].group)));
      const ovArgs: OverlayArgs = [shown, shownRivers, renderer.camera, {
        rivers: false,
        wind: overlays.value.wind,
        markers: !!cm.markers && !clean,
        season: season.value,
        style: mapStyle.value,
        shapes: glow.length || back?.shapes.length ? [...(back?.shapes ?? []), ...glow, ...preview.shapes] : preview.shapes,
        // 省名：省份类工具打开时（不是导出）标出所有的省帮着选；别的时候、导出都按图层里的“省名”（第十三轮修）
        provinceLabels: cm.provinces && !clean ? labelsFor(w, preview.provinces) : layerProvinceLabels(),
        features:
          overlays.value.labels || (cm.labels && !clean)
            ? labelsShown(cm.labels && !clean ? shown.derived.features : modeFeatures(shown.derived.features, md.features), def.focus && !clean ? def.focus.hideLabel(w) : '')
            : null,
        // 片区名（国名、文化名……，按模式）：图层里开着地名时
        countries: md.regions && overlays.value.labels ? regionDraws(shown, md.regions, nameMode.value) : null,
        // 城市、道路、地标、自定义点（第二十四轮）：“城市”一类开着时都画、选中的城市写名字；“道路”工具开着时道路画得清楚
        ...settleOverlay(shown, { mode: md, editing: cat.id === 'settlements' && !clean, selected: settleKey(), roadEdit: tool.value === 'road' && !clean }),
        labelTypes: types,
        peaks: overlays.value.peaks ? peakLabels(shown) : null,
        nameMode: nameMode.value,
        kmPerUnit: w.kmPerUnit,
        hoverLabel: cm.labels && !clean ? (view.hoverLabel ?? cm.labels()) : null,
        scaleBar: overlays.value.scale,
        cornerLift: lift,
        latitude: overlays.value.latitude
          ? { north: shown.settings.latNorth + shown.small.planet.latShift, south: shown.settings.latSouth + shown.small.planet.latShift }
          : null,
        currents: overlays.value.currents,
        motion: moving || settling,
        motionEpoch: renderer.motionEpoch,
        exact: clean,
      }];
      lastOverlay = ovArgs;
      labelBoxes = drawOverlay(ctx, ...ovArgs);
      if (clean) return;
      // 鼠标旁的一句话（拖滑块时一般由滑块上的数说明，这里不显示；画笔在鼠标最后停的地方预览涂一下时，写在那里）
      const at = sliderActive.value ? (preview.sliderHint ? view.lastPointer : null) : view.pointer;
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
        view.userMoved = false;
        view.lastPointer = null;
        // 鼠标还在地图上：按新的网格重新算它指着哪一格（旧的格号属于旧网格）
        input.refreshPointer();
      }
      if (provinceScaleFor !== w.causes.province) {
        renderer.provinceScale = provinceScale(w.causes.province);
        provinceScaleFor = w.causes.province;
      }
      provinceLabels = provinceLabelsOf(w, w.causes.province, w.small.provinces);
      // 鼠标没动、世界变了（编辑的结果到了）：屏幕上这一点画的格可能变了（陆海、切线），重新算
      for (const p of new Set([view.pointer, view.lastPointer])) if (p && p.cell >= 0) p.shown = displayCellAt(w, p.x, p.y, p.cell);
      if (view.pointer?.shown) input.setHover(view.pointer);
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
      // 省界：图层里开着，并且开着省份类工具、省份着色或画省界的地图模式（国家、文化……）
      // 国界：有国家时按地图模式（国家模式显眼，文化等模式淡），“国家”一类的工具里照旧显眼
      const md = modeDef(modeOf(w));
      const o = {
        mode: mode.value,
        season: season.value,
        focusSpecies: focusSpecies.value,
        borders: overlays.value.borders && (!!CATEGORY_DEFS[category.value].map?.provinces || mode.value === 'provinces' || md.provinces > 0),
        countryBorders: hasCountries(w) && (md.countryBorders !== 'none' || category.value === 'countries'),
      };
      renderer.countryAlpha = md.countryBorders === 'faint' && category.value !== 'countries' ? FAINT_COUNTRY : 1;
      colorOpts = o;
      const arrays: unknown[] = [];
      for (const v of Object.values(w.derived)) if (ArrayBuffer.isView(v)) arrays.push(v);
      for (const v of Object.values(w.causes)) if (ArrayBuffer.isView(v)) arrays.push(v);
      arrays.push(...Object.values(w.derived.corrF), ...Object.values(w.causes.fields));
      const key = [w.mesh, ...arrays, smallKey(w), o.mode, o.season, o.focusSpecies, o.borders, o.countryBorders];
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

    // 省界的浓淡：按地图模式（省份底图、省份类工具开着时照旧）
    function setBorderAlpha(md: ModeDef, provinceTool: boolean) {
      renderer.provinceAlpha = md.provinces > 0 && !provinceTool && mode.value !== 'provinces' ? md.provinces : 1;
    }
    // “城市”工具选中的城市：地图上照旧写名字
    function settleKey(): string | null {
      const r = selectedSettle.value;
      return r && (r.kind === 'city' || r.kind === 'point') ? markKey(r.kind, r.id) : null;
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
      renderer.flatByGroup = mode.value === 'provinces' || mode.value === 'country' || mode.value === 'bloc';
      renderer.highlightByGroup = !!CATEGORY_DEFS[category.value].map?.provinces;
      setBorderAlpha(modeDef(modeOf(w)), !!CATEGORY_DEFS[category.value].map?.provinces);
      renderer.style = mapStyle.value;
    }

    // 工具选中的东西自己的地名（key）先不标：画河时选中的河不盖住它的控制点、“+”。同样的输入给同一个数组
    let labelMemo: { from: GeoFeature[]; key: string; out: GeoFeature[] } | null = null;
    function labelsShown(list: GeoFeature[], key: string): GeoFeature[] {
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
    // 底部条按钮悬停时的预览由 setTool 清掉（defs/tools.ts）；鼠标不在地图上时新工具不预览（第十三轮修）
    // 第二十七轮：开关橡皮擦也换一个工具对象
    const disposeTool = effect(() => {
      const id = tool.value;
      void erasing.value;
      untracked(() => handler.cancel?.());
      handler = untracked(() => createTool(id, env));
      if (view.lastPointer && view.pointer) handler.move?.(view.lastPointer, false);
      requestDraw();
    });
    const disposeRedraw = effect(() => {
      void options.value;
      void pinnedCell.value;
      void overlays.value;
      void season.value;
      void mapStyle.value;
      void category.value;
      void flash.value;
      void hoverRiver.value;
      void labelGroups.value;
      void nameMode.value;
      void mapKind.value;
      void adjustPreview.value;
      void sliderActive.value;
      void openPanel.value;
      void measure.value;
      void picking.value;
      void reference.value;
      void redrawTick.value;
      void visualOverrides.value;
      void pendingEdits.value;
      void barPreview.value;
      // 各工具、各类声明的（选中的河、湖、省、地名，选生态的范围……）
      watchTools();
      requestDraw();
    });

    const resizeObs = new ResizeObserver(() => {
      const w = world.value;
      if (w && !view.userMoved) {
        renderer.fit(w.mesh, MAP_INSETS);
        input.refreshPointer();
      }
      requestDraw();
    });
    resizeObs.observe(glCanvas);

    // 投影（第十三轮 G4，图层里选，只对整个星球）：换了就把画面中心那一点留在中心、那里的大小不变；
    // 还没手动动过镜头时看全图。一块地区、等距圆柱时镜头上没有投影
    const disposeProjection = effect(() => {
      const w = world.value;
      const want = w?.mesh.kind === 'sphere' ? prefs.value.projection : 'equirect';
      const cur = renderer.camera.proj?.kind ?? 'equirect';
      if (!w || want === cur) return;
      const cw = glCanvas.clientWidth || 800;
      const ch = glCanvas.clientHeight || 600;
      const c = convertCamera(renderer.camera, cw, ch, want);
      c.zoom = Math.max(minZoom(w.mesh, cw, ch, c.proj), Math.min(maxZoom(w.mesh, c.proj), c.zoom));
      renderer.camera = c;
      if (!view.userMoved) renderer.fit(w.mesh, MAP_INSETS);
      clampPlanetCamera(w.mesh, renderer.camera, ch, true, cw);
      input.refreshPointer();
      requestDraw();
    });

    mapApi.current = {
      fit,
      zoomBy: (f) => input.zoomAt(glCanvas.clientWidth / 2, glCanvas.clientHeight / 2, f),
      cancel: () => input.cancel(),
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

    installMapHooks({ renderer, glCanvas, ovCanvas, requestDraw, draw, exportImage: exporter.exportImage, lastOverlay: () => lastOverlay });

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
      disposeProjection();
      resizeObs.disconnect();
      mapApi.current = null;
      onSettleImageLoad(null);
      input.dispose();
    };
  }, []);

  // 光标：点选类的工具是手指（工具表里声明的），其余是十字
  return (
    <div class="map">
      <canvas ref={glRef} class="map-gl" />
      <img ref={refImg} class="map-ref" alt="" />
      <div ref={refTile} class="map-ref" />
      <canvas ref={ovRef} class="map-overlay" style={{ cursor: TOOL_DEFS[tool.value].cursor }} />
    </div>
  );
}
