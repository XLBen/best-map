import { FEATURE_INFO, type FeatureType } from '../../../core/features';
import type { World } from '../../../core/world';
import { LABEL_REF_WIDTH, type LabelSize, exportFrame, planTiles, tileMargin, tileSize, tileView } from '../../render/export-plan';
import { type Frame, type OverlayPaths, type OverlayState, type ProvinceLabel, drawOverlay, peakLabels, releaseRiverTile, riverLayerScene, riverLayerTile } from '../../render/overlay';
import { type Proj, planeBounds } from '../../render/projection';
import type { Renderer } from '../../render/renderer';
import { modeDef, modeFeatures, modeOf } from './modes';
import { regionDraws } from './political';
import { settleOverlay } from './settle';
import { exportProgress, flowSeason, imageExportCancel, labelGroups, mode as viewMode, nameMode, overlays, showToast, world } from '../../state';
import { type MapStyle, handLook, styleRgba, worldMapStyle } from '../../../core/map-style';
import { styleUniforms } from '../../render/style-uniforms';
import { type DecorInfo, type DecorOptions, type LegendRow, anyDecor, drawExportDecor } from '../../render/export-decor';
import { loadGlyphs } from '../../render/label-font';
import { labelTexts } from '../../render/overlay-labels';
import { symbolsOn } from '../../render/overlay-symbols';
import { legendFor } from '../domain/legend';

// 导出图片：当前画面（snapshotCanvas）与整张地图（exportFullMap）。都是干净的画面：只有地图本身，
// 不带高亮、闪烁、工具的图形和预览、鼠标旁的话

// decor（第八十七轮）：罗盘、标题、边框、图例（省略为都不加）；title：标题写什么（世界的名字）
export type ExportImageOptions = { width: number; labels: LabelSize; tile?: number; overlay?: boolean; seam?: number; projected?: boolean; decor?: DecorOptions; title?: string };
type ExportImage = (o: ExportImageOptions, progress: (p: number) => void, cancelled: () => boolean) => Promise<HTMLCanvasElement | null>;

