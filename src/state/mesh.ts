import type { Mesh } from '../../core/mesh';
import { type PackedMesh, unpackMesh } from '../../core/mesh-pack';
import { viewOf } from '../../core/sphere';
import { type Settings, buildMeshFor, meshKey, settingsSchema } from '../../core/world';
import type { MeshRequest } from '../mesh-worker';

// 主线程上的网格（第七十轮从 state.ts 分出来）：按设置缓存一份；新建、打开时在建网格的 Worker（mesh-worker.ts）里先建好

let meshCache: { key: string; mesh: Mesh } | null = null;

export function meshFor(s: Settings): Mesh {
  const key = meshKey(s);
  if (meshCache?.key !== key) meshCache = { key, mesh: buildMeshFor(s) };
  return meshCache.mesh;
}

// 新建、打开时：Worker 在算的同时，主线程要的网格（整个星球还有显示用的三角网、多边形）在另一个 Worker 里建好转交过来
// （mesh-worker.ts，与计算 Worker 同时算），主线程不再为建网格停顿约 1 秒。没有 Worker 时（测试里）先让出一帧再就地建。
// 返回建好（或建不成）时兑现的承诺：换上快照之前等它，快照里的世界就用这份网格。build：检查点的版本号（worker-host.ts 的 hostOpts）
export function prebuildMesh(settings: Partial<Settings>, build: string | null): Promise<void> {
  let s: Settings;
  try {
    s = settingsSchema.parse(settings);
  } catch {
    // 设置无效时 Worker 会报错，这里不管
    return Promise.resolve();
  }
  const key = meshKey(s);
  if (meshCache?.key === key) return Promise.resolve();
  if (typeof Worker === 'undefined' || typeof document === 'undefined') {
    return new Promise((resolve) =>
      setTimeout(() => {
        try {
          const mesh = meshFor(s);
          if (mesh.kind === 'sphere') viewOf(mesh).polygons();
        } finally {
          resolve();
        }
      }, 0),
    );
  }
  const w = meshWorker();
  if (!w) return Promise.resolve();
  const id = ++meshSeq;
  return new Promise<void>((resolve) => {
    // 建网格的 Worker 迟迟不回（比如它读 IndexedDB 卡住了）：最多等 MESH_WAIT_MS，之后不等了，换上快照时在主线程上就地建
    const timer = setTimeout(() => {
      if (meshWaiters.delete(id)) resolve();
    }, MESH_WAIT_MS);
    meshWaiters.set(id, (packed) => {
      clearTimeout(timer);
      // 等的时候换成了别的网格（又新建了一个别的大小）就不要了
      if (packed && meshCache?.key !== key) {
        try {
          meshCache = { key, mesh: unpackMesh(packed) };
        } catch {
          // 拆不了：换上快照时就地建
        }
      }
      resolve();
    });
    try {
      w.postMessage({ id, settings: s, build } satisfies MeshRequest);
    } catch {
      meshWaiters.delete(id);
      resolve();
    }
  });
}

// 新建、打开时最多等建网格的 Worker 这么久（毫秒）
const MESH_WAIT_MS = 6000;

// 建网格的 Worker（一直留着：它写 IndexedDB 时不能被停掉）。开不了、出了事就不再用，换上快照时就地建
let meshWorkerRef: Worker | null = null;
let meshBroken = false;
let meshSeq = 0;
const meshWaiters = new Map<number, (mesh: PackedMesh | null) => void>();
function meshWorker(): Worker | null {
  if (meshBroken) return null;
  if (meshWorkerRef) return meshWorkerRef;
  try {
    const w = new Worker(new URL('../mesh-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; mesh?: PackedMesh }>) => {
      const done = meshWaiters.get(ev.data.id);
      meshWaiters.delete(ev.data.id);
      done?.(ev.data.ok && ev.data.mesh ? ev.data.mesh : null);
    };
    // 出了错、收到的消息拆不开：不再用它，等着的都按没建成算（换上快照时就地建）
    w.onerror = w.onmessageerror = () => {
      meshBroken = true;
      meshWorkerRef = null;
      const waiting = [...meshWaiters.values()];
      meshWaiters.clear();
      for (const done of waiting) done(null);
    };
    meshWorkerRef = w;
    return w;
  } catch {
    meshBroken = true;
    return null;
  }
}
