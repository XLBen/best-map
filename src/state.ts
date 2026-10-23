import { batch, signal } from '@preact/signals';
import { speciesOwner } from '../core/biome-scripts';
import type { Command } from '../core/commands';
import { checkDoc, isCurrentDoc } from '../core/doc-version';
import type { PreviewResult, ProvincesPreview, Timings, WorldDoc } from '../core/engine';
import type { ExportOptions } from '../core/export';
import type { WorldgenInput } from '../core/generate';
import type { Mesh } from '../core/mesh';
import { type PackedMesh, storedMeshKey, unpackMesh } from '../core/mesh-pack';
import { previewWorldOf } from '../core/preview-world';
import { type FoundScript, type ScriptIssue, type ScriptKind, findScripts } from '../core/script';
import { isRiverCell } from '../core/select';
import { SPECIES_SCRIPT_KINDS, type Visual } from '../core/species';
import { viewOf } from '../core/sphere';
import { type ChainKind, type IslandKind, type TerrainPatch, type TerrainPreview, brushRangeKm, defaultIslandKm, lakeRangeKm, mapScaleKm, reachRangeKm, roundKm } from '../core/terrain';
import { type Settings, type World, buildMeshFor, kmPerUnit, meshKey, settingsSchema } from '../core/world';
import { CheckpointStore, type StorageWorkerLike } from './checkpoint-store';
import { buildKey, engineCode, engineUrl } from './engine-source';
import { EngineWorker, type RawWorker, type SpawnMemory } from './engine-spawn';
import type { MeshRequest } from './mesh-worker';
import type { RiverStyleOverride } from './render/overlay';
import { idbTx, openDb } from './idb';
import { THUMB_EVERY_MS, activeLink, idbMapStore, isQuotaError, mapLink, mapSavedState, overwriteMap, thumbHook } from './maps';
import type { ExportJob, ExportReply, LightSnapshot, Request, Response, Snapshot } from './protocol';
import type { HighlightLayer } from './render/colors';
import { CANCELLED, EngineHost, type WorkerLike } from './sandbox';
import { clearLoading, markLoading, readLoading, tidyTrusted, trustScripts, uniqueScripts, untrustedScripts } from './trust';

// 主线程状态：世界的只读视图（网格本地构建，原因与推导来自 Worker 的快照）+ 界面状态

// 地图显示什么（着色方式）
export type ViewMode =
  | 'terrain'
  | 'dominant'
  | 'elevation'
  | 'temperature'
  | 'precip'
  | 'moisture'
  | 'wetness'
  | 'continentality'
  | 'corrT'
  | 'corrP'
  | 'suitability'
  | 'provinces'
  | 'uplift'
  | `field:${string}`;

export type Season = 'annual' | 'summer' | 'winter';

// 工具分六类，顶栏右边一类一个按钮
export type Category = 'terrain' | 'climate' | 'nature' | 'water' | 'provinces' | 'names';

export type ToolId =
  | 'land'
  | 'island'
  | 'chain'
  | 'relief'
  | 'reroll'
  | 'restore'
  // 气候：冷暖、干湿、擦掉冷暖干湿的改动、涂自定义场（有自定义场时才出现）
  | 'temp'
  | 'moist'
  | 'unclimate'
  | 'field'
  | 'biome'
  | 'grow'
  | 'endemic'
  | 'erase'
  | 'river'
  | 'lake'
  | 'unwater'
  | 'pselect'
  | 'pbrush'
  | 'pcut'
  | 'pmerge'
  | 'pregen'
  // 地名：改名、圈一块起名、放一个点状地名
  | 'rename'
  | 'area'
  | 'spot';

export const world = signal<World | null>(null);
// 新建或打开世界时加一：地图据此看全图（同样大小的世界共用网格，不能只看网格变没变）
export const worldEpoch = signal(0);
export const history = signal<{ summary: string; done: boolean }[]>([]);
export const canUndo = signal(false);
export const canRedo = signal(false);
const timings = signal<Timings>({ total: 0 });
// 正在算的带提示的请求（执行、撤销、新建、打开…）的提示；后台的预览、自动保存不算
export const busy = signal<string | null>(null);
export const toast = signal<{ text: string; error: boolean } | null>(null);

export const tool = signal<ToolId>('land');
export const mode = signal<ViewMode>('terrain');
export const season = signal<Season>('annual');
export const mapStyle = signal<'realistic' | 'atlas'>('realistic');
export const overlays = signal({ rivers: true, borders: true, wind: false, currents: false, labels: true, scale: true, latitude: false, edits: false });
export const hoverCell = signal<number>(-1);
// 鼠标下画出来的省按哪一格算（扭曲后的格、剪刀切线旁按显示的那一边，见 core/display.ts）：“这里”的省份一行用它。
// 与 hoverCell 一起设
export const hoverProvinceCell = signal<number>(-1);
// 地图上鼠标旁的说明（工具预览的一句话）。warn：做不了；caution：做得了，但要留意（比如合并后是一省两块）
export const cursorHint = signal<{ x: number; y: number; text: string; warn?: boolean; caution?: boolean } | null>(null);
export const focusSpecies = signal<string | null>(null);

// 拖生态的花纹、发光滑块时：地图在主线程上立即按这份外观画（只影响画法，不改世界，不进历史）。按生态 id 记。
// 用法：拖动时 setSpeciesVisualOverride(id, 外观)；松手提交（update_species），等 exec 返回（不论成没成，结果已换上），
// 覆盖的还是提交的那一份（visualOverrides.value.get(id) === 它，没有又拖到别的值）时再给 null 去掉，这样中间不会闪回旧的样子。
// 新建、打开世界时全部去掉；结果换上时，世界里已经没有这种生态的、存着的外观已经与覆盖的一样的也去掉（见 pruneVisualOverrides），
// 编辑面板忘了去掉时地图也不会一直画着世界里没有的样子
export const visualOverrides = signal<ReadonlyMap<string, Visual>>(new Map());
export function setSpeciesVisualOverride(id: string, visual: Visual | null) {
  const cur = visualOverrides.value;
  if (!visual && !cur.has(id)) return;
  const next = new Map(cur);
  if (visual) next.set(id, visual);
  else next.delete(id);
  visualOverrides.value = next;
}

// 两份外观逐项相同（不看键的先后：存进世界的那份经过校验，键的顺序可能与编辑面板给的不同）
const VISUAL_KEYS = ['pattern', 'color2', 'amount', 'size', 'glow', 'glowColor'] as const;
const visualValue = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
const sameVisual = (a: Visual | undefined, b: Visual) => !!a && VISUAL_KEYS.every((k) => visualValue(a[k]) === visualValue(b[k]));

// 结果换上时去掉用不着的覆盖：那种生态已经没有了（撤销、删掉），或者世界里存着的外观就是覆盖的这一份（松手提交的结果到了）。
// 去掉后画出来的与去掉前一样，不会闪
function pruneVisualOverrides(species: readonly { id: string; visual?: Visual }[]) {
  const cur = visualOverrides.value;
  if (!cur.size) return;
  const byId = new Map(species.map((sp) => [sp.id, sp]));
  let next: Map<string, Visual> | null = null;
  for (const [id, v] of cur) {
    const sp = byId.get(id);
    if (sp && !sameVisual(sp.visual, v)) continue;
    next ??= new Map(cur);
    next.delete(id);
  }
  if (next) visualOverrides.value = next;
}

// 顶栏按钮弹出的面板：同一时间只开一个。river：选中的河底部条上的“⋯”
// rivertype：给新画的河、选中的河选是哪一种河（第三批的河流类型）
// rivertype / laketype：选中的这条河、这个湖是哪一种；newrivertype / newlaketype：新画的河、新放的湖是哪一种
export type PanelId = 'world' | 'actions' | 'adjust' | 'layers' | 'biome' | 'river' | 'rivertype' | 'newrivertype' | 'laketype' | 'newlaketype' | `cat:${Category}`;
export const openPanel = signal<PanelId | null>(null);
export function togglePanel(id: PanelId) {
  openPanel.value = openPanel.value === id ? null : id;
}
// 右边的抽屉：生态类型编辑要一边看地图一边调，所以不随点地图关上
export const sheet = signal<'species' | null>(null);
// Tab：隐藏全部界面，只看地图
export const uiHidden = signal(false);
// 正在拖底部条上的滑块：地图在鼠标最后停的地方显示预览
export const sliderActive = signal(false);
// 工具的异步预览算好了：地图重画一次
export const redrawTick = signal(0);
// 拖一条画的河的“粗细”时地图上先这样画（不等 worker）；null 照存下的画
export const riverStyleOverride = signal<RiverStyleOverride | null>(null);
// “调整”面板拖滑块时的预览（会变成陆地 / 海的格、山会变高变矮的格、每格将来的海岸值：地图上画出将来的海岸线）
export const adjustPreview = signal<TerrainPreview | null>(null);

export const wizardOpen = signal(false);
export const helpOpen = signal(false);
// “调整”面板拖气候、河流的滑块，生态编辑器拖色块时：停下后算出的将来的世界，地图直接画它。
// key：预览的是哪条命令（JSON）；base：按哪个世界算的（世界换了就不再显示）；
// layers：同时要高亮的格（资源包“用到这个世界”：会变的格描边、新生态的格淡淡涂上）
export const adjustPreviewWorld = signal<{ key: string; base: World; world: World; layers?: HighlightLayer[] } | null>(null);
// 正在拖的那一行下面的小字：正在算预览 / 地图上是松手后的样子 / 松手后约 N 秒出结果
export const adjustPreviewNote = signal<{ key: string; text: string } | null>(null);
// 当前世界的状态编号（Worker 每改一次换一个）：预览只在按这个状态算出来时才显示，过期的丢掉
export const worldState = signal(0);
// 底部条伸到左下角时，比例尺和尺子按钮要往上抬多少（CSS 像素；MapView 每次重画时按底部条的位置算）
export const cornerLift = signal(0);
// 量距离：已经点的点（地图单位）；null 表示没在量
export const measure = signal<[number, number][] | null>(null);
// 地名：选中的地名（键）
export const selectedFeature = signal<string | null>(null);
// 刚圈好、刚放下的地名：底部条的名字框收到后获得焦点（选中全部文字，直接打字就是改名）
export const focusName = signal<string | null>(null);
// 省份：选中的省份
export const selectedProvince = signal<number | null>(null);
// 河：一条画的河（河道 id），或一条自然的河（河上的一格）
export type RiverRef = { kind: 'guide'; id: string } | { kind: 'natural'; cell: number };
// 画河时点中的河（底部条换成这条河的设置）；河流列表里鼠标停着的那条（地图上亮一下，什么工具都一样）
export const selectedRiver = signal<RiverRef | null>(null);
export const hoverRiver = signal<RiverRef | null>(null);
// 湖（第九轮）：一个放的湖（id），或一个自然的湖（湖里的一格）。放湖时点中的湖（底部条换成这个湖的设置）
export type LakeRef = { kind: 'placed'; id: string } | { kind: 'natural'; cell: number };
export const selectedLake = signal<LakeRef | null>(null);
// 显示哪些地名：按大类
export type LabelGroup = 'land' | 'water' | 'relief' | 'nature';
export const labelGroups = signal<Set<LabelGroup>>(new Set(['land', 'water', 'relief', 'nature']));

