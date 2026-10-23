import { describe, expect, it } from 'vitest';
import { kahnOrder } from './climate';
import { MinHeap } from './heap';
import { type Mesh, buildMesh } from './mesh';
import { mulberry32 } from './rng';
import { buildSphereMesh } from './sphere';

// 输运图的拓扑序：按入度分桶的写法必须与原来的最小堆写法给出完全相同的顺序（结果逐值不变靠它）

// 原来的写法：浮点优先级的最小堆，同优先级先进先出，弹出时跳过过期项
function heapOrder(mesh: Mesh, em: Uint8Array): Int32Array {
  const n = mesh.n;
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (em[e]) indeg[mesh.adj[e]]++;
  const order = new Int32Array(n);
  const placed = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  const place = (c: number) => {
    order[tail++] = c;
    placed[c] = 1;
  };
  const heap = new MinHeap(n);
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) place(i);
    else heap.push(i, indeg[i]);
  }
  while (tail < n) {
    while (head < tail) {
      const i = order[head++];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (!em[e]) continue;
        const j = mesh.adj[e];
        if (placed[j]) continue;
        if (--indeg[j] === 0) place(j);
        else heap.push(j, indeg[j]);
      }
    }
    if (tail >= n) break;
    for (;;) {
      const c = heap.pop();
      if (!placed[c] && heap.lastKey === indeg[c]) {
        place(c);
        break;
      }
    }
  }
  return order;
}

// 随机挑一部分边（p 越大环越多，入度相同、过期项也越多）
function randomMask(mesh: Mesh, p: number, seed: number): Uint8Array {
  const rnd = mulberry32(seed);
  const em = new Uint8Array(mesh.adj.length);
  for (let e = 0; e < em.length; e++) em[e] = rnd() < p ? 1 : 0;
  return em;
}

// 有方向的风：边 i→j 顺着某个方向时参与，再加一点随机的逆向边造成环
function windMask(mesh: Mesh, seed: number): Uint8Array {
  const rnd = mulberry32(seed);
  const em = new Uint8Array(mesh.adj.length);
  const a = rnd() * 2 * Math.PI;
  for (let i = 0; i < mesh.n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const dot = (mesh.x[j] - mesh.x[i]) * Math.cos(a) + (mesh.y[j] - mesh.y[i]) * Math.sin(a);
      em[e] = dot > 0 || rnd() < 0.08 ? 1 : 0;
    }
  }
  return em;
}

describe('输运图的拓扑序', () => {
  const plane = buildMesh(3000, 1.5, 4);
  const sphere = buildSphereMesh(3000, 4);
  for (const [name, mesh] of [
    ['一块地区', plane],
    ['整个星球', sphere],
  ] as const) {
    it(`${name}：随机的边（大量环）与原来的堆写法顺序相同`, () => {
      for (const p of [0, 0.05, 0.3, 0.5, 0.8, 1]) {
        for (let seed = 1; seed <= 4; seed++) {
          const em = randomMask(mesh, p, seed * 101 + Math.round(p * 10));
          const got = kahnOrder(mesh, em);
          expect(Array.from(got), `p=${p} seed=${seed}`).toEqual(Array.from(heapOrder(mesh, em)));
        }
      }
    });
    it(`${name}：顺风的边加少量逆风边与原来的堆写法顺序相同`, () => {
      for (let seed = 1; seed <= 6; seed++) {
        const em = windMask(mesh, seed);
        const got = kahnOrder(mesh, em);
        expect(new Set(got).size).toBe(mesh.n);
        expect(Array.from(got), `seed=${seed}`).toEqual(Array.from(heapOrder(mesh, em)));
      }
    });
  }
});
