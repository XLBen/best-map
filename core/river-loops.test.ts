import { describe, expect, it } from 'vitest';
import { encodePath, traceRivers } from './rivers';
import { SINK_LOOP, emptyPlan, isRiverCell, overlapsOf, planCourse, riverStem } from './select';
import { continents } from './testing/fixtures';
import type { World } from './world';

// 第十三轮：画完就消失的河绕回自己旁边（画成一个圈）、贴着别的河流、改道后旧河道还有水——重叠分析；
// 补水（画的河整条是河）按路由实际的下游，强制方向绕成圈时不再沿河道往下补

type Pt = [number, number];

function line(a: Pt, b: Pt, n = 24): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

// 离水（海、湖）至少 r 格、自己不是河的一格（在它周围画几格长的线都在陆地上）
function inland(w: World, r: number, skip = 0): number {
  const { mesh, causes, derived: d } = w;
  const dist = new Int32Array(mesh.n).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < mesh.n; i++)
    if (!causes.land[i] || d.lake[i] === 1 || mesh.boundary[i]) {
      dist[i] = 0;
      q.push(i);
    }
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (dist[j] < 0) {
        dist[j] = dist[c] + 1;
        q.push(j);
      }
    }
  }
  let seen = 0;
  for (let i = 0; i < mesh.n; i++) if (dist[i] >= r && !isRiverCell(w, d, i) && seen++ >= skip) return i;
  throw new Error('找不到内陆的格');
}

// 一个钩子：往东 6 格，往北 off 格，再往西 4.5 格（终点在出发那段的旁边 off 格）
function hook(w: World, c: number, off: number): Pt[] {
  const sp = w.mesh.spacing;
  const x = w.mesh.x[c];
  const y = w.mesh.y[c];
  return [...line([x - 3 * sp, y], [x + 3 * sp, y]), ...line([x + 3 * sp, y], [x + 3 * sp, y - off * sp], 4).slice(1), ...line([x + 3 * sp, y - off * sp], [x - 1.5 * sp, y - off * sp]).slice(1)];
}

describe('重叠分析', () => {
  it('在终点消失、终点又回到自己旁边（一个圈）：不让画，说清楚为什么', () => {
    const w = continents().world;
    // 第三十三轮：地形有了平原、三角洲，第一个内陆格旁边画开的钩子的终点落在了一条河上，换第五个
    const c = inland(w, 9, 4);
    const plan = planCourse(w, w.derived, hook(w, c, 1.1), { endOnLand: 'sink' });
    expect(plan.blocked).toBe(SINK_LOOP);
    // 画开一点（终点离出发那段 2.5 格）就能画
    const ok = planCourse(w, w.derived, hook(w, c, 2.5), { endOnLand: 'sink' });
    expect(ok.blocked).toBeNull();
    expect(ok.end).toBe('sink');
  });

  it('画完接着流的钩子：不拦着，但标出绕回自己旁边的那段', () => {
    const w = continents().world;
    const c = inland(w, 9);
    const plan = planCourse(w, w.derived, hook(w, c, 0.9), { endOnLand: 'flow' });
    expect(plan.blocked).toBeNull();
    const o = overlapsOf(w, w.derived, plan);
    expect(o.some((x) => x.kind === 'near-self' || x.kind === 'loop')).toBe(true);
    const near = o.find((x) => x.kind === 'near-self');
    if (near) expect(near.points.length).toBeGreaterThan(1);
  });

  it('画的线绕了一个小圈（同一格进了两次）：圈剪掉了，也标出来', () => {
    const w = continents().world;
    const c = inland(w, 9);
    const sp = w.mesh.spacing;
    const x = w.mesh.x[c];
    const y = w.mesh.y[c];
    const ring: Pt[] = [];
    for (let k = 0; k <= 24; k++) {
      const a = (2 * Math.PI * k) / 24;
      ring.push([x + 0.8 * sp * Math.sin(a), y + 0.8 * sp - 0.8 * sp * Math.cos(a)]);
    }
    const stroke = [...line([x - 4 * sp, y], [x, y]), ...ring.slice(1), ...line([x, y], [x + 4 * sp, y]).slice(1)];
    const plan = planCourse(w, w.derived, stroke, { endOnLand: 'sink' });
    expect(plan.blocked).toBeNull();
    expect(plan.loops.length).toBeGreaterThan(0);
    expect(overlapsOf(w, w.derived, plan).some((x) => x.kind === 'loop')).toBe(true);
  });

  it('贴着别的河流 1.5 格以上、终点挨着别的河：标出来，说是哪条', () => {
    const w = continents().world;
    const sp = w.mesh.spacing;
    const lines = traceRivers(w);
    const big = lines.filter((l) => l.guide === undefined).sort((a, b) => b.points.length - a.points.length)[0];
    // 干流中段 3 格长的一截，往旁边挪 0.35 格
    const P = big.points;
    let k = Math.floor(P.length / 3);
    const start = k;
    const path: Pt[] = [];
    let s = 0;
    while (k + 1 < P.length && s < 3 * sp) {
      const dx = P[k + 1][0] - P[k][0];
      const dy = P[k + 1][1] - P[k][1];
      const l = Math.hypot(dx, dy) || 1;
      path.push([P[k][0] - (dy / l) * 0.35 * sp, P[k][1] + (dx / l) * 0.35 * sp]);
      s += l;
      k++;
    }
    expect(k).toBeGreaterThan(start + 4);
    const plan = { ...emptyPlan(), path, cells: [], end: 'sink' as const };
    const o = overlapsOf(w, w.derived, plan, { lines });
    const along = o.find((x) => x.kind === 'alongside');
    expect(along).toBeDefined();
    expect(along!.cells.length).toBe(1);
    expect(o.some((x) => x.kind === 'sink-river')).toBe(true);
    // 这条河自己（改它时）不算
    expect(overlapsOf(w, w.derived, plan, { lines, own: big.cells }).some((x) => x.kind === 'alongside')).toBe(false);
  });

  it('改道后旧河道还有支流的水：标出那几格', () => {
    const w = continents().world;
    const { derived: d } = w;
    const thr = w.small.planet.riverThreshold;
    const f = d.features.filter((x) => x.type === 'river').sort((a, b) => b.cells.length - a.cells.length)[0];
    const stem = riverStem(w, d, f.cells[Math.floor(f.cells.length / 2)]).cells;
    // 截在一个支流汇进来（水多了一截）之前
    let k = -1;
    for (let i = 2; i + 3 < stem.length && k < 0; i++) if (isRiverCell(w, d, stem[i]) && d.discharge[stem[i + 2]] - d.discharge[stem[i]] >= thr * 1.5) k = i;
    expect(k).toBeGreaterThan(0);
    const plan = { ...emptyPlan(), cells: stem.slice(0, k + 1), path: [[w.mesh.x[stem[0]], w.mesh.y[stem[0]]] as Pt, [w.mesh.x[stem[k]], w.mesh.y[stem[k]]] as Pt], end: 'sink' as const };
    const o = overlapsOf(w, d, plan, { old: stem });
    const wet = o.find((x) => x.kind === 'old-flowing');
    expect(wet).toBeDefined();
    for (const c of wet!.cells) expect(stem.indexOf(c)).toBeGreaterThan(k);
  });
});