// 干净的画面的叠加层（与屏幕上 draw(true) 的一样：图层里打开的河、地名、省名、比例尺、纬度刻度，开着的风向、洋流；不看开着的是哪类工具）
export function cleanOverlay(w: World, frame: Frame, provinceLabels: ProvinceLabel[]): OverlayState {
  const groups = labelGroups.value;
  const types = new Set((Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => groups.has(FEATURE_INFO[t].group)));
  // 地图模式（第二十五轮）：按现在的模式写哪些地名、片区名，画哪些城市、地标
  const md = modeDef(modeOf(w));
  return {
    // 河画在每一块里（renderTile）
    rivers: false,
    wind: overlays.value.wind,
    markers: false,
    flowSeason: flowSeason.value,
    style: worldMapStyle(w.small),
    shapes: [],
    // 导出只看图层的设定（第十三轮修：以前省份类、地名类工具开着时导出的图里写满了省名，连海省也有）
    provinceLabels,
    features: overlays.value.labels ? modeFeatures(w.derived.features, md.features) : null,
    countries: overlays.value.labels && md.regions ? regionDraws(w, md.regions, nameMode.value) : null,
    ...settleOverlay(w, { mode: md, editing: false }),
    labelTypes: types,
    peaks: overlays.value.peaks ? peakLabels(w) : null,
    nameMode: nameMode.value,
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

// 导出的装饰要画的（第八十七轮）：标题、地图模式的图例（最多 8 行）与画了的符号（山、丘陵、森林、城市、道路）
const LEGEND_ROWS = 8;
export function decorInfo(w: World, st: OverlayState, title: string): DecorInfo {
  const data = legendFor(w, viewMode.value);
  const legend: LegendRow[] = (data?.items ?? []).filter((it) => it.color !== 'transparent' && !it.line).slice(0, LEGEND_ROWS).map((it) => ({ color: muted(it.color, st.style), label: it.label }));
  const h = handLook(st.style);
  if (symbolsOn(w, st)) {
    if (h.mountains) legend.push({ symbol: 'mountain', label: '山脉' }, { symbol: 'hill', label: '丘陵' });
    if (h.forests) legend.push({ symbol: 'forest', label: '森林' });
  }
  if (st.settlements?.some((m) => m.kind === 'city')) legend.push({ symbol: 'city', label: '城市' });
  if (st.roads && (st.roads.major.length || st.roads.minor.length)) legend.push({ symbol: 'road', label: '道路' });
  return { title, style: st.style, legendTitle: data?.title ?? '图例', legend };
}

// 图例的色块混上画风的陆地底色（地图上的颜色混过它，见合成着色器）
function muted(c: string, style: MapStyle): string {
  const v = styleRgba(c);
  const t = styleRgba(style.landTint);
  const k = style.landTintAmount;
  if (!v || !t || !k) return c;
  const m = (a: number, b: number) => Math.round(a + (b - a) * k);
  return `rgb(${m(v[0], t[0])}, ${m(v[1], t[1])}, ${m(v[2], t[2])})`;
}

// 叠加层与装饰：画风写了网页字体时先等要写的字载入好（最多几秒），再画叠加层，最后画装饰
async function finishImage(ctx: CanvasRenderingContext2D, w: World, paths: OverlayPaths, cam: Parameters<typeof drawOverlay>[3], st: OverlayState, o: ExportImageOptions, W: number, H: number) {
  const font = st.style.labelFont;
  const decor = o.decor && anyDecor(o.decor) ? o.decor : null;
  if (font && (o.overlay !== false || decor)) await loadGlyphs(font, [...labelTexts(st), o.title ?? '', '北图例山脉丘陵森林城市道路', decorInfo(w, st, '').legendTitle]);
  if (o.overlay !== false) drawOverlay(ctx, w, paths, cam, st);
  if (decor) drawExportDecor(ctx, W, H, decor, decorInfo(w, st, o.title ?? ''));
}

// 地图视图交给导出的：渲染器、现在的河的路径、换成干净画面的渲染器状态（当前世界的着色、存着的花纹，
// 不带高亮、省份预览、幽灵海岸）、图层里打开的省名、导完了（屏幕重画）
export interface ExportHost {
  renderer: Renderer;
  paths(): OverlayPaths | null;
  cleanState(w: World): void;
  provinceLabels(): ProvinceLabel[];
  done(): void;
}

// 导出整张地图（.png）：虚拟镜头盖住整张图（整个星球是一整圈 2:1，不重复），按停稳的画法离屏一块块画（每块四周多画一圈，
// 拼起来没有接缝），再在整张图上画河、地名（按整张图排）、边界之外的叠加层；与“当前画面”一样是干净的画面。
// 画的期间屏幕上的地图不重画（busy）；每画完一块让一下主线程（进度条照常动）。cancelled() 为真时停下，返回 null
export function mapExporter(host: ExportHost) {
  const { renderer } = host;
  const state = { busy: false };

  async function exportImage(o: ExportImageOptions, progress: (p: number) => void, cancelled: () => boolean): Promise<HTMLCanvasElement | null> {
    const w = world.value;
    const paths = host.paths();
    if (!w || !paths || state.busy) return null;
    const mesh = w.mesh;
    const proj = mesh.kind === 'sphere' ? renderer.camera.proj : undefined;
    if (o.projected && proj) return exportProjected(w, paths, proj, o, progress, cancelled);
    // 整个星球：图的左右边放在 seam（x）上，省略时放在经度 180°
    const fr = exportFrame(mesh, o.width, o.labels, mesh.kind === 'sphere' ? (o.seam ?? 0) : 0);
    const out = document.createElement('canvas');
    out.width = fr.width;
    out.height = fr.height;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('浏览器开不了这么大的画布');
    const cellPx = mesh.spacing * fr.cam.zoom * fr.dpr;
    // 手绘（第八十七轮）：岸外的水纹按场景颜色的 mipmap 量离岸多远——四周多留一圈（够最外一道水纹），块与边距都取 64 的倍数，
    // 各块的 mipmap 方格对齐整张图，拼起来没有接缝
    const hand = styleUniforms(worldMapStyle(w.small)).hand === 1;
    const m = hand ? Math.ceil((tileMargin(cellPx) + 48) / 64) * 64 : tileMargin(cellPx);
    const T0 = tileSize(renderer.exportLimit(), m, o.tile);
    const T = hand ? T0 - (T0 % 64) : T0;
    if (T < 64) throw new Error('显卡支持的画布太小，导不出这么大的图');
    const tiles = planTiles(fr.width, fr.height, T);
    state.busy = true;
    try {
      for (let i = 0; i < tiles.length; i++) {
        if (cancelled()) return null;
        // 每一块前都按当前世界换成干净的图层（中间世界变了也一致：都按开始时的这一份）
        host.cleanState(w);
        const t = tiles[i];
        const tv = tileView(fr, t.x, t.y, T, m);
        // 这一块的河（只画在陆地上，与屏幕上一样由渲染器合成）
        const river = overlays.value.rivers ? riverLayerTile(w, paths, { x: tv.cx, y: tv.cy, zoom: fr.cam.zoom }, worldMapStyle(w.small), T, fr.dpr) : null;
        const px = renderer.renderTile(w.kmPerUnit, tv, T, fr.cam.zoom, fr.dpr, river);
        const img = new ImageData(t.w, t.h);
        if (t.w === T) img.data.set(px.subarray(0, T * t.h * 4));
        else for (let r = 0; r < t.h; r++) img.data.set(px.subarray(r * T * 4, (r * T + t.w) * 4), r * t.w * 4);
        octx.putImageData(img, t.x, t.y);
        progress(((i + 1) / tiles.length) * 0.85);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled()) return null;
      await finishImage(octx as CanvasRenderingContext2D, w, paths, fr.cam, cleanOverlay(w, { cw: fr.cw, ch: fr.ch, dpr: fr.dpr }, host.provinceLabels()), o, fr.width, fr.height);
      if (cancelled()) return null;
      progress(0.9);
      return out;
    } finally {
      renderer.releaseExport();
      releaseRiverTile();
      state.busy = false;
      host.done();
    }
  }

  // 导出整张地图（等面积、球形投影，第十三轮 G4）：按现在的投影与朝向，整个形状放在图里（球形是朝着现在这一面的半球），
  // 投影之外透明。先画一块整圈的场景（受显卡的纹理大小所限，很大的图会软一些），再一块块合成；地名、经纬网按整张图排
  async function exportProjected(w: World, paths: OverlayPaths, proj: Proj, o: ExportImageOptions, progress: (p: number) => void, cancelled: () => boolean): Promise<HTMLCanvasElement | null> {
    const [u0, u1, v0, v1] = planeBounds(proj);
    const W = Math.max(2, Math.round(o.width));
    const H = Math.max(2, Math.round((W * (v1 - v0)) / (u1 - u0)));
    const ref = Math.min(LABEL_REF_WIDTH[o.labels], W);
    const dpr = W / ref;
    // 四周留一点边（球形外面一圈淡淡的大气）
    const zoom = (ref / (u1 - u0)) * (proj.kind === 'globe' ? 0.92 : 0.97);
    const cam = { x: (u0 + u1) / 2, y: (v0 + v1) / 2, zoom, proj };
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('浏览器开不了这么大的画布');
    const T = Math.min(renderer.exportLimit(), o.tile ?? 2048);
    if (T < 64) throw new Error('显卡支持的画布太小，导不出这么大的图');
    const tiles = planTiles(W, H, T);
    state.busy = true;
    try {
      host.cleanState(w);
      const style = worldMapStyle(w.small);
      const ex = renderer.beginProjectedExport(w.kmPerUnit, cam, W, H, dpr, overlays.value.rivers ? (s) => riverLayerScene(w, paths, s, style, true) : null);
      progress(0.2);
      for (let i = 0; i < tiles.length; i++) {
        if (cancelled()) return null;
        const t = tiles[i];
        const px = ex.tile(t.x, t.y, T);
        const img = new ImageData(t.w, t.h);
        if (t.w === T) img.data.set(px.subarray(0, T * t.h * 4));
        else for (let r = 0; r < t.h; r++) img.data.set(px.subarray(r * T * 4, (r * T + t.w) * 4), r * t.w * 4);
        octx.putImageData(img, t.x, t.y);
        progress(0.2 + ((i + 1) / tiles.length) * 0.65);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled()) return null;
      await finishImage(octx as CanvasRenderingContext2D, w, paths, cam, cleanOverlay(w, { cw: W / dpr, ch: H / dpr, dpr }, host.provinceLabels()), o, W, H);
      if (cancelled()) return null;
      progress(0.9);
      return out;
    } finally {
      renderer.releaseExport();
      releaseRiverTile();
      state.busy = false;
      host.done();
    }
  }

  return { state, exportImage };
}

// 导出当前视图为 PNG（与屏幕上看到的地图一致，不带高亮、工具的预览）
export function snapshotCanvas(): HTMLCanvasElement | null {
  const hook = (window as unknown as { __map2?: { snapshot: (clean?: boolean) => HTMLCanvasElement } }).__map2;
  return hook ? hook.snapshot(true) : null;
}

// 导出整张地图（.png）：进度显示在顶部的提示条上（与游戏文件包共用，可以取消），得到 PNG 的 Blob；取消、出错时为 null
// projected：整个星球按现在的等面积、球形投影导出（不给时是等距圆柱的 2:1）
export async function exportFullMap(o: { width: number; labels: LabelSize; seam?: number; projected?: boolean; decor?: DecorOptions; title?: string }): Promise<Blob | null> {
  const hook = (window as unknown as { __map2?: { exportImage: ExportImage } }).__map2;
  if (!hook || exportProgress.value !== null) return null;
  let stop = false;
  exportProgress.value = 0;
  imageExportCancel.current = () => (stop = true);
  try {
    const canvas = await hook.exportImage(o, (p) => (exportProgress.value = p), () => stop);
    if (!canvas || stop) return null;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) showToast('图片太大，换小一点的尺寸', true);
    return stop ? null : blob;
  } catch (e) {
    showToast(`导出失败：${(e as Error).message}`, true);
    return null;
  } finally {
    imageExportCancel.current = null;
    exportProgress.value = null;
  }
}
