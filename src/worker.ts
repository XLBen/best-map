/// <reference lib="webworker" />
import { Dirty } from '../core/commands';
import { type Checkpoint, Engine, type WorldDoc } from '../core/engine';
import { previewTerrain, resolveTerrain } from '../core/terrain';
import { renderThumbnail } from '../core/thumbnail';
import type { Mesh } from '../core/mesh';
import { type Settings, buildMeshFor, meshKey, settingsSchema } from '../core/world';
import { idbGet, idbTx } from './idb';
import type { LightSnapshot, Request, Response, Snapshot } from './protocol';

// 计算 Worker：持有引擎；每次状态变化后把原因与推导的副本发回主线程

let engine: Engine | null = null;

// 网格缓存：当前世界的网格和向导缩略图用的小网格（同一个大小、种子再新建或打开时不必重建）
const meshes = new Map<string, Mesh>();
function meshFor(raw: Partial<Settings>): Mesh {
  const s = settingsSchema.parse(raw);
  const key = meshKey(s);
  let m = meshes.get(key);
  if (m) meshes.delete(key);
  else m = buildMeshFor(s);
  meshes.set(key, m);
  // 大网格（连同挂在它上面的缓存有几十 MB）只留最近用的一个；缩略图的小网格最多留两个
  if (m.n > 5000) for (const [k, v] of meshes) if (k !== key && v.n > 5000) meshes.delete(k);
  while (meshes.size > 3) meshes.delete(meshes.keys().next().value!);
  return m;
}

function snapshot(e: Engine): { snap: Snapshot; transfer: Transferable[] } {
  const w = e.world;
  const transfer: Transferable[] = [];
  const copy = <T extends ArrayBufferView>(a: T): T => {
    const c = (a as unknown as { slice: () => T }).slice();
    transfer.push(c.buffer as ArrayBuffer);
    return c;
  };
  const causes = {} as Snapshot['causes'];
  for (const [k, v] of Object.entries(w.causes)) {
    (causes as unknown as Record<string, unknown>)[k] = ArrayBuffer.isView(v) ? copy(v) : v;
  }
  causes.fields = Object.fromEntries(Object.entries(w.causes.fields).map(([k, v]) => [k, copy(v)]));
  const derived = {} as Snapshot['derived'];
  for (const [k, v] of Object.entries(w.derived)) {
    (derived as unknown as Record<string, unknown>)[k] = ArrayBuffer.isView(v) ? copy(v) : v;
  }
  derived.corrF = Object.fromEntries(Object.entries(w.derived.corrF).map(([k, v]) => [k, copy(v)]));
  return {
    snap: {
      settings: w.settings,
      causes,
      small: w.small,
      derived,
      history: e.history,
      canUndo: e.canUndo,
      canRedo: e.canRedo,
      timings: e.lastTimings,
      stateId: e.stateId,
    },
    transfer,
  };
}

// 只改了名字、省份：推导数组没变，不必复制、传送约 10 MB 的数据
function lightSnapshot(e: Engine): { snap: LightSnapshot; transfer: Transferable[] } {
  const w = e.world;
  const province = w.causes.province.slice();
  return {
    snap: {
      light: true,
      small: w.small,
      features: w.derived.features,
      province,
      history: e.history,
      canUndo: e.canUndo,
      canRedo: e.canRedo,
      timings: e.lastTimings,
      stateId: e.stateId,
    },
    transfer: [province.buffer],
  };
}

function reply(msg: Response, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

// ---------- 检查点：存进 IndexedDB，打开上次的世界时直接恢复 ----------
// 只在打包好的程序里用：Worker 文件名带内容哈希，代码一变就不会用上旧的检查点（开发时文件名不变，不用）
const BUILD = import.meta.env.DEV ? null : import.meta.url;
let ckKey = '';
let ckAt = -Infinity;
let ckTimer: ReturnType<typeof setTimeout> | null = null;

// 写检查点（星球约 34 MB）：最多每 10 秒一次，最后一次改动之后也会补写；force：页面要被隐藏、关掉时立即写
function writeCheckpoint(force = false) {
  if (!BUILD || !engine) return;
  const key = engine.stepIds().join(',');
  if (key === ckKey) return;
  const wait = ckAt + 10000 - performance.now();
  if (!force && wait > 0) {
    if (!ckTimer) ckTimer = setTimeout(() => ((ckTimer = null), queue(async () => writeCheckpoint(true))), wait);
    return;
  }
  ckKey = key;
  ckAt = performance.now();
  // put 时就复制了数据（结构化克隆），之后的改动不影响；写盘在后台进行
  void idbTx(['checkpoint'], 'readwrite', (s) => s.put({ build: BUILD, cp: engine!.toCheckpoint() }, 'current')).catch(() => (ckKey = ''));
}

async function restore(doc: WorldDoc, mesh: Mesh): Promise<Engine | null> {
  if (!BUILD) return null;
  try {
    const saved = await idbGet<{ build: string; cp: Checkpoint }>('checkpoint', 'current');
    return saved && saved.build === BUILD ? Engine.fromCheckpoint(saved.cp, doc, mesh) : null;
  } catch {
    // 读不了或对不上：照旧重放
    return null;
  }
}

// 请求一个接一个处理（有的要等 IndexedDB）
let chain: Promise<void> = Promise.resolve();
function queue(run: () => Promise<void>) {
  chain = chain.then(run);
}

self.onmessage = (ev: MessageEvent<{ id: number; req: Request }>) => queue(() => handle(ev.data.id, ev.data.req));

async function handle(id: number, req: Request) {
  try {
    // light：这一步只重算了名字（或什么都没重算）时发轻快照
    const withSnap = (summary?: string, light = false) => {
      const deep = engine!.takeRecomputed();
      const { snap, transfer } = light && deep <= Dirty.Names ? lightSnapshot(engine!) : snapshot(engine!);
      reply({ id, ok: true, summary, snapshot: snap }, transfer);
    };
    switch (req.kind) {
      case 'init': {
        engine = new Engine(req.settings, meshFor(req.settings));
        for (const cmd of req.commands ?? []) engine.exec(cmd);
        engine.update();
        withSnap('新世界');
        return;
      }
      case 'load': {
        const mesh = meshFor(req.doc.settings);
        const restored = await restore(req.doc, mesh);
        engine = restored ?? Engine.fromDoc(req.doc, mesh);
        withSnap('已打开世界文件');
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
        // 什么都没改（比如在陆地上画陆地）：世界不变，不发快照
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
        // 差别里的数组是副本的（副本留着给紧接着的执行采用）：不转移，结构化克隆复制一份发过去
        const { result, patch } = engine!.previewWorld(req.cmd);
        reply({ id, ok: true, preview: result, world: patch });
        return;
      }
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
        // 与向导建出的世界一样打开山挡风（生态颜色跟着拐过的风算），同一步里只算一遍
        e.exec({
          op: 'batch',
          commands: [
            { op: 'set_worldgen', params: req.gen, reset: true },
            { op: 'set_planet', patch: { terrainWind: 1 } },
          ],
        });
        const thumb = renderThumbnail(e.world, req.width, req.height);
        reply({ id, ok: true, thumb }, [thumb.buffer as ArrayBuffer]);
        return;
      }
    }
  } catch (e) {
    reply({ id, ok: false, error: (e as Error).message });
  }
}
