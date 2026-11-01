import type { RiverDraw } from '../../core/river-pack';
import type { RiverType } from '../../core/river-types';
import type { MapStyle } from '../../core/map-style';
import type { FeatureType, GeoFeature } from '../../core/features';
import type { NameMode } from '../../core/name-display';
import type { CountryLabelDraw } from './overlay-country-labels';
import type { RoadDraw, SettleMark } from './settle-draw';
import type { Camera } from './renderer';
import type { World } from '../../core/world';
import type { Perf } from './perf';

// 叠加层共用的类型与小工具（第四十一轮从 overlay.ts 原样搬来）：路径、图形、选项、画布的大小、地名的框、测速

export interface OverlayPaths {
  // 地图上的河：每条河线一条带子（core/rivers.ts 的 riverRibbon），画的时候按镜头算出两岸
  rivers: RiverDraw[];
  guides: Path2D;
  lockedGuides: Path2D;
  // 在终点消失的河道的终点（水模式下画一个小圈）
  sinks: [number, number][];
  // 画过的河道的线（地图单位；等面积、球形投影时按点投影来画，见 overlay-proj.ts）
  guideLines?: { pts: [number, number][]; locked: boolean }[];
}

// 工具预览的矢量图形（地图单位）
export interface Shape {
  kind: 'circle' | 'line' | 'arrow' | 'cells' | 'river';
  x?: number;
  y?: number;
  r?: number;
  points?: [number, number][];
  cells?: number[];
  // river：与地图上的河同样画（宽度按流量分档、随缩放变宽，颜色照河的颜色，除非给了 color）。
  // flow 是每个点的流量，mul 是每个点的粗细倍数；arrow：河口画一个小箭头（看得出往哪流）
  flow?: number[];
  mul?: number[];
  arrow?: boolean;
  color?: string;
  // 线宽（屏幕像素）
  width?: number;
  dashed?: boolean;
  // river：按这种河流类型的画法、颜色、粗细画（画河时选了类型的预览）
  riverType?: RiverType;
  // 整个星球：圆是球面上真实大小的圆（画笔），投影到平铺图上（高纬度是横向拉长的椭圆）
  geodesic?: boolean;
  // 实心的圆（小礁的预览）
  fill?: boolean;
  // river：起点是源头（收尖）还是湖岸；最后一点在岸线上（河口略张开）。见 RiverLine
  head?: 'source' | 'lake';
  mouth?: boolean;
}

// 省份名字：无人区灰色、湖省蓝色（不用斜体：中文的斜体是把字硬拉斜）
export interface ProvinceLabel {
  x: number;
  y: number;
  text: string;
  kind?: 'land' | 'wasteland' | 'lake' | 'sea';
}
export const PROVINCE_LABEL_COLOR: Record<string, string> = { wasteland: 'rgba(95,95,95,0.95)', lake: 'rgba(40,95,160,0.95)' };

