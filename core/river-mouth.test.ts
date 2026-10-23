import { describe, expect, it } from 'vitest';
import { displayCoast, displayCoastAt, shoreCrossing } from './display';
import { type RiverLine, riverRibbon, riverWidth, seawardNormal, traceRivers } from './rivers';
import { pointIsLand } from './subcell';
import { coastValues } from './subcell';
import { continents, engineFor, snapshot } from './testing/fixtures';
import type { World } from './world';

// 第十二轮：河口画到画面上的岸线（与地形层画海岸线的同一个海岸场，湖也一样），出湖的河从湖岸画起；
// 河画成一条连续的带子（宽度平滑、往下游不变窄，源头收尖，河口略张开）

const planet = () =>
  snapshot('planet-4000-s4', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    return eng;
  });

// 一点在画面上的海岸场（> 0 陆地）
const field = (w: World, x: number, y: number) => displayCoastAt(w, displayCoast(w), x, y).v;

// 沿 a → b 方向离 p 前后各 eps 的两点
function around(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number], eps: number) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return { before: [p[0] - (dx / l) * eps, p[1] - (dy / l) * eps] as const, after: [p[0] + (dx / l) * eps, p[1] + (dy / l) * eps] as const };
}

describe('shoreCrossing：画面上的岸线', () => {
  it('与 pointIsLand（导出、悬停用的陆海判定）一致：岸线前一点是陆地、后一点是海（不靠湖的地方两者是同一个场）', () => {
    const w = continents().world;
    const { mesh, causes, derived: d } = w;
    const s = coastValues(w);
    let tried = 0;
    for (let i = 0; i < mesh.n && tried < 60; i++) {
      if (!causes.land[i] || d.lake[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (causes.land[j]) continue;
        const a: [number, number] = [mesh.x[i], mesh.y[i]];
        const b: [number, number] = [mesh.x[j], mesh.y[j]];
        const hit = shoreCrossing(w, a, b, i);
        expect(hit).not.toBeNull();
        const eps = mesh.spacing * 1e-3;
        const { before, after } = around(hit!.p, a, b, eps);
        expect(pointIsLand(w, s, d.elevation, before[0], before[1], i).land).toBe(true);
        expect(pointIsLand(w, s, d.elevation, after[0], after[1], i).land).toBe(false);
        // 从陆上一路走到这里都是陆地（第一次走到水面的地方）
        for (let k = 1; k < 16; k++) {
          const t = (hit!.t * k) / 16 - 1e-6;
          expect(field(w, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)).toBeGreaterThan(0);
        }
        tried++;
        break;
      }
    }
    expect(tried).toBeGreaterThan(20);
  });

  it('陆上的起点在画面上已是水面时为 null', () => {
    const w = continents().world;
    const { mesh, causes } = w;
    const sea = Array.from({ length: mesh.n }, (_, i) => i).find((i) => !causes.land[i])!;
    expect(shoreCrossing(w, [mesh.x[sea], mesh.y[sea]], [mesh.x[sea] + mesh.spacing, mesh.y[sea]], sea)).toBeNull();
  });
});

// 入海、入湖的河的最后一点、出湖的河的第一点都在画面上的岸线上：顺着找岸线的方向（河口那格往它流进的水面那格、
// 源头那格往湖里那格），前面千分之二格是陆地、后面是水面。画的河另见 course-render.test.ts
function checkEnds(w: World) {
  const { mesh, derived: d } = w;
  const lines = traceRivers(w).filter((l) => l.guide === undefined);
  let mouths = 0;
  let lakeHeads = 0;
  const tol = mesh.spacing * 2e-3;
  const centre = (c: number, ref: number): [number, number] => [ref + (mesh.x[c] - ref - 2 * Math.round((mesh.x[c] - ref) / 2) * (mesh.kind === 'sphere' ? 1 : 0)), mesh.y[c]];
  const onShore = (p: readonly [number, number], from: readonly [number, number], to: readonly [number, number]) => {
    const { before, after } = around(p, from, to, tol);
    return field(w, before[0], before[1]) > 0 && field(w, after[0], after[1]) <= 0;
  };
  for (const l of lines) {
    const n = l.points.length;
    if (l.mouth) {
      mouths++;
      const p = l.points[n - 1];
      const c = l.cells![n - 1];
      expect(onShore(p, centre(c, p[0]), centre(d.receiver[c], p[0]))).toBe(true);
    }
    if (l.head === 'lake') {
      lakeHeads++;
      const p = l.points[0];
      const c = l.cells![0];
      const lake = Array.from({ length: mesh.n }, (_, j) => j).filter((j) => d.receiver[j] === c && d.lake[j] === 1 && w.causes.land[j]);
      expect(lake.length).toBeGreaterThan(0);
      expect(lake.some((j) => onShore(p, centre(c, p[0]), centre(j, p[0])))).toBe(true);
    }
  }
  return { mouths, lakeHeads, lines };
}

describe('河口在画面上的岸线上', () => {
  it('一块地区：入海、入湖的河画到岸线为止，出湖的河从湖岸画起', () => {
    const w = continents().world;
    const { mouths, lakeHeads, lines } = checkEnds(w);
    expect(mouths).toBeGreaterThan(10);
    expect(lines.some((l) => l.head === 'source')).toBe(true);
    // 有湖的世界里才有出湖的河：这里只要求标得对（数可以是 0）
    expect(lakeHeads).toBeGreaterThanOrEqual(0);
  });

  it('整个星球：岸线噪声在球面上取，河口照样在岸线上（跨接缝的河也一样）', () => {
    const w = planet().world;
    const { mouths } = checkEnds(w);
    expect(mouths).toBeGreaterThan(5);
  });

  it('放一个湖：流进湖的河停在湖岸，流出湖的河从湖岸画起', () => {
    const eng = continents();
    const w0 = eng.world;
    const { mesh } = w0;
    // 找一条长河中游的一格放湖
    const big = traceRivers(w0)
      .filter((l) => l.cells && l.cells.length > 30)
      .sort((a, b) => b.cells!.length - a.cells!.length)[0];
    const cell = big.cells![Math.floor(big.cells!.length / 2)];
    eng.exec({ op: 'add_lake', lake: { cell, radius: 2 * mesh.spacing * w0.kmPerUnit, depth: 200, perennial: true } });
    const w = eng.world;
    expect(w.derived.lake.some((v, i) => v === 1 && w.causes.land[i])).toBe(true);
    const { lines } = checkEnds(w);
    expect(lines.some((l) => l.mouth && w.derived.lake[w.derived.receiver[l.cells![l.cells!.length - 1]]] === 1)).toBe(true);
    expect(lines.some((l) => l.head === 'lake')).toBe(true);
  });
});

describe('河的带子', () => {
  const thr = 10;
  const sp = 0.01;
  const straight = (n: number, flow: (k: number) => number, more: Partial<RiverLine> = {}): RiverLine => ({
    points: Array.from({ length: n }, (_, k) => [k * sp * 0.5, 0.5] as [number, number]),
    flow: Array.from({ length: n }, (_, k) => flow(k)),
    ...more,
  });

  it('宽度往下游只增不减（流量有起伏也一样），平滑：相邻两点的半宽差得很少', () => {
    const rb = riverRibbon(straight(40, (k) => 20 + 30 * k + (k % 3 === 0 ? -25 : 0)), thr, sp);
    for (let i = 1; i < rb.hw.length; i++) expect(rb.hw[i]).toBeGreaterThanOrEqual(rb.hw[i - 1] - 1e-6);
    for (let i = 1; i < rb.hw.length; i++) expect(rb.hw[i] - rb.hw[i - 1]).toBeLessThan(0.05);
    // 点加密到约 1/16 格
    expect(rb.x.length).toBeGreaterThan(39 * 8);
  });

  it('源头收尖：第一点约一成半宽，约 1.25 格以后是全宽；不是源头的不收', () => {
    const line = straight(30, () => 200);
    const full = riverWidth(200, thr) / 2;
    const src = riverRibbon({ ...line, head: 'source' }, thr, sp);
    expect(src.hw[0]).toBeCloseTo(0.15 * full, 3);
    const at = (rb: typeof src, s: number) => rb.hw[rb.s.findIndex((v) => v >= s)];
    expect(at(src, 0.6 * sp)).toBeGreaterThan(0.3 * full);
    expect(at(src, 0.6 * sp)).toBeLessThan(0.9 * full);
    expect(at(src, 1.3 * sp)).toBeCloseTo(full, 3);
    const lake = riverRibbon({ ...line, head: 'lake' }, thr, sp);
    expect(lake.hw[0]).toBeCloseTo(full, 3);
  });

  // 第十二轮修：小湖流出来一两格就入海的河以前画成一块平头的方块（41、42 号截图里血色的那条）
  it('从湖里流出来的短河：湖岸处约四成宽，往下游渐渐全宽；4 格以上的不收', () => {
    const full = riverWidth(200, thr) / 2;
    const short = riverRibbon({ ...straight(4, () => 200), head: 'lake', mouth: true }, thr, sp);
    const L = short.s[short.s.length - 1];
    expect(L).toBeCloseTo(1.5 * sp, 9);
    expect(short.hw[0]).toBeCloseTo(0.4 * full, 3);
    for (let i = 1; i < short.hw.length; i++) expect(short.hw[i]).toBeGreaterThanOrEqual(short.hw[i - 1] - 1e-6);
    const at = (s: number) => short.hw[short.s.findIndex((v) => v >= s)];
    expect(at(0.75 * L)).toBeGreaterThan(0.99 * full);
    const long = riverRibbon({ ...straight(10, () => 200), head: 'lake' }, thr, sp);
    expect(long.hw[0]).toBeCloseTo(full, 3);
  });

  it('河口略张开（最后约 0.6 格），最后一点就是河线的最后一点（平头收在岸线上）；两头不加弯曲', () => {
    const line = straight(30, () => 200, { mouth: true });
    const rb = riverRibbon(line, thr, sp);
    const n = rb.x.length;
    const full = riverWidth(200, thr) / 2;
    expect(rb.hw[n - 1]).toBeCloseTo(1.3 * full, 3);
    expect(rb.hw[Math.floor(n / 2)]).toBeCloseTo(full, 3);
    expect(rb.x[n - 1]).toBe(line.points[29][0]);
    expect(rb.y[n - 1]).toBe(line.points[29][1]);
    expect(rb.x[0]).toBe(line.points[0][0]);
    expect(rb.y[0]).toBe(line.points[0][1]);
    // 中间有细小的弯曲（不到 0.1 格），法向是单位向量
    const off = Math.max(...Array.from(rb.y, (v) => Math.abs(v - 0.5)));
    expect(off).toBeGreaterThan(0.005 * sp);
    expect(off).toBeLessThan(0.1 * sp);
    for (let i = 0; i < n; i++) expect(Math.hypot(rb.nx[i], rb.ny[i])).toBeCloseTo(1, 5);
  });

  it('结果确定：同一条线算两次逐位相同；粗细倍数乘在半宽上', () => {
    const line = straight(20, (k) => 50 + k * 10, { head: 'source', mouth: true });
    const a = riverRibbon(line, thr, sp);
    const b = riverRibbon(line, thr, sp);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.hw)).toEqual(Array.from(b.hw));
    const c = riverRibbon(line, thr, sp, () => 2);
    for (let i = 0; i < a.hw.length; i++) expect(c.hw[i]).toBeCloseTo(2 * a.hw[i], 5);
  });
});

