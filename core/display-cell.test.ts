import { describe, expect, it } from 'vitest';
import { type DisplayCell, displayCellAt, displayCoast, displayCoastAt } from './display';
import { Engine } from './engine';
import { findCell } from './mesh';
import { traceRivers } from './rivers';
import { applySeams, scissors, seamLayers, seamPick } from './seams';
import { rasterizeWorld } from './subcell';
import { continents, snapshot, seededEngine } from './testing/fixtures';
import type { World } from './world';

// 第八轮第四批：悬停卡片“这里”、Alt 吸取、选省、合并读的是屏幕上画出来的那一格。
// 着色器那一半只能在浏览器里看；这里拿与着色器同一套规则的 JS 实现对照：导出的 rasterizeWorld
// （逐像素：海岸值 + 格以下细节判陆海，扭曲后取最近的格；只多一步“陆海不一致时换成同类的邻格”）与 applySeams（切线规则）

// 第十三轮：画成水面（湖面在导出里算陆地）的点取到陆地格时，省份按 provinceCell 换成水面格（导出的切线规则不管湖面）
// 画成陆地的点取到水面格（湖）时同样换成附近的陆地格（第十三轮修）
function provinceRule(w: World, exported: number, d: DisplayCell): number {
  const coast = displayCoast(w).coast;
  if (!d.water) return coast[exported] >= 0 || d.province < 0 || coast[d.province] < 0 ? exported : d.province;
  if (coast[exported] < 0) return exported;
  return d.province < 0 || coast[d.province] < 0 ? d.province : exported;
}

// 逐像素对照：陆海与导出一致；格与陆海同类时就是导出的格（着色器的 id），不同类时 here 是导出换成的同类格；
// 省份按切线换过的格与导出的切线规则一致（同类时）。返回扭曲后与没扭曲的最近格不同的像素占几成
function compare(w: World, W: number, H: number): number {
  const { mesh, causes } = w;
  const raster = rasterizeWorld(w, W, H);
  const L = seamLayers(w, causes.province, w.small.provinceSeams);
  const byProvince = applySeams(w, L, raster.cell, W, H);
  let hint = 0;
  let moved = 0;
  let n = 0;
  const bad: string[] = [];
  for (let py = 0; py < H; py++) {
    const y = ((py + 0.5) / H) * mesh.height;
    for (let px = 0; px < W; px++) {
      const x = ((px + 0.5) / W) * mesh.width;
      const p = py * W + px;
      const d: DisplayCell = displayCellAt(w, x, y, hint);
      hint = d.cell;
      n++;
      if (d.cell !== findCell(mesh, x, y, hint)) moved++;
      const same = (causes.land[d.cell] === 1) === d.land;
      if (d.land !== (raster.land[p] === 1)) bad.push(`${px},${py} 陆海`);
      else if (same && (d.cell !== raster.cell[p] || d.here !== d.cell || d.province !== provinceRule(w, byProvince[p], d))) bad.push(`${px},${py} 格`);
      else if (!same && d.here !== raster.cell[p]) bad.push(`${px},${py} 同类格`);
      if (bad.length > 5) break;
    }
  }
  expect(bad).toEqual([]);
  return moved / n;
}

// 横切一个大的陆地省，让地图上有切线（整个星球：经度取圆周平均）
function cutBig(eng: Engine) {
  const w = eng.world;
  const { mesh } = w;
  const sphere = mesh.kind === 'sphere';
  const sizes = new Map<number, number>();
  w.causes.province.forEach((p) => p >= 0 && sizes.set(p, (sizes.get(p) ?? 0) + 1));
  const bigs = [...sizes].filter(([p]) => w.small.provinces[p]?.land).sort((a, b) => b[1] - a[1]);
  const s = mesh.spacing;
  for (const [big, size] of bigs.slice(0, 5)) {
    let sx = 0;
    let cx = 0;
    let cy = 0;
    w.causes.province.forEach((p, i) => {
      if (p !== big) return;
      sx += sphere ? Math.sin(Math.PI * mesh.x[i]) : mesh.x[i];
      cx += sphere ? Math.cos(Math.PI * mesh.x[i]) : 0;
      cy += mesh.y[i];
    });
    const x = sphere ? Math.atan2(sx, cx) / Math.PI : sx / size;
    const y = cy / size;
    const { line, cut } = scissors(w, [
      [x - 2 * s, y + 0.2 * s],
      [x + 2 * s, y - 0.1 * s],
    ]);
    if (!cut.plans.length) continue;
    eng.exec({ op: 'cut_province', line });
    expect(eng.world.small.provinceSeams?.length).toBeGreaterThan(0);
    return;
  }
  throw new Error('没有切得开的省');
}

