import { batch, signal } from '@preact/signals';
import type { Timings, WorldDoc } from '../../core/engine';
import type { WorldgenInput } from '../../core/generate';
import { storedMeshKey } from '../../core/mesh-pack';
import { newWorldContentCommands } from '../../core/packs/import';
import { type PostedRegenBase, unpostRegenBase } from '../../core/regen-base';
import { type ScriptIssue, findScripts } from '../../core/script';
import { isRiverCell } from '../../core/select';
import type { Command } from '../../core/commands';
import { type Settings, type World, kmPerUnit, settingsSchema } from '../../core/world';
import { CheckpointStore, type StorageWorkerLike } from '../checkpoint-store';
import { ContentHolder } from '../content-post';
import { engineCode, engineUrl } from '../engine-source';
import { EngineWorker, type RawWorker, type SpawnMemory } from '../engine-spawn';
import type { LightSnapshot, Request, Response, Snapshot } from '../protocol';
import { seedRivers, reseedRivers } from '../render/overlay';
import { lightWorld, mergeSnapshot } from './snapshot-merge';
import { CANCELLED, EngineHost, type WorkerLike } from '../sandbox';
import { noteTimings } from './cost-gate';
import { meshFor } from './mesh';
import { showToast } from './notes';
import { options, setOptions, sizesFor } from './options';
import {
  adjustPreview,
  adjustPreviewNote,
  adjustPreviewWorld,
  canRedo,
  canUndo,
  focusSpecies,
  history,
  hoverRiver,
  measure,
  pinCell,
  pinnedCell,
  pinnedPart,
  pruneVisualOverrides,
  regenTrack,
  selectedBloc,
  selectedCountry,
  selectedLake,
  selectedProvince,
  selectedRiver,
  selectedSettle,
  settleExists,
  sheet,
  visualOverrides,
  world,
  worldEpoch,
  worldState,
} from './world';

// 与计算 Worker 通信（第七十轮从 state.ts 分出来）：开 Worker、请求排队、换上快照（连同只带变了的数组的快照拼起来）

const timings = signal<Timings>({ total: 0 });
// 正在算的带提示的请求（执行、撤销、新建、打开…）的提示；后台的预览、自动保存不算
export const busy = signal<string | null>(null);

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

// 上面几层接到这里的事（第七十轮拆 state.ts 时为了不绕成圈）：确切预览（exact-preview.ts）、自动保存（autosave.ts）要用 call，
// 这里反过来不引用它们，由它们在模块里登记。在拆开之前调用的地方调用，先后不变
export const hostHooks = {
  // 换上快照时（batch 之后）：调整面板正在预览的命令作废
  snapshotSwapped: () => {},
  // 换上快照的最后：排一次自动保存
  snapshotApplied: () => {},
  // Worker 换了一个（卡住后恢复）：排着的、显示着的预览都不要了
  dropPreviews: () => {},
  // 新的引擎步号从 1 起：自动保存从头写
  resetAutosaveIds: () => {},
};

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
export const hostOpts: { build: string | null } = { build: null };

