/// <reference lib="webworker" />
import { type PackedMesh, packMesh, packedBuffers, storedMeshKey } from '../core/mesh-pack';
import { type Settings, buildMeshFor, settingsSchema } from '../core/world';
import { idbGet, openDb } from './idb';

// 建网格的 Worker：新建、打开世界时，主线程要的网格（整个星球还有显示用的三角网、Voronoi 多边形）在这里建好、转交过去，
// 与计算 Worker 同时算，主线程不再停顿约 1 秒。与页面同源，不运行脚本。
// 建好的网格（打包的样子）另存进 IndexedDB 的 meshes 表（只留最近的一个，键带上程序的版本号）：下次打开同一个世界时
// 这里直接读出来，计算 Worker 也经存储 Worker 拿到同一份（见 checkpoint-store.ts），都不必再建（星球上约 1–3 秒）

export interface MeshRequest {
  id: number;
  settings: Partial<Settings>;
  // 程序的版本号（检查点的那个）：没有时不读不存
  build: string | null;
}

// meshes 表里 'current' 的样子
export interface StoredMesh {
  key: string;
  mesh: PackedMesh;
}

async function cached(key: string): Promise<PackedMesh | null> {
  try {
    const hit = await idbGet<StoredMesh>('meshes', 'current');
    return hit && hit.key === key && hit.mesh ? hit.mesh : null;
  } catch {
    return null;
  }
}

// 存下（put 的那一刻就结构化克隆了一份，之后转交数组不影响存下的；写盘在后台进行）。存不了就算了
async function store(key: string, mesh: PackedMesh): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction('meshes', 'readwrite');
    tx.objectStore('meshes').put({ key, mesh } satisfies StoredMesh, 'current');
    tx.oncomplete = tx.onerror = tx.onabort = () => db.close();
  } catch {
    // 存不了：下次再建
  }
}

self.onmessage = async (ev: MessageEvent<MeshRequest>) => {
  const { id, settings, build } = ev.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
  try {
    const s = settingsSchema.parse(settings);
    const key = build ? storedMeshKey(build, s) : null;
    const hit = key ? await cached(key) : null;
    if (hit) {
      post({ id, ok: true, mesh: hit }, packedBuffers(hit));
      return;
    }
    const { packed, transfer } = packMesh(buildMeshFor(s));
    if (key) await store(key, packed);
    post({ id, ok: true, mesh: packed }, transfer);
  } catch (e) {
    post({ id, ok: false, error: (e as Error).message });
  }
};
