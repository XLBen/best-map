/// <reference lib="webworker" />
import { Dirty } from '../core/commands';
import { Engine } from '../core/engine';
import { exportPackage } from '../core/export';
import { previewTerrain } from '../core/terrain';
import { renderThumbnail } from '../core/thumbnail';
import type { LightSnapshot, Request, Response, Snapshot } from './protocol';

// 计算 Worker：持有引擎；每次状态变化后把原因与推导的副本发回主线程

let engine: Engine | null = null;

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
    },
    transfer: [province.buffer],
  };
}

function reply(msg: Response, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = ev.data;
  try {
    // light：这一步只重算了名字（或什么都没重算）时发轻快照
    const withSnap = (summary?: string, light = false) => {
      const deep = engine!.takeRecomputed();
      const { snap, transfer } = light && deep <= Dirty.Names ? lightSnapshot(engine!) : snapshot(engine!);
      reply({ id, ok: true, summary, snapshot: snap }, transfer);
    };
    switch (req.kind) {
      case 'init': {
        engine = new Engine(req.settings);
        for (const cmd of req.commands ?? []) engine.exec(cmd);
        engine.update();
        withSnap('新世界');
        return;
      }
      case 'load': {
        engine = Engine.fromDoc(req.doc);
        withSnap('已打开世界文件');
        return;
      }
      case 'exec':
        withSnap(engine!.exec(req.cmd), true);
        return;
      case 'undo':
        engine!.undo();
        withSnap('撤销', true);
        return;
      case 'redo':
        engine!.redo();
        withSnap('重做', true);
        return;
      case 'preview':
        reply({ id, ok: true, preview: engine!.preview(req.cmd) });
        return;
      case 'previewTerrain':
        reply({ id, ok: true, terrain: previewTerrain(engine!.world, req.patch) });
        return;
      case 'replaceLast':
        withSnap(engine!.replaceLast(req.cmd), true);
        return;
      case 'export': {
        const r = exportPackage(engine!.world, engine!.toDoc(), req.opts);
        reply({ id, ok: true, zip: r.zip }, [r.zip.buffer as ArrayBuffer]);
        return;
      }
      case 'doc':
        reply({ id, ok: true, doc: engine!.toDoc() });
        return;
      case 'thumbs': {
        const thumbs: Uint8ClampedArray[] = [];
        let mesh: Engine['world']['mesh'] | undefined;
        for (const gen of req.gens) {
          const e = new Engine({ ...req.settings, cells: 4000 }, mesh);
          mesh = e.world.mesh;
          e.exec({ op: 'set_worldgen', params: gen, reset: true });
          thumbs.push(renderThumbnail(e.world, req.width, req.height));
        }
        reply({ id, ok: true, thumbs }, thumbs.map((t) => t.buffer as ArrayBuffer));
        return;
      }
    }
  } catch (e) {
    reply({ id, ok: false, error: (e as Error).message });
  }
};
