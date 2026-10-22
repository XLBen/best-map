import { batch, signal } from '@preact/signals';
import type { Command } from '../core/commands';
import type { PreviewResult, Timings, WorldDoc } from '../core/engine';
import type { ExportOptions } from '../core/export';
import type { WorldgenInput } from '../core/generate';
import type { Mesh } from '../core/mesh';
import { viewOf } from '../core/sphere';
import { type IslandKind, type TerrainPatch, brushRangeKm, defaultIslandKm, lakeRangeKm, mapScaleKm, reachRangeKm, roundKm } from '../core/terrain';
import { type Settings, type World, buildMeshFor, kmPerUnit, meshKey, settingsSchema } from '../core/world';
import { idbTx, openDb } from './idb';
import type { ExportJob, ExportReply, LightSnapshot, Request, Response, Snapshot } from './protocol';

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
export const timings = signal<Timings>({ total: 0 });
// 正在算的带提示的请求（执行、撤销、新建、打开…）的提示；后台的预览、自动保存不算
export const busy = signal<string | null>(null);
export const toast = signal<{ text: string; error: boolean } | null>(null);

export const tool = signal<ToolId>('land');
export const mode = signal<ViewMode>('terrain');
export const season = signal<Season>('annual');
export const mapStyle = signal<'realistic' | 'atlas'>('realistic');
export const overlays = signal({ rivers: true, borders: true, wind: false, currents: false, labels: true, scale: true, latitude: false });
export const hoverCell = signal<number>(-1);
// 地图上鼠标旁的说明（工具预览的一句话）
export const cursorHint = signal<{ x: number; y: number; text: string; warn?: boolean } | null>(null);
export const focusSpecies = signal<string | null>(null);

// 顶栏按钮弹出的面板：同一时间只开一个
export type PanelId = 'world' | 'actions' | 'adjust' | 'layers' | 'biome' | `cat:${Category}`;
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
// “调整”面板拖滑块时的预览（会变成陆地 / 海的格、山会变高变矮的格）
export const adjustPreview = signal<{ gained: number[]; lost: number[]; relief: { cells: number[]; delta: number[] } } | null>(null);

export const wizardOpen = signal(false);
export const helpOpen = signal(false);
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
// 显示哪些地名：按大类
export type LabelGroup = 'land' | 'water' | 'relief' | 'nature';
export const labelGroups = signal<Set<LabelGroup>>(new Set(['land', 'water', 'relief', 'nature']));

// 编辑后的变化：一句话汇总（带撤销、“换一个”）与几秒钟的高亮
// action：提示条上的另一个按钮（比如新建了特有生态后的“编辑”）
export type NoteAction = { label: string; run: () => void };
export const changeNote = signal<{ id: number; head: string; detail: string; undoable: boolean; again?: NoteAction; action?: NoteAction } | null>(null);
export const flash = signal<{ cells: number[]; at: number } | null>(null);

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
    lakeKm: roundKm(clampTo(Math.max(cell * 1.6, width * 0.006) * 2, lakeRangeKm(w)) * 2) / 2,
    reachKm: roundKm(clampTo(width * 0.04, reachRangeKm(w))),
  };
}

// ---------- 与 Worker 通信 ----------

let worker: Worker | null = null;
let nextId = 1;
// edit：改动世界的请求（执行、撤销、重做、换一个）；画笔可以在它们后面排队
const pending = new Map<number, { resolve: (r: Response) => void; edit: boolean }>();
const EDITS = new Set<Request['kind']>(['exec', 'undo', 'redo', 'replaceLast']);

// 正在算的只有编辑（或不改世界的后台请求）：这时画的笔画可以排在后面，按顺序执行。
// busy 不为空且这里是 false：在算的是新建、打开世界，工具要等它算完
export function onlyEditsPending(): boolean {
  for (const p of pending.values()) if (!p.edit) return false;
  return true;
}
let meshCache: { key: string; mesh: Mesh } | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<Response>) => {
    const p = pending.get(ev.data.id);
    if (p) {
      pending.delete(ev.data.id);
      p.resolve(ev.data);
    }
  };
  return worker;
}

// 还没回来的带提示的请求（执行、撤销、新建、打开…）有几个：busy 只看它们。
// 后台的预览、缩略图、自动保存不改世界，还在算的时候也不挡工具
let labelled = 0;

function call(req: Request, label: string | null): Promise<Response> {
  const w = ensureWorker();
  const id = nextId++;
  if (label) {
    labelled++;
    busy.value = label;
  }
  return new Promise<Response>((resolve) => {
    pending.set(id, {
      // 不带提示的请求（预览、自动保存）不改世界，不挡排队
      edit: EDITS.has(req.kind) || !label,
      resolve: (r) => {
        if (label && --labelled === 0) busy.value = null;
        resolve(r);
      },
    });
    w.postMessage({ id, req });
  });
}

