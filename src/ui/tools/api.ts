import type { TerrainPreview } from '../../../core/terrain';
import { arcUnits, wrapX } from '../../../core/geo';
import type { ProvinceSeam } from '../../../core/seams';
import { ringWinding } from '../../../core/select';
import type { ProvinceMeta, World } from '../../../core/world';
import type { DisplayCell } from '../../../core/display';
import type { GhostEdit, HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { busy, onlyEditsPending, showToast } from '../../state';

// 地图工具的约定：每个工具在动手前或动手时给出确切的预览（高亮的格、矢量图形、一句话），
// 松手后执行的命令与预览用同一份计算，所以结果与预览一致。这里是工具与地图之间的接口和几个工具都用的小工具

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

// 地图给工具的：缩放（按像素定大小的图形、像素容差按它算）、屏幕上这一点是哪个地名的字
export interface ToolEnv {
  zoom: () => number;
  hitLabel: (sx: number, sy: number) => string | null;
}

export const EMPTY: Preview = { layers: [], shapes: [], hint: null };

export type RGB = [number, number, number];
export const WHITE: RGB = [255, 255, 255];
// 做不了：涂红
export const BLOCKED_RGB: RGB = [230, 90, 70];

// 两点之间的距离（地图单位）：整个星球上是球面上的距离
export const mapDist = (w: World, ax: number, ay: number, bx: number, by: number) => (w.mesh.kind === 'sphere' ? arcUnits(ax, ay, bx, by) : Math.hypot(ax - bx, ay - by));
// 整个星球：存进命令的经度绕回 [0, 2)
export const keepX = (w: World, x: number) => (w.mesh.kind === 'sphere' ? wrapX(x) : x);
// 整个星球：圈绕着极点（在平铺图上圈不住任何地方）
export const aroundPole = (w: World, ring: [number, number][]) => w.mesh.kind === 'sphere' && ringWinding(ring) !== 0;

// 世界的编号：用来判断预览缓存是否过期
const worldIds = new WeakMap<World, number>();
let nextWorldId = 1;
export const worldId = (w: World) => {
  let id = worldIds.get(w);
  if (!id) worldIds.set(w, (id = nextWorldId++));
  return id;
};

// ---------- 正在计算时 ----------

// 正在计算时能不能动手（每个工具声明一种）：
// queue：只是在算前面的编辑时照样能用（排队，松手后按顺序执行，与一步一步等着做相同）；正在新建、打开、导出时（世界可能马上换掉）也要等。
// refuse：要按最新的世界算（河、剪刀、合并……）：前面的算完以前不动手
export type BusyRule = 'queue' | 'refuse';

// 正在计算时按下：说一声，不默默地忽略
let busyNoted = Number.NEGATIVE_INFINITY;
const busyNote = () => {
  if (performance.now() - busyNoted < 2000) return;
  busyNoted = performance.now();
  showToast('正在计算…');
};

// 现在不能动手：说一声，返回 true
export function guard(rule: BusyRule): boolean {
  const blocked = rule === 'queue' ? busy.value !== null && !onlyEditsPending() : busy.value !== null;
  if (blocked) busyNote();
  return blocked;
}

// 正在计算（要等前面的算完）：说一声，返回 true
export const isBusy = () => guard('refuse');
