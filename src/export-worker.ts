/// <reference lib="webworker" />
import { exportPackage } from '../core/export';
import { buildMeshFor, kmPerUnit } from '../core/world';
import type { ExportJob, ExportReply } from './protocol';

// 导出 Worker：拿到世界（原因、推导、小数据）与世界文件，在自己的线程里生成游戏文件包。
// 与计算 Worker 分开：大图要好几秒到几分钟，期间照样能看地图、改地图；取消就是结束这个 Worker

function post(msg: ExportReply, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<ExportJob>) => {
  const { settings, causes, small, derived, doc, opts } = ev.data;
  try {
    const world = { settings, mesh: buildMeshFor(settings), kmPerUnit: kmPerUnit(settings), causes, small, derived };
    const r = exportPackage(world, doc, opts);
    post({ ok: true, zip: r.zip }, [r.zip.buffer as ArrayBuffer]);
  } catch (e) {
    post({ ok: false, error: (e as Error).message });
  }
};