function meshFor(s: Settings): Mesh {
  const key = meshKey(s);
  if (meshCache?.key !== key) meshCache = { key, mesh: buildMeshFor(s) };
  return meshCache.mesh;
}

// 新建、打开时：Worker 在算的同时，主线程先建好自己的网格（整个星球还有显示用的三角网），
// 不必等 Worker 算完再建。先让出一帧，“正在生成”的提示先画出来
function prebuildMesh(settings: Partial<Settings>) {
  setTimeout(() => {
    try {
      const mesh = meshFor(settingsSchema.parse(settings));
      if (mesh.kind === 'sphere') viewOf(mesh).polygons();
    } catch {
      // 设置无效时 Worker 会报错，这里不管
    }
  }, 0);
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
    }
    world.value = next;
  });
  history.value = s.history;
  adjustPreview.value = null;
  canUndo.value = s.canUndo;
  canRedo.value = s.canRedo;
  timings.value = s.timings;
  // 选中的省份可能已被合并；关注的生态、要涂的生态可能已被撤销掉
  if (selectedProvince.value !== null && !s.small.provinces[selectedProvince.value]) selectedProvince.value = null;
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
  for (let i = 0; i < n; i++) {
    const la = a.causes.land[i];
    const lb = b.causes.land[i];
    if (a.causes.province[i] !== b.causes.province[i]) province++;
    if (la !== lb) {
      if (lb) gained++;
      else lost++;
      cells.push(i);
      continue;
    }
    if (!lb) continue;
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
  }
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
  flashTimer = setTimeout(() => (flash.value = null), 3000);
}

// fresh：新建或打开了一个世界（不是编辑）
async function handle(r: Response, fresh = false): Promise<boolean> {
  if (!r.ok) {
    showToast(r.error, true);
    return false;
  }
  if (r.snapshot) applySnapshot(r.snapshot, fresh);
  return true;
}

export async function newWorld(settings: Partial<Settings>, commands: Command[]) {
  changeNote.value = null;
  flash.value = null;
  const r = call({ kind: 'init', settings, commands }, '正在生成世界…');
  prebuildMesh(settings);
  return handle(await r, true);
}

export async function loadDoc(doc: WorldDoc) {
  changeNote.value = null;
  const r = call({ kind: 'load', doc }, '正在打开世界…');
  prebuildMesh(doc.settings);
  return handle(await r, true);
}

// “换一个”：给出下一条命令（比如换了 variant 的放岛），替换掉刚做的那一步
export type Again = { label: string; next: () => Command | null };

// 执行一条编辑命令；成功后显示“改了什么”、撤销，以及能换一个时的“换一个”、额外的按钮
export async function exec(cmd: Command, label = '正在计算…', again?: Again, action?: NoteAction): Promise<boolean> {
  const r = await call({ kind: 'exec', cmd }, label);
  // 改动前的世界：排在前面的笔画已经算完、换上了，所以在回复到达时取
  const before = world.value;
  if (r.ok && r.noop) {
    showToast('没有变化');
    return true;
  }
  const ok = await handle(r);
  if (ok && r.ok) noteChange(r.summary ?? '完成', before, againAction(again, label), true, action);
  return ok;
}

function againAction(again: Again | undefined, label: string) {
  if (!again) return undefined;
  return {
    label: again.label,
    run: () => {
      const next = again.next();
      if (next) void replaceLast(next, label, again);
    },
  };
}

// 撤掉刚做的一步，换成新的命令（只重算一次，历史里只留一步）
export async function replaceLast(cmd: Command, label = '正在计算…', again?: Again): Promise<boolean> {
  const r = await call({ kind: 'replaceLast', cmd }, label);
  const before = world.value;
  const ok = await handle(r);
  if (ok && r.ok) noteChange(r.summary ?? '完成', before, againAction(again, label));
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

// “调整”面板拖滑块时的地形预览：同一时间只算一个，拖动中只保留最新的值
let terrainPending: TerrainPatch | null = null;
let terrainBusy = false;
// 每次清掉预览就换一代：还在路上的旧结果不再显示
let terrainGen = 0;
export function previewTerrain(patch: TerrainPatch | null) {
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
      const r = await call({ kind: 'previewTerrain', patch: p }, null);
      // 算的过程中松手了、世界变了，或者已经有更新的值在排队，这个结果就不要了
      if (r.ok && r.terrain && gen === terrainGen && world.value === w && !terrainPending) adjustPreview.value = r.terrain;
    }
    terrainBusy = false;
  })();
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
}

