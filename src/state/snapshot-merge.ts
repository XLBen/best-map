import type { World } from '../../core/world';
import type { LightSnapshot, Snapshot } from '../protocol';

// 主线程把快照拼到手上的世界上（第八十轮从 worker-host.ts 搬来，测试直接调）

// 只带变了的推导数组、原因数组的快照（Snapshot.same）：没发的数组沿用手上世界的同一个对象（着色、河线的缓存照样命中）。
// prev、prevState：手上的世界与它的状态编号。手上的世界不是 Worker 上一次发快照时的状态、网格不同时拼不起来，返回 null。完整的快照原样返回
export function mergeSnapshot(prev: World | null, prevState: number, s: Snapshot): Snapshot | null {
  const same = s.same;
  if (!same) return s;
  if (!prev || prevState !== same.base || prev.derived.corrF === undefined) return null;
  const pd = prev.derived as unknown as Record<string, unknown>;
  const d = s.derived as unknown as Record<string, unknown>;
  for (const k of same.derived) {
    const v = pd[k];
    if (!ArrayBuffer.isView(v) || d[k] !== null) return null;
    d[k] = v;
  }
  for (const [k, part] of Object.entries(same.rows ?? {})) {
    const v = pd[k] as Float32Array | undefined;
    if (!ArrayBuffer.isView(v) || d[k] !== null) return null;
    const n = prev.mesh.n;
    const width = v.length / n;
    const rows = part.rows as Float32Array;
    if (!Number.isInteger(width) || rows.constructor !== v.constructor || rows.length !== part.idx.length * width) return null;
    const out = v.slice();
    for (let q = 0; q < part.idx.length; q++) out.set(rows.subarray(q * width, (q + 1) * width), part.idx[q] * width);
    d[k] = out;
  }
  for (const k of same.objects ?? []) {
    const v = pd[k];
    if (v === undefined || v === null || d[k] !== null) return null;
    d[k] = v;
  }
  for (const k of same.corrF) {
    const v = prev.derived.corrF[k];
    if (!v || (s.derived.corrF as Record<string, unknown>)[k] !== null) return null;
    s.derived.corrF[k] = v;
  }
  // 第八十轮：没变的原因数组、自定义场同样沿用手上的（只改了国名、颜色时领土、人口的数组还是同一个对象，国家的缓存照样命中）
  const pc = prev.causes as unknown as Record<string, unknown>;
  const c = s.causes as unknown as Record<string, unknown>;
  for (const k of same.causes ?? []) {
    const v = pc[k];
    if (!ArrayBuffer.isView(v) || c[k] !== null) return null;
    c[k] = v;
  }
  for (const k of same.fields ?? []) {
    const v = prev.causes.fields[k];
    if (!v || (s.causes.fields as Record<string, unknown>)[k] !== null) return null;
    s.causes.fields[k] = v;
  }
  return s;
}

// 轻快照：推导数组沿用当前世界的（同一批数组对象，地图据此跳过重新着色）；省份、岛的种类没变时这两个数组也沿用
export function lightWorld(prev: World, s: LightSnapshot): World {
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const sameProvince = same(prev.causes.province, s.province);
  const sameIsland = same(prev.causes.islandType, s.islandType);
  const causes =
    sameProvince && sameIsland
      ? prev.causes
      : { ...prev.causes, province: sameProvince ? prev.causes.province : s.province, islandType: sameIsland ? prev.causes.islandType : s.islandType };
  return { ...prev, causes, small: s.small, derived: s.features ? { ...prev.derived, features: s.features } : { ...prev.derived } };
}
