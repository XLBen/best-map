import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { FEATURE_INFO, type FeatureType } from '../../core/features';
import { findCell } from '../../core/mesh';
import type { World } from '../../core/world';
import { type HighlightLayer, cellLayers, groupPreview, highlightColors, provinceScale } from '../render/colors';
import { type LabelBox, type OverlayPaths, type ProvinceLabel, buildPaths, drawOverlay, riverPathsKey, samePathsKey } from '../render/overlay';
import { Renderer } from '../render/renderer';
import {
  FLASH_MS,
  adjustPreview,
  cornerLift,
  cursorHint,
  flash,
  focusSpecies,
  hoverCell,
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
  showToast,
  sliderActive,
  tool,
  world,
  worldEpoch,
} from '../state';
import { MAP_INSETS, clampPlanetCamera, mapApi, maxZoom, minZoom } from './camera';
import { TOOL_DEFS, category } from './defs/tools';
import { type Pointer, type Preview, type ProvincePreview, type ToolHandler, measureTool, provinceCellAt } from './tools';

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
    let labelBoxes: LabelBox[] = [];
    let fittedMesh: unknown = null;
    let fittedEpoch = -1;
    let frame = 0;
    // 改完后的闪烁每 1/40 不透明度才变一次：到那时再画，不必每一帧都画一遍
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
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

    function highlightLayers(w: World, preview: Preview): { layers: HighlightLayer[]; key: unknown[] } {
      const layers: HighlightLayer[] = [];
      const c = category.value;
      // 按每个图层对象比较：工具沿用同一个图层时不必重新上传
      const key: unknown[] = [w, c, ...preview.layers];
      if (c === 'nature') {
        // 没涂成的格：红色斜线
        const failing = w.derived.conflicts.flatMap((x) => x.failing);
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
      // “调整”面板拖滑块：绿色会变成陆地，蓝色会变成海，橙 / 蓝灰是山会变高 / 变矮
      const ap = adjustPreview.value;
      if (ap) {
        if (ap.relief.cells.length) {
          const up: number[] = [];
          const upV: number[] = [];
          const down: number[] = [];
          const downV: number[] = [];
          ap.relief.cells.forEach((cell, k) => {
            const d = ap.relief.delta[k];
            if (d > 0) {
              up.push(cell);
              upV.push(Math.min(1, d / 0.6));
            } else {
              down.push(cell);
              downV.push(Math.min(1, -d / 0.6));
            }
          });
          layers.push({ cells: up, values: upV, color: [205, 135, 70], alpha: 0.7 }, { cells: down, values: downV, color: [120, 150, 190], alpha: 0.7 });
        }
        layers.push({ cells: ap.gained, color: [120, 205, 95], alpha: 0.8 }, { cells: ap.lost, color: [70, 150, 235], alpha: 0.8 });
        key.push(ap);
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

    // clean：导出图片用的干净画面——不带高亮、闪烁、工具的图形和预览、鼠标旁的话（画完由调用者再按原样重画一次）
    function draw(clean = false) {
      frame = 0;
      const w = world.value;
      if (!w || !paths) return;
      placeReference(w);
      // 拖左侧滑块时：鼠标不在地图上，也在最后停的地方（没有就在画面中间）显示预览
      if (sliderActive.value && !pointer && !pressed && !lastPointer) {
        const sx = glCanvas.clientWidth / 2;
        const sy = glCanvas.clientHeight / 2;
        const [x, y] = renderer.screenToWorld(sx, sy);
        lastPointer = { x, y, sx, sy, cell: findCell(w.mesh, x, y), shift: false, alt: false };
        handler.move?.(lastPointer, false);
      }
      // 量出来的线鼠标离开地图后也留着（看底部条上的数字时还在）；排队中的笔画鼠标离开后也留着
      const showPreview = !clean && (!!pointer || pressed || sliderActive.value || !!measure.value || !!active().keep?.());
      const preview: Preview = showPreview ? active().preview() : { layers: [], shapes: [], hint: null };
      if (clean) {
        renderer.setHighlight(null);
        lastHighlightKey = [];
      } else {
        const { layers, key } = highlightLayers(w, preview);
        if (key.length !== lastHighlightKey.length || key.some((k, i) => k !== lastHighlightKey[i])) {
          renderer.setHighlight(highlightColors(w, layers));
          lastHighlightKey = key;
        }
      }
      applyGroupPreview(w, preview.provinces ?? null);
      // 剪刀切线附近：省份着色、省份工具的高亮也按切线换过的格取
      renderer.flatByGroup = mode.value === 'provinces';
      renderer.highlightByGroup = category.value === 'provinces';
      renderer.style = mapStyle.value;
      renderer.render(w.kmPerUnit);
      const c = category.value;
      const groups = labelGroups.value;
      // 底部条伸到左下角（窗口窄、选项多）时，比例尺和尺子按钮抬到它上面
      const bar = document.querySelector('.bottombar');
      const r = bar?.getBoundingClientRect();
      const lift = r && r.left < 300 ? Math.ceil(window.innerHeight - r.top) + 4 : 0;
      if (lift !== cornerLift.value) cornerLift.value = lift;
      const types = new Set((Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => groups.has(FEATURE_INFO[t].group)));
      labelBoxes = drawOverlay(ctx, w, paths, renderer.camera, {
        rivers: overlays.value.rivers,
        wind: overlays.value.wind,
        markers: c === 'water' && !clean,
        season: season.value,
        style: mapStyle.value,
        shapes: preview.shapes,
        provinceLabels: c === 'provinces' ? provinceLabels : [],
        features: overlays.value.labels || c === 'names' ? w.derived.features : null,
        labelTypes: types,
        kmPerUnit: w.kmPerUnit,
        hoverLabel: c === 'names' && !clean ? (hoverLabel ?? selectedFeature.value) : null,
        scaleBar: overlays.value.scale,
        cornerLift: lift,
        latitude: overlays.value.latitude
          ? { north: w.settings.latNorth + w.small.planet.latShift, south: w.settings.latSouth + w.small.planet.latShift }
          : null,
        currents: overlays.value.currents,
      });
      if (clean) return;
      // 鼠标旁的一句话（拖滑块时一般由滑块上的数说明，这里不显示；画笔在鼠标最后停的地方预览涂一下时，写在那里）
      const at = sliderActive.value ? (preview.sliderHint ? lastPointer : null) : pointer;
      const hint = at && preview.hint ? { x: at.sx, y: at.sy, text: preview.hint, warn: preview.warn } : null;
      const cur = cursorHint.value;
      if (hint?.text !== cur?.text || hint?.x !== cur?.x || hint?.y !== cur?.y || hint?.warn !== cur?.warn) cursorHint.value = hint;
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
      if (w.mesh.kind === 'sphere') {
        // 整个星球：经度取圆周平均，跨过经度 180° 的省份名字也落在省份上
        const sums = new Map<number, [number, number, number, number]>();
        for (let i = 0; i < w.mesh.n; i++) {
          const p = w.causes.province[i];
          if (p < 0) continue;
          const s = sums.get(p) ?? [0, 0, 0, 0];
          s[0] += Math.sin(Math.PI * w.mesh.x[i]);
          s[1] += Math.cos(Math.PI * w.mesh.x[i]);
          s[2] += w.mesh.y[i];
          s[3]++;
          sums.set(p, s);
        }
        provinceLabels = [...sums]
          .filter(([p]) => w.small.provinces[p])
          .map(([p, [sn, cs, y, c]]) => {
            const x = Math.atan2(sn, cs) / Math.PI;
            return { x: x < 0 ? x + 2 : x, y: y / c, text: w.small.provinces[p].name || String(p), kind: w.small.provinces[p].kind };
          });
      } else {
        const sums = new Map<number, [number, number, number]>();
        for (let i = 0; i < w.mesh.n; i++) {
          const p = w.causes.province[i];
          if (p < 0) continue;
          const s = sums.get(p) ?? [0, 0, 0];
          s[0] += w.mesh.x[i];
          s[1] += w.mesh.y[i];
          s[2]++;
          sums.set(p, s);
        }
        provinceLabels = [...sums]
          .filter(([p]) => w.small.provinces[p])
          .map(([p, [x, y, c]]) => ({ x: x / c, y: y / c, text: w.small.provinces[p].name || String(p), kind: w.small.provinces[p].kind }));
      }
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

    // 着色：视图模式、季节、关注的类型、边界。着色用到的东西都没变（只改了名字的轻快照）就不重新着色、不重画地形
    let colorKey: unknown[] = [];
    const disposeColors = effect(() => {
      const w = world.value;
      if (!w) return;
      const o = { mode: mode.value, season: season.value, focusSpecies: focusSpecies.value, borders: overlays.value.borders && (category.value === 'provinces' || mode.value === 'provinces') };
      const kinds = Object.entries(w.small.provinces)
        .map(([p, m]) => `${p}:${m.kind}`)
        .join(',');
      const seams = (w.small.provinceSeams ?? []).map((s) => s.id).join(',');
      const key = [w.mesh, w.derived.elevation, w.derived.dominant, w.causes.province, kinds, seams, o.mode, o.season, o.focusSpecies, o.borders];
      if (key.length === colorKey.length && key.every((k, i) => k === colorKey[i])) return;
      colorKey = key;
      renderer.setMesh(w.mesh);
      renderer.setLayers(cellLayers(w, o));
      lastHighlightKey = [];
      groupKey = [];
      requestDraw();
    });

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
      void labelGroups.value;
      void adjustPreview.value;
      void sliderActive.value;
      void openPanel.value;
      void measure.value;
      void reference.value;
      void redrawTick.value;
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

    // 屏幕上的一点（CSS 像素，相对画布）在地图上的哪里
    const pointerAt = (sx: number, sy: number, shift: boolean, alt: boolean): Pointer => {
      const [x, y] = renderer.screenToWorld(sx, sy);
      const w = world.value;
      // 整个星球东西相接：只看南北
      const inside = !!w && (w.mesh.kind === 'sphere' ? y >= 0 && y <= 1 : x >= 0 && y >= 0 && x <= w.mesh.width && y <= w.mesh.height);
      return { x, y, sx, sy, cell: inside ? findCell(w!.mesh, x, y) : -1, shift, alt };
    };
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
      if (hoverCell.value !== p.cell) hoverCell.value = p.cell;
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
        // 吸取省份：剪刀切线附近按显示出来的那一边算
        const cell = def.category === 'provinces' ? provinceCellAt(w, p) : p.cell;
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
      if (hoverCell.value !== p.cell) hoverCell.value = p.cell;
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
    };
    return () => {
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