describe('屏幕上画出来的那一格', () => {
  it('一块地区：陆海、格、切线两边的省都与着色器的规则一致', () => {
    const eng = continents({ provinces: true });
    cutBig(eng);
    const moved = compare(eng.world, 480, 300);
    // 不扭曲、按最近格取的老办法有不少像素读错
    expect(moved).toBeGreaterThan(0.03);
  });

  it('整个星球（小网格）：跨经度接缝、两极也一致', () => {
    const eng = snapshot('display:planet', () => {
      const e = seededEngine({ cells: 2500, seed: 2, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
      e.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
      e.exec({ op: 'generate_provinces', rules: { seed: 2 } });
      return e;
    });
    // 也切一刀：切线在星球上按经度绕回
    cutBig(eng);
    compare(eng.world, 400, 200);
    // 平铺的另一份上同一点读到的一样
    const w = eng.world;
    const a = displayCellAt(w, 0.37, 0.41);
    expect(displayCellAt(w, 0.37 + 2, 0.41)).toEqual(a);
    expect(displayCellAt(w, 0.37 - 4, 0.41)).toEqual(a);
  });
});

// 第十三轮：海上的像素永远不属于陆上的省（陆上的小块可以算进海省）。曲折的海岸（破碎度 2.5）、窄海湾最容易出错
describe('水面的像素只取水面格', () => {
  const rugged = () =>
    snapshot('display:rugged-provinces', () => {
      const eng = continents({ provinces: true });
      eng.exec({ op: 'set_coast_style', roughness: 2.5 });
      return eng;
    });

  it('选省、悬停（displayCellAt）：画成水面的点省份格是水面格或 −1；海上的点没有一个落进陆地省。原来按扭曲取格时有不少', () => {
    const eng = rugged();
    cutBig(eng);
    const w = eng.world;
    const { mesh, causes } = w;
    const coast = displayCoast(w).coast;
    const L = seamLayers(w, causes.province, w.small.provinceSeams);
    const W = 600;
    const H = 375;
    let hint = 0;
    let water = 0;
    let sea = 0;
    let before = 0;
    let none = 0;
    const bad: string[] = [];
    for (let py = 0; py < H; py++) {
      const y = ((py + 0.5) / H) * mesh.height;
      for (let px = 0; px < W; px++) {
        const x = ((px + 0.5) / W) * mesh.width;
        const d = displayCellAt(w, x, y, hint);
        hint = d.cell;
        if (!d.water) continue;
        // 小湖群（第三十四轮）：画成水面、格还是陆地（不是湖面格）的像素，像碎岛反过来，不进省份（−1）；不算在这里。
        // 第三十五轮：地形变了，有一个小湖群的像素挨着湖（离湖面格 0.63 格），以前按“格是不是湖面格”认不出：按 speck 认
        if (d.speck || (d.land && !(causes.land[d.here] === 1 && w.derived.lake[d.here] === 1))) continue;
        water++;
        const old = seamPick(L, w, x, y, d.cell);
        if (old >= 0 && coast[old] > 0) before++;
        if (d.province < 0) {
          // 没有省：只在离所有水面格都超过一格的地方（破碎的海岸按格以下的细节在陆地里画出的小水洼）
          none++;
          let near = Infinity;
          for (let i = 0; i < mesh.n; i++) if (coast[i] < 0) near = Math.min(near, Math.hypot(mesh.x[i] - x, mesh.y[i] - y));
          if (near < mesh.spacing) bad.push(`${px},${py} 近处有水面格却没有省`);
          continue;
        }
        if (coast[d.province] > 0) bad.push(`${px},${py} 陆地格`);
        // 海上（不是湖面）的点：格是海格，省是海省或没有省
        if (!d.land) {
          sea++;
          const p = causes.province[d.province];
          // 湖面格、湖省照样是水（破碎的海岸边，海上的像素可能挨着并回陆地的小块海挖成的湖）
          const lakeCell = w.derived.lake[d.province] === 1;
          const landProv = p >= 0 && w.small.provinces[p]?.land && w.small.provinces[p]?.kind !== 'lake';
          if ((causes.land[d.province] === 1 && !lakeCell) || landProv) bad.push(`${px},${py} 陆地省`);
        }
        if (bad.length > 5) break;
      }
    }
    expect(bad).toEqual([]);
    expect(sea).toBeGreaterThan(water * 0.5);
    // 原来的规则（扭曲后的格按切线换过）在海岸边有不少水面像素取到陆地格；找不到水面格的很少（破碎度 2.5 时约 1%，默认的海岸约万分之三）。
    // 第三十六轮（续）：峡湾海岸的岸线更曲折（海岸细节 × 1 + 2.2 × 岛礁的权重），破碎度 2.5 时陆地里的小水洼多了一点（约 2.07%）：放宽到 2.5%
    expect(before).toBeGreaterThan(200);
    expect(none).toBeLessThan(water * 0.025);
  });

  it('画成陆地的点：省份格几乎都是陆地格（附近 0.6 格内有陆地格就取它），海省只拿到海边很细的一丝陆地；原来有一条条宽的', () => {
    const eng = rugged();
    const w = eng.world;
    const { mesh, causes } = w;
    const coast = displayCoast(w).coast;
    const L = seamLayers(w, causes.province, w.small.provinceSeams);
    const W = 600;
    const H = 375;
    let hint = 0;
    let land = 0;
    let wet = 0;
    let before = 0;
    const bad: string[] = [];
    for (let py = 0; py < H; py++) {
      const y = ((py + 0.5) / H) * mesh.height;
      for (let px = 0; px < W; px++) {
        const x = ((px + 0.5) / W) * mesh.width;
        const d = displayCellAt(w, x, y, hint);
        hint = d.cell;
        if (d.water) continue;
        land++;
        const old = seamPick(L, w, x, y, d.cell);
        if (old >= 0 && coast[old] < 0) before++;
        if (d.province < 0 || coast[d.province] >= 0) continue;
        wet++;
        // 还取水面格的：0.6 格以内（沿网格的格心）没有陆地格可取，或者都在别的方向上（只有细细的一丝）
        let near = Infinity;
        for (let i = 0; i < mesh.n; i++) if (coast[i] >= 0) near = Math.min(near, Math.hypot(mesh.x[i] - x, mesh.y[i] - y));
        if (near < mesh.spacing * 0.25) bad.push(`${px},${py} 格心就在旁边的陆地格没取`);
        if (bad.length > 5) break;
      }
    }
    expect(bad).toEqual([]);
    // 破碎度 2.5 的海岸：原来约 3.4% 的陆地像素取到水面格，现在约 0.2%
    expect(before).toBeGreaterThan(wet * 10);
    expect(wet).toBeLessThan(land * 0.003);
  });

  it('导出（provinces.bmp 取的格）：每个海上的像素都取海格，切线换过以后也是', () => {
    const eng = rugged();
    cutBig(eng);
    const w = eng.world;
    const { causes } = w;
    for (const [W, H] of [
      [300, 150],
      [700, 437],
    ]) {
      const raster = rasterizeWorld(w, W, H);
      const byProvince = applySeams(w, seamLayers(w, causes.province, w.small.provinceSeams), raster.cell, W, H);
      let seaPx = 0;
      const bad: number[] = [];
      for (let p = 0; p < W * H; p++) {
        if (raster.land[p]) continue;
        seaPx++;
        if (causes.land[raster.cell[p]] === 1 || causes.land[byProvince[p]] === 1) bad.push(p);
      }
      expect(seaPx).toBeGreaterThan(W * H * 0.2);
      expect(bad.slice(0, 5)).toEqual([]);
    }
  });

  it('河口：河线最后一点落在画出来的水面上（河画到岸线以外一点，不留缝），合成时按每像素的陆海遮掉（与地形层的海岸场同一个判定）', () => {
    const w = rugged().world;
    const f = displayCoast(w);
    let mouths = 0;
    for (const l of traceRivers(w)) {
      const [x, y] = l.points[l.points.length - 1];
      const d = displayCellAt(w, x, y);
      if (!d.water) continue;
      mouths++;
      // 遮罩：画成水面（湖面也算）的像素不画河；与地形层、着色器的 land（海岸场 > 0）同一个正负
      expect(displayCoastAt(w, f, x, y).v).toBeLessThanOrEqual(0);
      // 沿河往回走，水面上的那一小段不长（河口那一点刚过岸线）
      let s = 0;
      for (let k = l.points.length - 1; k > 0; k--) {
        const [ax, ay] = l.points[k - 1];
        s += Math.hypot(ax - l.points[k][0], ay - l.points[k][1]);
        if (!displayCellAt(w, ax, ay).water) break;
      }
      expect(s).toBeLessThan(2 * w.mesh.spacing);
    }
    expect(mouths).toBeGreaterThan(5);
  });
});
