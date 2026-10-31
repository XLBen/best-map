import { coastReads } from './coast-memo';
import { wrapX } from './geo';
import { findCell } from './mesh';
import { viewOf } from './sphere';
import { type SeamLayers, seamLayers, seamPick } from './seams';
import { bytesHash, coastDetail, coastDetail3, coastDetailAmp, shownCoastValues, fragCoast, fragLand, fragNoise, fragNoise3, fragValues, locate, nearestSeaCell, styleMayFlip, styledCoast, warpOffset, warpOffset3 } from './subcell';
import { fjordData, landStyle, styleAt, styleDetail, withoutLakeBarriers } from './coast-style';
import { type FjordLayer, provOnEdge } from './fjords';
import { landPixelCells } from './island-types';
import { coastSeed } from './terrain';
import type { World } from './world';

// ---------- 画面上的海岸场（地形层的着色器用的那一份）----------
// 每格的海岸值（coastValues）与高程，湖面另算：湖面的海岸值取负、离岸至少 60 m（有岸线、有格以下的岸线细节），
// 高程取负的水深（浅水边、海岸细节的幅度按它）。着色（src/render/colors.ts）上传给地形层的就是这一份，
// 河口（core/rivers.ts 的 shoreCrossing）按它找画出来的岸线，所以河正好画到岸上（海、湖都一样）

// 湖水深（m），至少 2 m
export const lakeDepth = (world: World, i: number) => Math.max(2, world.derived.water[i] - world.derived.elevation[i]);
// 湖面的海岸值：取负、离岸至少 60 m（幽灵海岸画新湖、原来的湖用同一个规则）
export const lakeCoast = (c: number) => -Math.max(60, Math.abs(c));
const isLakeCell = (world: World, i: number) => world.causes.land[i] === 1 && world.derived.lake[i] === 1;

export interface DisplayCoast {
  coast: Float32Array;
  elevation: Float32Array;
  // 每格的破碎度（0–1，第十八轮；湖面格照样有：湖里也能放碎岛）。没打碎过时为 null
  frag: Float32Array | null;
  // 海岸类型与小湖群（第三十四轮，每格两个数，见 core/coast-style.ts 的 packed；湖面格没有沙坝、岛礁）。没有生成器时为 null
  style: Float32Array | null;
  // 按陆海淹到哪里的峡湾（第三十六轮，core/fjords.ts 的 fjordLayer；湖面算陆地）。没有峡湾时为 null
  fjord: FjordLayer | null;
}

// 按高程数组缓存，另比湖、水面、陆海、陆地程度、海岸破碎度、海岸的种子、破碎度（当前世界与预览世界各留一份）
const displayCache = new WeakMap<Float32Array, { inputs: unknown[]; value: DisplayCoast }[]>();
export function displayCoast(world: World): DisplayCoast {
  const { derived: d, causes } = world;
  // 三角洲向海凸出（第三十三轮）按流向、汇水面积、“最高的山”认
  // 海岸类型（第三十四轮）只取决于陆海与生成器的分量：改了哪一样高程都是新的数组（重画一片也是），键里另加重画的记录。
  // 不在命中前算 landStyle（描河时 shoreCrossing 每次都来问，命中要快）
  const inputs: unknown[] = [d.lake, d.water, causes.land, causes.landness, world.small.terrain.coastRoughness, coastSeed(world), causes.fragment && bytesHash(2166136261, causes.fragment), d.receiver, d.drainArea, world.small.planet.mountainScale, world.small.terrain.gen?.rerolls];
  let list = displayCache.get(d.elevation);
  if (!list) displayCache.set(d.elevation, (list = []));
  const hit = list.find((e) => e.inputs.every((a, k) => a === inputs[k]));
  if (hit) return hit.value;
  const coast = shownCoastValues(world);
  const elevation = d.elevation.slice();
  const ls = landStyle(world);
  // 湖里不画沙坝（第三十四轮）：顺带记下有沙坝权重的湖格，有的话换一份去掉它们的（core/coast-style.ts 的 withoutLakeBarriers）
  const lakeBar: number[] = [];
  for (let i = 0; i < world.mesh.n; i++) {
    if (!isLakeCell(world, i)) continue;
    coast[i] = lakeCoast(coast[i]);
    elevation[i] = -lakeDepth(world, i);
    if (ls && ls[2 * i + 1] !== 0) lakeBar.push(i);
  }
  const value = { coast, elevation, frag: fragValues(world, false), style: ls && withoutLakeBarriers(ls, lakeBar), fjord: ls ? fjordData(world) : null };
  list.unshift({ inputs, value });
  list.length = Math.min(list.length, 2);
  return value;
}

