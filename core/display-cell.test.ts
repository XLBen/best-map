import { describe, expect, it } from 'vitest';
import { FOCUS_GLSL, FOCUS_REACH, SPECK_MARK } from '../src/render/renderer';
import { type DisplayCell, displayCellAt, displayCoast, displayCoastAt } from './display';
import { Engine } from './engine';
import { wrapX } from './geo';
import { landPixelCells } from './island-types';
import { findCell } from './mesh';
import { traceRivers } from './rivers';
import { applySeams, scissors, seamLayers, seamPick } from './seams';
import { brushCells } from './select';
import { rasterizeWorld, warpOffset, warpOffset3 } from './subcell';
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

// 第三十七轮：描格跟着画面上的陆海。描格的格 F(p) = 省份的规则（provinceCell / 着色器的 provCell）不按剪刀切线换格，
// 小湖群的点算它那一格的陆地；描出的范围 R(c, 陆/水) = {p : F(p) = c，且 p 画成的陆或水相同}。
// 着色器的 focusAt（FOCUS_GLSL）照字面换成 JS（取格、陆海、每格的海岸值按 CPU 的同一份），与 DisplayCell.focus 逐像素比

type Vec = [number, number];
interface FocusEnv {
  sceneG: (uv: Vec) => number;
  idAt: (uv: Vec) => number;
  waterCell: (id: number) => boolean;
  fragCell: (id: number) => boolean;
  landCellOf: (id: number) => number;
  uTexel: Vec;
  uCellPx: number;
}
function focusJs(env: FocusEnv): (uv: Vec, uvW: Vec) => number {
  // focusCell、focusAt（后面的 nearFocus 只是快速排除，另按 focusDist 查）
  let js = FOCUS_GLSL.slice(0, FOCUS_GLSL.indexOf('vec3 focusSphere'));
  // 向量的几处换成函数；每一处都要找得到（着色器改了这里跟着改）
  const swaps: [string, string][] = [
    ['texture(uSceneHeight, uv * uSceneXf.xy + uSceneXf.zw).g', 'sceneG(uv)'],
    ['((landPx ? 0.3 : 0.6) * float(ring) * uCellPx) * uTexel', 'mul2(uTexel, (landPx ? 0.3 : 0.6) * ring * uCellPx)'],
    ['uv + vec2(cos(a), sin(a)) * r', 'add2(uv, mul2([Math.cos(a), Math.sin(a)], r))'],
    ['float(k)', 'k'],
  ];
  for (const [from, to] of swaps) {
    expect(js, from).toContain(from);
    js = js.split(from).join(to);
  }
  js = js
    .replace(/\b(?:int|bool|float|vec2)\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_m, name: string, args: string) => `function ${name}(${args.replace(/\b(?:int|bool|float|vec2)\s+/g, '')}) {`)
    .replace(/\b(?:int|bool|float|vec2)\s+/g, 'let ');
  const mul2 = (a: Vec, b: number | Vec): Vec => (typeof b === 'number' ? [a[0] * b, a[1] * b] : [a[0] * b[0], a[1] * b[1]]);
  const add2 = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
  return new Function('env', 'mul2', 'add2', `const { sceneG, idAt, waterCell, fragCell, landCellOf, uTexel, uCellPx } = env;\n${js}\nreturn focusAt;`)(env, mul2, add2);
}

// 着色器的环境：画面上的位置用 (x, −y)（y 向上），一个“像素”一个地图单位、一格 uCellPx 个像素；纹理按 CPU 的同一份
function gpuFocus(w: World): (x: number, y: number) => number {
  const { mesh } = w;
  const sphere = mesh.kind === 'sphere';
  const f = displayCoast(w);
  const lp = landPixelCells(w);
  let hint = 0;
  const at = focusJs({
    sceneG: ([x, ny]) => {
      const d = displayCellAt(w, x, -ny, hint);
      return d.speck ? SPECK_MARK : d.water ? -1 : 1;
    },
    idAt: ([x, ny]) => (hint = findCell(mesh, sphere ? wrapX(x) : x, -ny, hint)),
    waterCell: (id) => f.coast[id] < 0,
    fragCell: (id) => !!f.frag && f.frag[id] > 0,
    landCellOf: (id) => (lp[id] >= 0 ? lp[id] : id),
    uTexel: [1, 1],
    uCellPx: mesh.spacing,
  });
  return (x, y) => {
    const px = sphere ? wrapX(x) : x;
    const [wx, wy] = sphere ? warpOffset3(px, y, mesh.spacing) : warpOffset(px, y, mesh.spacing);
    const qy = sphere ? Math.min(1, Math.max(0, y + wy)) : y + wy;
    return at([x, -y], [px + wx, -qy]);
  };
}