// 编辑后的变化：一句话汇总（带撤销、“换一个”）与几秒钟的高亮
// action：提示条上的另一个按钮（比如新建了特有生态后的“编辑”）
export type NoteAction = { label: string; run: () => void };
export const changeNote = signal<{ id: number; head: string; detail: string; undoable: boolean; again?: NoteAction; action?: NoteAction } | null>(null);
export const flash = signal<{ cells: number[]; at: number } | null>(null);
// 改完后变化的格淡淡地亮一下，这么久（毫秒）淡完
export const FLASH_MS = 1200;

// 偏好（存在本浏览器里）：滚轮 / 双指滑动是缩放还是平移
export type WheelPref = 'auto' | 'zoom' | 'pan';
const PREFS_KEY = 'map2.prefs';
function readPrefs(): { wheel: WheelPref } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    const p = raw ? (JSON.parse(raw) as { wheel?: WheelPref }) : {};
    return { wheel: p.wheel === 'zoom' || p.wheel === 'pan' ? p.wheel : 'auto' };
  } catch {
    return { wheel: 'auto' };
  }
}
export const prefs = signal(readPrefs());
export function setPrefs(patch: Partial<{ wheel: WheelPref }>) {
  prefs.value = { ...prefs.value, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs.value));
  } catch {
    // 存不了就只在这次打开时有效
  }
}

// 参考图（手绘草图）：铺在地图上照着画。只存在这个浏览器里（IndexedDB，不占自动保存的空间），不写进世界文件
export interface Reference {
  url: string;
  blob: Blob;
  // 浓淡：0.1 很淡，1 不透明
  opacity: number;
  // contain：保持比例放在地图中间；stretch：拉伸铺满整张地图
  fit: 'contain' | 'stretch';
  visible: boolean;
}
export const reference = signal<Reference | null>(null);

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => {
          resolve(req.result as T);
          db.close();
        };
        req.onerror = () => {
          reject(req.error);
          db.close();
        };
      }),
  );
}


type StoredReference = Omit<Reference, 'url'>;

export async function loadReference() {
  try {
    const r = await idb<StoredReference | undefined>('readonly', (s) => s.get('reference'));
    if (r?.blob) reference.value = { ...r, url: URL.createObjectURL(r.blob) };
  } catch {
    // 读不了就当没有
  }
}

// 换参考图或改设置；persist 为 false 时只改这次打开（拖浓淡时不必每一下都存）。存不下返回 false
export async function setReference(r: Reference | null, persist = true): Promise<boolean> {
  const old = reference.value;
  if (old && old.url !== r?.url) URL.revokeObjectURL(old.url);
  reference.value = r;
  if (!persist) return true;
  try {
    if (r) await idb('readwrite', (s) => s.put({ blob: r.blob, opacity: r.opacity, fit: r.fit, visible: r.visible } satisfies StoredReference, 'reference'));
    else await idb('readwrite', (s) => s.delete('reference'));
    return true;
  } catch {
    return false;
  }
}

export interface ToolOptions {
  // 画笔半径（km），所有画笔共用
  brushKm: number;
  landMode: 'land' | 'sea';
  // 画陆地：用画笔涂，还是圈一片
  landShape: 'brush' | 'lasso';
  reliefMode: 'up' | 'down';
  // 堆山的力度（抬升量）
  reliefAmount: number;
  islandKind: IslandKind;
  // 岛的海岸线半径（km）
  islandKm: number;
  islandVariant: number;
  // 岛链有自己的种类和大小（没有小礁），放岛时选小礁不影响岛链
  chainKind: ChainKind;
  chainKm: number;
  chainDensity: number;
  chainVariant: number;
  biome: string | null;
  biomeMode: 'natural' | 'force';
  // 自然融入时周围跟着变的范围（km）
  reachKm: number;
  tempMode: 'cold' | 'warm';
  moistMode: 'wet' | 'dry';
  // 冷暖干湿的力度：1 相当于升降 4 °C、雨水多少约四成
  climateAmount: number;
  // 湖的半径（km）
  lakeKm: number;
  // 画的河有多大：一路加进来的水合计为“河流多少”门槛的几倍
  riverFlow: number;
  // 画河：顺地势（点源头，河自己找路），还是自定义走向（按住画出河道，河照着走）
  riverMode: 'flow' | 'course';
  // 自定义走向画到的终点还在陆地上时：顺着地势接着流，还是在那里消失
  riverEnd: 'flow' | 'sink';
  // 新画的河是哪一种（河流类型的 id；'' 按各类型的规则判断；'plain' 普通的河）
  riverType: string;
  // 新放的湖是哪一种（同上，湖泊类型）
  lakeType: string;
  // 正在涂的自定义场
  field: string | null;
  fieldMode: 'add' | 'sub';
  fieldAmount: number;
}

export const options = signal<ToolOptions>({
  brushKm: 200,
  landMode: 'land',
  landShape: 'brush',
  reliefMode: 'up',
  reliefAmount: 0.7,
  islandKind: 'volcanic',
  islandKm: 100,
  islandVariant: 0,
  chainKind: 'volcanic',
  chainKm: 100,
  chainDensity: 1,
  chainVariant: 0,
  biome: null,
  biomeMode: 'natural',
  reachKm: 400,
  tempMode: 'cold',
  moistMode: 'wet',
  climateAmount: 1,
  lakeKm: 40,
  riverFlow: 4,
  riverMode: 'flow',
  riverEnd: 'flow',
  riverType: '',
  lakeType: '',
  field: null,
  fieldMode: 'add',
  fieldAmount: 0.25,
});

export function setOptions(patch: Partial<ToolOptions>) {
  options.value = { ...options.value, ...patch };
}

// 地图的尺度（km），画笔、湖、过渡的半径范围：放在 core 里（测试拿它们对照 schema），这里沿用原来的名字
export { mapScaleKm as mapKm, brushRangeKm as brushRange, lakeRangeKm as lakeRange, reachRangeKm as reachRange };

// 新世界：大小类的选项跟着地图尺度走
function sizesFor(w: World): Partial<ToolOptions> {
  const { width, cell } = mapScaleKm(w);
  const clampTo = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
  return {
    brushKm: roundKm(clampTo(width * 0.035, brushRangeKm(w))),
    islandKm: roundKm(defaultIslandKm(w) * 2) / 2,
    chainKm: roundKm(defaultIslandKm(w) * 2) / 2,
    lakeKm: roundKm(clampTo(Math.max(cell * 1.6, width * 0.006) * 2, lakeRangeKm(w)) * 2) / 2,
    reachKm: roundKm(clampTo(width * 0.04, reachRangeKm(w))),
  };
}

// ---------- 与 Worker 通信 ----------
// Worker 由 sandbox.ts 的 EngineHost 看着：脚本卡住、“停下”、Worker 崩了时停掉它，用主线程的命令记录另开一个恢复世界

// 正在运行谁的脚本（一段脚本算了 1.5 秒以上）：顶部提示“正在运行「X」的脚本…”，带“停下”
export const scriptRunning = signal<string | null>(null);
// 安全模式：这个世界里的脚本没有运行。reason 是横幅括号里的原因
export const safeMode = signal<{ reason: string } | null>(null);
// 脚本是不是在隔离的环境里跑：计算 Worker 是从 data: 地址开的，而且它自查的三项（来源为 null、IndexedDB 打不开、
// fetch('data:…') 被拒）全部通过（见 engine-spawn.ts、isolation-probe.ts）。没隔离时信任的问话里老实说
export const scriptsIsolated = signal(false);

let host: EngineHost | null = null;
let nextId = 1;
// edit：改动世界的请求（执行、撤销、重做、换一个）；画笔可以在它们后面排队
const pending = new Map<number, { edit: boolean; kind: Request['kind'] }>();
const EDITS = new Set<Request['kind']>(['exec', 'undo', 'redo', 'replaceLast']);
// 正在恢复世界（另开的 Worker 在打开命令记录里的世界）
let recovering = false;
const RECOVERING = '正在恢复世界…';

// 正在算的只有编辑（或不改世界的后台请求）：这时画的笔画可以排在后面，按顺序执行。
// busy 不为空且这里是 false：在算的是新建、打开世界（或者在恢复世界），工具要等它算完
export function onlyEditsPending(): boolean {
  if (recovering) return false;
  for (const p of pending.values()) if (!p.edit) return false;
  return true;
}

// 还没算完的编辑（执行、撤销、重做）有几步：排队时“换个形状”要等它们算完。
// 换一个本身不算：连点两下“换个形状”，第二下换掉的还是同一步
function editsInFlight(): number {
  let k = 0;
  for (const p of pending.values()) if (EDITS.has(p.kind) && p.kind !== 'replaceLast') k++;
  return k;
}

// 改动世界的请求（执行、撤销、重做、换一个，还有新建、打开）都算完了：这时 world、worldState 就是引擎里的样子。
// 脚本框要据此决定“换掉最后一步”还是“新的一步”（还有别人的改动在排队时换掉的会是别人的那一步）；
// 正在打开别的世界时也要等：不然排在打开后面的提交会落到新世界里同名的生态上
const WORLD_CHANGES = new Set<Request['kind']>([...EDITS, 'init', 'load']);
export function editsIdle(): boolean {
  for (const p of pending.values()) if (WORLD_CHANGES.has(p.kind)) return false;
  return true;
}
const idleWaiters: (() => void)[] = [];
// 等到 editsIdle()（回复到达、快照换上之后才算完）
export function whenEditsIdle(): Promise<void> {
  if (editsIdle()) return Promise.resolve();
  return new Promise<void>((r) => idleWaiters.push(r));
}
let meshCache: { key: string; mesh: Mesh } | null = null;

