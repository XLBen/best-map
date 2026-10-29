import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { groupPreview, provinceFlat, provinceGroups } from '../src/render/colors';
import { digestWorld } from '../tools/hash';
import { Engine } from './engine';
import { exportPackage } from './export';
import { findCell } from './mesh';
import { SEAM_BAND, applySeams, exportProvinceCells, scissors, seamLayers, seamPick } from './seams';
import { provinceCells } from './select';
import { rasterizeWorld } from './subcell';
import { snapshot, seededEngine } from './testing/fixtures';
import type { World } from './world';

// 第八轮：剪刀切出的边就是画的线。切线附近的像素按“在线的哪一边”分省，屏幕（着色器）与导出（provinces.bmp）同一条规则；
// 合并后自动失效，重新划分时删掉，撤销、重放照旧；只在切开的那几块之间换像素，邻省不动。
// 着色器那一半只能在浏览器里看，这里验的是导出、点选与交给着色器的数据（JS 那一半）

type Pt = [number, number];

// 一块地区（6000 格）与一个整个星球（6000 格），都划好了省份（与 raster-identity 的两个世界相同）
const region = () =>
  snapshot('seams:region', () => {
    const eng = seededEngine({ seed: 3, cells: 6000 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    return eng;
  });
const planet = () =>
  snapshot('seams:planet', () => {
    const eng = seededEngine({ cells: 6000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 4 } });
    return eng;
  });

// 离海最远的陆地格（按格数），keep 限定候选
function inland(w: World, keep: (i: number) => boolean): number {
  const { mesh, causes } = w;
  const dist = new Int32Array(mesh.n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) continue;
    dist[i] = 0;
    queue.push(i);
  }
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (dist[j] >= 0) continue;
      dist[j] = dist[c] + 1;
      queue.push(j);
    }
  }
  let best = -1;
  for (let i = 0; i < mesh.n; i++) if (keep(i) && (best < 0 || dist[i] > dist[best])) best = i;
  return best;
}

// 把 center 周围 r 格以内的陆地（湖面除外：湖属于湖省）都涂进 center 所在的省：一个够大的省（自动划分的省只有二三十格）
function bigProvince(eng: Engine, center: number, r: number): number {
  const w = eng.world;
  const { mesh } = w;
  const id = w.causes.province[center];
  const dx = (i: number) => (mesh.kind === 'sphere' ? ((mesh.x[i] - mesh.x[center] + 3) % 2) - 1 : mesh.x[i] - mesh.x[center]);
  const cells: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (w.causes.land[i] && w.derived.lake[i] !== 1 && w.causes.province[i] !== id && Math.hypot(dx(i), mesh.y[i] - mesh.y[center]) < r * mesh.spacing) cells.push(i);
  }
  eng.exec({ op: 'assign_province', cells, province: id });
  return id;
}

// 一条弯弯的线（正弦），中心 (cx, cy)，长 len 格、起伏 amp 格，转 angle 弧度；两端在省里，剪刀会延长到省外
function wavy(w: World, cx: number, cy: number, len: number, amp: number, angle: number): Pt[] {
  const s = w.mesh.spacing;
  const out: Pt[] = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40 - 0.5;
    const u = t * len * s;
    const v = Math.sin(t * Math.PI * 2) * amp * s;
    out.push([cx + u * Math.cos(angle) - v * Math.sin(angle), cy + u * Math.sin(angle) + v * Math.cos(angle)]);
  }
  return out;
}

// 点到折线的距离，以及最近点离线的两端有多远（沿线）
function toLine(line: Pt[], x: number, y: number): { d: number; fromEnd: number } {
  let total = 0;
  for (let k = 0; k + 1 < line.length; k++) total += Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
  let best = Infinity;
  let at = 0;
  let acc = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k];
    const ex = line[k + 1][0] - ax;
    const ey = line[k + 1][1] - ay;
    const len = Math.hypot(ex, ey);
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (len * len)));
    const d = Math.hypot(x - ax - ex * t, y - ay - ey * t);
    if (d < best) {
      best = d;
      at = acc + t * len;
    }
    acc += len;
  }
  return { d: best, fromEnd: Math.min(at, total - at) };
}

