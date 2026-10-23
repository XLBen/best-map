import { describe, expect, it } from 'vitest';
import { digest } from '../tools/hash';
import { type Mesh, graphDistance, updateDistance } from './mesh';
import { mulberry32 } from './rng';
import { meshFor } from './testing/fixtures';

// 距离场从旧的改起（updateDistance）与从头算（graphDistance）逐值相同：去掉、加上、挪动种子，成片的、零散的

const full = (mesh: Mesh, seeds: Uint8Array) => {
  const from: number[] = [];
  for (let i = 0; i < seeds.length; i++) if (seeds[i]) from.push(i);
  return graphDistance(mesh, from);
};

// 以 c 为中心 r 步以内的格
function blob(mesh: Mesh, c: number, r: number): number[] {
  const seen = new Map<number, number>([[c, 0]]);
  const q = [c];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (seen.get(i)! >= r) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!seen.has(j)) {
        seen.set(j, seen.get(i)! + 1);
        q.push(j);
      }
    }
  }
  return q;
}

describe('距离场从旧的改起与从头算逐值相同', () => {
  for (const [label, settings] of [
    ['一块地区', { cells: 5000, seed: 2 }],
    ['整个星球', { cells: 5000, seed: 2, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
  ] as const) {
    it(label, () => {
      const mesh = meshFor(settings);
      const n = mesh.n;
      const rnd = mulberry32(7);
      let seeds = new Uint8Array(n);
      for (const c of blob(mesh, 100, 6)) seeds[c] = 1;
      for (let k = 0; k < 40; k++) seeds[Math.floor(rnd() * n)] = 1;
      let dist = full(mesh, seeds);
      const step = (what: string, change: (s: Uint8Array) => void) => {
        const next = seeds.slice();
        change(next);
        const got = updateDistance(mesh, seeds, dist, next);
        const want = full(mesh, next);
        expect(got, what).not.toBeNull();
        expect(digest(got!), what).toBe(digest(want));
        seeds = next;
        dist = want;
      };
      step('不变', () => {});
      step('去掉一片', (s) => {
        for (const c of blob(mesh, 100, 3)) s[c] = 0;
      });
      step('加上一片', (s) => {
        for (const c of blob(mesh, 2000, 4)) s[c] = 1;
      });
      step('零散地去掉、加上', (s) => {
        for (let k = 0; k < 60; k++) {
          const i = Math.floor(rnd() * n);
          s[i] = s[i] ? 0 : 1;
        }
      });
      step('挪一格', (s) => {
        const i = s.indexOf(1);
        s[i] = 0;
        s[mesh.adj[mesh.off[i]]] = 1;
      });
      step('全去掉', (s) => s.fill(0));
      step('从没有到有', (s) => {
        for (const c of blob(mesh, 3000, 5)) s[c] = 1;
      });
      step('全是种子', (s) => s.fill(1));
      step('只剩一格', (s) => {
        s.fill(0);
        s[17] = 1;
      });
    });
  }
});