// 隔离的结果知道了没有（第一个计算 Worker 打过招呼，或者退回了普通 Worker）；等着它的
let isolationKnown = false;
const isolationWaiters: (() => void)[] = [];
function isolationResult(on: boolean) {
  scriptsIsolated.value = on;
  isolationKnown = true;
  for (const w of isolationWaiters.splice(0)) w();
}

// 开计算 Worker：页面里先试隔离的（data: 地址），不行再用普通的；测试里（没有页面）直接用普通的
const spawnMemory: SpawnMemory = {};
function spawnEngine(): WorkerLike {
  const create = (url: string, opts: WorkerOptions) => new Worker(url, opts) as unknown as RawWorker;
  if (typeof document === 'undefined') return create(engineUrl, { type: 'module' });
  let me: EngineWorker | null = null;
  me = new EngineWorker({
    code: engineCode,
    url: engineUrl,
    create,
    memory: spawnMemory,
    // 只听当前这个 Worker 的（停掉的旧 Worker 不会再说话，这里再挡一下）
    isolated: (on) => {
      if (host?.isCurrent(me) ?? true) isolationResult(on);
    },
  });
  return me;
}

// 检查点的版本号（见 engine-source.ts 的 buildKey）：新建、打开之前取好放在这里，随新建、打开告诉计算 Worker。
// 没有时（取不到引擎文件、测试里）不读不写检查点
const hostOpts: { build: string | null } = { build: null };

// 检查点存取：只做存储、不运行脚本的同源 Worker，第一次用到时才开
let store: CheckpointStore | null = null;
function checkpointStore(): CheckpointStore | null {
  if (!hostOpts.build || typeof Worker === 'undefined' || typeof MessageChannel === 'undefined') return null;
  store ??= new CheckpointStore(() => new Worker(new URL('./storage-worker.ts', import.meta.url), { type: 'module' }) as unknown as StorageWorkerLike);
  return store;
}

// 打开的世界的网格存在浏览器里时的键（设置无效时为 null）
function meshKeyOf(build: string, settings: Partial<Settings>): string | null {
  try {
    return storedMeshKey(build, settingsSchema.parse(settings));
  } catch {
    return null;
  }
}

function engineHost(): EngineHost {
  if (host) return host;
  host = new EngineHost(
    spawnEngine,
    {
      slow: (label) => (scriptRunning.value = label),
      reset: engineReset,
      restored: engineRestored,
      failed: engineFailed,
      abandoned: recovered,
    },
    undefined,
    {
      get build() {
        return hostOpts.build;
      },
      storeChannel: (build, doc) => checkpointStore()?.open(build, doc, doc ? meshKeyOf(build, doc.settings) : null) ?? null,
      commit: (token, epoch, ids) => checkpointStore()?.commit(token, epoch, ids),
    },
  );
  return host;
}

// 问要不要信任脚本之前：先知道脚本能不能隔离运行（问话里怎么说）。还没有计算 Worker 时先开一个；
// 最多等 ms 毫秒（等不到就按没隔离说，结果来了问话跟着改）。测试里（没有页面）不等
export function knowIsolation(ms = 3000): Promise<void> {
  if (isolationKnown || typeof document === 'undefined') return Promise.resolve();
  engineHost().warm();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    isolationWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// 还没回来的带提示的请求（执行、撤销、新建、打开…）有几个：busy 只看它们。
// 后台的预览、缩略图、自动保存不改世界，还在算的时候也不挡工具
let labelled = 0;

// safeReason：安全模式打开的原因（新建、打开时）。
// after：回复到了之后还要等的处理（新建、打开时等网格、换上快照）：它做完之前这个请求照样算在 pending、busy 里，
// 等着 whenEditsIdle 的也不叫醒（不然画笔、排着的编辑、自动保存会在新引擎上动手，而界面上还是旧世界）
function call(req: Request, label: string | null, safeReason?: string, after?: (r: Response) => Promise<unknown>): Promise<Response> {
  const id = nextId++;
  if (label) {
    labelled++;
    busy.value = label;
  }
  return new Promise<Response>((resolve) => {
    // 不带提示的请求（预览、自动保存）不改世界，不挡排队
    pending.set(id, { edit: EDITS.has(req.kind) || !label, kind: req.kind });
    const finish = (r: Response) => {
      pending.delete(id);
      if (label && --labelled === 0) busy.value = recovering ? RECOVERING : null;
      resolve(r);
      // 排在这条回复的处理（换上快照）之后再叫醒等着的
      if (idleWaiters.length && editsIdle()) for (const w of idleWaiters.splice(0)) w();
    };
    engineHost().send(
      req,
      (r) => {
        if (!after) return finish(r);
        after(r)
          .catch((e) => console.error(e))
          .finally(() => finish(r));
      },
      safeReason,
    );
  });
}

// Worker 卡住、停下、崩了，旧的已经停掉（正在等的请求都回了出错）：预览都作废，提示这一步没有做，等着恢复
function engineReset(message: string) {
  dropPreviews();
  resetAutosaveIds();
  showToast(message, true);
  recovering = true;
  if (labelled === 0) busy.value = RECOVERING;
}

// 恢复好了：换上快照（不算新打开：镜头不动），标上是不是安全模式
function engineRestored(r: Extract<Response, { ok: true }>, reason: string | null) {
  recovered();
  resetAutosaveIds();
  if (r.snapshot) applySnapshot(r.snapshot);
  safeMode.value = reason !== null ? { reason } : null;
}

function engineFailed(message: string) {
  recovered();
  showToast(message, true);
}

// 不再等恢复（恢复好了、恢复不了、打开了别的世界）
function recovered() {
  recovering = false;
  if (labelled === 0) busy.value = null;
}

// 界面上的“停下”：停掉正在跑的脚本（与卡住一样恢复，这一步不做）
export function stopScripts() {
  host?.stop();
}

function meshFor(s: Settings): Mesh {
  const key = meshKey(s);
  if (meshCache?.key !== key) meshCache = { key, mesh: buildMeshFor(s) };
  return meshCache.mesh;
}

// 新建、打开时：Worker 在算的同时，主线程要的网格（整个星球还有显示用的三角网、多边形）在另一个 Worker 里建好转交过来
// （mesh-worker.ts，与计算 Worker 同时算），主线程不再为建网格停顿约 1 秒。没有 Worker 时（测试里）先让出一帧再就地建。
// 返回建好（或建不成）时兑现的承诺：换上快照之前等它，快照里的世界就用这份网格
function prebuildMesh(settings: Partial<Settings>): Promise<void> {
  let s: Settings;
  try {
    s = settingsSchema.parse(settings);
  } catch {
    // 设置无效时 Worker 会报错，这里不管
    return Promise.resolve();
  }
  const key = meshKey(s);
  if (meshCache?.key === key) return Promise.resolve();
  if (typeof Worker === 'undefined' || typeof document === 'undefined') {
    return new Promise((resolve) =>
      setTimeout(() => {
        try {
          const mesh = meshFor(s);
          if (mesh.kind === 'sphere') viewOf(mesh).polygons();
        } finally {
          resolve();
        }
      }, 0),
    );
  }
  const w = meshWorker();
  if (!w) return Promise.resolve();
  const id = ++meshSeq;
  return new Promise<void>((resolve) => {
    // 建网格的 Worker 迟迟不回（比如它读 IndexedDB 卡住了）：最多等 MESH_WAIT_MS，之后不等了，换上快照时在主线程上就地建
    const timer = setTimeout(() => {
      if (meshWaiters.delete(id)) resolve();
    }, MESH_WAIT_MS);
    meshWaiters.set(id, (packed) => {
      clearTimeout(timer);
      // 等的时候换成了别的网格（又新建了一个别的大小）就不要了
      if (packed && meshCache?.key !== key) {
        try {
          meshCache = { key, mesh: unpackMesh(packed) };
        } catch {
          // 拆不了：换上快照时就地建
        }
      }
      resolve();
    });
    try {
      w.postMessage({ id, settings: s, build: hostOpts.build } satisfies MeshRequest);
    } catch {
      meshWaiters.delete(id);
      resolve();
    }
  });
}

// 新建、打开时最多等建网格的 Worker 这么久（毫秒）
const MESH_WAIT_MS = 6000;

// 建网格的 Worker（一直留着：它写 IndexedDB 时不能被停掉）。开不了、出了事就不再用，换上快照时就地建
let meshWorkerRef: Worker | null = null;
let meshBroken = false;
let meshSeq = 0;
const meshWaiters = new Map<number, (mesh: PackedMesh | null) => void>();
function meshWorker(): Worker | null {
  if (meshBroken) return null;
  if (meshWorkerRef) return meshWorkerRef;
  try {
    const w = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; mesh?: PackedMesh }>) => {
      const done = meshWaiters.get(ev.data.id);
      meshWaiters.delete(ev.data.id);
      done?.(ev.data.ok && ev.data.mesh ? ev.data.mesh : null);
    };
    // 出了错、收到的消息拆不开：不再用它，等着的都按没建成算（换上快照时就地建）
    w.onerror = w.onmessageerror = () => {
      meshBroken = true;
      meshWorkerRef = null;
      const waiting = [...meshWaiters.values()];
      meshWaiters.clear();
      for (const done of waiting) done(null);
    };
    meshWorkerRef = w;
    return w;
  } catch {
    meshBroken = true;
    return null;
  }
}

// 轻快照：推导数组沿用当前世界的（同一批数组对象，地图据此跳过重新着色）；省份没变时省份数组也沿用
function lightWorld(prev: World, s: LightSnapshot): World {
  const old = prev.causes.province;
  let same = old.length === s.province.length;
  for (let i = 0; same && i < old.length; i++) if (old[i] !== s.province[i]) same = false;
  return { ...prev, causes: same ? prev.causes : { ...prev.causes, province: s.province }, small: s.small, derived: { ...prev.derived, features: s.features } };
}

