/// <reference lib="webworker" />
import { exportPackage, exportPart } from '../core/export';
import { buildMeshFor, kmPerUnit } from '../core/world';
import { compactJob } from './compact-job';
import type { CompactJob, CompactReply, ExportJob, ExportReply } from './protocol';

// 导出 Worker：拿到世界（原因、推导、小数据）与世界文件，在自己的线程里生成游戏文件包；第二十九轮起也在这里压缩世界文件（compact-job.ts）。
// 与计算 Worker 分开：大图要好几秒到几分钟，期间照样能看地图、改地图；取消就是结束这个 Worker

function post(msg: ExportReply, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<ExportJob | CompactJob>) => {
  if ('compact' in ev.data) {
    try {
      (self as DedicatedWorkerGlobalScope).postMessage(compactJob(ev.data));
    } catch (e) {
      (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, error: (e as Error).message } satisfies CompactReply);
    }
    return;
  }
  const { settings, causes, small, derived, doc, opts, part } = ev.data;
  try {
    const world = { settings, mesh: buildMeshFor(settings), kmPerUnit: kmPerUnit(settings), causes, small, derived };
    // 分开导出的一项（第二十四轮）
    if (part) {
      const files = exportPart(world, part.id, { width: part.width, height: part.height });
      post({ ok: true, files }, Object.values(files).map((f) => f.buffer as ArrayBuffer));
      return;
    }
    const r = exportPackage(world, doc, opts, (progress) => post({ progress }));
    post({ ok: true, zip: r.zip, warnings: r.warnings }, [r.zip.buffer as ArrayBuffer]);
  } catch (e) {
    post({ ok: false, error: (e as Error).message });
  }
};
