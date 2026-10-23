import { describe, expect, it } from 'vitest';
import { type Mesh, graphDistanceOwner } from './mesh';
import { buildMeshFor, settingsSchema } from './world';

// 类型化数组的堆（第九轮 A）与原来 JS 数组写的堆逐值一致：距离、owner（含距离相同时归哪个种子）都相同。
// 下面的 oldOwner 是原来 graphDistanceOwner 与 HeapLite 的原样拷贝，不要改它

class OldHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    const items = this.items;
    const keys = this.keys;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }
  pop(): [number, number] {
    const items = this.items;
    const keys = this.keys;
    const top: [number, number] = [items[0], keys[0]];
    const lastI = items.pop()!;
    const lastK = keys.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastK) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = lastI;
      keys[i] = lastK;
    }
    return top;
  }
}

function oldOwner(mesh: Mesh, seeds: Iterable<number>, limit = Infinity, cost?: (i: number, j: number, e: number) => number) {
  const d = new Float64Array(mesh.n).fill(Infinity);
  const owner = new Int32Array(mesh.n).fill(-1);
  const heap = new OldHeap();
  for (const s of seeds) {
    d[s] = 0;
    owner[s] = s;
    heap.push(s, 0);
  }
  while (heap.size) {
    const [i, di] = heap.pop();
    if (di > d[i] || di > limit) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const c = cost ? cost(i, j, e) : mesh.dist[e];
      if (!(c < Infinity)) continue;
      const nd = di + c;
      if (nd < d[j] && nd <= limit) {
        d[j] = nd;
        owner[j] = owner[i];
        heap.push(j, nd);
      }
    }
  }
  return { dist: d, owner };
}

const same = (a: ArrayBufferView, b: ArrayBufferView) => Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

describe('类型化数组的堆与原来的逐值一致', () => {
  const meshes = [buildMeshFor(settingsSchema.parse({ seed: 2, cells: 3000 })), buildMeshFor(settingsSchema.parse({ seed: 4, cells: 3000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }))];
  it.each(meshes.map((m) => [m.kind, m] as const))('%s', (_k, mesh) => {
    const seeds = [5, 900, 901, 1777, 2500];
    const cases: [number, ((i: number, j: number, e: number) => number) | undefined][] = [
      [Infinity, undefined],
      [mesh.spacing * 6, undefined],
      // 步数代价：大量距离相同，看相同时归哪个种子
      [Infinity, () => 1],
      [12, () => 1],
      // 有的边走不通
      [Infinity, (i, j, e) => ((i + j) % 7 === 0 ? Infinity : mesh.dist[e] * (1 + (j % 3)))],
    ];
    for (const [limit, cost] of cases) {
      const a = oldOwner(mesh, seeds, limit, cost);
      const b = graphDistanceOwner(mesh, seeds, limit, cost);
      expect(same(a.dist, b.dist)).toBe(true);
      expect(same(a.owner, b.owner)).toBe(true);
    }
  });
});
