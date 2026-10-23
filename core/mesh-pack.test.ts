import { describe, expect, it } from 'vitest';
import { packMesh, unpackMesh } from './mesh-pack';
import { type Mesh, findCell } from './mesh';
import { viewOf } from './sphere';
import { buildMeshFor, settingsSchema } from './world';

// 在别的 Worker 里建好网格、打包转交、拆包：与就地建的网格逐值相同，查格（findCell、locate）结果也相同

function sameBytes(p: ArrayBufferView, q: ArrayBufferView): boolean {
  if (p.byteLength !== q.byteLength || p.constructor !== q.constructor) return false;
  const u = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  const v = new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
  for (let k = 0; k < u.length; k++) if (u[k] !== v[k]) return false;
  return true;
}

// 结构化克隆再拆包（与 postMessage 转交一样：数组都是新的）
function roundTrip(m: Mesh): Mesh {
  const { packed } = packMesh(m);
  return unpackMesh(structuredClone(packed));
}

describe('网格打包、拆包后与就地建的逐值相同', () => {
  it.each([
    ['地区', { seed: 3, cells: 3000, aspect: 1.6 }],
    ['整个星球', { seed: 5, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
  ] as const)('%s', (_name, raw) => {
    const s = settingsSchema.parse(raw);
    const a = buildMeshFor(s);
    const b = roundTrip(buildMeshFor(s));
    expect(b.kind).toBe(a.kind);
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const [k, v] of Object.entries(a)) {
      const w = (b as unknown as Record<string, unknown>)[k];
      if (ArrayBuffer.isView(v)) expect(sameBytes(v, w as ArrayBufferView), k).toBe(true);
      else if (typeof v === 'number' || typeof v === 'string') expect(Object.is(w, v), k).toBe(true);
    }
    // 查格：按坐标找格（地区用 Delaunay，星球用显示的三角网）在一片网格点上结果相同
    let hint = 0;
    for (let k = 0; k < 400; k++) {
      const x = (k * 0.6180339887) % a.width;
      const y = (k * 0.41421356) % 1;
      const ca = findCell(a, x, y, hint);
      const cb = findCell(b, x, y, hint);
      expect(cb).toBe(ca);
      hint = ca;
    }
    if (a.kind === 'sphere' && b.kind === 'sphere') {
      const va = viewOf(a);
      const vb = viewOf(b);
      for (const k of ['x', 'y', 'cellOf', 'triangles'] as const) expect(sameBytes(va[k], vb[k]), k).toBe(true);
      const pa = va.polygons();
      const pb = vb.polygons();
      for (const k of ['off', 'xy', 'cell'] as const) expect(sameBytes(pa[k], pb[k]), k).toBe(true);
      // 邻居（Delaunay 的内部数组原样）
      expect([...vb.delaunay.neighbors(17)]).toEqual([...va.delaunay.neighbors(17)]);
    }
    if (a.kind === 'plane' && b.kind === 'plane') {
      expect(b.triangles).toBe(b.delaunay.triangles);
      expect([...b.delaunay.neighbors(17)]).toEqual([...a.delaunay.neighbors(17)]);
    }
  });
});