export interface OverlayState {
  // 河画在叠加层上（屏幕、导出的地图上河由渲染器合成，只画在陆地上：MapView 给 false，见 riverLayer）
  rivers: boolean;
  wind: boolean;
  // 画过的河与湖的标记（水模式）
  markers: boolean;
  season: 'annual' | 'summer' | 'winter';
  style: MapStyle;
  shapes: Shape[];
  provinceLabels: ProvinceLabel[];
  // 地名标注；labelTypes 为 null 时显示全部类型
  features: GeoFeature[] | null;
  labelTypes: Set<FeatureType> | null;
  // 地名显示中文、原文还是两者（第二十轮；省略为中文）
  nameMode?: NameMode;
  // 全部山峰（第二十一轮，图层里的“山峰”；见 peakLabels）：画成小三角，放大后标名字，排在别的地名之后；null 不画
  peaks?: GeoFeature[] | null;
  // 片区名（第二十三轮的国名；第二十五轮也是文化、文化组、每一维的取值的名字，键是 'region:…'）：沿片区的中线弯着写、字距拉开，
  // 最先排（别的地名让它）；null 不画
  countries?: CountryLabelDraw[] | null;
  // 城市、地标、自定义点（第二十四轮，见 settle-draw.ts）：图标与名字，排在国名之后、别的地名之前（重要的先排）；null 不画。
  // settleNames：写不写它们的名字（图层里的“地名”）。cellSize：一格多大（地图单位），按它在屏幕上的像素数决定画哪几级
  settlements?: SettleMark[] | null;
  settleNames?: boolean;
  cellSize?: number;
  // 道路（第二十四轮）：画在地名、工具的图形下面；小路放大后才画
  roads?: RoadDraw | null;
  kmPerUnit: number;
  // 鼠标悬停或选中的地名（高亮）
  hoverLabel: string | null;
  // 左下角的比例尺；底部条伸到左下角时往上抬多少（CSS 像素）
  scaleBar: boolean;
  cornerLift: number;
  // 纬度刻度：地图上下边的实际纬度（含挪动）；null 不画。整个星球画经纬网
  latitude: { north: number; south: number } | null;
  // 洋流流线（整个星球）
  currents?: boolean;
  // 镜头正在动（渲染器按低分辨率画的那几帧）：底层的河挪用缓存的那张、地名沿用排好的版面，停稳后按原样画
  motion?: boolean;
  // 渲染器移动中的场景重画到第几次了（Renderer.motionEpoch）：变了就在同一帧重画底层的河、重排地名
  motionEpoch?: number;
  // 导出图片：底层的河直接画（不贴缓存），与原来逐像素相同
  exact?: boolean;
  // 风、洋流的流线（第四十轮）：新露出来的块不在这一帧里算，空闲时一段段地算，算好了调它（MapView 给 requestDraw）；
  // 没给时（导出、测试）当场算
  lazy?: () => void;
  // 导出整张地图（.png）：画在一张离屏的大画布上，按这个虚拟窗口（cw × ch 个 CSS 像素，每个 CSS 像素 dpr 个像素）画，
  // 不清空画布（直接画在底图上）、不用也不动屏幕上的缓存；地名排整张图、不伸出图外，整个星球只排一份
  frame?: Frame;
}

export interface Frame {
  cw: number;
  ch: number;
  dpr: number;
}

// 画布的大小（CSS 像素）与每个 CSS 像素几个像素：导出时按给的虚拟窗口，否则按屏幕上的画布
export function frameOf(ctx: { canvas: { clientWidth: number; clientHeight: number } }, st?: { frame?: Frame }): Frame {
  if (st?.frame) return st.frame;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  return { cw: ctx.canvas.clientWidth, ch: ctx.canvas.clientHeight, dpr };
}

// 整个星球的平铺图：屏幕上看得见的副本（x 平移 2k）。河、画的河展开后可能伸出 [0, 2) 一点，所以多算一点
export function copiesFor(cam: Camera, cw: number): number[] {
  const halfW = cw / 2 / cam.zoom;
  const k0 = Math.ceil((cam.x - halfW - 2.6) / 2);
  const k1 = Math.floor((cam.x + halfW + 0.6) / 2);
  const out: number[] = [];
  for (let k = k0; k <= k1 && out.length < 7; k++) out.push(k);
  return out;
}

// 整个星球的格比同样格数的地区地图小：按格距把缩放换算成“相当于 4 万格地区地图的缩放”，
// 河宽、何时标省名和山峰都按它算（一块地区照旧用原来的缩放）
export function refZoom(world: World, zoom: number): number {
  return world.mesh.kind === 'sphere' ? (zoom * world.mesh.spacing) / 0.0076 : zoom;
}