describe('补水按路由实际的下游', () => {
  it('两条画的河的强制方向绕成圈（路由把那几格恢复成自然的流向）：不再沿着河道往下补成河', () => {
    const eng = continents();
    const w0 = eng.world;
    const { mesh } = w0;
    const thr = w0.small.planet.riverThreshold;
    // 三格两两相邻、都不是河、自然的流向不是 p → q 的一个三角
    let tri: [number, number, number] | null = null;
    for (let p = 0; p < mesh.n && !tri; p++) {
      if (!w0.causes.land[p] || isRiverCell(w0, w0.derived, p) || w0.derived.lake[p]) continue;
      for (let e = mesh.off[p]; e < mesh.off[p + 1] && !tri; e++) {
        const q = mesh.adj[e];
        if (!w0.causes.land[q] || isRiverCell(w0, w0.derived, q) || w0.derived.receiver[p] === q || w0.derived.discharge[q] > 0.3 * thr) continue;
        for (let f = mesh.off[q]; f < mesh.off[q + 1] && !tri; f++) {
          const r = mesh.adj[f];
          if (r === p || !w0.causes.land[r] || isRiverCell(w0, w0.derived, r)) continue;
          for (let g = mesh.off[r]; g < mesh.off[r + 1]; g++) if (mesh.adj[g] === p) tri = [p, q, r];
        }
      }
    }
    expect(tri).not.toBeNull();
    const [p, q, r] = tri!;
    const at = (c: number): [number, number] => [mesh.x[c], mesh.y[c]];
    eng.exec({ op: 'add_guide', guide: { id: 'a', cells: [p, q, r], path: encodePath([at(p), at(q), at(r)]), locked: true, spring: false } });
    eng.exec({ op: 'add_guide', guide: { id: 'b', cells: [r, p], path: encodePath([at(r), at(p)]), locked: true, spring: false } });
    const w = eng.world;
    // 路由把圈上的格恢复成了自然的流向：p 不流向 q
    expect(w.derived.receiver[p]).not.toBe(q);
    // q 不再被补成河（水不照这条河道走）
    expect(w.derived.discharge[q]).toBeLessThan(thr);
  });
});