// 导出图里 A、B 两省相邻像素（左右、上下）的交界离线有多远（像素）：只看离线两端两个带宽以外的。
// 整个星球上线的经度是展开的，交界点按离线最近的那一份算
function borderOffsets(w: World, line: Pt[], A: number, B: number, cell: Int32Array, W: number, H: number) {
  const k = W / w.mesh.width;
  const band = SEAM_BAND * w.mesh.spacing;
  const shifts = w.mesh.kind === 'sphere' ? [-2, 0, 2] : [0];
  let max = 0;
  let count = 0;
  const pid = (p: number) => w.causes.province[cell[p]];
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const p = py * W + px;
      const a = pid(p);
      if (a !== A && a !== B) continue;
      for (const [q, mx, my] of [
        [px + 1 < W ? p + 1 : -1, px + 1, py + 0.5],
        [py + 1 < H ? p + W : -1, px + 0.5, py + 1],
      ]) {
        if (q < 0 || pid(q) !== (a === A ? B : A)) continue;
        const r = shifts.map((sh) => toLine(line, mx / k + sh, my / k)).reduce((x, y) => (y.d < x.d ? y : x));
        if (r.fromEnd < 2 * band) continue;
        count++;
        max = Math.max(max, r.d * k);
      }
    }
  }
  return { max, count };
}

// 切一刀：剪刀（界面）的线 → cut_province；同样的块走旧的 batch（assign_province 'new'）作对照。
// line 是命令里的线，future 是会记下的切线（每个切开的省一条），trimmed 是第一条（切开省的那一段）
function cutBoth(eng: Engine, raw: Pt[]) {
  const w = eng.world;
  const { line, cut, seams: future } = scissors(w, raw);
  const trimmed = future[0].line;
  const seam = eng.clone();
  seam.exec({ op: 'cut_province', line });
  const old = eng.clone();
  old.exec({ op: 'batch', commands: cut.plans.flatMap((pl) => pl.parts.slice(1).map((cells) => ({ op: 'assign_province' as const, cells, province: 'new' as const }))) });
  return { line, trimmed, future, cut, seam, old };
}

