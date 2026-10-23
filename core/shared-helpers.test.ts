import { describe, expect, it } from 'vitest';
import { BARE_RGB, blendRgb } from './biome-look';
import { shoreCrossing } from './display';
import { hexToRgb } from './export';
import type { Mesh } from './mesh';
import { type RiverLine, smoothCourse, traceRivers } from './rivers';
import { buildSphereMesh } from './sphere';
import { COAST_AMP, brushRangeKm, coastNoiseField, coastSeed, lakeRangeKm, mapScaleKm, reachRangeKm, resolveTerrain } from './terrain';
import { coastValueAt, coastValues, vnoise } from './subcell';
import { continents, meshFor } from './testing/fixtures';
import { type World, createWorld } from './world';

// 第八轮抽出来的公用函数（海岸值、河道平滑、生态混色、画笔范围）：与抽出前的算式逐位相同。
// 这里留一份抽出前的原样代码对照

function terrainWorld(mesh: Mesh, globe: boolean, rough: number): World {
  const w = globe ? createWorld({ cells: mesh.n, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, mesh) : createWorld({ cells: mesh.n, seed: 1 }, mesh);
  w.small.terrain.gen = { seed: 4, type: 'continents', mountains: 1.2, rerolls: [] };
  w.small.terrain.coastRoughness = rough;
  // 画过几笔：landDelta 不全是 0
  for (let i = 0; i < mesh.n; i += 7) w.causes.landDelta[i] = ((i % 13) - 6) * 40;
  resolveTerrain(w);
  return w;
}

describe('coastValueAt 与 coastValues 逐位相同', () => {
  // 抽出前 coastValues 循环里的算式
  const before = (L: number, noise: number, amp: number, land: number) => {
    const v = L + amp * noise;
    const signed = land ? Math.max(v, 1) : Math.min(v, -1);
    return 250 * Math.tanh(signed / 250);
  };
  for (const [name, globe] of [
    ['一块地区', false],
    ['整个星球', true],
  ] as const) {
    it(name, () => {
      const mesh = globe ? buildSphereMesh(3000, 1) : meshFor({ cells: 4000, seed: 1 });
      for (const rough of [0.35, 1, 1.8]) {
        const w = terrainWorld(mesh, globe, rough);
        const s = coastValues(w);
        const noise = coastNoiseField(w.mesh, coastSeed(w));
        const amp = COAST_AMP * rough;
        let bad = 0;
        for (let i = 0; i < mesh.n; i++) {
          const L = w.causes.landness[i];
          if (!Object.is(s[i], Math.fround(before(L, noise[i], amp, w.causes.land[i])))) bad++;
          if (!Object.is(s[i], Math.fround(coastValueAt(L, noise[i], amp, w.causes.land[i] === 1)))) bad++;
        }
        expect(bad, `海岸曲折 ${rough}`).toBe(0);
      }
    });
  }
});

describe('smoothCourse：河道与抽出前逐位相同', () => {
  // 抽出前的 traceRivers（曲流与 Chaikin 平滑写在循环里）。第十二轮起入海、入湖的河画到画面上的岸线（shoreCrossing，第十三轮起二分 9 次，
  // 找不到时退回两格的中点），出湖的河从湖岸画起；第十二轮修起汇合处顺着水多的那条往下画（一样多时编号小的），
  // 支流的最后一点画到干流平滑后的线上（ends：第几条线的最后一点画在哪里，取现在的结果）：这里照样改了，其余逐位照旧
  function traceBefore(world: World, ends: Map<string, [number, number]>): RiverLine[] {
    const { mesh, derived: d, causes, small } = world;
    const n = mesh.n;
    const thr = small.planet.riverThreshold;
    const isRiver = (i: number) => causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= thr;
    const main = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (!isRiver(i)) continue;
      const r = d.receiver[i];
      if (r < 0 || !isRiver(r)) continue;
      const o = main[r];
      if (o < 0 || d.discharge[i] > d.discharge[o] || (d.discharge[i] === d.discharge[o] && i < o)) main[r] = i;
    }
    const sources: number[] = [];
    for (let i = 0; i < n; i++) if (isRiver(i) && main[i] < 0) sources.push(i);
    sources.sort((a, b) => d.elevation[b] - d.elevation[a]);
    const visited = new Uint8Array(n);
    const lines: RiverLine[] = [];
    const meander = 0.22 * mesh.spacing;
    const sphere = mesh.kind === 'sphere';
    const xAt = (c: number, ref: number) => (sphere ? ref + (mesh.x[c] - ref - 2 * Math.round((mesh.x[c] - ref) / 2)) : mesh.x[c]);
    const shore = (a: [number, number], b: [number, number], c: number, r: number): [number, number] => shoreCrossing(world, a, b, c, [c, r], { samples: 12, bisect: 9 })?.p ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const s of sources) {
      const pts: [number, number][] = [];
      const flow: number[] = [];
      let c = s;
      let cx = mesh.x[s];
      let donor = -1;
      for (let j = 0; j < n; j++) {
        if (!causes.land[j] || d.lake[j] !== 1 || d.receiver[j] !== s) continue;
        if (donor < 0 || d.discharge[j] > d.discharge[donor] || (d.discharge[j] === d.discharge[donor] && j < donor)) donor = j;
      }
      if (donor >= 0) {
        pts.push(shore([cx, mesh.y[s]], [xAt(donor, cx), mesh.y[donor]], s, donor));
        flow.push(d.discharge[s]);
      }
      for (let guard = 0; guard < n; guard++) {
        cx = xAt(c, cx);
        pts.push([cx, mesh.y[c]]);
        flow.push(d.discharge[c]);
        visited[c] = 1;
        const r = d.receiver[c];
        if (r < 0) break;
        if (!causes.land[r] || d.lake[r] === 1) {
          pts.push(shore([cx, mesh.y[c]], [xAt(r, cx), mesh.y[r]], c, r));
          flow.push(d.discharge[c]);
          break;
        }
        if (!isRiver(r)) break;
        if (visited[r] || main[r] !== c) {
          pts.push(ends.get(`${pts[0][0]},${pts[0][1]}`) ?? [xAt(r, cx), mesh.y[r]]);
          flow.push(d.discharge[r]);
          break;
        }
        c = r;
      }
      if (pts.length < 2) continue;
      for (let k = 1; k < pts.length - 1; k++) {
        const [x0, y0] = pts[k - 1];
        const [x1, y1] = pts[k + 1];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const off = meander * vnoise(pts[k][0] / mesh.spacing * 0.9 + 11.1, pts[k][1] / mesh.spacing * 0.9);
        pts[k] = [pts[k][0] - ((y1 - y0) / len) * off, pts[k][1] + ((x1 - x0) / len) * off];
      }
      let points = pts;
      let fl = flow;
      for (let it = 0; it < 3; it++) {
        if (points.length < 3) break;
        const p: [number, number][] = [points[0]];
        const f: number[] = [fl[0]];
        for (let k = 0; k + 1 < points.length; k++) {
          const [ax, ay] = points[k];
          const [bx, by] = points[k + 1];
          p.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
          f.push(fl[k] * 0.75 + fl[k + 1] * 0.25, fl[k] * 0.25 + fl[k + 1] * 0.75);
        }
        p.push(points[points.length - 1]);
        f.push(fl[fl.length - 1]);
        points = p;
        fl = f;
      }
      lines.push({ points, flow: fl });
    }
    return lines;
  }

  // 每个数逐位比（toEqual 对 ±0 也区分，这里再按 Float64 的字节比一遍）
  const flat = (lines: RiverLine[]) => Float64Array.from(lines.flatMap((l) => [l.points.length, ...l.points.flat(), ...l.flow]));

  it('大陆世界的全部河流', () => {
    const w = continents().world;
    const now = traceRivers(w);
    const old = traceBefore(
      w,
      // 汇入别的河的线的最后一点（按线头认：海岸边的小河不画了，下标对不上）
      new Map(now.filter((l) => l.into !== undefined).map((l) => [`${l.points[0][0]},${l.points[0][1]}`, l.points[l.points.length - 1]])),
    );
    expect(now.length).toBeGreaterThan(10);
    expect(now.every((l) => l.cells?.length === l.points.length)).toBe(true);
    // 第十三轮起河口那一段改成沿岸线的法向（normalMouth）、海岸边的源头小河不画、挤在一起的河口挪开或并成一条（tidyMouths）：
    // 这几样只改线尾（急转时、挪开河口时最多从河口往回约 2.4 格再接过去），之前的点与流量仍与抽出前逐位相同；不入海、不并的线整条逐位相同
    const sp = w.mesh.spacing;
    const byHead = new Map(old.map((l) => [`${l.points[0][0]},${l.points[0][1]}`, l]));
    let whole = 0;
    for (const l of now) {
      const o = byHead.get(`${l.points[0][0]},${l.points[0][1]}`);
      expect(o).toBeDefined();
      if (!l.mouth && !o!.points.length) continue;
      let same = 0;
      while (same < l.points.length && same < o!.points.length && l.points[same][0] === o!.points[same][0] && l.points[same][1] === o!.points[same][1] && l.flow[same] === o!.flow[same]) same++;
      if (same === l.points.length && same === o!.points.length) {
        whole++;
        expect(new Uint8Array(flat([l]).buffer)).toEqual(new Uint8Array(flat([o!]).buffer));
        continue;
      }
      let tail = 0;
      for (let k = Math.max(0, same - 1); k + 1 < l.points.length; k++) tail += Math.hypot(l.points[k + 1][0] - l.points[k][0], l.points[k + 1][1] - l.points[k][1]);
      expect(tail).toBeLessThan((l.mouth ? 2.6 : 3.5) * sp);
      expect(same).toBeGreaterThan(0);
    }
    expect(whole).toBeGreaterThan(now.length / 2);
  });

  it('不改动传进来的点', () => {
    const pts: [number, number][] = [
      [0.1, 0.2],
      [0.13, 0.22],
      [0.16, 0.21],
      [0.2, 0.25],
    ];
    const copy = pts.map((p) => [...p]);
    const flow = [10, 12, 15, 20];
    const line = smoothCourse(pts, flow, 0.02);
    expect(pts).toEqual(copy);
    expect(flow).toEqual([10, 12, 15, 20]);
    // 两端不动；每遍平滑点数翻倍：4 → 8 → 16 → 32
    expect(line.points[0]).toEqual(pts[0]);
    expect(line.points[line.points.length - 1]).toEqual(pts[3]);
    expect(line.points.length).toBe(32);
    expect(line.flow.length).toBe(32);
  });
});

