import type { ToolId } from './ui/defs/tools';
import { signal } from '@preact/signals';
import { speciesOwner } from '../core/biome-scripts';
import type { ScriptIssue, ScriptKind } from '../core/script';
import { SPECIES_SCRIPT_KINDS } from '../core/species';
import type { RiverStyleOverride } from './render/overlay';
import { focusSpecies, sheet, world } from './state/world';

// 主线程状态：世界的只读视图（网格本地构建，原因与推导来自 Worker 的快照）+ 界面状态。
// 第七十轮起分在 state/ 下（见 docs/dev/src.md）；这里留着只给界面用的信号（下面的模块都用不到），并把 state/ 下给界面用的一起导出：
// 界面照旧从 './state' 引用（测试里 vi.mock 这个模块换掉 exec 等，所以界面不要绕过它直接引用 state/ 下的文件）

// 地图显示什么（着色方式）
export type ViewMode =
  | 'terrain'
  | 'dominant'
  | 'elevation'
  | 'temperature'
  // 海水温度（第十四轮）：只给海着色，陆地灰色
  | 'seaTemp'
  | 'precip'
  | 'moisture'
  | 'wetness'
  | 'continentality'
  | 'corrT'
  | 'corrP'
  | 'suitability'
  | 'provinces'
  | 'uplift'
  // 地形类别、资源（第二十一轮）：每格一种颜色，平涂在地貌上
  | 'terrainClass'
  | 'resource'
  // 人文（第二十二轮）：宜居度、人口密度（色带），文化圈（按文化、按文化组）与时代的每一维（dim:维度 id），平涂在地貌上
  | 'habitability'
  | 'popDensity'
  | 'culture'
  | 'cultureGroup'
  // 国家（第二十三轮）：国家的颜色平涂在地貌上（附庸用宗主的浅色），领海淡淡地涂
  | 'country'
  // 同盟（第二十六轮）：帝国、联邦、同盟各一种颜色，不在集团里的国家灰色
  | 'bloc'
  | `dim:${string}`
  | `field:${string}`;

export type Season = 'annual' | 'summer' | 'winter';

// 工具分九类，顶栏右边一类一个按钮（第二十二轮加了“文化”，第二十三轮加了“国家”，第二十四轮加了“城市”）；
// inspect（第二十五轮）只有指针，顶栏最左边单独一个按钮
export type Category = 'inspect' | 'terrain' | 'climate' | 'nature' | 'water' | 'provinces' | 'names' | 'culture' | 'countries' | 'settlements';

// 工具的 id：由 ui/defs/tools/ 的工具表推出来
export type { ToolId };

export const tool = signal<ToolId>('land');
// 换工具：defs/tools/index.ts 的 setTool 登记进来（换工具时要清掉的东西都在那里）。面板、工具里换工具都走它，不直接写 tool
let toolSwitch = (id: ToolId) => {
  tool.value = id;
};
export const switchTool = (id: ToolId) => toolSwitch(id);
export function registerToolSwitch(f: (id: ToolId) => void) {
  toolSwitch = f;
}
export const mode = signal<ViewMode>('terrain');
export const season = signal<Season>('annual');
// 风的流线按哪一季画（第四十八轮）：与 season 分开——season 管地貌的雪、气温降水的底图，这一个只管风，换它不重算底图（只在这次打开的页面里记着）
export const flowSeason = signal<Season>('annual');
// peaks（第二十一轮）：全部山峰画成小三角，放大后标名字
// roads、cities、landmarks（第二十四轮）：道路两种图都画；城市在人文图里画；地标在人文图里全画、地理图里只画自然的（自定义点两种图都画）
// wind、currents（第四十八轮）：风向、洋流两个独立的开关，任何地图模式上都能叠加；关着时一块不算、一笔不画（见 render/wind-layer.ts）
export const overlays = signal({ rivers: true, borders: true, labels: true, scale: true, latitude: false, edits: false, peaks: false, roads: true, cities: true, landmarks: true, wind: false, currents: false });
export const hoverCell = signal<number>(-1);
// 鼠标下画出来的省按哪一格算（扭曲后的格、剪刀切线旁按显示的那一边，见 core/display.ts）：“这里”的省份一行用它。
// 与 hoverCell 一起设
export const hoverProvinceCell = signal<number>(-1);
// 地图上鼠标旁的说明（工具预览的一句话）。warn：做不了；caution：做得了，但要留意（比如合并后是一省两块）
export const cursorHint = signal<{ x: number; y: number; text: string; warn?: boolean; caution?: boolean } | null>(null);

