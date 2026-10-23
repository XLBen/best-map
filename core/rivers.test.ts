import { describe, expect, it } from 'vitest';
import { hashArray } from '../tools/hash';
import { Engine } from './engine';
import { continents as sharedContinents } from './testing/fixtures';
import { findCell } from './mesh';
import { hashString } from './names';
import { isRiverCell, lassoBandKm, lassoStroke, planRiver, traceRiver } from './select';
import { landStroke, previewLand } from './terrain';
import type { World } from './world';

// 第四轮：画河能汇入别的河、能改道、能选大小；画的河逐值不变（固定的哈希）

// 两格之间贪心地走相邻格：只用来造固定的路线，与界面上画河的规则无关
function walk(w: World, from: number, to: number): number[] {
  const { mesh } = w;
  const path = [from];
  let c = from;
  for (let guard = 0; c !== to && guard < mesh.n; guard++) {
    let best = -1;
    let bd = (mesh.x[c] - mesh.x[to]) ** 2 + (mesh.y[c] - mesh.y[to]) ** 2;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      const dd = (mesh.x[j] - mesh.x[to]) ** 2 + (mesh.y[j] - mesh.y[to]) ** 2;
      if (dd < bd) {
        bd = dd;
        best = j;
      }
    }
    if (best < 0) break;
    path.push(best);
    c = best;
  }
  return path;
}

describe('画的河逐值不变', () => {
  it('有泉水、不带大小的画河，横穿一片的河，不带泉水的河道', () => {
    // 第九轮去掉旧存档兼容时重录（画的河都只挖河床，不再下切山谷）；之后的优化必须逐值不变
    const eng = new Engine({ seed: 6, cells: 12000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 6, type: 'continents' }, reset: true });
    const w = eng.world;
    const thr = w.small.planet.riverThreshold;
    const inland = [...Array(w.mesh.n).keys()].filter(
      (i) => w.causes.land[i] && w.derived.lake[i] !== 1 && w.derived.continentality[i] > 0.5 && w.derived.discharge[i] < thr * 0.3,
    );
    const water = (i: number) => !w.causes.land[i] || w.derived.lake[i] === 1;
    eng.exec({ op: 'add_guide', guide: { cells: traceRiver(w, w.derived, inland[0]), locked: true, spring: true } });
    let b = walk(w, inland[Math.floor(inland.length / 3)], inland[Math.floor((inland.length * 2) / 3)]);
    const wet = b.findIndex(water);
    if (wet >= 0) b = b.slice(0, wet + 1);
    else {
      const rest = traceRiver(w, w.derived, b[b.length - 1]).slice(1);
      const loop = rest.findIndex((c) => b.includes(c));
      b = [...b, ...(loop >= 0 ? rest.slice(0, loop) : rest)];
    }
    eng.exec({ op: 'add_guide', guide: { cells: b, locked: true, spring: true } });
    const c = traceRiver(w, w.derived, inland[inland.length - 1]);
    eng.exec({ op: 'add_guide', guide: { cells: c, locked: false, spring: false } });
    const d = w.derived;
    const got = {
      guides: w.small.guides.map((g) => g.cells.length).join(','),
      elevation: hashArray(d.elevation),
      discharge: hashArray(d.discharge),
      receiver: hashArray(d.receiver),
      lake: hashArray(d.lake),
      features: hashString(d.features.map((f) => `${f.key}=${f.name}`).join('|')).toString(16),
    };
    expect(got).toEqual({ guides: '4,10,3', elevation: '6959cdb4', discharge: 'bccec68d', receiver: '57d14845', lake: 'c5611545', features: '1a703c21' });
  });
});

const continents = () => sharedContinents();

const isWater = (w: World, i: number) => !w.causes.land[i] || w.derived.lake[i] === 1;

// 顺着现在的流向到海或湖要经过几格陆地
function courseOf(w: World, c: number): number[] {
  const out: number[] = [];
  for (let x = c; x >= 0 && !isWater(w, x) && out.length < w.mesh.n; x = w.derived.receiver[x]) out.push(x);
  return out;
}

// 从河上一格往旁边（垂直于流向）走 k 格
function aside(w: World, c: number, k: number, sign: 1 | -1): number {
  const { mesh } = w;
  const r = w.derived.receiver[c];
  const vx = mesh.x[r] - mesh.x[c];
  const vy = mesh.y[r] - mesh.y[c];
  const l = Math.hypot(vx, vy) || 1;
  return findCell(mesh, mesh.x[c] - (vy / l) * mesh.spacing * k * sign, mesh.y[c] + (vx / l) * mesh.spacing * k * sign);
}

// 内陆的大河：流量大、离入海口还远
function bigRivers(w: World, minFlow: number, minCourse: number): number[] {
  const thr = w.small.planet.riverThreshold;
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) {
    if (isRiverCell(w, w.derived, i) && w.derived.discharge[i] > thr * minFlow && courseOf(w, i).length >= minCourse) out.push(i);
  }
  return out;
}