// 一次绘制里实际画出来的地名的屏幕范围（CSS 像素），供点击命中
export interface LabelBox {
  key: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// 叠加层最底下的那一层（河、画的河道标记、湖标记）：只随画出来的世界、河的路径、镜头、选项变。
// 停稳时画进一张与叠加层一样大的离屏画布缓存着（画笔拖动、鼠标移动时不重描几万段河），先清空再画、
// 整张原样贴回，与直接画在叠加层上逐像素相同；移动中按 MOTION_LAYER_SCALE 的分辨率、四周多画 MOTION_LAYER_MARGIN，
// 镜头还在边距之内、缩放没变太多时把这一张挪一挪、缩一缩贴上，停下以后（停稳的那一帧）再按原样画
export const MOTION_LAYER_SCALE = 0.5;
// 与渲染器移动中的场景同样的边距、缩放（同一帧重建，见 motionEpoch）
export const MOTION_LAYER_MARGIN = 0.35;
export const MOTION_LAYER_ZOOM = 1.3;
export interface BackLayer {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  key: unknown[];
  cam: Camera;
  soft: boolean;
  // 缓存里已经画好（停稳的那一张第一次没变时才画）
  ready: boolean;
  // 画它时每个 CSS 像素几个像素（页面缩放变了、画布像素数没变时也要重画）
  dpr: number;
  // 移动中的那张：画它时渲染器的 motionEpoch
  epoch?: number;
}

// 开发用（src/render/bench.ts 的 overlayBench）：底层改用软件画的画布，测速时能同步量到画它花的时间
// noStatic：屏幕上什么都没变时也照原样直接画（测速、对照用）
export const overlayDebug: { softLayers: boolean; noStatic: boolean } = { softLayers: false, noStatic: false };

export function makeLayer(w: number, h: number, dpr: number): BackLayer {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', overlayDebug.softLayers ? { willReadFrequently: true } : undefined) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  return { canvas, ctx, key: [], cam: { x: 0, y: 0, zoom: 1 }, soft: overlayDebug.softLayers, ready: false, dpr };
}
// 测速（第三十九轮的 ?perf）：MapView 交过来；记 overlayStatic（静态的变了、直接画）、overlayDynamic（只有图形变了、直接画）、
// layout（排地名），notes 里记 overlay:skip / overlay:shapes / overlay:direct / overlay:motion
export let perf: Perf | null = null;
export function setOverlayPerf(p: Perf | null) {
  perf = p;
}
export const LABEL_STYLE: Record<'land' | 'water' | 'relief' | 'nature', { color: string; italic: boolean; spacing: number }> = {
  land: { color: '#1e2226', italic: false, spacing: 0 },
  water: { color: '#1f4f7a', italic: true, spacing: 0.15 },
  relief: { color: '#5a3b1e', italic: false, spacing: 0.35 },
  nature: { color: '#3d4f22', italic: true, spacing: 0.2 },
};

// 地名：按重要度从高到低放，和已放的重叠就跳过；字号随屏幕上的大小。
// 排版（逐字测宽、避让）按镜头缓存：鼠标移动时不重排，只重画
export interface PlacedLabel {
  key: string;
  chars: string[];
  widths: number[];
  spacing: number;
  total: number;
  font: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  // 国名：每个字自己的位置与方向（CSS 像素、弧度），沿弯的中线排；有它时不看 x、y、angle
  glyphs?: { x: number; y: number; a: number }[];
  // 描边的颜色、粗细（国名淡一些）
  halo?: string;
  haloWidth?: number;
  // 城市、地标、点的图标（第二十四轮）：画在 x、y（CSS 像素），没有字；markScale：缩得很小时小一些
  mark?: SettleMark;
  markScale?: number;
  // 投影时（第四十轮）：地名、图标的锚点（地图坐标）与排的时候它在屏幕上的位置；国名每个字落在地图上的点（转球的手势里按它重新投影）
  anchor?: Anchor;
  glyphAnchors?: ([number, number] | null)[];
}
// [地图 x, 地图 y, 排的时候屏幕 x, 屏幕 y]
export type Anchor = [number, number, number, number];
// 每个字的宽度按字体缓存：平移、缩放的每一帧不必再量（字体加载完成后清空重量）
export const glyphs = new Map<string, number>();
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => glyphs.clear());
export function glyphWidth(ctx: CanvasRenderingContext2D, font: string, c: string): number {
  const key = `${font}|${c}`;
  let w = glyphs.get(key);
  if (w === undefined) {
    w = ctx.measureText(c).width;
    glyphs.set(key, w);
  }
  return w;
}