// 第十二轮修：支流画到干流画出来的中线上（干流加过曲流、平滑、带子上又加了细小的弯曲；以前支流停在汇合那格的格心，
// 急弯处干流抄近路走开，汇合处露出一截平头的缺口）。干流在汇合处顺着水多的那条往下画（与地名、点选认干流相同）
function checkConfluences(w: World) {
  const { mesh, derived: d } = w;
  const thr = w.small.planet.riverThreshold;
  const lines = traceRivers(w);
  const ribbons = lines.map((l) => riverRibbon(l, thr, mesh.spacing));
  let joins = 0;
  let worst = 0;
  lines.forEach((l, i) => {
    if (l.into === undefined) return;
    joins++;
    const t = ribbons[l.into];
    const rb = ribbons[i];
    const x = rb.x[rb.x.length - 1];
    const y = rb.y[rb.y.length - 1];
    // 到干流的中线（加密后的折线）最近的距离与那里的半宽
    let best = Number.POSITIVE_INFINITY;
    let hw = 0;
    for (let k = 0; k + 1 < t.x.length; k++) {
      const shift = mesh.kind === 'sphere' ? 2 * Math.round((x - t.x[k]) / 2) : 0;
      const ax = t.x[k] + shift;
      const bx = t.x[k + 1] + shift;
      const dx = bx - ax;
      const dy = t.y[k + 1] - t.y[k];
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - t.y[k]) * dy) / l2)) : 0;
      const dd = Math.hypot(x - ax - u * dx, y - t.y[k] - u * dy);
      if (dd < best) {
        best = dd;
        hw = t.hw[k];
      }
    }
    // 最大缩放（一格约 64 像素、河宽系数 4）下不到干流宽的四分之一；与格距相比几乎为零
    expect(best).toBeLessThan(0.25 * 2 * hw * 4 * (mesh.spacing / 64));
    worst = Math.max(worst, best / mesh.spacing);
    // 汇合的那一格在干流上
    expect(lines[l.into].cells).toContain(l.cells![l.cells!.length - 1]);
  });
  // 汇合处干流顺着水多的那条：支流流进汇合那格的那一格不比干流流进那格的那一格水多
  lines.forEach((l) => {
    if (l.into === undefined) return;
    const n = l.cells!.length;
    const r = l.cells![n - 1];
    const prev = l.cells![n - 2];
    const trunk = lines[l.into].cells!;
    const up = trunk.slice(0, trunk.indexOf(r)).reverse().find((c) => c !== r);
    if (up !== undefined && prev !== r && d.receiver[up] === r && d.receiver[prev] === r) expect(d.discharge[up]).toBeGreaterThanOrEqual(d.discharge[prev]);
  });
  return { joins, worst };
}