// 检查点存取：只做存储、不运行脚本的同源 Worker，第一次用到时才开
let store: CheckpointStore | null = null;
function checkpointStore(): CheckpointStore | null {
  if (!hostOpts.build || typeof Worker === 'undefined' || typeof MessageChannel === 'undefined') return null;
  store ??= new CheckpointStore(() => new Worker(new URL('../storage-worker.ts', import.meta.url), { type: 'module' }) as unknown as StorageWorkerLike);
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

export function engineHost(): EngineHost {
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
export function call(req: Request, label: string | null, safeReason?: string, after?: (r: Response) => Promise<unknown>): Promise<Response> {
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
  hostHooks.dropPreviews();
  hostHooks.resetAutosaveIds();
  showToast(message, true);
  recovering = true;
  if (labelled === 0) busy.value = RECOVERING;
}

// 恢复好了：换上快照（不算新打开：镜头不动），标上是不是安全模式
function engineRestored(r: Extract<Response, { ok: true }>, reason: string | null) {
  recovered();
  hostHooks.resetAutosaveIds();
  // 换了 Worker：第一份快照总是带着内容
  if (r.snapshot && contentHolder.unpack(r.snapshot)) applySnapshot(r.snapshot, false, r.regen, !!r.regen);
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

// 现在的计算 Worker（还没开时为 null，不去开）
export function currentHost(): EngineHost | null {
  return host;
}

// 有没有这一类的请求还没回来
export function isPending(kind: Request['kind']): boolean {
  return [...pending.values()].some((p) => p.kind === kind);
}

// regen（第九十轮）：引擎从命令记录里算的“上一次生成时的内容”（新建、打开、撤销、重做的回复里带）。
// restart：引擎是新的（新建、打开，或者卡住后另开 Worker 恢复的）：跟着记的那一份从引擎给的重新起头
function applySnapshot(s: Snapshot | LightSnapshot, fresh = false, regen?: PostedRegenBase, restart = fresh) {
  const before = world.value;
  if ('light' in s && !before) throw new Error('轻快照之前必须有完整的世界');
  const next: World =
    'light' in s
      ? lightWorld(before!, s)
      : { settings: s.settings, mesh: meshFor(s.settings), kmPerUnit: kmPerUnit(s.settings), causes: s.causes, small: s.small, derived: s.derived };
  // Worker 描好的河（第十三轮）：画这个世界的河时直接用
  // 第八十轮：河没变时快照不带，用手上拆好的那一份
  if (!('light' in s)) {
    if (s.rivers) seedRivers(next, s.rivers, s.riversId);
    else reseedRivers(next, s.riversId);
  }
  const mesh = next.mesh;
  batch(() => {
    if (fresh) {
      worldEpoch.value++;
      measure.value = null;
      pinnedCell.value = -1;
      pinnedPart.value = null;
      if (visualOverrides.value.size) visualOverrides.value = new Map();
    } else pruneVisualOverrides(next.small.species);
    // 第六十二轮：跟着撤销的先后记上一次生成时的内容（面板顶上的“重新生成”，见 regen-track.ts）
    const done = s.history.filter((h) => h.done).length;
    const base = regen ? unpostRegenBase(regen, next.small.content) : null;
    if (restart) regenTrack.reset(done, next.small.content, base);
    else regenTrack.step(done, next.small.content, base);
    world.value = next;
    worldState.value = s.stateId;
    // 结果换上了：调整面板预览的世界（松手前一直显示着，不闪回原样）这时才去掉
    adjustPreviewWorld.value = null;
    adjustPreviewNote.value = null;
  });
  hostHooks.snapshotSwapped();
  history.value = s.history;
  adjustPreview.value = null;
  canUndo.value = s.canUndo;
  canRedo.value = s.canRedo;
  timings.value = s.timings;
  noteTimings(s.timings);
  // 选中的省份可能已被合并；关注的生态、要涂的生态可能已被撤销掉
  if (selectedProvince.value !== null && !s.small.provinces[selectedProvince.value]) selectedProvince.value = null;
  // 选中的国家：被合并、删除、撤销掉了，或者换了世界
  if (selectedCountry.value !== null && (fresh || !s.small.countries?.[selectedCountry.value])) {
    selectedCountry.value = null;
    if (sheet.value === 'country') sheet.value = null;
  }
  // 选中的集团：删掉、撤销掉了，或者换了世界
  if (selectedBloc.value !== null && (fresh || !s.small.blocs?.some((b) => b.id === selectedBloc.value))) {
    selectedBloc.value = null;
    if (sheet.value === 'bloc') sheet.value = null;
  }
  // 选中的城市、道路、地标、点：删掉、撤销掉了，或者换了世界
  const ss = selectedSettle.value;
  if (ss && (fresh || !settleExists(s.small, ss))) {
    selectedSettle.value = null;
    if (sheet.value === 'settle') sheet.value = null;
  }
  // 选中的河：换了世界，画的河被删掉、撤销掉了，或者自然的河那一格不再是河
  const sel = selectedRiver.value;
  if (sel && (fresh || (sel.kind === 'guide' ? !next.small.guides.some((g) => g.id === sel.id) : !isRiverCell(next, next.derived, sel.cell)))) {
    // 撤销了固定一条自然的河（或改它的第一步）：那条河又是自然的河了，照样选着它
    const old = !fresh && sel.kind === 'guide' ? before?.small.guides.find((g) => g.id === sel.id) : undefined;
    const taken = new Set(next.small.guides.flatMap((g) => g.cells));
    const back = old?.nameKey !== undefined ? old.cells.find((c) => isRiverCell(next, next.derived, c) && !taken.has(c)) : undefined;
    selectedRiver.value = back !== undefined ? { kind: 'natural', cell: back } : null;
  }
  // 选中的湖：放的湖被删掉、撤销掉了，或者那一格（放的湖的中心、自然的湖上点的那格）不再是湖
  const lk = selectedLake.value;
  const lkCell = lk?.kind === 'placed' ? next.small.lakes.find((l) => l.id === lk.id)?.cell : lk?.cell;
  if (lk && (fresh || lkCell === undefined || !next.derived.lake[lkCell])) selectedLake.value = null;
  const hov = hoverRiver.value;
  if (hov && (fresh || (hov.kind === 'guide' && !next.small.guides.some((g) => g.id === hov.id)))) hoverRiver.value = null;
  if (focusSpecies.value && !s.small.species.some((x) => x.id === focusSpecies.value)) focusSpecies.value = null;
  // 钉住的格：换了大小的网格（打开别的世界之外，撤销到新建之前……）就不钉了
  if (pinnedCell.value >= next.mesh.n) pinCell(-1);
  if (options.value.biome && !s.small.species.some((x) => x.id === options.value.biome)) setOptions({ biome: null });
  // 新世界：画笔、岛、湖的大小跟着地图尺度走
  if (!before || before.mesh !== mesh || before.kmPerUnit !== next.kmPerUnit) setOptions(sizesFor(next));
  hostHooks.snapshotApplied();
}

// 快照里没带的内容从这里补上（见 content-post.ts）
const contentHolder = new ContentHolder();

// fresh：新建或打开了一个世界（不是编辑）。restart：引擎是新的（“再试一次”打开的是同一个世界，镜头不动，但引擎换了）
// quiet：出错时不在顶上弹出原因（调用方自己说）
export async function handle(r: Response, fresh = false, restart = fresh, quiet = false): Promise<boolean> {
  if (!r.ok) {
    regenTrack.pending = null;
    if (!quiet) showToast(r.error, true);
    return false;
  }
  if (r.snapshot) {
    const s = contentHolder.unpack(r.snapshot) ? ('light' in r.snapshot ? r.snapshot : completeSnapshot(r.snapshot)) : null;
    if (s) applySnapshot(s, fresh, r.regen, restart);
    else {
      // 只带变了的数组、却拼不起来（手上的世界不是 Worker 上一次发快照时的状态）：要一份完整的
      const full = await call({ kind: 'snapshot' }, null);
      if (full.ok && full.snapshot && !('light' in full.snapshot) && contentHolder.unpack(full.snapshot)) {
        const f = completeSnapshot(full.snapshot);
        if (f) applySnapshot(f, fresh, r.regen, restart);
      }
    }
  }
  regenTrack.pending = null;
  return true;
}

// 只带变了的数组的快照：拼到手上的世界上（见 snapshot-merge.ts）
const completeSnapshot = (s: Snapshot): Snapshot | null => mergeSnapshot(world.value, worldState.value, s);

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

// content：生成之前加进去的内容（第三十轮：Worker 里没有内置的生态，省略时是新世界默认勾上的基础、自然、中文地名）
export async function thumbnail(settings: Partial<Settings>, gen: WorldgenInput, width: number, height: number, content: Command[] = newWorldContentCommands()): Promise<Uint8ClampedArray | null> {
  const req: Request = { kind: 'thumb', settings, gen, width, height, content };
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
  const r = await call({ kind: 'thumb', settings, gen, width, height, content: newWorldContentCommands() }, null);
  if (!r.ok) return { error: r.error, ...(r.id === CANCELLED ? { stopped: true } : {}) };
  return r.thumb ? { thumb: r.thumb, issues: r.issues ?? [] } : { error: '缩略图生成失败' };
}

// 页面要被隐藏、关掉：让 Worker 立即写检查点（下次打开时直接恢复，不必重放）。
// 自动保存在这时也马上写一次（第九十四轮，state/autosave.ts 的 saveOnLeave：先用主线程的命令记录同步写，再照平常的路写）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && host?.alive && world.value) void call({ kind: 'checkpoint' }, null);
  });
}
