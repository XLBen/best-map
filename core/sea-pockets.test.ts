import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { POCKET_MAX, landStroke, previewLand } from './terrain';
import type { World } from './world';
import { seededEngine } from './testing/fixtures';

// 第十三轮修：陆地围住的小块“海”（不挨地图边、不超过 POCKET_MAX 格）并回陆地，三格以上的挖成湖；
// 河流进湖、从出口接着流向大海，不再被两三格的“内海”整条吞掉

function island(): Engine {
  const eng = seededEngine({ seed: 4, cells: 12000, latNorth: 18, latSouth: 8 });
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'ocean' }, reset: true });
  eng.exec({ op: 'add_island', island: { x: 1, y: 0.5, kind: 'continental', size: 160, variant: 1 } });
  return eng;
}

// 岛中间的一格与它挨着的 k − 1 格（都离海够远）
function middle(w: World, k: number): number[] {
  const { mesh } = w;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < mesh.n; i++) {
    const d = Math.hypot(mesh.x[i] - 1.01, mesh.y[i] - 0.5);
    if (w.causes.land[i] && d < bd) {
      bd = d;
      best = i;
    }
  }
  const out = [best];
  for (let e = mesh.off[best]; e < mesh.off[best + 1] && out.length < k; e++) out.push(mesh.adj[e]);
  return out;
}

// 画海：只压这几格（t = 0，画笔中心）
function seaStroke(w: World, cells: number[]) {
  return landStroke(w, cells, cells.map(() => 0), 'sea');
}

// 一格往下游走到哪里为止：海（0）还是在陆上消失（1）
function endsInSea(w: World, start: number): boolean {
  let c = start;
  for (let k = 0; k < w.mesh.n; k++) {
    const r = w.derived.receiver[c];
    if (r < 0) return false;
    if (!w.causes.land[r]) return true;
    c = r;
  }
  return false;
}

describe('陆地围住的小块海', () => {
  it('两格的小块并回陆地（平地），预览与结果逐格相同', () => {
    const eng = island();
    const w = eng.world;
    const cells = middle(w, 2);
    const s = seaStroke(w, cells);
    const pv = previewLand(w, s.cells, s.delta);
    expect(pv.lost).toEqual([]);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
    for (const c of cells) expect(eng.world.causes.land[c]).toBe(1);
    for (const c of cells) expect(eng.world.derived.lake[c]).toBe(0);
  });

  it('三到六格的小块挖成湖，湖水从出口流向大海', () => {
    for (const k of [3, 5]) {
      const eng = island();
      const cells = middle(eng.world, k);
      eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
      const w = eng.world;
      for (const c of cells) expect(w.causes.land[c], `${k}`).toBe(1);
      const lake = cells.filter((c) => w.derived.lake[c] === 1);
      expect(lake.length, `${k}`).toBeGreaterThanOrEqual(3);
      // 湖面的格往下游走能走到海
      expect(endsInSea(w, lake[0]), `${k}`).toBe(true);
    }
  });

  it('大于 POCKET_MAX 格的内海照旧是海；连上大海时原来填掉的小块又是海，预览与结果相同', () => {
    const eng = island();
    const big = middle(eng.world, POCKET_MAX + 1);
    // 一圈邻格也画成海，凑够 POCKET_MAX 格以上
    const { mesh } = eng.world;
    const ring = new Set(big);
    for (const c of big) for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) ring.add(mesh.adj[e]);
    const cells = [...ring];
    expect(cells.length).toBeGreaterThan(POCKET_MAX);
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
    for (const c of cells) expect(eng.world.causes.land[c]).toBe(0);

    // 三格的小块（已经并回陆地）挨着一条画到海边的海峡：连上大海后又是海
    const e2 = island();
    const w2 = e2.world;
    const pocket = middle(w2, 3);
    e2.exec({ op: 'paint_land', cells: pocket, t: pocket.map(() => 0), mode: 'sea' });
    for (const c of pocket) expect(e2.world.causes.land[c]).toBe(1);
    // 从小块往东一直画到海
    const w3 = e2.world;
    const strait: number[] = [];
    let c = pocket[0];
    for (let step = 0; step < 200 && w3.causes.land[c]; step++) {
      let next = -1;
      for (let e = w3.mesh.off[c]; e < w3.mesh.off[c + 1]; e++) {
        const j = w3.mesh.adj[e];
        if (next < 0 || w3.mesh.x[j] > w3.mesh.x[next]) next = j;
      }
      if (!pocket.includes(c)) strait.push(c);
      c = next;
    }
    const s = seaStroke(w3, strait);
    const pv = previewLand(w3, s.cells, s.delta);
    const before = w3.causes.land.slice();
    e2.exec({ op: 'paint_land', cells: strait, t: strait.map(() => 0), mode: 'sea' });
    const w4 = e2.world;
    for (const p of pocket) expect(w4.causes.land[p], '连上大海后是海').toBe(0);
    const lost = new Set<number>();
    for (let i = 0; i < w4.mesh.n; i++) if (before[i] && !w4.causes.land[i]) lost.add(i);
    expect(new Set(pv.lost)).toEqual(lost);
  });
});
