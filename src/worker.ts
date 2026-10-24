/// <reference lib="webworker" />
import { Dirty } from '../core/commands';
import { previewWorldOf } from '../core/preview-world';
import { riverBuffers, worldRivers } from '../core/river-pack';
import { type Checkpoint, Engine, type WorldDoc } from '../core/engine';
import { planetFormIssues, previewTerrain, resolveTerrain } from '../core/terrain';
import { renderThumbnail } from '../core/thumbnail';
import type { Mesh } from '../core/mesh';
import { type PackedMesh, unpackMesh } from '../core/mesh-pack';
import { setScriptHost, setScriptsEnabled } from '../core/script';
import { type Settings, buildMeshFor, meshKey, settingsSchema } from '../core/world';
import { probeIsolation } from './isolation-probe';
import type { CheckpointPut, TakeReply } from './checkpoint-store';
import type { CheckpointReady, Hello, LightSnapshot, MirrorLog, Request, Response, ScriptPing, Snapshot } from './protocol';

// 计算 Worker：持有引擎；每次状态变化后把原因与推导的副本发回主线程。
// 用户的脚本在这里跑：主线程尽量从 data: 地址开它（不透明的来源，页面的 CSP 管着），这样脚本读不到这个浏览器里
// 保存的世界、也不能联网。所以这里不碰 IndexedDB：检查点经主线程给的端口与只做存储的 Worker（storage-worker.ts）来往，
// 写好时另告诉主线程步号，由它核对后让存储 Worker 写下。也不读自己的文件地址（data: 地址开的 Worker 没有），版本号由主线程告诉

let engine: Engine | null = null;

// 安全模式：脚本不运行。从第一次新建、打开起在这个 Worker 里固定不变（主线程要换模式时另开一个 Worker）：
// 按内容记住的缓存（地形、地物、脚本的结果）不分模式，同一个 Worker 里换来换去会用上另一种模式算的结果
let safeMode = false;
function useSafeMode(safe: boolean | undefined) {
  if (!safe || safeMode) return;
  safeMode = true;
  setScriptsEnabled(false);
}

// ---------- 脚本的看门狗：进入、还在算（最多每 250 毫秒一次）、算完时告诉主线程 ----------
// 主线程只在脚本运行期间计时：4 秒没有消息就判定卡住，停掉这个 Worker 另开一个
const LABEL_MAX = 60;
let scriptLabel = '';
let tickAt = 0;
function ping(phase: ScriptPing['phase']) {
  post({ kind: 'script', phase, label: scriptLabel });
}
setScriptHost({
  enter(label) {
    scriptLabel = String(label).slice(0, LABEL_MAX);
    tickAt = performance.now();
    ping('enter');
  },
  tick() {
    const now = performance.now();
    if (now - tickAt < 250) return;
    tickAt = now;
    ping('tick');
  },
  exit() {
    ping('exit');
    scriptLabel = '';
  },
});

// ---------- 主线程保存的命令记录 ----------
// 每次改动世界的回复都带上上次送到主线程以来变了的命令；引擎换了一个（新建、打开）时纪元加一、从头发（from 为 0），
// 免得新引擎从 1 起的步号碰巧对上旧的，主线程留着上一个世界的命令。
// 纪元在换引擎的那一刻就加（换上后发快照出错、回复没送到，下一次照样从头发）；
// 记下“已经送到”的步号要等回复真的发出去之后（发不出去时下一次连同这些一起发，主线程的记录接得上）
let epoch = 0;
let reported: number[] = [];
function useEngine(e: Engine) {
  engine = e;
  epoch++;
  // 新的引擎：下一份快照是完整的
  lastSent = null;
  reported = [];
  // 检查点也按步号认：新引擎的步号从 1 起，可能与上一个世界写过的碰巧相同，那样这个世界的检查点就一直不写
  ckKey = '';
}
function logOf(e: Engine): MirrorLog {
  return { ...e.docTail(reported), epoch };
}