describe('支流接在干流画出来的中线上', () => {
  it('一块地区：每个汇合处支流的最后一点都在干流的中线上', () => {
    const { joins, worst } = checkConfluences(continents().world);
    expect(joins).toBeGreaterThan(10);
    expect(worst).toBeLessThan(1e-6);
  });

  it('整个星球（跨接缝的河也一样）', () => {
    const { joins, worst } = checkConfluences(planet().world);
    expect(joins).toBeGreaterThan(5);
    expect(worst).toBeLessThan(1e-6);
  });
});

// 第十三轮：河口那一段沿岸线的法向进水；海岸边不到 1.5 格的源头小河不画；流进同一格海、挨得很近的河口并成一条
function mouthStats(w: World) {
  const { mesh, causes, derived: d } = w;
  const sp = mesh.spacing;
  const f = displayCoast(w);
  const lines = traceRivers(w);
  const angles: number[] = [];
  let stubs = 0;
  let merged = 0;
  const bySea = new Map<number, [number, number][]>();
  const len = (P: [number, number][]) => P.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - P[k][0], p[1] - P[k][1]), 0);
  for (const l of lines) {
    const P = l.points;
    const cells = l.cells!;
    if (l.guide === undefined && !l.mouth && l.into !== undefined) {
      // 在岸边汇入别的河：倒数第二格流进海
      const r = d.receiver[cells[cells.length - 2]];
      if (r >= 0 && !causes.land[r]) merged++;
    }
    if (!l.mouth) continue;
    const c = cells[cells.length - 1];
    const r = d.receiver[c];
    const sea = r >= 0 && !causes.land[r];
    if (l.guide === undefined && sea) {
      if (l.head === 'source' && len(P) < 1.5 * sp) stubs++;
      const list = bySea.get(r) ?? [];
      list.push(P[P.length - 1]);
      bySea.set(r, list);
    }
    // 最后约 0.25 格的方向与河口处岸线的法向
    const end = P[P.length - 1];
    let k = P.length - 1;
    for (let s = 0; k > 0 && s < 0.25 * sp; k--) s += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    const dx = end[0] - P[k][0];
    const dy = end[1] - P[k][1];
    const n = seawardNormal(w, f, end, c);
    if (!n) continue;
    angles.push((Math.acos(Math.max(-1, Math.min(1, (dx * n[0] + dy * n[1]) / (Math.hypot(dx, dy) || 1)))) * 180) / Math.PI);
  }
  angles.sort((a, b) => a - b);
  // 流进同一格海的自然的河口两两之间的最近距离（格）
  let closest = Infinity;
  let close = 0;
  for (const ends of bySea.values())
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) {
        const dx = mesh.kind === 'sphere' ? ends[i][0] - ends[j][0] - 2 * Math.round((ends[i][0] - ends[j][0]) / 2) : ends[i][0] - ends[j][0];
        const dd = Math.hypot(dx, ends[i][1] - ends[j][1]) / sp;
        closest = Math.min(closest, dd);
        if (dd <= 1.6) close++;
      }
  return { median: angles[Math.floor(angles.length / 2)], p90: angles[Math.floor(angles.length * 0.9)], count: angles.length, stubs, merged, closest, close };
}