function applySnapshot(s: Snapshot | LightSnapshot, fresh = false) {
  const before = world.value;
  if ('light' in s && !before) throw new Error('轻快照之前必须有完整的世界');
  const next: World =
    'light' in s
      ? lightWorld(before!, s)
      : { settings: s.settings, mesh: meshFor(s.settings), kmPerUnit: kmPerUnit(s.settings), causes: s.causes, small: s.small, derived: s.derived };
  const mesh = next.mesh;
  batch(() => {
    if (fresh) {
      worldEpoch.value++;
      measure.value = null;
      if (visualOverrides.value.size) visualOverrides.value = new Map();
    } else pruneVisualOverrides(next.small.species);
    world.value = next;
    worldState.value = s.stateId;
    // 结果换上了：调整面板预览的世界（松手前一直显示着，不闪回原样）这时才去掉
    adjustPreviewWorld.value = null;
    adjustPreviewNote.value = null;
  });
  adjustKey = '';
  history.value = s.history;
  adjustPreview.value = null;
  canUndo.value = s.canUndo;
  canRedo.value = s.canRedo;
  timings.value = s.timings;
  noteTimings(s.timings);
  // 选中的省份可能已被合并；关注的生态、要涂的生态可能已被撤销掉
  if (selectedProvince.value !== null && !s.small.provinces[selectedProvince.value]) selectedProvince.value = null;
  // 选中的河：换了世界，画的河被删掉、撤销掉了，或者自然的河那一格不再是河
  const sel = selectedRiver.value;
  if (sel && (fresh || (sel.kind === 'guide' ? !next.small.guides.some((g) => g.id === sel.id) : !isRiverCell(next, next.derived, sel.cell)))) selectedRiver.value = null;
  // 选中的湖：放的湖被删掉、撤销掉了，或者那一格（放的湖的中心、自然的湖上点的那格）不再是湖
  const lk = selectedLake.value;
  const lkCell = lk?.kind === 'placed' ? next.small.lakes.find((l) => l.id === lk.id)?.cell : lk?.cell;
  if (lk && (fresh || lkCell === undefined || !next.derived.lake[lkCell])) selectedLake.value = null;
  const hov = hoverRiver.value;
  if (hov && (fresh || (hov.kind === 'guide' && !next.small.guides.some((g) => g.id === hov.id)))) hoverRiver.value = null;
  if (focusSpecies.value && !s.small.species.some((x) => x.id === focusSpecies.value)) focusSpecies.value = null;
  if (options.value.biome && !s.small.species.some((x) => x.id === options.value.biome)) setOptions({ biome: null });
  // 新世界：画笔、岛、湖的大小跟着地图尺度走
  if (!before || before.mesh !== mesh || before.kmPerUnit !== next.kmPerUnit) setOptions(sizesFor(next));
  scheduleAutosave();
}

export function showToast(text: string, error = false) {
  toast.value = { text, error };
  const current = toast.value;
  setTimeout(() => {
    if (toast.value === current) toast.value = null;
  }, error ? 6000 : 2500);
}

// 编辑前后的差别：哪些格变了、用一句话怎么说
export function describeChange(a: World, b: World): { cells: number[]; detail: string } {
  if (a.mesh !== b.mesh) return { cells: [], detail: '' };
  const n = a.mesh.n;
  const cells: number[] = [];
  let gained = 0;
  let lost = 0;
  let biome = 0;
  let relief = 0;
  let temp = 0;
  let province = 0;
  const riverChanged = new Uint8Array(n);
  const thrA = a.small.planet.riverThreshold;
  const thrB = b.small.planet.riverThreshold;
  const sp = (w: World, i: number) => {
    const s = w.derived.dominant[i];
    return s >= 0 ? w.small.species[s]?.id : String(s);
  };
  // 只换了省份的格（切开、合并、涂省）：另记，最后看情况一起闪
  const provinceOnly: number[] = [];
  for (let i = 0; i < n; i++) {
    const la = a.causes.land[i];
    const lb = b.causes.land[i];
    const pc = a.causes.province[i] !== b.causes.province[i];
    if (pc) province++;
    if (la !== lb) {
      if (lb) gained++;
      else lost++;
      cells.push(i);
      continue;
    }
    if (!lb) {
      if (pc) provinceOnly.push(i);
      continue;
    }
    let changed = false;
    if (sp(a, i) !== sp(b, i)) {
      biome++;
      changed = true;
    }
    if (Math.abs(a.derived.elevation[i] - b.derived.elevation[i]) > 30) {
      relief++;
      changed = true;
    }
    if (Math.abs(a.derived.tMean[i] - b.derived.tMean[i]) > 0.5) {
      temp++;
      changed = true;
    }
    const ra = a.derived.discharge[i] >= thrA && a.derived.lake[i] !== 1;
    const rb = b.derived.discharge[i] >= thrB && b.derived.lake[i] !== 1;
    if (ra !== rb || a.derived.lake[i] !== b.derived.lake[i]) {
      riverChanged[i] = 1;
      changed = true;
    }
    if (changed) cells.push(i);
    else if (pc) provinceOnly.push(i);
  }
  // 切省、合并、涂省也闪一下；整张图重新划分（三成以上的格换了省）时不闪，免得整张图一亮
  if (province <= n * 0.3) for (const i of provinceOnly) cells.push(i);
  // 河道的变化按连通的片数计
  let rivers = 0;
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!riverChanged[i] || seen[i]) continue;
    rivers++;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      for (let e = a.mesh.off[q[h]]; e < a.mesh.off[q[h] + 1]; e++) {
        const j = a.mesh.adj[e];
        if (riverChanged[j] && !seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
  }
  const parts: string[] = [];
  if (gained) parts.push(`陆地 +${gained} 格`);
  if (lost) parts.push(`陆地 −${lost} 格`);
  if (relief) parts.push(`${relief} 格地势变了`);
  if (temp) parts.push(`${temp} 格气温变了`);
  if (biome) parts.push(`${biome} 格生态变了`);
  if (rivers) parts.push(`${rivers} 处河道变了`);
  if (province && !parts.length) parts.push(`${province} 格换了省份`);
  return { cells, detail: parts.join('，') };
}

let noteId = 0;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

// 让这些格淡淡地亮一下（比如“地图上有一处出错（点这里去看）”），FLASH_MS 后去掉
export function flashCells(cells: number[]) {
  flash.value = cells.length ? { cells, at: performance.now() } : null;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.value = null), FLASH_MS);
}

function noteChange(head: string, before: World | null, again?: NoteAction, undoable = true, action?: NoteAction) {
  const after = world.value;
  if (!after || !before) return;
  const { cells, detail } = describeChange(before, after);
  const id = ++noteId;
  changeNote.value = { id, head, detail, undoable, again, action };
  setTimeout(() => {
    if (changeNote.value?.id === id) changeNote.value = null;
  }, 9000);
  flash.value = cells.length ? { cells, at: performance.now() } : null;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.value = null), FLASH_MS);
}

// fresh：新建或打开了一个世界（不是编辑）
async function handle(r: Response, fresh = false): Promise<boolean> {
  if (!r.ok) {
    showToast(r.error, true);
    return false;
  }
  if (r.snapshot) {
    const s = 'light' in r.snapshot ? r.snapshot : completeSnapshot(r.snapshot);
    if (s) applySnapshot(s, fresh);
    else {
      // 只带变了的数组、却拼不起来（手上的世界不是 Worker 上一次发快照时的状态）：要一份完整的
      const full = await call({ kind: 'snapshot' }, null);
      if (full.ok && full.snapshot && !('light' in full.snapshot)) {
        const f = completeSnapshot(full.snapshot);
        if (f) applySnapshot(f, fresh);
      }
    }
  }
  return true;
}

// 只带变了的推导数组的快照（Snapshot.same）：没发的数组沿用手上世界的同一个对象（着色、河线的缓存照样命中）。
// 手上的世界不是 Worker 上一次发快照时的状态、网格不同时拼不起来，返回 null。完整的快照原样返回
function completeSnapshot(s: Snapshot): Snapshot | null {
  const same = s.same;
  if (!same) return s;
  const prev = world.value;
  if (!prev || worldState.value !== same.base || prev.derived.corrF === undefined) return null;
  const pd = prev.derived as unknown as Record<string, unknown>;
  const d = s.derived as unknown as Record<string, unknown>;
  for (const k of same.derived) {
    const v = pd[k];
    if (!ArrayBuffer.isView(v) || d[k] !== null) return null;
    d[k] = v;
  }
  for (const [k, part] of Object.entries(same.rows ?? {})) {
    const v = pd[k] as Float32Array | undefined;
    if (!ArrayBuffer.isView(v) || d[k] !== null) return null;
    const n = prev.mesh.n;
    const width = v.length / n;
    const rows = part.rows as Float32Array;
    if (!Number.isInteger(width) || rows.constructor !== v.constructor || rows.length !== part.idx.length * width) return null;
    const out = v.slice();
    for (let q = 0; q < part.idx.length; q++) out.set(rows.subarray(q * width, (q + 1) * width), part.idx[q] * width);
    d[k] = out;
  }
  for (const k of same.corrF) {
    const v = prev.derived.corrF[k];
    if (!v || (s.derived.corrF as Record<string, unknown>)[k] !== null) return null;
    s.derived.corrF[k] = v;
  }
  return s;
}

// ---------- 脚本的信任、安全模式 ----------

// 要用户选一个的问题（信任脚本吗、用安全模式打开吗、查看脚本）：界面上是一个对话框（见 ui/shell/Ask.tsx）
export interface AskChoice {
  value: string;
  label: string;
  primary?: boolean;
}
export interface Ask {
  title: string;
  text?: string;
  // 列出的脚本（谁的、哪一种、源码）
  scripts?: FoundScript[];
  choices: AskChoice[];
  // 带一个输入框（起名字）：框里一开始的字。回车等于点主要的按钮
  input?: string;
  resolve: (value: string, text?: string) => void;
}
export const ask = signal<Ask | null>(null);

// 问一个问题，等用户点一个按钮（关掉对话框是 'cancel'）。新的问题顶掉还没回答的（那个当作取消）
export function askUser(a: Omit<Ask, 'resolve'>): Promise<string> {
  return new Promise((resolve) => {
    ask.value?.resolve('cancel');
    const me: Ask = {
      ...a,
      resolve: (v) => {
        if (ask.value === me) ask.value = null;
        resolve(v);
      },
    };
    ask.value = me;
  });
}

// 问一个名字：带输入框的问话。点了哪个按钮、框里写的什么（关掉对话框是 'cancel'）
export function askText(a: Omit<Ask, 'resolve' | 'input'> & { input: string }): Promise<{ value: string; text: string }> {
  return new Promise((resolve) => {
    ask.value?.resolve('cancel');
    const me: Ask = {
      ...a,
      resolve: (v, text) => {
        if (ask.value === me) ask.value = null;
        resolve({ value: v, text: text ?? a.input });
      },
    };
    ask.value = me;
  });
}