// 网格缓存：当前世界的网格和向导缩略图用的小网格（同一个大小、种子再新建或打开时不必重建）
const meshes = new Map<string, Mesh>();
// packed：存储 Worker 发来的这个世界的网格（打包的样子，与就地建的逐值相同），有就不必建
function meshFor(raw: Partial<Settings>, packed: PackedMesh | null = null): Mesh {
  const s = settingsSchema.parse(raw);
  const key = meshKey(s);
  let m = meshes.get(key);
  if (m) meshes.delete(key);
  else m = unpacked(packed, s.cells) ?? buildMeshFor(s);
  meshes.set(key, m);
  // 大网格（连同挂在它上面的缓存有几十 MB）只留最近用的一个；缩略图的小网格最多留两个
  if (m.n > 5000) for (const [k, v] of meshes) if (k !== key && v.n > 5000) meshes.delete(k);
  while (meshes.size > 3) meshes.delete(meshes.keys().next().value!);
  return m;
}

function unpacked(packed: PackedMesh | null, cells: number): Mesh | null {
  if (!packed) return null;
  try {
    const m = unpackMesh(packed);
    // 格数对不上（不该发生）就自己建
    return m.n > 0 && m.x.length === m.n && Math.abs(m.n - cells) <= cells ? m : null;
  } catch {
    return null;
  }
}

// 上一次发给主线程的推导数组（引用；发出去之后引擎不再就地改它们，见 Engine.freezeDerived）与那时的状态编号。
// 下一次只发与它们内容不同的数组。换了引擎（新建、打开）、要完整的快照时清掉
let lastSent: { state: number; derived: Map<string, ArrayBufferView>; corrF: Map<string, ArrayBufferView> } | null = null;