describe('河口沿岸线的法向进水（第十三轮）', () => {
  it('一块地区：河口最后一段与岸线法向的夹角中位数不到 10°；没有海岸边不到 1.5 格的源头小河；同一格海里挨着的河口并成了一条', () => {
    const s = mouthStats(continents().world);
    expect(s.count).toBeGreaterThan(20);
    expect(s.median).toBeLessThan(10);
    expect(s.p90).toBeLessThan(30);
    expect(s.stubs).toBe(0);
    expect(s.closest).toBeGreaterThan(1.6);
  });

  it('整个星球：同上', () => {
    const s = mouthStats(planet().world);
    expect(s.count).toBeGreaterThan(20);
    expect(s.median).toBeLessThan(10);
    expect(s.p90).toBeLessThan(30);
    expect(s.stubs).toBe(0);
    // 挨着的河口都并了；隔着一个窄海湾（两岸之间接不过去）的照旧各自入海
    expect(s.close).toBeLessThanOrEqual(1);
    expect(s.merged).toBeGreaterThan(0);
  });

  it('往水里多画一段（underShore）：只多出最后那段，岸线以前的带子不变', () => {
    const sp = 0.01;
    const line: RiverLine = { points: Array.from({ length: 20 }, (_, k) => [k * sp * 0.5, 0.5] as [number, number]), flow: Array.from({ length: 20 }, () => 200), mouth: true };
    const a = riverRibbon(line, 10, sp);
    const b = riverRibbon(line, 10, sp, undefined, { underShore: 0.3 });
    expect(b.s[b.s.length - 1]).toBeCloseTo(a.s[a.s.length - 1] + 0.3 * sp, 9);
    for (let i = 0; i < a.x.length; i++) {
      expect(b.x[i]).toBeCloseTo(a.x[i], 12);
      expect(b.hw[i]).toBeCloseTo(a.hw[i], 6);
    }
    // 不入海的线不多画
    const plain = { ...line, mouth: undefined };
    expect(riverRibbon(plain, 10, sp, undefined, { underShore: 0.3 }).x.length).toBe(riverRibbon(plain, 10, sp).x.length);
  });
});