// 新建、打开带脚本的世界之前：有没信任过的脚本就问。信任并打开（记为信任）/ 不运行脚本打开（安全模式）/ 取消
async function askTrust(scripts: FoundScript[], verb: '打开' | '新建'): Promise<'run' | 'safe' | 'cancel'> {
  const list = await untrustedScripts(null, scripts);
  if (!list.length) return 'run';
  await knowIsolation();
  const v = await askUser({
    title: '信任这个世界里的脚本吗？',
    text: `里面有 ${list.length} 段没见过的脚本。脚本是一小段程序，会在这台电脑上运行，只信任来源可靠的世界。`,
    scripts: list,
    choices: [
      { value: 'run', label: `信任并${verb}`, primary: true },
      { value: 'safe', label: `不运行脚本${verb}` },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v === 'run') await trustScripts(list);
  return v === 'run' || v === 'safe' ? v : 'cancel';
}

// 往当前世界里导入的东西（生态 JSON……）带着没见过的脚本：先问，信任了才导入。
// 安全模式下不问（脚本不运行），也不记为信任：之后“再试一次”时照样会问
export async function confirmImport(json: unknown): Promise<boolean> {
  if (safeMode.value) return true;
  const list = await untrustedScripts(json);
  if (!list.length) return true;
  await knowIsolation();
  const v = await askUser({
    title: '信任这些脚本吗？',
    text: `要导入的内容里有 ${list.length} 段没见过的脚本。脚本是一小段程序，会在这台电脑上运行，只信任来源可靠的。`,
    scripts: list,
    choices: [
      { value: 'run', label: '信任并导入', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'run') return false;
  await trustScripts(list);
  return true;
}

// 星球形态里没见过的脚本（向导里点了形态的卡片、打开形态编辑器，调整里选了一个形态）：先问，信任了才用
// （缩略图、预览都会运行它）。inWorld：用到现在的世界上；安全模式下脚本不运行，不问（也不记为信任，“再试一次”时照样会问）
export async function trustFormScripts(json: unknown, inWorld = false): Promise<boolean> {
  if (inWorld && safeMode.value) return true;
  const list = await untrustedScripts(json);
  if (!list.length) return true;
  const v = await askUser({
    title: '信任这个星球形态里的脚本吗？',
    text: `里面有 ${list.length} 段没见过的脚本。脚本是一小段程序，会在这台电脑上运行，只信任来源可靠的。`,
    scripts: list,
    choices: [
      { value: 'run', label: '信任', primary: true },
      { value: 'cancel', label: '取消' },
    ],
  });
  if (v !== 'run') return false;
  await trustScripts(list);
  return true;
}

// 自己提交的脚本（加、改生态……）记为信任。安全模式下不记：那里的脚本可能是从没信任的世界里复制来的。
// 每一笔都要过一遍（涂一笔的命令里有上万个格号）：findScripts 不把数放进栈，比先转成 JSON 再找快
function trustOwn(cmd: Command) {
  if (safeMode.value || trustedElsewhere.has(cmd)) return;
  const found = findScripts(cmd);
  if (found.length) void trustScripts(found);
}

// 脚本框的提交不在这里记：编辑器只报框里写的那一段（补丁里整份带着的另一段不算），
// 同一步里被换掉的中间版本还要从信任列表里去掉（见 ui/connect.ts）。这样的命令先在这里登记
const trustedElsewhere = new WeakSet<Command>();
export function trustHandledElsewhere<C extends Command>(cmd: C): C {
  trustedElsewhere.add(cmd);
  return cmd;
}

// 打开时选了“不运行脚本”
const SAFE_CHOSEN = '打开时选了不运行脚本';

// 新建、打开完：标上是不是安全模式；正常打开时整理信任列表（当前世界的留着）
function afterOpen(r: Response, scripts: FoundScript[]) {
  const safe = r.ok && r.safe === true;
  safeMode.value = safe ? { reason: engineHost().safeReason ?? SAFE_CHOSEN } : null;
  if (!safe) void tidyTrusted(scripts);
}

export interface OpenOptions {
  // 用安全模式打开（脚本不运行），值是原因（横幅里写）
  safe?: string;
  // 镜头不动（“再试一次”打开的是同一个世界）
  keepView?: boolean;
}

// 新建、打开：带脚本时先查信任（没见过的问用户）；正常打开带脚本的世界期间记下标记（页面停止响应后下次启动时先问）。
// 不带脚本时与以前一样立刻发给 Worker
async function open(req: Extract<Request, { kind: 'init' | 'load' }>, label: string, opts: OpenOptions, verb: '打开' | '新建', settings: Partial<Settings>): Promise<boolean> {
  // 新建时设置也一起查（脚本可能出现在任何地方：findScripts 找的是所有叫 scripts 的容器）
  const scripts = uniqueScripts(findScripts(req.kind === 'init' ? [req.settings, req.commands] : req.doc));
  // 没有脚本的世界不用安全模式（安全模式只是不运行脚本；比如在安全模式里把脚本都删了，自动保存还记着安全模式）
  let safe = scripts.length ? (opts.safe ?? null) : null;
  if (safe === null && scripts.length) {
    const d = await askTrust(scripts, verb);
    if (d === 'cancel') return false;
    if (d === 'safe') safe = SAFE_CHOSEN;
  }
  changeNote.value = null;
  if (req.kind === 'init') flash.value = null;
  const marked = safe === null && scripts.length > 0;
  if (marked) await markLoading(scripts.map((s) => s.hash));
  // 检查点的版本号（开发时要先取引擎文件算哈希；页面里才有）
  if (typeof document !== 'undefined') hostOpts.build = await buildKey();
  let meshReady: Promise<void> = Promise.resolve();
  let ok = false;
  // 等网格、换上快照都在 call 的 after 里：做完之前新建、打开一直算在 pending、busy 里（见 call）
  const r = call(safe === null ? req : { ...req, safe: true }, label, safe ?? undefined, async (res) => {
    await meshReady;
    if (marked) void clearLoading();
    // 新的引擎（可能在新开的 Worker 里）：步号从 1 起，自动保存从头写（镜头不动时世界的纪元不变，要在这里清）
    if (res.ok) resetAutosaveIds();
    ok = await handle(res, !opts.keepView);
    if (ok) afterOpen(res, scripts);
  });
  meshReady = prebuildMesh(settings);
  await r;
  return ok;
}

export async function newWorld(settings: Partial<Settings>, commands: Command[], opts: OpenOptions = {}) {
  return open({ kind: 'init', settings, commands }, '正在生成世界…', opts, '新建', settings);
}

// 打开世界：世界文件、自动保存（连同检查点）、“再试一次”都经过这里，带脚本时统一查信任。
// 不是世界文件、是旧版本的世界（第九轮起不再兼容）时直接说打不开，不去重放
export async function loadDoc(doc: WorldDoc, opts: OpenOptions = {}) {
  try {
    checkDoc(doc);
  } catch (e) {
    showToast((e as Error).message, true);
    return false;
  }
  return open({ kind: 'load', doc }, '正在打开世界…', opts, '打开', doc.settings);
}

// 继续上次的世界（启动时、向导里）：读自动保存，上次是安全模式就照样用安全模式打开。
// 上次正常打开带脚本的世界时页面停止了响应（标记还在、是这个世界的脚本）：先问要不要用安全模式。没有自动保存时返回 null
export async function resumeLast(): Promise<boolean | null> {
  const saved = await readAutosave();
  if (!saved) return null;
  let safe = saved.safe ?? null;
  const mark = await readLoading();
  if (mark) {
    await clearLoading();
    const mine = new Set(findScripts(saved.doc).map((s) => s.hash));
    if (safe === null && mark.hashes.some((h) => mine.has(h))) {
      const v = await askUser({
        title: '上次打开这个世界时程序停止了响应。用安全模式打开吗？（脚本不运行）',
        choices: [
          { value: 'safe', label: '用安全模式打开', primary: true },
          { value: 'run', label: '照常打开' },
        ],
      });
      if (v !== 'run') safe = '上次打开时程序停止了响应';
    }
  }
  const ok = await loadDoc(saved.doc, safe !== null ? { safe } : {});
  if (ok && saved.mapId) await relink(saved.mapId, saved.mapSynced ? 0 : saved.savedAt);
  return ok;
}

// 打开上次的世界后：它连着“我的地图”里的一张就接着连上（那一张不在了就不连）。
// 那一张比自动保存旧（上次写完自动保存、还没来得及写它就关了页面）：马上补写一次。
// autosavedAt：自动保存的时间；写自动保存时那一张已经相同（只是打开了它，没改）时为 0
async function relink(id: string, autosavedAt: number) {
  try {
    const e = await idbMapStore.entry(id);
    if (!e) return;
    mapLink.value = { id, name: e.name, epoch: worldEpoch.value };
    mapSavedState.value = e.savedAt >= autosavedAt ? worldState.value : -1;
    if (mapSavedState.value < 0) void autosaveNow();
  } catch {
    // 读不了就当没连着
  }
}

// 安全模式横幅的“再试一次”：另开一个 Worker，脚本照常运行（没信任过的照样先问）。
// 先等排着的改动算完再取世界：比如脚本框里刚写的一段，点按钮时离开框就提交了，还在算；
// 不等的话取到的世界里没有它，重新打开后这一段就丢了
export async function retryScripts(): Promise<boolean> {
  await whenEditsIdle();
  const doc = host?.mirror.doc() ?? (await getDoc());
  return doc ? loadDoc(doc, { keepView: true }) : false;
}

// “查看脚本”：现在这个世界里的脚本（生态的……）
export async function showScripts(): Promise<void> {
  const w = world.value;
  const list = w ? uniqueScripts(findScripts(w.small)) : [];
  await askUser({ title: '这个世界里的脚本', text: list.length ? undefined : '这个世界里没有脚本。', scripts: list, choices: [{ value: 'close', label: '关上', primary: true }] });
}

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
function openWaterTypeEditor(kind: 'river' | 'lake', id: string) {
  if (tool.value !== 'river' && tool.value !== 'lake' && tool.value !== 'unwater') tool.value = kind === 'lake' ? 'lake' : 'river';
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

// “换一个”：给出下一条命令（比如换了 variant 的放岛），替换掉刚做的那一步
export type Again = { label: string; next: () => Command | null };

// 执行一条编辑命令；成功后显示“改了什么”、撤销，以及能换一个时的“换一个”、额外的按钮
// head：顶部说的话（不用引擎的说法时）；是函数时按改完的世界说（返回 null 照用引擎的说法）
export async function exec(cmd: Command, label = '正在计算…', again?: Again, action?: NoteAction, head?: string | ((after: World, summary: string) => string | null)): Promise<boolean> {
  const r = await call({ kind: 'exec', cmd }, label);
  // 这类命令重算一次要多久（成本闸门：太慢的不自动预览）
  if (r.ok && r.snapshot && !('light' in r.snapshot)) noteCost(cmd, r.snapshot.timings.total);
  // 改动前的世界：排在前面的笔画已经算完、换上了，所以在回复到达时取
  const before = world.value;
  if (r.ok && r.noop) {
    showToast('没有变化');
    return true;
  }
  const ok = await handle(r);
  if (ok && r.ok) {
    trustOwn(cmd);
    const said = typeof head === 'function' ? (world.value ? head(world.value, r.summary ?? '') : null) : head;
    const text = said ?? ((cmd.op === 'add_constraint' && before && world.value && paintNote(before, world.value)) || r.summary || '完成');
    noteChange(text, before, againAction(again, label), true, action);
  }
  return ok;
}

// 涂了一片生态之后实际的结果（与按住时的预览一样说）：“水晶丛林：60 格变了 · 495 格没涂成（这里长不了）”。
// 刚涂的是 after 里最后一条涂的设定；没涂成的格是它在冲突里列出的格。拼不出来时返回 null（照用引擎的说法）
export function paintNote(before: World, after: World): string | null {
  const c = after.small.constraints[after.small.constraints.length - 1];
  if (!c || before.mesh !== after.mesh) return null;
  const name = after.small.species.find((x) => x.id === c.species)?.name || c.species;
  const id = (w: World, i: number) => {
    const k = w.derived.dominant[i];
    return k >= 0 ? w.small.species[k]?.id : null;
  };
  let changed = 0;
  for (let i = 0; i < after.mesh.n; i++) if (id(before, i) !== id(after, i)) changed++;
  const failing = after.derived.conflicts.find((x) => x.constraintId === c.id)?.failing.length ?? 0;
  const mode = c.mode === 'constraint' ? '自然融入' : '强制';
  const head = changed ? `${name}：${changed} 格变了` : `${name}：生态没变`;
  return failing ? `${head} · ${failing} 格没涂成（这里长不了）` : `${head}（${mode}）`;
}

function againAction(again: Again | undefined, label: string) {
  if (!again) return undefined;
  return {
    label: again.label,
    run: () => {
      // 后面还有排队的编辑：现在换掉的会是排在最后的那一步，不是这一步
      if (editsInFlight()) {
        showToast('等排队的几步算完再换');
        return;
      }
      const next = again.next();
      if (next) void replaceLast(next, label, again);
    },
  };
}

// 撤掉刚做的一步，换成新的命令（只重算一次，历史里只留一步）
export async function replaceLast(cmd: Command, label = '正在计算…', again?: Again): Promise<boolean> {
  const r = await call({ kind: 'replaceLast', cmd }, label);
  if (r.ok && r.snapshot && !('light' in r.snapshot)) noteCost(cmd, r.snapshot.timings.total);
  const before = world.value;
  const ok = await handle(r);
  if (ok && r.ok) {
    trustOwn(cmd);
    noteChange(r.summary ?? '完成', before, againAction(again, label));
  }
  return ok;
}

// 改动前的世界、历史都在回复到达时取：排在前面的笔画那时已经换上了
export async function undo() {
  const r = await call({ kind: 'undo' }, '撤销…');
  const before = world.value;
  const last = history.value.filter((h) => h.done).pop();
  const ok = await handle(r);
  if (ok && last) noteChange(`撤销了：${last.summary}`, before, undefined, false);
}

export async function redo() {
  const r = await call({ kind: 'redo' }, '重做…');
  const before = world.value;
  const next = history.value.find((h) => !h.done);
  const ok = await handle(r);
  if (ok && next) noteChange(`重做了：${next.summary}`, before);
}

// “调整”面板拖滑块时的地形预览：同一时间只算一个，拖动中只算最新的值。
// 算好的照样先显示（后面已经有更新的值在排队也显示，但一秒最多换几次，大星球上换一次要几十毫秒）：
// 一直拖着不停时，海岸线慢一步跟着滑块走，而不是一直不出来
let terrainPending: TerrainPatch | null = null;
let terrainBusy = false;
// 正在算的、显示着的是哪个值（JSON）：松手时据此决定还要不要再算一遍（见 commitTerrain）
let terrainFlight = '';
let terrainShown: { key: string; t: TerrainPreview; at: number } | null = null;
// 每次清掉预览就换一代：还在路上的旧结果不再显示
let terrainGen = 0;
// 要过几次预览（清掉也算）：松手执行后据此判断用户是不是又拖了（见 commitTerrain）
let terrainAsked = 0;
export function previewTerrain(patch: TerrainPatch | null) {
  terrainAsked++;
  if (!patch) {
    terrainPending = null;
    terrainGen++;
    adjustPreview.value = null;
    return;
  }
  terrainPending = patch;
  if (terrainBusy) return;
  void (async () => {
    terrainBusy = true;
    while (terrainPending) {
      const p = terrainPending;
      terrainPending = null;
      const gen = terrainGen;
      const w = world.value;
      const key = JSON.stringify(p);
      terrainFlight = key;
      const r = await call({ kind: 'previewTerrain', patch: p }, null);
      terrainFlight = '';
      // 算的过程中松手了（不要了）、世界变了，这个结果就不要了；后面还有更新的值、刚换过一次的，也先不换
      const soon = terrainPending !== null && terrainShown !== null && performance.now() - terrainShown.at < 150;
      if (r.ok && r.terrain && gen === terrainGen && world.value === w && !soon) showTerrain(key, r.terrain);
    }
    terrainBusy = false;
  })();
}

function showTerrain(key: string, t: TerrainPreview) {
  terrainShown = { key, t, at: performance.now() };
  adjustPreview.value = t;
}

// “调整”的地形滑块松手：执行命令，拖到的那个值的预览（将来的海岸线）留在地图上，直到结果换上
// （applySnapshot 时清掉），算的期间不闪回旧的海岸。松手的值还没算过、也不在算（一直拖着没停就松手）：
// 现在就算它，Worker 按顺序处理，它在执行之前算好；排队的、在算的旧值作废。
// 没有变化、出错时在这里清掉；松手后又拖了就不动（那是新的预览）
export async function commitTerrain(cmd: Command, label: string, patch: TerrainPatch | null): Promise<boolean> {
  if (patch) {
    const key = JSON.stringify(patch);
    terrainPending = null;
    if (key !== terrainFlight) {
      const gen = ++terrainGen;
      const w = world.value;
      const shown = terrainShown?.key === key && adjustPreview.value === terrainShown.t;
      if (!shown) {
        void call({ kind: 'previewTerrain', patch }, null).then((r) => {
          if (r.ok && r.terrain && gen === terrainGen && world.value === w) showTerrain(key, r.terrain);
        });
      }
    }
  }
  const mark = terrainAsked;
  const ok = await exec(cmd, label);
  if (terrainAsked === mark && adjustPreview.value) previewTerrain(null);
  return ok;
}

// 一次性的地形预览（重画这一片悬停时）：同一时间只算一个，排队时来了新的，旧的直接得到 null（见下面的 latest）；
// 算的过程中世界换了也得到 null。结果里的 ms 是 Worker 算它用了多久（工具据此决定要不要自动预览）
const terrainOnce = latest(async (patch: TerrainPatch) => {
  const w = world.value;
  const r = await call({ kind: 'previewTerrain', patch }, null);
  return r.ok && r.terrain && world.value === w ? r.terrain : null;
});
export function previewTerrainOnce(patch: TerrainPatch): Promise<TerrainPreview | null> {
  return terrainOnce.ask(patch);
}

// 命令的确切预览：在世界的副本上执行，返回会出现 / 消失的河等（画河改道时用）。
// 同一时间只算一个；排队时来了新的，旧的直接得到 null。Worker 留着算好的副本，紧接着执行同一条命令时直接采用
let cmdPending: { cmd: Command; resolve: (r: PreviewResult | null) => void } | null = null;

// 不再需要的预览（松手提交了、取消了）：还在排队的直接作废，不再发给 Worker
export function cancelPreviews() {
  cmdPending?.resolve(null);
  cmdPending = null;
}
let cmdBusy = false;
export function previewCommand(cmd: Command): Promise<PreviewResult | null> {
  return new Promise((resolve) => {
    cmdPending?.resolve(null);
    cmdPending = { cmd, resolve };
    if (cmdBusy) return;
    void (async () => {
      cmdBusy = true;
      while (cmdPending) {
        const p = cmdPending;
        cmdPending = null;
        const w = world.value;
        const r = await call({ kind: 'preview', cmd: p.cmd }, null);
        p.resolve(r.ok && r.preview && world.value === w ? r.preview : null);
      }
      cmdBusy = false;
    })();
  });
}

// 省份命令的轻预览（重划、按新规则重新划分、换一种划分）：只算省份，返回执行后的省份数组、各省（含新起的名字）与切线。
// 同一时间只算一个；排队时来了新的，旧的直接得到 null（见下面的 latest）。做不成（比如涂得不够）、世界已经变了也是 null，不提示
const provincePreviews = latest(async (cmd: Command) => {
  const w = world.value;
  const r = await call({ kind: 'previewProvinces', cmd }, null);
  return r.ok && r.provinces && world.value === w ? r.provinces : null;
});
export function previewProvinces(cmd: Command): Promise<ProvincesPreview | null> {
  return provincePreviews.ask(cmd);
}

// 导出：在单独的 Worker 里用主线程上的这一份世界生成（期间照样能看、能改地图），进度显示在顶部，可以取消
export const exportProgress = signal<number | null>(null);
let exporting: { worker: Worker; done: (zip: Uint8Array | null) => void } | null = null;

export async function exportZip(opts: ExportOptions): Promise<Uint8Array | null> {
  const w = world.value;
  const doc = await getDoc();
  if (!w || !doc) return null;
  cancelExport();
  const worker = new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' });
  exportProgress.value = 0;
  return new Promise((resolve) => {
    const job = {
      worker,
      done: (zip: Uint8Array | null) => {
        worker.terminate();
        if (exporting === job) {
          exporting = null;
          exportProgress.value = null;
        }
        resolve(zip);
      },
    };
    exporting = job;
    worker.onmessage = (ev: MessageEvent<ExportReply>) => {
      const r = ev.data;
      if ('progress' in r) {
        if (exporting === job) exportProgress.value = r.progress;
        return;
      }
      if (!r.ok) showToast(r.error, true);
      else if (r.warnings?.length) showToast(r.warnings.join('；'), true);
      job.done(r.ok ? r.zip : null);
    };
    worker.onerror = () => {
      showToast('导出失败', true);
      job.done(null);
    };
    const msg: ExportJob = { settings: w.settings, causes: w.causes, small: w.small, derived: w.derived, doc, opts };
    worker.postMessage(msg);
  });
}

export function cancelExport() {
  exporting?.done(null);
  imageExportCancel.current?.();
}

// 导出整张地图（.png，MapView 的 exportFullMap）正在画时登记的取消：顶部提示条上的“取消”也停它
export const imageExportCancel: { current: (() => void) | null } = { current: null };

export async function getDoc(): Promise<WorldDoc | null> {
  const r = await call({ kind: 'doc' }, null);
  return r.ok ? (r.doc ?? null) : null;
}

// 带脚本的缩略图（向导里带脚本的星球形态）在另一个计算 Worker 里算（同样隔离）：脚本看不到当前打开的世界；
// 卡住了只停掉那一个，不会把当前的世界也恢复一遍。那个 Worker 里从来不打开世界
let scratch: EngineHost | null = null;
function scratchCall(req: Request): Promise<Response> {
  scratch ??= new EngineHost(spawnEngine);
  return new Promise<Response>((resolve) => scratch!.send(req, resolve));
}

export async function thumbnail(settings: Partial<Settings>, gen: WorldgenInput, width: number, height: number): Promise<Uint8ClampedArray | null> {
  const req: Request = { kind: 'thumb', settings, gen, width, height };
  const r = findScripts([settings, gen]).length ? await scratchCall(req) : await call(req, null);
  if (!r.ok) {
    showToast(r.error, true);
    return null;
  }
  return r.thumb ?? null;
}

// 星球形态编辑器的实时缩略图：不弹提示条，出错（脚本的语法错误、形态写得不对）时把原因给回来；
// 脚本运行时出的错（这一次按没有脚本算）在 issues 里。stopped：没算完就被停下了（脚本卡住、点了“停下”、
// 计算程序停止了响应）：Worker 已经换了一个，世界从命令记录里恢复
export async function formThumbnail(
  settings: Partial<Settings>,
  gen: WorldgenInput,
  width: number,
  height: number,
): Promise<{ thumb: Uint8ClampedArray; issues: ScriptIssue[] } | { error: string; stopped?: boolean }> {
  const r = await call({ kind: 'thumb', settings, gen, width, height }, null);
  if (!r.ok) return { error: r.error, ...(r.id === CANCELLED ? { stopped: true } : {}) };
  return r.thumb ? { thumb: r.thumb, issues: r.issues ?? [] } : { error: '缩略图没算出来' };
}

export function download(name: string, data: Uint8Array | string | Blob, type: string) {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 确切预览：将来的世界 ----------

// 同一时间只算一个；排队时来了新的，旧的直接得到 null（拖动中只算最新的那个）。
// cancel：正在算的那个也不要了时叫它（确切预览：Worker 在下一个阶段之间停下，不必等它算完）
function latest<A, R>(run: (a: A) => Promise<R | null>, cancel?: () => void) {
  let waiting: { a: A; resolve: (r: R | null) => void } | null = null;
  let running = false;
  return {
    ask: (a: A) =>
      new Promise<R | null>((resolve) => {
        waiting?.resolve(null);
        waiting = { a, resolve };
        if (running) {
          cancel?.();
          return;
        }
        void (async () => {
          running = true;
          while (waiting) {
            const p = waiting;
            waiting = null;
            // 出了错也当没有结果，不卡住后面的预览
            p.resolve(await run(p.a).catch(() => null));
          }
          running = false;
        })();
      }),
    // 还没发出去的作废（松手提交了、换了工具）
    drop: () => {
      waiting?.resolve(null);
      waiting = null;
    },
  };
}

// ---- 成本闸门 ----
// 每类命令最近一次预览（或执行）算了多久（毫秒）。超过约 600 毫秒的那类不再自动预览（拖动中停顿时）：
// Worker 一次只做一件事，松手时的执行要排在还没算完的预览后面；改为说一句“松手后约 N 秒出结果”
// 按网格分开记：换了一个世界（比如从大星球换到小地图）就重新量，不沿用别的世界上的慢
const COST_LIMIT = 600;
const costsByMesh = new WeakMap<object, Map<string, number>>();
const noMesh = {};
function costs(): Map<string, number> {
  const key = world.value?.mesh ?? noMesh;
  let c = costsByMesh.get(key);
  if (!c) costsByMesh.set(key, (c = new Map()));
  return c;
}
// 最近一次确切预览算了多久：停顿多久才预览按它放长（慢的世界上少算几次）
let lastPreviewMs = 0;

// 哪一类命令（代价相近的算一类）
function costKey(cmd: Command): string {
  if (cmd.op === 'set_planet') return `set_planet:${Object.keys(cmd.patch).sort().join(',')}`;
  if (cmd.op === 'paint') return `paint:${cmd.field.startsWith('field:') ? 'field' : cmd.field}`;
  if (cmd.op === 'batch') return `batch:${cmd.commands.map(costKey).join('+')}`;
  return cmd.op;
}

export function noteCost(cmd: Command, ms: number) {
  costs().set(costKey(cmd), ms);
}

// 要从气候重算起的整体参数（没算过这一类时，按最近一次从气候算起用了多久估计）
const CLIMATE_KEYS = ['tilt', 'solar', 'lapse', 'humidity', 'latShift', 'currents', 'terrainWind', 'mountainScale', 'rotation', 'outsideOcean'];
const CLIMATE = 'climate';
function noteTimings(t: Timings) {
  if (t.climate !== undefined) costs().set(CLIMATE, t.total - (t.elevation ?? 0));
}

// 这条命令自动预览太慢：返回大约几秒（“松手后约 N 秒出结果”）；不慢、或者还不知道时为 null
export function slowPreview(cmd: Command): number | null {
  let ms = costs().get(costKey(cmd));
  if (ms === undefined && cmd.op === 'set_planet' && Object.keys(cmd.patch).some((k) => CLIMATE_KEYS.includes(k))) ms = costs().get(CLIMATE);
  return ms !== undefined && ms > COST_LIMIT ? Math.max(1, Math.round(ms / 1000)) : null;
}

// 停顿多久再预览（毫秒）：至少 base，上次预览算得久就等得久一点（上次的一半），最多 600
// 大世界（6 万格以上，比如整个星球）：至少停 700 毫秒才算（一次预览要几秒，停顿短时算了也多半被下一笔取消）
export function exactDelay(base: number): number {
  const big = (world.value?.mesh.n ?? 0) > BIG_WORLD;
  return Math.min(big ? 900 : 600, Math.max(base, big ? 700 : 0, 0.5 * lastPreviewMs));
}
const BIG_WORLD = 60000;

// 确切预览的结果：将来的世界。base：按哪个世界算的（世界换了就不再显示）
export interface WorldPreview {
  result: PreviewResult;
  world: World;
  base: World;
}

// Worker 回来的预览：按当前世界的状态算的才用（排在前面的编辑之后算的也算数：那时它的结果已经换上了），
// 过期的丢掉；在当前世界上补上差别，得到将来的世界
export function previewReply(r: Response): WorldPreview | null {
  const base = world.value;
  if (!r.ok || !r.preview || !r.world || !base || r.preview.stateId !== worldState.value) return null;
  return { result: r.preview, world: previewWorldOf(base, r.world), base };
}

// 最近一次确切预览没算成时 Worker 说的原因（比如资源包里的脚本写错了），按命令记：
// 问的是别的命令（或这条还没算就被更新的换掉了）时为 null，不拿别处的出错冒充这一条的
let worldPreviewFailure: { key: string; error: string } | null = null;
export function worldPreviewError(cmd: Command): string | null {
  const f = worldPreviewFailure;
  return f && f.key === JSON.stringify(cmd) ? f.error : null;
}

const worldPreviews = latest(async (cmd: Command) => {
  const r = await call({ kind: 'previewWorld', cmd }, null);
  worldPreviewFailure = r.ok ? null : { key: JSON.stringify(cmd), error: r.error };
  if (r.ok && r.preview) {
    noteCost(cmd, r.preview.ms);
    lastPreviewMs = r.preview.ms;
  }
  // 预览算不成（比如涂的格都不能长东西）不提示：松手执行时才说
  return previewReply(r);
}, stopRunningPreview);

// 正在算的确切预览不要了：告诉 Worker 在下一个阶段之间停下（星球上一次预览要几秒，新的一笔、要别的值时不必等它算完）。
// 已经发了同一条命令的执行时 Worker 不停（执行直接采用它）。没有在算的预览时什么都不做
function stopRunningPreview() {
  if (![...pending.values()].some((p) => p.kind === 'previewWorld')) return;
  void call({ kind: 'cancelPreview' }, null);
}

// 命令的确切预览，连同将来的世界（previewCommand 不变，画河改道照旧用它）。Worker 留着算好的副本：
// 紧接着执行同一条命令时直接采用，松手后立刻出结果，颜色不跳
export function previewWorld(cmd: Command): Promise<WorldPreview | null> {
  return worldPreviews.ask(cmd);
}

// 还没发出去的作废；hard：正在算的也停下（新的一笔、换了工具）。松手执行时不要 hard：执行同一条命令要直接采用它
// （执行别的命令时 Worker 自己会停下它）
export function cancelWorldPreview(hard = false) {
  worldPreviews.drop();
  if (hard) stopRunningPreview();
}

// Worker 换了一个（卡住后恢复）：排着的、显示着的预览都不要了（按旧 Worker 的状态算的）
function dropPreviews() {
  cancelPreviews();
  worldPreviews.drop();
  provincePreviews.drop();
  terrainOnce.drop();
  terrainPending = null;
  terrainGen++;
  adjustPreview.value = null;
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = null;
  adjustKey = '';
  adjustPreviewWorld.value = null;
  adjustPreviewNote.value = null;
}

// ---- 调整面板、生态编辑器：拖动停下后预览将来的世界，松手执行同一条命令（直接采用） ----
let adjustTimer: ReturnType<typeof setTimeout> | null = null;
// 正在预览（或要预览）的命令（JSON）
let adjustKey = '';
// 松手后正在执行的命令（JSON）：它的预览世界留到结果换上，关面板也不去掉
let settling = '';

// cmd 为 null：不再预览（关了面板、拖回原来的值）
export function previewAdjust(cmd: Command | null, pause = 200) {
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = null;
  if (!cmd) {
    adjustKey = '';
    cancelWorldPreview(true);
    if (adjustPreviewWorld.value?.key !== settling) adjustPreviewWorld.value = null;
    adjustPreviewNote.value = null;
    return;
  }
  const key = JSON.stringify(cmd);
  if (key === adjustKey) return;
  adjustKey = key;
  const slow = slowPreview(cmd);
  if (slow !== null) {
    // 不会再有新的预览换上：别的值的预览世界不能留在图上冒充这个值的
    if (adjustPreviewWorld.value?.key !== settling) adjustPreviewWorld.value = null;
    adjustPreviewNote.value = { key, text: `松手后约 ${slow} 秒出结果` };
    return;
  }
  adjustPreviewNote.value = { key, text: '正在算预览…' };
  adjustTimer = setTimeout(() => {
    adjustTimer = null;
    void previewWorld(cmd).then((r) => {
      if (!r || adjustKey !== key) return;
      adjustPreviewWorld.value = { key, base: r.base, world: r.world };
      adjustPreviewNote.value = { key, text: '地图上是松手后的样子' };
    });
  }, exactDelay(pause));
}

// 松手：执行 cmd。预览的就是它时，预览的世界一直留到结果换上（不先闪回原样），Worker 直接采用预览算好的结果；
// 不是它就先去掉。没有变化、执行失败时（世界没换）也去掉
export async function execAdjust(cmd: Command, label?: string): Promise<boolean> {
  if (adjustTimer) clearTimeout(adjustTimer);
  adjustTimer = null;
  const key = JSON.stringify(cmd);
  adjustKey = '';
  worldPreviews.drop();
  adjustPreviewNote.value = null;
  if (adjustPreviewWorld.value?.key !== key) adjustPreviewWorld.value = null;
  settling = key;
  try {
    return await exec(cmd, label);
  } finally {
    if (settling === key) settling = '';
    if (adjustPreviewWorld.value?.key === key) adjustPreviewWorld.value = null;
  }
}

// ---------- 自动保存（只存在本浏览器里） ----------
// 存在 IndexedDB：结构化克隆，不必转成 JSON，也没有 localStorage 约 5 MB 的上限（以前画多了会存不下、
// 之后悄悄不再保存）。每次只写变了的那些命令（撤销、换一个只改动最后几步）。IndexedDB 用不了时退回 localStorage

const AUTOSAVE_KEY = 'map2.autosave';
interface AutosaveMeta extends Omit<WorldDoc, 'commands'> {
  savedAt: number;
  count: number;
  // 安全模式（脚本没有运行）的原因：下次打开时照样用安全模式（不运行脚本打开 → 自动保存 → 刷新，脚本也不会跑起来）
  safe?: string;
  // 连着“我的地图”里的哪一张（见 maps.ts）：刷新后照样连着。mapSynced：写这份自动保存时那一张已经与它相同
  mapId?: string;
  mapSynced?: boolean;
}
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveWarned = false;
// 已写进 IndexedDB 的步的编号、属于哪一个世界（新建、打开后从头写）
let savedIds: number[] = [];
let savedEpoch = -1;
let savedCount = -1;
// Worker 换了一个（卡住后恢复）时加一：新引擎的步号从 1 起，旧的编号对不上，从头写
let savedGen = 0;
function resetAutosaveIds() {
  savedIds = [];
  savedGen++;
}

// 上次自动保存的时间（向导里“继续上次的世界”用）；没有时为 null
export const autosaved = signal<number | null>(null);

// 一次只写一份：前一次还没写完时，接在它后面
let autosaving: Promise<void> = Promise.resolve();
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => (autosaving = autosaving.then(autosave)), 1500);
}

// 马上自动保存一次（连上、断开“我的地图”里的一张之后，换别的世界之前）；等它写完
export function autosaveNow(): Promise<void> {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = null;
  autosaving = autosaving.then(autosave);
  return autosaving;
}

// 连着的地图上次换缩略图的时间；存满了只提醒一次
let thumbAt = 0;
let linkWarned = false;
export function noteThumb(at = Date.now()) {
  thumbAt = at;
}

// 自动保存之后：连着“我的地图”里的一张就把它也更新（世界文件；隔几分钟换一张缩略图）。
// link、state 是这次自动保存开始时的：之后换了世界（纪元变了）就不写
async function syncLinked(link: { id: string; name: string; epoch: number }, state: number) {
  if (mapSavedState.value === state) return;
  const doc = await getDoc();
  if (!doc || link.epoch !== worldEpoch.value || activeLink(mapLink.value, worldEpoch.value)?.id !== link.id) return;
  const now = Date.now();
  const thumb = now - thumbAt > THUMB_EVERY_MS ? (thumbHook.make?.() ?? null) : null;
  try {
    const e = await overwriteMap(idbMapStore, link.id, { doc, thumb, now });
    if (!e) {
      // 别的页面里删掉了：这个世界不再连着它
      if (mapLink.value?.id === link.id) mapLink.value = null;
      return;
    }
    if (thumb) thumbAt = now;
    if (mapLink.value?.id === link.id && link.epoch === worldEpoch.value) mapSavedState.value = state;
  } catch (e) {
    if (!linkWarned) showToast(isQuotaError(e) ? `浏览器的存储满了，「${link.name}」没能自动保存。删掉几张不要的地图，或用“世界 → 导出世界文件”留一份` : `「${link.name}」没能自动保存（浏览器的存储用不了）`, true);
    linkWarned = true;
  }
}

async function autosave() {
  if (savedEpoch !== worldEpoch.value) {
    savedIds = [];
    savedEpoch = worldEpoch.value;
  }
  const epoch = savedEpoch;
  const gen = savedGen;
  const link = activeLink(mapLink.value, epoch);
  const state = worldState.value;
  const r = await call({ kind: 'docTail', ids: savedIds }, null);
  if (!r.ok || !r.tail || epoch !== worldEpoch.value || gen !== savedGen) return;
  const { from, commands, ids, ...head } = r.tail;
  const meta: AutosaveMeta = { ...head, savedAt: Date.now(), count: ids.length };
  if (safeMode.value) meta.safe = safeMode.value.reason;
  if (link) {
    meta.mapId = link.id;
    if (mapSavedState.value === state) meta.mapSynced = true;
  }
  try {
    if (savedCount < 0) savedCount = ((await idb<AutosaveMeta | undefined>('readonly', (s) => s.get('autosave')))?.count ?? 0) as number;
    const stale = savedCount;
    // 一个事务：要么全写进去，要么都不写
    await idbTx(['kv', 'autosave'], 'readwrite', (kv, store) => {
      commands.forEach((c, k) => store.put(c, from + k));
      if (stale > meta.count) store.delete(IDBKeyRange.bound(meta.count, stale - 1));
      kv.put(meta, 'autosave');
    });
    if (epoch === worldEpoch.value && gen === savedGen) savedIds = ids;
    savedCount = meta.count;
    autosaved.value = meta.savedAt;
    // IndexedDB 用不了时存在 localStorage 里的：已经有更新的了
    localStorage.removeItem(AUTOSAVE_KEY);
    if (link) await syncLinked(link, state);
  } catch {
    // IndexedDB 用不了（比如隐私模式）：整份存进 localStorage
    const doc = await getDoc();
    if (!doc) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: Date.now(), doc, ...(safeMode.value ? { safe: safeMode.value.reason } : {}) }));
      autosaved.value = Date.now();
    } catch {
      if (!autosaveWarned) showToast('世界太大，浏览器存不下自动保存；记得用“世界 → 导出世界文件”留一份', true);
      autosaveWarned = true;
    }
  }
}

// 页面要被隐藏、关掉：让 Worker 立即写检查点（下次打开时直接恢复，不必重放）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && host?.alive && world.value) void call({ kind: 'checkpoint' }, null);
  });
}