// 顶栏按钮弹出的面板：同一时间只开一个。world：世界（新建、保存、打开、导出）；more：更多（历史、偏好、上手说明）
// river / province：选中的河、省底部条上的“⋯”（不常用的按钮收在里面）
// 选“哪一种”（同一个 TypePicker，见 App.tsx 的 TYPE_PANELS）：rivertype / laketype 选中的这条河、这个湖，
// newrivertype / newlaketype 新画的河、新放的湖，islandtype / chaintype 放岛、画岛链用哪一种岛
// classpick / resourcepick（第二十一轮）：画地形类别、资源用哪一种
// culturepick / poppick / valuepick（第二十二轮）：文化笔刷的文化、人口笔刷“改成分”的群体、“改一个维度”的取值
// countrypick（第二十三轮）：领土笔刷涂给哪个国家
// cityrank / landmarkpick / pointpick（第二十四轮）：选中的城市的等级、放地标、放自定义点用哪一种
export type TypePanelId =
  | 'rivertype'
  | 'newrivertype'
  | 'laketype'
  | 'newlaketype'
  | 'islandtype'
  | 'chaintype'
  | 'featurestyle'
  | 'classpick'
  | 'resourcepick'
  | 'culturepick'
  | 'poppick'
  | 'valuepick'
  | 'countrypick'
  | 'cityrank'
  | 'landmarkpick'
  | 'pointpick';
export type PanelId = 'world' | 'more' | 'adjust' | 'layers' | 'river' | 'province' | TypePanelId | `cat:${Category}`;
export const openPanel = signal<PanelId | null>(null);
export function togglePanel(id: PanelId) {
  openPanel.value = openPanel.value === id ? null : id;
}
// Tab：隐藏全部界面，只看地图
export const uiHidden = signal(false);
// 正在拖底部条上的滑块：地图在鼠标最后停的地方显示预览
export const sliderActive = signal(false);
// 工具的异步预览算好了：地图重画一次
export const redrawTick = signal(0);
// 拖一条画的河的“粗细”时地图上先这样画（不等 worker）；null 照存下的画
export const riverStyleOverride = signal<RiverStyleOverride | null>(null);

export const wizardOpen = signal(false);
export const helpOpen = signal(false);
// 底部条伸到左下角时，比例尺和尺子按钮要往上抬多少（CSS 像素；MapView 每次重画时按底部条的位置算）
export const cornerLift = signal(0);
// 地名：选中的地名（键）
export const selectedFeature = signal<string | null>(null);
// 刚圈好、刚放下的地名：底部条的名字框收到后获得焦点（选中全部文字，直接打字就是改名）
export const focusName = signal<string | null>(null);
// 第二十七轮：⇧+点多选的省份（两个以上时底部条换成合并、划给某国、重新划分）
export const provinceSet = signal<number[]>([]);
// 第二十七轮：底部条第二行的吸管（下一次点地图是吸取，吸完回到原来的笔刷）与橡皮擦（auto 恢复自动、clear 清空，null 不擦）。
// 换工具时都关上
export const picking = signal(false);
export const erasing = signal<'auto' | 'clear' | null>(null);
// 显示哪些地名：按大类
// provinces、seaProvinces（第十三轮修）：省名、海域的省名，默认不显示；打开后屏幕上一直标着、导出的图里也有
export type LabelGroup = 'land' | 'water' | 'relief' | 'nature' | 'provinces' | 'seaProvinces';
export const labelGroups = signal<Set<LabelGroup>>(new Set(['land', 'water', 'relief', 'nature']));

// 脚本出错的提示条：用户关掉的是哪一组问题（同一组不再出现，换了才出现）
export const dismissedIssues = signal('');