describe('画河：碰到别的河就汇进去', () => {
  it('点源头：自然流下去碰到河就停在那里汇入，那条河照旧流到原来的入海口', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    const thr = w.small.planet.riverThreshold;
    let plan = null;
    for (let i = 0; i < w.mesh.n && !plan; i++) {
      if (isWater(w, i) || isRiverCell(w, d, i) || d.discharge[i] > thr * 0.2) continue;
      const p = planRiver(w, d, [i]);
      if (p.end === 'river' && p.cells.length >= 4) plan = p;
    }
    expect(plan).not.toBeNull();
    const { cells, join } = plan!;
    expect(join).toBe(cells[cells.length - 1]);
    expect(cells.slice(0, -1).some((c) => isRiverCell(w, d, c))).toBe(false);
    const before = d.discharge[join];
    const mainCourse = courseOf(w, join);
    eng.exec({ op: 'add_guide', guide: { cells, locked: true, spring: true } });
    expect(w.derived.discharge[join]).toBeGreaterThanOrEqual(before + thr);
    expect(mainCourse.every((c) => isRiverCell(w, w.derived, c))).toBe(true);
  });

  it('拖过一条大河：路线停在第一次碰到的河上，不会穿过去', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    let tried = 0;
    for (const r of bigRivers(w, 8, 6)) {
      const a = aside(w, r, 3, 1);
      const b = aside(w, r, 3, -1);
      if (isWater(w, a) || isRiverCell(w, d, a) || isWater(w, b)) continue;
      const plan = planRiver(w, d, [a, b]);
      expect(plan.end).toBe('river');
      expect(plan.cells.filter((c) => isRiverCell(w, d, c))).toEqual([plan.join]);
      if (++tried >= 5) break;
    }
    expect(tried).toBeGreaterThan(0);
  });
});

