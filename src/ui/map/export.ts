import { FEATURE_INFO, type FeatureType } from '../../../core/features';
import type { World } from '../../../core/world';
import { LABEL_REF_WIDTH, type LabelSize, exportFrame, planTiles, tileMargin, tileSize, tileView } from '../../render/export-plan';
import { type Frame, type OverlayPaths, type OverlayState, type ProvinceLabel, drawOverlay, releaseRiverTile, riverLayerScene, riverLayerTile } from '../../render/overlay';
import { type Proj, planeBounds } from '../../render/projection';
import type { Renderer } from '../../render/renderer';
import { exportProgress, imageExportCancel, labelGroups, mapStyle, nameMode, overlays, season, showToast, world } from '../../state';

// 导出图片：当前画面（snapshotCanvas）与整张地图（exportFullMap）。都是干净的画面：只有地图本身，
// 不带高亮、闪烁、工具的图形和预览、鼠标旁的话

export type ExportImageOptions = { width: number; labels: LabelSize; tile?: number; overlay?: boolean; seam?: number; projected?: boolean };
type ExportImage = (o: ExportImageOptions, progress: (p: number) => void, cancelled: () => boolean) => Promise<HTMLCanvasElement | null>;

// 干净的画面的叠加层（与屏幕上 draw(true) 的一样：图层里打开的河、风、洋流、地名、省名、比例尺、纬度刻度；不看开着的是哪类工具）
export function cleanOverlay(w: World, frame: Frame, provinceLabels: ProvinceLabel[]): OverlayState {
  const groups = labelGroups.value;
  const types = new Set((Object.keys(FEATURE_INFO) as FeatureType[]).filter((t) => groups.has(FEATURE_INFO[t].group)));
  return {
    // 河画在每一块里（renderTile）
    rivers: false,
    wind: overlays.value.wind,
    markers: false,
    season: season.value,
    style: mapStyle.value,
    shapes: [],
    // 导出只看图层的设定（第十三轮修：以前省份类、地名类工具开着时导出的图里写满了省名，连海省也有）
    provinceLabels,
    features: overlays.value.labels ? w.derived.features : null,
    labelTypes: types,
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
    const m = tileMargin(cellPx);
    const T = tileSize(renderer.exportLimit(), m, o.tile);
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
        const river = overlays.value.rivers ? riverLayerTile(w, paths, { x: tv.cx, y: tv.cy, zoom: fr.cam.zoom }, mapStyle.value, T, fr.dpr) : null;
        const px = renderer.renderTile(w.kmPerUnit, tv, T, fr.cam.zoom, fr.dpr, river);
        const img = new ImageData(t.w, t.h);
        if (t.w === T) img.data.set(px.subarray(0, T * t.h * 4));
        else for (let r = 0; r < t.h; r++) img.data.set(px.subarray(r * T * 4, (r * T + t.w) * 4), r * t.w * 4);
        octx.putImageData(img, t.x, t.y);
        progress(((i + 1) / tiles.length) * 0.85);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled()) return null;
      if (o.overlay !== false) drawOverlay(octx as CanvasRenderingContext2D, w, paths, fr.cam, cleanOverlay(w, { cw: fr.cw, ch: fr.ch, dpr: fr.dpr }, host.provinceLabels()));
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
      const style = mapStyle.value;
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
      if (o.overlay !== false) drawOverlay(octx as CanvasRenderingContext2D, w, paths, cam, cleanOverlay(w, { cw: W / dpr, ch: H / dpr, dpr }, host.provinceLabels()));
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
export async function exportFullMap(o: { width: number; labels: LabelSize; seam?: number; projected?: boolean }): Promise<Blob | null> {
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