// 出错的脚本的“编辑”：脚本编辑器把自己的打开方法放在 open 上（ui/connect.ts 接上：打开生态抽屉、展开“高级”、
// 光标放进那个脚本框）；没有时打开生态抽屉、选中这种生态
export type SpeciesScriptKind = (typeof SPECIES_SCRIPT_KINDS)[number];
export const scriptEditor: { open: ((species: string, kind: SpeciesScriptKind) => void) | null } = { open: null };
const isSpeciesKind = (k: ScriptKind): k is SpeciesScriptKind => (SPECIES_SCRIPT_KINDS as readonly ScriptKind[]).includes(k);
// 出错的是哪种生态的哪一段（生态的两种脚本；星球形态的布局、地形脚本没有编辑的地方）。先按 id，旧的说明没有 id 时按名字
function scriptOfIssue(issue: ScriptIssue): { id: string; kind: SpeciesScriptKind } | undefined {
  const kind = issue.kind;
  if (!isSpeciesKind(kind)) return undefined;
  const sp = world.value?.small.species.find((s) => (issue.id !== undefined ? s.id === issue.id : speciesOwner(s) === issue.owner));
  return sp && { id: sp.id, kind };
}
// 河流、湖泊类型的 match 脚本（第三批、第九轮）：出错时“编辑”打开“水系 ⋯”里“水体类型”这一种的编辑（见 ui/panels/waterTypes.tsx）。
// “新建类型…”之后也用它打开新的那一种
export const waterTypeEditorRequest = signal<{ kind: 'river' | 'lake'; id: string } | null>(null);
function waterTypeOfIssue(issue: ScriptIssue): { kind: 'river' | 'lake'; id: string } | undefined {
  if (issue.kind !== 'match' || issue.id === undefined) return undefined;
  const small = world.value?.small;
  const river = small?.riverTypes?.find((t) => t.id === issue.id);
  const lake = small?.lakeTypes?.find((t) => t.id === issue.id);
  // 河、湖的类型 id 相同时按名字分
  if (lake && (!river || (lake.name === issue.owner && river.name !== issue.owner))) return { kind: 'lake', id: lake.id };
  return river ? { kind: 'river', id: river.id } : undefined;
}
// 打开“水系 ⋯”里这一种的编辑
export function openWaterTypeEditor(kind: 'river' | 'lake', id: string) {
  if (tool.value !== 'river' && tool.value !== 'lake' && tool.value !== 'unwater') switchTool(kind === 'lake' ? 'lake' : 'river');
  waterTypeEditorRequest.value = { kind, id };
  openPanel.value = 'cat:water';
}
// 有没有地方可以打开它（没有时提示条上不放“编辑”）
export function canEditScript(issue: ScriptIssue): boolean {
  return scriptOfIssue(issue) !== undefined || waterTypeOfIssue(issue) !== undefined;
}
export function editScript(issue: ScriptIssue) {
  const wt = waterTypeOfIssue(issue);
  if (wt) {
    openWaterTypeEditor(wt.kind, wt.id);
    return;
  }
  const at = scriptOfIssue(issue);
  if (!at) return;
  if (scriptEditor.open) {
    scriptEditor.open(at.id, at.kind);
    return;
  }
  focusSpecies.value = at.id;
  sheet.value = 'species';
}

// ---------- state/ 下的（第七十轮从这个文件分出去，照旧从这里导出） ----------
export {
  type LakeRef,
  type RiverRef,
  type SettleRef,
  adjustPreview,
  adjustPreviewNote,
  adjustPreviewWorld,
  canRedo,
  canUndo,
  focusSpecies,
  hereOpen,
  history,
  hoverRiver,
  measure,
  pinCell,
  pinnedCell,
  pinnedPart,
  regenTrack,
  selectedBloc,
  selectedCountry,
  selectedLake,
  selectedProvince,
  selectedRiver,
  selectedSettle,
  setSpeciesVisualOverride,
  settleExists,
  sheet,
  visualOverrides,
  world,
  worldEpoch,
  worldState,
} from './state/world';
export { FLASH_MS, type NoteAction, changeNote, describeChange, flash, flashCells, holdNote, noteAction, noteSkipped, showToast, skippedNote, toast } from './state/notes';
export { type MapKind, type Prefs, type ProjectionPref, type Reference, type WheelPref, loadReference, nameMode, parseMapKind, parsePrefs, prefs, reference, setNameMode, setPrefs, setReference } from './state/prefs';
export { type ToolOptions, brushRange, lakeRange, mapKm, options, reachRange, setOptions } from './state/options';
export { busy, editsIdle, formThumbnail, getDoc, knowIsolation, onlyEditsPending, safeMode, scriptRunning, scriptsIsolated, stopScripts, thumbnail, whenEditsIdle } from './state/worker-host';
export { type Ask, type AskChoice, ask, askText, askUser } from './state/ask';
export { confirmImport, showScripts, trustFormScripts, trustHandledElsewhere } from './state/script-trust';
export { type OpenOptions, loadDoc, newWorld, resumeLast, retryScripts } from './state/open';
export { exec, paintNote, redo, replaceLast, undo } from './state/edits';
export { noteCost, slowHint, slowPreview } from './state/cost-gate';
export {
  type WorldPreview,
  cancelPreviews,
  cancelWorldPreview,
  commitTerrain,
  exactDelay,
  execAdjust,
  previewAdjust,
  previewCommand,
  previewProvinces,
  previewReply,
  previewTerrain,
  previewTerrainOnce,
  previewWorld,
  worldPreviewError,
} from './state/exact-preview';
export { cancelExport, download, exportPartFiles, exportProgress, exportZip, imageExportCancel } from './state/export-host';
export { compactForSave, keepRemoved, planTidy, worldName } from './state/tidy';
export { type Autosaved, autosaveNow, autosaved, noteThumb } from './state/autosave';
