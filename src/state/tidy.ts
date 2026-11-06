import type { RemovedItem } from '../../core/commands';
import type { ContentRef } from '../../core/content/unused';
import type { WorldDoc } from '../../core/engine';
import type { TidyPlan } from '../../core/tidy';
import { keepInLibrary } from '../library';
import { activeLink, defaultMapName, fileHint, mapLink } from '../maps';
import type { CompactReply } from '../protocol';
import { showToast } from './notes';
import { busy, call } from './worker-host';
import { world, worldEpoch } from './world';

// 第七十轮从 state.ts 分出来

// ---------- 拿掉的不丢、整理、压缩（第二十九轮） ----------

// 世界的叫法（存进资源库的“来自《世界名》”）：连着的“我的地图”的名字，打开的文件名，或最大的一块陆地的名字
export function worldName(): string {
  const link = activeLink(mapLink.value, worldEpoch.value);
  if (link) return link.name;
  const hint = fileHint.value;
  if (hint && hint.epoch === worldEpoch.value && hint.name) return hint.name;
  return defaultMapName(world.value?.derived.features ?? [], []);
}

// 移出世界的内容：自己做的、改过的存进资源库（内置原样的本来就在资源包里；一模一样的不重复存）。存了几项
export async function keepRemoved(items: readonly RemovedItem[], name = worldName()): Promise<number> {
  try {
    const r = await keepInLibrary(name, items);
    if (r.saved) showToast(`${r.saved} 项存进了资源库`);
    if (r.full.length) showToast(`资源库里放不下：${r.full.slice(0, 2).join('、')}`, true);
    return r.saved;
  } catch {
    return 0;
  }
}

// 整理本世界的计划（在 Worker 里的副本上试，世界不变）。only：只考虑这几项。出错时 null
export async function planTidy(only?: ContentRef[], label: string | null = '正在检查…'): Promise<TidyPlan | null> {
  const r = await call({ kind: 'planTidy', ...(only ? { only } : {}) }, label);
  return r.ok ? (r.tidy ?? null) : null;
}

// 压缩要写出去的世界文件（导出、存进“我的地图”）：在导出 Worker 里重放两遍，核对过的才用，不然用原来的。
// 当前打开的世界不变
const COMPACTING = '正在整理世界文件…';
export async function compactForSave(doc: WorldDoc): Promise<WorldDoc> {
  if (typeof Worker === 'undefined') return doc;
  const prev = busy.value;
  busy.value = COMPACTING;
  try {
    const reply = await new Promise<CompactReply>((resolve) => {
      const worker = new Worker(new URL('../export-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<CompactReply>) => {
        worker.terminate();
        resolve(ev.data);
      };
      worker.onerror = () => {
        worker.terminate();
        resolve({ ok: false, error: '压缩失败' });
      };
      worker.postMessage({ compact: doc });
    });
    if (!reply.ok || !('compacted' in reply)) return doc;
    const c = reply.compacted;
    return c.verified ? c.doc : doc;
  } catch {
    return doc;
  } finally {
    if (busy.value === COMPACTING) busy.value = prev;
  }
}