// 第十三轮：混色改成按份额的平方（再归一化），占多数的生态颜色更纯；这里的对照跟着改成平方
describe('blendRgb 与直白的写法逐位相同', () => {
  it('大陆世界的每一格陆地', () => {
    const w = continents().world;
    const d = w.derived;
    const S = w.small.species.length;
    const colors = w.small.species.map((s) => hexToRgb(s.color));
    let bad = 0;
    let checked = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!w.causes.land[i]) continue;
      // 抽出前 colors.ts、thumbnail.ts 里的写法，份额换成份额的平方
      let r = 0;
      let g = 0;
      let b = 0;
      let t = 0;
      for (let s = 0; s < S; s++) {
        const v = d.share[i * S + s];
        if (v <= 0) continue;
        const x = v * v;
        r += x * colors[s][0];
        g += x * colors[s][1];
        b += x * colors[s][2];
        t += x;
      }
      const old = t > 0 ? [r / t, g / t, b / t] : [205, 190, 160];
      const now = blendRgb(d.share, i, colors);
      if (!old.every((v, k) => Object.is(v, now[k]))) bad++;
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  it('没有份额时是裸地的颜色，每次给出新的数组', () => {
    const colors: [number, number, number][] = [
      [10, 20, 30],
      [200, 100, 0],
    ];
    const share = new Float32Array([0, 0, 0.25, 0.75]);
    const bare = blendRgb(share, 0, colors);
    expect(bare).toEqual(BARE_RGB);
    bare[0] = 0;
    expect(blendRgb(share, 0, colors)).toEqual([205, 190, 160]);
    // 份额 0.25 : 0.75 → 权重 0.0625 : 0.5625（归一化后 0.1 : 0.9）
    const [r, g, b] = blendRgb(share, 1, colors);
    expect(r).toBeCloseTo(0.1 * 10 + 0.9 * 200, 9);
    expect(g).toBeCloseTo(0.1 * 20 + 0.9 * 100, 9);
    expect(b).toBeCloseTo(0.1 * 30, 9);
  });
});

describe('画笔、湖、过渡的范围搬进 core 后数值不变', () => {
  it('一块地区与整个星球', () => {
    const worlds = [continents().world, createWorld({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }, buildSphereMesh(3000, 1))];
    for (const w of worlds) {
      // 抽出前 src/state.ts 里的写法；最小值是第八轮 1b 改小的（画笔 0.4 格、湖半格、过渡一格半），最大值不变
      const width = w.mesh.kind === 'sphere' ? w.kmPerUnit : w.mesh.width * w.kmPerUnit;
      const cell = w.mesh.spacing * w.kmPerUnit;
      expect(mapScaleKm(w)).toEqual({ width, cell });
      expect(brushRangeKm(w)).toEqual([cell * 0.4, width * 0.2]);
      expect(lakeRangeKm(w)).toEqual([cell * 0.5, Math.max(cell * 4, width * 0.05)]);
      expect(reachRangeKm(w)).toEqual([Math.max(cell * 1.5, width * 0.005), Math.min(5000, width * 0.2)]);
    }
  });
});