// 描河时（core/rivers.ts 的 traceRivers）不画小湖群（第三十四轮）：河口在海岸、湖岸上，小湖群只在离岸远、高出海平面的低地上；
// 一段线在不在陆地上（分汊的几股）只看真正的水面。小湖群在冰川低地上到处都有，算进来时只看正负的捷径几乎都走不了，描一遍河慢一两成
export const riverQueries = { on: false };

// 画面上一点的海岸场（> 0 画成陆地，湖、海 < 0）：与地形层的着色器同一个算式（三角形内插值 + 格以下的海岸细节，
// 整个星球上细节在球面上取）。hint：附近的格；返回值与离它最近的格（下一次的 hint）。
// signOnly：只要正负时，插值的那部分比细节可能的最大值还大就不算细节（细节噪声最多 ±0.9375，结果的正负不变）
const DETAIL_MAX = 0.9375;
export function displayCoastAt(world: World, f: DisplayCoast, x: number, y: number, hint = 0, signOnly = false): { v: number; nearest: number } {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const px = sphere ? wrapX(x) : x;
  const loc = locate(mesh, px, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  // 描河时记下读到的格（core/coast-memo.ts）
  if (coastReads.on) coastReads.cells.push(a, b, c);
  const sv = f.coast[a] * wa + f.coast[b] * wb + f.coast[c] * wc;
  const h = f.elevation[a] * wa + f.elevation[b] * wb + f.elevation[c] * wc;
  const weight = Math.min(1, Math.max(0, (1 - Math.max(wa, wb, wc)) * 2.2));
  let amp = weight * coastDetailAmp(world, Math.max(0, h));
  // 破碎的地方（第十八轮）：不走只看正负的捷径
  const fv = f.frag ? f.frag[a] * wa + f.frag[b] * wb + f.frag[c] * wc : 0;
  // 海岸类型与小湖群（第三十四轮）：可能改变正负的地方也不走捷径
  const style = f.style;
  if (style) {
    styleAt(style, f.coast, a, b, c, wa, wb, wc, stAt, loc.prov);
    amp *= styleDetail(stAt[4], stAt[2]);
  }
  const speck = !riverQueries.on;
  if (signOnly && fv <= 0 && Math.abs(sv) > amp * DETAIL_MAX && !(style && styleMayFlip(sphere, px, y, sp, stAt, sv, h, speck, amp * DETAIL_MAX, f.fjord))) return { v: sv, nearest: loc.nearest };
  const detail = sphere ? coastDetail3(px, y, sp) : coastDetail(px, y, sp);
  let v = fv > 0 ? fragCoast(sv, amp * detail, fv, weight, sphere ? fragNoise3(px, y, sp) : fragNoise(px, y, sp)) : sv + amp * detail;
  if (style) v = styledCoast(sphere, px, y, sp, v, sv, h, stAt, speck, detail, f.fjord);
  return { v, nearest: loc.nearest };
}
const stAt = new Float64Array(7);

// 两格的格心 a、b 之间是不是画面三角网的一条边（一块地区的格与网格的相邻相同；整个星球按显示的三角网：
// 接缝外的影子点要正好落在 b 上，两极那一行的影子点不算）
function displayEdge(world: World, c: number, r: number, a: readonly [number, number], b: readonly [number, number]): boolean {
  const { mesh } = world;
  if (mesh.kind !== 'sphere') return true;
  const view = viewOf(mesh);
  const eps = 1e-9;
  if (Math.abs(wrapX(a[0]) - mesh.x[c]) > eps || Math.abs(a[1] - mesh.y[c]) > eps) return false;
  const bx = mesh.x[c] + (b[0] - a[0]);
  for (const v of view.delaunay.neighbors(c)) if (view.cellOf[v] === r && Math.abs(view.x[v] - bx) < eps && Math.abs(view.y[v] - b[1]) < eps) return true;
  return false;
}

// 从陆上的一点 a 往水里的一点 b 走，画出来的岸线在哪里（第一次走到水面的地方）：先等分取 12 个点，再在跨过岸线的那一小段里二分。
// a 在画面上不是陆地、一路都没走到水面时为 null。整个星球上 x 可以展开（结果与 a 在同一份上）
const CROSS_SAMPLES = 12;
const stEdge = new Float64Array(7);
const CROSS_BISECT = 12;
// edge（可选）：a、b 是相邻两格 [c, r] 的格心（河口那格与它流进的水面那格）。这条边在画面的三角网里时，线上每一点的重心坐标
// 就是 (1 − t, t, 0)，不必一点点找三角形（逐点找要慢几倍）；不在时（整个星球两极附近）照常找。
// steps（可选）：先等分取几个点、再二分几次（短的线用不着 12 + 12 次：河口沿法向找岸线的线只有一格多长，6 + 8 次就准到千分之一格）
export function shoreCrossing(
  world: World,
  a: readonly [number, number],
  b: readonly [number, number],
  hint = 0,
  edge?: readonly [number, number],
  steps?: { samples: number; bisect: number },
): { p: [number, number]; t: number } | null {
  const f = displayCoast(world);
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const [ax, ay] = a;
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  let h = hint;
  const onEdge = edge && displayEdge(world, edge[0], edge[1], a, b);
  // 沿边走时峡湾的表按以这条边为边的一个画面三角形取（第三十六轮，core/fjords.ts）
  const edgeProv = onEdge && f.style ? provOnEdge(mesh, edge![0], edge![1]) : -1;
  const at = onEdge
    ? (t: number) => {
        const [c, r] = edge!;
        const sv = f.coast[c] * (1 - t) + f.coast[r] * t;
        const weight = Math.min(1, Math.max(0, (1 - Math.max(1 - t, t)) * 2.2));
        const hh = f.elevation[c] * (1 - t) + f.elevation[r] * t;
        let amp = weight * coastDetailAmp(world, Math.max(0, hh));
        const fv = f.frag ? f.frag[c] * (1 - t) + f.frag[r] * t : 0;
        // 海岸类型与小湖群（第三十四轮，与 displayCoastAt 相同）
        const style = f.style;
        if (style) {
          styleAt(style, f.coast, c, r, r, 1 - t, t, 0, stEdge, edgeProv);
          amp *= styleDetail(stEdge[4], stEdge[2]);
        }
        const x = ax + dx * t;
        const y = ay + dy * t;
        const xw = sphere ? wrapX(x) : x;
        if (fv <= 0 && Math.abs(sv) > amp * DETAIL_MAX && !(style && styleMayFlip(sphere, xw, y, mesh.spacing, stEdge, sv, hh, !riverQueries.on, amp * DETAIL_MAX, f.fjord))) return sv;
        const nd = sphere ? coastDetail3(xw, y, mesh.spacing) : coastDetail(x, y, mesh.spacing);
        const det = amp * nd;
        const v = fv > 0 ? fragCoast(sv, det, fv, weight, sphere ? fragNoise3(xw, y, mesh.spacing) : fragNoise(x, y, mesh.spacing)) : sv + det;
        return style ? styledCoast(sphere, xw, y, mesh.spacing, v, sv, hh, stEdge, !riverQueries.on, nd, f.fjord) : v;
      }
    : (t: number) => {
        const r = displayCoastAt(world, f, ax + dx * t, ay + dy * t, h, true);
        h = r.nearest;
        return r.v;
      };
  // 沿边走时读的是这两格（描河时记下，core/coast-memo.ts）；不沿边时 displayCoastAt 自己记
  if (onEdge && coastReads.on) {
    coastReads.cells.push(edge![0], edge![1]);
    // 峡湾的表按以这条边为边的三角形的最后一个顶点取（可能是第三格）
    if (edgeProv >= 0) coastReads.cells.push(edgeProv);
  }
  if (at(0) <= 0) return null;
  const samples = steps?.samples ?? CROSS_SAMPLES;
  const bisect = steps?.bisect ?? CROSS_BISECT;
  let t0 = 0;
  for (let k = 1; k <= samples; k++) {
    const t1 = k / samples;
    if (at(t1) > 0) {
      t0 = t1;
      continue;
    }
    let lo = t0;
    let hi = t1;
    for (let it = 0; it < bisect; it++) {
      const m = (lo + hi) / 2;
      if (at(m) > 0) lo = m;
      else hi = m;
    }
    // 取刚过岸线的那一点（在水面一侧）：河画到岸线为止，不留缝
    return { p: [ax + dx * hi, ay + dy * hi], t: hi };
  }
  return null;
}

// 屏幕上的一点画的是哪一格：与着色器同一套规则（src/render/renderer.ts 的 FS_COMPOSE 与地形层）。
//   · 陆还是海：三角形内插值的海岸值 + 格以下的海岸细节（地形层画海岸线的那一条，见 subcell.ts 的 pointIsLand；
//     整个星球上细节噪声在球面上取，与着色器、导出相同）；
//   · 生态、省份着色、省界按扭曲后的位置取最近的格（着色器的 id），省份再按剪刀切线的规则换格（着色器的 idG）。
// 着色器取格时不看陆海（导出的位图另外换成同类的邻格），所以海岸附近“画成陆地的像素”取到的格可能是海格：
// 悬停卡片、吸取生态、点地名要说的是这一点画成的陆地或海，用 here（与这一点同类的格：同类时就是 cell，
// 不同类时按导出的规则换成最近的同类邻格）。
// 悬停卡片“这里”、Alt 吸取、选省、合并、点地名都用它：说的、取的就是屏幕上画出来的那一格

const stCell = new Float64Array(7);

export interface DisplayCell {
  // 扭曲后的最近格（着色器的 id：生态的平涂、按格着色的视图画的是它）
  cell: number;
  // 这一点画成陆地还是海
  land: boolean;
  // 与这一点同类的格（描述这里是什么、吸取生态、点地名用）
  here: number;
  // 省份按哪一格算（剪刀切线附近按在线的哪一边换过：省界、省份着色画的是它）。画成水面的点只取水面格（见 provinceCell），
  // 附近没有水面格时为 −1
  province: number;
  // 这一点画成水面（海、湖；湖面在 land 里算陆地）
  water: boolean;
  // 小湖群（第三十四轮）画出来的水面：没画小湖群时是陆地（不归哪个省，province 为 −1）
  speck: boolean;
}

// 海岸值按陆度数组缓存（同一个世界只算一次；只改了名字、省份的轻快照沿用同一个数组）。
// 三角洲向海凸出（第三十三轮）另按高程、流向、汇水面积、湖面、“最高的山”认
const coastCache = new WeakMap<Float32Array, { land: Uint8Array; rough: number; seed: number; derived: unknown[]; s: Float32Array }>();
function coastOf(world: World): Float32Array {
  const { causes, derived: d } = world;
  const rough = world.small.terrain.coastRoughness;
  const seed = coastSeed(world);
  const derived: unknown[] = [d.elevation, d.receiver, d.drainArea, d.lake, world.small.planet.mountainScale];
  const c = coastCache.get(causes.landness);
  if (c && c.land === causes.land && c.rough === rough && c.seed === seed && c.derived.every((a, k) => a === derived[k])) return c.s;
  const s = shownCoastValues(world);
  coastCache.set(causes.landness, { land: causes.land, rough, seed, derived, s });
  return s;
}

// 切线的分组按省份数组与切线缓存（鼠标每动一下都要查）
const seamCache = new WeakMap<Int32Array, { seams: unknown; L: SeamLayers | null }>();
function seamsOf(world: World): SeamLayers | null {
  const seams = world.small.provinceSeams;
  if (!seams?.length) return null;
  const province = world.causes.province;
  const c = seamCache.get(province);
  if (c && c.seams === seams) return c.L;
  const L = seamLayers(world, province, seams);
  seamCache.set(province, { seams, L });
  return L;
}

// (x, y)：地图单位（整个星球上 x 可以在平铺的任何一份里）；hint：附近的格（找格的起点，比如上一次的结果）
export function displayCellAt(world: World, x: number, y: number, hint = 0): DisplayCell {
  const { mesh, causes, derived } = world;
  const sphere = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const px = sphere ? wrapX(x) : x;
  // 陆还是海：与 rasterizeWorld 逐像素的判定相同
  const s = coastOf(world);
  const fl = fragLand(world);
  const loc = locate(mesh, px, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  const sv = s[a] * wa + s[b] * wb + s[c] * wc;
  const h = derived.elevation[a] * wa + derived.elevation[b] * wb + derived.elevation[c] * wc;
  const weight = Math.min(1, Math.max(0, (1 - Math.max(wa, wb, wc)) * 2.2));
  const detail = sphere ? coastDetail3(px, y, sp) : coastDetail(px, y, sp);
  // 破碎的地方（第十八轮）：碎岛的噪声只在要用时取
  let fn = Number.NaN;
  const fragN = () => (Number.isNaN(fn) ? (fn = sphere ? fragNoise3(px, y, sp) : fragNoise(px, y, sp)) : fn);
  // 海岸类型（第三十四轮）：峡湾、沙坝按陆海判也算（小湖群只在画面的海岸场里）
  const cs = landStyle(world);
  if (cs) styleAt(cs, s, a, b, c, wa, wb, wc, stCell, loc.prov);
  const det = weight * coastDetailAmp(world, Math.max(0, h)) * (cs ? styleDetail(stCell[4], stCell[2]) : 1) * detail;
  const fv = fl ? fl[a] * wa + fl[b] * wb + fl[c] * wc : 0;
  let sl = fv > 0 ? fragCoast(sv, det, fv, weight, fragN()) : sv + det;
  if (cs) sl = styledCoast(sphere, px, y, sp, sl, sv, h, stCell, false, detail, fjordData(world));
  const land = sl > 0;
  // 画成水面（海、湖）还是陆地：画面上的海岸场（湖面取负，与地形层、着色器的 land 相同）
  const f = displayCoast(world);
  const sw = f.coast[a] * wa + f.coast[b] * wb + f.coast[c] * wc;
  const hw = f.elevation[a] * wa + f.elevation[b] * wb + f.elevation[c] * wc;
  if (f.style) styleAt(f.style, f.coast, a, b, c, wa, wb, wc, stCell, loc.prov);
  const detW = weight * coastDetailAmp(world, Math.max(0, hw)) * (f.style ? styleDetail(stCell[4], stCell[2]) : 1) * detail;
  const fw = f.frag ? f.frag[a] * wa + f.frag[b] * wb + f.frag[c] * wc : 0;
  let swv = fw > 0 ? fragCoast(sw, detW, fw, weight, fragN()) : sw + detW;
  // 小湖群（第三十四轮）：没画小湖群时是陆地、画了是水面的点不归哪个省（与合成着色器相同）
  let speck = false;
  if (f.style) {
    const pre = styledCoast(sphere, px, y, sp, swv, sw, hw, stCell, false, detail, f.fjord);
    swv = styledCoast(sphere, px, y, sp, swv, sw, hw, stCell, true, detail, f.fjord);
    speck = pre > 0 && swv <= 0;
  }
  const water = swv <= 0;
  // 扭曲后的最近格（整个星球：南北夹在两极以内，与着色器相同）
  const [wx, wy] = sphere ? warpOffset3(px, y, sp) : warpOffset(px, y, sp);
  const qy = sphere ? Math.min(1, Math.max(0, y + wy)) : y + wy;
  const cell = findCell(mesh, px + wx, qy, loc.nearest);
  // 碎岛（破碎的海格里画成陆地的像素）就是那一格（与导出相同）
  const isle = land && causes.land[cell] !== 1 && !!fl && fl[cell] > 0;
  const here = (causes.land[cell] === 1) === land || isle ? cell : sameKindNear(world, land, cell, loc.nearest, px, y);
  return { cell, land, water, here, province: speck ? -1 : provinceCell(world, f.coast, seamsOf(world), px, y, cell, loc.nearest, water, f.frag), speck };
}

// 省份按哪一格（第十三轮；与着色器的 provCell 同一条规则）：扭曲后的格按剪刀切线换过；这一点画成水面（海、湖）而那一格是陆地格时
// 不取它（海上的像素永远不属于陆上的省）：依次试没扭曲的最近格、周围 0.6 格与 1.2 格半径上各 8 个点的格（同样按切线换过），
// 取第一个水面格；都不是时为 −1（不着色、不画省界、选不中）。
// 画成陆地的像素取到水面格时（第十三轮修：海边一条条宽宽的陆地算进了海省）：同样依次试没扭曲的最近格、周围 0.3 格与 0.6 格
// 半径上各 8 个点的格，取第一个陆地格；都不是时（第十四轮）取那个水面格离它最近的陆地省的格（island-types.ts 的 landProvinceCells），
// 破碎的陆地永远归陆地省（海永远不算进陆上的省）。
// coast：画面上每格的海岸值（displayCoast，湖面 < 0）；near：没扭曲的最近格
export const PROVINCE_RING = { n: 8, radii: [0.6, 1.2] } as const;
export const PROVINCE_LAND_RING = { n: 8, radii: [0.3, 0.6] } as const;
// frag（第十八轮）：画面上每格的破碎度（displayCoast 的 frag）。画成陆地的像素取到破碎的水面格时就是那一格：碎岛归海省（湖里的归湖）
export function provinceCell(world: World, coast: Float32Array, L: SeamLayers | null, x: number, y: number, cell: number, near: number, water: boolean, frag: Float32Array | null = null): number {
  const first = seamPick(L, world, x, y, cell);
  if (first < 0 || coast[first] < 0 === water) return first;
  if (!water && frag && frag[first] > 0) return first;
  const ok = (c: number) => {
    const g = seamPick(L, world, x, y, c);
    return g >= 0 && coast[g] < 0 === water ? g : -1;
  };
  let g = ok(near);
  if (g >= 0) return g;
  const { mesh } = world;
  const ring = water ? PROVINCE_RING : PROVINCE_LAND_RING;
  for (const r of ring.radii) {
    const rr = r * mesh.spacing;
    for (let k = 0; k < ring.n; k++) {
      const a = (k * 2 * Math.PI) / ring.n;
      // 着色器里的角度按画面（y 向上）量：地图上 y 向下，所以减
      g = ok(findCell(mesh, x + rr * Math.cos(a), y - rr * Math.sin(a), near));
      if (g >= 0) return g;
    }
  }
  if (water) return -1;
  const fallback = landPixelCells(world)[first];
  return fallback >= 0 ? fallback : first;
}

// 最近格、扭曲后那一格与最近格的邻格里，离这一点最近的同类格（与导出 rasterizeWorld 的 sameKindCell 相同）；都不同类时陆上的点
// 取那一格离它最近的陆地省的格（landProvinceCells，第十四轮），海上的点按 nearestSeaCell 往外找
function sameKindNear(world: World, land: boolean, cell: number, near: number, x: number, y: number): number {
  const { mesh, causes } = world;
  let best = -1;
  let bd = Infinity;
  const tryCell = (j: number) => {
    if ((causes.land[j] === 1) !== land) return;
    const dx = mesh.kind === 'sphere' ? mesh.x[j] - x - 2 * Math.round((mesh.x[j] - x) / 2) : mesh.x[j] - x;
    const d = dx * dx + (mesh.y[j] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = j;
    }
  };
  tryCell(near);
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) tryCell(mesh.adj[e]);
  for (let e = mesh.off[near]; e < mesh.off[near + 1]; e++) tryCell(mesh.adj[e]);
  if (best >= 0) return best;
  // 海上的点都不同类时沿网格往外找最近的海格（与导出相同：海上的像素永远不取陆地格）
  if (!land) return nearestSeaCell(mesh, causes.land, cell, x, y);
  const fallback = landPixelCells(world)[cell];
  return fallback >= 0 ? fallback : cell;
}
