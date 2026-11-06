import { signal } from '@preact/signals';
import type { ExportOptions, ExportPartId } from '../../core/export';
import type { ExportJob, ExportReply } from '../protocol';
import { showToast } from './notes';
import { getDoc } from './worker-host';
import { world } from './world';

// 导出（第七十轮从 state.ts 分出来）：在导出 Worker（export-worker.ts）里写文件包、单独导出的一项；下载

// 导出：在单独的 Worker 里用主线程上的这一份世界生成（期间照样能看、能改地图），进度显示在顶部，可以取消
export const exportProgress = signal<number | null>(null);
// 正在导出的一件（游戏文件包或分开导出的一项）：取消时 done(null)
let exporting: { worker: Worker; done: (v: null) => void } | null = null;

export async function exportZip(opts: ExportOptions): Promise<Uint8Array | null> {
  const w = world.value;
  const doc = await getDoc();
  if (!w || !doc) return null;
  cancelExport();
  const worker = new Worker(new URL('../export-worker.ts', import.meta.url), { type: 'module' });
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
      else if ('warnings' in r && r.warnings?.length) showToast(r.warnings.join('；'), true);
      job.done(r.ok && 'zip' in r ? r.zip : null);
    };
    worker.onerror = () => {
      showToast('导出失败', true);
      job.done(null);
    };
    const msg: ExportJob = { settings: w.settings, causes: w.causes, small: w.small, derived: w.derived, doc, opts };
    worker.postMessage(msg);
  });
}

// 分开导出的一项（第二十四轮，“导出”里的“单独导出”）：在导出 Worker 里写好这一项的文件（图要几秒）。取消、出错时为 null
export async function exportPartFiles(id: ExportPartId, width: number): Promise<Record<string, Uint8Array> | null> {
  const w = world.value;
  const doc = await getDoc();
  if (!w || !doc) return null;
  cancelExport();
  const worker = new Worker(new URL('../export-worker.ts', import.meta.url), { type: 'module' });
  exportProgress.value = 0;
  return new Promise((resolve) => {
    const job = {
      worker,
      done: (files: Record<string, Uint8Array> | null) => {
        worker.terminate();
        if (exporting === job) {
          exporting = null;
          exportProgress.value = null;
        }
        resolve(files);
      },
    };
    exporting = job;
    worker.onmessage = (ev: MessageEvent<ExportReply>) => {
      const r = ev.data;
      if ('progress' in r) return;
      if (!r.ok) showToast(r.error, true);
      job.done(r.ok && 'files' in r ? r.files : null);
    };
    worker.onerror = () => {
      showToast('导出失败', true);
      job.done(null);
    };
    const height = Math.round((width * w.mesh.height) / w.mesh.width);
    const msg: ExportJob = { settings: w.settings, causes: w.causes, small: w.small, derived: w.derived, doc, opts: { width, height, seaLevelGray: 95, maxElevation: 6000 }, part: { id, width, height } };
    worker.postMessage(msg);
  });
}

export function cancelExport() {
  exporting?.done(null);
  imageExportCancel.current?.();
}

// 导出整张地图（.png，ui/map/export.ts 的 exportFullMap）正在画时登记的取消：顶部提示条上的“取消”也停它
export const imageExportCancel: { current: (() => void) | null } = { current: null };

export function download(name: string, data: Uint8Array | string | Blob, type: string) {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
