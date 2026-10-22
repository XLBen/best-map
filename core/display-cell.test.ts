import { describe, expect, it } from 'vitest';
import { type DisplayCell, displayCellAt } from './display';
import { Engine } from './engine';
import { findCell } from './mesh';
import { applySeams, scissors, seamLayers } from './seams';
import { rasterizeWorld } from './subcell';
import { continents, snapshot } from './testing/fixtures';
import type { World } from './world';

// 第八轮第四批：悬停卡片“这里”、Alt 吸取、选省、合并读的是屏幕上画出来的那一格。
// 着色器那一半只能在浏览器里看；这里拿与着色器同一套规则的 JS 实现对照：导出的 rasterizeWorld
// （逐像素：海岸值 + 格以下细节判陆海，扭曲后取最近的格；只多一步“陆海不一致时换成同类的邻格”）与 applySeams（切线规则）

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
      else if (same && (d.cell !== raster.cell[p] || d.here !== d.cell || d.province !== byProvince[p])) bad.push(`${px},${py} 格`);
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
      const e = new Engine({ cells: 2500, seed: 2, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
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