export async function getDoc(): Promise<WorldDoc | null> {
  const r = await call({ kind: 'doc' }, null);
  return r.ok ? (r.doc ?? null) : null;
}

export async function thumbnail(settings: Partial<Settings>, gen: WorldgenInput, width: number, height: number): Promise<Uint8ClampedArray | null> {
  const r = await call({ kind: 'thumb', settings, gen, width, height }, null);
  if (!r.ok) {
    showToast(r.error, true);
    return null;
  }
  return r.thumb ?? null;
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

// ---------- 自动保存（只存在本浏览器里） ----------
// 存在 IndexedDB：结构化克隆，不必转成 JSON，也没有 localStorage 约 5 MB 的上限（以前画多了会存不下、
// 之后悄悄不再保存）。每次只写变了的那些命令（撤销、换一个只改动最后几步）。IndexedDB 用不了时退回 localStorage

const AUTOSAVE_KEY = 'map2.autosave';
interface AutosaveMeta extends Omit<WorldDoc, 'commands'> {
  savedAt: number;
  count: number;
}
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveWarned = false;
// 已写进 IndexedDB 的步的编号、属于哪一个世界（新建、打开后从头写）
let savedIds: number[] = [];
let savedEpoch = -1;
let savedCount = -1;

// 上次自动保存的时间（向导里“继续上次的世界”用）；没有时为 null
export const autosaved = signal<number | null>(null);

// 一次只写一份：前一次还没写完时，接在它后面
let autosaving: Promise<void> = Promise.resolve();
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => (autosaving = autosaving.then(autosave)), 1500);
}

async function autosave() {
  if (savedEpoch !== worldEpoch.value) {
    savedIds = [];
    savedEpoch = worldEpoch.value;
  }
  const epoch = savedEpoch;
  const r = await call({ kind: 'docTail', ids: savedIds }, null);
  if (!r.ok || !r.tail || epoch !== worldEpoch.value) return;
  const { from, commands, ids, ...head } = r.tail;
  const meta: AutosaveMeta = { ...head, savedAt: Date.now(), count: ids.length };
  try {
    if (savedCount < 0) savedCount = ((await idb<AutosaveMeta | undefined>('readonly', (s) => s.get('autosave')))?.count ?? 0) as number;
    const stale = savedCount;
    // 一个事务：要么全写进去，要么都不写
    await idbTx(['kv', 'autosave'], 'readwrite', (kv, store) => {
      commands.forEach((c, k) => store.put(c, from + k));
      if (stale > meta.count) store.delete(IDBKeyRange.bound(meta.count, stale - 1));
      kv.put(meta, 'autosave');
    });
    if (epoch === worldEpoch.value) savedIds = ids;
    savedCount = meta.count;
    autosaved.value = meta.savedAt;
    // 旧版存在 localStorage 里的：已经搬过来了
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // IndexedDB 用不了（比如隐私模式）：整份存进 localStorage
    const doc = await getDoc();
    if (!doc) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: Date.now(), doc }));
      autosaved.value = Date.now();
    } catch {
      if (!autosaveWarned) showToast('世界太大，浏览器存不下自动保存；记得在“世界 → 保存世界文件”里手动保存', true);
      autosaveWarned = true;
    }
  }
}

// 页面要被隐藏、关掉：让 Worker 立即写检查点（下次打开时直接恢复，不必重放）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && worker && world.value) void call({ kind: 'checkpoint' }, null);
  });
}

// 读上次的自动保存：IndexedDB 与（旧版的）localStorage 里较新的那一份
export async function readAutosave(): Promise<{ savedAt: number; doc: WorldDoc } | null> {
  let best: { savedAt: number; doc: WorldDoc } | null = null;
  try {
    const db = await openDb();
    const tx = db.transaction(['kv', 'autosave'], 'readonly');
    const get = <T>(req: IDBRequest) => new Promise<T>((resolve, reject) => ((req.onsuccess = () => resolve(req.result as T)), (req.onerror = () => reject(req.error))));
    const meta = await get<AutosaveMeta | undefined>(tx.objectStore('kv').get('autosave'));
    if (meta && meta.count > 0) {
      const commands = await get<Command[]>(tx.objectStore('autosave').getAll(IDBKeyRange.bound(0, meta.count - 1)));
      const { savedAt, count, ...head } = meta;
      if (commands.length === count) best = { savedAt, doc: { ...head, commands } };
    }
    db.close();
  } catch {
    // 读不了就看 localStorage
  }
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    const old = raw ? (JSON.parse(raw) as { savedAt: number; doc: WorldDoc }) : null;
    if (old && (!best || old.savedAt > best.savedAt)) best = old;
  } catch {
    // 坏了就当没有
  }
  autosaved.value = best?.savedAt ?? null;
  return best;
}