// 一点到格心的远近（与着色器的 nearFocus 相同，地图单位）：一块地区按平面，整个星球按球面上的弦长（1 合 π 弧度）
function focusDist(w: World, x: number, y: number, c: number): number {
  const { mesh } = w;
  if (mesh.kind !== 'sphere') return Math.hypot(x - mesh.x[c], y - mesh.y[c]);
  const at = (u: number, v: number) => {
    const lon = Math.PI * (u - 1);
    const colat = Math.PI * Math.min(1, Math.max(0, v));
    return [Math.sin(colat) * Math.cos(lon), Math.sin(colat) * Math.sin(lon), Math.cos(colat)];
  };
  const a = at(x, y);
  const b = at(mesh.x[c], mesh.y[c]);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.PI;
}

const focusKey = (f: { cell: number; land: boolean }) => (f.cell < 0 ? -1 : f.cell * 2 + (f.land ? 1 : 0));

const R37_WORLDS: [string, () => Engine][] = [
  [
    '高纬的一块地区（峡湾、岛礁、小湖群、湖）',
    () =>
      snapshot('display:r37-region', () => {
        const e = seededEngine({ cells: 6000, seed: 7, latNorth: 78, latSouth: 40 });
        e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
        return e;
      }),
  ],
  [
    '整个星球（峡湾、岛礁、小湖群、湖，跨经度接缝、两极）',
    () =>
      snapshot('display:r37-planet', () => {
        const e = seededEngine({ cells: 5000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
        e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
        return e;
      }),
  ],
  [
    '打碎的海岸与碎岛',
    () =>
      snapshot('display:r37-shards', () => {
        const e = continents({ provinces: true });
        const w = e.world;
        const { mesh } = w;
        // 离 (0.9, 0.55) 最近的海岸陆地格，打碎它周围 9 格
        let c = -1;
        let bd = Infinity;
        for (let i = 0; i < mesh.n; i++) {
          if (!w.causes.land[i] || mesh.boundary[i]) continue;
          let coast = false;
          for (let k = mesh.off[i]; k < mesh.off[i + 1]; k++) if (!w.causes.land[mesh.adj[k]]) coast = true;
          const d = Math.hypot(mesh.x[i] - 0.9, mesh.y[i] - 0.55);
          if (coast && d < bd) {
            bd = d;
            c = i;
          }
        }
        const rKm = mesh.spacing * w.kmPerUnit * 9;
        const b = brushCells(w, mesh.x[c], mesh.y[c], rKm);
        e.exec({ op: 'fragment', cells: b.cells, t: b.t, strength: 0.8, mode: 'blocks', size: rKm });
        return e;
      }),
  ],
];

describe('第三十七轮：描格跟着画面上的陆海', () => {
  for (const [label, build] of R37_WORLDS) {
    it(`${label}：着色器的 focusAt 与 CPU 逐像素相同（鼠标所在的像素一定在描出的范围里）；陆水按画面；描出的范围在 FOCUS_REACH 以内`, () => {
      const w = build().world;
      const { mesh, causes } = w;
      const sphere = mesh.kind === 'sphere';
      const f = displayCoast(w);
      const gpu = gpuFocus(w);
      const W = sphere ? 520 : 480;
      const H = sphere ? 260 : 300;
      const sp = mesh.spacing;
      // 打碎过的世界只看打碎的那一片四周（有破碎度时 displayCellAt 慢得多）
      let box = [0, mesh.width, 0, mesh.height];
      const frag = causes.fragment;
      if (frag) {
        box = [Infinity, -Infinity, Infinity, -Infinity];
        for (let i = 0; i < mesh.n; i++) {
          if (!frag[i]) continue;
          box = [Math.min(box[0], mesh.x[i]), Math.max(box[1], mesh.x[i]), Math.min(box[2], mesh.y[i]), Math.max(box[3], mesh.y[i])];
        }
        box = [box[0] - 2 * sp, box[1] + 2 * sp, box[2] - 2 * sp, box[3] + 2 * sp];
      }
      let hint = 0;
      const n = { all: 0, water: 0, lake: 0, speck: 0, islet: 0, cut: 0, none: 0, oldMiss: 0, landWet: 0 };
      let reach = 0;
      const bad: string[] = [];
      for (let py = 0; py < H && bad.length < 6; py++) {
        const y = ((py + 0.5) / H) * mesh.height;
        if (y < box[2] || y > box[3]) continue;
        for (let px = 0; px < W; px++) {
          const x = ((px + 0.5) / W) * mesh.width;
          if (x < box[0] || x > box[1]) continue;
          const d = displayCellAt(w, x, y, hint);
          hint = d.cell;
          n.all++;
          const fc = d.focus;
          // 着色器与 CPU 相同：着色器描的范围 {p : focusAt(p) = 鼠标处的 focus} 里一定有鼠标所在的像素
          const g = gpu(x, y);
          if (g !== focusKey(fc)) bad.push(`${px},${py} 着色器 ${g}，CPU ${focusKey(fc)}`);
          // 原来描的是 here 那一格扭曲后的范围：鼠标所在的像素扭曲后的格不是 here 时，框里没有鼠标
          if (d.cell !== d.here) n.oldMiss++;
          // 陆水是画面上的（湖面算水面，小湖群算陆地）
          if (fc.land !== (!d.water || d.speck)) bad.push(`${px},${py} 陆水`);
          if (!fc.land) n.water++;
          if (fc.cell < 0) {
            // 没有描格的格：只在画成水面、附近没有水面格的地方（峡湾深处）
            n.none++;
            if (fc.land) bad.push(`${px},${py} 陆地上没有描格的格`);
            continue;
          }
          if (d.speck) {
            n.speck++;
            if (fc.cell !== d.cell) bad.push(`${px},${py} 小湖群`);
          } else if (!fc.land) {
            // 水面只取水面格；湖面取湖面格（描到画出来的湖岸）
            if (f.coast[fc.cell] >= 0) bad.push(`${px},${py} 水面取到陆地格`);
            if (causes.land[fc.cell] === 1 && w.derived.lake[fc.cell] === 1) n.lake++;
            // 刻进陆地格的水面（峡湾、海湾）
            if (f.coast[d.cell] > 0) n.cut++;
          } else if (f.coast[fc.cell] < 0) {
            // 陆地取到水面格：碎岛（那一格的海省），或附近找不到陆地格又没有最近的陆地省
            if (f.frag && f.frag[fc.cell] > 0) n.islet++;
            else n.landWet++;
          }
          // 描出的范围离格心不过 FOCUS_REACH 格（着色器只算这以内的像素；外面的衬边再宽一个像素）
          reach = Math.max(reach, focusDist(w, x, y, fc.cell) / sp);
        }
      }
      expect(bad).toEqual([]);
      expect(reach).toBeLessThan(FOCUS_REACH - 0.25);
      // 找不到描格的格的水面很少（约 0.2–0.4%）；原来的描边有 2.5–4% 的像素框里没有鼠标
      expect(n.none).toBeLessThan(n.all * 0.01);
      expect(n.oldMiss).toBeGreaterThan(n.all * 0.01);
      expect(n.landWet).toBeLessThan(n.all * 0.001);
      // 高纬的两个世界里有湖、小湖群、刻进陆地格的水面（峡湾、海湾）；打碎的那一片里有碎岛
      if (frag) {
        expect(n.islet).toBeGreaterThan(50);
      } else {
        expect(n.lake).toBeGreaterThan(300);
        expect(n.speck).toBeGreaterThan(100);
        expect(n.cut).toBeGreaterThan(1000);
      }
    });
  }
});