describe('剪刀切线', () => {
  it('切开后导出的省份边界就是画的线', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => w0.mesh.x[i] > 0.3 && w0.mesh.x[i] < 1.7 && w0.mesh.y[i] > 0.2 && w0.mesh.y[i] < 0.8);
    const A = bigProvince(eng, center, 7);
    const W = 1024;
    const H = 512;
    const raster = rasterizeWorld(eng.world, W, H);
    for (const angle of [0, 1.6]) {
      const { line, trimmed, future, cut, seam, old } = cutBoth(eng, wavy(eng.world, w0.mesh.x[center], w0.mesh.y[center], 8, 1.5, angle));
      expect(cut.plans.map((pl) => pl.id)).toEqual([A]);
      const B = eng.world.small.nextProvince;
      // 两条路分出来的格一模一样，只是 cut_province 多记了一条切线（命令里的线去掉伸进邻省的线头，与切开的两块）
      expect(Array.from(seam.world.causes.province)).toEqual(Array.from(old.world.causes.province));
      expect(seam.world.small.provinceSeams?.map(({ line, provinces }) => ({ line, provinces }))).toEqual(future);
      expect(future.map((f) => f.provinces)).toEqual([[A, B]]);
      expect(trimmed.length).toBeLessThanOrEqual(line.length);
      expect(old.world.small.provinceSeams).toBeUndefined();
      // 地形不变，栅格化的格也不变：两边共用一份
      const withSeam = borderOffsets(seam.world, trimmed, A, B, exportProvinceCells(seam.world, raster.cell, W, H).cell, W, H);
      const control = borderOffsets(old.world, trimmed, A, B, raster.cell, W, H);
      expect(withSeam.count).toBeGreaterThan(50);
      expect(withSeam.max).toBeLessThanOrEqual(1.5);
      expect(control.max).toBeGreaterThanOrEqual(5);
    }
  });

  it('一条直线连着切开几个省：每个省切开的地方都是画的线', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const { mesh } = w0;
    const s = mesh.spacing;
    const center = inland(w0, (i) => mesh.x[i] > 0.3 && mesh.x[i] < 1.7 && mesh.y[i] > 0.2 && mesh.y[i] < 0.8);
    const cx = mesh.x[center];
    const cy = mesh.y[center];
    // 一排三个省，各约 7 格宽
    const ids: number[] = [];
    for (const off of [-7, 0, 7]) {
      const cells: number[] = [];
      for (let i = 0; i < mesh.n; i++) if (w0.causes.land[i] && Math.hypot(mesh.x[i] - (cx + off * s), mesh.y[i] - cy) < 3.5 * s) cells.push(i);
      eng.exec({ op: 'assign_province', cells, province: 'new' });
      ids.push(eng.world.small.nextProvince - 1);
    }
    // 一刀直线：化简后只剩两个点、一段线，穿过三个省
    const { line, cut, seams } = scissors(eng.world, [
      [cx - 10 * s, cy + 0.3 * s],
      [cx + 10 * s, cy - 0.2 * s],
    ]);
    expect(line).toHaveLength(2);
    expect(cut.plans.map((pl) => pl.id)).toEqual(ids);
    const W = 1024;
    const H = 512;
    const raster = rasterizeWorld(eng.world, W, H);
    eng.exec({ op: 'cut_province', line });
    const w = eng.world;
    // 每个切开的省一条切线，只留线在那个省里的一段
    expect(w.small.provinceSeams?.map((sm) => sm.provinces)).toEqual(seams.map((sm) => sm.provinces));
    const out = exportProvinceCells(w, raster.cell, W, H).cell;
    for (const sm of w.small.provinceSeams!) {
      expect(sm.provinces).toHaveLength(2);
      const r = borderOffsets(w, sm.line, sm.provinces[0], sm.provinces[1], out, W, H);
      expect(r.count).toBeGreaterThanOrEqual(10);
      expect(r.max).toBeLessThanOrEqual(1.5);
    }
  });

  it('再切一刀横过旧的线：旧线两边的新块之间照样按旧线画', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const { mesh } = w0;
    const s = mesh.spacing;
    const center = inland(w0, (i) => mesh.x[i] > 0.3 && mesh.x[i] < 1.7 && mesh.y[i] > 0.2 && mesh.y[i] < 0.8);
    const A = bigProvince(eng, center, 7);
    const cx = mesh.x[center];
    const cy = mesh.y[center];
    const W = 1024;
    const H = 512;
    const raster = rasterizeWorld(eng.world, W, H);
    // 第一刀横着（直线：化简后只有两个点），第二刀竖着把两块都切开
    const first = scissors(eng.world, [
      [cx - 5 * s, cy + 0.2 * s],
      [cx + 5 * s, cy - 0.3 * s],
    ]);
    eng.exec({ op: 'cut_province', line: first.line });
    const B = first.seams[0].provinces[1];
    expect(first.seams.map((sm) => sm.provinces)).toEqual([[A, B]]);
    const second = scissors(eng.world, [
      [cx + 0.4 * s, cy - 5 * s],
      [cx - 0.3 * s, cy + 5 * s],
    ]);
    expect(second.seams.map((sm) => sm.provinces[0]).sort()).toEqual([A, B].sort());
    // 拖动时着色器拿到的省界数据（旧切线也管新块）与结果相同
    const cells: number[] = [];
    const ids: number[] = [];
    second.cut.plans.forEach((pl, k) =>
      pl.parts.forEach((part, j) => {
        for (const c of j ? part : []) {
          cells.push(c);
          ids.push(second.seams[k].provinces[j]);
        }
      }),
    );
    const shown = groupPreview(eng.world, { cells, ids, seams: second.seams }, 'terrain');
    eng.exec({ op: 'cut_province', line: second.line });
    const w = eng.world;
    expect(Array.from(provinceGroups(w, w.causes.province, seamLayers(w, w.causes.province, w.small.provinceSeams)))).toEqual(Array.from(shown.group));
    // 第一条切线也管第二刀切出来的两块
    const born = second.seams.flatMap((sm) => sm.provinces.slice(1));
    expect(w.small.provinceSeams![0].provinces).toEqual([A, B, ...born]);
    // 第一刀的线上（离第二刀的线远的地方）：两边各是哪一块都按线分
    const out = exportProvinceCells(w, raster.cell, W, H).cell;
    const line1 = w.small.provinceSeams![0].line;
    const family = new Set([A, B, ...born]);
    const k = W / mesh.width;
    const band = SEAM_BAND * s;
    let max = 0;
    let count = 0;
    const pid = (p: number) => w.causes.province[out[p]];
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const p = py * W + px;
        const a = pid(p);
        if (!family.has(a)) continue;
        for (const [q, mx, my] of [
          [px + 1 < W ? p + 1 : -1, px + 1, py + 0.5],
          [py + 1 < H ? p + W : -1, px + 0.5, py + 1],
        ]) {
          if (q < 0 || pid(q) === a || !family.has(pid(q))) continue;
          const r = toLine(line1, mx / k, my / k);
          if (r.fromEnd < 2 * band || r.d > 3 * band) continue;
          if (second.seams.some((sm) => toLine(sm.line, mx / k, my / k).d < 2 * band)) continue;
          count++;
          max = Math.max(max, r.d * k);
        }
      }
    }
    expect(count).toBeGreaterThan(20);
    expect(max).toBeLessThanOrEqual(1.5);
    // 对半分开：分出来的一半也归这些切线管
    const id = w.small.nextProvince;
    eng.exec({ op: 'split_province', id: B });
    expect(w.small.provinceSeams![0].provinces).toContain(id);
  });

  it('切线只在切开的那几块之间换像素：邻省的像素一个不动', () => {
    const base = region();
    const w0 = base.world;
    const { mesh } = w0;
    const W = 512;
    const H = 256;
    const raster = rasterizeWorld(w0, W, H);
    // 随便切十几刀（固定的随机数）：省里任意一点、任意方向、长 4–12 格、弯一点
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const land = Object.keys(w0.small.provinces)
      .map(Number)
      .filter((id) => w0.small.provinces[id].land && provinceCells(w0, id).length >= 20);
    let cuts = 0;
    let moved = 0;
    for (let t = 0; t < 30 && cuts < 16; t++) {
      const cells = provinceCells(w0, land[Math.floor(rnd() * land.length)]);
      const c = cells[Math.floor(rnd() * cells.length)];
      const { line, cut } = scissors(w0, wavy(w0, mesh.x[c], mesh.y[c], 4 + rnd() * 8, rnd() * 1.5, rnd() * Math.PI));
      if (!cut.plans.length) continue;
      const eng = base.clone();
      eng.exec({ op: 'cut_province', line });
      const w = eng.world;
      const out = exportProvinceCells(w, raster.cell, W, H).cell;
      // 换了省的像素：前后两个省是同一条切线切出来的几块
      const pieceOf = new Map<number, number>();
      w.small.provinceSeams!.forEach((sm, k) => {
        for (const p of sm.provinces) pieceOf.set(p, k);
      });
      for (let p = 0; p < out.length; p++) {
        const a = w.causes.province[raster.cell[p]];
        const b = w.causes.province[out[p]];
        if (a === b) continue;
        moved++;
        expect(pieceOf.get(a)).toBeDefined();
        expect(pieceOf.get(b)).toBe(pieceOf.get(a));
      }
      cuts++;
    }
    expect(cuts).toBe(16);
    expect(moved).toBeGreaterThan(200);
  });

  it('导出逐行扫描与逐点找最近的段结果相同（着色器按段号依次画、近的胜，也是这条规则）', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => w0.mesh.x[i] > 0.3 && w0.mesh.x[i] < 1.7 && w0.mesh.y[i] > 0.2 && w0.mesh.y[i] < 0.8);
    bigProvince(eng, center, 7);
    // 两刀交叉：最近的段在两条线之间换来换去
    for (const angle of [0.4, 2.0]) eng.exec({ op: 'cut_province', line: scissors(eng.world, wavy(eng.world, w0.mesh.x[center], w0.mesh.y[center], 8, 1.2, angle)).line });
    const w = eng.world;
    // 第二刀切开了第一刀切出来的两块：每个切开的省一条切线，一共三条
    expect(w.small.provinceSeams).toHaveLength(3);
    const W = 512;
    const H = 256;
    const raster = rasterizeWorld(w, W, H);
    const L = seamLayers(w, w.causes.province, w.small.provinceSeams)!;
    const rows = applySeams(w, L, raster.cell, W, H);
    let changed = 0;
    let differ = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const p = py * W + px;
        const one = seamPick(L, w, ((px + 0.5) / W) * w.mesh.width, ((py + 0.5) / H) * w.mesh.height, raster.cell[p]);
        if (one !== rows[p]) differ++;
        if (rows[p] !== raster.cell[p]) changed++;
      }
    }
    expect(changed).toBeGreaterThan(20);
    expect(differ).toBe(0);
  });

  it('选省：切线附近按线的哪一边算（与显示出来的一样）', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => w0.mesh.x[i] > 0.3 && w0.mesh.x[i] < 1.7 && w0.mesh.y[i] > 0.2 && w0.mesh.y[i] < 0.8);
    const A = bigProvince(eng, center, 7);
    const B = eng.world.small.nextProvince;
    const { line } = scissors(eng.world, wavy(eng.world, w0.mesh.x[center], w0.mesh.y[center], 8, 1.5, 0.7));
    eng.exec({ op: 'cut_province', line });
    const w = eng.world;
    const L = seamLayers(w, w.causes.province, w.small.provinceSeams);
    const s = w.mesh.spacing;
    // 线中段每个折点两侧 0.3 格处：两侧各是一个省（A 一边、B 一边），不会两边都是同一个省
    let checked = 0;
    let total = 0;
    for (let k = 4; k + 4 < line.length; k++) {
      const [x0, y0] = line[k - 1];
      const [x1, y1] = line[k + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const nx = -(y1 - y0) / len;
      const ny = (x1 - x0) / len;
      const [x, y] = line[k];
      if (toLine(line, x, y).fromEnd < 3 * SEAM_BAND * s) continue;
      const side = (sign: number) => {
        const px = x + sign * nx * 0.3 * s;
        const py = y + sign * ny * 0.3 * s;
        const c = findCell(w.mesh, px, py);
        return w.causes.province[seamPick(L, w, px, py, c)];
      };
      const l = side(1);
      const r = side(-1);
      total++;
      if ([l, r].sort().join() === [A, B].sort().join()) checked++;
    }
    expect(total).toBeGreaterThan(5);
    expect(checked).toBe(total);
  });

  it('合并后切线自动失效', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => w0.mesh.x[i] > 0.3 && w0.mesh.x[i] < 1.7 && w0.mesh.y[i] > 0.2 && w0.mesh.y[i] < 0.8);
    const A = bigProvince(eng, center, 7);
    // 这一刀还切开了旁边的一个省：每个切开的省各记一条切线
    eng.exec({ op: 'cut_province', line: scissors(eng.world, wavy(eng.world, w0.mesh.x[center], w0.mesh.y[center], 8, 1.5, 0.3)).line });
    const w = eng.world;
    const seams = w.small.provinceSeams!;
    expect(seams.length).toBeGreaterThanOrEqual(2);
    expect(seams[0].provinces[0]).toBe(A);
    const active = () => {
      const L = seamLayers(w, w.causes.province, w.small.provinceSeams)!;
      const on = seams.map(() => 0);
      for (let s = 0; s < L.segs.count; s++) if (L.gL[s] !== L.gR[s]) on[L.segs.seam[s]]++;
      return on;
    };
    expect(active().every((n) => n > 0)).toBe(true);
    // 只把 A 切出来的那块并回去：A 的切线失效，别的省的切线照旧
    eng.exec({ op: 'merge_province', from: seams[0].provinces[1], into: A });
    expect(active()[0]).toBe(0);
    expect(active().slice(1).every((n) => n > 0)).toBe(true);
    // 都并回去：切线都失效
    for (const sm of seams.slice(1)) for (const p of sm.provinces.slice(1)) eng.exec({ op: 'merge_province', from: p, into: sm.provinces[0] });
    expect(w.small.provinceSeams).toHaveLength(seams.length);
    expect(active().every((n) => n === 0)).toBe(true);
    // 导出的省份图与没有切线时逐字节相同
    const bmp = (e: Engine) => unzipSync(exportPackage(e.world, e.toDoc(), { width: 512, height: 256, seaLevelGray: 95, maxElevation: 6000 }).zip)['provinces.bmp'];
    const bare = eng.clone();
    delete bare.world.small.provinceSeams;
    expect(bmp(eng)).toEqual(bmp(bare));
  });

  it('撤销 / 重放 / 重新划分', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => w0.mesh.x[i] > 0.3 && w0.mesh.x[i] < 1.7 && w0.mesh.y[i] > 0.2 && w0.mesh.y[i] < 0.8);
    const A = bigProvince(eng, center, 7);
    const before = digestWorld(eng.world);
    const { line } = scissors(eng.world, wavy(eng.world, w0.mesh.x[center], w0.mesh.y[center], 8, 1.5, 1.1));
    eng.exec({ op: 'cut_province', line });
    const after = digestWorld(eng.world);
    expect(eng.world.small.provinceSeams).toHaveLength(1);
    // 撤销：切线与新省份都没了，与切之前逐值相同；重做回来
    eng.undo();
    expect(eng.world.small.provinceSeams).toBeUndefined();
    expect(digestWorld(eng.world)).toEqual(before);
    eng.redo();
    expect(digestWorld(eng.world)).toEqual(after);
    // 存档：重放结果逐值相同
    const doc = eng.toDoc();
    expect(doc.version).toBe(6);
    expect(digestWorld(Engine.fromDoc(doc, eng.world.mesh).world)).toEqual(after);
    // 重新划分切开的省：碰到它的切线不要了
    const regen = eng.clone();
    regen.exec({ op: 'regenerate_provinces', cells: provinceCells(regen.world, A) });
    expect(regen.world.small.provinceSeams).toBeUndefined();
    // 重新划分别处的省：切线留着
    const far = Object.keys(eng.world.small.provinces)
      .map(Number)
      .find((id) => eng.world.small.provinces[id].land && id !== A && provinceCells(eng.world, id).length > 10 && line.every(([x, y]) => eng.world.causes.province[findCell(eng.world.mesh, x, y)] !== id))!;
    const other = eng.clone();
    other.exec({ op: 'regenerate_provinces', cells: provinceCells(other.world, far) });
    expect(other.world.small.provinceSeams).toHaveLength(1);
    // 整张图重新划分：切线都不要了
    eng.exec({ op: 'generate_provinces', rules: {} });
    expect(eng.world.small.provinceSeams).toBeUndefined();
    // 线没有把省份分开：命令拒绝，什么都不变
    const s = eng.world.mesh.spacing;
    expect(() => eng.exec({ op: 'cut_province', line: [[w0.mesh.x[center], w0.mesh.y[center]], [w0.mesh.x[center] + 0.1 * s, w0.mesh.y[center]]] })).toThrow('线没有把省份分开');
  });

  it('剪刀的预览就是结果', () => {
    const eng = region().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => w0.mesh.x[i] > 0.3 && w0.mesh.x[i] < 1.7 && w0.mesh.y[i] > 0.2 && w0.mesh.y[i] < 0.8);
    bigProvince(eng, center, 7);
    // 一刀切开几个省（长线）、一刀来回（切成三块）
    const s = w0.mesh.spacing;
    const cx = w0.mesh.x[center];
    const cy = w0.mesh.y[center];
    const raws: Pt[][] = [
      wavy(eng.world, cx, cy, 24, 2, 0.2),
      [
        [cx - 10 * s, cy - 2 * s],
        [cx + 10 * s, cy - 2 * s],
        [cx + 10 * s, cy + 2 * s],
        [cx - 10 * s, cy + 2 * s],
      ],
    ];
    for (const raw of raws) {
      const e = eng.clone();
      const w = e.world;
      // 界面上：预览的块与新省份的编号（与剪刀工具一样，编号取 seams 里记的）
      const { line, cut, seams } = scissors(w, raw);
      expect(line.length).toBeLessThanOrEqual(raw.length + 2);
      const expect0 = w.causes.province.slice();
      let pieces = 0;
      cut.plans.forEach((pl, k) => {
        pl.parts.forEach((part, j) => {
          if (!j) return;
          for (const c of part) expect0[c] = seams[k].provinces[j];
          pieces++;
        });
      });
      expect(pieces).toBeGreaterThan(raw.length === 4 ? 1 : 2);
      const next = w.small.nextProvince + pieces;
      // 拖动时交给着色器的省界数据（分组、省份着色、切线两边的省）
      const changed: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (expect0[i] !== w.causes.province[i]) changed.push(i);
      const shown = groupPreview(w, { cells: changed, ids: changed.map((i) => expect0[i]), seams }, 'provinces');
      // 执行命令：分出来的格与编号、记下的切线都与预览相同
      e.exec({ op: 'cut_province', line });
      expect(Array.from(w.causes.province)).toEqual(Array.from(expect0));
      expect(w.small.nextProvince).toBe(next);
      expect(w.small.provinceSeams?.map(({ line, provinces }) => ({ line, provinces }))).toEqual(seams);
      // 结果回来后着色器拿到的数据与拖动时的一样：松手时省界不跳
      const after = seamLayers(w, w.causes.province, w.small.provinceSeams)!;
      expect(Array.from(provinceGroups(w, w.causes.province, after))).toEqual(Array.from(shown.group));
      expect(Array.from(provinceFlat(w, w.causes.province))).toEqual(Array.from(shown.flat!));
      for (const key of ['gL', 'gR', 'repL', 'repR'] as const) expect(Array.from(after[key])).toEqual(Array.from(shown.seams![key]));
    }
  });

  it('整个星球：切线跨过经度 180°（x = 0 / 2）', () => {
    const eng = planet().clone();
    const w0 = eng.world;
    const center = inland(w0, (i) => (w0.mesh.x[i] < 0.08 || w0.mesh.x[i] > 1.92) && Math.abs(w0.mesh.y[i] - 0.5) < 0.3);
    const A = bigProvince(eng, center, 6);
    const W = 1024;
    const H = 512;
    const raster = rasterizeWorld(eng.world, W, H);
    // 线的中心放在接缝上（x = 1.99），两头分在接缝两边
    const cx = w0.mesh.x[center] > 1 ? 1.99 : -0.01;
    for (const angle of [0, 0.5]) {
      const { trimmed: line, cut, seam } = cutBoth(eng, wavy(eng.world, cx, w0.mesh.y[center], 7, 1.2, angle));
      expect(cut.plans.map((pl) => pl.id)).toEqual([A]);
      const xs = line.map(([x]) => x);
      expect(Math.min(...xs)).toBeLessThan(2);
      expect(Math.max(...xs)).toBeGreaterThan(2);
      const B = eng.world.small.nextProvince;
      const withSeam = borderOffsets(seam.world, line, A, B, exportProvinceCells(seam.world, raster.cell, W, H).cell, W, H);
      const control = borderOffsets(seam.world, line, A, B, raster.cell, W, H);
      expect(withSeam.count).toBeGreaterThan(30);
      expect(withSeam.max).toBeLessThanOrEqual(1.5);
      expect(control.max).toBeGreaterThan(withSeam.max + 2);
    }
  });
});