describe('画河：从河上拖出来是改道', () => {
  it('改道后原来的下游变干，新路线是河，水量跟着过去', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    let found: { x: number; plan: ReturnType<typeof planRiver>; q0: number } | null = null;
    for (const x of bigRivers(w, 6, 10)) {
      for (const sign of [1, -1] as const) {
        const a = aside(w, x, 4, sign);
        if (isWater(w, a)) continue;
        const plan = planRiver(w, d, [x, a]);
        if (plan.reroute && plan.end && !plan.blocked && !plan.same && plan.dried.length >= 3) found = { x, plan, q0: d.discharge[x] };
        if (found) break;
      }
      if (found) break;
    }
    expect(found).not.toBeNull();
    const { plan, q0 } = found!;
    // 顺着流向往下拖：和原来一模一样
    expect(planRiver(w, d, [found!.x, d.receiver[found!.x]]).same).toBe(true);
    const dried = plan.dried;
    eng.exec({ op: 'add_guide', guide: { cells: plan.cells, locked: true, spring: false }, reroute: true });
    const after = w.derived;
    expect(dried.filter((c) => !isRiverCell(w, after, c)).length / dried.length).toBeGreaterThanOrEqual(0.8);
    // 起点那一格不算：新河道下切后，上游的水可能直接流进路线的第二格
    const body = plan.cells.slice(1).filter((c) => !isWater(w, c));
    expect(body.every((c) => isRiverCell(w, after, c))).toBe(true);
    expect(after.discharge[body[body.length - 1]]).toBeGreaterThanOrEqual(q0 * 0.8);
  });

  it('不能接回这条河自己的上游', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    let checked = 0;
    for (const x of bigRivers(w, 6, 6)) {
      // 沿流量最大的支流往上走三格
      let u = x;
      for (let k = 0; k < 3; k++) {
        let best = -1;
        for (let e = w.mesh.off[u]; e < w.mesh.off[u + 1]; e++) {
          const j = w.mesh.adj[e];
          if (d.receiver[j] === u && isRiverCell(w, d, j) && (best < 0 || d.discharge[j] > d.discharge[best])) best = j;
        }
        if (best < 0) break;
        u = best;
      }
      if (u === x) continue;
      expect(planRiver(w, d, [x, u]).blocked).not.toBeNull();
      if (++checked >= 5) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('从画过的河中间改道：原来那条在起点处截断；撤销恢复；重放结果一致', () => {
    const eng = continents();
    const w = eng.world;
    const thr = w.small.planet.riverThreshold;
    let first = null;
    for (let i = 0; i < w.mesh.n && !first; i++) {
      if (isWater(w, i) || isRiverCell(w, w.derived, i) || w.derived.discharge[i] > thr * 0.2) continue;
      const p = planRiver(w, w.derived, [i]);
      if (p.end && p.cells.length >= 8) first = p;
    }
    expect(first).not.toBeNull();
    eng.exec({ op: 'add_guide', guide: { cells: first!.cells, locked: true, spring: true, flow: 6 } });
    const original = w.small.guides[0].cells.slice();
    const m = original[3];
    let plan = null;
    for (const sign of [1, -1] as const) {
      for (const k of [3, 4, 5]) {
        const p = planRiver(w, w.derived, [m, aside(w, m, k, sign)]);
        if (p.reroute && p.end && !p.blocked && !p.same) plan = p;
        if (plan) break;
      }
      if (plan) break;
    }
    expect(plan).not.toBeNull();
    eng.exec({ op: 'add_guide', guide: { cells: plan!.cells, locked: true, spring: false }, reroute: true, label: '让河改道' });
    expect(w.small.guides.map((g) => g.cells.length)).toEqual([4, plan!.cells.length]);
    expect(w.small.guides[0].cells).toEqual(original.slice(0, 4));
    expect(eng.history[eng.history.length - 1].summary).toBe('让河改道');
    const live = hashArray(w.derived.discharge);
    const replay = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(hashArray(replay.world.derived.discharge)).toBe(live);
    eng.undo();
    expect(w.small.guides.map((g) => g.cells)).toEqual([original]);
  });
});

describe('画河：河的大小', () => {
  it('大小为 20 的河，到末端前流量至少是门槛的 20 倍；越往下越宽', () => {
    const eng = continents();
    const w = eng.world;
    const thr = w.small.planet.riverThreshold;
    let plan = null;
    for (let i = 0; i < w.mesh.n && !plan; i++) {
      if (isWater(w, i) || isRiverCell(w, w.derived, i) || w.derived.discharge[i] > thr * 0.2) continue;
      const p = planRiver(w, w.derived, [i]);
      if (p.end && p.cells.length >= 6) plan = p;
    }
    expect(plan).not.toBeNull();
    const cells = plan!.cells;
    eng.exec({ op: 'add_guide', guide: { cells, locked: true, spring: true, flow: 20 } });
    const q = cells.slice(0, -1).map((c) => w.derived.discharge[c]);
    expect(q[q.length - 1]).toBeGreaterThanOrEqual(20 * thr);
    expect(q[0]).toBeLessThan(q[q.length - 1] / 2);
  });
});

describe('圈一片', () => {
  it('预览新增的陆地就是结果；圈里离边远的格全是陆地；新增的格都在圈和过渡带里', () => {
    const eng = new Engine({ cells: 12000, seed: 1 });
    eng.exec({ op: 'set_worldgen', params: { seed: 1, type: 'ocean' }, reset: true });
    const w = eng.world;
    const { width, height } = w.mesh;
    const h = height * 0.18;
    const cx = width / 2;
    const cy = height / 2;
    // 一个方形，边上多放几个点
    const pts: [number, number][] = [];
    const corners: [number, number][] = [
      [cx - h, cy - h],
      [cx + h, cy - h],
      [cx + h, cy + h],
      [cx - h, cy + h],
    ];
    corners.forEach(([ax, ay], k) => {
      const [bx, by] = corners[(k + 1) % 4];
      for (let s = 0; s < 8; s++) pts.push([ax + ((bx - ax) * s) / 8, ay + ((by - ay) * s) / 8]);
    });
    const r = lassoStroke(w, pts);
    const stroke = landStroke(w, r.cells, r.t, 'land');
    const preview = previewLand(w, stroke.cells, stroke.delta).gained.sort((a, b) => a - b);
    const before = w.causes.land.slice();
    eng.exec({ op: 'paint_land', cells: r.cells, t: r.t, mode: 'land' });
    const gained: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.causes.land[i] && !before[i]) gained.push(i);
    expect(gained).toEqual(preview);
    const band = lassoBandKm(w) / w.kmPerUnit;
    const { x, y } = w.mesh;
    for (let i = 0; i < w.mesh.n; i++) {
      const dx = Math.abs(x[i] - cx);
      const dy = Math.abs(y[i] - cy);
      if (dx < h - band && dy < h - band) expect(w.causes.land[i]).toBe(1);
    }
    for (const i of gained) expect(Math.abs(x[i] - cx) < h + band + w.mesh.spacing && Math.abs(y[i] - cy) < h + band + w.mesh.spacing).toBe(true);
  });
});

describe('湖', () => {
  it('不足 3 格的自然洼地不算湖（水照常流过）；用户放的湖照旧', () => {
    const eng = continents();
    const w = eng.world;
    for (const f of w.derived.features.filter((x) => x.type === 'lake')) expect(f.cells.length).toBeGreaterThanOrEqual(3);
    const cell = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.derived.continentality[i] > 0.6 && w.derived.slope[i] < 5)!;
    eng.exec({ op: 'add_lake', lake: { cell, radius: 10, depth: 120, perennial: true } });
    expect(w.derived.lake[cell]).toBe(1);
  });
});