// 读上次的自动保存：IndexedDB 与 localStorage（IndexedDB 用不了时的后备）里较新的那一份。safe：上次是安全模式（原因）。
// 旧版本的世界（第九轮起不再兼容）当作没有：启动时弹出向导新建，不报错；新世界的自动保存会盖掉它
export interface Autosaved {
  savedAt: number;
  doc: WorldDoc;
  safe?: string;
  mapId?: string;
  mapSynced?: boolean;
}
async function readAutosave(): Promise<Autosaved | null> {
  let best: Autosaved | null = null;
  try {
    const db = await openDb();
    const tx = db.transaction(['kv', 'autosave'], 'readonly');
    const get = <T>(req: IDBRequest) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result as T)), (req.onerror = () => reject(req.error))));
    const meta = await get<AutosaveMeta | undefined>(tx.objectStore('kv').get('autosave'));
    if (meta && meta.count > 0) {
      const commands = await get<Command[]>(tx.objectStore('autosave').getAll(IDBKeyRange.bound(0, meta.count - 1)));
      const { savedAt, count, safe, mapId, mapSynced, ...head } = meta;
      const doc = { ...head, commands };
      if (commands.length === count && isCurrentDoc(doc))
        best = { savedAt, doc, ...(typeof safe === 'string' ? { safe } : {}), ...(typeof mapId === 'string' ? { mapId, mapSynced: mapSynced === true } : {}) };
    }
    db.close();
  } catch {
    // 读不了就看 localStorage
  }
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    const old = raw ? (JSON.parse(raw) as Autosaved) : null;
    if (old && isCurrentDoc(old.doc) && (!best || old.savedAt > best.savedAt)) best = { savedAt: old.savedAt, doc: old.doc, ...(typeof old.safe === 'string' ? { safe: old.safe } : {}) };
  } catch {
    // 坏了就当没有
  }
  autosaved.value = best?.savedAt ?? null;
  return best;
}