// 两个数组内容相同（同一个对象，或者逐字节相同）
function sameArray(a: ArrayBufferView | undefined, b: ArrayBufferView): boolean {
  if (a === b) return true;
  if (!a || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
  const n = a.byteLength;
  if (n % 4 === 0 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const x = new Int32Array(a.buffer, a.byteOffset, n / 4);
    const y = new Int32Array(b.buffer, b.byteOffset, n / 4);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  const x = new Uint8Array(a.buffer, a.byteOffset, n);
  const y = new Uint8Array(b.buffer, b.byteOffset, n);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

// a 与 b（同样类型、同样长）里变了的格：每格 width 个值逐位比较。变了的超过一成时为 null（整份发更省事）
function changedCells(a: ArrayBufferView, b: ArrayBufferView, n: number): { idx: Int32Array; rows: ArrayBufferView } | null {
  if (a.constructor !== b.constructor || a.byteLength !== b.byteLength || n <= 0) return null;
  const T = b as unknown as Float32Array;
  const len = T.length;
  if (len % n !== 0) return null;
  const width = len / n;
  // 按位比较：4 字节的按 Int32，8 字节的按两个 Int32，其他按字节
  const bpe = T.BYTES_PER_ELEMENT;
  const unit = bpe >= 4 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 ? 4 : 1;
  const per = (width * bpe) / unit;
  const x = unit === 4 ? new Int32Array(a.buffer, a.byteOffset, a.byteLength / 4) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = unit === 4 ? new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const limit = Math.floor(n / 10);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = i * per, end = k + per; k < end; k++) {
      if (x[k] !== y[k]) {
        idx.push(i);
        break;
      }
    }
    if (idx.length > limit) return null;
  }
  const Ctor = T.constructor as Float32ArrayConstructor;
  const rows = new Ctor(idx.length * width);
  for (let q = 0; q < idx.length; q++) rows.set(T.subarray(idx[q] * width, (idx[q] + 1) * width), q * width);
  return { idx: Int32Array.from(idx), rows };
}

// 快照：原因（不大）整份复制；推导只复制、转交与上一次发的不同的数组（full 时全部），相同的写 null、列进 same
function snapshot(e: Engine, full = false): { snap: Snapshot; transfer: Transferable[] } {
  const w = e.world;
  const transfer: Transferable[] = [];
  const copy = <T extends ArrayBufferView>(a: T): T => {
    const c = (a as unknown as { slice: () => T }).slice();
    transfer.push(c.buffer as ArrayBuffer);
    return c;
  };
  const prev = full ? null : lastSent;
  const causes = {} as Snapshot['causes'];
  for (const [k, v] of Object.entries(w.causes)) {
    (causes as unknown as Record<string, unknown>)[k] = ArrayBuffer.isView(v) ? copy(v) : v;
  }
  causes.fields = Object.fromEntries(Object.entries(w.causes.fields).map(([k, v]) => [k, copy(v)]));
  const sent = { state: e.stateId, derived: new Map<string, ArrayBufferView>(), corrF: new Map<string, ArrayBufferView>() };
  const same: NonNullable<Snapshot['same']> = { base: prev?.state ?? 0, derived: [], corrF: [], rows: {} };
  const derived = {} as Snapshot['derived'];
  for (const [k, v] of Object.entries(w.derived)) {
    if (!ArrayBuffer.isView(v)) {
      (derived as unknown as Record<string, unknown>)[k] = v;
      continue;
    }
    sent.derived.set(k, v);
    const old = prev?.derived.get(k);
    if (prev && sameArray(old, v)) {
      (derived as unknown as Record<string, unknown>)[k] = null;
      same.derived.push(k);
      continue;
    }
    // 只变了一小部分格：只发那些格
    const part = old ? changedCells(old, v, w.mesh.n) : null;
    if (part) {
      (derived as unknown as Record<string, unknown>)[k] = null;
      same.rows[k] = part;
      transfer.push(part.idx.buffer as ArrayBuffer, part.rows.buffer as ArrayBuffer);
    } else (derived as unknown as Record<string, unknown>)[k] = copy(v);
  }
  derived.corrF = {};
  for (const [k, v] of Object.entries(w.derived.corrF)) {
    sent.corrF.set(k, v);
    if (prev && sameArray(prev.corrF.get(k), v)) {
      (derived.corrF as Record<string, unknown>)[k] = null;
      same.corrF.push(k);
    } else derived.corrF[k] = copy(v);
  }
  // 地图上的河：在这里描好、打包转交（主线程不再描，见 core/river-pack.ts）
  const rivers = worldRivers(w);
  transfer.push(...riverBuffers(rivers));
  // 发出去的数组之后不能就地改（下一次按它们比较）
  e.freezeDerived();
  lastSent = sent;
  return {
    snap: {
      rivers,
      settings: w.settings,
      causes,
      small: w.small,
      derived,
      history: e.history,
      canUndo: e.canUndo,
      canRedo: e.canRedo,
      timings: e.lastTimings,
      stateId: e.stateId,
      ...(prev ? { same } : {}),
    },
    transfer,
  };
}

// 只改了名字、省份：推导数组没变，不必复制、传送约 10 MB 的数据
function lightSnapshot(e: Engine): { snap: LightSnapshot; transfer: Transferable[] } {
  const w = e.world;
  // 推导数组没变（主线程沿用）：下一份只带变了的数组的快照照样以这些数组为准，状态编号换成这一次的
  if (lastSent) lastSent.state = e.stateId;
  const province = w.causes.province.slice();
  const islandType = w.causes.islandType.slice();
  return {
    snap: {
      light: true,
      small: w.small,
      features: w.derived.features,
      province,
      islandType,
      history: e.history,
      canUndo: e.canUndo,
      canRedo: e.canRedo,
      timings: e.lastTimings,
      stateId: e.stateId,
    },
    transfer: [province.buffer, islandType.buffer],
  };
}

function reply(msg: Response, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

// ---------- 检查点：打开上次的世界时直接恢复，不必重放 ----------
// 只在打包好的程序里用：版本号是引擎文件的地址（文件名带内容哈希），代码一变就不会用上旧的检查点。
// 由主线程随新建、打开告诉这里（开发时没有，不写）
let BUILD: string | null = null;
// 通往存储 Worker 的端口：主线程随新建、打开给一个新的（安全模式、开发时没有），之前的作废
let store: MessagePort | null = null;
function useStore(build: unknown, port: unknown) {
  BUILD = typeof build === 'string' && build ? build : null;
  if (store && store !== port) {
    store.onmessage = null;
    store.close();
  }
  store = port && typeof (port as MessagePort).postMessage === 'function' ? (port as MessagePort) : null;
}
let ckKey = '';
let ckAt = -Infinity;
let ckTimer: ReturnType<typeof setTimeout> | null = null;

// 写检查点（星球约 34 MB）：最多每 10 秒一次，最后一次改动之后也会补写；force：页面要被隐藏、关掉时立即写
// 安全模式下不写：检查点里的推导没有运行脚本，正常打开时不能用
function writeCheckpoint(force = false) {
  if (!BUILD || !store || !engine || safeMode) return;
  const key = engine.stepIds().join(',');
  if (key === ckKey) return;
  const wait = ckAt + 10000 - performance.now();
  if (!force && wait > 0) {
    if (!ckTimer) ckTimer = setTimeout(() => ((ckTimer = null), queue(async () => writeCheckpoint(true))), wait);
    return;
  }
  ckKey = key;
  ckAt = performance.now();
  // 从端口直接发给存储 Worker（不经过主线程）。发的时候就复制了一份（结构化克隆，与以前存进 IndexedDB 时一样只复制一次，
  // 之后的改动不影响；数组还在引擎里用着，不转移）。再告诉主线程纪元和步号：它核对与命令记录对得上，才让存储 Worker 写下
  try {
    const cp = engine.toCheckpoint();
    store.postMessage({ epoch, cp } satisfies CheckpointPut);
    post({ kind: 'checkpointReady', epoch, ids: cp.done.map((h) => h.id) });
  } catch {
    ckKey = '';
  }
}

// 打开时的检查点：从存储的端口收第一条（存储 Worker 只发对得上这个世界的，否则发 null；存着这个世界的网格时连同网格）。
// 端口留着之后写检查点用。安全模式下没有端口；等不到（存储 Worker 出了事）就照旧重放
const CHECKPOINT_WAIT_MS = 5000;
function receiveCheckpoint(port: MessagePort | null): Promise<{ cp: Checkpoint | null; mesh: PackedMesh | null }> {
  const none = { cp: null, mesh: null };
  if (!port || !BUILD || safeMode) return Promise.resolve(none);
  return new Promise((resolve) => {
    const done = (r: { cp: Checkpoint | null; mesh: PackedMesh | null }) => {
      clearTimeout(timer);
      port.onmessage = null;
      resolve(r);
    };
    const timer = setTimeout(() => done(none), CHECKPOINT_WAIT_MS);
    port.onmessage = (ev: MessageEvent<Partial<TakeReply> | null>) => {
      const cp = ev.data?.cp;
      const mesh = ev.data?.mesh;
      done({ cp: cp && typeof cp === 'object' ? cp : null, mesh: mesh && typeof mesh === 'object' ? mesh : null });
    };
  });
}

function restore(cp: Checkpoint | null, doc: WorldDoc, mesh: Mesh): Engine | null {
  if (!cp || !BUILD || safeMode) return null;
  try {
    return Engine.fromCheckpoint(cp, doc, mesh);
  } catch {
    // 对不上、恢复时出错：照旧重放
    return null;
  }
}

function post(msg: Hello | CheckpointReady | ScriptPing) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

// 请求一个接一个处理（打开时要等检查点）。第一件事是自查是不是在隔离的环境里、跟主线程打招呼：
// 招呼发出之前不处理任何请求，脚本也就不可能抢在前面伪造一条“隔离了”
let chain: Promise<void> = probeIsolation(self).then(
  (isolated) => post({ kind: 'hello', isolated }),
  () => post({ kind: 'hello', isolated: false }),
);
// 一件出了错（比如后台补写检查点时重算出错）不能让后面的都不再处理
function queue(run: () => Promise<void>) {
  chain = chain.then(run).catch(() => undefined);
}

// 收到了还没算完的确切预览（排着的和正在算的；分阶段算，阶段之间让出线程，见 previewWorld）：新来的请求要它们停下时
// cancelled 设为 true，排着的轮到时直接不算，正在算的在下一个阶段之间停下。收到同一条命令的执行时 adopt 设为 true：
// 执行要直接采用它，之后不再停
interface PreviewRun {
  key: string;
  cancelled: boolean;
  adopt: boolean;
}
const previewRuns = new Map<number, PreviewRun>();

// 新来的请求：要不要停下收到了的预览。执行别的命令、撤销、重做、新建、打开、要别的预览、取消时停；执行同一条命令时留着
const CANCELS = new Set<Request['kind']>(['exec', 'replaceLast', 'undo', 'redo', 'init', 'load', 'previewWorld', 'preview', 'cancelPreview']);
function maybeCancelPreview(req: Request) {
  if (!previewRuns.size || !CANCELS.has(req.kind)) return;
  const key = req.kind === 'exec' ? JSON.stringify(req.cmd) : null;
  for (const run of previewRuns.values()) {
    if (run.adopt) continue;
    if (key !== null && key === run.key) run.adopt = true;
    else run.cancelled = true;
  }
}

// 让出线程（这时 onmessage 收得到新的消息）
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

self.onmessage = (ev: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = ev.data;
  maybeCancelPreview(req);
  if (req?.kind === 'previewWorld') previewRuns.set(id, { key: JSON.stringify(req.cmd), cancelled: false, adopt: false });
  // 取消立即回复，不排在正在算的预览后面
  if (req.kind === 'cancelPreview') {
    reply({ id, ok: true });
    return;
  }
  queue(() => handle(id, req));
};

async function handle(id: number, req: Request) {
  try {
    // light：这一步只重算了名字（或什么都没重算）时发轻快照。fresh：新建、打开（带上是不是安全模式）
    const withSnap = (summary?: string, light = false, fresh = false) => {
      const deep = engine!.takeRecomputed();
      const { snap, transfer } = light && deep <= Dirty.Names ? lightSnapshot(engine!) : snapshot(engine!);
      const log = logOf(engine!);
      reply({ id, ok: true, summary, snapshot: snap, log, ...(fresh ? { safe: safeMode } : {}) }, transfer);
      reported = log.ids;
    };
    switch (req.kind) {
      case 'init': {
        useSafeMode(req.safe);
        useStore(req.build, safeMode ? null : req.store);
        const e = new Engine(req.settings, meshFor(req.settings));
        for (const cmd of req.commands ?? []) e.exec(cmd);
        e.update();
        useEngine(e);
        withSnap('新世界', false, true);
        return;
      }
      case 'load': {
        useSafeMode(req.safe);
        useStore(req.build, safeMode ? null : req.store);
        // 先收存储 Worker 发来的检查点和网格（存着这个世界的网格时不必再建）
        const got = await receiveCheckpoint(store);
        const mesh = meshFor(req.doc.settings, got.mesh);
        const restored = restore(got.cp, req.doc, mesh);
        useEngine(restored ?? Engine.fromDoc(req.doc, mesh));
        withSnap('已打开世界文件', false, true);
        if (restored) {
          ckKey = restored.stepIds().join(',');
          // 恢复的世界还没有地形底图的缓存：先发快照让地图显示出来，再在后台补上（下一次改地形就不必等）
          queue(async () => {
            if (engine === restored) resolveTerrain(restored.world);
          });
        }
        return;
      }
      case 'exec': {
        const summary = engine!.exec(req.cmd);
        // 什么都没改（比如在陆地上画陆地）：世界不变，不发快照（命令记录也没变）
        if (engine!.lastNoop) reply({ id, ok: true, summary, noop: true });
        else withSnap(summary, true);
        return;
      }
      case 'undo':
        engine!.undo();
        withSnap('撤销', true);
        return;
      case 'redo':
        engine!.redo();
        withSnap('重做', true);
        return;
      case 'previewWorld': {
        // 分阶段算：阶段之间让出线程，新的一笔、松手执行别的命令时在那里停下（回 cancelled），不必等它算完
        const run = previewRuns.get(id) ?? { key: '', cancelled: false, adopt: false };
        try {
          if (run.cancelled) {
            reply({ id, ok: true, cancelled: true });
            return;
          }
          const steps = engine!.previewWorldSteps(req.cmd);
          for (;;) {
            const r = steps.next();
            if (r.done) {
              // 差别里的数组是副本的（副本留着给紧接着的执行采用）：不转移，结构化克隆复制一份发过去。
              // 预览世界的河也在这里描好（主线程画将来的样子时直接用）
              const rivers = worldRivers(previewWorldOf(engine!.world, r.value.patch));
              reply({ id, ok: true, preview: r.value.result, world: r.value.patch, rivers }, riverBuffers(rivers));
              return;
            }
            await yieldNow();
            if (run.cancelled) {
              steps.return(undefined as never);
              reply({ id, ok: true, cancelled: true });
              return;
            }
          }
        } finally {
          previewRuns.delete(id);
        }
      }
      case 'cancelPreview':
        reply({ id, ok: true });
        return;
      case 'preview':
        reply({ id, ok: true, preview: engine!.preview(req.cmd) });
        return;
      case 'previewProvinces': {
        const provinces = engine!.previewProvinces(req.cmd);
        reply({ id, ok: true, provinces }, [provinces.province.buffer as ArrayBuffer]);
        return;
      }
      case 'previewTerrain': {
        const t0 = performance.now();
        const terrain = previewTerrain(engine!.world, req.patch);
        terrain.ms = performance.now() - t0;
        // 每格的海岸值（幽灵海岸用）直接转交，不复制
        reply({ id, ok: true, terrain }, [terrain.coast.buffer as ArrayBuffer]);
        return;
      }
      case 'replaceLast':
        withSnap(engine!.replaceLast(req.cmd), true);
        return;
      case 'doc':
        reply({ id, ok: true, doc: engine!.toDoc() });
        return;
      case 'snapshot': {
        const { snap, transfer } = snapshot(engine!, true);
        reply({ id, ok: true, snapshot: snap }, transfer);
        return;
      }
      case 'docTail':
        reply({ id, ok: true, tail: engine!.docTail(req.ids) });
        writeCheckpoint();
        return;
      case 'checkpoint':
        writeCheckpoint(true);
        reply({ id, ok: true });
        return;
      case 'thumb': {
        const settings = { ...req.settings, cells: 4000 };
        const e = new Engine(settings, meshFor(settings));
        e.features = false;
        e.exec({ op: 'set_worldgen', params: req.gen, reset: true });
        const thumb = renderThumbnail(e.world, req.width, req.height);
        // 星球形态的脚本出的错（形态编辑器写在缩略图下面）：只在有形态时带上
        const issues = req.gen.form ? planetFormIssues(e.world) : undefined;
        reply({ id, ok: true, thumb, ...(issues ? { issues } : {}) }, [thumb.buffer as ArrayBuffer]);
        return;
      }
    }
  } catch (e) {
    reply({ id, ok: false, error: (e as Error).message });
  }
}
